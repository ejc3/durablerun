import {
  DERIVED_INTEGER_BOUNDS,
  PERSISTED_INTEGER_BOUNDS,
  requireDerivedInteger,
} from '@durablerun/core'
import { expect, it } from 'vitest'
import {
  storedIncrementableClaimGeneration,
  storedIncrementableInteger,
  storedIntegerWithin,
  storedPositiveClaimGeneration,
} from '../src/fragments.js'
import { persistedRowInteger } from '../src/store.js'

it('binds a persisted SQL column to its own nominal integer domain', () => {
  expect(storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.tasks.infra_retries, 't')).toContain(
    't.infra_retries',
  )

  expect(storedIncrementableInteger(PERSISTED_INTEGER_BOUNDS.tasks.infra_retries)).toContain(
    'infra_retries',
  )

  expect(
    persistedRowInteger(
      'claim',
      { infra_retries: 0 },
      PERSISTED_INTEGER_BOUNDS.tasks.infra_retries,
    ),
  ).toBe(0)

  const unionBounds = PERSISTED_INTEGER_BOUNDS.tasks.attempts as
    | typeof PERSISTED_INTEGER_BOUNDS.tasks.attempts
    | typeof PERSISTED_INTEGER_BOUNDS.tasks.infra_retries

  // A union is safe now: whichever descriptor arrives owns both the field and
  // its interval, so no independently selected source can disagree with it.
  expect(storedIntegerWithin(unionBounds, 't')).toContain(`t.${unionBounds.field.split('.')[1]}`)
  expect(storedIncrementableInteger(unionBounds, 't')).toContain(
    `t.${unionBounds.field.split('.')[1]}`,
  )
  expect(persistedRowInteger('claim', { attempts: 0, infra_retries: 0 }, unionBounds)).toBe(0)

  expect(storedPositiveClaimGeneration('r')).toContain('r.claim_gen')
  expect(storedIncrementableClaimGeneration('r')).toContain('r.claim_gen')

  const compileOnly = (): void => {
    const widenedAttemptBounds = {
      ...PERSISTED_INTEGER_BOUNDS.runs.attempt,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }
    void 'mutation-verdict:construction:stored-within-rejects-spread-descriptor'
    // @ts-expect-error persisted descriptor endpoints cannot be replaced by spreading
    storedIntegerWithin(widenedAttemptBounds, 'r')
    void 'mutation-verdict:construction:stored-incrementable-rejects-spread-descriptor'
    // @ts-expect-error incrementable descriptors also require canonical endpoints
    storedIncrementableInteger(widenedAttemptBounds, 'r')
    void 'mutation-verdict:construction:persisted-row-rejects-spread-descriptor'
    // @ts-expect-error persisted row decoding requires the canonical descriptor endpoints
    persistedRowInteger('claim', { attempt: 0 }, widenedAttemptBounds)

    const widenedDurationBounds = {
      ...DERIVED_INTEGER_BOUNDS.duration_ms,
      max: Number.MAX_SAFE_INTEGER,
    }
    void 'mutation-verdict:construction:derived-row-rejects-spread-descriptor'
    // @ts-expect-error derived decoding requires the canonical descriptor endpoints
    requireDerivedInteger('remaining', Number.MAX_SAFE_INTEGER, widenedDurationBounds)

    // @ts-expect-error the independent column/bounds API no longer exists
    storedIntegerWithin('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.attempts)
    // @ts-expect-error the independent column/bounds API no longer exists
    storedIncrementableInteger('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.attempts)
    // @ts-expect-error the independent value/bounds API no longer exists
    persistedRowInteger('claim.infra_retries', 0, PERSISTED_INTEGER_BOUNDS.tasks.attempts)

    // @ts-expect-error claim generation must use its fixed positive/incrementable helpers
    storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.runs.claim_gen, 'r')
    // @ts-expect-error claim generation must use its fixed positive/incrementable helpers
    storedIncrementableInteger(PERSISTED_INTEGER_BOUNDS.runs.claim_gen, 'r')

    // @ts-expect-error derived results are not persisted SQL fields
    storedIntegerWithin(DERIVED_INTEGER_BOUNDS.duration_ms, 'r')
    // @ts-expect-error derived results are not persisted SQL fields
    storedIncrementableInteger(DERIVED_INTEGER_BOUNDS.duration_ms, 'r')
    // @ts-expect-error derived results cannot be decoded as persisted row fields
    persistedRowInteger('derived', { duration_ms: 0 }, DERIVED_INTEGER_BOUNDS.duration_ms)
  }
  expect(compileOnly).toBeTypeOf('function')
})
