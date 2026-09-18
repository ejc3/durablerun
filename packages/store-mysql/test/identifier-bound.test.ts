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
    s.awaitTaskDone(id, 't', 'r', 'c', 's', 'child'),
    s.awaitTaskDone('q', id, 'r', 'c', 's', 'child'),
    s.awaitTaskDone('q', 't', id, 'c', 's', 'child'),
    s.awaitTaskDone('q', 't', 'r', 'c', id, 'child'),
    s.awaitTaskDone('q', 't', 'r', 'c', 's', id),
  ],
}

/** Methods no caller reaches: each runs inside a public one, behind its check. */
const INTERNAL = [
  'sweepLostLaunch',
  'sweepClaimTimeout',
  'cancelTransition',
  'refusal',
  'refusalState',
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

it('counts characters as MySQL does, so 255 characters outside the basic plane still fit', async () => {
  const { store, reached } = storeOverRecorder()
  const fits = '\u{1F600}'.repeat(255)
  expect(fits.length).toBe(510)
  const results = await outcomes(entries(store, fits))
  expect(results.filter((outcome) => outcome instanceof InvalidDurableStringError)).toEqual([])
  expect(reached.length).toBeGreaterThan(0)
})
