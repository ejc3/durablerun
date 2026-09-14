/**
 * A store LIMIT must be a finite, non-negative integer. SQLite reads a negative
 * LIMIT as unlimited, so clamp and floor before any SQL sees it.
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new RangeError(`limit ${limit}`)
  return Math.max(0, Math.floor(limit))
}

/** Run `fn` over `items` with at most `width` concurrent calls, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}
