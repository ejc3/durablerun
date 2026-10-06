import { isDeepStrictEqual } from 'node:util'
import {
  INFRA_RETRY_CAP,
  MAX_COUNT,
  OPERATOR_LIST_CAP,
  RETRY_GUARD,
  type RetryGuardConjunct,
  SAGA_STARTED_PREFIX,
  type SchedulerStore,
  type SqlExecutor,
  type TaskAdmission,
  taskDoneEventName,
} from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from './fixture.js'
import { runFuzzScenario } from './fuzz.js'
import { Q, START, spawn, worldOf } from './operator-reads.js'
import { snapshot } from './poison-matrix.js'
import { CAUSE } from './sagas.js'
import {
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  infraRetrySeed,
  spawnedRun,
} from './scenario.js'

/**
 * The two reads a drive verb asks before it names a refusal (`OperatorReads`, DESIGN.md
 * §3.11), on one dialect: what the engine's own guards say of one task, and one event's
 * stored payload. Core holds the one implementation. What is held here is what a dialect
 * decides: whether each flag it answers is what its engine then does.
 *
 * Each flag of `taskAdmission` is a predicate the engine's own statement holds, so each is
 * held against the engine and not against a second account of the predicate. A conjunct
 * of the retry guard is false for a task planted to break that conjunct and no other, and
 * `retryTask` then refuses the task and writes nothing. Over the states a fuzz walk of the
 * engine leaves, every conjunct holds of a task exactly when `retryTask` revives it, a
 * claim's flag is true of exactly the runs the finder lists as a claim's, and the sweep's
 * flags of exactly the rows it lists as the sweep's, with a floor on what the walks reach.
 */

/**
 * Where a state is planted: a store's port and the executor under it, in the queue `Q`.
 * A conformance fixture is one, and so is the test database of another package, which
 * plants the same states to hold what its own layer says of them.
 */
export interface Planting {
  readonly store: SchedulerStore
  readonly raw: SqlExecutor
}

/** A task that failed for good after `attempts` started attempts, each but the last retried at once. */
async function failedTask(db: Planting, maxAttempts = 1, attempts = maxAttempts) {
  const task = await spawnedRun(db.store, Q, 'job', { maxAttempts })
  const runs: string[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const run = await claimActivated(db.store, Q, `w-${attempt}`)
    if (run.taskId !== task.taskId) throw new Error('the claim took another task')
    runs.push(run.runId)
    await db.store.fail(
      Q,
      run.runId,
      run.claimToken,
      '{"name":"Boom"}',
      attempt < attempts ? { delaySeconds: 0 } : null,
    )
  }
  const firstRunId = runs[0]
  const lastRunId = runs[runs.length - 1]
  if (firstRunId === undefined || lastRunId === undefined) throw new Error('no attempt ran')
  return { taskId: task.taskId, firstRunId, lastRunId }
}

/** Fixture SQL: statements that write what no engine path writes. */
const planted = (db: Planting, statements: { sql: string; args: (string | number)[] }[]) =>
  db.raw.batch('fixture:admission', statements)

/** The conjuncts of the guard that an answer says are false, in the guard's order. */
const falseOf = (admission: TaskAdmission | null): RetryGuardConjunct[] =>
  admission === null ? [] : RETRY_GUARD.filter((name) => admission.retry[name] === false)

/**
 * Plant a task that failed for good, then write to it what no engine path writes, and
 * answer the task. `budget` is the attempts the task is given, one when none is.
 */
const failedThen =
  (
    statements: (task: Awaited<ReturnType<typeof failedTask>>) => Parameters<typeof planted>[1],
    ...budget: [attempts?: number]
  ) =>
  async (db: Planting): Promise<string> => {
    const task = await failedTask(db, ...budget)
    await planted(db, statements(task))
    return task.taskId
  }

export interface RetryRefusalState {
  /** What the task is, as its case is titled. A state no engine path reaches says it is fixture-built. */
  readonly what: string
  /**
   * Every conjunct the state leaves false: the one the case is for, and any that cannot
   * hold without it. Written out from what the plant did, never read back.
   */
  readonly leavesFalse: readonly RetryGuardConjunct[]
  /** Plant the state, with nothing else due in the queue, and answer its task. */
  build(db: Planting): Promise<string>
}

/**
 * One state for every conjunct of the retry guard, in which that conjunct is false. The
 * record is keyed by core's list, so a conjunct the guard gains stops the build until a
 * state is written for it. Each state passes every other conjunct where one can: a task
 * with no run has no top ordinal, so its charge is no number and neither comparison of
 * the charge holds.
 */
export const RETRY_REFUSALS: Readonly<Record<RetryGuardConjunct, RetryRefusalState>> = {
  failed: {
    what: 'a task cancelled before it started',
    leavesFalse: ['failed'],
    build: async (f) => {
      const task = await spawnedRun(f.store, Q, 'job')
      if (!(await f.store.cancelTask(Q, task.taskId))) throw new Error('nothing was cancelled')
      return task.taskId
    },
  },
  ownsEveryRun: {
    what: 'a task that failed twice, whose first run is then moved to another queue, fixture-built',
    leavesFalse: ['ownsEveryRun'],
    build: failedThen(
      (task) => [
        {
          sql: "UPDATE runs SET queue = 'another-queue' WHERE run_id = ?",
          args: [task.firstRunId],
        },
      ],
      2,
    ),
  },
  hasAFailureReason: {
    what: 'a failed task whose reason is then set to NULL, fixture-built',
    leavesFalse: ['hasAFailureReason'],
    build: failedThen((task) => [
      { sql: 'UPDATE tasks SET failure_reason = NULL WHERE task_id = ?', args: [task.taskId] },
    ]),
  },
  hasNoCompletedPayload: {
    what: 'a failed task that is then given a completed payload, fixture-built',
    leavesFalse: ['hasNoCompletedPayload'],
    build: failedThen((task) => [
      {
        sql: `UPDATE tasks SET completed_payload = '{"forged":true}' WHERE task_id = ?`,
        args: [task.taskId],
      },
    ]),
  },
  hasARun: {
    what: 'a failed task whose runs are then deleted, fixture-built',
    leavesFalse: ['hasARun', 'chargeIsTheAttemptsOrOneMore', 'chargeWithinBudget'],
    build: failedThen((task) => [
      { sql: 'DELETE FROM runs WHERE task_id = ?', args: [task.taskId] },
    ]),
  },
  hasNoLiveRun: {
    what: 'a failed task whose run is then set back to pending, fixture-built',
    leavesFalse: ['hasNoLiveRun'],
    build: failedThen((task) => [
      { sql: "UPDATE runs SET state = 'pending' WHERE run_id = ?", args: [task.lastRunId] },
    ]),
  },
  attemptsInRange: {
    what: 'a failed task whose attempts are then set below zero, fixture-built',
    leavesFalse: ['attemptsInRange'],
    // Two infrastructure retries keep the charge equal to the attempts, so the counter's
    // bounds are the one thing that refuses.
    build: failedThen((task) => [
      {
        sql: 'UPDATE tasks SET attempts = -1, infra_retries = 2 WHERE task_id = ?',
        args: [task.taskId],
      },
    ]),
  },
  infraRetriesInRange: {
    what: 'a failed task set one infrastructure retry past the cap, with its run at the matching ordinal, fixture-built',
    leavesFalse: ['infraRetriesInRange'],
    build: failedThen((task) => infraRetrySeed(task.taskId, task.firstRunId, INFRA_RETRY_CAP + 1)),
  },
  everyRunOrdinalInRange: {
    what: 'a task that failed twice, whose first run is then set to ordinal zero, fixture-built',
    leavesFalse: ['everyRunOrdinalInRange'],
    build: failedThen(
      (task) => [{ sql: 'UPDATE runs SET attempt = 0 WHERE run_id = ?', args: [task.firstRunId] }],
      2,
    ),
  },
  budgetTakesOneMore: {
    what: 'a task spawned with the largest budget the store holds, failed for good on its first attempt',
    leavesFalse: ['budgetTakesOneMore'],
    build: async (f) => (await failedTask(f, MAX_COUNT, 1)).taskId,
  },
  chargeIsTheAttemptsOrOneMore: {
    what: 'a failed task then given three infrastructure retries its runs do not show, fixture-built',
    leavesFalse: ['chargeIsTheAttemptsOrOneMore'],
    build: failedThen((task) => [
      { sql: 'UPDATE tasks SET infra_retries = 3 WHERE task_id = ?', args: [task.taskId] },
    ]),
  },
  sagaNotBegun: {
    what: 'a task whose saga began and whose rollback pass then ended it',
    leavesFalse: ['sagaNotBegun'],
    build: async (f) => {
      const task = await spawnedRun(f.store, Q, 'saga', { maxAttempts: 1 })
      const forward = await claimActivated(f.store, Q, 'w-forward')
      // A registered step starts: its marker commits, carrying its index.
      await checkpointOwned(f.store, Q, forward, `${SAGA_STARTED_PREFIX}a`, '1', 60)
      const entered = await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
      if (!entered.rollingBack) throw new Error('the failure placed no rollback pass')
      const pass = await claimActivated(f.store, Q, 'w-pass')
      await f.store.fail(Q, pass.runId, pass.claimToken, CAUSE, null)
      return task.taskId
    },
  },
  chargeWithinBudget: {
    what: 'a task that failed on its one attempt, whose run is then set to ordinal two, fixture-built',
    leavesFalse: ['chargeWithinBudget'],
    build: failedThen((task) => [
      { sql: 'UPDATE runs SET attempt = 2 WHERE run_id = ?', args: [task.firstRunId] },
    ]),
  },
}

/**
 * What a revival would change of a task, read without the task's counters: its state, the
 * stamp of the batch that last wrote it, and how many runs name it. A snapshot of every
 * table selects the counters, and one driver refuses to hand over an integer a number
 * cannot hold, so the planted row is read around.
 */
async function untouched(raw: SqlExecutor, taskId: string) {
  const [task, runs] = await raw.batch(
    'fixture:admission-untouched',
    [
      { sql: 'SELECT state, fence_stamp FROM tasks WHERE task_id = ?', args: [taskId] },
      { sql: 'SELECT COUNT(*) AS runs FROM runs WHERE task_id = ?', args: [taskId] },
    ],
    'read',
  )
  return {
    task: task?.rows.map((row) => [String(row.state), String(row.fence_stamp)]),
    runs: runs?.rows.map((row) => Number(row.runs)),
  }
}

/**
 * The least and the greatest integer a 64-bit column holds, as text, because a number
 * holds neither. Every dialect stores a counter in such a column.
 */
const INT64 = { least: '-9223372036854775808', greatest: '9223372036854775807' } as const

/** A counter the retry guard reads, with the statement that plants a value in it for a failed task. */
const COUNTERS = {
  attempts: {
    plant: (task: Awaited<ReturnType<typeof failedTask>>, value: string) => ({
      sql: 'UPDATE tasks SET attempts = ? WHERE task_id = ?',
      args: [value, task.taskId],
    }),
    // The charge is compared with the attempts, so that conjunct is not asked.
    leavesFalse: { least: ['attemptsInRange'], greatest: ['attemptsInRange'] },
  },
  'infrastructure retries': {
    plant: (task: Awaited<ReturnType<typeof failedTask>>, value: string) => ({
      sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
      args: [value, task.taskId],
    }),
    // The charge is the top ordinal less these, so neither conjunct of the charge is asked.
    leavesFalse: { least: ['infraRetriesInRange'], greatest: ['infraRetriesInRange'] },
  },
  'attempt budget': {
    plant: (task: Awaited<ReturnType<typeof failedTask>>, value: string) => ({
      sql: 'UPDATE tasks SET max_attempts = ? WHERE task_id = ?',
      args: [value, task.taskId],
    }),
    // The charge of one attempt is within the greatest budget and past the least.
    leavesFalse: {
      least: ['budgetTakesOneMore', 'chargeWithinBudget'],
      greatest: ['budgetTakesOneMore'],
    },
  },
  'ordinal of its one run': {
    plant: (task: Awaited<ReturnType<typeof failedTask>>, value: string) => ({
      sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
      args: [value, task.firstRunId],
    }),
    // The charge is the top ordinal less the retries, so neither conjunct of the charge is asked.
    leavesFalse: { least: ['everyRunOrdinalInRange'], greatest: ['everyRunOrdinalInRange'] },
  },
} as const satisfies Record<
  string,
  {
    plant(
      task: Awaited<ReturnType<typeof failedTask>>,
      value: string,
    ): { sql: string; args: (string | number)[] }
    leavesFalse: Record<keyof typeof INT64, readonly RetryGuardConjunct[]>
  }
>

/**
 * A failed task with one counter at the least or the greatest value its column holds, which
 * no engine path writes. The guard refuses each for the counter's range. A conjunct that
 * computes with a counter is asked only where that counter is in range: at these values
 * the subtraction overflows the column's type, which one dialect answers with an error
 * and another with a value that is no integer. Each state is fixture-built.
 */
export const RETRY_COUNTER_EXTREMES: readonly RetryRefusalState[] = (
  Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]
).flatMap((counter) =>
  (Object.keys(INT64) as (keyof typeof INT64)[]).map((end) => ({
    what: `a failed task whose ${counter} is then set to the ${end} 64-bit integer, fixture-built`,
    leavesFalse: COUNTERS[counter].leavesFalse[end],
    build: failedThen((task) => [COUNTERS[counter].plant(task, INT64[end])]),
  })),
)

/** The instant the seeded queue is read at: every lease of it has lapsed and both deadlines have passed. */
const LATER = START + 70_000

/** What the read answers of a task beside the retry guard, which its own cases hold. */
const besideTheGuard = (admission: TaskAdmission | null) => {
  if (admission === null) return null
  const { retry: _retry, ...rest } = admission
  return rest
}

const sorted = (ids: Iterable<string>): string[] => [...ids].sort()

/** The walks: these seeds, each this many steps, each read at these instants. A failing seed replays exactly. */
const WALKS = Array.from({ length: 12 }, (_, seed) => `admission-${seed}`)
const WALK_STEPS = 100
const ROUNDS_AHEAD_MS = [0, 31_000, 62_000, 300_000]

interface Reached {
  /** Runs a claim's flag was true of, over every reading. */
  claimTakes: number
  /** Runs the sweep's reclaim flag was true of. */
  sweepReclaims: number
  /** Tasks the sweep's cancel flag was true of. */
  sweepCancels: number
  /** Tasks every conjunct held of, which the revival then took. */
  revived: number
  /** Failed tasks a conjunct refused. */
  failedAndRefused: number
  /** Tasks that were not failed, which the guard refuses for that. */
  notFailed: number
}

/**
 * What the walks must reach between them, so that walks that leave nothing to admit fail.
 * Measured when the case was written, the same on every dialect because the walks are:
 * over the readings a claim's flag was true of 74 runs, the sweep's of 96 runs and of 18
 * tasks, and at the end of the walks 8 tasks were revived, 10 failed tasks were refused,
 * each the task of a saga, and 155 tasks were refused for not being failed. Each floor
 * sits below that, so a change to the walk that moves a seed does not fail the case for a
 * row or two, and a walk that stops reaching a kind of row does.
 */
const FLOORS: Reached = {
  claimTakes: 50,
  sweepReclaims: 65,
  sweepCancels: 12,
  revived: 5,
  failedAndRefused: 6,
  notFailed: 100,
}

export function operatorAdmissionConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`operator reads of what the engine admits [${dialect}]`, () => {
    const inWorld = worldOf(makeFixture)

    it('says every conjunct of the retry guard holds of a task that failed for good, and the revival then takes it', () =>
      inWorld('admission-revivable', async ({ f }) => {
        const task = await failedTask(f)
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        const before = await reads.taskAdmission(Q, task.taskId)
        expect(
          { false: falseOf(before), named: Object.keys(before?.retry ?? {}) },
          'mutation-verdict:behavior:operator-admission-reads-every-conjunct-of-the-guard',
        ).toEqual({ false: [], named: [...RETRY_GUARD] })
        const revived = await f.store.retryTask(Q, task.taskId)
        expect(revived).toEqual({ runId: expect.any(String), attempt: 2 })
        // Revived, the task is live with a pending run, and the guard says why a second
        // revival is refused.
        expect(falseOf(await reads.taskAdmission(Q, task.taskId))).toEqual([
          'failed',
          'hasAFailureReason',
          'hasNoLiveRun',
        ])
        // A task the queue does not hold has no conjunct to read, in this queue or another.
        expect(await reads.taskAdmission(Q, 'no-such-task')).toBeNull()
        expect(await reads.taskAdmission('another-queue', task.taskId)).toBeNull()
        // One batch of reads to a call, and nothing after it.
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set(['task-admission/read']),
        )
        expect(recorder.batches).toHaveLength(4)
      }))

    describe('a conjunct of the retry guard that is false is the one the read names, and the revival is refused', () => {
      it('has a state for every conjunct of the guard, and a state no engine path reaches says it is fixture-built', () => {
        expect(Object.keys(RETRY_REFUSALS)).toEqual([...RETRY_GUARD])
        // Each state is for its own conjunct, which is the first it leaves false or among them.
        for (const name of RETRY_GUARD) expect(RETRY_REFUSALS[name].leavesFalse).toContain(name)
        // The states an engine path reaches: a cancellation, the largest budget, a saga.
        expect(
          RETRY_GUARD.filter((name) => !RETRY_REFUSALS[name].what.endsWith(', fixture-built')),
        ).toEqual(['failed', 'budgetTakesOneMore', 'sagaNotBegun'])
      })

      for (const name of RETRY_GUARD) {
        const refusal = RETRY_REFUSALS[name]
        it(`${name}: ${refusal.what}`, () =>
          inWorld(`refused-${name}`, async ({ f }) => {
            const taskId = await refusal.build(f)
            const admission = await f.operatorReadsOver(f.raw).taskAdmission(Q, taskId)
            const before = await snapshot(f.raw)
            const revived = await f.store.retryTask(Q, taskId)
            expect(
              {
                conjunct: name,
                false: falseOf(admission),
                revived,
                wroteNothing: JSON.stringify(await snapshot(f.raw)) === JSON.stringify(before),
              },
              'mutation-verdict:behavior:operator-admission-names-the-conjunct-that-refuses',
            ).toEqual({
              conjunct: name,
              false: refusal.leavesFalse,
              revived: null,
              wroteNothing: true,
            })
          }))
      }
    })

    describe('a counter at the least or the greatest value its column holds is read, and the revival is refused', () => {
      for (const extreme of RETRY_COUNTER_EXTREMES) {
        it(extreme.what, () =>
          inWorld('refused-at-a-bound', async ({ f }) => {
            const taskId = await extreme.build(f)
            const admission = await f.operatorReadsOver(f.raw).taskAdmission(Q, taskId)
            const before = await untouched(f.raw, taskId)
            const revived = await f.store.retryTask(Q, taskId)
            expect(
              {
                false: falseOf(admission),
                revived,
                wroteNothing: isDeepStrictEqual(await untouched(f.raw, taskId), before),
              },
              'mutation-verdict:behavior:operator-admission-asks-a-charge-only-where-its-counters-are-in-range',
            ).toEqual({ false: extreme.leavesFalse, revived: null, wroteNothing: true })
          }))
      }
    })

    it('says of each run and task of a seeded queue what a claim and a sweep then do with it, with one canonical answer', () =>
      inWorld('admission-queue', async ({ f, at }) => {
        // Each claim takes the one run that is due, so the runs that are claimed come first.
        const lease = await spawn(f, 'lease')
        await claimActivated(f.store, Q, 'w-lease')
        const napper = await spawn(f, 'nap')
        const napping = await claimActivated(f.store, Q, 'w-nap')
        await f.store.reschedule(Q, napping.runId, napping.claimToken, { inSeconds: 20 })
        const gens = await spawn(f, 'gens')
        await claimActivated(f.store, Q, 'w-gens')
        const due = await spawn(f, 'due')
        const doomed = await spawn(f, 'doomed', { cancellation: { maxDelaySeconds: 30 } })
        const delayed = await spawn(f, 'delayed', { startDelaySeconds: 3600 })
        const strategy = await spawn(f, 'strategy')
        const foreign = await spawn(f, 'foreign', { cancellation: { maxDelaySeconds: 30 } })
        // Fixture-built, each a row no engine path writes: generations the sweep's scan
        // cannot act on, a retry strategy a claim cannot run, and a run in another queue.
        await planted(f, [
          {
            sql: 'UPDATE runs SET activated_gen = claim_gen + 5 WHERE run_id = ?',
            args: [gens.runId],
          },
          {
            sql: "UPDATE tasks SET retry_strategy = 'not json' WHERE task_id = ?",
            args: [strategy.taskId],
          },
          {
            sql: "UPDATE runs SET queue = 'another-queue' WHERE run_id = ?",
            args: [foreign.runId],
          },
        ])
        await at(LATER)
        const reads = f.operatorReadsOver(f.raw)
        const read = async (task: { taskId: string }) =>
          besideTheGuard(await reads.taskAdmission(Q, task.taskId))
        const run = (runId: string, over: Record<string, unknown>) => ({
          runId,
          state: 'pending',
          claimGen: 0,
          availableAtMs: START,
          claimExpiresAtMs: null,
          claimTakes: false,
          sweepReclaims: false,
          ...over,
        })
        const task = (state: string, runs: unknown[], over: Record<string, unknown> = {}) => ({
          // The instant the read was made at, which is the instant its flags are of.
          nowMs: LATER,
          state,
          cancelAtMs: null,
          sweepCancels: false,
          runs,
          corrupt: [],
          ...over,
        })
        const leased = { state: 'running', claimGen: 1, claimExpiresAtMs: START + 60_000 }
        expect(
          {
            // Started, and its lease has lapsed: the sweep takes the run back.
            lease: await read(lease),
            // Asleep until twenty seconds on, which have passed: a claim takes it.
            napper: await read(napper),
            // Its lease has lapsed, and the sweep's scan refuses its generations.
            gens: await read(gens),
            // Due since the start: a claim takes it.
            due: await read(due),
            // Past its start deadline: no claim takes its run, and the sweep cancels the task.
            doomed: await read(doomed),
            // Due in an hour: nothing is owed to it.
            delayed: await read(delayed),
            // Due, with a retry strategy that is not JSON: no claim takes it.
            strategy: await read(strategy),
            // Past its deadline, with its run in another queue: the sweep's scan refuses it.
            foreign: await read(foreign),
          },
          'mutation-verdict:behavior:operator-admission-flags-are-what-the-engine-does',
        ).toEqual({
          lease: task('running', [run(lease.runId, { ...leased, sweepReclaims: true })]),
          napper: task('sleeping', [
            run(napper.runId, {
              state: 'sleeping',
              claimGen: 1,
              availableAtMs: START + 20_000,
              claimTakes: true,
            }),
          ]),
          gens: task('running', [run(gens.runId, leased)]),
          due: task('pending', [run(due.runId, { claimTakes: true })]),
          doomed: task('pending', [run(doomed.runId, {})], {
            cancelAtMs: START + 30_000,
            sweepCancels: true,
          }),
          delayed: task('pending', [run(delayed.runId, { availableAtMs: START + 3_600_000 })]),
          strategy: task('pending', [run(strategy.runId, {})]),
          foreign: task('pending', [run(foreign.runId, {})], { cancelAtMs: START + 30_000 }),
        })
        // And the engine does what the flags say: a claim with room for every run takes the
        // two a flag named, and the sweep cancels the one task and takes back the one run.
        const claimed = await f.store.claim(Q, 'w-all', { leaseSeconds: 60, limit: 100 })
        expect(sorted(claimed.map((one) => one.runId))).toEqual(sorted([napper.runId, due.runId]))
        const swept = await f.store.sweep(Q, 100)
        expect(
          sorted(
            swept.map((one) => `${one.kind} ${one.kind === 'cancelled' ? one.taskId : one.runId}`),
          ),
        ).toEqual(sorted([`cancelled ${doomed.taskId}`, `claim-timeout ${lease.runId}`]))
      }))

    it('lists an integer it read beside a flag that is outside its bounds, and still answers the flags', () =>
      inWorld('admission-corrupt', async ({ f }) => {
        const task = await spawn(f, 'job', { cancellation: { maxDelaySeconds: 30 } })
        // Fixture-built: no engine path writes a generation below zero or a deadline below it.
        await planted(f, [
          { sql: 'UPDATE runs SET claim_gen = -1 WHERE run_id = ?', args: [task.runId] },
          { sql: 'UPDATE tasks SET cancel_at_ms = -5 WHERE task_id = ?', args: [task.taskId] },
        ])
        const outOfRange = { reason: 'out-of-range', stored: 'number' }
        expect(
          besideTheGuard(await f.operatorReadsOver(f.raw).taskAdmission(Q, task.taskId)),
        ).toEqual({
          nowMs: START,
          state: 'pending',
          cancelAtMs: null,
          sweepCancels: false,
          runs: [
            {
              runId: task.runId,
              state: 'pending',
              claimGen: null,
              availableAtMs: START,
              claimExpiresAtMs: null,
              // A claim refuses a run whose generation it cannot raise, and a task whose
              // deadline it cannot read.
              claimTakes: false,
              sweepReclaims: false,
            },
          ],
          corrupt: [
            { field: 'runs.claim_gen', runId: task.runId, ...outOfRange, value: '-1' },
            { field: 'tasks.cancel_at_ms', taskId: task.taskId, ...outOfRange, value: '-5' },
          ],
        })
      }))

    it('agrees with the retry guard, with a claim and with a sweep on every state a walk of the engine leaves', async () => {
      const reached: Reached = {
        claimTakes: 0,
        sweepReclaims: 0,
        sweepCancels: 0,
        revived: 0,
        failedAndRefused: 0,
        notFailed: 0,
      }
      for (const seed of WALKS) {
        await runFuzzScenario(makeFixture, seed, WALK_STEPS, async (f) => {
          const reads = f.operatorReadsOver(f.raw)
          // The walk is over, and nothing below writes before the revivals at the end, so
          // the queue's tasks are listed once.
          const tasks = (await snapshot(f.raw)).tasks
            .filter((task) => task.queue === Q)
            .map((task) => String(task.task_id))
          let nowMs = await f.admin.nowEpochMs()
          for (const [round, ahead] of ROUNDS_AHEAD_MS.entries()) {
            nowMs += ahead
            await f.admin.setFakeNowEpochMs(nowMs)
            const where = `walk ${seed}, round ${round}`
            // What the finder lists as the engine's to take, with room for every row.
            const owed = await reads.stuckRuns(Q, { graceSeconds: 0, limit: OPERATOR_LIST_CAP })
            const said = { claim: [] as string[], reclaim: [] as string[], cancel: [] as string[] }
            for (const taskId of tasks) {
              const admission = await reads.taskAdmission(Q, taskId)
              if (admission === null)
                throw new Error(`${where}: task ${taskId} is listed and not read`)
              if (admission.sweepCancels) said.cancel.push(taskId)
              for (const run of admission.runs) {
                if (run.claimTakes) said.claim.push(run.runId)
                if (run.sweepReclaims) said.reclaim.push(run.runId)
              }
            }
            expect(
              {
                where,
                claim: sorted(said.claim),
                reclaim: sorted(said.reclaim),
                cancel: sorted(said.cancel),
              },
              'mutation-verdict:behavior:operator-admission-agrees-with-the-finder-on-a-walk',
            ).toEqual({
              where,
              claim: sorted(
                [...owed.dueUnclaimed.rows, ...owed.sleepingPastWake.rows].map((run) => run.runId),
              ),
              reclaim: sorted(owed.leaseLapsed.rows.map((run) => run.runId)),
              cancel: sorted(owed.cancelOverdue.rows.map((task) => task.taskId)),
            })
            reached.claimTakes += said.claim.length
            reached.sweepReclaims += said.reclaim.length
            reached.sweepCancels += said.cancel.length
          }
          // Last, because it writes: every conjunct holds of a task exactly when the
          // revival takes it.
          const disagreed: string[] = []
          for (const taskId of tasks) {
            const admission = await reads.taskAdmission(Q, taskId)
            if (admission === null)
              throw new Error(`walk ${seed}: task ${taskId} is listed and not read`)
            const refusedBy = falseOf(admission)
            const revived = (await f.store.retryTask(Q, taskId)) !== null
            if (revived !== (refusedBy.length === 0)) {
              disagreed.push(
                `walk ${seed}: task ${taskId} was ${revived ? 'revived' : 'refused'}, and the read says ${refusedBy.length === 0 ? 'every conjunct holds' : `${refusedBy.join(', ')} refuse it`}`,
              )
            }
            if (revived) reached.revived += 1
            else if (admission.retry.failed) reached.failedAndRefused += 1
            else reached.notFailed += 1
          }
          expect(
            disagreed,
            'mutation-verdict:behavior:operator-admission-agrees-with-the-guard-on-a-walk',
          ).toEqual([])
        })
      }
      // The floor: walks that leave nothing to admit prove nothing, and fail.
      const missed = (Object.keys(FLOORS) as (keyof Reached)[]).filter(
        (kind) => reached[kind] < FLOORS[kind],
      )
      expect(missed, `the walks reached ${JSON.stringify(reached)}`).toEqual([])
    }, 600_000)

    it("answers the payload an event's first emit stored, byte for byte, a completion event's too, and nothing of another queue's", () =>
      inWorld('event-payload', async ({ f }) => {
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        expect(await reads.eventPayload(Q, 'approval')).toEqual({ exists: false })
        // Text a JSON printer would not write: the digest an operator compares is of these bytes.
        const first = '{ "first" :  "é\u{1f600}" }'
        await f.store.emitEvent(Q, 'approval', first)
        // First write wins, so a second emit changes nothing a read answers.
        await f.store.emitEvent(Q, 'approval', '{"second":2}')
        expect(
          await reads.eventPayload(Q, 'approval'),
          'mutation-verdict:behavior:operator-event-payload-is-what-the-first-emit-stored',
        ).toEqual({ exists: true, payloadJson: first })
        expect(await reads.eventPayload('another-queue', 'approval')).toEqual({ exists: false })
        // A completion event is the engine's own, under a reserved name. Its payload is the
        // one a parent that awaits the child is handed.
        const parent = await spawn(f, 'parent')
        const parentRun = await claimActivated(f.store, Q, 'w-parent')
        const child = await f.store.spawn(Q, 'child', '{}', {
          childOf: {
            parentQueue: Q,
            parentTaskId: parent.taskId,
            runId: parentRun.runId,
            claimToken: parentRun.claimToken,
            replayKey: 'site:1',
          },
        })
        const done = taskDoneEventName(child.taskId)
        expect(await reads.eventPayload(Q, done)).toEqual({ exists: false })
        const childRun = await claimActivated(f.store, Q, 'w-child')
        await f.store.complete(Q, childRun.runId, childRun.claimToken, '"done"')
        const handed = await awaitTaskOwned(
          f.store,
          Q,
          parentRun,
          'await-child',
          child.taskId,
          null,
        )
        expect(await reads.eventPayload(Q, done)).toEqual(
          handed.emitted
            ? { exists: true, payloadJson: handed.payloadJson }
            : 'the await was not hit',
        )
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set(['event-payload/read']),
        )
      }))
  })
}
