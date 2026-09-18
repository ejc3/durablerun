import { InvalidDurableStringError, type SqlExecutor } from '@durablerun/core'
import { expect, it } from 'vitest'
import { MysqlSchedulerStore } from '../src/store.js'
import { mysqlTestIdSource } from '../src/testing.js'

/**
 * MySQL indexes an identifier as VARCHAR(255) and cuts trailing spaces past that width
 * with a note, so a longer name could be stored as a different, shorter one. The store
 * refuses every identifier past the width before any statement is sent, whatever the
 * excess is. This needs no server: the executor here only records that it was reached.
 */

function storeOverRecorder() {
  const reached: string[] = []
  const db: SqlExecutor = {
    batch: async (label) => {
      reached.push(label)
      return []
    },
  }
  return { store: new MysqlSchedulerStore(db, mysqlTestIdSource('bound')), reached }
}

const wake = { inSeconds: 1 }

type Entry = (s: MysqlSchedulerStore, id: string) => Promise<unknown>[]

/** For every public method, one call for each place a bounded identifier enters it. */
const ENTRIES: Readonly<Record<string, Entry>> = {
  spawn: (s, id) => [s.spawn(id, 't', '{}'), s.spawn('q', 't', '{}', { idempotencyKey: id })],
  claim: (s, id) => [s.claim(id, 'w', { leaseSeconds: 30, limit: 1 })],
  activate: (s, id) => [s.activate(id, 'r', 'c', 1), s.activate('q', id, 'c', 1)],
  heartbeat: (s, id) => [s.heartbeat(id, 'r', 'c', 30), s.heartbeat('q', id, 'c', 30)],
  sweep: (s, id) => [s.sweep(id, 10)],
  expireLeaseNow: (s, id) => [s.expireLeaseNow(id, 'r', 'c'), s.expireLeaseNow('q', id, 'c')],
  driverHeartbeat: (s, id) => [s.driverHeartbeat(id, 'd', 30), s.driverHeartbeat('q', id, 30)],
  retryTask: (s, id) => [s.retryTask(id, 't'), s.retryTask('q', id)],
  cancelTask: (s, id) => [s.cancelTask(id, 't'), s.cancelTask('q', id)],
  claimedTaskName: (s, id) => [
    s.claimedTaskName(id, 'r', 'c', 1),
    s.claimedTaskName('q', id, 'c', 1),
  ],
  deferLaunch: (s, id) => [s.deferLaunch(id, 'r', 'c', 1, 5), s.deferLaunch('q', id, 'c', 1, 5)],
  reschedule: (s, id) => [s.reschedule(id, 'r', 'c', wake), s.reschedule('q', id, 'c', wake)],
  suspendRun: (s, id) => [
    s.suspendRun(id, 'r', 'c', wake, { key: 'k', stateJson: '{}' }),
    s.suspendRun('q', id, 'c', wake, { key: 'k', stateJson: '{}' }),
    s.suspendRun('q', 'r', 'c', wake, { key: id, stateJson: '{}' }),
  ],
  complete: (s, id) => [s.complete(id, 'r', 'c', '{}'), s.complete('q', id, 'c', '{}')],
  fail: (s, id) => [s.fail(id, 'r', 'c', '{}', null), s.fail('q', id, 'c', '{}', null)],
  failRollback: (s, id) => [
    s.failRollback(id, 'r', 'c', '{}', null, { key: 'k', stateJson: '{}' }),
    s.failRollback('q', id, 'c', '{}', null, { key: 'k', stateJson: '{}' }),
    s.failRollback('q', 'r', 'c', '{}', null, { key: id, stateJson: '{}' }),
  ],
  getCheckpoints: (s, id) => [s.getCheckpoints(id, 't', 1), s.getCheckpoints('q', id, 1)],
  setCheckpoint: (s, id) => [
    s.setCheckpoint(id, 't', 'r', 'c', 'k', '{}', 30),
    s.setCheckpoint('q', id, 'r', 'c', 'k', '{}', 30),
    s.setCheckpoint('q', 't', id, 'c', 'k', '{}', 30),
    s.setCheckpoint('q', 't', 'r', 'c', id, '{}', 30),
  ],
  getTaskResult: (s, id) => [s.getTaskResult(id, 't'), s.getTaskResult('q', id)],
  nextWakeAtEpochMs: (s, id) => [s.nextWakeAtEpochMs(id)],
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
}

/** Methods no caller reaches: each runs inside a public one, behind its check. */
const INTERNAL = [
  'sweepLostLaunch',
  'sweepClaimTimeout',
  'cancelTransition',
  'refusal',
  'refusalState',
  'endingTask',
  'taskDone',
  'wakeWaiters',
  'awaitNamedEvent',
  'taskDoneState',
  'recordTaskDone',
  'sagaPass',
  'failInto',
]

const entries = (s: MysqlSchedulerStore, id: string): Promise<unknown>[] =>
  Object.values(ENTRIES).flatMap((entry) => entry(s, id))

it('has an entry for every method the store has, so a new method cannot arrive unchecked', () => {
  const prototype = MysqlSchedulerStore.prototype as unknown as Record<string, unknown>
  const methods = Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor' && typeof prototype[name] === 'function',
  )
  expect([...methods].sort()).toEqual([...Object.keys(ENTRIES), ...INTERNAL].sort())
})

const outcomes = (calls: Promise<unknown>[]) =>
  Promise.all(
    calls.map((call) =>
      call.then(
        () => 'accepted',
        (error: unknown) => error,
      ),
    ),
  )

it('refuses an identifier past 255 characters at every entry, before anything is sent', async () => {
  for (const tooLong of [
    `${'x'.repeat(255)} `,
    'x'.repeat(256),
    `${'x'.repeat(255)}${' '.repeat(40)}`,
  ]) {
    const { store, reached } = storeOverRecorder()
    const results = await outcomes(entries(store, tooLong))
    expect(
      results.map((outcome) => outcome instanceof InvalidDurableStringError),
      'mutation-verdict:construction:mysql-identifier-past-the-width-refused-in-the-store',
    ).toEqual(results.map(() => true))
    expect(reached).toEqual([])
  }
})

it('counts characters as MySQL does, so 200 characters outside the basic plane, which are 400 UTF-16 units, still fit', async () => {
  // The exact boundary, 255 four-byte characters, is held against the server in
  // real-server.test.ts. Here the identifier also has to fit inside the names the store
  // derives from it, such as a child's completion event, so it is shorter than the width.
  const { store, reached } = storeOverRecorder()
  const fits = '\u{1F600}'.repeat(200)
  expect(fits.length).toBe(400)
  const results = await outcomes(entries(store, fits))
  expect(results.filter((outcome) => outcome instanceof InvalidDurableStringError)).toEqual([])
  expect(reached.length).toBeGreaterThan(0)
})

/**
 * Two names the store derives from an identifier are longer than it, and the bound is held
 * to them as they are stored. Each refusal names what the caller passed.
 */
it('holds a child task id to the width less its completion event prefix, and says so', async () => {
  const awaited = async (childTaskId: string) => {
    const { store, reached } = storeOverRecorder()
    const outcome = await store.awaitTaskDone('q', 't', 'r', 'c', 's', childTaskId, null).then(
      () => 'accepted',
      (error: unknown) => error,
    )
    return { outcome, reached: reached.length }
  }
  // `$task-done:` is 11 characters, so 244 is the longest child id whose event name fits.
  const fits = await awaited('x'.repeat(244))
  expect(fits.outcome).not.toBeInstanceOf(InvalidDurableStringError)
  expect(fits.reached).toBeGreaterThan(0)
  const tooLong = await awaited('x'.repeat(245))
  expect(tooLong.outcome).toBeInstanceOf(InvalidDurableStringError)
  expect(String(tooLong.outcome)).toContain('childTaskId')
  expect(String(tooLong.outcome)).not.toContain('eventName')
  expect(tooLong.reached).toBe(0)
})

it('holds a replay key to the width less the rest of the stored child key, and says so', async () => {
  const parentTaskId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
  expect(parentTaskId).toHaveLength(36)
  const spawned = async (replayKey: string) => {
    const { store, reached } = storeOverRecorder()
    const outcome = await store
      .spawn('q', 'child', '{}', {
        childOf: { parentQueue: 'q', parentTaskId, runId: 'r', claimToken: 'c', replayKey },
      })
      .then(
        () => 'accepted',
        (error: unknown) => error,
      )
    return { outcome, reached: reached.length }
  }
  // `$spawn:36:`, the parent id, and a colon are 47 characters, which leaves 208.
  const fits = await spawned('k'.repeat(208))
  expect(fits.outcome).not.toBeInstanceOf(InvalidDurableStringError)
  expect(fits.reached).toBeGreaterThan(0)
  const tooLong = await spawned('k'.repeat(209))
  expect(tooLong.outcome).toBeInstanceOf(InvalidDurableStringError)
  expect(String(tooLong.outcome)).toContain('replayKey')
  expect(String(tooLong.outcome)).not.toContain('idempotencyKey')
  expect(tooLong.reached).toBe(0)
})

it('holds a saga step key to the width less the longest saga prefix, at every entry that carries one', async () => {
  // A step's checkpoints are named by a prefix and its key, and the longest prefix,
  // `$rollback-tries:`, is 16 characters, so a key holds 239. The shortest name is held to
  // that too: a step registers under `$started:`, and a key that fits only there would
  // start and could never have a failed rollback recorded.
  const wake = { inSeconds: 1 }
  const entries = (
    s: MysqlSchedulerStore,
    key: string,
  ): Record<string, () => Promise<unknown>> => ({
    checkpointName: () => s.setCheckpoint('q', 't', 'r', 'c', `$started:${key}`, '0', 30),
    'checkpointName ': () => s.setCheckpoint('q', 't', 'r', 'c', `$rollback:${key}`, 'null', 30),
    'checkpoint.key': () =>
      s.suspendRun('q', 'r', 'c', wake, { key: `$started:${key}`, stateJson: '0' }),
    'rollbackTry.key': () =>
      s.failRollback('q', 'r', 'c', '{}', null, { key: `$rollback-tries:${key}`, stateJson: '{}' }),
  })
  const outcomesOf = async (key: string) => {
    const { store, reached } = storeOverRecorder()
    const results: [string, unknown][] = []
    for (const [field, call] of Object.entries(entries(store, key))) {
      results.push([
        field.trim(),
        await call().then(
          () => 'accepted',
          (error: unknown) => error,
        ),
      ])
    }
    return { results, reached: reached.length }
  }
  const fits = await outcomesOf('k'.repeat(239))
  expect(
    fits.results.filter(([, outcome]) => outcome instanceof InvalidDurableStringError),
  ).toEqual([])
  expect(fits.reached).toBeGreaterThan(0)
  const tooLong = await outcomesOf('k'.repeat(240))
  expect(
    tooLong.results.map(
      ([field, outcome]) =>
        outcome instanceof InvalidDurableStringError && String(outcome).includes(field),
    ),
  ).toEqual([true, true, true, true])
  expect(tooLong.reached).toBe(0)
  // A name that is not a saga's is held to the plain width and nothing less.
  const { store, reached } = storeOverRecorder()
  const plain = await store.setCheckpoint('q', 't', 'r', 'c', 'k'.repeat(255), '0', 30).then(
    () => 'accepted',
    (error: unknown) => error,
  )
  expect(plain).not.toBeInstanceOf(InvalidDurableStringError)
  expect(reached.length).toBeGreaterThan(0)
})
