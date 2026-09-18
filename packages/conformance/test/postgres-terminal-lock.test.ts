import { encodeTaskOutcome, taskDoneEventName } from '@durablerun/core'
import { expect, it } from 'vitest'
import { TERMINAL_BATCHES } from '../src/child-tasks.js'
import {
  awaitOwned,
  awaitTaskOwned,
  claimActivated,
  readOne,
  withFixture,
} from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

const START_MS = 1_000_000
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A trigger that sleeps after a wait row is inserted, so the await that wrote it stays open. */
const HOLD_THE_AWAIT_OPEN = [
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
]

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
      await f.raw.batch('hold-the-await-open', HOLD_THE_AWAIT_OPEN)
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

/**
 * The await that records the outcome of a child an older build ended writes the event
 * itself, so it takes the same lock. Without it a second such await reads no event while
 * the first has not committed, inserts the same row, and is refused by the table's key
 * when the first commits. A trigger that sleeps after the event row is inserted holds the
 * first open across the whole of the second. With the lock the second waits, and then
 * finds the event the first recorded.
 */
it('an await that records an outcome waits for another that has not committed', async () => {
  await withFixture(makePostgresFixture, 'recording-await-lock', async (f) => {
    await f.admin.setFakeNowEpochMs(START_MS)
    const child = await f.store.spawn('q', 'child', '{}', { maxAttempts: 1 })
    const childRun = await claimActivated(f.store, 'q', 'w-child')
    await f.store.complete('q', childRun.runId, childRun.claimToken, '{"old":1}')
    await f.raw.batch('an-older-build-wrote-no-event', [
      {
        sql: 'DELETE FROM events WHERE queue = ? AND event_name = ?',
        args: ['q', taskDoneEventName(child.taskId)],
      },
    ])
    await f.raw.batch('hold-the-recording-open', [
      {
        sql: `CREATE FUNCTION hold_the_recording_open() RETURNS trigger LANGUAGE plpgsql AS '
                BEGIN
                  PERFORM pg_sleep(0.4);
                  RETURN NEW;
                END'`,
        args: [],
      },
      {
        sql: `CREATE TRIGGER hold_the_recording_open AFTER INSERT ON events
              FOR EACH ROW EXECUTE FUNCTION hold_the_recording_open()`,
        args: [],
      },
    ])
    await f.store.spawn('q', 'first-parent', '{}')
    const first = await claimActivated(f.store, 'q', 'w-first', 3600)
    await f.store.spawn('q', 'second-parent', '{}')
    const second = await claimActivated(f.store, 'q', 'w-second', 3600)
    const answer = (awaiting: Promise<unknown>) =>
      awaiting.catch((error: unknown) => (error instanceof Error ? error.name : String(error)))
    const firstAnswer = answer(awaitTaskOwned(f.store, 'q', first, 's', child.taskId, null))
    await pause(100)
    const secondAnswer = answer(awaitTaskOwned(f.store, 'q', second, 's', child.taskId, null))
    const recorded = {
      emitted: true,
      payloadJson: encodeTaskOutcome({ state: 'completed', completedPayloadJson: '{"old":1}' }),
    }
    const events = await Promise.all([firstAnswer, secondAnswer]).then(() =>
      readOne(f.raw, 'SELECT COUNT(*) AS n FROM events WHERE queue = ?', ['q']),
    )
    expect(
      { first: await firstAnswer, second: await secondAnswer, events: Number(events?.n) },
      'mutation-verdict:behavior:recording-await-takes-the-event-lock',
    ).toEqual({ first: recorded, second: recorded, events: 1 })
  })
}, 60_000)

/**
 * An emit takes the same lock, and so does the await on the other side of every case in
 * this file. The same trigger holds an await of a caller's event open across the whole
 * emit: an unlocked emit inserts the event, sees no wait row, and the waiter sleeps
 * forever, and a locked one waits for the await to commit and wakes it. Before this case
 * the emit's lock was held by a race of real connections alone, which is a sample.
 */
it('an emit waits for an await of its event that has not committed', async () => {
  await withFixture(makePostgresFixture, 'emit-lock', async (f) => {
    await f.admin.setFakeNowEpochMs(START_MS)
    await f.raw.batch('hold-the-await-open', HOLD_THE_AWAIT_OPEN)
    await f.store.spawn('q', 'waiter', '{}')
    const waiter = await claimActivated(f.store, 'q', 'w-waiter', 3600)
    const awaiting = awaitOwned(f.store, 'q', waiter, 's', 'go', null)
    await pause(100)
    await f.store.emitEvent('q', 'go', '{"n":1}')
    const awaited = await awaiting
    const run = await readOne(f.raw, 'SELECT state, event_payload FROM runs WHERE run_id = ?', [
      waiter.runId,
    ])
    expect({ awaited, waiter: run }, 'mutation-verdict:behavior:emit-takes-the-event-lock').toEqual(
      {
        awaited: { emitted: false },
        waiter: { state: 'pending', event_payload: '{"n":1}' },
      },
    )
  })
}, 60_000)
