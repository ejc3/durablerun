import { describe, expect, it } from 'vitest'
import {
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  decodeRollbackTry,
  firstNamePast,
  nextRollbackTry,
  requireFailedRollback,
  rollbackTriesName,
} from '../src/index.js'

describe('the names under a reserved saga prefix, as a range of names compared by bytes', () => {
  it('ends before the prefix with a semicolon where its colon was', () => {
    expect(
      ([SAGA_STARTED_PREFIX, SAGA_ROLLBACK_PREFIX, SAGA_TRIES_PREFIX] as const).map(firstNamePast),
    ).toEqual(['$started;', '$rollback;', '$rollback-tries;'])
  })

  it('holds every name under the prefix, and no name beside it', () => {
    const bytes = (name: string) => Buffer.from(name, 'utf8')
    const held = (name: string) =>
      Buffer.compare(bytes(name), bytes(SAGA_STARTED_PREFIX)) >= 0 &&
      Buffer.compare(bytes(name), bytes(firstNamePast(SAGA_STARTED_PREFIX))) < 0
    const under = [
      '$started:',
      '$started:a',
      '$started:\u0000',
      '$started:\u{10FFFF}',
      '$started:~ ',
    ]
    const beside = ['$started', '$started9', '$started;', '$STARTED:a', '$rollback:a', 'started:a']
    expect({ under: under.filter(held), beside: beside.filter(held) }).toEqual({
      under,
      beside: [],
    })
  })

  it('refuses a prefix that does not end in a colon', () => {
    // The type refuses these where a call is compiled, and the check where it is not.
    expect(
      ['$started', ''].map((prefix) => {
        try {
          return firstNamePast(prefix as `${string}:`)
        } catch (error) {
          return error instanceof RangeError ? 'RangeError' : String(error)
        }
      }),
      'mutation-verdict:behavior:saga-first-name-past-needs-a-colon',
    ).toEqual(['RangeError', 'RangeError'])
  })
})

describe("a rollback's attempt record, as the store names it and counts it", () => {
  const failed = { stepKey: 'charge#2', errorJson: '{"name":"Boom"}' }

  it('is stored under the reserved prefix and the step, one attempt past the last one stored', () => {
    const stored = (tries: number) => JSON.stringify({ tries, errorJson: '{"name":"Earlier"}' })
    // A record that cannot be read counts as none: the SDK halts the saga on one, and the
    // halt's record is written over it.
    const unreadable = [
      'not json',
      'null',
      '{"tries":0,"errorJson":"{}"}',
      '{"tries":"2","errorJson":"{}"}',
    ]
    expect({
      name: rollbackTriesName('a'),
      none: nextRollbackTry(failed, null),
      fifth: nextRollbackTry(failed, stored(5)),
      unreadable: unreadable.map(
        (state) => decodeRollbackTry(nextRollbackTry(failed, state).stateJson)?.tries,
      ),
    }).toEqual({
      name: '$rollback-tries:a',
      none: {
        key: '$rollback-tries:charge#2',
        stateJson: '{"tries":1,"errorJson":"{\\"name\\":\\"Boom\\"}"}',
      },
      fifth: {
        key: '$rollback-tries:charge#2',
        stateJson: '{"tries":6,"errorJson":"{\\"name\\":\\"Boom\\"}"}',
      },
      unreadable: [1, 1, 1, 1],
    })
  })

  it('takes the step and the failure, each read once, and refuses anything else by saying what the port takes', () => {
    const answer = (value: unknown) => {
      try {
        return requireFailedRollback(value)
      } catch (error) {
        return error instanceof TypeError && error.message.includes('{ stepKey, errorJson }')
          ? 'refused, naming the shape'
          : String(error)
      }
    }
    let reads = 0
    const counting = {
      get stepKey() {
        reads++
        return 'a'
      },
      errorJson: '{}',
    }
    const taken = answer(counting)
    // The verdict of the mutation that stops this reader refusing a shape. Through a store
    // the port's one check answers such a call first, so only a direct call can see it.
    const marker = 'mutation-verdict:behavior:saga-failed-rollback-shape-is-checked'
    expect(
      {
        taken,
        reads,
        // A count a caller adds is not read: the answer holds the two fields and nothing else.
        withACount: answer({ stepKey: 'a', errorJson: '{}', tries: 7 }),
        refused: [
          { key: '$rollback-tries:a', stateJson: '{"tries":1,"errorJson":"{}"}' },
          { stepKey: 'a' },
          { stepKey: 1, errorJson: '{}' },
          null,
          undefined,
          'a',
        ].map(answer),
      },
      marker,
    ).toEqual({
      taken: { stepKey: 'a', errorJson: '{}' },
      reads: 1,
      withACount: { stepKey: 'a', errorJson: '{}' },
      refused: Array.from({ length: 6 }, () => 'refused, naming the shape'),
    })
  })

  it('holds the step to the room the record name leaves, and names the step it was passed', () => {
    // `$rollback-tries:` is 16 characters, so a step of 239 fits the 255 a name holds.
    const answer = (stepKey: string) => {
      try {
        requireFailedRollback({ stepKey, errorJson: '{}' })
        return 'fits'
      } catch (error) {
        const refusal = error as Error
        return `${refusal.constructor.name}, naming the step: ${refusal.message.includes('rollback.stepKey')}`
      }
    }
    expect([
      answer('k'.repeat(239)),
      answer('k'.repeat(240)),
      answer(`${'k'.repeat(239)} `),
    ]).toEqual([
      'fits',
      'InvalidDurableStringError, naming the step: true',
      'InvalidDurableStringError, naming the step: true',
    ])
  })

  it('holds the count at the largest safe integer, and never reads its own record as none', () => {
    // Only a record an older build wrote can sit at the bound: that build's store wrote the
    // count it was handed. One past the bound is no safe integer, and the decoder reads a
    // record that holds one as no record, so the attempt after it would be stored as the
    // first and every spent attempt would come back. The count stays at the bound, which
    // still says the budget is spent, and the failure is recorded all the same.
    const largest = Number.MAX_SAFE_INTEGER
    const stored = (tries: number) => JSON.stringify({ tries, errorJson: '{"name":"Earlier"}' })
    const recordOf = (write: { stateJson: string }) => decodeRollbackTry(write.stateJson)
    const belowTheBound = nextRollbackTry(failed, stored(largest - 1))
    const atTheBound = nextRollbackTry(failed, stored(largest))
    const afterIt = nextRollbackTry(failed, atTheBound.stateJson)
    expect(
      {
        belowTheBound: recordOf(belowTheBound),
        atTheBound: recordOf(atTheBound),
        afterIt: recordOf(afterIt),
      },
      'mutation-verdict:behavior:saga-store-count-saturates',
    ).toEqual({
      belowTheBound: { tries: largest, errorJson: failed.errorJson },
      atTheBound: { tries: largest, errorJson: failed.errorJson },
      afterIt: { tries: largest, errorJson: failed.errorJson },
    })
  })
})
