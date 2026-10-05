import { RELAUNCH_CAP } from '@durablerun/core'
import { runClaimedRun } from '@durablerun/sdk'
import { type Cause, HUNG_RUN_MS, type Verdict } from '../src/explain.js'
import {
  type CliDb,
  NOW_MS,
  QUEUE,
  REFUSING_CLOCK,
  claimActivated,
  openCliDb,
  seedRefused,
} from './support.js'

/**
 * One seed for every cause of `explain`'s table (exit test line 36). A seed reaches its
 * state through the store's ports alone, under the test clock, as a deployment does, unless
 * its name says it is fixture-built: then raw SQL writes a row no engine path writes, after
 * the ports took the task as far as they go.
 */

/** A test database and its clock, which every database of these tests starts at NOW_MS. */
export interface SeedWorld {
  readonly db: CliDb
  /** Set the database's clock. */
  at(ms: number): Promise<void>
}

export interface ExplainSeed {
  readonly cause: Cause
  readonly verdict: Verdict
  /** What the seed is, as its case is titled. A fixture-built seed says so. */
  readonly name: string
  /** Which of line 36's six healthy controls the seed is, for those that are one. */
  readonly control?: string
  /**
   * The verdict marker of the registered mutation that deletes the cause's arm, or for
   * `unexplained`, of the one that answers a healthy cause when no arm takes the facts. A
   * literal, because the mutation audit reads it from this source.
   */
  readonly marker: string
  /** Build the state and answer the task to explain. */
  build(world: SeedWorld): Promise<string>
}

export function seedWorld(db: CliDb): SeedWorld {
  return { db, at: (ms) => db.admin.setFakeNowEpochMs(ms) }
}

/** Build one seed on a database of its own, of one dialect, and run `body` against it. */
export async function onSeed<T>(
  dialect: CliDb['dialect'],
  seed: ExplainSeed,
  body: (db: CliDb, taskId: string, at: SeedWorld['at']) => Promise<T>,
): Promise<T> {
  const db = await openCliDb(dialect, `explain-${seed.cause}`)
  try {
    const world = seedWorld(db)
    return await body(db, await seed.build(world), world.at)
  } finally {
    await db.close()
  }
}

type SpawnOptions = Parameters<CliDb['store']['spawn']>[3]

/** The claim token of the worker that starts a seed's first run. */
export const SEED_WORKER = 'w-seed'

const spawn = (db: CliDb, name = 'job', options: SpawnOptions = {}) =>
  db.store.spawn(QUEUE, name, '{}', options)

/** A task whose one run a worker claimed and started. Call it when no other run is due. */
async function started(db: CliDb, options: SpawnOptions = {}) {
  const task = await spawn(db, 'job', options)
  const run = await claimActivated(db, SEED_WORKER, task.taskId)
  return { taskId: task.taskId, run }
}

/** A started task parked on an event, `approval` unless another is named, under a timeout or with none. */
export async function parkedOnAnEvent(
  db: CliDb,
  timeoutSeconds: number | null,
  options: SpawnOptions = {},
  event = 'approval',
) {
  const { taskId, run } = await started(db, options)
  const answer = await db.store.awaitEvent(
    QUEUE,
    taskId,
    run.runId,
    run.claimToken,
    'approve',
    event,
    timeoutSeconds,
  )
  if (answer.emitted) throw new Error('the seed found its event emitted already')
  return taskId
}

/** A started task parked by a sleep: the park and the sleep's checkpoint in one transition. */
export async function asleep(db: CliDb, seconds: number, options: SpawnOptions = {}) {
  const { taskId, run } = await started(db, options)
  await db.store.suspendRun(
    QUEUE,
    run.runId,
    run.claimToken,
    { inSeconds: seconds },
    { key: '$sleep:nap', stateJson: 'null' },
  )
  return taskId
}

/**
 * A chain of `length` tasks: each but the last was started, spawned the next as its child,
 * and is parked on that child's completion with no timeout. The last is due and unclaimed.
 */
export async function chainOfAwaits(db: CliDb, length: number): Promise<string[]> {
  let { taskId, run } = await started(db)
  const chain = [taskId]
  while (chain.length < length) {
    const child = await db.store.spawn(QUEUE, 'child', '{}', {
      childOf: {
        parentQueue: QUEUE,
        parentTaskId: taskId,
        runId: run.runId,
        claimToken: run.claimToken,
        replayKey: 'await-child',
      },
    })
    const answer = await db.store.awaitTaskDone(
      QUEUE,
      taskId,
      run.runId,
      run.claimToken,
      'await-child',
      child.taskId,
      null,
    )
    if (answer.emitted) throw new Error('the seed found its child ended already')
    chain.push(child.taskId)
    if (chain.length === length) break
    // The parent is parked, so the child's run is the one that is due.
    taskId = child.taskId
    run = await claimActivated(db, `w-seed-${chain.length}`, taskId)
  }
  return chain
}

/** Fixture SQL: one statement that writes what no engine path writes. */
export const fixture = (db: CliDb, sql: string, args: (string | number)[]) =>
  db.raw.batch('fixture:explain-seed', [{ sql, args }])

export const EXPLAIN_SEEDS: readonly ExplainSeed[] = [
  {
    cause: 'completed',
    verdict: 'ok',
    name: 'a task its worker completed',
    marker: 'mutation-verdict:behavior:cli-explain-arm-completed',
    build: async ({ db }) => {
      const { taskId, run } = await started(db)
      await db.store.complete(QUEUE, run.runId, run.claimToken, '{}')
      return taskId
    },
  },
  {
    cause: 'cancelled',
    verdict: 'ok',
    name: 'a task cancelled before it started',
    marker: 'mutation-verdict:behavior:cli-explain-arm-cancelled',
    build: async ({ db }) => {
      const task = await spawn(db)
      if (!(await db.store.cancelTask(QUEUE, task.taskId))) throw new Error('nothing to cancel')
      return task.taskId
    },
  },
  {
    cause: 'failed-by-an-engine-reason',
    verdict: 'ok',
    name: 'a task the sweep failed at the relaunch cap, after every launch of it was lost',
    marker: 'mutation-verdict:behavior:cli-explain-arm-failed-by-an-engine-reason',
    build: async ({ db, at }) => {
      const task = await spawn(db)
      // Each round claims the run, starts no worker, and lets the lease lapse under a sweep.
      for (let round = 0; round <= RELAUNCH_CAP; round++) {
        const due = await db.store.nextWakeAtEpochMs(QUEUE)
        if (due === null) throw new Error('the seed has no run to claim')
        await at(due)
        const claimed = await db.store.claim(QUEUE, `lost-${round}`, { leaseSeconds: 30, limit: 1 })
        if (claimed.length !== 1) throw new Error(`round ${round} claimed nothing`)
        await at(due + 30_000)
        await db.store.sweep(QUEUE, 10)
      }
      return task.taskId
    },
  },
  {
    cause: 'failed-attempts-exhausted',
    verdict: 'ok',
    name: 'a task whose code failed on the one attempt it had',
    marker: 'mutation-verdict:behavior:cli-explain-arm-failed-attempts-exhausted',
    build: async ({ db }) => {
      const { taskId, run } = await started(db, { maxAttempts: 1 })
      await db.store.fail(QUEUE, run.runId, run.claimToken, '{"name":"Error"}', null)
      return taskId
    },
  },
  {
    cause: 'failed-with-no-retry',
    verdict: 'ok',
    name: 'a task whose worker failed it for good on the first of three attempts',
    marker: 'mutation-verdict:behavior:cli-explain-arm-failed-with-no-retry',
    build: async ({ db }) => {
      const { taskId, run } = await started(db, { maxAttempts: 3 })
      await db.store.fail(QUEUE, run.runId, run.claimToken, '{"name":"Error"}', null)
      return taskId
    },
  },
  {
    cause: 'cancellation-deadline-passed',
    verdict: 'waiting',
    name: 'a task at its start deadline, which no sweep has cancelled',
    marker: 'mutation-verdict:behavior:cli-explain-arm-cancellation-deadline-passed',
    build: async ({ db, at }) => {
      const task = await spawn(db, 'job', {
        startDelaySeconds: 3600,
        cancellation: { maxDelaySeconds: 60 },
      })
      await at(NOW_MS + 3_660_000)
      return task.taskId
    },
  },
  {
    cause: 'lease-lapsed-unswept',
    verdict: 'waiting',
    name: 'a started run at the end of its lease, which no sweep has taken back',
    marker: 'mutation-verdict:behavior:cli-explain-arm-lease-lapsed-unswept',
    build: async ({ db, at }) => {
      const { taskId } = await started(db)
      await at(NOW_MS + 60_000)
      return taskId
    },
  },
  {
    cause: 'running-past-the-hung-bound',
    verdict: 'ok',
    name: 'a run its worker has kept alive for a millisecond more than the hung-run bound',
    marker: 'mutation-verdict:behavior:cli-explain-arm-running-past-the-hung-bound',
    build: async ({ db, at }) => {
      const { taskId, run } = await started(db)
      await at(NOW_MS + HUNG_RUN_MS - 1_000)
      if (!(await db.store.heartbeat(QUEUE, run.runId, run.claimToken, 60)).held) {
        throw new Error('the seed lost its lease')
      }
      await at(NOW_MS + HUNG_RUN_MS + 1)
      return taskId
    },
  },
  {
    cause: 'running-under-a-live-lease',
    verdict: 'ok',
    name: 'a run under a lease its worker extended',
    control: 'a live lease',
    marker: 'mutation-verdict:behavior:cli-explain-arm-running-under-a-live-lease',
    build: async ({ db, at }) => {
      const { taskId, run } = await started(db)
      await at(NOW_MS + 5_000)
      if (!(await db.store.heartbeat(QUEUE, run.runId, run.claimToken, 30)).held) {
        throw new Error('the seed lost its lease')
      }
      return taskId
    },
  },
  {
    cause: 'pending-delayed',
    verdict: 'waiting',
    name: 'a task enqueued with a start an hour off',
    control: 'a start delay',
    marker: 'mutation-verdict:behavior:cli-explain-arm-pending-delayed',
    build: async ({ db }) => (await spawn(db, 'job', { startDelaySeconds: 3600 })).taskId,
  },
  {
    cause: 'woken-unclaimed',
    verdict: 'waiting',
    name: 'a run an emitted event woke, which no claim has taken',
    marker: 'mutation-verdict:behavior:cli-explain-arm-woken-unclaimed',
    build: async ({ db, at }) => {
      const taskId = await parkedOnAnEvent(db, null)
      await at(NOW_MS + 2_000)
      await db.store.emitEvent(QUEUE, 'approval', '{}')
      return taskId
    },
  },
  {
    cause: 'pending-due-unclaimed',
    verdict: 'waiting',
    name: 'a task enqueued a moment ago, which no claim has taken',
    marker: 'mutation-verdict:behavior:cli-explain-arm-pending-due-unclaimed',
    build: async ({ db }) => (await spawn(db)).taskId,
  },
  {
    cause: 'backing-off',
    verdict: 'waiting',
    name: 'a run its worker failed with attempts left, whose next attempt sleeps until the retry delay has run',
    marker: 'mutation-verdict:behavior:cli-explain-arm-backing-off',
    build: async ({ db }) => {
      const { taskId, run } = await started(db, { maxAttempts: 3 })
      await db.store.fail(QUEUE, run.runId, run.claimToken, '{"name":"Error"}', {
        delaySeconds: 30,
      })
      return taskId
    },
  },
  {
    cause: 'never-started',
    verdict: 'waiting',
    name: 'a task enqueued ahead of the build that registers it, which a real worker with no handler for it deferred',
    control: 'a task enqueued ahead of the build that registers it',
    marker: 'mutation-verdict:behavior:cli-explain-arm-never-started',
    build: async ({ db }) => {
      const task = await spawn(db, 'registered-by-the-next-build')
      const [run] = await db.store.claim(QUEUE, 'old-build', { leaseSeconds: 60, limit: 1 })
      if (run?.taskId !== task.taskId) throw new Error('the old build claimed nothing')
      const outcome = await runClaimedRun(
        { store: db.store, clock: REFUSING_CLOCK, registry: new Map() },
        { queue: QUEUE, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
      )
      if (outcome.kind !== 'deferred') throw new Error(`the worker answered ${outcome.kind}`)
      return task.taskId
    },
  },
  {
    cause: 'wait-outlives-its-event',
    verdict: 'inconsistent',
    name: 'a run parked on an event whose row is then planted, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-wait-outlives-its-event',
    build: async ({ db }) => {
      const taskId = await parkedOnAnEvent(db, null)
      // Fixture-built: an emit wakes every run that waits on its event in the same batch.
      await fixture(
        db,
        'INSERT INTO events (queue, event_name, payload, emitted_at_ms) VALUES (?, ?, ?, ?)',
        [QUEUE, 'approval', '{}', NOW_MS],
      )
      return taskId
    },
  },
  {
    cause: 'never-started-alpha1-form',
    verdict: 'waiting',
    name: 'a run started and then rescheduled 15 seconds on with no checkpoint, the two port calls the alpha.1 worker makes for a task name it has no handler for',
    marker: 'mutation-verdict:behavior:cli-explain-arm-never-started-alpha1-form',
    build: async ({ db }) => {
      const { taskId, run } = await started(db)
      await db.store.reschedule(QUEUE, run.runId, run.claimToken, { inSeconds: 15 })
      return taskId
    },
  },
  {
    cause: 'sleeping-past-its-wake',
    verdict: 'waiting',
    name: 'a sleeping run at its wake, which no claim has taken',
    marker: 'mutation-verdict:behavior:cli-explain-arm-sleeping-past-its-wake',
    build: async ({ db, at }) => {
      const taskId = await asleep(db, 120)
      await at(NOW_MS + 120_000)
      return taskId
    },
  },
  {
    cause: 'awaiting-a-child',
    verdict: 'waiting',
    name: 'a parent parked on a child that is due and unclaimed',
    marker: 'mutation-verdict:behavior:cli-explain-arm-awaiting-a-child',
    build: async ({ db }) => (await chainOfAwaits(db, 2))[0] ?? '',
  },
  {
    cause: 'awaiting-a-timed-event',
    verdict: 'waiting',
    name: 'a run parked on an event inside its timeout',
    control: 'a timed await inside its timeout',
    marker: 'mutation-verdict:behavior:cli-explain-arm-awaiting-a-timed-event',
    build: async ({ db }) => parkedOnAnEvent(db, 300),
  },
  {
    cause: 'awaiting-an-untimed-event',
    verdict: 'waiting',
    name: 'a run parked on an event with no timeout',
    control: 'an untimed await',
    marker: 'mutation-verdict:behavior:cli-explain-arm-awaiting-an-untimed-event',
    build: async ({ db }) => parkedOnAnEvent(db, null),
  },
  {
    cause: 'sleeping-on-a-timer',
    verdict: 'waiting',
    name: 'a run its code put to sleep for two minutes',
    control: 'a sleep',
    marker: 'mutation-verdict:behavior:cli-explain-arm-sleeping-on-a-timer',
    build: async ({ db }) => asleep(db, 120),
  },
  {
    cause: 'unreadable',
    verdict: 'inconsistent',
    name: 'a completed task whose payload is then set to NULL, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-unreadable',
    build: ({ db }) => seedRefused(db),
  },
  {
    cause: 'terminal-task-with-a-live-run',
    verdict: 'inconsistent',
    name: 'a completed task whose run is then set back to pending, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-terminal-task-with-a-live-run',
    build: async ({ db }) => {
      const { taskId, run } = await started(db)
      await db.store.complete(QUEUE, run.runId, run.claimToken, '{}')
      await fixture(db, "UPDATE runs SET state = 'pending' WHERE task_id = ?", [taskId])
      return taskId
    },
  },
  {
    cause: 'live-task-without-one-live-run',
    verdict: 'inconsistent',
    name: 'a pending task whose one run is then set to cancelled, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-live-task-without-one-live-run',
    build: async ({ db }) => {
      const task = await spawn(db)
      await fixture(db, "UPDATE runs SET state = 'cancelled' WHERE task_id = ?", [task.taskId])
      return task.taskId
    },
  },
  {
    cause: 'task-and-run-states-differ',
    verdict: 'inconsistent',
    name: 'a pending run whose task is then set to sleeping, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-task-and-run-states-differ',
    build: async ({ db }) => {
      const task = await spawn(db)
      await fixture(db, "UPDATE tasks SET state = 'sleeping' WHERE task_id = ?", [task.taskId])
      return task.taskId
    },
  },
  {
    cause: 'deadline-no-sweep-cancels',
    verdict: 'inconsistent',
    name: "a task past its start deadline whose run is then moved to another queue, so the sweep's scan does not answer the task, fixture-built",
    marker: 'mutation-verdict:behavior:cli-explain-arm-deadline-no-sweep-cancels',
    build: async ({ db, at }) => {
      const task = await spawn(db, 'job', { cancellation: { maxDelaySeconds: 30 } })
      await fixture(db, "UPDATE runs SET queue = 'elsewhere' WHERE task_id = ?", [task.taskId])
      await at(NOW_MS + 60_000)
      return task.taskId
    },
  },
  {
    cause: 'lapsed-lease-no-sweep-reclaims',
    verdict: 'inconsistent',
    name: "a started run at the end of its lease whose activation generation is then set past its claim generation, so the sweep's scan does not answer the run, fixture-built",
    marker: 'mutation-verdict:behavior:cli-explain-arm-lapsed-lease-no-sweep-reclaims',
    build: async ({ db, at }) => {
      const { taskId, run } = await started(db)
      await fixture(db, 'UPDATE runs SET activated_gen = claim_gen + 5 WHERE run_id = ?', [
        run.runId,
      ])
      await at(NOW_MS + 60_000)
      return taskId
    },
  },
  {
    cause: 'due-run-no-claim-admits',
    verdict: 'inconsistent',
    name: 'a due run whose task is then given a retry strategy that is not JSON, so no claim admits the run, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-arm-due-run-no-claim-admits',
    build: async ({ db }) => {
      const task = await spawn(db)
      await fixture(db, "UPDATE tasks SET retry_strategy = 'not json' WHERE task_id = ?", [
        task.taskId,
      ])
      return task.taskId
    },
  },
  {
    cause: 'unexplained',
    verdict: 'unexplained',
    name: 'a sleeping run whose wake instant is then set to NULL with no event to wait on, fixture-built',
    marker: 'mutation-verdict:behavior:cli-explain-answers-unexplained-by-default',
    build: async ({ db }) => {
      const taskId = await asleep(db, 120)
      await fixture(db, 'UPDATE runs SET available_at_ms = NULL WHERE task_id = ?', [taskId])
      return taskId
    },
  },
]
