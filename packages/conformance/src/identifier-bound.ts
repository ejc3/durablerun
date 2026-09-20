import {
  LIVE_STATES,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  type SqlExecutor,
  TERMINAL_STATES,
  childSpawnKey,
  encodeRollbackTry,
} from '@durablerun/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { engineHistoryViolations } from './engine-history.js'
import { checkpointOwned, claimActivated, refusalName, withFixture } from './scenario.js'

/**
 * A durable identifier holds 255 characters, counted in Unicode code points, on every
 * dialect (DESIGN.md §3.4). The number is written here and not imported, so the suite
 * holds the contract and not whatever the constant happens to say.
 */
const WIDTH = 255
const REFUSED = 'InvalidDurableStringError'
const CAUSE = '{"name":"Error","message":"boom"}'
const wake = { inSeconds: 1 }

/** A store over an executor that only records that it was reached. */
function storeOverRecorder(f: StoreFixture) {
  const reached: string[] = []
  const db: SqlExecutor = {
    batch: async (label) => {
      reached.push(label)
      return []
    },
  }
  return { store: f.storeOver(db), reached }
}

type Entry = (s: SchedulerStore, id: string) => Promise<unknown>[]

/** A parent as a child spawn names it. Each identifier in it enters the port too. */
const PARENT = { parentQueue: 'q', parentTaskId: 'p', runId: 'r', claimToken: 'c', replayKey: 'k' }

/**
 * For every method of the port, one call for each place an identifier enters it. The
 * type makes a port method with no entry here a compile error, so a new method cannot
 * arrive unchecked.
 */
const ENTRIES: { readonly [Method in keyof SchedulerStore]: Entry } = {
  spawn: (s, id) => [
    s.spawn(id, 't', '{}'),
    s.spawn('q', 't', '{}', { idempotencyKey: id }),
    s.spawn('q', 't', '{}', { childOf: { ...PARENT, parentQueue: id } }),
    s.spawn('q', 't', '{}', { childOf: { ...PARENT, parentTaskId: id } }),
    s.spawn('q', 't', '{}', { childOf: { ...PARENT, runId: id } }),
  ],
  claim: (s, id) => [s.claim(id, 'w', { leaseSeconds: 30, limit: 1 })],
  activate: (s, id) => [s.activate(id, 'r', 'c', 1), s.activate('q', id, 'c', 1)],
  claimedTaskName: (s, id) => [
    s.claimedTaskName(id, 'r', 'c', 1),
    s.claimedTaskName('q', id, 'c', 1),
  ],
  deferLaunch: (s, id) => [s.deferLaunch(id, 'r', 'c', 1, 5), s.deferLaunch('q', id, 'c', 1, 5)],
  heartbeat: (s, id) => [s.heartbeat(id, 'r', 'c', 30), s.heartbeat('q', id, 'c', 30)],
  reschedule: (s, id) => [s.reschedule(id, 'r', 'c', wake), s.reschedule('q', id, 'c', wake)],
  complete: (s, id) => [s.complete(id, 'r', 'c', '{}'), s.complete('q', id, 'c', '{}')],
  suspendRun: (s, id) => [
    s.suspendRun(id, 'r', 'c', wake, { key: 'k', stateJson: '{}' }),
    s.suspendRun('q', id, 'c', wake, { key: 'k', stateJson: '{}' }),
    s.suspendRun('q', 'r', 'c', wake, { key: id, stateJson: '{}' }),
  ],
  fail: (s, id) => [s.fail(id, 'r', 'c', '{}', null), s.fail('q', id, 'c', '{}', null)],
  failRollback: (s, id) => [
    s.failRollback(id, 'r', 'c', '{}', null, { key: 'k', stateJson: '{}' }),
    s.failRollback('q', id, 'c', '{}', null, { key: 'k', stateJson: '{}' }),
    s.failRollback('q', 'r', 'c', '{}', null, { key: id, stateJson: '{}' }),
  ],
  sweep: (s, id) => [s.sweep(id, 10)],
  expireLeaseNow: (s, id) => [s.expireLeaseNow(id, 'r', 'c'), s.expireLeaseNow('q', id, 'c')],
  getCheckpoints: (s, id) => [s.getCheckpoints(id, 't', 1), s.getCheckpoints('q', id, 1)],
  setCheckpoint: (s, id) => [
    s.setCheckpoint(id, 't', 'r', 'c', 'k', '{}', 30),
    s.setCheckpoint('q', id, 'r', 'c', 'k', '{}', 30),
    s.setCheckpoint('q', 't', id, 'c', 'k', '{}', 30),
    s.setCheckpoint('q', 't', 'r', 'c', id, '{}', 30),
  ],
  emitEvent: (s, id) => [s.emitEvent(id, 'e', '{}'), s.emitEvent('q', id, '{}')],
  awaitEvent: (s, id) => [
    s.awaitEvent(id, 't', 'r', 'c', 's', 'e', null),
    s.awaitEvent('q', id, 'r', 'c', 's', 'e', null),
    s.awaitEvent('q', 't', id, 'c', 's', 'e', null),
    s.awaitEvent('q', 't', 'r', 'c', id, 'e', null),
    s.awaitEvent('q', 't', 'r', 'c', 's', id, null),
  ],
  awaitTaskDone: (s, id) => [
    s.awaitTaskDone(id, 't', 'r', 'c', 's', 'child', null),
    s.awaitTaskDone('q', id, 'r', 'c', 's', 'child', null),
    s.awaitTaskDone('q', 't', id, 'c', 's', 'child', null),
    s.awaitTaskDone('q', 't', 'r', 'c', id, 'child', null),
    s.awaitTaskDone('q', 't', 'r', 'c', 's', id, null),
  ],
  getTaskResult: (s, id) => [s.getTaskResult(id, 't'), s.getTaskResult('q', id)],
  nextWakeAtEpochMs: (s, id) => [s.nextWakeAtEpochMs(id)],
  driverHeartbeat: (s, id) => [s.driverHeartbeat(id, 'd', 30), s.driverHeartbeat('q', id, 30)],
  cancelTask: (s, id) => [s.cancelTask(id, 't'), s.cancelTask('q', id)],
  retryTask: (s, id) => [s.retryTask(id, 't'), s.retryTask('q', id)],
}

/** The refusal of every entry, keyed by the method and the position the identifier took. */
async function refusalsAtEveryEntry(
  store: SchedulerStore,
  id: string,
): Promise<Record<string, string>> {
  const refusals: Record<string, string> = {}
  for (const [method, entry] of Object.entries(ENTRIES)) {
    for (const [position, call] of entry(store, id).entries()) {
      refusals[`${method}#${position}`] = await refusalName(call)
    }
  }
  return refusals
}

/**
 * A store whose calls start when they are awaited and not when they are made. An entry
 * makes all its calls at once, which is right over a recorder and wrong over a database:
 * there they would race, and one that refused while another was awaited would be
 * reported as unhandled. Over this store they run one at a time, in the order read.
 * The store itself answers no `then`: a proxy that answered one would be a thenable, and
 * awaiting it, or returning it from an async function, would never resolve.
 */
function oneAtATime(store: SchedulerStore): SchedulerStore {
  return new Proxy(store, {
    get: (target, method) =>
      method === 'then'
        ? undefined
        : (...args: unknown[]) => ({
            // biome-ignore lint/suspicious/noThenProperty: a call that starts when it is awaited is a thenable
            then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
              (Reflect.get(target, method) as (...values: unknown[]) => Promise<unknown>)
                .apply(target, args)
                .then(resolve, reject),
          }),
  })
}

/** What one call answered over the recorder: its error, or 'accepted', and whether anything was sent. */
async function outcomeOf(f: StoreFixture, call: (s: SchedulerStore) => Promise<unknown>) {
  const { store, reached } = storeOverRecorder(f)
  const outcome = await call(store).then(
    () => 'accepted',
    (error: unknown) => error,
  )
  return {
    refused: outcome instanceof Error && outcome.name === REFUSED,
    message: String(outcome),
    sent: reached.length > 0,
  }
}

export function identifierBoundConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`identifier bound conformance [${dialect}]`, () => {
    // The first three cases send nothing, because their stores sit over a recorder. They
    // share one fixture, and it is not migrated: only its store constructor is used.
    let f: StoreFixture
    beforeAll(async () => {
      f = await makeFixture('identifier-bound', { migrate: false })
    })
    afterAll(async () => {
      await f.close()
    })

    it('refuses an identifier past 255 characters at every entry of the port, before anything is sent', async () => {
      for (const tooLong of [
        'x'.repeat(WIDTH + 1),
        // Excess that is only trailing spaces is the excess one dialect would cut silently.
        `${'x'.repeat(WIDTH)} `,
        '\u{1F600}'.repeat(WIDTH + 1),
      ]) {
        const { store, reached } = storeOverRecorder(f)
        const refusals = await refusalsAtEveryEntry(store, tooLong)
        expect(
          { refusals, sent: reached },
          'mutation-verdict:behavior:identifier-past-the-width-refused-at-every-entry',
        ).toEqual({
          refusals: Object.fromEntries(Object.keys(refusals).map((entry) => [entry, REFUSED])),
          sent: [],
        })
      }
    })

    it('counts characters as code points, so 200 characters outside the basic plane fit at every entry', async () => {
      // They are 400 UTF-16 units and 800 bytes. The identifier also has to fit inside the
      // names the engine derives from it, so it is shorter than the width.
      const fits = '\u{1F600}'.repeat(200)
      expect(fits.length).toBe(400)
      const { store, reached } = storeOverRecorder(f)
      const refusals = await refusalsAtEveryEntry(store, fits)
      expect(
        Object.entries(refusals).filter(([, refusal]) => refusal === REFUSED),
        'mutation-verdict:behavior:identifier-width-counts-code-points',
      ).toEqual([])
      expect(reached.length).toBeGreaterThan(0)
    })

    it('refuses a name outside the durable string domain at every entry of the port, before anything is sent', async () => {
      // No dialect keeps such a name as it was passed. A NUL ends the name on one dialect,
      // is stored whole on another, and is refused by the third as an outage. A lone
      // surrogate is replaced by every driver, so two names that differ only in one are
      // stored as one name, and a claim token that differs only in one holds the claim.
      for (const undurable of ['a\u0000b', 'a\uD800b', 'a\uDC00b']) {
        const { store, reached } = storeOverRecorder(f)
        const refusals = await refusalsAtEveryEntry(store, undurable)
        expect({ refusals, sent: reached }).toEqual({
          refusals: Object.fromEntries(Object.keys(refusals).map((entry) => [entry, REFUSED])),
          sent: [],
        })
      }
    })

    it('holds the names the engine derives from an identifier to the same width, and names what the caller passed', async () => {
      // `$task-done:` is 11 characters, so 244 is the longest child id whose event name fits.
      const awaited = (childTaskId: string) =>
        outcomeOf(f, (s) => s.awaitTaskDone('q', 't', 'r', 'c', 's', childTaskId, null))
      // `$spawn:36:`, a 36-character parent id, and a colon are 47 characters, which leaves 208.
      const parentTaskId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
      const spawned = (replayKey: string) =>
        outcomeOf(f, (s) =>
          s.spawn('q', 'child', '{}', {
            childOf: { parentQueue: 'q', parentTaskId, runId: 'r', claimToken: 'c', replayKey },
          }),
        )
      // A step's saga names are a prefix and its key, and the longest prefix,
      // `$rollback-tries:`, is 16 characters, so a key holds 239. The key is held where the
      // step starts, under `$started:`, which is the shortest of its names: a key that fit
      // only there would start and could never have a failed rollback recorded.
      const sagaEntries: Record<string, (s: SchedulerStore, key: string) => Promise<unknown>> = {
        'checkpointName, as a start marker': (s, key) =>
          s.setCheckpoint('q', 't', 'r', 'c', `${SAGA_STARTED_PREFIX}${key}`, '0', 30),
        'checkpointName, as a rollback record': (s, key) =>
          s.setCheckpoint('q', 't', 'r', 'c', `${SAGA_ROLLBACK_PREFIX}${key}`, 'null', 30),
        'checkpoint.key': (s, key) =>
          s.suspendRun('q', 'r', 'c', wake, {
            key: `${SAGA_STARTED_PREFIX}${key}`,
            stateJson: '0',
          }),
        'rollbackTry.key': (s, key) =>
          s.failRollback('q', 'r', 'c', '{}', null, {
            key: `${SAGA_TRIES_PREFIX}${key}`,
            stateJson: '{}',
          }),
      }
      const saga = async (key: string) => {
        const outcomes: Record<string, { refused: boolean; namesIt: boolean; sent: boolean }> = {}
        for (const [field, call] of Object.entries(sagaEntries)) {
          const outcome = await outcomeOf(f, (s) => call(s, key))
          outcomes[field] = {
            refused: outcome.refused,
            namesIt: outcome.message.includes(field.split(',')[0] ?? field),
            sent: outcome.sent,
          }
        }
        return outcomes
      }
      const fits = { refused: false, sent: true }
      const refusedNamingIt = { refused: true, namesIt: true, sent: false }
      const childFits = await awaited('x'.repeat(244))
      const childTooLong = await awaited('x'.repeat(245))
      const keyFits = await spawned('k'.repeat(208))
      const keyTooLong = await spawned('k'.repeat(209))
      expect(
        {
          childFits: { refused: childFits.refused, sent: childFits.sent },
          childTooLong: {
            refused: childTooLong.refused,
            sent: childTooLong.sent,
            namesTheChild: childTooLong.message.includes('childTaskId'),
            namesTheEvent: childTooLong.message.includes('eventName'),
          },
          keyFits: { refused: keyFits.refused, sent: keyFits.sent },
          keyTooLong: {
            refused: keyTooLong.refused,
            sent: keyTooLong.sent,
            namesTheReplayKey: keyTooLong.message.includes('replayKey'),
            namesAnIdempotencyKey: keyTooLong.message.includes('idempotencyKey'),
          },
          sagaFits: await saga('k'.repeat(239)),
          sagaTooLong: await saga('k'.repeat(240)),
          // A name that is not a saga's is held to the plain width and nothing less.
          plainCheckpoint: await outcomeOf(f, (s) =>
            s.setCheckpoint('q', 't', 'r', 'c', 'k'.repeat(WIDTH), '0', 30),
          ).then(({ refused, sent }) => ({ refused, sent })),
        },
        'mutation-verdict:behavior:derived-names-held-to-the-identifier-width',
      ).toEqual({
        childFits: fits,
        childTooLong: { refused: true, sent: false, namesTheChild: true, namesTheEvent: false },
        keyFits: fits,
        keyTooLong: {
          refused: true,
          sent: false,
          namesTheReplayKey: true,
          namesAnIdempotencyKey: false,
        },
        sagaFits: Object.fromEntries(
          Object.keys(sagaEntries).map((field) => [field, { ...fits, namesIt: false }]),
        ),
        sagaTooLong: {
          'checkpointName, as a start marker': refusedNamingIt,
          // A rollback record is held to the plain width and not to the key: a step that
          // started before the rule, under a longer key, must still be able to record that
          // its rollback ran.
          'checkpointName, as a rollback record': { ...fits, namesIt: false },
          'checkpoint.key': refusedNamingIt,
          // `$rollback-tries:` and 240 characters are 256, which the plain width refuses.
          'rollbackTry.key': refusedNamingIt,
        },
        plainCheckpoint: fits,
      })
    })

    it('answers an identifier that spells a task state as it answers any other, at every entry of the port', () =>
      // A state's name is a word a caller may pass as an identifier. The engine reads its
      // own statements to know what they do, and a caller's string bound into one must
      // never read as part of it: every entry answers such a word as it answers a word
      // that spells nothing. It reads and writes, so it has a migrated fixture of its own.
      withFixture(makeFixture, 'identifier-bound-state-words', async (live) => {
        const store = oneAtATime(live.store)
        const ordinary = await refusalsAtEveryEntry(store, 'spells-nothing')
        const answers: Record<string, Record<string, string>> = {}
        for (const word of [...LIVE_STATES, ...TERMINAL_STATES]) {
          answers[word] = await refusalsAtEveryEntry(store, word)
        }
        expect(answers).toEqual(
          Object.fromEntries(Object.keys(answers).map((word) => [word, ordinary])),
        )
        expect(Object.keys(answers)).toHaveLength(6)
        expect(await engineHistoryViolations(live.raw)).toEqual([])
      }))

    it('keeps the longest names that fit, and the names derived from them, exactly as they were passed', () =>
      // The one case that reads and writes, so it has a migrated fixture of its own.
      withFixture(makeFixture, 'identifier-bound-round-trip', async (live) => {
        // Four-byte characters, so the widest value a dialect has to index is what is stored.
        const queue = '\u{1F600}'.repeat(WIDTH)
        const childQueue = 'c'.repeat(WIDTH)
        const idempotencyKey = '\u{1F511}'.repeat(WIDTH)
        const eventName = '\u{1F4E3}'.repeat(WIDTH)
        const stepName = 's'.repeat(WIDTH)
        const checkpointName = 'p'.repeat(WIDTH)
        const stepKey = 'k'.repeat(239)

        const spawned = await live.store.spawn(queue, 'job', '{}', { idempotencyKey })
        const again = await live.store.spawn(queue, 'job', '{}', { idempotencyKey })
        const first = await claimActivated(live.store, queue, 'w-first')
        // The await registers and parks the run, so the step and the event are stored as
        // the wait's names, and the emit hands both back through the next claim.
        const awaited = await live.store.awaitEvent(
          queue,
          first.taskId,
          first.runId,
          first.claimToken,
          stepName,
          eventName,
          null,
        )
        await live.store.emitEvent(queue, eventName, '{"x":1}')
        const run = await claimActivated(live.store, queue, 'w-forward')
        await checkpointOwned(live.store, queue, run, checkpointName, '1', 60)

        // The stored child key holds the parent task id as well, so the room left for the
        // replay key is measured against the key as the engine builds it.
        const room = WIDTH - [...childSpawnKey(spawned.taskId, '')].length
        const childOf = {
          parentQueue: queue,
          parentTaskId: spawned.taskId,
          runId: run.runId,
          claimToken: run.claimToken,
        }
        const child = await live.store.spawn(childQueue, 'child', '{}', {
          childOf: { ...childOf, replayKey: 'r'.repeat(room) },
        })
        const oneMore = await refusalName(
          live.store.spawn(childQueue, 'child', '{}', {
            childOf: { ...childOf, replayKey: 'r'.repeat(room + 1) },
          }),
        )

        // A registered step under the longest key, taken through a rollback that fails for
        // good, which writes all three of its saga names.
        await checkpointOwned(live.store, queue, run, `${SAGA_STARTED_PREFIX}${stepKey}`, '1', 60)
        await live.store.fail(queue, run.runId, run.claimToken, CAUSE, null)
        const pass = await claimActivated(live.store, queue, 'w-pass')
        await live.store.failRollback(queue, pass.runId, pass.claimToken, CAUSE, null, {
          key: `${SAGA_TRIES_PREFIX}${stepKey}`,
          stateJson: encodeRollbackTry({ tries: 1, errorJson: CAUSE }),
        })

        const [tasks, events, checkpoints] = await live.raw.batch(
          'identifier-bound-readback',
          [
            { sql: 'SELECT task_id, queue, idempotency_key FROM tasks ORDER BY task_id', args: [] },
            { sql: 'SELECT queue, event_name FROM events WHERE event_name = ?', args: [eventName] },
            {
              sql: 'SELECT checkpoint_name FROM checkpoints WHERE task_id = ? ORDER BY checkpoint_name',
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        const read = await live.store.getCheckpoints(queue, spawned.taskId, pass.attempt)
        const storedNames = [
          `${SAGA_TRIES_PREFIX}${stepKey}`,
          `${SAGA_STARTED_PREFIX}${stepKey}`,
          SAGA_PHASE_CHECKPOINT,
          checkpointName,
        ].sort()
        expect({
          replayFindsTheTask: again.taskId === spawned.taskId && !again.created,
          awaited,
          wake: run.wake,
          oneMore,
          tasks: tasks?.rows.map((row) => ({
            taskId: String(row.task_id),
            queue: String(row.queue),
            key: String(row.idempotency_key),
          })),
          events: events?.rows.map((row) => ({
            queue: String(row.queue),
            eventName: String(row.event_name),
          })),
          checkpoints: checkpoints?.rows.map((row) => String(row.checkpoint_name)),
          readThroughThePort: read.map((checkpoint) => checkpoint.checkpointName).sort(),
        }).toEqual({
          replayFindsTheTask: true,
          awaited: { emitted: false },
          wake: { event: eventName, step: stepName, payloadJson: '{"x":1}' },
          oneMore: REFUSED,
          tasks: [
            { taskId: spawned.taskId, queue, key: idempotencyKey },
            {
              taskId: child.taskId,
              queue: childQueue,
              key: childSpawnKey(spawned.taskId, 'r'.repeat(room)),
            },
          ].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
          events: [{ queue, eventName }],
          checkpoints: storedNames,
          readThroughThePort: storedNames,
        })
        expect([...childSpawnKey(spawned.taskId, 'r'.repeat(room))]).toHaveLength(WIDTH)
        expect(await engineHistoryViolations(live.raw)).toEqual([])
      }))
  })
}
