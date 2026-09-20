import {
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SqlExecutor,
  type SqlRow,
  decodeRollbackTry,
} from '@durablerun/core'

async function rowsOf(raw: SqlExecutor, sql: string): Promise<SqlRow[]> {
  const [result] = await raw.batch('saga-rows', [{ sql, args: [] }], 'read')
  return result?.rows ?? []
}

/**
 * What specs/Sagas.tla requires of any history the engine itself produced, read from the
 * saga's checkpoints (core `sagas.ts`). Like `childTaskViolations` it is not part of the
 * invariant library, which also judges rows the poison matrix writes by hand.
 *
 * - StartOrderDistinct: a start marker holds a positive index, and no two of a task share one.
 * - RollbackOnlyEligible: a rollback ran only for a step that started.
 * - SagaOnlyAfterDecision: a rollback or an attempt record exists only once the phase began.
 * - ReverseOrder: a step is rolled back only once every step that started after it is.
 * - ForwardFrozenInSaga: no forward checkpoint is as new as the phase marker, and a task
 *   in the phase never completed.
 * - OneAttemptRecordPerRun: no two attempt records of a task share an owning run. The
 *   model has no runs, so this one is the engine's own. A run fails once, so it writes one
 *   record at most, and the task result reads the record its last run wrote, with no
 *   order to choose among several.
 */
export async function sagaViolations(raw: SqlExecutor): Promise<string[]> {
  const tasks = await rowsOf(raw, 'SELECT task_id, state FROM tasks')
  const checkpoints = await rowsOf(
    raw,
    'SELECT task_id, checkpoint_name, state, owner_run_id, owner_attempt FROM checkpoints',
  )
  const violations: string[] = []
  const byTask = new Map<string, SqlRow[]>()
  for (const row of checkpoints) {
    const taskId = String(row.task_id)
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), row])
  }
  for (const task of tasks) {
    const taskId = String(task.task_id)
    const rows = byTask.get(taskId) ?? []
    const named = (prefix: string) =>
      rows.filter((row) => String(row.checkpoint_name).startsWith(prefix))
    const stepOf = (row: SqlRow, prefix: string) => String(row.checkpoint_name).slice(prefix.length)
    const marker = rows.find((row) => String(row.checkpoint_name) === SAGA_PHASE_CHECKPOINT)
    const started = new Map<string, number>()
    for (const row of named(SAGA_STARTED_PREFIX)) {
      const index = Number(row.state)
      if (!Number.isSafeInteger(index) || index < 1 || String(index) !== String(row.state)) {
        violations.push(`saga/start-index-not-a-positive-integer: ${taskId}/${row.checkpoint_name}`)
      }
      if ([...started.values()].includes(index)) {
        violations.push(`saga/start-index-shared: ${taskId}/${index}`)
      }
      started.set(stepOf(row, SAGA_STARTED_PREFIX), index)
    }
    const rolledBack = new Set(
      named(SAGA_ROLLBACK_PREFIX).map((row) => stepOf(row, SAGA_ROLLBACK_PREFIX)),
    )
    for (const step of rolledBack) {
      const index = started.get(step)
      if (index === undefined) {
        violations.push(`saga/rollback-of-a-step-that-never-started: ${taskId}/${step}`)
        continue
      }
      for (const [later, laterIndex] of started) {
        if (laterIndex > index && !rolledBack.has(later)) {
          violations.push(`saga/rollback-out-of-order: ${taskId}/${step} before ${later}`)
        }
      }
    }
    for (const row of named(SAGA_TRIES_PREFIX)) {
      if (decodeRollbackTry(String(row.state)) === null) {
        violations.push(`saga/attempt-record-undecodable: ${taskId}/${row.checkpoint_name}`)
      }
    }
    const owners = named(SAGA_TRIES_PREFIX).map((row) => String(row.owner_run_id))
    if (new Set(owners).size !== owners.length) {
      violations.push(`saga/attempt-records-share-a-run: ${taskId}`)
    }
    if (marker === undefined) {
      if (rolledBack.size > 0 || named(SAGA_TRIES_PREFIX).length > 0) {
        violations.push(`saga/rollback-outside-the-phase: ${taskId}`)
      }
      continue
    }
    if (String(task.state) === 'completed')
      violations.push(`saga/completed-in-the-phase: ${taskId}`)
    for (const row of rows) {
      const name = String(row.checkpoint_name)
      const ofThePhase =
        name === SAGA_PHASE_CHECKPOINT ||
        name.startsWith(SAGA_ROLLBACK_PREFIX) ||
        name.startsWith(SAGA_TRIES_PREFIX)
      if (!ofThePhase && Number(row.owner_attempt) >= Number(marker.owner_attempt)) {
        violations.push(`saga/forward-checkpoint-in-the-phase: ${taskId}/${name}`)
      }
    }
  }
  return violations
}
