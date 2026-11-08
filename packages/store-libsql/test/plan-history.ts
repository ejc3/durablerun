import { SAGA_STARTED_PREFIX, type SqlExecutor } from '@durablerun/core'
import {
  type LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  operatorReads,
  retention,
} from '../src/index.js'
import { testIdSource } from '../src/testing.js'

type SqlStatement = Parameters<SqlExecutor['batch']>[1][number]

/** One statement a real operation sent: the label of its batch, its place in it, its binds. */
export interface Shipped {
  readonly label: string
  readonly index: number
  readonly sql: string
  readonly args: unknown[]
}

export const keyOf = (label: string, sql: string) => `${label}\n${sql}`

/**
 * One scripted history of real operations, and every statement the store sends while it
 * runs, once per send, under the label that carried it, so nothing planned from it is a hand
 * copy of what ships. The history reaches every batch in every variant it compiles to, and
 * what holds it to that is the corpus: a statement of `corpus/libsql.json` that this history
 * never sent fails the plan test. `onBatch` is called with each batch before it is sent, so
 * a caller can look at the database as the batch found it.
 */
export async function recordHistory(
  db: LibsqlExecutor,
  onBatch?: (label: string, statements: readonly SqlStatement[]) => Promise<void>,
): Promise<Shipped[]> {
  const seen: Shipped[] = []
  const recorder: SqlExecutor = {
    batch: async (label, statements, mode) => {
      await onBatch?.(label, statements)
      for (const [index, st] of statements.entries()) {
        seen.push({ label, index, sql: st.sql, args: [...st.args] })
      }
      return db.batch(label, statements, mode)
    },
  }
  const admin = new LibsqlStoreAdmin(db)
  await admin.setFakeNowEpochMs(1_000_000)
  const store = new LibsqlSchedulerStore(recorder, testIdSource('shipped-statements'))
  // A claim token is fresh for every claim, as a tick's is, and the run carries it.
  let claims = 0
  const claimOf = async (taskId: string) => {
    claims += 1
    const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
    if (!run || run.taskId !== taskId) throw new Error(`expected to claim task ${taskId}`)
    return run
  }
  const startedOf = async (taskId: string) => {
    const run = await claimOf(taskId)
    await store.activate('q', run.runId, run.claimToken, run.claimGen)
    return run
  }
  const claimed = async (name: string) => claimOf((await store.spawn('q', name, '{}')).taskId)
  const started = async (name: string, options: { maxAttempts?: number } = {}) =>
    startedOf((await store.spawn('q', name, '{}', options)).taskId)
  const deferred = await claimed('deferred')
  await store.deferLaunch('q', deferred.runId, deferred.claimToken, deferred.claimGen, 3600)
  const rescheduled = await started('rescheduled')
  await store.reschedule('q', rescheduled.runId, rescheduled.claimToken, { inSeconds: 3600 })
  const suspended = await started('suspended')
  await store.suspendRun(
    'q',
    suspended.runId,
    suspended.claimToken,
    { inSeconds: 3600 },
    { key: 'step', stateJson: '{}' },
  )
  // A heartbeat and the reads, beside a live run. A read changes nothing, so where it
  // stands is free. The driver's heartbeat is no run's, and rides here.
  const live = await started('live')
  await store.heartbeat('q', live.runId, live.claimToken, 60)
  await store.claimedTaskName('q', live.runId, live.claimToken, live.claimGen)
  await store.getCheckpoints('q', live.taskId, 1)
  await store.getTaskResult('q', live.taskId)
  await store.nextWakeAtEpochMs('q')
  await store.driverHeartbeat('q', 'driver', 60)
  // A run this store never heard of: the terminal batch reads its task, finds none, and
  // reads its state to say why it refuses.
  const refused = await store.complete('q', 'no-such-run', 'no-token', '{}').then(
    () => false,
    () => true,
  )
  if (!refused) throw new Error('expected a run nobody made to be refused')
  await store.complete('q', live.runId, live.claimToken, '{}')
  const waiting = await started('waiting')
  await store.awaitEvent(
    'q',
    waiting.taskId,
    waiting.runId,
    waiting.claimToken,
    'step',
    'event',
    null,
  )
  // An operator's reads of a parked task, of the task a key names, and of an event, before
  // the event exists and after: a read changes nothing, so where it stands is free.
  const operator = operatorReads(recorder)
  await operator.taskFacts('q', waiting.taskId)
  await operator.taskIdByKey('q', 'no-such-key')
  await store.emitEvent('q', 'event', '{}')
  await operator.taskFacts('q', waiting.taskId)
  await operator.eventState('q', 'event')
  const woken = await startedOf(waiting.taskId)
  await store.complete('q', woken.runId, woken.claimToken, '{}')
  // A parent awaits a live child, and the child ends and wakes it. Then an older build's
  // ending is staged, one that wrote no event, so the parent's next await records it.
  const parent = await started('parent')
  const child = await store.spawn('q', 'child', '{}', {
    childOf: {
      parentQueue: 'q',
      parentTaskId: parent.taskId,
      runId: parent.runId,
      claimToken: parent.claimToken,
      replayKey: 'site',
    },
  })
  const awaitChild = (run: typeof parent) =>
    store.awaitTaskDone('q', run.taskId, run.runId, run.claimToken, 'step', child.taskId, null)
  await awaitChild(parent)
  // An operator's reads of the queue, here because every table now holds a row of it: what
  // a claim or a sweep would take now, the gauges, the row counts, and an event's waiters.
  await operator.stuckRuns('q', { graceSeconds: 0, limit: 20 })
  await operator.queueStatus('q')
  await operator.tableRows('q')
  await operator.eventWaiters('q', 'event')
  await operator.agedTasks('q', { olderThanSeconds: 0, limit: 20 })
  // What a drive verb reads before it names a refusal: an event's stored payload, and
  // what the retry guard, a claim and a sweep each say of one task.
  await operator.eventPayload('q', 'event')
  await operator.taskAdmission('q', parent.taskId)
  const childRun = await startedOf(child.taskId)
  await store.complete('q', childRun.runId, childRun.claimToken, '{}')
  const wokenParent = await startedOf(parent.taskId)
  await db.batch('an-older-build-wrote-no-event', [
    {
      sql: 'DELETE FROM events WHERE queue = ? AND event_name LIKE ?',
      args: ['q', '$task-done:%'],
    },
  ])
  await awaitChild(wokenParent)
  await store.complete('q', wokenParent.runId, wokenParent.claimToken, '{}')
  const retried = await started('fails-and-retries', { maxAttempts: 2 })
  await store.fail('q', retried.runId, retried.claimToken, '{}', { delaySeconds: 3600 })
  const failed = await started('fails', { maxAttempts: 1 })
  await store.fail('q', failed.runId, failed.claimToken, '{}', null)
  // A saga (DESIGN.md §3.10). A registered step starts, and the failure that ends the
  // forward phase places the rollback pass, which `fail` ships. A rollback's failed
  // attempt places the next pass, and the one after it halts the saga, which
  // `fail-rollback` ships both ways.
  const saga = await started('rolls-back', { maxAttempts: 1 })
  await store.setCheckpoint(
    'q',
    saga.taskId,
    saga.runId,
    saga.claimToken,
    `${SAGA_STARTED_PREFIX}a`,
    '1',
    60,
  )
  const entered = await store.fail('q', saga.runId, saga.claimToken, '{}', null)
  if (!entered.rollingBack) throw new Error('expected the failure to place a rollback pass')
  const sagaTried = { stepKey: 'a', errorJson: '{}' }
  const firstPass = await startedOf(saga.taskId)
  const again = await store.failRollback(
    'q',
    firstPass.runId,
    firstPass.claimToken,
    '{}',
    { delaySeconds: 0 },
    sagaTried,
  )
  if (!again.rollingBack) throw new Error('expected the failed rollback to place another pass')
  const lastPass = await startedOf(saga.taskId)
  await store.failRollback('q', lastPass.runId, lastPass.claimToken, '{}', null, sagaTried)
  await store.retryTask('q', failed.taskId)
  await store.cancelTask('q', failed.taskId)
  // The same label asked to spare a saga, which is its second variant.
  const spared = await store.spawn('q', 'is-spared', '{}')
  await store.cancelTask('q', spared.taskId, { unlessSagaBegan: true })
  // Last, because it moves the clock: a launch that is lost, a worker that dies and whose
  // lease an advisory signal shortens first, and a task never started by its deadline.
  await claimed('launch-is-lost')
  const dies = await started('worker-dies')
  await store.expireLeaseNow('q', dies.runId, dies.claimToken)
  await store.spawn('q', 'never-starts', '{}', { cancellation: { maxDelaySeconds: 30 } })
  await admin.setFakeNowEpochMs(1_000_000 + 120_000)
  await store.sweep('q', 10)
  // Retention (DESIGN.md §3.12), last of all, because it removes what the history made. A
  // window after the sweep, the candidates are read, and of each what the barrier says is
  // read and its unit is purged.
  await admin.setFakeNowEpochMs(1_000_000 + 120_000 + 3_600_000)
  const purges = retention(recorder, testIdSource('shipped-purges'))
  const policy = { completedSeconds: 3_600, cancelledSeconds: 3_600 }
  const listed = await purges.purgeCandidates('q', policy, { limit: 20 })
  let purged = 0
  for (const candidate of listed.candidates) {
    await purges.purgeAdmission('q', candidate, policy)
    if ((await purges.purgeUnit('q', candidate, policy)) !== null) purged += 1
  }
  if (purged === 0) throw new Error('expected the history to purge a unit')
  return seen
}
