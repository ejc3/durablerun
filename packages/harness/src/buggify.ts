import type { Buggify } from '@durablerun/core'
import type { Rng } from './rng.js'

/**
 * Seeded buggify for simulations: each named site fires with the given
 * probability, drawn from the world's deterministic Rng — buggified runs
 * replay by seed exactly like everything else.
 */
export function seededBuggify(rng: Rng, probability: number): Buggify {
  if (probability < 0 || probability > 1) throw new RangeError(`probability ${probability}`)
  return () => rng.next() < probability
}
