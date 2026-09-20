import type { Expression } from 'kysely'
import { fenceValue, literalValue } from '../sql-tree.js'
import { treeBuilder } from '../store-tables.js'
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
