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
