import type { IdSource } from '@durablerun/core'
import { Rng } from './rng.js'

/**
 * Deterministic IdSource for simulations: ids are monotonic (a counter
 * prefix preserves the time-ordering property UUIDv7 gives production ids —
 * run ordering ties break on id) and the random suffix replays by seed.
 *
 * The two kinds of id draw from SEPARATE streams. Sharing one stream couples
 * them: a test that predicts the id an operation will mint — by replaying the
 * same seed and counting draws — then breaks whenever any unrelated code path
 * happens to take a token, even though nothing about the id it cares about
 * changed. That is a false failure that looks exactly like a real one, and it
 * fires precisely when the engine is being refactored, which is when a
 * regression suite most needs to be trustworthy. Splitting the streams makes
 * a predicted id depend only on how many ids were minted before it.
 */
export function seededIdSource(rng: Rng): IdSource {
  let counter = 0
  const ids = rng
  const tokens = new Rng(`${rng.seed}:tokens`)
  const hex = (from: Rng, n: number): string => {
    let out = ''
    for (let i = 0; i < n; i++) out += from.int(16).toString(16)
    return out
  }
  return {
    uuidv7: () => `${(++counter).toString(16).padStart(12, '0')}-${hex(ids, 12)}`,
    token: () => `tok-${hex(tokens, 24)}`,
  }
}
