import { PERSISTED_INTEGER_BOUNDS } from '@durablerun/core'
import { expect, it } from 'vitest'
import { storedIncrementableInteger, storedIntegerWithin } from '../src/fragments.js'
import { persistedRowInteger } from '../src/store.js'

it('binds a persisted SQL column to its own nominal integer domain', () => {
  expect(
    storedIntegerWithin('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.infra_retries),
  ).toContain('t.infra_retries')

  // @ts-expect-error attempts bounds must never validate infra_retries
  storedIntegerWithin('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.attempts)

  expect(
    storedIncrementableInteger('infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.infra_retries),
  ).toContain('infra_retries')

  // @ts-expect-error attempts bounds must never validate infra_retries
  storedIncrementableInteger('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.attempts)

  expect(
    persistedRowInteger('claim.infra_retries', 0, PERSISTED_INTEGER_BOUNDS.tasks.infra_retries),
  ).toBe(0)

  // @ts-expect-error attempts bounds must never decode infra_retries
  persistedRowInteger('claim.infra_retries', 0, PERSISTED_INTEGER_BOUNDS.tasks.attempts)

  const unionBounds = PERSISTED_INTEGER_BOUNDS.tasks.attempts as
    | typeof PERSISTED_INTEGER_BOUNDS.tasks.attempts
    | typeof PERSISTED_INTEGER_BOUNDS.tasks.infra_retries

  // @ts-expect-error a union must not restore the independently selected column/bounds API
  storedIntegerWithin('t.infra_retries', unionBounds)

  // @ts-expect-error a union must not restore the independently selected column/bounds API
  storedIncrementableInteger('t.infra_retries', unionBounds)

  // @ts-expect-error a union must not restore the independently selected column/bounds API
  persistedRowInteger('claim.infra_retries', 0, unionBounds)
})
