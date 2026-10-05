import {
  type AgedTask,
  type AgedTasks,
  type Capped,
  type Gauge,
  type LapsedRun,
  OPERATOR_GAUGE_CAP,
  type OverdueRun,
  type OverdueTask,
  type QueueStatus,
  type StuckRuns,
  type TableRows,
  type UnadmittedRun,
  type UncancelledTask,
  type UnreclaimedRun,
  type Windowed,
} from '@durablerun/core'
import { type Printed, corruptView } from './inspect.js'

/**
 * What `stuck`, `stats` and `sizes` print of one queue. Nothing here is a value a user
 * wrote: a row is ids, a task name, a state the statement held to a live one, an ordinal,
 * instants and flags, and a gauge is a count. So nothing here is redacted, and `--reveal`
 * changes nothing these print.
 */

const overdueRunView = (run: OverdueRun): Printed<OverdueRun> => ({
  runId: run.runId,
  taskId: run.taskId,
  taskName: run.taskName,
  attempt: run.attempt,
  dueAtMs: run.dueAtMs,
  lateByMs: run.lateByMs,
})

const unadmittedRunView = (run: UnadmittedRun): Printed<UnadmittedRun> => ({
  runId: run.runId,
  taskId: run.taskId,
  state: run.state,
  attempt: run.attempt,
  dueAtMs: run.dueAtMs,
  lateByMs: run.lateByMs,
})

const unreclaimedRunView = (run: UnreclaimedRun): Printed<UnreclaimedRun> => ({
  runId: run.runId,
  taskId: run.taskId,
  attempt: run.attempt,
  dueAtMs: run.dueAtMs,
  lateByMs: run.lateByMs,
})

const uncancelledTaskView = (task: UncancelledTask): Printed<UncancelledTask> => ({
  taskId: task.taskId,
  taskName: task.taskName,
  state: task.state,
  dueAtMs: task.dueAtMs,
  lateByMs: task.lateByMs,
})

const lapsedRunView = (run: LapsedRun): Printed<LapsedRun> => ({
  ...overdueRunView(run),
  activated: run.activated,
})

const overdueTaskView = (task: OverdueTask): Printed<OverdueTask> => ({
  taskId: task.taskId,
  taskName: task.taskName,
  state: task.state,
  runId: task.runId,
  dueAtMs: task.dueAtMs,
  lateByMs: task.lateByMs,
})

/** One leg: its rows, and whether the queue holds more of them than it lists. */
const legView = <Row>(leg: Capped<Row>, view: (row: Row) => unknown): Printed<Capped<Row>> => ({
  rows: leg.rows.map(view),
  atLeast: leg.atLeast,
})

/** One leg of what the engine does not take: the same, and whether its window left rows unsettled. */
const windowView = <Row>(
  leg: Windowed<Row>,
  view: (row: Row) => unknown,
): Printed<Windowed<Row>> => ({
  rows: leg.rows.map(view),
  atLeast: leg.atLeast,
  unexamined: leg.unexamined,
})

/**
 * How many rows the legs list between them, which is what `--fail-if-any` asks about. A row
 * can be in two legs: a run under a lapsed lease whose task is also past its deadline, and
 * a run the engine does not take whose task the sweep cancels, which is listed as a run
 * and as a task.
 */
export const rowsListed = (owed: StuckRuns): number =>
  owed.dueUnclaimed.rows.length +
  owed.sleepingPastWake.rows.length +
  owed.dueNotAdmitted.rows.length +
  owed.leaseLapsed.rows.length +
  owed.lapsedNotReclaimed.rows.length +
  owed.cancelOverdue.rows.length +
  owed.deadlineNotCancelled.rows.length

/** What `stuck` prints of what the driver owes a queue, every member of it. */
export function stuckView(
  owed: StuckRuns,
): Printed<Omit<StuckRuns, 'nowMs'>> & { readonly databaseNowEpochMs: unknown } {
  return {
    databaseNowEpochMs: owed.nowMs,
    fakeClock: owed.fakeClock,
    dueUnclaimed: legView(owed.dueUnclaimed, overdueRunView),
    sleepingPastWake: legView(owed.sleepingPastWake, overdueRunView),
    dueNotAdmitted: windowView(owed.dueNotAdmitted, unadmittedRunView),
    leaseLapsed: legView(owed.leaseLapsed, lapsedRunView),
    lapsedNotReclaimed: windowView(owed.lapsedNotReclaimed, unreclaimedRunView),
    cancelOverdue: legView(owed.cancelOverdue, overdueTaskView),
    deadlineNotCancelled: windowView(owed.deadlineNotCancelled, uncancelledTaskView),
    corrupt: owed.corrupt.map(corruptView),
  }
}

const agedTaskView = (task: AgedTask): Printed<AgedTask> => ({
  taskId: task.taskId,
  taskName: task.taskName,
  state: task.state,
  enqueueAtMs: task.enqueueAtMs,
  ageMs: task.ageMs,
})

/**
 * What `stuck --older-than` adds to its report, under `agedLive`: the live tasks enqueued
 * at least that long ago, oldest first, each with its age. It is read after the legs, in
 * a snapshot of its own, so it prints the database time it was read at. An age is not a
 * defect: a row here says a task has been live that long, and nothing about why.
 */
export function agedLiveView(
  aged: AgedTasks,
  olderThanSeconds: number,
): Printed<Omit<AgedTasks, 'nowMs' | 'tasks'> & Capped<AgedTask>> & {
  readonly olderThanSeconds: number
  readonly databaseNowEpochMs: unknown
} {
  return {
    olderThanSeconds,
    databaseNowEpochMs: aged.nowMs,
    fakeClock: aged.fakeClock,
    rows: aged.tasks.rows.map(agedTaskView),
    atLeast: aged.tasks.atLeast,
    corrupt: aged.corrupt.map(corruptView),
  }
}

const gaugeView = (gauge: Gauge): Printed<Gauge> => ({ count: gauge.count, atLeast: gauge.atLeast })

/** Every gauge of a set, each under its own name, so a gauge core adds prints with no line here. */
const gaugesView = <Name extends string>(
  gauges: Readonly<Record<Name, Gauge>>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries<Gauge>(gauges).map(([name, gauge]) => [name, gaugeView(gauge)]))

/**
 * What `stats` prints of a queue's state, every member of it, with the cap of its gauges
 * and one word for the whole: `quiet` when every gauge is zero, and `active` otherwise. It
 * never says a queue is well. `quiet` says the queue holds no live task, and that is as
 * true of a queue whose driver has stopped with nothing enqueued as of a healthy idle one.
 * `active` says only that some gauge is not zero. A queue whose every run waits on an
 * event nobody emits is `active`, by the gauge of its live tasks, and the word says
 * nothing of whether its work is moving.
 */
export function statsView(status: QueueStatus): Printed<Omit<QueueStatus, 'nowMs'>> & {
  readonly databaseNowEpochMs: unknown
  readonly summary: 'quiet' | 'active'
  readonly gaugeCap: number
} {
  return {
    databaseNowEpochMs: status.nowMs,
    fakeClock: status.fakeClock,
    summary: Object.values(status.gauges).every((gauge) => gauge.count === 0) ? 'quiet' : 'active',
    gaugeCap: OPERATOR_GAUGE_CAP,
    gauges: gaugesView(status.gauges),
    claimLagMs: status.claimLagMs,
    leaseHeadroomMs: status.leaseHeadroomMs,
    nextWakeAtMs: status.nextWakeAtMs,
    oldestLiveTaskAgeMs: status.oldestLiveTaskAgeMs,
    corrupt: status.corrupt.map(corruptView),
  }
}

/** What `sizes` prints: the cap, and each table's count of the queue's rows. */
export function sizesView(rows: TableRows): Printed<TableRows> {
  return { cap: rows.cap, tables: gaugesView(rows.tables) }
}
