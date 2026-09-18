import { type Expression, expressionBuilder } from 'kysely'
import { SUCCESSOR_CARRIED_RUN_COLUMNS } from '../contract.js'
import { type SqlFragment, fenceValue, insertedFrom, rawSql, stampValue } from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'

type Runs = StoreTables['runs']
type CarriedColumn = (typeof SUCCESSOR_CARRIED_RUN_COLUMNS)[number]

/**
 * The names a run insert reads. `f` is the row this batch stamped, a run or a task, and
 * `p` is the task's top run when `f` is the task. Every column named through this
 * builder exists on whichever table the name stands for.
 */
const sources = () => expressionBuilder<{ f: Runs; p: Runs }, 'f' | 'p'>()

/** The columns a new run carries, copied unchanged from the run `alias` names. */
function carriedFrom(alias: 'f' | 'p'): Record<CarriedColumn, Expression<string | null>> {
  const eb = sources()
  const carried = SUCCESSOR_CARRIED_RUN_COLUMNS.map((c) => [c, eb.ref(`${alias}.${c}`)] as const)
  const record: Partial<Record<CarriedColumn, Expression<string | null>>> = {}
  for (const [column, value] of carried) record[column] = value
  return record as Record<CarriedColumn, Expression<string | null>>
}

/**
 * The one record every insert of a run is built from, so the four of them cannot fall
 * out of step: spawn's first run, the two failure successors, and a revival. The new
 * run takes its queue, its task, its creation instant, and its provenance instant from
 * the fenced row `f`, and never from the clock.
 */
export function insertedRun(run: {
  runId: string
  attempt: Expression<number | bigint>
  state: Expression<string>
  availableAt: Expression<number | bigint | null>
  /** The run whose parked wake and run database the new run carries, if any. */
  carriedFrom: 'f' | 'p' | null
}) {
  const eb = sources()
  return insertedFrom({
    run_id: eb.val(run.runId),
    queue: eb.ref('f.queue'),
    task_id: eb.ref('f.task_id'),
    attempt: run.attempt,
    state: run.state,
    available_at_ms: run.availableAt,
    created_at_ms: eb.ref('f.fence_at_ms'),
    ...(run.carriedFrom === null ? {} : carriedFrom(run.carriedFrom)),
    fence_stamp: stampValue,
    fence_at_ms: eb.ref('f.fence_at_ms'),
  })
}

/** What a store passes to insert the successor of a run its batch failed. */
export type FailureSuccessor = {
  successorId: string
  /** The run this batch failed, under the compare-and-set named `fail`. */
  runId: string
  /**
   * How long after the failed run's instant the successor is due. The store holds it
   * beside the headroom guard in the compare-and-set that protects the addition, so the
   * two are read together. The addition itself is built here, from nodes, so a follow-on
   * insert passes no value fragment and the plain-selection rule can read every value.
   */
  delayMs: number
  /** The store's join of the failed run `f` to the task `t` that owns it. */
  taskOwnsRun: SqlFragment
  /** What the store requires of the task `t` and the run `f` for a successor to follow. */
  admission: SqlFragment
  /** No run already holds the successor's identity: its id, its task, and its ordinal. */
  successorFree: SqlFragment
}

/**
 * The successor of a failed run: the next attempt, carrying the run database and any
 * parked wake. It is a plain insert with no conflict clause, so a collision with a
 * foreign row fails loudly. Its instants are the failed run's own, so a delay runs from
 * the moment of failure and not from a second clock read.
 */
export function failureSuccessor(binds: FailureSuccessor, state: Expression<string>) {
  const eb = sources()
  const { columns, selections } = insertedRun({
    runId: binds.successorId,
    attempt: eb('f.attempt', '+', 1),
    state,
    availableAt: eb('f.fence_at_ms', '+', binds.delayMs),
    carriedFrom: 'f',
  })
  return treeBuilder
    .insertInto('runs')
    .columns(columns)
    .expression(
      treeBuilder
        .selectFrom('runs as f')
        .innerJoin('tasks as t', (join) => join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')))
        .select(selections)
        .where('f.run_id', '=', binds.runId)
        .where('f.fence_stamp', '=', fenceValue('fail'))
        .where(rawSql<boolean>(binds.admission, 'predicate'))
        .where(rawSql<boolean>(binds.successorFree, 'predicate')),
    )
}
