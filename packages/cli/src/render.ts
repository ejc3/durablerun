import { createHash } from 'node:crypto'
import {
  type Checkpoint,
  REASON_CANCELLED,
  REASON_CLAIM_TIMEOUT,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  type TaskResult,
} from '@durablerun/core'

/**
 * Redaction and canonical JSON. A value a user wrote (params, headers, a checkpoint's state,
 * an event payload, a result, a failure reason the task's code wrote, an idempotency key)
 * prints as its byte length and sha256, and its text prints only with `--reveal`. A
 * database credential is full admin, and the rows hold those values in plaintext, so the
 * default is the one that does not copy them into a terminal or a log.
 */

/** A value a user wrote, as the CLI prints it. */
export interface UserValue {
  readonly bytes: number
  readonly sha256: string
  /** Present only with `--reveal`. */
  readonly text?: string
}

export function userValue(text: string, reveal: boolean): UserValue {
  const bytes = Buffer.byteLength(text, 'utf8')
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex')
  return reveal ? { bytes, sha256, text } : { bytes, sha256 }
}

/** The four failure reasons the engine writes itself. Each prints as its name. */
const ENGINE_REASONS: ReadonlyMap<string, string> = new Map([
  [REASON_CLAIM_TIMEOUT, '$ClaimTimeout'],
  [REASON_RELAUNCH_CAP, '$RelaunchCapExhausted'],
  [REASON_INFRA_CAP, '$InfraRetriesExhausted'],
  [REASON_CANCELLED, '$Cancelled'],
])

export type FailureReason = { readonly engine: string } | UserValue

/** A failure reason: an engine reason by its name, and any other as a user's value. */
export function failureReason(json: string, reveal: boolean): FailureReason {
  const engine = ENGINE_REASONS.get(json)
  return engine === undefined ? userValue(json, reveal) : { engine }
}

/** What `result` prints of a task's outcome. */
export function resultView(result: TaskResult, reveal: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = { state: result.state }
  if (result.completedPayloadJson !== undefined) {
    view.completedPayload = userValue(result.completedPayloadJson, reveal)
  }
  if (result.failureReasonJson !== undefined) {
    view.failureReason = failureReason(result.failureReasonJson, reveal)
  }
  if (result.rollback !== undefined) {
    const rollback: Record<string, unknown> = { outcome: result.rollback.outcome }
    if (result.rollback.errorJson !== undefined) {
      rollback.error = userValue(result.rollback.errorJson, reveal)
    }
    view.rollback = rollback
  }
  return view
}

/** What `checkpoints` prints of one checkpoint. Names print, and state is a user's value. */
export function checkpointView(checkpoint: Checkpoint, reveal: boolean): Record<string, unknown> {
  return {
    name: checkpoint.checkpointName,
    ownerRunId: checkpoint.ownerRunId,
    ownerAttempt: checkpoint.ownerAttempt,
    state: userValue(checkpoint.stateJson, reveal),
  }
}

/**
 * One JSON document, with every object's keys in code point order, so the same answer
 * prints the same bytes whichever store gave it.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key]
    if (entry !== undefined) sorted[key] = sortKeys(entry)
  }
  return sorted
}

function isUserValue(value: unknown): value is UserValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sha256?: unknown }).sha256 === 'string' &&
    typeof (value as { bytes?: unknown }).bytes === 'number'
  )
}

/**
 * The same document as text, one `name: value` line for each field, indented under the
 * object it belongs to. A user's value prints as its text when it was revealed, and as its
 * length and sha256 when it was not.
 */
export function humanText(value: Record<string, unknown>): string {
  const lines: string[] = []
  const walk = (entry: unknown, name: string, indent: string): void => {
    if (isUserValue(entry)) {
      lines.push(
        `${indent}${name}: ${entry.text ?? `<${entry.bytes} bytes, sha256 ${entry.sha256}>`}`,
      )
    } else if (Array.isArray(entry) && entry.every((item) => typeof item !== 'object')) {
      lines.push(`${indent}${name}: ${entry.length === 0 ? '(none)' : entry.join(', ')}`)
    } else if (Array.isArray(entry)) {
      lines.push(`${indent}${name}:`)
      entry.forEach((item, index) => walk(item, `[${index}]`, `${indent}  `))
    } else if (entry !== null && typeof entry === 'object') {
      lines.push(`${indent}${name}:`)
      for (const key of Object.keys(entry).sort()) {
        const inner = (entry as Record<string, unknown>)[key]
        if (inner !== undefined) walk(inner, key, `${indent}  `)
      }
    } else {
      lines.push(`${indent}${name}: ${String(entry)}`)
    }
  }
  for (const key of Object.keys(value).sort()) {
    const entry = value[key]
    if (entry !== undefined) walk(entry, key, '')
  }
  return `${lines.join('\n')}\n`
}
