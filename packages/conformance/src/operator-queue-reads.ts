import {
  LIVE_STATES,
  MAX_EPOCH_MS,
  OPERATOR_GAUGE_CAP,
  OPERATOR_LIST_CAP,
  OPERATOR_TABLE_ROWS_CAP,
  QUEUE_TABLES,
  type QueueStatus,
  type SqlRow,
  type SqlStatement,
  type SweptRun,
  type TableRows,
} from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { runFuzzScenario } from './fuzz.js'
import { Q, START, type World, spawn, worldOf } from './operator-reads.js'
import { type ProtocolSnapshot, snapshot } from './poison-matrix.js'
import { awaitOwned, claimActivated, claimOne } from './scenario.js'

/**
 * The operator's reads of a queue (`OperatorReads`, DESIGN.md §3.11) on one dialect: what a
 * move of the driver is owed to, the gauges, the row counts, and an event's waiters. Core
 * holds the one implementation, and core's own cases hold how it decodes rows. What is held
 * here is what a dialect decides: which rows each of its statements answers with.
 *
 * Two properties carry the weight, and each is held by something that is not the reads.
 * The finder agrees with the engine: read with no grace, the runs it lists as owed a claim
 * are the runs a claim then takes, and the runs and tasks it lists as owed a sweep are
 * what a sweep then reclaims or cancels. That is a statement about every state the engine
 * leaves a queue in, so it is asked of the states a fuzz walk of the engine leaves, with a
 * floor on what the walks reached, as well as of a queue seeded by hand, at the instant
 * each move comes due and one millisecond before it. The gauges and the row counts equal
 * counts made here, in TypeScript, from a dump of every table.
 */

/** A task and its one run, as a spawn answers them. */
interface Spawned {
  readonly taskId: string
  readonly runId: string
}

/** The instants of the seeded queue. */
const WAKES_AT = START + 20_000
const DEADLINE_AT = START + 30_000
const TIMES_OUT_AT = START + 40_000
const LEASES_END_AT = START + 60_000
const LATER = START + 70_000

interface SeededQueue {
  /** Claimed and started at `START` under a lease of 60 seconds. */
  readonly running: Spawned
  /** Claimed at `START` under a lease of 60 seconds, and never started. */
  readonly lost: Spawned
  /** Started, and asleep on a timer until `WAKES_AT`. */
  readonly asleep: Spawned
  /** Started, and parked on the event `approval` with no timeout. */
  readonly untimed: Spawned
  /** Started, and parked on the event `approval` until `TIMES_OUT_AT`. */
  readonly timed: Spawned
  /** Due at `START`, and never claimed. */
  readonly due: Spawned
  /** Due an hour after `START`. */
  readonly delayed: Spawned
  /** Due at `START`, never claimed, and to be started by `DEADLINE_AT` or cancelled. */
  readonly doomed: Spawned
}

/**
 * A queue with a run in every state the legs and the gauges tell apart, driven through the
 * store's ports at `START`. Each claim takes the one run that is due, so a task is taken to
 * its state before the next is spawned. Another queue holds one task, which nothing here
 * may count or list.
 */
async function seededQueue({ f }: World): Promise<SeededQueue> {
  const running = await spawn(f, 'running')
  await claimActivated(f.store, Q, 'w-running')
  const lost = await spawn(f, 'launch-lost')
  await claimOne(f.store, Q, 'w-lost')
  const asleep = await spawn(f, 'asleep')
  const napping = await claimActivated(f.store, Q, 'w-asleep')
  await f.store.suspendRun(
    Q,
    napping.runId,
    napping.claimToken,
    { inSeconds: 20 },
    { key: '$sleep:nap', stateJson: 'null' },
  )
  const park = async (worker: string, timeoutSeconds: number | null) => {
    const run = await claimActivated(f.store, Q, worker)
    expect(await awaitOwned(f.store, Q, run, 'approve', 'approval', timeoutSeconds)).toEqual({
      emitted: false,
    })
  }
  const untimed = await spawn(f, 'awaits-with-no-timeout')
  await park('w-untimed', null)
  const timed = await spawn(f, 'awaits-under-a-timeout')
  await park('w-timed', 40)
  await f.store.spawn('another-queue', 'job', '{}')
  const due = await spawn(f, 'due')
  const delayed = await spawn(f, 'delayed', { startDelaySeconds: 3600 })
  const doomed = await spawn(f, 'doomed', { cancellation: { maxDelaySeconds: 30 } })
  return { running, lost, asleep, untimed, timed, due, delayed, doomed }
}

const NONE = { rows: [], atLeast: false }
const all = <Row>(...rows: Row[]) => ({ rows, atLeast: false })
const exactly = (count: number) => ({ count, atLeast: false })

/** A run the finder lists, as it lists it at `nowMs`: first attempt, and late by the difference. */
const owedRun = (task: Spawned, taskName: string, dueAtMs: number, nowMs: number) => ({
  runId: task.runId,
  taskId: task.taskId,
  taskName,
  attempt: 1,
  dueAtMs,
  lateByMs: nowMs - dueAtMs,
})

/** What `stuckRuns` answers at `nowMs` under the test clock, with the legs given and every other one empty. */
const report = (nowMs: number, legs: Record<string, unknown> = {}) => ({
  nowMs,
  fakeClock: true,
  dueUnclaimed: NONE,
  sleepingPastWake: NONE,
  leaseLapsed: NONE,
  cancelOverdue: NONE,
  corrupt: [],
  ...legs,
})

/** The legs of the seeded queue at `LATER`, with no grace. */
const legsAtLater = (seeded: SeededQueue) => ({
  dueUnclaimed: all(owedRun(seeded.due, 'due', START, LATER)),
  sleepingPastWake: all(
    owedRun(seeded.asleep, 'asleep', WAKES_AT, LATER),
    owedRun(seeded.timed, 'awaits-under-a-timeout', TIMES_OUT_AT, LATER),
  ),
  leaseLapsed: all(
    { ...owedRun(seeded.running, 'running', LEASES_END_AT, LATER), activated: true },
    { ...owedRun(seeded.lost, 'launch-lost', LEASES_END_AT, LATER), activated: false },
  ),
  cancelOverdue: all({
    taskId: seeded.doomed.taskId,
    taskName: 'doomed',
    state: 'pending',
    runId: seeded.doomed.runId,
    dueAtMs: DEADLINE_AT,
    lateByMs: LATER - DEADLINE_AT,
  }),
})

const sorted = (ids: readonly string[]): string[] => [...ids].sort()

/** What the readings below reached, summed over every one of a case. */
interface Reached {
  /** Pending runs a claim took. */
  dueUnclaimed: number
  /** Sleeping runs a claim took. */
  sleepingPastWake: number
  /** Launches the sweep reopened. */
  lostLaunches: number
  /** Started runs the sweep failed for a lapsed lease. */
  claimTimeouts: number
  /** Tasks the sweep cancelled. */
  cancelled: number
  /** Runs under a lapsed lease whose task was also past its deadline, which are in two legs. */
  inBothLegs: number
  /** Live tasks enqueued at least `AGED_SECONDS` before a reading, which the read of the oldest lists. */
  agedLive: number
  /** Live tasks enqueued more recently than that, which it leaves out. */
  youngLive: number
}

const nothingReached = (): Reached => ({
  dueUnclaimed: 0,
  sleepingPastWake: 0,
  lostLaunches: 0,
  claimTimeouts: 0,
  cancelled: 0,
  inBothLegs: 0,
  agedLive: 0,
  youngLive: 0,
})

/**
 * One reading of the finder with no grace, and then the engine's own claim and sweep at the
 * same instant, each with a limit past anything the queue holds. The runs the finder
 * listed as owed a claim are the runs the claim takes. The tasks it listed as past their
 * deadline are the tasks the sweep cancels, and the runs it listed under a lapsed lease
 * are the runs the sweep reclaims.
 *
 * One kind of row is in two legs: a run under a lapsed lease whose task is also past its
 * deadline. A sweep finds it twice and sends a batch for each finding, side by side, so
 * which arm takes it is decided by which batch lands first: the cancellation alone, or the
 * reclaim and then the cancellation of what the reclaim left. Such a row is held to being
 * taken by an arm, and every other row to its own arm exactly.
 */
async function finderAgainstTheEngine(
  f: StoreFixture,
  where: string,
  claimToken: string,
  reached: Reached,
): Promise<void> {
  const owed = await f
    .operatorReadsOver(f.raw)
    .stuckRuns(Q, { graceSeconds: 0, limit: OPERATOR_LIST_CAP })
  const legs = [owed.dueUnclaimed, owed.sleepingPastWake, owed.leaseLapsed, owed.cancelOverdue]
  expect({ where, more: legs.map((leg) => leg.atLeast), corrupt: owed.corrupt }).toEqual({
    where,
    more: [false, false, false, false],
    corrupt: [],
  })

  const claimed = await f.store.claim(Q, claimToken, {
    leaseSeconds: 60,
    limit: OPERATOR_LIST_CAP,
  })
  expect(
    { where, claimed: sorted(claimed.map((run) => run.runId)) },
    'mutation-verdict:behavior:operator-finder-lists-the-runs-a-claim-takes',
  ).toEqual({
    where,
    claimed: sorted(
      [...owed.dueUnclaimed.rows, ...owed.sleepingPastWake.rows].map((run) => run.runId),
    ),
  })

  const swept = await f.store.sweep(Q, 10 * OPERATOR_LIST_CAP)
  type Reclaimed = Exclude<SweptRun, { kind: 'cancelled' }>
  const reclaimed = swept.filter((outcome): outcome is Reclaimed => outcome.kind !== 'cancelled')
  const cancelled = new Set(
    swept.filter((outcome) => outcome.kind === 'cancelled').map((outcome) => outcome.taskId),
  )
  const reclaimedRuns = new Set(reclaimed.map((outcome) => outcome.runId))
  // The rows in both legs, as the finder itself listed them.
  const pastTheirDeadline = new Set(owed.cancelOverdue.rows.map((task) => task.taskId))
  const inBothLegs = owed.leaseLapsed.rows.filter((run) => pastTheirDeadline.has(run.taskId))
  const runsInBoth = new Set(inBothLegs.map((run) => run.runId))
  const tasksInBoth = new Set(inBothLegs.map((run) => run.taskId))
  expect(
    { where, cancelled: sorted([...cancelled].filter((task) => !tasksInBoth.has(task))) },
    'mutation-verdict:behavior:operator-finder-lists-the-tasks-a-sweep-cancels',
  ).toEqual({
    where,
    cancelled: sorted(
      owed.cancelOverdue.rows.map((task) => task.taskId).filter((task) => !tasksInBoth.has(task)),
    ),
  })
  expect(
    { where, reclaimed: sorted([...reclaimedRuns].filter((run) => !runsInBoth.has(run))) },
    'mutation-verdict:behavior:operator-finder-lists-the-runs-a-sweep-reclaims',
  ).toEqual({
    where,
    reclaimed: sorted(
      owed.leaseLapsed.rows.map((run) => run.runId).filter((run) => !runsInBoth.has(run)),
    ),
  })
  expect(
    inBothLegs
      .filter((run) => !reclaimedRuns.has(run.runId) && !cancelled.has(run.taskId))
      .map((run) => `${where}: no arm of the sweep took ${run.runId}`),
    'mutation-verdict:behavior:operator-finder-lists-a-row-of-both-legs-that-a-sweep-takes',
  ).toEqual([])
  // What the finder said of each lapsed run is what the sweep then did with it: it fails a
  // run that was started, and reopens a launch that was lost.
  const started = new Map(owed.leaseLapsed.rows.map((run) => [run.runId, run.activated]))
  expect(
    reclaimed
      .filter((outcome) => outcome.kind === 'claim-timeout' || outcome.kind === 'lost-launch')
      .filter((outcome) => started.get(outcome.runId) !== (outcome.kind === 'claim-timeout'))
      .map((outcome) => `${where}: ${outcome.kind} of ${outcome.runId}`),
    'mutation-verdict:behavior:operator-finder-says-whether-a-lapsed-run-was-started',
  ).toEqual([])

  reached.dueUnclaimed += owed.dueUnclaimed.rows.length
  reached.sleepingPastWake += owed.sleepingPastWake.rows.length
  reached.lostLaunches += reclaimed.filter((outcome) => outcome.kind === 'lost-launch').length
  reached.claimTimeouts += reclaimed.filter((outcome) => outcome.kind === 'claim-timeout').length
  reached.cancelled += cancelled.size
  reached.inBothLegs += inBothLegs.length
}

/** A stored instant of a dumped row, or null where the row holds none. */
const instantOf = (row: SqlRow, column: string): number | null => {
  const stored = row[column]
  return stored === null || stored === undefined ? null : Number(stored)
}

const held = (instants: readonly (number | null)[]): number[] =>
  instants.filter((instant): instant is number => instant !== null)

const least = (instants: readonly number[]): number | null =>
  instants.length === 0 ? null : Math.min(...instants)

/**
 * What `queueStatus` must answer for one queue, counted here from a dump of every table and
 * from nothing the reads send: no leg, no index and no fragment of a store.
 */
function statusFromTheDump(dump: ProtocolSnapshot, nowMs: number): QueueStatus {
  const runs = (state: string, column: string): number[] =>
    held(
      dump.runs
        .filter((run) => run.queue === Q && run.state === state)
        .map((run) => instantOf(run, column)),
    )
  const live: readonly string[] = LIVE_STATES
  const pending = runs('pending', 'available_at_ms')
  const sleeping = runs('sleeping', 'available_at_ms')
  const running = runs('running', 'claim_expires_at_ms')
  const deadlines = held(
    dump.tasks
      .filter((task) => task.queue === Q && live.includes(String(task.state)))
      .map((task) => instantOf(task, 'cancel_at_ms')),
  )
  const enqueued = held(
    dump.tasks
      .filter((task) => task.queue === Q && live.includes(String(task.state)))
      .map((task) => instantOf(task, 'enqueue_at_ms')),
  )
  const firstEnqueued = least(enqueued)
  const cameDue = (instants: readonly number[]) => instants.filter((at) => at <= nowMs)
  const gauge = (rows: readonly number[]) => ({
    count: Math.min(rows.length, OPERATOR_GAUGE_CAP),
    atLeast: rows.length > OPERATOR_GAUGE_CAP,
  })
  const head = least([...cameDue(pending), ...cameDue(sleeping)])
  const firstExpiry = least(running)
  return {
    nowMs,
    fakeClock: true,
    gauges: {
      pendingRuns: gauge(pending),
      pendingRunsDue: gauge(cameDue(pending)),
      sleepingRuns: gauge(sleeping),
      sleepingRunsDue: gauge(cameDue(sleeping)),
      runningRuns: gauge(running),
      runningRunsLapsed: gauge(cameDue(running)),
      tasksWithADeadline: gauge(deadlines),
      tasksPastTheirDeadline: gauge(cameDue(deadlines)),
      liveTasks: gauge(enqueued),
    },
    claimLagMs: head === null ? null : nowMs - head,
    leaseHeadroomMs: firstExpiry === null ? null : firstExpiry - nowMs,
    nextWakeAtMs: least([...pending, ...sleeping, ...running, ...deadlines]),
    oldestLiveTaskAgeMs: firstEnqueued === null ? null : nowMs - firstEnqueued,
    corrupt: [],
  }
}

/** What `tableRows` must answer for one queue, counted from the same dump. */
function rowsFromTheDump(dump: ProtocolSnapshot, queue: string): TableRows {
  return {
    cap: OPERATOR_TABLE_ROWS_CAP,
    tables: Object.fromEntries(
      QUEUE_TABLES.map((table) => [
        table,
        exactly(dump[table].filter((row) => row.queue === queue).length),
      ]),
    ) as TableRows['tables'],
  }
}

/** How old a live task must be for the readings of a walk to list it, in seconds. */
const AGED_SECONDS = 45

/**
 * What `agedTasks` must answer for one queue with a limit past its live tasks, made from the
 * same dump: every live task enqueued at least so long ago, oldest first and then by id.
 */
function agedFromTheDump(dump: ProtocolSnapshot, nowMs: number, olderThanMs: number) {
  const live: readonly string[] = LIVE_STATES
  const rows = dump.tasks
    .filter((task) => task.queue === Q && live.includes(String(task.state)))
    .map((task) => ({
      taskId: String(task.task_id),
      taskName: String(task.task_name),
      state: String(task.state),
      enqueueAtMs: Number(task.enqueue_at_ms),
    }))
    .filter((task) => task.enqueueAtMs <= nowMs - olderThanMs)
    .sort(
      (left, right) =>
        left.enqueueAtMs - right.enqueueAtMs ||
        (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
    )
    .map((task) => ({ ...task, ageMs: nowMs - task.enqueueAtMs }))
  return { nowMs, fakeClock: true, tasks: { rows, atLeast: false }, corrupt: [] }
}

/**
 * The gauges, the row counts and the oldest live tasks of the queue, each against a count
 * or a list made from a dump of every table.
 */
async function countsAgainstTheDump(
  f: StoreFixture,
  where: string,
  nowMs: number,
  reached?: Reached,
): Promise<void> {
  const reads = f.operatorReadsOver(f.raw)
  const dump = await snapshot(f.raw)
  expect(
    { where, status: await reads.queueStatus(Q) },
    'mutation-verdict:behavior:operator-gauges-equal-a-count-of-the-dump',
  ).toEqual({ where, status: statusFromTheDump(dump, nowMs) })
  expect(
    { where, rows: await reads.tableRows(Q) },
    'mutation-verdict:behavior:operator-row-counts-equal-a-count-of-the-dump',
  ).toEqual({ where, rows: rowsFromTheDump(dump, Q) })
  // The live tasks, oldest first: every one of them, and those enqueued long enough ago.
  const everyLive = agedFromTheDump(dump, nowMs, 0)
  for (const olderThanSeconds of [0, AGED_SECONDS]) {
    const aged = agedFromTheDump(dump, nowMs, olderThanSeconds * 1000)
    expect(
      {
        where,
        olderThanSeconds,
        aged: await reads.agedTasks(Q, { olderThanSeconds, limit: OPERATOR_LIST_CAP }),
      },
      'mutation-verdict:behavior:operator-aged-equals-the-live-tasks-of-the-dump',
    ).toEqual({ where, olderThanSeconds, aged })
    if (olderThanSeconds > 0 && reached !== undefined) {
      reached.agedLive += aged.tasks.rows.length
      reached.youngLive += everyLive.tasks.rows.length - aged.tasks.rows.length
    }
  }
}

/**
 * The walks: these seeds, each this many steps of the conformance package's fuzz walk of
 * the engine. When a walk ends the clock is moved on in rounds, so that what the walk left
 * comes due: runs wake, leases lapse, deadlines pass. A failing seed replays exactly.
 */
const WALKS = Array.from({ length: 12 }, (_, seed) => `finder-${seed}`)
const WALK_STEPS = 100
/** How far each round moves the clock on from the round before, in milliseconds. */
const ROUNDS_AHEAD_MS = [0, 31_000, 62_000, 300_000, 4_000_000]

/**
 * What the walks must reach between them, so that a set of walks that leaves nothing owed
 * fails. Measured when the case was written, the same on every dialect because the walks
 * are: 86 pending and 12 sleeping runs that a claim took, 103 launches reopened, 14 started
 * runs failed for a lapsed lease, 4 tasks cancelled, and 2 runs in both legs of the sweep.
 * Over the readings the walks also left 267 live tasks at least 45 seconds old, beside
 * 26 younger ones, which the read of the oldest live tasks tells apart.
 * Each floor sits below that, so a change to the walk that moves a seed does not fail the
 * case for a row or two, and a walk that stops reaching a kind of move does.
 */
const FLOORS: Reached = {
  dueUnclaimed: 60,
  sleepingPastWake: 8,
  lostLaunches: 70,
  claimTimeouts: 10,
  cancelled: 3,
  inBothLegs: 1,
  agedLive: 180,
  youngLive: 10,
}

export function operatorQueueReadsConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`operator reads of a queue [${dialect}]`, () => {
    const inWorld = worldOf(makeFixture)

    it('lists what a claim and a sweep would take from a seeded queue, under each grace and limit, with one canonical answer', () =>
      inWorld('queue-owed', async (world) => {
        const { f, at } = world
        const seeded = await seededQueue(world)
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        // At the instant everything was spawned, only the two runs that are due and unclaimed.
        expect(await reads.stuckRuns(Q, { graceSeconds: 0, limit: 10 })).toEqual(
          report(START, {
            dueUnclaimed: all(
              owedRun(seeded.due, 'due', START, START),
              owedRun(seeded.doomed, 'doomed', START, START),
            ),
          }),
        )
        await at(LATER)
        const before = await snapshot(f.raw)
        // Seventy seconds on: the run that slept and the await that timed out are due, both
        // leases have lapsed, and the task that was never started is past its deadline, so
        // no claim takes its run. The delayed run and the await with no timeout are owed
        // nothing.
        expect(
          await reads.stuckRuns(Q, { graceSeconds: 0, limit: 10 }),
          'mutation-verdict:behavior:operator-finder-answers-a-seeded-queue',
        ).toEqual(report(LATER, legsAtLater(seeded)))
        // A grace of 45 seconds keeps what has been owed for that long: the run due for 70
        // and the sleeper due for 50, and neither a lease that lapsed 10 ago nor a deadline
        // that passed 40 ago.
        expect(await reads.stuckRuns(Q, { graceSeconds: 45, limit: 10 })).toEqual(
          report(LATER, {
            dueUnclaimed: all(owedRun(seeded.due, 'due', START, LATER)),
            sleepingPastWake: all(owedRun(seeded.asleep, 'asleep', WAKES_AT, LATER)),
          }),
        )
        // A limit of one lists the oldest of each leg, and says which legs hold more.
        const { sleepingPastWake, leaseLapsed, ...others } = legsAtLater(seeded)
        expect(await reads.stuckRuns(Q, { graceSeconds: 0, limit: 1 })).toEqual(
          report(LATER, {
            ...others,
            sleepingPastWake: { rows: sleepingPastWake.rows.slice(0, 1), atLeast: true },
            leaseLapsed: { rows: leaseLapsed.rows.slice(0, 1), atLeast: true },
          }),
        )
        // Another queue's one run is due, and a queue that holds nothing has nothing owed.
        expect(
          (await reads.stuckRuns('another-queue', { graceSeconds: 0, limit: 10 })).dueUnclaimed.rows
            .length,
        ).toBe(1)
        expect(await reads.stuckRuns('an-empty-queue', { graceSeconds: 0, limit: 10 })).toEqual(
          report(LATER),
        )
        // Each reading is one batch of reads, the flag of the test clock follows it, and
        // nothing was written.
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set(['stuck-runs/read', 'fake-clock/read']),
        )
        expect(recorder.batches.map((batch) => batch.label).slice(0, 2)).toEqual([
          'stuck-runs',
          'fake-clock',
        ])
        expect(await snapshot(f.raw)).toEqual(before)
      }))

    it("counts a seeded queue's gauges and rows, and lists an event's waiters, with one canonical answer", () =>
      inWorld('queue-gauges', async (world) => {
        const { f, at } = world
        const seeded = await seededQueue(world)
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        const gauges = {
          pendingRuns: exactly(3),
          sleepingRuns: exactly(2),
          runningRuns: exactly(2),
          tasksWithADeadline: exactly(1),
          // Every task of the seed is live.
          liveTasks: exactly(8),
        }
        expect(await reads.queueStatus(Q)).toEqual({
          nowMs: START,
          fakeClock: true,
          gauges: {
            ...gauges,
            pendingRunsDue: exactly(2),
            sleepingRunsDue: exactly(0),
            runningRunsLapsed: exactly(0),
            tasksPastTheirDeadline: exactly(0),
          },
          claimLagMs: 0,
          leaseHeadroomMs: LEASES_END_AT - START,
          nextWakeAtMs: START,
          oldestLiveTaskAgeMs: 0,
          corrupt: [],
        })
        await at(LATER)
        const before = await snapshot(f.raw)
        // The run parked on an await with no timeout holds no instant, so it is in no gauge
        // of runs. The run that is due and the run past its deadline are both pending and due:
        // a gauge applies none of a claim's admission.
        expect(
          await reads.queueStatus(Q),
          'mutation-verdict:behavior:operator-gauges-answer-a-seeded-queue',
        ).toEqual({
          nowMs: LATER,
          fakeClock: true,
          gauges: {
            ...gauges,
            pendingRunsDue: exactly(2),
            sleepingRunsDue: exactly(2),
            runningRunsLapsed: exactly(2),
            tasksPastTheirDeadline: exactly(1),
          },
          claimLagMs: LATER - START,
          leaseHeadroomMs: LEASES_END_AT - LATER,
          nextWakeAtMs: START,
          oldestLiveTaskAgeMs: LATER - START,
          corrupt: [],
        })
        const counted = (tables: Record<string, number>) => ({
          cap: OPERATOR_TABLE_ROWS_CAP,
          tables: Object.fromEntries(
            QUEUE_TABLES.map((table) => [table, exactly(tables[table] ?? 0)]),
          ),
        })
        // Eight tasks with a run each, the two waits, and the one checkpoint of the sleep.
        expect(
          await reads.tableRows(Q),
          'mutation-verdict:behavior:operator-row-counts-answer-a-seeded-queue',
        ).toEqual(counted({ tasks: 8, runs: 8, waits: 2, checkpoints: 1 }))
        expect(await reads.tableRows('another-queue')).toEqual(counted({ tasks: 1, runs: 1 }))
        expect(await reads.tableRows('an-empty-queue')).toEqual(counted({}))
        // Both waits on the event, the one whose timeout has passed among them: its wait
        // stands until a claim takes its run.
        const waiter = (task: Spawned, timeoutAtMs: number | null) => ({
          taskId: task.taskId,
          runId: task.runId,
          stepName: 'approve',
          timeoutAtMs,
        })
        expect(
          await reads.eventWaiters(Q, 'approval'),
          'mutation-verdict:behavior:operator-waiters-answer-a-seeded-queue',
        ).toEqual({
          waiters: all(waiter(seeded.untimed, null), waiter(seeded.timed, TIMES_OUT_AT)),
          corrupt: [],
        })
        const nobody = { waiters: NONE, corrupt: [] }
        expect(await reads.eventWaiters(Q, 'an-event-nobody-awaits')).toEqual(nobody)
        expect(await reads.eventWaiters('another-queue', 'approval')).toEqual(nobody)
        // Every reading is a batch of reads, and nothing was written.
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set([
            'queue-status/read',
            'fake-clock/read',
            'table-rows/read',
            'event-waiters/read',
          ]),
        )
        expect(await snapshot(f.raw)).toEqual(before)
        // The same answers, counted from the dump.
        await countsAgainstTheDump(f, 'the seeded queue', LATER)
      }))

    describe('lists a move from the instant it comes due, as the engine takes it, and not a millisecond before', () => {
      // Each instant of the seeded queue is the instant one kind of move comes due. At it,
      // with no grace, the finder lists that move as late by nothing, and the engine's own
      // claim and sweep take exactly what the finder listed. One millisecond earlier neither
      // does.
      const INSTANTS: readonly {
        readonly move: string
        readonly at: number
        /** The run or the task whose move comes due at the instant, and the leg it is listed in. */
        listed(seeded: SeededQueue): { leg: string; id: string }[]
      }[] = [
        {
          move: 'a sleeping run comes due at its wake',
          at: WAKES_AT,
          listed: (seeded) => [{ leg: 'sleepingPastWake', id: seeded.asleep.runId }],
        },
        {
          move: 'a task that was never started reaches its deadline',
          at: DEADLINE_AT,
          listed: (seeded) => [{ leg: 'cancelOverdue', id: seeded.doomed.taskId }],
        },
        {
          move: 'an await comes due at its timeout',
          at: TIMES_OUT_AT,
          listed: (seeded) => [{ leg: 'sleepingPastWake', id: seeded.timed.runId }],
        },
        {
          move: 'a lease expires',
          at: LEASES_END_AT,
          listed: (seeded) => [
            { leg: 'leaseLapsed', id: seeded.running.runId },
            { leg: 'leaseLapsed', id: seeded.lost.runId },
          ],
        },
      ]
      for (const [index, instant] of INSTANTS.entries()) {
        it(instant.move, () =>
          inWorld(`queue-instant-${index}`, async (world) => {
            const { f, at } = world
            const seeded = await seededQueue(world)
            const reads = f.operatorReadsOver(f.raw)
            const atZeroLateness = async () => {
              const owed = await reads.stuckRuns(Q, { graceSeconds: 0, limit: 10 })
              return [
                ...owed.dueUnclaimed.rows.map((run) => ['dueUnclaimed', run.runId, run.lateByMs]),
                ...owed.sleepingPastWake.rows.map((run) => [
                  'sleepingPastWake',
                  run.runId,
                  run.lateByMs,
                ]),
                ...owed.leaseLapsed.rows.map((run) => ['leaseLapsed', run.runId, run.lateByMs]),
                ...owed.cancelOverdue.rows.map((task) => [
                  'cancelOverdue',
                  task.taskId,
                  task.lateByMs,
                ]),
              ].filter(([, , lateByMs]) => lateByMs === 0)
            }
            const expected = instant.listed(seeded).map(({ leg, id }) => [leg, id, 0])
            await at(instant.at - 1)
            expect(await atZeroLateness()).toEqual([])
            await at(instant.at)
            expect(
              await atZeroLateness(),
              'mutation-verdict:behavior:operator-finder-lists-a-move-at-the-instant-it-comes-due',
            ).toEqual(expected)
            const reached = nothingReached()
            await finderAgainstTheEngine(f, instant.move, `at-${index}`, reached)
            expect(
              reached.dueUnclaimed +
                reached.sleepingPastWake +
                reached.lostLaunches +
                reached.claimTimeouts +
                reached.cancelled,
            ).toBeGreaterThan(0)
          }))
      }

      it('a run that is due the instant it is spawned', () =>
        inWorld('queue-instant-spawn', async (world) => {
          const { f } = world
          await seededQueue(world)
          const reached = nothingReached()
          await finderAgainstTheEngine(f, 'at the instant of the spawns', 'at-spawn', reached)
          expect(reached).toEqual({ ...nothingReached(), dueUnclaimed: 2 })
        }))
    })

    it('agrees with the engine, and with a count of the dump, on every state a walk of the engine leaves', async () => {
      const reached = nothingReached()
      for (const seed of WALKS) {
        await runFuzzScenario(makeFixture, seed, WALK_STEPS, async (f) => {
          let nowMs = await f.admin.nowEpochMs()
          for (const [round, ahead] of ROUNDS_AHEAD_MS.entries()) {
            nowMs += ahead
            await f.admin.setFakeNowEpochMs(nowMs)
            const where = `walk ${seed}, round ${round}`
            await countsAgainstTheDump(f, where, nowMs, reached)
            await finderAgainstTheEngine(f, where, `${seed}-round-${round}`, reached)
          }
        })
      }
      // The floor: a set of walks that leaves nothing owed proves nothing, and fails.
      const missed = (Object.keys(FLOORS) as (keyof Reached)[]).filter(
        (kind) => reached[kind] < FLOORS[kind],
      )
      // A floor that is missed prints everything the walks reached.
      expect(missed, `the walks reached ${JSON.stringify(reached)}`).toEqual([])
    }, 600_000)

    it('counts a row whose instant is outside its bounds, lists it as corrupt, and agrees with the engine about the rest', () =>
      inWorld('queue-corrupt', async (world) => {
        const { f, at } = world
        const seeded = await seededQueue(world)
        await at(LATER)
        // Fixture-built: no engine path writes an instant outside its bounds.
        const plant = (statement: SqlStatement) => f.raw.batch('fixture:out-of-bounds', [statement])
        await plant({
          sql: 'UPDATE runs SET available_at_ms = -1 WHERE run_id = ?',
          args: [seeded.due.runId],
        })
        await plant({
          sql: 'UPDATE runs SET claim_expires_at_ms = ? WHERE run_id = ?',
          args: [MAX_EPOCH_MS + 1, seeded.running.runId],
        })
        await plant({
          sql: 'UPDATE tasks SET cancel_at_ms = -5 WHERE task_id = ?',
          args: [seeded.doomed.taskId],
        })
        const reads = f.operatorReadsOver(f.raw)
        const outOfRange = { reason: 'out-of-range', stored: 'number' }
        // Each row is still counted in the gauge of its state, in no gauge of an instant,
        // and named: the run that was due, the run whose lease had lapsed, and the task
        // that was past its deadline.
        expect(
          await reads.queueStatus(Q),
          'mutation-verdict:behavior:operator-gauges-count-a-corrupt-row-and-list-it',
        ).toEqual({
          nowMs: LATER,
          fakeClock: true,
          gauges: {
            pendingRuns: exactly(3),
            pendingRunsDue: exactly(1),
            sleepingRuns: exactly(2),
            sleepingRunsDue: exactly(2),
            runningRuns: exactly(2),
            runningRunsLapsed: exactly(1),
            tasksWithADeadline: exactly(1),
            tasksPastTheirDeadline: exactly(0),
            liveTasks: exactly(8),
          },
          claimLagMs: LATER - START,
          leaseHeadroomMs: LEASES_END_AT - LATER,
          nextWakeAtMs: START,
          oldestLiveTaskAgeMs: LATER - START,
          corrupt: [
            { field: 'runs.available_at_ms', runId: seeded.due.runId, ...outOfRange, value: '-1' },
            {
              field: 'runs.claim_expires_at_ms',
              runId: seeded.running.runId,
              ...outOfRange,
              value: String(MAX_EPOCH_MS + 1),
            },
            {
              field: 'tasks.cancel_at_ms',
              taskId: seeded.doomed.taskId,
              ...outOfRange,
              value: '-5',
            },
          ],
        })
        // The engine takes none of the three: its own predicates hold each instant to its
        // bounds. So the finder lists none of them, and what it does list is what the
        // engine takes.
        const { sleepingPastWake, leaseLapsed } = legsAtLater(seeded)
        expect(await reads.stuckRuns(Q, { graceSeconds: 0, limit: 10 })).toEqual(
          report(LATER, { sleepingPastWake, leaseLapsed: all(...leaseLapsed.rows.slice(1)) }),
        )
        const reached = nothingReached()
        await finderAgainstTheEngine(f, 'beside three corrupt rows', 'corrupt', reached)
        expect(reached).toEqual({ ...nothingReached(), sleepingPastWake: 2, lostLaunches: 1 })
      }))

    it('lists the live tasks of a queue enqueued at least so long ago, oldest first, each with its age, and no task that ended', () =>
      inWorld('queue-aged', async (world) => {
        const { f, at } = world
        // A task that ended, and then three that stay live, enqueued a second apart: one a
        // worker holds, one parked on an event nobody emits, and one that waits its turn.
        await spawn(f, 'ended')
        const ending = await claimActivated(f.store, Q, 'w-ended')
        await f.store.complete(Q, ending.runId, ending.claimToken, '{}')
        const held = await spawn(f, 'held')
        await claimActivated(f.store, Q, 'w-held')
        await at(START + 1_000)
        const parked = await spawn(f, 'parked')
        const parking = await claimActivated(f.store, Q, 'w-parked')
        expect(await awaitOwned(f.store, Q, parking, 'approve', 'approval', null)).toEqual({
          emitted: false,
        })
        await at(START + 2_000)
        const waiting = await spawn(f, 'waits-its-turn')
        await f.store.spawn('another-queue', 'job', '{}')
        const now = START + 10_000
        await at(now)
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        const before = await snapshot(f.raw)
        const live = (task: Spawned, taskName: string, state: string, enqueueAtMs: number) => ({
          taskId: task.taskId,
          taskName,
          state,
          enqueueAtMs,
          ageMs: now - enqueueAtMs,
        })
        const oldest = [
          live(held, 'held', 'running', START),
          live(parked, 'parked', 'sleeping', START + 1_000),
          live(waiting, 'waits-its-turn', 'pending', START + 2_000),
        ]
        const listing = (rows: unknown[], atLeast = false) => ({
          nowMs: now,
          fakeClock: true,
          tasks: { rows, atLeast },
          corrupt: [],
        })
        expect(
          await reads.agedTasks(Q, { olderThanSeconds: 0, limit: 10 }),
          'mutation-verdict:behavior:operator-aged-answers-a-seeded-queue',
        ).toEqual(listing(oldest))
        // A task is listed from the instant it is as old as asked. The parked one is nine
        // seconds old.
        expect(
          await reads.agedTasks(Q, { olderThanSeconds: 9, limit: 10 }),
          'mutation-verdict:behavior:operator-aged-lists-a-task-at-the-instant-it-is-as-old-as-asked',
        ).toEqual(listing(oldest.slice(0, 2)))
        expect(await reads.agedTasks(Q, { olderThanSeconds: 9.001, limit: 10 })).toEqual(
          listing(oldest.slice(0, 1)),
        )
        expect(await reads.agedTasks(Q, { olderThanSeconds: 11, limit: 10 })).toEqual(listing([]))
        // A limit lists the oldest, and says that more are as old.
        expect(
          await reads.agedTasks(Q, { olderThanSeconds: 0, limit: 2 }),
          'mutation-verdict:behavior:operator-aged-stops-at-its-limit',
        ).toEqual(listing(oldest.slice(0, 2), true))
        expect(await reads.agedTasks(Q, { olderThanSeconds: 0, limit: 3 })).toEqual(listing(oldest))
        // Another queue's task is its own queue's, and an empty queue has none.
        const elsewhere = await reads.agedTasks('another-queue', { olderThanSeconds: 0, limit: 10 })
        expect(elsewhere.tasks.rows.map((task) => task.taskName)).toEqual(['job'])
        expect(await reads.agedTasks('an-empty-queue', { olderThanSeconds: 0, limit: 10 })).toEqual(
          listing([]),
        )
        const status = await reads.queueStatus(Q)
        expect({
          liveTasks: status.gauges.liveTasks,
          oldestLiveTaskAgeMs: status.oldestLiveTaskAgeMs,
        }).toEqual({ liveTasks: exactly(3), oldestLiveTaskAgeMs: 10_000 })
        // Every reading is a batch of reads, and nothing was written.
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set(['aged-tasks/read', 'fake-clock/read', 'queue-status/read']),
        )
        expect(await snapshot(f.raw)).toEqual(before)
        // Fixture-built: no engine path writes an enqueue instant outside its bounds. The
        // task is listed however old was asked, with no age, and named, and the gauge still
        // counts it and dates the oldest from the rest.
        await f.raw.batch('fixture:out-of-bounds', [
          { sql: 'UPDATE tasks SET enqueue_at_ms = -9 WHERE task_id = ?', args: [waiting.taskId] },
        ])
        const entry = {
          field: 'tasks.enqueue_at_ms',
          taskId: waiting.taskId,
          reason: 'out-of-range',
          stored: 'number',
          value: '-9',
        }
        expect(
          await reads.agedTasks(Q, { olderThanSeconds: 3600, limit: 10 }),
          'mutation-verdict:behavior:operator-aged-lists-a-task-whose-enqueue-instant-is-outside-its-bounds',
        ).toEqual({
          ...listing([
            {
              taskId: waiting.taskId,
              taskName: 'waits-its-turn',
              state: 'pending',
              enqueueAtMs: null,
              ageMs: null,
            },
          ]),
          corrupt: [entry],
        })
        const beside = await reads.queueStatus(Q)
        expect({
          liveTasks: beside.gauges.liveTasks,
          oldestLiveTaskAgeMs: beside.oldestLiveTaskAgeMs,
          corrupt: beside.corrupt,
        }).toEqual({ liveTasks: exactly(3), oldestLiveTaskAgeMs: 10_000, corrupt: [entry] })
      }))

    it(
      'stops a leg at its limit and a gauge at its cap, beside a thousand and one due runs',
      () =>
        inWorld('queue-caps', async ({ f }) => {
          const past = OPERATOR_GAUGE_CAP + 1
          const runs: string[] = []
          let spawned = 0
          await Promise.all(
            Array.from({ length: 16 }, async () => {
              while (spawned < past) {
                spawned += 1
                runs.push((await spawn(f, 'job')).runId)
              }
            }),
          )
          const reads = f.operatorReadsOver(f.raw)
          const capped = { count: OPERATOR_GAUGE_CAP, atLeast: true }
          const status = await reads.queueStatus(Q)
          expect(
            {
              pendingRuns: status.gauges.pendingRuns,
              pendingRunsDue: status.gauges.pendingRunsDue,
            },
            'mutation-verdict:behavior:operator-gauges-stop-at-the-cap',
          ).toEqual({ pendingRuns: capped, pendingRunsDue: capped })
          // Every run came due at one instant, so the oldest are the least by id.
          const few = await reads.stuckRuns(Q, { graceSeconds: 0, limit: 5 })
          expect(
            {
              runs: few.dueUnclaimed.rows.map((run) => run.runId),
              atLeast: few.dueUnclaimed.atLeast,
            },
            'mutation-verdict:behavior:operator-finder-stops-a-leg-at-its-limit',
          ).toEqual({ runs: sorted(runs).slice(0, 5), atLeast: true })
          const many = await reads.stuckRuns(Q, { graceSeconds: 0, limit: OPERATOR_LIST_CAP })
          expect({
            runs: many.dueUnclaimed.rows.length,
            atLeast: many.dueUnclaimed.atLeast,
          }).toEqual({ runs: OPERATOR_LIST_CAP, atLeast: true })
          // Every task is live, so the gauge of live tasks stops at its cap too, and the read
          // of the oldest at the most a caller may ask for.
          expect(
            status.gauges.liveTasks,
            'mutation-verdict:behavior:operator-gauge-of-live-tasks-stops-at-the-cap',
          ).toEqual(capped)
          const oldest = await reads.agedTasks(Q, { olderThanSeconds: 0, limit: OPERATOR_LIST_CAP })
          expect({ tasks: oldest.tasks.rows.length, atLeast: oldest.tasks.atLeast }).toEqual({
            tasks: OPERATOR_LIST_CAP,
            atLeast: true,
          })
          // A count of rows stops far higher, so it is exact here.
          const rows = await reads.tableRows(Q)
          expect({ tasks: rows.tables.tasks, runs: rows.tables.runs }).toEqual({
            tasks: exactly(past),
            runs: exactly(past),
          })
        }),
      120_000,
    )

    it(
      "stops the list of an event's waiters at the cap, beside a thousand and one waits, fixture-built",
      () =>
        inWorld('queue-waiters-cap', async ({ f }) => {
          // Fixture-built: a wait is registered by a claimed run, and these stand alone.
          const past = OPERATOR_GAUGE_CAP + 1
          const tasks = Array.from(
            { length: past },
            (_, row) => `crowd-${String(row).padStart(4, '0')}`,
          )
          for (let from = 0; from < past; from += 100) {
            await f.raw.batch(
              'fixture:waits',
              tasks.slice(from, from + 100).map((taskId) => ({
                sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                      timeout_at_ms, created_at_ms)
                    VALUES (?, 'approve', ?, ?, 'crowded', 'waiting', NULL, ?)`,
                args: [`run-of-${taskId}`, Q, taskId, START],
              })),
            )
          }
          const answer = await f.operatorReadsOver(f.raw).eventWaiters(Q, 'crowded')
          expect(
            {
              waiters: answer.waiters.rows.map((waiter) => waiter.taskId),
              atLeast: answer.waiters.atLeast,
            },
            'mutation-verdict:behavior:operator-waiters-stop-at-the-cap',
          ).toEqual({ waiters: tasks.slice(0, OPERATOR_GAUGE_CAP), atLeast: true })
        }),
      60_000,
    )

    it('reports the server clock when the test clock is not set', () =>
      inWorld('queue-real-clock', async (world) => {
        const { f } = world
        await seededQueue(world)
        await f.admin.setFakeNowEpochMs(null)
        const reads = f.operatorReadsOver(f.raw)
        const owed = await reads.stuckRuns(Q, { graceSeconds: 0, limit: 10 })
        const status = await reads.queueStatus(Q)
        expect({ owed: owed.fakeClock, status: status.fakeClock }).toEqual({
          owed: false,
          status: false,
        })
        // The server's own clock, which is this century's and not the instant a test wrote,
        // so everything that was spawned at that instant is long overdue.
        expect(owed.nowMs).toBeGreaterThan(1_600_000_000_000)
        expect(status.nowMs).toBeGreaterThan(1_600_000_000_000)
        expect(owed.dueUnclaimed.rows.length).toBe(2)
        expect(status.gauges.runningRunsLapsed).toEqual(exactly(2))
        // Every task of the seed is live, and far older than an hour by that clock.
        const aged = await reads.agedTasks(Q, { olderThanSeconds: 3600, limit: 10 })
        expect({ fakeClock: aged.fakeClock, tasks: aged.tasks.rows.length }).toEqual({
          fakeClock: false,
          tasks: 8,
        })
        expect(aged.nowMs).toBeGreaterThan(1_600_000_000_000)
      }))
  })
}
