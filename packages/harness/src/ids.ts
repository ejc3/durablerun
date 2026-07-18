import type { IdSource } from '@absurd-lite/core'
import type { Rng } from './rng.js'

/**
 * Deterministic IdSource for simulations: ids are monotonic (a counter
 * prefix preserves the time-ordering property UUIDv7 gives production ids —
 * run ordering ties break on id) and the random suffix replays by seed.
 */
export function seededIdSource(rng: Rng): IdSource {
  let counter = 0
  const hex = (n: number): string => {
    let out = ''
    for (let i = 0; i < n; i++) out += rng.int(16).toString(16)
    return out
  }
  return {
    uuidv7: () => `${(++counter).toString(16).padStart(12, '0')}-${hex(12)}`,
    token: () => `tok-${hex(24)}`,
  }
}
