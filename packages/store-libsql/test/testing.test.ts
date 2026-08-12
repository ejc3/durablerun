import { describe, expect, it } from 'vitest'
import { openTestDb, testIdSource } from '../src/testing.js'

describe('the routine test id source', () => {
  it('keeps ids ordered and tokens unique when calls are interleaved', () => {
    const ids = testIdSource('fixture')
    expect(
      [ids.token(), ids.uuidv7(), ids.uuidv7(), ids.token()],
      'mutation-verdict:behavior:test-token-source-monotonic',
    ).toEqual([
      'fixture-token-000001',
      'fixture-id-000001',
      'fixture-id-000002',
      'fixture-token-000002',
    ])
  })

  it('rejects a duplicate proposed token serial before exposing it', () => {
    const testIdSourceWithSerialProposal = testIdSource as (
      namespace: string,
      options: { nextTokenSerial(previous: number): number },
    ) => ReturnType<typeof testIdSource>
    const ids = testIdSourceWithSerialProposal('guard', {
      nextTokenSerial: () => 1,
    })

    ids.token()
    expect(() => ids.token(), 'regression:test-token-source-monotonic-guard').toThrow(
      /token serial must strictly increase/,
    )
  })

  it('requires every proposed token serial to be a safe integer', () => {
    const testIdSourceWithSerialProposal = testIdSource as (
      namespace: string,
      options: { nextTokenSerial(previous: number): number },
    ) => ReturnType<typeof testIdSource>
    const observations = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53].map(
      (invalid, index) => {
        const proposals = [1, invalid, 2]
        const ids = testIdSourceWithSerialProposal(`domain-${index}`, {
          nextTokenSerial: () => proposals.shift() ?? 2,
        })
        const first = ids.token()
        let attempt: unknown
        try {
          attempt = ids.token()
        } catch (error) {
          attempt = String(error)
        }
        return { invalid: String(invalid), first, attempt, retry: ids.token() }
      },
    )

    expect(observations, 'regression:test-token-source-valid-serial').toEqual([
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
        attempt:
          'RangeError: test token serial must be a safe integer: 9007199254740992',
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
