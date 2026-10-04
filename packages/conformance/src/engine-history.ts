import type { SqlExecutor } from '@durablerun/core'
import { childTaskViolations } from './child-task-rows.js'
import { engineInvariantViolations } from './invariants.js'
import { retentionViolations } from './retention-rows.js'
import { sagaViolations } from './saga-rows.js'

/**
 * Everything the rows of a history must satisfy when only the engine wrote them: the
 * invariant library, what specs/ChildTasks.tla requires, what specs/Sagas.tla requires,
 * and what specs/Retention.tla requires of the rows that none of those reads. Every
 * generated surface and seeded race whose rows only the engine wrote judges them here:
 * the fuzz walk, a fault matrix cell, the self-concurrency, identifier, child-task, saga,
 * and retention surfaces, the suite's seeded races, and the SDK's tests. So none of them
 * can leave a checker out, and a checker added here reaches them all. A test that writes
 * a terminal task by hand still runs the invariant library alone, because a hand-written
 * ending has no batch that could have recorded its completion event. So does a scenario
 * case of the suite that names the library, and a test of one checker calls that checker.
 */
export async function engineHistoryViolations(raw: SqlExecutor): Promise<string[]> {
  return [
    ...(await engineInvariantViolations(raw)),
    ...(await childTaskViolations(raw)),
    ...(await sagaViolations(raw)),
    ...(await retentionViolations(raw)),
  ]
}
