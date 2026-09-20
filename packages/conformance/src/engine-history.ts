import type { SqlExecutor } from '@durablerun/core'
import { childTaskViolations } from './child-task-rows.js'
import { engineInvariantViolations } from './invariants.js'
import { sagaViolations } from './saga-rows.js'

/**
 * Everything the rows of a history must satisfy when only the engine wrote them: the
 * invariant library, what specs/ChildTasks.tla requires, and what specs/Sagas.tla
 * requires. A walk, a matrix cell, and a scenario judge their rows here, so no surface
 * can leave a checker out, and a checker added here reaches every one of them. A test
 * that writes a terminal task by hand runs the invariant library alone, because a
 * hand-written ending has no batch that could have recorded its completion event.
 */
export async function engineHistoryViolations(raw: SqlExecutor): Promise<string[]> {
  return [
    ...(await engineInvariantViolations(raw)),
    ...(await childTaskViolations(raw)),
    ...(await sagaViolations(raw)),
  ]
}
