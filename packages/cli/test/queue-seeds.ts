import { runClaimedRun } from '@durablerun/sdk'
import { type CliDb, NOW_MS, QUEUE, REFUSING_CLOCK, claimActivated } from './support.js'

/**
 * Seeds for the reads of a queue (exit test line 37). Each reaches its state through the
 * store's ports alone, under the test clock, as a deployment does.
 */

/** What `owedQueue` leaves, each by the id its leg lists it under. */
export interface OwedQueue {
  /** The run of a task that is due from the seed's start, which no claim takes. */
  readonly due: string
  /** The run of a task its code put to sleep for 30 seconds. */
  readonly sleeper: string
  /** The run a worker started under a lease of 60 seconds and never touched again. */
  readonly abandoned: string
  /** The task that must start within 45 seconds, which no claim takes. */
  readonly doomed: string
  /** That task's run, which is due from the seed's start and which no claim admits once the 45 seconds have passed. */
  readonly doomedRun: string
}

/** The instant the abandoned run's lease expires, by which every move of `owedQueue` is owed. */
export const OWED_AT_MS = NOW_MS + 60_000

/** The one run of a task, read from its row: no port answers a run by its task. */
export async function runOf(db: CliDb, taskId: string): Promise<string> {
  const [read] = await db.raw.batch(
    'fixture:run-of-a-task',
    [{ sql: 'SELECT run_id FROM runs WHERE task_id = ?', args: [taskId] }],
    'read',
  )
  const [row, ...more] = read?.rows ?? []
  if (row === undefined || more.length > 0) throw new Error(`task ${taskId} has not one run`)
  return String(row.run_id)
}

/**
 * A queue with one move of each kind the driver comes to owe: a run that is due, a run
 * past its wake, a run under a lapsed lease, and a task past its cancellation deadline.
 * Call it on a database at NOW_MS. At OWED_AT_MS every one of the four is owed.
 */
export async function owedQueue(db: CliDb): Promise<OwedQueue> {
  const { store } = db
  const napping = await store.spawn(QUEUE, 'nap', '{}')
  const sleeper = await claimActivated(db, 'w-sleeper', napping.taskId)
  await store.suspendRun(
    QUEUE,
    sleeper.runId,
    sleeper.claimToken,
    { inSeconds: 30 },
    { key: '$sleep:nap', stateJson: 'null' },
  )
  const left = await store.spawn(QUEUE, 'left', '{}')
  const abandoned = await claimActivated(db, 'w-gone', left.taskId)
  const doomed = await store.spawn(QUEUE, 'doomed', '{}', {
    cancellation: { maxDelaySeconds: 45 },
  })
  const due = await store.spawn(QUEUE, 'due', '{}')
  return {
    due: await runOf(db, due.taskId),
    sleeper: sleeper.runId,
    abandoned: abandoned.runId,
    doomed: doomed.taskId,
    doomedRun: await runOf(db, doomed.taskId),
  }
}

/** The two workers that park a run they have no handler for, each in its own way. */
export const DEFERRAL_FORMS = ['current', 'alpha.1'] as const
export type DeferralForm = (typeof DEFERRAL_FORMS)[number]

/**
 * One tick of a driver over a task no deployed build has a handler for: a claim takes the
 * task's run, and the worker parks it again. The current worker reads the task's name
 * before it starts the run and parks it with `deferLaunch`, and this runs that worker with
 * an empty registry. The release alpha.1 starts the run first and parks it with
 * `reschedule`, 15 to 24 seconds on, and this makes the same two port calls. It answers
 * the run that was parked.
 */
export async function deferralTick(
  db: CliDb,
  form: DeferralForm,
  taskId: string,
  tick: number,
): Promise<string> {
  const [run] = await db.store.claim(QUEUE, `tick-${tick}`, { leaseSeconds: 60, limit: 1 })
  if (run?.taskId !== taskId) throw new Error(`tick ${tick} did not claim the deferred task`)
  if (form === 'current') {
    const outcome = await runClaimedRun(
      { store: db.store, clock: REFUSING_CLOCK, registry: new Map() },
      { queue: QUEUE, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
    )
    if (outcome.kind !== 'deferred') throw new Error(`the worker answered ${outcome.kind}`)
  } else {
    const live = await db.store.activate(QUEUE, run.runId, run.claimToken, run.claimGen)
    if (live === null) throw new Error(`tick ${tick} could not start the run`)
    await db.store.reschedule(QUEUE, run.runId, run.claimToken, { inSeconds: 15 + (tick % 10) })
  }
  return run.runId
}

/** What `owedToASweep` leaves, each by the ids the sweep's transition names. */
export interface OwedToASweep {
  /** The launch that is lost: claimed, and never started. */
  readonly lost: { readonly taskId: string; readonly runId: string }
  /** The started run whose worker is gone, under a lease of 60 seconds. */
  readonly left: { readonly taskId: string; readonly runId: string }
  /** The task that must start within 45 seconds, which no claim takes. */
  readonly doomed: { readonly taskId: string; readonly runId: string }
}

/**
 * One of each transition a sweep makes: a launch lost, a lease lapsed and a deadline
 * passed. Call it on a database at NOW_MS whose queue holds no other run that is due. It
 * leaves the clock 61 seconds on, where all three are owed.
 */
export async function owedToASweep(db: CliDb): Promise<OwedToASweep> {
  const lost = await db.store.spawn(QUEUE, 'lost', '{}')
  const [claimed] = await db.store.claim(QUEUE, 'w-lost', { leaseSeconds: 60, limit: 1 })
  if (claimed?.taskId !== lost.taskId) throw new Error('the lost launch was not claimed')
  const left = await db.store.spawn(QUEUE, 'left', '{}')
  const gone = await claimActivated(db, 'w-gone', left.taskId)
  const doomed = await db.store.spawn(QUEUE, 'doomed', '{}', {
    cancellation: { maxDelaySeconds: 45 },
  })
  await db.admin.setFakeNowEpochMs(NOW_MS + 61_000)
  return {
    lost: { taskId: lost.taskId, runId: claimed.runId },
    left: { taskId: left.taskId, runId: gone.runId },
    doomed: { taskId: doomed.taskId, runId: await runOf(db, doomed.taskId) },
  }
}
