/**
 * Numeric port-boundary validation (DESIGN.md §3.4 numeric contract).
 *
 * SQL drivers bind JS numbers as REAL and INTEGER columns are affinity, not
 * enforcement: an unchecked `Infinity` becomes an unexpirable lease, an
 * unsafe integer poisons later reads (libsql throws RangeError), and a
 * fractional product breaks the integer epoch-ms contract. The rule that
 * falls out: client-supplied durations and epochs cross the port ONLY
 * through these validators, and SQL never multiplies a client number —
 * milliseconds are computed (and rounded) here.
 */

import { FatalTaskError } from './errors.js'

/** 9999-12-31T23:59:59Z — no legitimate engine timestamp lies beyond it. */
export const MAX_EPOCH_MS = 253_402_300_799_000

/** 100 years — no legitimate relative duration is longer. */
export const MAX_DURATION_MS = 3_155_760_000_000

/**
 * A relative duration in seconds → integer milliseconds. Fractional seconds
 * are legal (rounded to the nearest ms); non-finite, negative, or >100y are
 * not. `positive` additionally requires at least 1ms (leases, extensions).
 */
export function durationToMs(
  name: string,
  seconds: number,
  opts: { positive?: boolean } = {},
): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(`${name} must be a finite non-negative number of seconds, got ${seconds}`)
  }
  const ms = Math.round(seconds * 1000)
  if (ms > MAX_DURATION_MS) {
    throw new RangeError(`${name} exceeds the 100-year duration bound: ${seconds}s`)
  }
  if (opts.positive && ms < 1) {
    throw new RangeError(`${name} must be at least 1ms, got ${seconds}s`)
  }
  return ms
}

/** An absolute epoch-ms instant (ctx.sleepUntil — the one sanctioned user absolute). */
export function requireEpochMs(name: string, epochMs: number): number {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > MAX_EPOCH_MS) {
    throw new RangeError(
      `${name} must be an integer epoch-ms in [0, ${MAX_EPOCH_MS}], got ${epochMs}`,
    )
  }
  return epochMs
}

/**
 * A million. Every count that crosses this port ends up bounding a run
 * ordinal, and the ordinal counts EVERY successor — so an accepted
 * MAX_SAFE_INTEGER lets a successor be written at an ordinal SQLite stores
 * happily and JavaScript cannot represent. Every later claim decoding that
 * run then throws, and the task sits pending forever with no worker able to
 * take it. No real workload needs more, and the bound leaves the ordinal
 * ten orders of magnitude clear of the representable range.
 */
export const MAX_COUNT = 1_000_000

/** Counts: maxAttempts, claim limits. */
export function requirePositiveInt(name: string, value: number, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min || value > MAX_COUNT) {
    throw new RangeError(`${name} must be an integer in [${min}, ${MAX_COUNT}], got ${value}`)
  }
  return value
}

/** What a bad value IS, for an error message that saves a debugging session. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

/*
 * User-boundary validators: task-facing inputs (names and knobs a task
 * function passes to its context) cross into the engine ONLY through the
 * forms below. The validator IS the classifier — a deterministic bad input
 * is a permanent task failure (FatalTaskError), never a retryable one, so
 * it can never loop through lease recovery burning attempts. The raw
 * RangeError validators above remain the PORT classification for store
 * callers; packages/sdk/src is lint-banned from importing them.
 */

/**
 * A validated user-supplied name, mintable only through parse — code that
 * builds durable replay keys can demand this type and become structurally
 * unable to accept a raw string (the events round shipped the same
 * reserved-charset bug a second time because the check lived per-method).
 */
export class UserName {
  private declare readonly userNameBrand: undefined

  private constructor(readonly value: string) {}

  /**
   * '#' anywhere collides with DERIVED replay keys (`poll#2`); a '$'
   * prefix collides with the engine's own markers (`$sleep`, `$await:`).
   */
  static parse(what: string, raw: string): UserName {
    // The type says string; the callers include JavaScript, decoded JSON and
    // anything typed `any`. Reaching .includes() on a non-string throws a
    // plain TypeError, which the worker reads as an ordinary user failure and
    // RETRIES — so one deterministic bad call runs maxAttempts times, redoing
    // whatever the handler did before it each time. Deterministic bad input
    // has to be permanent.
    if (typeof raw !== 'string') {
      throw new FatalTaskError(`${what} must be a string, got ${describe(raw)}`)
    }
    if (raw.includes('#') || raw.startsWith('$')) {
      throw new FatalTaskError(
        `${what} '${raw}' uses reserved characters ('#' anywhere, '$' prefix)`,
      )
    }
    // A durable key must survive a round-trip through storage. A NUL
    // truncates a SQLite TEXT value at the first byte, and a lone surrogate
    // (not well-formed UTF-16) is re-encoded to U+FFFD — either way two
    // distinct JS names collide or a name silently changes, and its wake
    // never matches. Reject both at the single mint point.
    if (raw.includes('\u0000') || /\p{Surrogate}/u.test(raw)) {
      throw new FatalTaskError(
        `${what} '${raw}' contains characters that do not round-trip through storage (NUL or a lone surrogate)`,
      )
    }
    return new UserName(raw)
  }
}

/** durationToMs, classified for the task boundary. */
export function userDurationToMs(
  name: string,
  seconds: number,
  opts: { positive?: boolean } = {},
): number {
  try {
    return durationToMs(name, seconds, opts)
  } catch (error) {
    throw new FatalTaskError(String(error))
  }
}

/**
 * A serialized VALUE crossing the user boundary — the third kind of user
 * input, alongside names and knobs.
 *
 * The boundary only had validators for names and knobs, so a value had
 * nowhere to be checked and went straight to the database driver. That
 * matters because `JSON.stringify` is typed `(value: any) => string` but
 * returns `undefined` for undefined, functions and symbols, so
 * `JSON.stringify(obj.missingProperty)` type-checks and yields undefined.
 * The driver then rejects the bind, the store wraps every driver throw as an
 * outage, and the worker treats an outage as infrastructure — so an ordinary
 * typo consumed the whole infrastructure-retry budget, re-ran the task body
 * on every one of those attempts, and reported exhausted infrastructure with
 * no user-visible reason. Deterministic bad input must never loop through
 * lease recovery.
 *
 * Parse and reserialize, rather than only checking, deliberately gives every
 * value crossing this boundary one wire representation. Otherwise equivalent
 * spellings such as `{ "a": 1 }` and `{"a":1}` become distinct durable data.
 */
export function userJsonValue(what: string, json: string): string {
  if (typeof json !== 'string') {
    throw new FatalTaskError(
      `${what} is ${describe(json)}, not a JSON string — JSON.stringify returns undefined for undefined, functions and symbols`,
    )
  }
  try {
    return JSON.stringify(JSON.parse(json))
  } catch (error) {
    throw new FatalTaskError(`${what} is not valid JSON: ${String(error)}`)
  }
}

/** requireEpochMs, classified for the task boundary. */
export function userEpochMs(name: string, epochMs: number): number {
  try {
    return requireEpochMs(name, epochMs)
  } catch (error) {
    throw new FatalTaskError(String(error))
  }
}
