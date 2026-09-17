import { type ExpressionBuilder, expressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  aliasedAs,
  coalesced,
  defineStatement,
  fenceValue,
  insertedFrom,
  nowValue,
  rawSql,
  stampValue,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'

/** The claim an awaiting worker presents: its run, in this queue and task, under its token. */
type AwaitingClaim = {
  queue: string
  runId: string
  taskId: string
  claimToken: string
  /** The store's join of the run `r` to the task `t` that owns it. */
  taskOwnsRun: SqlFragment
}

/**
 * The run is still running under its claim, and the store's predicate holds of the task
 * `t` that owns it. The claim's identity is nodes, so a store fragment cannot leave it
 * out. Registering a wait and reading an emitted event both require this.
 */
const stillClaimed = (claim: AwaitingClaim, task: SqlFragment) =>
  treeBuilder
    .selectFrom('runs as r')
    .innerJoin('tasks as t', (join) => join.on(rawSql<boolean>(claim.taskOwnsRun, 'predicate')))
    .select('r.run_id')
    .where('r.run_id', '=', claim.runId)
    .where('r.queue', '=', claim.queue)
    .where('r.task_id', '=', claim.taskId)
    .where('r.claimed_by', '=', claim.claimToken)
    .where('r.state', '=', 'running')
    .where(rawSql<boolean>(task, 'predicate'))

/**
 * `await-event`'s compare-and-set: register a wait, unless the event was already
 * emitted. The miss branch is folded into the guard, so no round trip separates the
 * check from the registration. A wait this run already registered for this step is
 * left as it is.
 */
export const registerWaitCas = defineStatement(
  'await-event',
  (binds: {
    queue: string
    runId: string
    taskId: string
    claimToken: string
    stepName: string
    eventName: string
    /** The wait's timeout instant, or NULL for an untimed wait. */
    timeoutAt: SqlFragment
    timeoutFits: SqlFragment
    /** The store's join of the run `r` to the task `t` that owns it. */
    taskOwnsRun: SqlFragment
    /** What the store requires of the task `t` for its run to suspend. */
    taskEligible: SqlFragment
  }) => {
    const eb = expressionBuilder<StoreTables, never>()
    const wait = {
      run_id: eb.val(binds.runId),
      step_name: eb.val(binds.stepName),
      queue: eb.val(binds.queue),
      task_id: eb.val(binds.taskId),
      event_name: eb.val(binds.eventName),
      status: eb.val('waiting'),
      timeout_at_ms: rawSql<number | null>(binds.timeoutAt, 'value'),
      created_at_ms: nowValue,
      ...FENCE_ASSIGNMENTS,
    }
    const { columns, selections } = insertedFrom(wait)
    return treeBuilder
      .insertInto('waits')
      .columns(columns)
      .expression(
        treeBuilder
          .selectNoFrom(selections)
          .where((where) =>
            where.not(
              where.exists(
                where
                  .selectFrom('events')
                  .select('events.queue')
                  .where('events.queue', '=', binds.queue)
                  .where('events.event_name', '=', binds.eventName),
              ),
            ),
          )
          .where((where) => where.exists(stillClaimed(binds, binds.taskEligible)))
          .where(rawSql<boolean>(binds.timeoutFits, 'predicate')),
      )
      .onConflict((conflict) => conflict.columns(['run_id', 'step_name']).doNothing())
  },
)

/**
 * `emit-event`'s compare-and-set: record the event, first write wins. A re-emit keeps
 * the payload and the first instant and takes only this statement's stamp, which is
 * what lets the follow-ons of this batch fence on it. The stamp comparison is the
 * standard null-safe inequality, which SQLite and PostgreSQL both take. A dialect
 * supplies what it requires of the existing row.
 */
export const emitEventCas = defineStatement(
  'emit-event',
  (binds: {
    queue: string
    eventName: string
    payloadJson: string
    existingEventAdmits: SqlFragment
  }) =>
    treeBuilder
      .insertInto('events')
      .values({
        queue: binds.queue,
        event_name: binds.eventName,
        payload: binds.payloadJson,
        emitted_at_ms: nowValue,
        ...FENCE_ASSIGNMENTS,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['queue', 'event_name'])
          .doUpdateSet((eb) => ({
            fence_stamp: stampValue,
            fence_at_ms: eb.ref('events.emitted_at_ms'),
          }))
          .where((eb) => eb('events.fence_stamp', 'is distinct from', stampValue))
          .where(rawSql<boolean>(binds.existingEventAdmits, 'predicate')),
      ),
)

/**
 * The event this batch recorded, as a parked run reads it: the row of `events` in the
 * run's own queue, by name, under the stamp of the compare-and-set named `event`. The
 * gate, the wake instant, the payload, and the provenance instant all read this one
 * row, so they cannot disagree about which event woke the run.
 */
const recordedEvent = (eb: ExpressionBuilder<StoreTables, 'runs'>, eventName: string) =>
  eb
    .selectFrom('events as f')
    .whereRef('f.queue', '=', 'runs.queue')
    .where('f.event_name', '=', eventName)
    .where('f.fence_stamp', '=', fenceValue('event'))

/**
 * `emit-event`'s wake: every run parked on this event, in a live task, becomes pending
 * at the event's instant, with the stored payload and never the one this call carried,
 * so a re-emit agrees with the event row. It is the one follow-on whose rows this batch
 * did not stamp. It finds runs through `waits`, which an earlier await registered, and
 * uses the event's stamp as its gate. The gate is tied to each run by its queue and not
 * by a key, because one event wakes many runs.
 *
 * The store owns what registered mutations mutate and what its query plan depends on:
 * the waiter subquery, which stays uncorrelated so the waits index drives the
 * statement, the match on the event the run parked on, the full wait witness, and the
 * probe that the owning task is live.
 */
export const wakeRunsUpdate = defineStatement(
  'emit-event wake-runs',
  (binds: {
    eventName: string
    /** The step of the run's one registered wait, for a run parked before runs carried `wake_step`. */
    registeredStep: SqlFragment
    /** The run is parked on this event. */
    parkedOnEvent: SqlFragment
    /** A parenthesized subquery of the run ids waiting on this event, not correlated to `runs`. */
    waiterRunIds: SqlFragment
    /** The run's own wait registration answers for the step it parked on. */
    witness: SqlFragment
    taskIsLive: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set((eb) => ({
        state: 'pending',
        available_at_ms: recordedEvent(eb, binds.eventName).select('f.fence_at_ms'),
        wake_step: coalesced<string | null>(
          'wake_step',
          rawSql<string | null>(binds.registeredStep, 'value'),
        ),
        wake_event: binds.eventName,
        event_payload: recordedEvent(eb, binds.eventName).select('f.payload'),
        fence_stamp: stampValue,
        fence_at_ms: recordedEvent(eb, binds.eventName).select('f.fence_at_ms'),
      }))
      .where('state', '=', 'sleeping')
      .where(rawSql<boolean>(binds.parkedOnEvent, 'predicate'))
      .where((eb) => eb('run_id', 'in', rawSql<string>(binds.waiterRunIds, 'subquery')))
      .where(rawSql<boolean>(binds.witness, 'predicate'))
      .where((eb) => eb.exists(recordedEvent(eb, binds.eventName).select('f.queue')))
      .where(rawSql<boolean>(binds.taskIsLive, 'predicate')),
)

/** One event, by its key. */
const eventRow = (binds: { queue: string; eventName: string }) =>
  treeBuilder
    .selectFrom('events')
    .where('queue', '=', binds.queue)
    .where('event_name', '=', binds.eventName)

/**
 * `emit-event`'s read of the stored event. It is an open read: on a replay the row may
 * carry an earlier delivery's stamp, and its payload must be TEXT whoever stamped it.
 * How a dialect names a stored value's type is the store's.
 */
export const storedEventRead = defineStatement(
  'emit-event stored-event',
  (binds: { queue: string; eventName: string; payloadType: SqlFragment }) =>
    eventRow(binds).select(() => [
      aliasedAs(rawSql<string>(binds.payloadType, 'value'), 'payload_type'),
    ]),
)

/**
 * `await-event`'s hit: the event, if it was already emitted, for a run still running
 * under its claim. It is an open read, because the emitting batch wrote the event. The
 * live claim token is what fences it.
 */
export const emittedEventRead = defineStatement(
  'await-event hit',
  (binds: AwaitingClaim & { eventName: string; payloadType: SqlFragment; liveTask: SqlFragment }) =>
    eventRow(binds)
      .select('payload')
      .select(() => [aliasedAs(rawSql<string>(binds.payloadType, 'value'), 'payload_type')])
      .where((where) => where.exists(stillClaimed(binds, binds.liveTask))),
)
