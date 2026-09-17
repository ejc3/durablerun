import { expect, it } from 'vitest'
import { makeLibsqlFixture } from './fixture-libsql.js'

// The libSQL client runs every statement as a blocking native call and resolves with
// microtasks only, so nothing in a libSQL test lets the event loop reach its timers
// phase, and vitest does not reach it between two such tests. A run of them is one
// stretch in which the worker cannot answer vitest, which fails the run after 60 seconds
// with every test passing. The fixture factory is the one place every conformance test
// and every fuzz walk passes through, so it is where the loop is let turn.
//
// The timer is the subject here, and the assertion is on whether it fired, not on how
// long anything took.
it('lets a pending timer fire while it builds a libSQL fixture', async () => {
  let fired = false
  setTimeout(() => {
    fired = true
  }, 0)
  const fixture = await makeLibsqlFixture('yields-to-timers')
  try {
    expect(fired).toBe(true)
  } finally {
    await fixture.close()
  }
})
