import { expect, it } from 'vitest'
import { claimActivated, readOne } from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

/**
 * Every batch that ends a task takes the event lock of its completion event, and so
 * does every emit and every await. A lock that is a row is a row for every task that
 * ever ends, which nothing deletes, so a completion event is locked without one. A
 * caller's event keeps the row that every build locks, one for each event name.
 */
it("leaves a lock row for a caller's event, and none for a task that ends", async () => {
  const f = await makePostgresFixture('postgres-event-lock')
  try {
    await f.admin.setFakeNowEpochMs(1_000_000)
    for (const end of ['complete', 'fail', 'cancel'] as const) {
      const spawned = await f.store.spawn('q', end, '{}')
      const run = await claimActivated(f.store, 'q', `w-${end}`)
      if (end === 'complete') await f.store.complete('q', run.runId, run.claimToken, '{}')
      else if (end === 'fail') await f.store.fail('q', run.runId, run.claimToken, '{}', null)
      else await f.store.cancelTask('q', spawned.taskId)
    }
    await f.store.emitEvent('q', 'user-event', '{}')
    const locks = await readOne(f.raw, 'SELECT COUNT(*) AS n FROM event_locks', [])
    const events = await readOne(f.raw, 'SELECT COUNT(*) AS n FROM events', [])
    expect({ lockRows: Number(locks?.n), events: Number(events?.n) }).toEqual({
      lockRows: 1,
      events: 4,
    })
  } finally {
    await f.close()
  }
})
