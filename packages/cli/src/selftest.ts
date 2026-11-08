import {
  MAX_RUN_ORDINAL,
  MIN_RETENTION_SECONDS,
  OPERATOR_LIST_CAP,
  PURGE_BARRIER_CONDITIONS,
  type RetentionPolicy,
} from '@durablerun/core'
import { COMMANDS, NOT_SENT_BY_SELFTEST, type PortUse } from './commands.js'
import type { OpenedStore } from './open-store.js'

/**
 * What `selftest` does: the calls it makes against a queue of its own, in order, and what
 * the engine answers to each on a database that takes every batch a command sends. It
 * exists for a branch or a snapshot of a database, before a migration or a first purge:
 * each batch below is one a command of this CLI sends, and a database that refuses one, or
 * answers it otherwise, is found here and not during an incident.
 *
 * It writes two tasks and one event, all its own, and it deletes nothing. Nothing else may
 * work the queue while it runs: a worker that claims one of its tasks between two calls
 * shows as an answer that is not the expected one. One task is
 * cancelled by a sweep, through a cancellation deadline that passes as it is spawned, and
 * the other by a cancellation. The purge it sends is of that second task, which ended a
 * moment ago, so the barrier refuses it and the answer says so.
 *
 * Every check reads the state a call left and not the call's own answer where the two can
 * differ, so a store that delivers a batch twice still passes: the second delivery of a
 * fenced batch writes nothing.
 *
 * Five calls answer of this queue what they answer of an empty one: the read of
 * checkpoints, the read of an event's waits, the revival, the listing of what a purge may
 * take and the purge. What would tell the two apart is a run a worker claimed, or a unit a
 * window old, and selftest makes neither. Of those five it shows that the database takes
 * the batch and answers nothing, and no more.
 */

/** The task name both tasks are spawned under. No handler is registered for it, and none runs. */
export const SELFTEST_TASK = 'selftest'

/** The policy of the purge selftest sends: every state at the shortest window a policy takes. */
const POLICY: RetentionPolicy = Object.freeze({
  completedSeconds: MIN_RETENTION_SECONDS,
  cancelledSeconds: MIN_RETENTION_SECONDS,
  failedSeconds: MIN_RETENTION_SECONDS,
})

/** What one run of selftest names: its queue, and the id its keys and its event are made from. */
export interface SelftestNames {
  readonly queue: string
  readonly runId: string
}

export interface SelftestStep {
  /** The call the step is for, as the command table declares it, with its batch labels. */
  readonly port: PortUse
  /** What the step sends, in a few words. */
  readonly sends: string
  /** Null when the call answered as the engine does, or what it answered instead. */
  run(): Promise<string | null>
}

/** The call of that name as the command table declares it for selftest. */
function declared(call: PortUse['call']): PortUse {
  const port = COMMANDS.selftest.ports.find((use) => use.call === call)
  if (port === undefined) throw new Error(`the command table declares no ${call} for selftest`)
  return port
}

/**
 * A difference between what a call answered and what the engine answers, in words, or null
 * for none. The two are compared and printed as JSON, so a caller hands it only what may
 * print: counts, flags, ids and names of the engine's own. A text a row stores is compared
 * before it gets here, and what arrives is whether it matched.
 */
function differs(what: string, found: unknown, expected: unknown): string | null {
  const [was, wanted] = [JSON.stringify(found), JSON.stringify(expected)]
  return was === wanted ? null : `${what} is ${was}, not ${wanted}`
}

/** The first of several checks that names a difference, or null. */
const first = (...checks: readonly (string | null)[]): string | null =>
  checks.find((check) => check !== null) ?? null

/**
 * The steps of one run, in the order they run. Each holds what the steps before it made:
 * the two tasks, and the run of the first.
 */
export function selftestSteps(
  store: Pick<OpenedStore, 'admin' | 'scheduler' | 'operator' | 'retention'>,
  { queue, runId }: SelftestNames,
): SelftestStep[] {
  const { admin, scheduler, operator, retention } = store
  const keyOfA = `selftest-${runId}-a`
  const keyOfB = `selftest-${runId}-b`
  const event = `selftest-${runId}`
  const payload = JSON.stringify({ selftest: runId })
  let a = ''
  let b = ''
  let runOfA = ''
  const unitOfA = () => ({ taskId: a, idempotencyKey: keyOfA })
  /** A task's state as the store's decoder answers it, which refuses a state that is not the engine's own. */
  const stateOf = async (taskId: string): Promise<string | null> =>
    (await scheduler.getTaskResult(queue, taskId))?.state ?? null
  /** The queue's row counts, table by table in the order of the tables' names. */
  const rowsOf = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      Object.entries((await operator.tableRows(queue)).tables)
        .map(([table, gauge]): [string, number] => [table, gauge.count])
        .sort(([left], [right]) => (left < right ? -1 : 1)),
    )
  const step = (
    call: PortUse['call'],
    sends: string,
    run: () => Promise<string | null>,
  ): SelftestStep => ({ port: declared(call), sends, run })

  return [
    step('admin.nowEpochMs', "a read of the database's clock", async () => {
      const now = await admin.nowEpochMs()
      return Number.isSafeInteger(now) ? null : `the clock answered ${JSON.stringify(now)}`
    }),
    step('scheduler.spawn', 'a spawn under a key of this run', async () => {
      a = (await scheduler.spawn(queue, SELFTEST_TASK, 'null', { idempotencyKey: keyOfA })).taskId
      return differs('the task the key finds', await operator.taskIdByKey(queue, keyOfA), a)
    }),
    step('scheduler.spawn', 'the same spawn again', async () => {
      const again = await scheduler.spawn(queue, SELFTEST_TASK, 'null', { idempotencyKey: keyOfA })
      return first(
        differs('created', again.created, false),
        differs('the task a repeated spawn answers', again.taskId, a),
      )
    }),
    step(
      'scheduler.spawn',
      'a spawn of a second task, whose cancellation deadline passes as it is spawned',
      async () => {
        const spawned = await scheduler.spawn(queue, SELFTEST_TASK, 'null', {
          idempotencyKey: keyOfB,
          cancellation: { maxDelaySeconds: 0 },
        })
        b = spawned.taskId
        return b === a ? 'a second key found the first task' : null
      },
    ),
    step('operator.taskIdByKey', 'a read of a task by its key', async () =>
      differs('the task the second key finds', await operator.taskIdByKey(queue, keyOfB), b),
    ),
    step('operator.taskFacts', 'a snapshot of the first task', async () => {
      const facts = await operator.taskFacts(queue, a)
      if (facts === null) return 'the queue does not hold the task it spawned'
      runOfA = facts.runs[0]?.runId ?? ''
      return first(
        differs(
          'whether the task holds the name it was spawned under',
          facts.task.taskName === SELFTEST_TASK,
          true,
        ),
        differs('the state', facts.task.state, 'pending'),
        differs('the number of runs', facts.runs.length, 1),
        differs("the run's state", facts.runs[0]?.state, 'pending'),
        differs('the number of values not readable', facts.corrupt.length, 0),
      )
    }),
    step('scheduler.getTaskResult', "a read of the first task's outcome", async () =>
      differs('the state', await stateOf(a), 'pending'),
    ),
    step('scheduler.getCheckpoints', "a read of the first task's checkpoints", async () =>
      differs(
        'the number of checkpoints',
        (await scheduler.getCheckpoints(queue, a, MAX_RUN_ORDINAL)).length,
        0,
      ),
    ),
    step(
      'operator.taskAdmission',
      "a read of what the engine's guards say of the first task",
      async () => {
        const admission = await operator.taskAdmission(queue, a)
        if (admission === null) return 'the queue does not hold the task it spawned'
        return first(
          differs('the state', admission.state, 'pending'),
          differs('the number of values not readable', admission.corrupt.length, 0),
        )
      },
    ),
    step(
      'operator.stuckRuns',
      'a read of what the driver owes the queue, with no grace',
      async () => {
        const owed = await operator.stuckRuns(queue, { graceSeconds: 0, limit: OPERATOR_LIST_CAP })
        return first(
          differs(
            'whether a claim would take the run of the first task',
            owed.dueUnclaimed.rows.some((run) => run.runId === runOfA),
            true,
          ),
          differs(
            'whether a sweep would cancel the second task',
            owed.cancelOverdue.rows.some((task) => task.taskId === b),
            true,
          ),
          differs('the number of values not readable', owed.corrupt.length, 0),
        )
      },
    ),
    step('operator.agedTasks', "a read of the queue's live tasks by their age", async () => {
      const aged = await operator.agedTasks(queue, {
        olderThanSeconds: 0,
        limit: OPERATOR_LIST_CAP,
      })
      return differs(
        'the live tasks',
        aged.tasks.rows.map((task) => task.taskId).sort(),
        [a, b].sort(),
      )
    }),
    step('operator.queueStatus', "a read of the queue's gauges", async () => {
      const { gauges, corrupt } = await operator.queueStatus(queue)
      return first(
        differs('the gauge of live tasks', gauges.liveTasks.count, 2),
        differs('the gauge of pending runs', gauges.pendingRuns.count, 2),
        differs('the gauge of tasks past their deadline', gauges.tasksPastTheirDeadline.count, 1),
        differs('the number of values not readable', corrupt.length, 0),
      )
    }),
    step('scheduler.nextWakeAtEpochMs', "a read of the queue's next wake", async () => {
      const next = await scheduler.nextWakeAtEpochMs(queue)
      return typeof next === 'number' ? null : `the next wake is ${JSON.stringify(next)}`
    }),
    step('scheduler.sweep', 'a sweep, which cancels the task past its deadline', async () => {
      await scheduler.sweep(queue, OPERATOR_LIST_CAP)
      return first(
        differs('the state of the task past its deadline', await stateOf(b), 'cancelled'),
        differs('the state of the task with no deadline', await stateOf(a), 'pending'),
      )
    }),
    step('operator.eventState', 'a read of whether an event of this run exists', async () =>
      differs('whether the event exists', (await operator.eventState(queue, event)).exists, false),
    ),
    step('operator.eventWaiters', 'a read of the waits on that event', async () =>
      differs(
        'the number of waits',
        (await operator.eventWaiters(queue, event)).waiters.rows.length,
        0,
      ),
    ),
    step('scheduler.emitEvent', 'an emit of that event', async () => {
      await scheduler.emitEvent(queue, event, payload)
      return differs(
        'whether the event exists',
        (await operator.eventState(queue, event)).exists,
        true,
      )
    }),
    step('operator.eventPayload', "a read of the event's stored payload", async () => {
      const stored = await operator.eventPayload(queue, event)
      return differs(
        'whether the stored payload is the one sent',
        stored.exists && stored.payloadJson === payload,
        true,
      )
    }),
    step(
      'scheduler.retryTask',
      'a revival of a task that has not failed, which the guard refuses',
      async () =>
        first(
          differs('the revival', await scheduler.retryTask(queue, a), null),
          differs('the state', await stateOf(a), 'pending'),
        ),
    ),
    step('scheduler.cancelTask', 'a cancellation of the first task', async () => {
      await scheduler.cancelTask(queue, a, { unlessSagaBegan: true })
      return differs('the state', await stateOf(a), 'cancelled')
    }),
    step('retention.purgeCandidates', 'a listing of what a purge may take', async () => {
      const page = await retention.purgeCandidates(queue, POLICY, { limit: OPERATOR_LIST_CAP })
      return differs('the number of tasks ended a window ago', page.candidates.length, 0)
    }),
    step(
      'retention.purgeUnit',
      'a purge of the first task, which ended a moment ago, so the barrier refuses it',
      async () => {
        const purged = await retention.purgeUnit(queue, unitOfA(), POLICY)
        return first(
          purged === null ? null : 'the purge took a unit that ended a moment ago',
          differs('the state', await stateOf(a), 'cancelled'),
        )
      },
    ),
    step('retention.purgeAdmission', 'a read of what the barrier says of that unit', async () => {
      const admission = await retention.purgeAdmission(queue, unitOfA(), POLICY)
      if (admission === null) return 'the queue does not hold the unit'
      const notHeld = PURGE_BARRIER_CONDITIONS.filter((condition) => !admission.holds[condition])
      return differs('the conditions that do not hold', notHeld, ['endedAWindowAgo'])
    }),
    step('operator.tableRows', "a count of the queue's rows", async () => {
      // Two tasks, each with its one run and its completion event, and the event emitted.
      return differs('the rows the queue holds', await rowsOf(), {
        checkpoints: 0,
        events: 3,
        runs: 2,
        tasks: 2,
        waits: 0,
      })
    }),
  ]
}

export type StepResult = 'ok' | 'unexpected' | 'failed' | 'not-run'

/** A step as the report prints it. */
export interface StepReport {
  readonly call: string
  readonly labels: readonly string[]
  readonly sends: string
  readonly result: StepResult
  /** What the call answered, when it is not what the engine answers. */
  readonly found?: string
}

/**
 * Each batch label selftest declares, with its result: `ok` when every step that sends it
 * passed, the result of the step that did not otherwise, and `not-run` for a label whose
 * steps were not reached.
 */
export function labelResults(steps: readonly StepReport[]): Record<string, StepResult> {
  const worst: readonly StepResult[] = ['failed', 'unexpected', 'not-run', 'ok']
  const results: Record<string, StepResult> = {}
  for (const port of COMMANDS.selftest.ports) {
    for (const label of port.labels) {
      const of = steps.filter((step) => step.labels.includes(label)).map((step) => step.result)
      results[label] = worst.find((result) => of.includes(result)) ?? 'not-run'
    }
  }
  return results
}

/** The labels selftest does not send, each with why, as the command table holds them. */
export const notSentView = (): Record<string, string> => ({ ...NOT_SENT_BY_SELFTEST })
