import {
  LeaseLostError,
  PermanentStoreError,
  STORE_FAILURE_TYPES,
  type StoreFailureKind,
  StoreUnavailableError,
} from '@durablerun/core'
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

  it('books every kind of store failure core names: an outage, a refused credential and a permanent answer fail a contest, and a schema error is a refusal under its name', async () => {
    // A kind core adds has no entry here, which fails the typecheck until one is written.
    const booked: Record<StoreFailureKind, string> = {
      unavailable: 'outage',
      'access-refused': 'outage',
      permanent: 'outage',
      'schema-mismatch': 'refused',
      'schema-not-initialized': 'refused',
    }
    const observed: Record<string, string> = {}
    for (const kind of Object.keys(booked) as StoreFailureKind[]) {
      const Failure = STORE_FAILURE_TYPES[kind]
      observed[kind] = (await settle(Promise.reject(new Failure(kind)))).kind
    }
    expect(
      observed,
      'mutation-verdict:behavior:contest-books-a-refused-credential-as-an-outage',
    ).toEqual(booked)
  })
})
