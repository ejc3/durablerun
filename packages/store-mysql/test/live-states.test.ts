import { LIVE_STATES } from '@durablerun/core'
import { expect, it } from 'vitest'
import { LIVE } from '../src/fragments.js'

/**
 * The cancel compare-and-set checks the live state with core's list, as nodes, and the
 * follow-ons of the same batch read this store's text list. This holds the two lists to
 * the same states.
 */
it("the text list of live states is core's list", () => {
  expect(LIVE).toBe(`(${LIVE_STATES.map((state) => `'${state}'`).join(',')})`)
})
