import { expressionBuilder } from 'kysely'
import {
  type SqlFragment,
  aliasedAs,
  defineStatement,
  nowValue,
  rawSql,
  stampValue,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'

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
    // One record, so a column and its value cannot fall out of step: the insert stamp
    // rule reads the SELECT list by column position.
    const wait = {
      run_id: eb.val(binds.runId),
      step_name: eb.val(binds.stepName),
      queue: eb.val(binds.queue),
      task_id: eb.val(binds.taskId),
      event_name: eb.val(binds.eventName),
      status: eb.val('waiting'),
      timeout_at_ms: rawSql<number | null>(binds.timeoutAt, 'value'),
      created_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    }
    const columns = Object.keys(wait) as (keyof typeof wait)[]
    return treeBuilder
      .insertInto('waits')
      .columns(columns)
      .expression(
        treeBuilder
          .selectNoFrom(() =>
            columns.map((column) => aliasedAs<unknown, typeof column>(wait[column], column)),
          )
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
          // The run is still running under its claim, and its task is eligible. The
          // claim's identity is nodes, so a store fragment cannot leave it out.
          .where((where) =>
            where.exists(
              where
                .selectFrom('runs as r')
                .innerJoin('tasks as t', (join) =>
                  join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')),
                )
                .select('r.run_id')
                .where('r.run_id', '=', binds.runId)
                .where('r.queue', '=', binds.queue)
                .where('r.task_id', '=', binds.taskId)
                .where('r.claimed_by', '=', binds.claimToken)
                .where('r.state', '=', 'running')
                .where(rawSql<boolean>(binds.taskEligible, 'predicate')),
            ),
          )
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
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
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
