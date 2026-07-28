import { PERSISTED_INTEGER_BOUNDS } from '@durablerun/core'
import { expect, it } from 'vitest'
import { storedIntegerWithin } from '../src/fragments.js'

it('binds a persisted SQL column to its own nominal integer domain', () => {
  expect(
    storedIntegerWithin('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.infra_retries),
  ).toContain('t.infra_retries')

  // @ts-expect-error attempts bounds must never validate infra_retries
  storedIntegerWithin('t.infra_retries', PERSISTED_INTEGER_BOUNDS.tasks.attempts)
})
