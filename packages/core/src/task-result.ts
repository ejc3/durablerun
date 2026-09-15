import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlRow } from './primitives.js'
import { LIVE_STATES, TERMINAL_STATES, type TaskResult, type TaskState } from './types.js'

const {
  ObjectCreate: createObject,
  ObjectFreeze: freeze,
  ObjectHasOwn: hasOwn,
  RangeError: TrustedRangeError,
  StringFrom: stringFrom,
} = TASK_INTRINSICS

/** The task columns that hold an outcome. The stores own them; every other reader decodes here. */
export const TASK_OUTCOME_COLUMNS = Object.freeze(['completed_payload', 'failure_reason'] as const)

const TASK_RESULT_COLUMN_LIST = Object.freeze(['state', ...TASK_OUTCOME_COLUMNS] as const)

/** The task columns `decodeTaskResult` reads: select exactly this list to decode an outcome. */
export const TASK_RESULT_COLUMNS = TASK_RESULT_COLUMN_LIST.join(', ')

const TASK_STATE_NAMES: Readonly<Record<string, true>> = (() => {
  const names = createObject(null) as Record<string, true>
  for (const state of [...LIVE_STATES, ...TERMINAL_STATES]) names[state] = true
  return freeze(names)
})()

/** A way a task row's outcome can contradict its state. */
export type TaskResultContradiction =
  | 'completed-without-payload'
  | 'payload-on-other-state'
  | 'failure-without-reason'
  | 'reason-on-other-state'

const CONTRADICTION_DETAIL = Object.freeze({
  'completed-without-payload': 'has no completed payload',
  'payload-on-other-state': 'carries a completed payload',
  'failure-without-reason': 'has no failure reason',
  'reason-on-other-state': 'carries a failure reason',
} as const satisfies Record<TaskResultContradiction, string>)

/**
 * Read a task's outcome from a row that selected `TASK_RESULT_COLUMNS`, without
 * checking it against the state. A row that lacks one of the columns or names an
 * unknown state is refused with RangeError.
 */
export function readTaskResult(taskId: string, row: SqlRow): TaskResult {
  for (let index = 0; index < TASK_RESULT_COLUMN_LIST.length; index++) {
    const column = TASK_RESULT_COLUMN_LIST[index] as string
    if (!hasOwn(row, column) || row[column] === undefined) {
      throw new TrustedRangeError(`task ${taskId} row has no ${column} column`)
    }
  }
  const state = stringFrom(row.state)
  if (!hasOwn(TASK_STATE_NAMES, state)) {
    throw new TrustedRangeError(`task ${taskId} has unknown state ${state}`)
  }
  const result: TaskResult = { state: state as TaskState }
  if (row.completed_payload !== null)
    result.completedPayloadJson = stringFrom(row.completed_payload)
  if (row.failure_reason !== null) result.failureReasonJson = stringFrom(row.failure_reason)
  return result
}

/**
 * The first rule `result` breaks, or null. A completed task must carry its payload,
 * a failed or cancelled task must carry its reason, and no other state may carry
 * either.
 */
export function taskResultContradiction(result: TaskResult): TaskResultContradiction | null {
  const hasPayload = result.completedPayloadJson !== undefined
  if (result.state === 'completed' && !hasPayload) return 'completed-without-payload'
  if (result.state !== 'completed' && hasPayload) return 'payload-on-other-state'
  const failed = result.state === 'failed' || result.state === 'cancelled'
  if (failed && result.failureReasonJson === undefined) return 'failure-without-reason'
  if (!failed && result.failureReasonJson !== undefined) return 'reason-on-other-state'
  return null
}

/**
 * Decode a task's observable outcome from a row that selected `TASK_RESULT_COLUMNS`.
 * A row that lacks a column, names an unknown state, or contradicts its state reports
 * an outcome the engine never recorded, so it is refused with RangeError.
 */
export function decodeTaskResult(taskId: string, row: SqlRow): TaskResult {
  const result = readTaskResult(taskId, row)
  const contradiction = taskResultContradiction(result)
  if (contradiction !== null) {
    throw new TrustedRangeError(
      `task ${taskId} is ${result.state} but ${CONTRADICTION_DETAIL[contradiction]}`,
    )
  }
  return result
}
