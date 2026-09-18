import { expect, it } from 'vitest'
import { makeLibsqlFixture } from './fixture-libsql.js'

// makeLibsqlFixture resumes from a zero-delay timer, for the reason written there. The
// timer is the subject here, and the assertion is on whether it fired, not on how long
// anything took. It asks twice, because a factory that yields only on its first call
// would bring the stall back with one build still green.
it('lets a pending timer fire every time it builds a libSQL fixture', async () => {
  for (const seed of ['yields-to-timers-1', 'yields-to-timers-2']) {
    let fired = false
    setTimeout(() => {
      fired = true
    }, 0)
    const fixture = await makeLibsqlFixture(seed)
    try {
      expect(fired, seed).toBe(true)
    } finally {
      await fixture.close()
    }
  }
})
