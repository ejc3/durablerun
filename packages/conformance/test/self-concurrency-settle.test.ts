import { LeaseLostError, PermanentStoreError, StoreUnavailableError } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { settle } from '../src/self-concurrency.js'

describe('how a contest of the self-concurrency surface books what a copy threw', () => {
  it('keeps a permanent store error with the outages, which fail a contest in either order', async () => {
    // A refusal is compared between the two orders, so a call that breaks a constraint in
    // both would pass as a refusal. An outage fails the contest wherever it appears.
    const booked = async (thrown: Error) => {
      const { kind } = await settle(Promise.reject(thrown))
      return kind
    }
    expect(
      {
        permanent: await booked(new PermanentStoreError('batch(spawn) failed permanently')),
        outage: await booked(new StoreUnavailableError('batch(spawn) failed')),
        lostLease: await settle(Promise.reject(new LeaseLostError('complete run-1'))),
        answer: await settle(Promise.resolve(null)),
      },
      'mutation-verdict:behavior:contest-books-a-permanent-store-error-as-an-outage',
    ).toEqual({
      permanent: 'outage',
      outage: 'outage',
      lostLease: { kind: 'refused', name: 'LeaseLostError' },
      answer: { kind: 'answered', value: null },
    })
  })
})
