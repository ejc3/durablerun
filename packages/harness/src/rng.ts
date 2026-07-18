/**
 * Seeded deterministic PRNG (mulberry32). Engine code never uses randomness;
 * this exists solely so the simulation scheduler's choices replay by seed.
 */
export class Rng {
  private state: number

  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed)
    if (this.state === 0) this.state = 0x9e3779b9
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (n <= 0) throw new RangeError(`int(${n})`)
    return Math.floor(this.next() * n)
  }

  /** Pick one element. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)]
    if (item === undefined) throw new RangeError('pick from empty array')
    return item
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
