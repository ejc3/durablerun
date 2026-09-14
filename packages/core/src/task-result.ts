import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlRow } from './primitives.js'
import { LIVE_STATES, TERMINAL_STATES, type TaskResult } from './types.js'

const { RangeError: TrustedRangeError, StringFrom: stringFrom } = TASK_INTRINSICS

const TASK_STATE_SET: ReadonlySet<string> = new Set([...LIVE_STATES, ...TERMINAL_STATES])

/** The task columns `decodeTaskResult` reads: select exactly this list to decode an outcome. */
export const TASK_RESULT_COLUMNS = 'state, completed_payload, failure_reason'

/**
 * Decode a task's observable outcome from a row that selected `TASK_RESULT_COLUMNS`.
 *
 * A completed task must carry its payload, a failed or cancelled task must carry
 * its reason, and no other state may carry either. A row that contradicts this,
 * names an unknown state, or lacks one of the columns reports an outcome the
 * engine never recorded, so it is refused with RangeError.
 */
export function decodeTaskResult(taskId: string, row: SqlRow): TaskResult {
  for (const column of ['state', 'completed_payload', 'failure_reason'] as const) {
    if (row[column] === undefined) {
      throw new TrustedRangeError(`task ${taskId} row has no ${column} column`)
    }
  }
  const state = stringFrom(row.state)
  if (!TASK_STATE_SET.has(state)) {
    throw new TrustedRangeError(`task ${taskId} has unknown state ${state}`)
  }
  const result: TaskResult = { state: state as TaskResult['state'] }
  if (row.completed_payload !== null)
    result.completedPayloadJson = stringFrom(row.completed_payload)
  if (row.failure_reason !== null) result.failureReasonJson = stringFrom(row.failure_reason)
  const hasPayload = result.completedPayloadJson !== undefined
  if (result.state === 'completed' && !hasPayload) {
    throw new TrustedRangeError(`task ${taskId} is completed but has no completed payload`)
  }
  if (result.state !== 'completed' && hasPayload) {
    throw new TrustedRangeError(`task ${taskId} is ${result.state} but carries a completed payload`)
  }
  if (
    (result.state === 'failed' || result.state === 'cancelled') &&
    result.failureReasonJson === undefined
  ) {
    throw new TrustedRangeError(`task ${taskId} is ${result.state} but has no failure reason`)
  }
  if (
    result.state !== 'failed' &&
    result.state !== 'cancelled' &&
    result.failureReasonJson !== undefined
  ) {
    throw new TrustedRangeError(`task ${taskId} is ${result.state} but carries a failure reason`)
  }
  return result
}
