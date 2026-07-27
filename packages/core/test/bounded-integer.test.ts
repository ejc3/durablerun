import { describe, expect, it } from 'vitest'
import { PERSISTED_INTEGER_BOUNDS, decodeBoundedInteger } from '../src/index.js'

describe('decodeBoundedInteger', () => {
  const bounds = { min: 0, max: 10 }

  for (const representation of ['number', 'bigint'] as const) {
    const value = (n: number): number | bigint => (representation === 'number' ? n : BigInt(n))

    it(`accepts every ${representation} boundary exactly`, () => {
      expect(decodeBoundedInteger(value(0), bounds)).toEqual({
        ok: true,
        value: 0,
        exact: 0n,
      })
      expect(decodeBoundedInteger(value(10), bounds)).toEqual({
        ok: true,
        value: 10,
        exact: 10n,
      })
    })

    it(`rejects ${representation} values immediately outside either bound`, () => {
      expect(decodeBoundedInteger(value(-1), bounds)).toMatchObject({
        ok: false,
        reason: 'out-of-range',
      })
      expect(decodeBoundedInteger(value(11), bounds)).toMatchObject({
        ok: false,
        reason: 'out-of-range',
      })
    })
  }

  for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
    it(`rejects the non-integer representation ${String(invalid)}`, () => {
      expect(decodeBoundedInteger(invalid, bounds)).toEqual({
        ok: false,
        reason: 'not-an-exact-integer',
      })
    })
  }

  it('never rounds a dialect-exact bigint through Number', () => {
    expect(decodeBoundedInteger(9_007_199_254_740_993n, bounds)).toEqual({
      ok: false,
      reason: 'out-of-range',
      exact: 9_007_199_254_740_993n,
    })
  })

  it('makes persisted field bounds nominal instead of interchangeable by value', () => {
    const claimBounds: typeof PERSISTED_INTEGER_BOUNDS.runs.claim_gen =
      PERSISTED_INTEGER_BOUNDS.runs.claim_gen
    // @ts-expect-error a task-attempt limit must never stand in for run claim generation
    const wrongField: typeof PERSISTED_INTEGER_BOUNDS.runs.claim_gen =
      PERSISTED_INTEGER_BOUNDS.tasks.max_attempts
    expect(claimBounds).not.toBe(wrongField)
  })
})
