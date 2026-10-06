import { expressionBuilder } from 'kysely'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  rawSql,
  sqlFragment,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { whereTaskInQueue } from './claimed-run.js'
import { insertedRun } from './successor.js'

/**
 * The conjuncts of `retry-task`'s admission that a store writes, each under a name, in the
 * order the guard holds them. A store hands core one predicate over the row `tasks` for
 * each, and the guard is those predicates and nothing else (`retryAdmission`). The
 * operator's read of what the engine's guards say of a task selects each of them as a flag
 * of its own, so a refusal is named by the guard's own conjuncts and by no second account
 * of them.
 */
export const RETRY_CONJUNCTS = [
  'ownsEveryRun',
  'hasAFailureReason',
  'hasNoCompletedPayload',
  'hasARun',
  'hasNoLiveRun',
  'attemptsInRange',
  'infraRetriesInRange',
  'everyRunOrdinalInRange',
  'budgetTakesOneMore',
  'chargeIsTheAttemptsOrOneMore',
  'sagaNotBegun',
  'chargeWithinBudget',
] as const
export type RetryConjunct = (typeof RETRY_CONJUNCTS)[number]

/** What a store hands core for the retry guard: one predicate over the row `tasks` to a conjunct, with no bind. */
export type RetryConjuncts = Readonly<Record<RetryConjunct, SqlFragment>>

/**
 * Every conjunct of the retry guard: `failed`, which `reviveCas` holds itself, and then
 * the store's. The guard also names the task by its id and its queue, and a task that is
 * not there has no conjunct to read.
 */
export const RETRY_GUARD = ['failed', ...RETRY_CONJUNCTS] as const
export type RetryGuardConjunct = (typeof RETRY_GUARD)[number]

/**
 * The conjuncts that compute with counters, each beside the conjuncts that hold those
 * counters to their range. The computation is made only where they hold. On a row whose
 * counter is at the edge of what its column stores, the subtraction overflows the column's
 * type, which one dialect answers with an error and another with a value that is no
 * integer. The guard and the operator's read of it are both built from this table, so
 * neither computes where the other does not.
 */
export const RETRY_CONJUNCT_COMPUTES_WITH: Partial<
  Record<RetryGuardConjunct, readonly RetryConjunct[]>
> = {
  chargeIsTheAttemptsOrOneMore: [
    'attemptsInRange',
    'infraRetriesInRange',
    'everyRunOrdinalInRange',
  ],
  chargeWithinBudget: ['infraRetriesInRange', 'everyRunOrdinalInRange'],
}

/**
 * The admission `reviveCas` takes: the store's conjuncts, every one of them, joined by AND
 * in the list's order. A store builds its admission here, so the guard cannot hold a
 * conjunct the list does not name, or leave one out. A conjunct that computes with
 * counters is held inside a CASE on their ranges: a CASE computes a result only where its
 * condition holds, which AND does not promise.
 */
export function retryAdmission(conjuncts: RetryConjuncts): SqlFragment {
  const written = (name: RetryConjunct): string => {
    const { sql, args } = conjuncts[name]
    if (args.length > 0) throw new TypeError(`the retry guard's ${name} carries a bind`)
    return sql
  }
  const held = RETRY_CONJUNCTS.map((name) => {
    const under = RETRY_CONJUNCT_COMPUTES_WITH[name] ?? []
    if (under.length === 0) return written(name)
    const inRange = under.map((counter) => `(${written(counter)})`).join(' AND ')
    return `CASE WHEN ${inRange} THEN CASE WHEN ${written(name)} THEN 1 ELSE 0 END ELSE 0 END = 1`
  })
  return sqlFragment(held.join('\n         AND '))
}

/**
 * `retry-task`'s compare-and-set: a task returns to pending, charged for its top run,
 * with one more attempt in its budget and its reason cleared. It requires the failed
 * state itself and consumes it, so a replay matches nothing and cannot raise the budget
 * twice. The store's admission predicate requires a well-formed failure, which a
 * registered mutation owns as store text, and says what the task's runs and counters
 * must look like. The store computes the charge.
 */
export const reviveCas = defineStatement(
  'retry-task',
  (binds: {
    queue: string
    taskId: string
    /** The revival run, recorded as the task's last attempt. */
    runId: string
    /** The user attempts the task is charged with: its top ordinal net of infrastructure retries. */
    charged: SqlFragment
    admission: SqlFragment
  }) =>
    treeBuilder
      .updateTable('tasks')
      .set((eb) => ({
        state: 'pending',
        attempts: rawSql<number>(binds.charged, 'value'),
        max_attempts: eb('max_attempts', '+', 1),
        failure_reason: null,
        last_attempt_run: binds.runId,
        ...FENCE_ASSIGNMENTS,
      }))
      .$call(whereTaskInQueue(binds))
      .where('state', '=', 'failed')
      .where(rawSql<boolean>(binds.admission, 'predicate')),
)

/**
 * `retry-task`'s revival run, for the task this batch revived under the compare-and-set
 * named `revive`: one attempt past the task's top run `p`, carrying what that run
 * carried, and due at the revival's own instant.
 */
export const revivalRunInsert = defineStatement(
  'retry-task run',
  (binds: {
    runId: string
    taskId: string
    /** The store's join of a run `p` to the revived task `f` that owns it. */
    taskOwnsRun: SqlFragment
    /** The run `p` is the task's top attempt. */
    isTopRun: SqlFragment
    /** The task has no live run, which an exact replay of the revival would find. */
    noLiveRun: SqlFragment
  }) => {
    const eb = expressionBuilder<{ f: StoreTables['tasks']; p: StoreTables['runs'] }, 'f' | 'p'>()
    const { columns, selections } = insertedRun({
      runId: binds.runId,
      attempt: eb('p.attempt', '+', 1),
      state: eb.val('pending'),
      availableAt: eb.ref('f.fence_at_ms'),
      carriedFrom: 'p',
    })
    return treeBuilder
      .insertInto('runs')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('tasks as f')
          .innerJoin('runs as p', (join) =>
            join.on(rawSql<boolean>(binds.taskOwnsRun, 'predicate')),
          )
          .select(selections)
          .where('f.task_id', '=', binds.taskId)
          .where('f.fence_stamp', '=', fenceValue('revive'))
          .where(rawSql<boolean>(binds.isTopRun, 'predicate'))
          .where(rawSql<boolean>(binds.noLiveRun, 'predicate')),
      )
  },
)

/** `retry-task`'s read of the run this batch inserted, under the follow-on named `run`. */
export const revivedRunRead = defineStatement('retry-task revived', (binds: { runId: string }) =>
  treeBuilder
    .selectFrom('runs')
    .select('attempt')
    .where('run_id', '=', binds.runId)
    .where('fence_stamp', '=', fenceValue('run')),
)
