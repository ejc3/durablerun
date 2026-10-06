import { describe, expect, it } from 'vitest'
import { SOAK_LAST_HOUR, SOAK_TIMEOUT_MS, soakControl } from '../src/retention-soak.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

// A week of the retention soak is thousands of batches inside one fixture. On libSQL none
// of them gives the event loop a turn: measured before the week asked for one, a week ran
// for 8 to 13 seconds and a pending timer fired once in it, when its fixture was built. A
// test worker whose loop does not turn for a minute fails its run with every test passing
// (fixture-libsql.ts says how), and a week on a loaded machine is not far from a minute. So
// the week asks its fixture for a turn at each simulated day, and the timer is the subject
// here: armed to fire again and again, it fires at least once in each of the days the
// passes run for.
//
// The case runs on every selected dialect, and it can fail on libSQL alone. A batch of
// PostgreSQL or MySQL crosses a socket, so the loop turns at every one of them and the
// timer fires thousands of times with the fixture's turn or without it.
for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
  describe(`a week's turns of the event loop [${dialect}]`, () => {
    it(
      'lets a pending timer fire in each of its simulated days',
      async () => {
        let turns = 0
        const timer = setInterval(() => {
          turns += 1
        }, 0)
        try {
          await soakControl(makeFixture)
        } finally {
          clearInterval(timer)
        }
        expect(turns).toBeGreaterThanOrEqual(SOAK_LAST_HOUR / 24)
      },
      SOAK_TIMEOUT_MS,
    )
  })
}
