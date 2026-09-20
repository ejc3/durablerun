import { describe, expect, it } from 'vitest'
import {
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  firstNamePast,
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
