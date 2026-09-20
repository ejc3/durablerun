/**
 * A store LIMIT must be a finite, non-negative integer. SQLite reads a negative
 * LIMIT as unlimited, so clamp and floor before any SQL sees it.
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new RangeError(`limit ${limit}`)
  return Math.max(0, Math.floor(limit))
}

/**
 * Run `fn` over `items` with at most `width` concurrent calls, preserving result
 * order. `width` must be a positive safe integer. Once one call rejects, no
 * further item starts, and mapLimit rejects with that first error only after
 * every started call has settled, so no work continues after it returns.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new RangeError(`mapLimit width must be a positive safe integer, got ${width}`)
  }
  const results = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | undefined
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (failure === undefined && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T)
      } catch (error) {
        if (failure === undefined) failure = { error }
      }
    }
  })
  await Promise.all(workers)
  if (failure !== undefined) throw failure.error
  return results
}

/**
 * The sweep runs its per-item batches at most this many at once through
 * `mapLimit`. The fencing discipline requires per-item atomicity, never
 * sequential issuance.
 */
export const SWEEP_PIPELINE_WIDTH = 8
