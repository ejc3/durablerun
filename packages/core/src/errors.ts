/**
 * Engine error taxonomy, ported from Absurd's custom SQLSTATEs and internal
 * SDK exceptions (DESIGN.md §1.2): AB001 → RunCancelledError, AB002 →
 * LeaseLostError; SuspendSignal is the internal control-flow signal thrown by
 * ctx.sleepFor / ctx.awaitEvent and caught by the worker runtime.
 */

import { TASK_INTRINSICS } from './intrinsics.js'

export type TaskThrowableSnapshot = Readonly<{
  kind: 'failure'
  fatal: boolean
  failureJson: string
}>

const {
  JSONStringify: stringifyJson,
  ObjectFreeze: freeze,
  ObjectGetOwnPropertyDescriptor: getOwnPropertyDescriptor,
  ObjectGetPrototypeOf: getPrototypeOf,
  ObjectHasOwn: hasOwn,
  StringFrom: stringifyPrimitive,
} = TASK_INTRINSICS
const AUTHENTIC_FATAL_FAILURES = new WeakMap<object, TaskThrowableSnapshot>()
const getAuthenticFatalFailure = AUTHENTIC_FATAL_FAILURES.get.bind(AUTHENTIC_FATAL_FAILURES)
const setAuthenticFatalFailure = AUTHENTIC_FATAL_FAILURES.set.bind(AUTHENTIC_FATAL_FAILURES)

function taskFailureJson(name: string, message: string): string {
  // Quote primitive strings separately: serializing an object would consult a
  // user-installed Object.prototype.toJSON after the handler has run.
  return `{"name":${stringifyJson(name)},"message":${stringifyJson(message)}}`
}

export const UNINSPECTABLE_TASK_FAILURE_JSON = taskFailureJson(
  'Error',
  'task threw an uninspectable value',
)

const GENERIC_TASK_FAILURE = freeze({
  kind: 'failure',
  fatal: false,
  failureJson: UNINSPECTABLE_TASK_FAILURE_JSON,
} as const)

function authenticateFatalFailure(error: object, snapshot: TaskThrowableSnapshot): void {
  setAuthenticFatalFailure(error, freeze(snapshot))
}

type DataString =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsafe' }

/**
 * Read an Error-like data field without invoking accessors or coercion.
 * Prototype traversal preserves built-in names such as TypeError while the
 * fixed depth makes hostile or cyclic proxy chains total.
 */
function errorDataString(value: object, field: 'name' | 'message'): DataString {
  let current: object | null = value
  for (let depth = 0; depth < 8 && current !== null; depth++) {
    const descriptor = getOwnPropertyDescriptor(current, field)
    if (descriptor !== undefined) {
      return hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
        ? { kind: 'value', value: descriptor.value }
        : { kind: 'unsafe' }
    }
    current = getPrototypeOf(current)
  }
  return current === null ? { kind: 'absent' } : { kind: 'unsafe' }
}

function unauthenticatedTaskFailure(value: unknown): TaskThrowableSnapshot {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const name = errorDataString(value, 'name')
    if (name.kind === 'unsafe') return GENERIC_TASK_FAILURE
    const message = errorDataString(value, 'message')
    if (message.kind !== 'value') return GENERIC_TASK_FAILURE
    return freeze({
      kind: 'failure',
      fatal: false,
      failureJson: taskFailureJson(name.kind === 'value' ? name.value : 'Error', message.value),
    })
  }

  const message = typeof value === 'string' ? value : stringifyPrimitive(value)
  return freeze({
    kind: 'failure',
    fatal: false,
    failureJson: taskFailureJson('Error', message),
  })
}

/**
 * The single total user-failure boundary. FatalTaskError is the one
 * intentionally public policy signal; every other JavaScript value becomes
 * owned failure JSON without retaining, coercing an object, or later
 * re-reading the thrown value. Engine control authority is invocation-local
 * in the SDK and is checked before this function is called.
 */
export function snapshotTaskThrowable(value: unknown): TaskThrowableSnapshot {
  try {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      const authentic = getAuthenticFatalFailure(value)
      if (authentic !== undefined) return authentic
    }
    return unauthenticatedTaskFailure(value)
  } catch {
    return GENERIC_TASK_FAILURE
  }
}

export class SuspendSignal extends Error {
  override readonly name = 'SuspendSignal'
  constructor(
    readonly reason: 'sleep' | 'await-event' | 'chain',
    /** Where the runtime should park the run (relative, or the sanctioned
     * user absolute). Omitted for 'chain' (wake immediately). */
    readonly wake?: { inSeconds: number } | { atEpochMs: number },
    /**
     * The suspension marker, written IN THE SAME transition as the park —
     * a marker without a park lies ("the wake already happened"), so the
     * two must be one atomic batch (store.suspendRun).
     */
    readonly checkpoint?: { key: string; stateJson: string },
  ) {
    super(`run suspended: ${reason}`)
  }
}

/** The run was cancelled (Absurd AB001); abort the handler quietly. */
export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError'
}

/**
 * The lease is gone — swept, superseded, or expired (Absurd AB002). The
 * worker must abort immediately when this originates at a trusted store or
 * runtime boundary; another claim now owns the run. Task construction alone
 * carries no runtime authority.
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError'
}

/**
 * The store could not be reached or the write did not go through — a
 * TRANSIENT infrastructure failure (network, busy database). Consumers
 * classify this type only at the immediate trusted store boundary:
 * infrastructure problems abort a pass quietly and recover through the
 * lease, and must never spend the user's retry budget. Task construction
 * alone carries no runtime authority.
 */
export class StoreUnavailableError extends Error {
  override readonly name = 'StoreUnavailableError'
}

/**
 * The database's schema is not the one this build expects — a missing table
 * or column. DELIBERATELY NOT a StoreUnavailableError: it is permanent, and
 * waiting does not repair it.
 *
 * That distinction is the whole point of the type. Consumers classify
 * infrastructure trouble by type and respond by aborting the pass and
 * recovering through the lease, which for a schema mismatch means retrying a
 * deterministic failure until the run's infrastructure budget is gone — the
 * task then dies reporting exhausted infrastructure and the real cause (an
 * un-migrated database, most often mid-deploy) is recorded nowhere. Naming
 * the fault separately makes that outcome unreachable rather than merely
 * unlikely.
 */
export class SchemaMismatchError extends Error {
  override readonly name = 'SchemaMismatchError'
}

/**
 * The schema metadata relation does not exist yet, so migration may initialize
 * a genuinely fresh database. Dialect executors emit this only for the
 * canonical schema-version read; StoreAdmin must never infer it from text.
 */
export class SchemaNotInitializedError extends Error {
  override readonly name = 'SchemaNotInitializedError'
}

/** Intentionally public task policy: permanent failure, skip retries. */
export class FatalTaskError extends Error {
  override readonly name = 'FatalTaskError'
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    const descriptor = getOwnPropertyDescriptor(this, 'message')
    const ownedMessage =
      descriptor !== undefined &&
      hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
        ? descriptor.value
        : ''
    authenticateFatalFailure(
      this,
      freeze({
        kind: 'failure',
        fatal: true,
        failureJson: taskFailureJson('FatalTaskError', ownedMessage),
      }),
    )
  }
}

/**
 * An awaitEvent timeout fired: the claim delivered `wakeEvent` with a NULL
 * payload (§3.4 rule 2's TimeoutError path). Raised into user code by the SDK.
 */
export class EventTimeoutError extends Error {
  override readonly name = 'EventTimeoutError'
  constructor(readonly eventName: string) {
    super(`timed out waiting for event '${eventName}'`)
  }
}
