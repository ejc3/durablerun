import { describe, expect, it } from 'vitest'
import {
  attributeExpectedFailure,
  attributeReplacedFailure,
  requireExpectedFailure,
} from '../src/testing.js'
import type { RetryStrategy } from '../src/types.js'
import { decideRetry, normalizeRetryStrategy, retryDelaySeconds } from '../src/retry.js'
import { MAX_DURATION_MS, requirePositiveInt } from '../src/validate.js'

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

  it('a zero base stays zero when exponentiation overflows', async () => {
    const s = { kind: 'exponential', baseSeconds: 0, factor: 2, maxSeconds: 3600 } as const
    const delay = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'retry-zero-base-overflow' },
      /zero-base exponential overflow produced a nonzero delay/,
      async () => {
        const value = retryDelaySeconds(s, 1025)
        if (value !== 0) {
          throw new Error('zero-base exponential overflow produced a nonzero delay')
        }
        return value
      },
    )
    expect(delay).toBe(0)
  })
})

describe('normalizeRetryStrategy', () => {
  it('rejects a base above the durable duration bound', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'retry-normalize-base-bound' },
      /exceeds the 100-year duration bound/,
      async () =>
        normalizeRetryStrategy({
          kind: 'fixed',
          baseSeconds: MAX_DURATION_MS / 1000 + 1,
        }),
    )
  })

  it('rejects an exponential cap above the durable duration bound', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'retry-normalize-max-bound' },
      /exceeds the 100-year duration bound/,
      async () =>
        normalizeRetryStrategy({
          kind: 'exponential',
          baseSeconds: 1,
          factor: 2,
          maxSeconds: MAX_DURATION_MS / 1000 + 1,
        }),
    )
  })

  it('rejects a negative exponential factor', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'retry-normalize-factor' },
      /factor must be a finite non-negative number/,
      async () =>
        normalizeRetryStrategy({
          kind: 'exponential',
          baseSeconds: 1,
          factor: -1,
          maxSeconds: 60,
        }),
    )
  })

  it('rejects an unknown strategy kind', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'retry-normalize-kind' },
      /kind must be none, fixed, or exponential/,
      async () => normalizeRetryStrategy({ kind: 'future-policy' }),
    )
  })

  it('rebuilds exact frozen millisecond-canonical data', async () => {
    const rawStrategies = [
      [
        {
          kind: 'none' as const,
          ignored: true,
          toJSON: () => {
            throw new Error('caller toJSON escaped')
          },
        },
        '{"kind":"none"}',
      ],
      [
        {
          kind: 'fixed' as const,
          baseSeconds: 0.0005,
          ignored: true,
          toJSON: () => {
            throw new Error('caller toJSON escaped')
          },
        },
        '{"kind":"fixed","baseSeconds":0.001}',
      ],
      [
        {
          kind: 'exponential' as const,
          baseSeconds: 0.0005,
          factor: 2,
          maxSeconds: 60,
          ignored: true,
          toJSON: () => {
            throw new Error('caller toJSON escaped')
          },
        },
        '{"kind":"exponential","baseSeconds":0.001,"factor":2,"maxSeconds":60}',
      ],
    ] as const

    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'retry-normalize-rebuild' },
      /retry normalization did not rebuild exact canonical data/,
      async () => {
        for (const [raw, expectedJson] of rawStrategies) {
          const value = normalizeRetryStrategy(raw)
          if (
            Object.is(value, raw) ||
            !Object.isFrozen(value) ||
            JSON.stringify(value) !== expectedJson
          ) {
            throw new Error('retry normalization did not rebuild exact canonical data')
          }
        }
      },
    )
  })

  it('canonicalizes negative zero before serialization', async () => {
    await attributeExpectedFailure(
      { kind: 'construction', mutation: 'retry-normalize-positive-zero' },
      /retry normalization preserved negative zero/,
      async () => {
        const fixed = normalizeRetryStrategy({ kind: 'fixed', baseSeconds: -0 })
        const exponential = normalizeRetryStrategy({
          kind: 'exponential',
          baseSeconds: 1,
          factor: -0,
          maxSeconds: -0,
        })
        if (
          fixed.kind !== 'fixed' ||
          exponential.kind !== 'exponential' ||
          Object.is(fixed.baseSeconds, -0) ||
          Object.is(exponential.factor, -0) ||
          Object.is(exponential.maxSeconds, -0)
        ) {
          throw new Error('retry normalization preserved negative zero')
        }
      },
    )
  })

  it('contains hostile getters at one field-reading boundary', async () => {
    const hostileFields = [
      ['kind', {}],
      ['baseSeconds', { kind: 'fixed' }],
      ['factor', { kind: 'exponential', baseSeconds: 1, maxSeconds: 60 }],
      ['maxSeconds', { kind: 'exponential', baseSeconds: 1, factor: 2 }],
    ] as const

    for (const [field, partial] of hostileFields) {
      const escaped = new Error(`raw retry ${field} getter escaped`)
      const hostile = Object.defineProperty({ ...partial }, field, {
        get: () => {
          throw escaped
        },
      })
      await attributeReplacedFailure(
        { kind: 'behavior', mutation: 'retry-normalize-readable-fields' },
        (error) =>
          error instanceof RangeError &&
          error.message === `retry strategy ${field} is not readable`,
        (error) => error === escaped,
        async () => normalizeRetryStrategy(hostile),
      )
    }
  })

  it('is the decision API boundary for hostile strategy objects', async () => {
    const escaped = new Error('raw retry-decision kind getter escaped')
    const hostile = Object.defineProperty({}, 'kind', {
      get: () => {
        throw escaped
      },
    }) as RetryStrategy

    await attributeReplacedFailure(
      { kind: 'behavior', mutation: 'retry-decision-normalization' },
      /retry strategy kind is not readable/,
      (error) => error === escaped,
      async () => decideRetry(hostile, 1, 2),
    )
  })

  it('is the delay API boundary for hostile strategy objects', async () => {
    const escaped = new Error('raw retry-delay kind getter escaped')
    const hostile = Object.defineProperty({}, 'kind', {
      get: () => {
        throw escaped
      },
    }) as Exclude<RetryStrategy, { kind: 'none' }>

    await attributeReplacedFailure(
      { kind: 'behavior', mutation: 'retry-delay-normalization' },
      /retry strategy kind is not readable/,
      (error) => error === escaped,
      async () => retryDelaySeconds(hostile, 1),
    )
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
