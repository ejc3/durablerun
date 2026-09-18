import type { ExpressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
  stampValue,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { LIVE_STATES } from '../types.js'
import { CLEARED_WAKE_COLUMNS, whereClaimedRun } from './claimed-run.js'

/**
 * `complete`'s compare-and-set, defined once for every dialect. A store supplies its
 * task admission predicate, built from its own fragments.
 */
export const completeCas = defineStatement(
  'complete',
  (binds: {
    runId: string
    queue: string
    claimToken: string
    resultJson: string
    taskAdmitsCompletion: SqlFragment
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        state: 'completed',
        completed_at_ms: nowValue,
        result: binds.resultJson,
        ...CLEARED_WAKE_COLUMNS,
        claimed_by: null,
        claim_expires_at_ms: null,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where(rawSql<boolean>(binds.taskAdmitsCompletion, 'predicate')),
)

/**
 * `complete`'s task mirror, defined once for every dialect: the task of the run this batch
 * completed becomes completed, takes the result as its payload, and its deadline is
 * consumed. It follows the compare-and-set's stamp on that run, and binds the queue on both
 * sides, so neither subquery is correlated with the task row it writes,
 * and takes the run's instant, because a follow-on reads no clock. A task that is no longer
 * live is left alone.
 */
export const completeTaskMirror = defineStatement(
  'complete task',
  (binds: { runId: string; queue: string; resultJson: string }) => {
    const completedRun = (eb: ExpressionBuilder<StoreTables, 'tasks'>) =>
      eb
        .selectFrom('runs as f')
        .where('f.run_id', '=', binds.runId)
        .where('f.queue', '=', binds.queue)
        .where('f.fence_stamp', '=', fenceValue('complete'))
    return treeBuilder
      .updateTable('tasks')
      .set((eb) => ({
        state: 'completed',
        completed_payload: binds.resultJson,
        cancel_at_ms: null,
        fence_stamp: stampValue,
        fence_at_ms: completedRun(eb).select((run) =>
          run.fn.min('f.fence_at_ms').as('source_instant'),
        ),
      }))
      .where((eb) => eb('task_id', 'in', completedRun(eb).select('f.task_id')))
      .where('tasks.queue', '=', binds.queue)
      .where('state', 'in', [...LIVE_STATES])
  },
)
