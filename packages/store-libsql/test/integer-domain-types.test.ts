import {
  DERIVED_INTEGER_BOUNDS,
  PERSISTED_INTEGER_BOUNDS,
  type PersistedCounterFieldRecord,
  persistedRowInteger,
  requireDerivedInteger,
} from '@durablerun/core'
import { expect, it } from 'vitest'
import {
  storedIncrementableClaimGeneration,
  storedIncrementableInteger,
  storedIntegerWithin,
  storedPositiveClaimGeneration,
} from '../src/fragments.js'

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
    // @ts-expect-error persisted descriptor endpoints cannot be replaced by spreading — mutation-verdict:construction:stored-within-rejects-spread-descriptor
    storedIntegerWithin(widenedAttemptBounds, 'r')
    // @ts-expect-error incrementable descriptors also require canonical endpoints — mutation-verdict:construction:stored-incrementable-rejects-spread-descriptor
    storedIncrementableInteger(widenedAttemptBounds, 'r')
    // @ts-expect-error persisted row decoding requires canonical endpoints — mutation-verdict:construction:persisted-row-rejects-spread-descriptor
    persistedRowInteger('claim', { attempt: 0 }, widenedAttemptBounds)

    const widenedDurationBounds = {
      ...DERIVED_INTEGER_BOUNDS.duration_ms,
      max: Number.MAX_SAFE_INTEGER,
    }
    // @ts-expect-error derived decoding requires canonical endpoints — mutation-verdict:construction:derived-row-rejects-spread-descriptor
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

it('requires every keyed persisted-counter descriptor at construction', () => {
  const compileOnly = (): void => {
    const withoutTaskAttempts = {} as Omit<PersistedCounterFieldRecord, 'task-attempts'>
    // @ts-expect-error task attempts must remain enrolled — mutation-verdict:construction:persisted-counter-field-task-attempts
    const taskAttempts: PersistedCounterFieldRecord = withoutTaskAttempts

    const withoutTaskMaxAttempts = {} as Omit<PersistedCounterFieldRecord, 'task-max-attempts'>
    // @ts-expect-error task max attempts must remain enrolled — mutation-verdict:construction:persisted-counter-field-task-max-attempts
    const taskMaxAttempts: PersistedCounterFieldRecord = withoutTaskMaxAttempts

    const withoutTaskInfraRetries = {} as Omit<PersistedCounterFieldRecord, 'task-infra-retries'>
    // @ts-expect-error task infra retries must remain enrolled — mutation-verdict:construction:persisted-counter-field-task-infra-retries
    const taskInfraRetries: PersistedCounterFieldRecord = withoutTaskInfraRetries

    const withoutRunAttempt = {} as Omit<PersistedCounterFieldRecord, 'run-attempt'>
    // @ts-expect-error run attempt must remain enrolled — mutation-verdict:construction:persisted-counter-field-run-attempt
    const runAttempt: PersistedCounterFieldRecord = withoutRunAttempt

    const withoutRunClaimGen = {} as Omit<PersistedCounterFieldRecord, 'run-claim-gen'>
    // @ts-expect-error run claim generation must remain enrolled — mutation-verdict:construction:persisted-counter-field-run-claim-gen
    const runClaimGen: PersistedCounterFieldRecord = withoutRunClaimGen

    const withoutRunActivatedGen = {} as Omit<PersistedCounterFieldRecord, 'run-activated-gen'>
    // @ts-expect-error run activation generation must remain enrolled — mutation-verdict:construction:persisted-counter-field-run-activated-gen
    const runActivatedGen: PersistedCounterFieldRecord = withoutRunActivatedGen

    const withoutRunRelaunchCount = {} as Omit<PersistedCounterFieldRecord, 'run-relaunch-count'>
    // @ts-expect-error run relaunch count must remain enrolled — mutation-verdict:construction:persisted-counter-field-run-relaunch-count
    const runRelaunchCount: PersistedCounterFieldRecord = withoutRunRelaunchCount

    const withoutCheckpointOwnerAttempt = {} as Omit<
      PersistedCounterFieldRecord,
      'checkpoint-owner-attempt'
    >
    // @ts-expect-error checkpoint owner attempt must remain enrolled — mutation-verdict:construction:persisted-counter-field-checkpoint-owner-attempt
    const checkpointOwnerAttempt: PersistedCounterFieldRecord = withoutCheckpointOwnerAttempt

    void [
      taskAttempts,
      taskMaxAttempts,
      taskInfraRetries,
      runAttempt,
      runClaimGen,
      runActivatedGen,
      runRelaunchCount,
      checkpointOwnerAttempt,
    ]
  }
  expect(compileOnly).toBeTypeOf('function')
})
