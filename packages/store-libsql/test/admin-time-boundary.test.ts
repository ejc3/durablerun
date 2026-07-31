import { MAX_EPOCH_MS } from '@durablerun/core'
import { attributeExpectedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlExecutor, LibsqlStoreAdmin } from '../src/index.js'

let db: LibsqlExecutor
let admin: LibsqlStoreAdmin

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  admin = new LibsqlStoreAdmin(db)
  await admin.migrate()
  await admin.setFakeNowEpochMs(1_000_000)
})

afterEach(() => {
  db.close()
})

describe('fake engine-time boundary', () => {
  const invalidEpochs: ReadonlyArray<readonly [string, unknown]> = [
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['past the epoch ceiling', MAX_EPOCH_MS + 1],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['non-number', '1000001'],
  ]

  it.each(invalidEpochs)('rejects a %s fake clock without changing time', async (_name, value) => {
    // MUTATION-RED: removing the admin epoch validator admits this value.
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'admin-fake-now-invalid' },
      (error) => error instanceof RangeError,
      () => admin.setFakeNowEpochMs(value as Parameters<typeof admin.setFakeNowEpochMs>[0]),
    )
    expect(await admin.nowEpochMs()).toBe(1_000_000)
  })

  it('accepts both exact epoch endpoints', async () => {
    // MUTATION-CONTROL: the fake-clock validator includes both legal endpoints.
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'admin-fake-now-exact-endpoints' },
      (error) =>
        error instanceof RangeError &&
        error.message === `epochMs must be an integer epoch-ms in [0, ${MAX_EPOCH_MS}], got -1`,
      () => admin.setFakeNowEpochMs(0),
    )
    expect(await admin.nowEpochMs()).toBe(0)
    await admin.setFakeNowEpochMs(MAX_EPOCH_MS)
    expect(await admin.nowEpochMs()).toBe(MAX_EPOCH_MS)
  })
})
