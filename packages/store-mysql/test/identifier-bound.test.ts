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

/** One call for every place a bounded identifier enters the store. */
const entries = (s: MysqlSchedulerStore, id: string): Promise<unknown>[] => [
  s.spawn(id, 't', '{}'),
  s.spawn('q', 't', '{}', { idempotencyKey: id }),
  s.claim(id, 'w', { leaseSeconds: 30, limit: 1 }),
  s.activate(id, 'r', 'c', 1),
  s.activate('q', id, 'c', 1),
  s.heartbeat(id, 'r', 'c', 30),
  s.heartbeat('q', id, 'c', 30),
  s.sweep(id, 10),
  s.expireLeaseNow(id, 'r', 'c'),
  s.expireLeaseNow('q', id, 'c'),
  s.driverHeartbeat(id, 'd', 30),
  s.driverHeartbeat('q', id, 30),
  s.retryTask(id, 't'),
  s.retryTask('q', id),
  s.cancelTask(id, 't'),
  s.cancelTask('q', id),
  s.claimedTaskName(id, 'r', 'c', 1),
  s.claimedTaskName('q', id, 'c', 1),
  s.deferLaunch(id, 'r', 'c', 1, 5),
  s.deferLaunch('q', id, 'c', 1, 5),
  s.reschedule(id, 'r', 'c', wake),
  s.reschedule('q', id, 'c', wake),
  s.suspendRun(id, 'r', 'c', wake, { key: 'k', stateJson: '{}' }),
  s.suspendRun('q', id, 'c', wake, { key: 'k', stateJson: '{}' }),
  s.suspendRun('q', 'r', 'c', wake, { key: id, stateJson: '{}' }),
  s.complete(id, 'r', 'c', '{}'),
  s.complete('q', id, 'c', '{}'),
  s.fail(id, 'r', 'c', '{}', null),
  s.fail('q', id, 'c', '{}', null),
  s.getCheckpoints(id, 't', 1),
  s.getCheckpoints('q', id, 1),
  s.setCheckpoint(id, 't', 'r', 'c', 'k', '{}', 30),
  s.setCheckpoint('q', id, 'r', 'c', 'k', '{}', 30),
  s.setCheckpoint('q', 't', id, 'c', 'k', '{}', 30),
  s.setCheckpoint('q', 't', 'r', 'c', id, '{}', 30),
  s.getTaskResult(id, 't'),
  s.getTaskResult('q', id),
  s.nextWakeAtEpochMs(id),
  s.emitEvent(id, 'e', '{}'),
  s.emitEvent('q', id, '{}'),
  s.awaitEvent(id, 't', 'r', 'c', 's', 'e', null),
  s.awaitEvent('q', id, 'r', 'c', 's', 'e', null),
  s.awaitEvent('q', 't', id, 'c', 's', 'e', null),
  s.awaitEvent('q', 't', 'r', 'c', id, 'e', null),
  s.awaitEvent('q', 't', 'r', 'c', 's', id, null),
]

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
