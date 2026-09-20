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
import {
  HELD_PLACES,
  IDENTIFIER_PLACES,
  OUTSIDE_THE_DOMAIN,
  PAST_THE_WIDTH,
  PORT_STRING_PLACES,
  PORT_STRING_PROBLEMS,
  type PortStringPlace,
  WIDTH,
} from './port-strings.js'
import { checkpointOwned, claimActivated, refusalName, withFixture } from './scenario.js'

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

/** What every place in `places` answers for `value`, keyed by the place. */
async function refusalsAt(
  places: readonly PortStringPlace[],
  store: SchedulerStore,
  value: unknown,
): Promise<Record<string, string>> {
  const refusals: Record<string, string> = {}
  for (const { place, call } of places) refusals[place] = await refusalName(call(store, value))
  return refusals
}

/** Every place refused, as the expectation of a case that asks all of them. */
const allRefused = (refusals: Record<string, string>) =>
  Object.fromEntries(Object.keys(refusals).map((place) => [place, REFUSED]))

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

/** Every place the port does not hold as an identifier, written here by hand. */
const NOT_AN_IDENTIFIER: Readonly<Record<string, string>> = {
  'spawn[1](taskName)': 'durable',
  'spawn[2](paramsJson)': 'payload',
  'spawn[3].childOf.claimToken(childOf.claimToken)': 'durable',
  'spawn[3].headers(headers)': 'payload',
  'claim[1](claimToken)': 'durable',
  'activate[2](claimToken)': 'durable',
  'claimedTaskName[2](claimToken)': 'durable',
  'deferLaunch[2](claimToken)': 'durable',
  'heartbeat[2](claimToken)': 'durable',
  'reschedule[2](claimToken)': 'durable',
  'complete[2](claimToken)': 'durable',
  'complete[3](resultJson)': 'payload',
  'suspendRun[2](claimToken)': 'durable',
  'suspendRun[4].stateJson(checkpoint.stateJson)': 'payload',
  'fail[2](claimToken)': 'durable',
  'fail[3](failureJson)': 'payload',
  'failRollback[2](claimToken)': 'durable',
  'failRollback[3](failureJson)': 'payload',
  'failRollback[5].stateJson(rollbackTry.stateJson)': 'payload',
  'expireLeaseNow[2](claimToken)': 'durable',
  'setCheckpoint[3](claimToken)': 'durable',
  'setCheckpoint[5](stateJson)': 'payload',
  'emitEvent[2](payloadJson)': 'payload',
  'awaitEvent[3](claimToken)': 'durable',
  'awaitTaskDone[3](claimToken)': 'durable',
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
      for (const tooLong of Object.values(PAST_THE_WIDTH)) {
        const { store, reached } = storeOverRecorder(f)
        const refusals = await refusalsAt(IDENTIFIER_PLACES, store, tooLong)
        expect(
          { refusals, sent: reached },
          'mutation-verdict:behavior:identifier-past-the-width-refused-at-every-entry',
        ).toEqual({ refusals: allRefused(refusals), sent: [] })
      }
    })

    it('counts characters as code points, so 200 characters outside the basic plane fit at every entry', async () => {
      // They are 400 UTF-16 units and 800 bytes. The identifier also has to fit inside the
      // names the engine derives from it, so it is shorter than the width.
      const fits = '\u{1F600}'.repeat(200)
      expect(fits.length).toBe(400)
      const { store, reached } = storeOverRecorder(f)
      const refusals = await refusalsAt(IDENTIFIER_PLACES, store, fits)
      expect(
        Object.entries(refusals).filter(([, refusal]) => refusal === REFUSED),
        'mutation-verdict:behavior:identifier-width-counts-code-points',
      ).toEqual([])
      expect(reached.length).toBeGreaterThan(0)
    })

    it('refuses a name outside the durable string domain at every entry of the port, before anything is sent', async () => {
      // No dialect keeps such a name as it was passed. A NUL ends the name where one
      // dialect stores it, is stored whole by another, and is refused by the third as an
      // outage. A lone surrogate is replaced by every driver, so two names that differ
      // only in one are stored as one name, and a claim token that differs only in one
      // holds the claim. A task name and a claim token are held as an identifier is.
      for (const [what, undurable] of Object.entries(OUTSIDE_THE_DOMAIN)) {
        const { store, reached } = storeOverRecorder(f)
        const refusals = await refusalsAt(HELD_PLACES, store, undurable)
        expect(
          { what, refusals, sent: reached },
          'mutation-verdict:behavior:name-outside-the-domain-refused-at-every-place',
        ).toEqual({ what, refusals: allRefused(refusals), sent: [] })
      }
    })

    it('leaves a payload to its serializer, at exactly the places that are written here', async () => {
      // The places the port does not hold as an identifier. The cases above draw their
      // places from core's table, so a place named there as a payload, or as a durable
      // string with no width, is asked nothing by them. It has to be written here too,
      // which makes that choice a second, visible edit.
      const notAnIdentifier = Object.fromEntries(
        PORT_STRING_PLACES.filter(({ rule }) => rule !== 'identifier').map(({ place, rule }) => [
          place,
          rule,
        ]),
      )
      // First, that the places could be generated at all: a table that names one string at
      // two arguments folds two places into one, and the written list would not see it.
      expect(
        { problems: PORT_STRING_PROBLEMS, notAnIdentifier },
        'mutation-verdict:construction:places-that-are-not-identifiers-are-written-down',
      ).toEqual({ problems: [], notAnIdentifier: NOT_AN_IDENTIFIER })
      // The counts are written here too. The list above is of what is NOT an identifier,
      // so a held place that vanished would leave it as it is: these move when one does.
      expect({
        places: PORT_STRING_PLACES.length,
        identifiers: IDENTIFIER_PLACES.length,
        held: HELD_PLACES.length,
        distinct: new Set(PORT_STRING_PLACES.map(({ place }) => place)).size,
      }).toEqual({ places: 82, identifiers: 57, held: 73, distinct: 82 })
      // A payload with a NUL in it is not this check's to refuse: nothing here answers it.
      const { store } = storeOverRecorder(f)
      const payloads = PORT_STRING_PLACES.filter(({ rule }) => rule === 'payload')
      const answers = await refusalsAt(payloads, store, '{"a":"\u0000"}')
      expect(Object.entries(answers).filter(([, answer]) => answer === REFUSED)).toEqual([])
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
        // Each place's call is made when it is asked for and awaited before the next, so
        // over a database they run one at a time, in the table's order.
        const store = live.store
        const ordinary = await refusalsAt(IDENTIFIER_PLACES, store, 'spells-nothing')
        const answers: Record<string, Record<string, string>> = {}
        for (const word of [...LIVE_STATES, ...TERMINAL_STATES]) {
          answers[word] = await refusalsAt(IDENTIFIER_PLACES, store, word)
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
