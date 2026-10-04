import {
  type Capped,
  type Gauge,
  type LapsedRun,
  OPERATOR_GAUGE_CAP,
  type OverdueRun,
  type OverdueTask,
  type QueueStatus,
  type StuckRuns,
  type TableRows,
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

/** The legs of `stuck`, by the name each prints under, with how many rows each lists. */
const listedIn = (owed: StuckRuns): readonly number[] => [
  owed.dueUnclaimed.rows.length,
  owed.sleepingPastWake.rows.length,
  owed.leaseLapsed.rows.length,
  owed.cancelOverdue.rows.length,
]

/**
 * How many rows the legs list between them, which is what `--fail-if-any` asks about. A run
 * under a lapsed lease whose task is also past its deadline is a row of two legs.
 */
export const rowsListed = (owed: StuckRuns): number =>
  listedIn(owed).reduce((sum, rows) => sum + rows, 0)

/** What `stuck` prints of what the driver owes a queue, every member of it. */
export function stuckView(
  owed: StuckRuns,
): Printed<Omit<StuckRuns, 'nowMs'>> & { readonly databaseNowEpochMs: unknown } {
  return {
    databaseNowEpochMs: owed.nowMs,
    fakeClock: owed.fakeClock,
    dueUnclaimed: legView(owed.dueUnclaimed, overdueRunView),
    sleepingPastWake: legView(owed.sleepingPastWake, overdueRunView),
    leaseLapsed: legView(owed.leaseLapsed, lapsedRunView),
    cancelOverdue: legView(owed.cancelOverdue, overdueTaskView),
    corrupt: owed.corrupt.map(corruptView),
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
 * never says a queue is well. A gauge counts rows by their state and their instant, so a
 * queue whose every run waits on an event nobody emits is `quiet`, and so is one whose
 * driver has stopped with nothing enqueued.
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
    corrupt: status.corrupt.map(corruptView),
  }
}

/** What `sizes` prints: the cap, and each table's count of the queue's rows. */
export function sizesView(rows: TableRows): Printed<TableRows> {
  return { cap: rows.cap, tables: gaugesView(rows.tables) }
}
