import { type ExpressionBuilder, expressionBuilder } from 'kysely'
import { EventName, taskDoneEventName } from '../child-tasks.js'
import type { SagaPhasePredicate } from '../sagas.js'
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
import { LIVE_STATES } from '../types.js'

/** The claim an awaiting worker presents: its run, in this queue and task, under its token. */
export type AwaitingClaim = {
  queue: string
  runId: string
  taskId: string
  claimToken: string
  /** The store's join of the run `r` to the task `t` that owns it. */
  taskOwnsRun: SqlFragment
}

/**
 * The event lock of a statement that names its event in its binds (§3.4 rule 2). An emit
 * and an await of one event are atomic and mutually exclusive on every dialect, and the
 * lock is what makes them so where a write batch is not serialized: the statement that
 * records the event or registers the wait names the lock, so the batch that holds the
 * statement holds the lock.
 */
const onItsEvent = (binds: { queue: string; eventName: EventName }) => ({
  queue: binds.queue,
  eventName: binds.eventName,
})

/**
 * The run is still running under its claim, and the store's predicate holds of the task
 * `t` that owns it. The claim's identity is nodes, so a store fragment cannot leave it
 * out. Registering a wait and reading an emitted event both require this.
 */
export const stillClaimed = (claim: AwaitingClaim, task: SqlFragment) =>
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
    eventName: EventName
    /** The wait's timeout instant, or NULL for an untimed wait. */
    timeoutAt: SqlFragment
    timeoutFits: SqlFragment
    /** The store's join of the run `r` to the task `t` that owns it. */
    taskOwnsRun: SqlFragment
    /** What the store requires of the task `t` for its run to suspend. */
    taskEligible: SqlFragment
    /** The forward phase is frozen once a saga began, so no wait registers then (§3.10). */
    phase: SagaPhasePredicate
  }) => {
    const eb = expressionBuilder<StoreTables, never>()
    const wait = {
      run_id: eb.val(binds.runId),
      step_name: eb.val(binds.stepName),
      queue: eb.val(binds.queue),
      task_id: eb.val(binds.taskId),
      event_name: eb.val(binds.eventName.value),
      status: eb.val('waiting'),
      timeout_at_ms: rawSql<number | null>(binds.timeoutAt, 'value'),
      created_at_ms: nowValue,
      ...FENCE_ASSIGNMENTS,
    }
    const { columns, selections } = insertedFrom(wait)
    let guarded = treeBuilder
      .selectNoFrom(selections)
      .where((where) =>
        where.not(
          where.exists(
            where
              .selectFrom('events')
              .select('events.queue')
              .where('events.queue', '=', binds.queue)
              .where('events.event_name', '=', binds.eventName.value),
          ),
        ),
      )
      .where((where) => where.exists(stillClaimed(binds, binds.taskEligible)))
      .where(rawSql<boolean>(binds.timeoutFits, 'predicate'))
      .$if(binds.phase !== 'open', (query) =>
        query.where(rawSql<boolean>(binds.phase as SqlFragment, 'predicate')),
      )
    // A wait on a completion event registers only while the event's task is live and in
    // this queue (specs/ChildTasks.tla's AwaitMiss). A task that has ended, in another
    // queue, or that does not exist will never be ended by a batch that could wake the
    // wait, so the wait would sleep forever. The task is the one the name carries, so a
    // caller cannot pass one child's event and another child's id.
    const awaitedTaskId = binds.eventName.taskId
    if (awaitedTaskId !== null) {
      guarded = guarded.where((where) =>
        where.exists(
          treeBuilder
            .selectFrom('tasks as c')
            .select('c.task_id')
            .where('c.task_id', '=', awaitedTaskId)
            .where('c.queue', '=', binds.queue)
            .where('c.state', 'in', [...LIVE_STATES]),
        ),
      )
    }
    return treeBuilder
      .insertInto('waits')
      .columns(columns)
      .expression(guarded)
      .onConflict((conflict) => conflict.columns(['run_id', 'step_name']).doNothing())
  },
  onItsEvent,
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
    eventName: EventName
    payloadJson: string
    existingEventAdmits: SqlFragment
  }) =>
    treeBuilder
      .insertInto('events')
      .values({
        queue: binds.queue,
        event_name: binds.eventName.value,
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
  onItsEvent,
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
    eventName: EventName
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
        available_at_ms: recordedEvent(eb, binds.eventName.value).select('f.fence_at_ms'),
        wake_step: coalesced<string | null>(
          'wake_step',
          rawSql<string | null>(binds.registeredStep, 'value'),
        ),
        wake_event: binds.eventName.value,
        event_payload: recordedEvent(eb, binds.eventName.value).select('f.payload'),
        fence_stamp: stampValue,
        fence_at_ms: recordedEvent(eb, binds.eventName.value).select('f.fence_at_ms'),
      }))
      .where('state', '=', 'sleeping')
      .where(rawSql<boolean>(binds.parkedOnEvent, 'predicate'))
      .where((eb) => eb('run_id', 'in', rawSql<string>(binds.waiterRunIds, 'subquery')))
      .where(rawSql<boolean>(binds.witness, 'predicate'))
      .where((eb) => eb.exists(recordedEvent(eb, binds.eventName.value).select('f.queue')))
      .where(rawSql<boolean>(binds.taskIsLive, 'predicate')),
)

/** One event, by its key. */
const eventRow = (binds: { queue: string; eventName: EventName }) =>
  treeBuilder
    .selectFrom('events')
    .where('queue', '=', binds.queue)
    .where('event_name', '=', binds.eventName.value)

/**
 * `emit-event`'s read of the stored event. It is an open read: on a replay the row may
 * carry an earlier delivery's stamp, and its payload must be TEXT whoever stamped it.
 * How a dialect names a stored value's type is the store's.
 */
export const storedEventRead = defineStatement(
  'emit-event stored-event',
  (binds: { queue: string; eventName: EventName; payloadType: SqlFragment }) =>
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
  (
    binds: AwaitingClaim & {
      eventName: EventName
      payloadType: SqlFragment
      liveTask: SqlFragment
    },
  ) =>
    eventRow(binds)
      .select('payload')
      .select(() => [aliasedAs(rawSql<string>(binds.payloadType, 'value'), 'payload_type')])
      .where((where) => where.exists(stillClaimed(binds, binds.liveTask))),
)

/**
 * A terminal batch's completion event (DESIGN.md §3.2, specs/ChildTasks.tla's
 * ChildTerminal): the first outcome the task reached, written by the batch that ended
 * it. It selects from the task row this batch made terminal, under the stamp of the
 * statement named `terminal`, so a batch that ended nothing writes no event. Only that
 * statement writes that stamp, and it writes the state the payload reports.
 *
 * First write wins without a conflict clause, which a follow-on insert may not carry:
 * an event that exists is left alone, so a revived task that ends again keeps its
 * first outcome. Every dialect serializes this batch against an await of the same
 * event, so nothing can insert the event between the check and the insert.
 *
 * That is the completion event's lock, which this statement names, so every batch that
 * can end a task holds it and no store takes it by hand. It is held whether or not the
 * batch ends the task, and this is where that is decided, once: a `fail` that schedules
 * a retry, a lost-launch sweep that reopens, and a sweep that places a successor all
 * take it and record nothing. A lock is taken before the transaction's first statement,
 * on MySQL before the transaction, and only the compare-and-set inside it knows whether
 * the task ends. Taking the lock after that statement won would wait on a lock while
 * holding row locks, which is the order every dialect's executor rules out (event first,
 * then rows). The price is one round trip on a dialect that pays one for each statement.
 */
export const taskDoneEventInsert = defineStatement(
  'task-done event',
  (binds: {
    queue: string
    taskId: string
    payloadJson: string
    /** The statement of this batch that made the task terminal. */
    terminal: string
  }) => {
    const eventName = taskDoneEventName(binds.taskId)
    const eb = expressionBuilder<{ f: StoreTables['tasks'] }, 'f'>()
    const event = {
      queue: eb.ref('f.queue'),
      event_name: eb.val(eventName),
      payload: eb.val(binds.payloadJson),
      emitted_at_ms: eb.ref('f.fence_at_ms'),
      fence_stamp: stampValue,
      fence_at_ms: eb.ref('f.fence_at_ms'),
    }
    const { columns, selections } = insertedFrom(event)
    return treeBuilder
      .insertInto('events')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('tasks as f')
          .select(selections)
          .where('f.task_id', '=', binds.taskId)
          .where('f.queue', '=', binds.queue)
          .where('f.fence_stamp', '=', fenceValue(binds.terminal))
          .where((where) =>
            where.not(
              where.exists(
                where
                  .selectFrom('events as e')
                  .select('e.queue')
                  .whereRef('e.queue', '=', 'f.queue')
                  .where('e.event_name', '=', eventName),
              ),
            ),
          ),
      )
  },
  (binds) => ({ queue: binds.queue, eventName: EventName.taskDone(binds.taskId) }),
)

/**
 * `await-event`'s other compare-and-set, for a child that ended with nothing recorded
 * (specs/ChildTasks.tla's AwaitMaterialize): a build older than the completion event
 * ended it, so no terminal batch will ever write its event. The await writes the event
 * itself, from the outcome the store read, and answers as a hit. The insert is fenced
 * on the child's row being the one that was read: it carries the same stamp, which any
 * transition since, such as a revival, would have replaced. The store has already
 * refused a child in another queue, and a row under the stamp that was read is in the
 * state that was read, so neither is asked again. It requires that no event exists, and
 * that the awaiting run still holds its claim.
 */
export const materializeTaskDoneCas = defineStatement(
  'await-event materialize',
  (
    binds: AwaitingClaim & {
      eventName: EventName
      payloadJson: string
      /** The stamp the child's row carried when its outcome was read, or null. */
      childStamp: string | null
      liveTask: SqlFragment
    },
  ) => {
    // The child is the one the name carries. A caller's event names no task, and an
    // insert keyed on a null task id would write nothing and say nothing.
    const childTaskId = binds.eventName.taskId
    if (childTaskId === null) {
      throw new Error('await-event materialize records a completion event, and was given another')
    }
    const eb = expressionBuilder<{ c: StoreTables['tasks'] }, 'c'>()
    const event = {
      queue: eb.ref('c.queue'),
      event_name: eb.val(binds.eventName.value),
      payload: eb.val(binds.payloadJson),
      emitted_at_ms: nowValue,
      ...FENCE_ASSIGNMENTS,
    }
    const { columns, selections } = insertedFrom(event)
    return treeBuilder
      .insertInto('events')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('tasks as c')
          .select(selections)
          .where('c.task_id', '=', childTaskId)
          .where('c.fence_stamp', 'is not distinct from', binds.childStamp)
          .where((where) =>
            where.not(
              where.exists(
                where
                  .selectFrom('events as e')
                  .select('e.queue')
                  .whereRef('e.queue', '=', 'c.queue')
                  .where('e.event_name', '=', binds.eventName.value),
              ),
            ),
          )
          .where((where) => where.exists(stillClaimed(binds, binds.liveTask))),
      )
  },
  onItsEvent,
)
