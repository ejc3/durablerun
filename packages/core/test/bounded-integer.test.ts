import { describe, expect, it } from 'vitest'
import {
  DERIVED_INTEGER_BOUNDS,
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  MAX_RUN_ORDINAL,
  PERSISTED_INTEGER_BOUNDS,
  PERSISTED_TEMPORAL_FIELDS,
  decodeBoundedInteger,
  requireDerivedInteger,
  requireRunOrdinal,
} from '../src/index.js'

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

  it('pins the complete nominal persisted-temporal inventory', () => {
    expect(
      {
        length: PERSISTED_TEMPORAL_FIELDS.length,
        inventoryFrozen: Object.isFrozen(PERSISTED_TEMPORAL_FIELDS),
        uniqueIds: new Set(PERSISTED_TEMPORAL_FIELDS.map((field) => field.id)).size,
        uniqueLocations: new Set(
          PERSISTED_TEMPORAL_FIELDS.map((field) => `${field.table}.${field.column}`),
        ).size,
        fields: PERSISTED_TEMPORAL_FIELDS.map((field) => ({
          frozen: Object.isFrozen(field),
          idMatchesBounds: field.id === field.bounds.field,
          boundsMatchLocation: field.bounds.field === `${field.table}.${field.column}`,
          minMatchesKind: field.bounds.min === (field.kind === 'duration-ms' ? 1 : 0),
          maxMatchesKind:
            field.bounds.max === (field.kind === 'duration-ms' ? MAX_DURATION_MS : MAX_EPOCH_MS),
        })),
        nullable: PERSISTED_TEMPORAL_FIELDS.filter((field) => field.nullable).length,
        nonnullable: PERSISTED_TEMPORAL_FIELDS.filter((field) => !field.nullable).length,
      },
      'mutation-verdict:construction:temporal-field-id-is-bounds-field',
    ).toEqual({
      length: 23,
      inventoryFrozen: true,
      uniqueIds: 23,
      uniqueLocations: 23,
      fields: Array.from({ length: 23 }, () => ({
        frozen: true,
        idMatchesBounds: true,
        boundsMatchLocation: true,
        minMatchesKind: true,
        maxMatchesKind: true,
      })),
      nullable: 16,
      nonnullable: 7,
    })
  })

  it('keeps persisted descriptors out of the derived-result decoder', () => {
    expect(requireDerivedInteger('remaining', 0, DERIVED_INTEGER_BOUNDS.duration_ms)).toBe(0)
    const compileOnly = (): void => {
      // @ts-expect-error persisted fields must use their field-specific decoder
      requireDerivedInteger('attempt', 1, PERSISTED_INTEGER_BOUNDS.runs.attempt)
    }
    expect(compileOnly).toBeTypeOf('function')
  })

  it('validates the numeric run-ordinal interval through one fixed domain', () => {
    expect(
      {
        declaredMaximum: MAX_RUN_ORDINAL,
        persistedMaximum: PERSISTED_INTEGER_BOUNDS.runs.attempt.max,
        acceptedMaximum: requireRunOrdinal('attempt', PERSISTED_INTEGER_BOUNDS.runs.attempt.max),
      },
      'mutation-verdict:behavior:sweep-accepts-max-ordinal-at-infra-cap',
    ).toEqual({
      declaredMaximum: MAX_RUN_ORDINAL,
      persistedMaximum: MAX_RUN_ORDINAL,
      acceptedMaximum: MAX_RUN_ORDINAL,
    })
    expect(requireRunOrdinal('attempt', 1)).toBe(1)
    expect(requireRunOrdinal('attempt', MAX_RUN_ORDINAL)).toBe(MAX_RUN_ORDINAL)
    // Non-number client inputs are owned end-to-end by the sole production
    // consumer so primitive and port assertions cannot both kill one mutant.
    for (const invalid of [0, 1.5, MAX_RUN_ORDINAL + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => requireRunOrdinal('attempt', invalid)).toThrow(/runs\.attempt/)
    }
  })
})
