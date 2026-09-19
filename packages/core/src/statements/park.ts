import type { Expression, ExpressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  fenceValue,
  literalValue,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import type { TaskState } from '../types.js'

/**
 * The state a statement gives a task, by name. It is a value node, written into the
 * statement's text and never bound, so a batch can read whether the statement ends the
 * task and the text comes from the declaration: the two cannot disagree.
 */
export const taskStateValue = (state: TaskState): Expression<TaskState> => literalValue(state)

/**
 * The state of run `runId` as the statement named `fence` left it, for a task that
 * follows its run. It is built from nodes, so a batch reads it as the copy of a run's
 * state and not as a state the statement names.
 */
export const stampedRunState = (runId: string, fence: string): Expression<string> =>
  treeBuilder
    .selectFrom('runs as f')
    .select('f.state')
    .where('f.run_id', '=', runId)
    .where('f.fence_stamp', '=', fenceValue(fence))
    .$asScalar()

/** The claim columns a parked run clears, so it carries no live token, lease deadline, or heartbeat. */
export const PARKED_CLAIM_COLUMNS = {
  claimed_by: null,
  claim_expires_at_ms: null,
  heartbeat_at_ms: null,
} as const

/**
 * The same columns as text assignments, for a follow-on that parks a run and is still
 * text. The type holds the two lists to the same columns.
 */
export const PARKED_CLAIM_CLEARED_TEXT = {
  claimed_by: 'NULL',
  claim_expires_at_ms: 'NULL',
  heartbeat_at_ms: 'NULL',
} as const satisfies Record<keyof typeof PARKED_CLAIM_COLUMNS, 'NULL'>

/**
 * What parking a claimed run assigns, for every transition that parks one: the run is
 * due now or sleeps until `wakeAt`, it gives up its claim, and it takes this statement's
 * stamp. `wakeAt` is the store's wake instant, database time plus a relative wake or a
 * validated absolute one.
 */
export function parkAssignments(eb: ExpressionBuilder<StoreTables, 'runs'>, wakeAt: SqlFragment) {
  return {
    state: eb
      .case()
      .when(rawSql<number>(wakeAt, 'value'), '<=', nowValue)
      .then('pending')
      .else('sleeping')
      .end(),
    available_at_ms: rawSql<number>(wakeAt, 'value'),
    ...PARKED_CLAIM_COLUMNS,
    ...FENCE_ASSIGNMENTS,
  }
}
