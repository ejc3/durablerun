import {
  FencedBatch,
  type HeldOperatorReads,
  READS_SEED,
  type SqlExecutor,
  createOperatorReads,
  sqlFragment,
} from '@durablerun/core'
import { rollbackError, rollbackOutcome, runOwnedByTask, sagaBegan } from './fragments.js'
import {
  CLAIM_OWED_PENDING,
  CLAIM_OWED_SLEEPING,
  COUNTED_DEADLINES,
  COUNTED_PENDING_RUNS,
  COUNTED_RUNNING_RUNS,
  COUNTED_SLEEPING_RUNS,
  DEADLINES_PASSED,
  DUE_PENDING,
  DUE_SLEEPING,
  LEASES_LAPSED,
  LIVE_TASKS_BY_AGE,
  RETRY_ADMITS,
  STORED_PAYLOAD_TYPE,
  SWEEP_CANCELS_DUE,
  SWEEP_CLAIMS_EXPIRED,
  SWEEP_LIVE_RUN_OF_TASK,
} from './store.js'
import { FAKE_CLOCK_READ_SQL, NOW_MS } from './time.js'
import { TREE_DIALECT } from './tree.js'

/**
 * What this dialect supplies to core's operator reads: its batches, each labelled here and
 * run here, its read of the test clock, and its fragments. The reads themselves are core's
 * (`createOperatorReads`). It is a class with the executor as `this.db` because that is
 * where the batch checkers read a store's batches: sent as `this.db.batch(...)`, or run as
 * `batch.run(this.db)`, inside a member of a class.
 */
class MysqlOperatorReads {
  constructor(private readonly db: SqlExecutor) {}

  reads(): HeldOperatorReads {
    return createOperatorReads({
      run: (batch: FencedBatch) => batch.run(this.db),
      open: {
        taskFacts: () =>
          new FencedBatch('task-facts', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        taskIdByKey: () =>
          new FencedBatch('task-id-by-key', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        eventState: () =>
          new FencedBatch('event-state', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        stuckRuns: () =>
          new FencedBatch('stuck-runs', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        queueStatus: () =>
          new FencedBatch('queue-status', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        tableRows: () =>
          new FencedBatch('table-rows', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        eventWaiters: () =>
          new FencedBatch('event-waiters', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        agedTasks: () =>
          new FencedBatch('aged-tasks', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        eventPayload: () =>
          new FencedBatch('event-payload', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        taskAdmission: () =>
          new FencedBatch('task-admission', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
      },
      fakeClock: async () => {
        const [flag] = await this.db.batch(
          'fake-clock',
          [{ sql: FAKE_CLOCK_READ_SQL, args: [] }],
          'read',
        )
        return flag?.rows[0]?.fake_clock
      },
      sagaBegan: sqlFragment(sagaBegan('tasks')),
      rollbackOutcome: sqlFragment(rollbackOutcome('tasks')),
      rollbackError: sqlFragment(rollbackError('tasks')),
      taskOwnsRun: sqlFragment(runOwnedByTask('r', 't')),
      liveRunOfTask: sqlFragment(SWEEP_LIVE_RUN_OF_TASK),
      storedPayloadType: sqlFragment(STORED_PAYLOAD_TYPE),
      // The conjuncts this store's `retryTask` holds, which `task-admission` selects as flags.
      retryConjuncts: RETRY_ADMITS,
      // What the claim and the sweep of this store would take now, by their own predicates.
      owed: {
        pendingRuns: (queue) => sqlFragment(CLAIM_OWED_PENDING, [queue]),
        sleepingRuns: (queue) => sqlFragment(CLAIM_OWED_SLEEPING, [queue]),
        expiredClaims: (queue) => sqlFragment(SWEEP_CLAIMS_EXPIRED, [queue]),
        dueCancels: (queue) => sqlFragment(SWEEP_CANCELS_DUE, [queue]),
      },
      // The same rows by their instant alone, before anything the claim or the sweep requires.
      overdue: {
        pendingRuns: (queue) => sqlFragment(DUE_PENDING, [queue]),
        sleepingRuns: (queue) => sqlFragment(DUE_SLEEPING, [queue]),
        lapsedLeases: (queue) => sqlFragment(LEASES_LAPSED, [queue]),
        passedDeadlines: (queue) => DEADLINES_PASSED.map((leg) => sqlFragment(leg, [queue])),
      },
      counted: {
        pendingRuns: (queue) => sqlFragment(COUNTED_PENDING_RUNS, [queue]),
        sleepingRuns: (queue) => sqlFragment(COUNTED_SLEEPING_RUNS, [queue]),
        runningRuns: (queue) => sqlFragment(COUNTED_RUNNING_RUNS, [queue]),
        tasksWithADeadline: (queue) => COUNTED_DEADLINES.map((leg) => sqlFragment(leg, [queue])),
        liveTasks: (queue) => LIVE_TASKS_BY_AGE.map((leg) => sqlFragment(leg, [queue])),
      },
    })
  }
}

/**
 * The operator's read port (`OperatorReads`) over an executor of this store. It is apart
 * from the scheduler store: no engine actor calls it, and it sends only batches of reads.
 */
export function operatorReads(db: SqlExecutor): HeldOperatorReads {
  return new MysqlOperatorReads(db).reads()
}
