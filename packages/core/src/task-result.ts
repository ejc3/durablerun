import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlRow } from './primitives.js'
import type { TaskResult } from './types.js'

const { RangeError: TrustedRangeError, StringFrom: stringFrom } = TASK_INTRINSICS

/**
 * Decode a task's observable outcome from the `state`, `completed_payload`, and
 * `failure_reason` columns of its row. Every reader of a task outcome goes through
 * here, so no second read path can report a row the stores refuse.
 *
 * A completed task must carry its payload, a failed or cancelled task must carry
 * its reason, and no other state may carry a payload. A row that contradicts this
 * reports an outcome the engine never recorded, so it is refused with RangeError.
 * A reason on a live task stays legal, because reviving a failed task keeps its
 * last reason, as Absurd's retry_task does.
 */
export function decodeTaskResult(taskId: string, row: SqlRow): TaskResult {
  const result: TaskResult = { state: stringFrom(row.state) as TaskResult['state'] }
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
  return result
}
