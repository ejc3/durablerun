import {
  type SqlFragment,
  aliasedAs,
  defineStatement,
  nowValue,
  rawSql,
  stampValue,
} from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'

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
    stepName: string
    eventName: string
    /** The wait's timeout instant, or NULL for an untimed wait. */
    timeoutAt: SqlFragment
    timeoutFits: SqlFragment
    /** The run is still running under its claim, and its task is eligible. */
    claimHolds: SqlFragment
  }) =>
    treeBuilder
      .insertInto('waits')
      .columns([
        'run_id',
        'step_name',
        'queue',
        'task_id',
        'event_name',
        'status',
        'timeout_at_ms',
        'created_at_ms',
        'fence_stamp',
        'fence_at_ms',
      ])
      .expression(
        treeBuilder
          .selectNoFrom((eb) => [
            eb.val(binds.runId).as('run_id'),
            eb.val(binds.stepName).as('step_name'),
            eb.val(binds.queue).as('queue'),
            eb.val(binds.taskId).as('task_id'),
            eb.val(binds.eventName).as('event_name'),
            eb.val('waiting').as('status'),
            aliasedAs(rawSql<number | null>(binds.timeoutAt, 'value'), 'timeout_at_ms'),
            aliasedAs(nowValue, 'created_at_ms'),
            aliasedAs(stampValue, 'fence_stamp'),
            aliasedAs(nowValue, 'fence_at_ms'),
          ])
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('events')
                  .select('events.queue')
                  .where('events.queue', '=', binds.queue)
                  .where('events.event_name', '=', binds.eventName),
              ),
            ),
          )
          .where(rawSql<boolean>(binds.claimHolds, 'predicate'))
          .where(rawSql<boolean>(binds.timeoutFits, 'predicate')),
      )
      .onConflict((conflict) => conflict.columns(['run_id', 'step_name']).doNothing()),
)

/**
 * `emit-event`'s compare-and-set: record the event, first write wins. A re-emit keeps
 * the payload and the first instant and takes only this statement's stamp, which is
 * what lets the follow-ons of this batch fence on it. A dialect supplies its null-safe
 * inequality and what it requires of the existing row.
 */
export const emitEventCas = defineStatement(
  'emit-event',
  (binds: {
    queue: string
    eventName: string
    payloadJson: string
    stampDiffers: 'is not' | 'is distinct from'
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
          .where((eb) => eb('events.fence_stamp', binds.stampDiffers, stampValue))
          .where(rawSql<boolean>(binds.existingEventAdmits, 'predicate')),
      ),
)
