import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION } from '../src/index.js'
import { openTestDb, testIdSource } from '../src/testing.js'

describe('the routine test id source', () => {
  const observeTokenProposals = (namespace: string, proposedSerials: readonly number[]) => {
    const remaining = [...proposedSerials]
    const ids = testIdSource(namespace, {
      nextTokenSerial: () => {
        const proposed = remaining.shift()
        if (proposed === undefined) throw new Error('missing proposed token serial')
        return proposed
      },
    })
    const capture = (): string => {
      try {
        return ids.token()
      } catch (error) {
        return String(error)
      }
    }
    return { first: capture(), attempt: capture(), retry: capture() }
  }

  it('keeps ids ordered and tokens unique when calls are interleaved', () => {
    const ids = testIdSource('fixture')
    expect([ids.token(), ids.uuidv7(), ids.uuidv7(), ids.token()]).toEqual([
      'fixture-token-000001',
      'fixture-id-000001',
      'fixture-id-000002',
      'fixture-token-000002',
    ])
  })

  it('rejects a duplicate proposed token serial before exposing it', () => {
    expect(
      observeTokenProposals('guard', [1, 1, 2]),
      'mutation-verdict:behavior:test-token-source-monotonic',
    ).toEqual({
      first: 'guard-token-000001',
      attempt: 'RangeError: test token serial must strictly increase: proposed 1 after 1',
      retry: 'guard-token-000002',
    })
  })

  it('requires every proposed token serial to be a safe integer', () => {
    const observations = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53].map(
      (invalid, index) => ({
        invalid: String(invalid),
        ...observeTokenProposals(`domain-${index}`, [1, invalid, 2]),
      }),
    )

    expect(observations, 'mutation-verdict:behavior:test-token-source-valid-serial').toEqual([
      {
        invalid: 'NaN',
        first: 'domain-0-token-000001',
        attempt: 'RangeError: test token serial must be a safe integer: NaN',
        retry: 'domain-0-token-000002',
      },
      {
        invalid: 'Infinity',
        first: 'domain-1-token-000001',
        attempt: 'RangeError: test token serial must be a safe integer: Infinity',
        retry: 'domain-1-token-000002',
      },
      {
        invalid: '1.5',
        first: 'domain-2-token-000001',
        attempt: 'RangeError: test token serial must be a safe integer: 1.5',
        retry: 'domain-2-token-000002',
      },
      {
        invalid: '9007199254740992',
        first: 'domain-3-token-000001',
        attempt: 'RangeError: test token serial must be a safe integer: 9007199254740992',
        retry: 'domain-3-token-000002',
      },
    ])
  })

  it('reserves the fence separator for the compiled stamp', () => {
    expect(() => testIdSource('fixture:claim')).toThrow('only letters, digits')
  })

  it('returns one monotone source with each database', async () => {
    const f = await openTestDb({ idNamespace: 'database' })
    expect([f.ids.token(), f.ids.token()]).toEqual([
      'database-token-000001',
      'database-token-000002',
    ])
    f.close()
  })
})

describe('openTestDb', () => {
  it('opens the database a url names instead of a private in-memory one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-testdb-'))
    const url = `file:${join(dir, 'test.db')}`
    const first = await openTestDb({ url })
    first.close()
    const second = await openTestDb({ url, migrate: false })
    try {
      expect(
        await second.admin.schemaVersion(),
        'the second open sees the first one migrated',
      ).toBe(CURRENT_SCHEMA_VERSION)
    } finally {
      second.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
