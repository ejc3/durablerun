import { describe, expect, it } from 'vitest'
import { Rng, seededIdSource } from '../src/index.js'

describe('seeded IdSource stream independence', () => {
  it('keeps the UUID sequence stable when token calls are interleaved', () => {
    const uninterrupted = seededIdSource(new Rng('independent-streams'))
    const interleaved = seededIdSource(new Rng('independent-streams'))

    const expected = [uninterrupted.uuidv7(), uninterrupted.uuidv7(), uninterrupted.uuidv7()]
    const actual = [interleaved.uuidv7()]
    interleaved.token()
    actual.push(interleaved.uuidv7())
    interleaved.token()
    interleaved.token()
    actual.push(interleaved.uuidv7())

    expect(actual).toEqual(expected)
  })
})
