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
