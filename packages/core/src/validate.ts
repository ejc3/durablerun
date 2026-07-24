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

/** Counts: maxAttempts, claim limits. */
export function requirePositiveInt(name: string, value: number, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`)
  }
  return value
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
  private constructor(readonly value: string) {}

  /**
   * '#' anywhere collides with DERIVED replay keys (`poll#2`); a '$'
   * prefix collides with the engine's own markers (`$sleep`, `$await:`).
   */
  static parse(what: string, raw: string): UserName {
    if (raw.includes('#') || raw.startsWith('$')) {
      throw new FatalTaskError(
        `${what} '${raw}' uses reserved characters ('#' anywhere, '$' prefix)`,
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

/** requireEpochMs, classified for the task boundary. */
export function userEpochMs(name: string, epochMs: number): number {
  try {
    return requireEpochMs(name, epochMs)
  } catch (error) {
    throw new FatalTaskError(String(error))
  }
}
