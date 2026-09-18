import { encodeTaskOutcome } from '@durablerun/core'
import { expect, it } from 'vitest'
import { TERMINAL_BATCHES } from '../src/child-tasks.js'
import { awaitTaskOwned, claimActivated, readOne, withFixture } from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

const START_MS = 1_000_000
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Every batch that ends a task takes the event lock of its completion event, each at its
 * own site. Without it a parent reads no event, the child's batch inserts the event and
 * sees no wait row, and the parent sleeps forever. Racing the two leaves that to timing:
 * four of the five sites were seen to survive twelve races twice. A trigger that sleeps
 * after the wait row is inserted holds the await's transaction open across the whole of
 * the terminal batch, so an unlocked batch loses the wakeup every time, and a locked one
 * waits for the await to commit and wakes it.
 */
it('every terminal batch waits for an await of its completion event that has not committed', async () => {
  const observed: Record<string, unknown> = {}
  const expected: Record<string, unknown> = {}
  for (const batch of TERMINAL_BATCHES) {
    await withFixture(makePostgresFixture, `terminal-lock-${batch.label}`, async (f) => {
      await f.admin.setFakeNowEpochMs(START_MS)
      await f.raw.batch('hold-the-await-open', [
        {
          sql: `CREATE FUNCTION hold_the_await_open() RETURNS trigger LANGUAGE plpgsql AS '
                  BEGIN
                    PERFORM pg_sleep(0.4);
                    RETURN NEW;
                  END'`,
          args: [],
        },
        {
          sql: `CREATE TRIGGER hold_the_await_open AFTER INSERT ON waits
                FOR EACH ROW EXECUTE FUNCTION hold_the_await_open()`,
          args: [],
        },
      ])
      await f.store.spawn('q', 'parent', '{}')
      // A lease that outlives the clock move a sweep needs.
      const parent = await claimActivated(f.store, 'q', 'w-parent', 3600)
      const ready = await batch.prepare(f, 'q')
      if (ready.advanceMs > 0) await f.admin.setFakeNowEpochMs(START_MS + ready.advanceMs)
      const awaiting = awaitTaskOwned(f.store, 'q', parent, 's', ready.childTaskId, null)
      await pause(100)
      await ready.end(f.store)
      const awaited = await awaiting
      const run = await readOne(f.raw, 'SELECT state, event_payload FROM runs WHERE run_id = ?', [
        parent.runId,
      ])
      observed[batch.label] = { awaited, parent: run }
      expected[batch.label] = {
        awaited: { emitted: false },
        parent: { state: 'pending', event_payload: encodeTaskOutcome(ready.outcome) },
      }
    })
  }
  expect(observed, 'mutation-verdict:behavior:terminal-batch-takes-the-event-lock').toEqual(
    expected,
  )
}, 120_000)
