import { describe, expect, it } from 'vitest'
import { decideRetry, retryDelaySeconds } from '../src/retry.js'
import { requirePositiveInt } from '../src/validate.js'

describe('retryDelaySeconds', () => {
  it('fixed strategy returns base delay regardless of attempt', () => {
    const s = { kind: 'fixed', baseSeconds: 30 } as const
    expect(retryDelaySeconds(s, 1)).toBe(30)
    expect(retryDelaySeconds(s, 7)).toBe(30)
  })

  it('exponential strategy is base * factor^(attempt-1), matching absurd.sql', () => {
    const s = { kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 3600 } as const
    expect(retryDelaySeconds(s, 1)).toBe(10)
    expect(retryDelaySeconds(s, 2)).toBe(20)
    expect(retryDelaySeconds(s, 5)).toBe(160)
  })

  it('exponential strategy caps at maxSeconds', () => {
    const s = { kind: 'exponential', baseSeconds: 10, factor: 3, maxSeconds: 100 } as const
    expect(retryDelaySeconds(s, 4)).toBe(100)
    expect(retryDelaySeconds(s, 20)).toBe(100)
  })

  it('a zero base stays zero when exponentiation overflows', () => {
    const s = { kind: 'exponential', baseSeconds: 0, factor: 2, maxSeconds: 3600 } as const
    expect(retryDelaySeconds(s, 1025)).toBe(0)
  })
})

describe('decideRetry', () => {
  it('never retries under the none strategy', () => {
    expect(decideRetry({ kind: 'none' }, 1, 10)).toEqual({ retry: false })
  })

  it('retries while the next attempt fits within maxAttempts', () => {
    const s = { kind: 'fixed', baseSeconds: 5 } as const
    expect(decideRetry(s, 1, 3)).toEqual({ retry: true, delaySeconds: 5 })
    expect(decideRetry(s, 2, 3)).toEqual({ retry: true, delaySeconds: 5 })
  })

  it('exhausts when the next attempt would exceed maxAttempts', () => {
    const s = { kind: 'fixed', baseSeconds: 5 } as const
    expect(decideRetry(s, 3, 3)).toEqual({ retry: false })
  })

  it('a single-attempt task never retries', () => {
    const s = { kind: 'exponential', baseSeconds: 1, factor: 2, maxSeconds: 60 } as const
    expect(decideRetry(s, 1, 1)).toEqual({ retry: false })
  })

  it('rejects nonsensical attempt numbers', () => {
    expect(() => decideRetry({ kind: 'none' }, 0, 3)).toThrow(RangeError)
  })
})

describe('attempt counts stay inside the range JavaScript can represent', () => {
  it('refuses a maxAttempts that would push a run ordinal past MAX_SAFE_INTEGER', () => {
    // The run ordinal counts every successor, so max_attempts bounds it. An
    // accepted MAX_SAFE_INTEGER lets a successor be written at an ordinal
    // SQLite stores happily and JavaScript cannot represent, after which
    // every claim decoding that run throws and the task is stuck pending
    // forever with no worker able to take it.
    expect(() => requirePositiveInt('maxAttempts', Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
    expect(() => requirePositiveInt('maxAttempts', 1_000_001)).toThrow(RangeError)
    expect(requirePositiveInt('maxAttempts', 1_000_000)).toBe(1_000_000)
  })
})
