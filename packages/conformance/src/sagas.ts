import {
  type ClaimedRun,
  INFRA_RETRY_CAP,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  REASON_ROLLED_BACK,
  RELAUNCH_CAP,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SqlExecutor,
  type SqlRow,
  decodeRollbackTry,
  encodeRollbackTry,
} from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childTaskViolations } from './child-tasks.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { checkpointOwned, claimActivated, claimOne, refusalName } from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000
const CAUSE = '{"name":"ForwardBoom"}'
const ROLLBACK_BOOM = '{"name":"RollbackBoom"}'

async function rowsOf(raw: SqlExecutor, sql: string, args: (string | number)[] = []) {
  const [result] = await raw.batch('saga-rows', [{ sql, args }], 'read')
  return result?.rows ?? []
}

/**
 * What specs/Sagas.tla requires of any history the engine itself produced, read from the
 * saga's checkpoints (core `sagas.ts`). Like `childTaskViolations` it is not part of the
 * invariant library, which also judges rows the poison matrix writes by hand.
 *
 * - StartOrderDistinct: a start marker holds a positive index, and no two of a task share one.
 * - RollbackOnlyEligible: a rollback ran only for a step that started.
 * - SagaOnlyAfterDecision: a rollback or an attempt record exists only once the phase began.
 * - ReverseOrder: a step is rolled back only once every step that started after it is.
 * - ForwardFrozenInSaga: no forward checkpoint is as new as the phase marker, and a task
 *   in the phase never completed.
 */
export async function sagaViolations(raw: SqlExecutor): Promise<string[]> {
  const tasks = await rowsOf(raw, 'SELECT task_id, state FROM tasks')
  const checkpoints = await rowsOf(
    raw,
    'SELECT task_id, checkpoint_name, state, owner_attempt FROM checkpoints',
  )
  const violations: string[] = []
  const byTask = new Map<string, SqlRow[]>()
  for (const row of checkpoints) {
    const taskId = String(row.task_id)
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), row])
  }
  for (const task of tasks) {
    const taskId = String(task.task_id)
    const rows = byTask.get(taskId) ?? []
    const named = (prefix: string) =>
      rows.filter((row) => String(row.checkpoint_name).startsWith(prefix))
    const stepOf = (row: SqlRow, prefix: string) => String(row.checkpoint_name).slice(prefix.length)
    const marker = rows.find((row) => String(row.checkpoint_name) === SAGA_PHASE_CHECKPOINT)
    const started = new Map<string, number>()
    for (const row of named(SAGA_STARTED_PREFIX)) {
      const index = Number(row.state)
      if (!Number.isSafeInteger(index) || index < 1 || String(index) !== String(row.state)) {
        violations.push(`saga/start-index-not-a-positive-integer: ${taskId}/${row.checkpoint_name}`)
      }
      if ([...started.values()].includes(index)) {
        violations.push(`saga/start-index-shared: ${taskId}/${index}`)
      }
      started.set(stepOf(row, SAGA_STARTED_PREFIX), index)
    }
    const rolledBack = new Set(
      named(SAGA_ROLLBACK_PREFIX).map((row) => stepOf(row, SAGA_ROLLBACK_PREFIX)),
    )
    for (const step of rolledBack) {
      const index = started.get(step)
      if (index === undefined) {
        violations.push(`saga/rollback-of-a-step-that-never-started: ${taskId}/${step}`)
        continue
      }
      for (const [later, laterIndex] of started) {
        if (laterIndex > index && !rolledBack.has(later)) {
          violations.push(`saga/rollback-out-of-order: ${taskId}/${step} before ${later}`)
        }
      }
    }
    for (const row of named(SAGA_TRIES_PREFIX)) {
      if (decodeRollbackTry(String(row.state)) === null) {
        violations.push(`saga/attempt-record-undecodable: ${taskId}/${row.checkpoint_name}`)
      }
    }
    if (marker === undefined) {
      if (rolledBack.size > 0 || named(SAGA_TRIES_PREFIX).length > 0) {
        violations.push(`saga/rollback-outside-the-phase: ${taskId}`)
      }
      continue
    }
    if (String(task.state) === 'completed')
      violations.push(`saga/completed-in-the-phase: ${taskId}`)
    for (const row of rows) {
      const name = String(row.checkpoint_name)
      const ofThePhase =
        name === SAGA_PHASE_CHECKPOINT ||
        name.startsWith(SAGA_ROLLBACK_PREFIX) ||
        name.startsWith(SAGA_TRIES_PREFIX)
      if (!ofThePhase && Number(row.owner_attempt) >= Number(marker.owner_attempt)) {
        violations.push(`saga/forward-checkpoint-in-the-phase: ${taskId}/${name}`)
      }
    }
  }
  return violations
}

const startMarker = (step: string) => `${SAGA_STARTED_PREFIX}${step}`
const rollbackOf = (step: string) => `${SAGA_ROLLBACK_PREFIX}${step}`
const triesOf = (step: string, tries: number) => ({
  key: `${SAGA_TRIES_PREFIX}${step}`,
  stateJson: encodeRollbackTry({ tries, errorJson: ROLLBACK_BOOM }),
})

/** A registered step starts: its marker commits, carrying its index, before its body runs. */
function startStep(f: StoreFixture, run: ClaimedRun, step: string, index: number) {
  return checkpointOwned(f.store, Q, run, startMarker(step), String(index), 60)
}

async function taskRow(f: StoreFixture, taskId: string) {
  const [row] = await rowsOf(
    f.raw,
    'SELECT state, attempts, max_attempts, failure_reason FROM tasks WHERE task_id = ?',
    [taskId],
  )
  return row === undefined
    ? undefined
    : {
        state: String(row.state),
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        failureReason: row.failure_reason === null ? null : String(row.failure_reason),
      }
}

async function checkpointNames(f: StoreFixture, taskId: string): Promise<string[]> {
  const rows = await rowsOf(
    f.raw,
    'SELECT checkpoint_name FROM checkpoints WHERE task_id = ? ORDER BY checkpoint_name',
    [taskId],
  )
  return rows.map((row) => String(row.checkpoint_name))
}

async function doneEvents(f: StoreFixture): Promise<number> {
  const [row] = await rowsOf(f.raw, 'SELECT COUNT(*) AS n FROM events')
  return Number(row?.n)
}

/**
 * A task whose steps `steps` started and finished, in that order, and whose terminal
 * failure was then decided: it is rolling back, and the returned run is its first pass.
 */
async function rollingBack(f: StoreFixture, steps: readonly string[] = ['a']) {
  const spawned = await f.store.spawn(Q, 'saga', '{}')
  const run = await claimActivated(f.store, Q, 'w-forward')
  for (const [index, step] of steps.entries()) {
    await startStep(f, run, step, index + 1)
    await checkpointOwned(f.store, Q, run, step, `"${step}-result"`, 60)
  }
  await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
  const pass = await claimActivated(f.store, Q, 'w-pass')
  return { taskId: spawned.taskId, forward: run, pass }
}

/**
 * The executable twins of specs/Sagas.tla at the store, for every dialect, under the
 * maintainer's three answers: a cancellation in the phase halts the saga, `retry-task`
 * refuses a task whose saga began, and an infrastructure cap rolls back. The order the
 * rollbacks run in, their budgets, and what a handler receives are the SDK's, and its
 * replay harness holds them.
 */
export function sagaConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`saga conformance [${dialect}]`, () => {
    let f: StoreFixture

    beforeEach(async () => {
      f = await makeFixture('sagas')
      await f.admin.setFakeNowEpochMs(START_MS)
    })

    afterEach(async () => {
      const violations = {
        saga: await sagaViolations(f.raw),
        childTasks: await childTaskViolations(f.raw),
        engine: await engineInvariantViolations(f.raw),
      }
      await f.close()
      expect(violations).toEqual({ saga: [], childTasks: [], engine: [] })
    })

    // UserTerminal with AtomicEnter: the decision and the phase marker are one batch.
    it('enters the phase in the batch that decides the failure, and ends nothing', async () => {
      const { taskId, forward, pass } = await rollingBack(f)
      expect({
        task: await taskRow(f, taskId),
        passIsTheNextAttempt: pass.attempt === forward.attempt + 1 && pass.taskId === taskId,
        checkpoints: await checkpointNames(f, taskId),
        marker: (
          await rowsOf(
            f.raw,
            'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
            [taskId, SAGA_PHASE_CHECKPOINT],
          )
        )[0]?.state,
        completionEvents: await doneEvents(f),
        result: await f.store.getTaskResult(Q, taskId),
      }).toEqual({
        // The pass runs past the user budget, so the budget is the pass's own ordinal.
        task: { state: 'running', attempts: 1, maxAttempts: 2, failureReason: null },
        passIsTheNextAttempt: true,
        checkpoints: [SAGA_PHASE_CHECKPOINT, startMarker('a'), 'a'].sort(),
        marker: CAUSE,
        completionEvents: 0,
        result: { state: 'running' },
      })
    })

    it('a retry the user budget refuses is the same decision', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 1 })
      const run = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, run, 'a', 1)
      await f.store.fail(Q, run.runId, run.claimToken, CAUSE, { delaySeconds: 0 })
      expect({
        task: await taskRow(f, spawned.taskId),
        checkpoints: await checkpointNames(f, spawned.taskId),
      }).toEqual({
        task: { state: 'pending', attempts: 1, maxAttempts: 2, failureReason: null },
        checkpoints: [SAGA_PHASE_CHECKPOINT, startMarker('a')].sort(),
      })
    })

    it('a failure with budget left retries, and a task with nothing to roll back just fails', async () => {
      const retried = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 3 })
      const first = await claimActivated(f.store, Q, 'w-1')
      await startStep(f, first, 'a', 1)
      await f.store.fail(Q, first.runId, first.claimToken, CAUSE, { delaySeconds: 0 })
      const afterRetry = await checkpointNames(f, retried.taskId)
      const second = await claimActivated(f.store, Q, 'w-2')
      await f.store.fail(Q, second.runId, second.claimToken, CAUSE, null)
      await f.store.cancelTask(Q, retried.taskId)

      const plain = await f.store.spawn(Q, 'plain', '{}')
      const only = await claimActivated(f.store, Q, 'w-3')
      await f.store.fail(Q, only.runId, only.claimToken, CAUSE, null)
      expect({
        afterRetry,
        plain: await f.store.getTaskResult(Q, plain.taskId),
        plainCheckpoints: await checkpointNames(f, plain.taskId),
      }).toEqual({
        afterRetry: [startMarker('a')],
        plain: { state: 'failed', failureReasonJson: CAUSE },
        plainCheckpoints: [],
      })
    })

    // ForwardFrozenInSaga, and RunRollback only in the phase.
    it('freezes the forward phase, and admits a rollback only inside it', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const run = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, run, 'a', 1)
      const before = await refusalName(
        checkpointOwned(f.store, Q, run, rollbackOf('a'), 'null', 60),
      )
      await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      const pass = await claimActivated(f.store, Q, 'w-pass')
      const frozen = {
        step: await refusalName(checkpointOwned(f.store, Q, pass, 'b', '"late"', 60)),
        start: await refusalName(startStep(f, pass, 'b', 2)),
        complete: await refusalName(f.store.complete(Q, pass.runId, pass.claimToken, '"done"')),
      }
      const rollback = await refusalName(
        checkpointOwned(f.store, Q, pass, rollbackOf('a'), 'null', 60),
      )
      expect({
        before,
        frozen,
        rollback,
        task: (await taskRow(f, spawned.taskId))?.state,
        checkpoints: await checkpointNames(f, spawned.taskId),
      }).toEqual({
        before: 'LeaseLostError',
        frozen: { step: 'LeaseLostError', start: 'LeaseLostError', complete: 'LeaseLostError' },
        rollback: 'accepted',
        task: 'running',
        checkpoints: [SAGA_PHASE_CHECKPOINT, rollbackOf('a'), startMarker('a')].sort(),
      })
    })

    // FinishSaga: OutcomeHonest, SagaEndsFailed, and the completion event written once,
    // by the batch that ends the task and not the one that entered the phase.
    it('ends failed with the deciding failure and a complete outcome once every rollback ran', async () => {
      const { taskId, pass } = await rollingBack(f, ['a', 'b'])
      await checkpointOwned(f.store, Q, pass, rollbackOf('b'), 'null', 60)
      await checkpointOwned(f.store, Q, pass, rollbackOf('a'), 'null', 60)
      const eventsBefore = await doneEvents(f)
      await f.store.fail(Q, pass.runId, pass.claimToken, CAUSE, null)
      expect({
        eventsBefore,
        events: await doneEvents(f),
        result: await f.store.getTaskResult(Q, taskId),
        revived: await f.store.retryTask(Q, taskId),
      }).toEqual({
        eventsBefore: 0,
        events: 1,
        result: { state: 'failed', failureReasonJson: CAUSE, rollback: { outcome: 'complete' } },
        // Revive, under "refused": a task whose saga began is never revived.
        revived: null,
      })
    })

    // RollbackRetry: the attempt record lands with the failure, and the pass that
    // follows is not capped by the user budget. RollbackHalts: FailedOutcomeHonest.
    it('counts a failed rollback attempt, retries it past the budget, and halts when told to', async () => {
      const { taskId, pass } = await rollingBack(f, ['a', 'b'])
      await checkpointOwned(f.store, Q, pass, rollbackOf('b'), 'null', 60)
      await f.store.failRollback(
        Q,
        pass.runId,
        pass.claimToken,
        CAUSE,
        { delaySeconds: 0 },
        triesOf('a', 1),
      )
      const retried = await taskRow(f, taskId)
      const again = await claimActivated(f.store, Q, 'w-pass-2')
      await f.store.failRollback(Q, again.runId, again.claimToken, CAUSE, null, triesOf('a', 2))
      expect({
        retried,
        againIsTheNextAttempt: again.attempt === pass.attempt + 1,
        result: await f.store.getTaskResult(Q, taskId),
        record: decodeRollbackTry(
          String(
            (
              await rowsOf(
                f.raw,
                'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
                [taskId, triesOf('a', 2).key],
              )
            )[0]?.state,
          ),
        ),
      }).toEqual({
        retried: { state: 'pending', attempts: 2, maxAttempts: 3, failureReason: null },
        againIsTheNextAttempt: true,
        result: {
          state: 'failed',
          failureReasonJson: CAUSE,
          rollback: { outcome: 'failed', errorJson: ROLLBACK_BOOM },
        },
        record: { tries: 2, errorJson: ROLLBACK_BOOM },
      })
    })

    it('refuses a failed rollback of a task that is not rolling back, and writes nothing', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const run = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, run, 'a', 1)
      expect({
        refused: await refusalName(
          f.store.failRollback(Q, run.runId, run.claimToken, CAUSE, null, triesOf('a', 1)),
        ),
        task: (await taskRow(f, spawned.taskId))?.state,
        checkpoints: await checkpointNames(f, spawned.taskId),
      }).toEqual({ refused: 'LeaseLostError', task: 'running', checkpoints: [startMarker('a')] })
      await f.store.cancelTask(Q, spawned.taskId)
    })

    it('caps a failure in the phase that carries no attempt record, which halts the saga', async () => {
      const { taskId, pass } = await rollingBack(f)
      await f.store.fail(Q, pass.runId, pass.claimToken, ROLLBACK_BOOM, { delaySeconds: 0 })
      expect(await f.store.getTaskResult(Q, taskId)).toEqual({
        state: 'failed',
        failureReasonJson: ROLLBACK_BOOM,
        rollback: { outcome: 'failed' },
      })
    })

    // Cancel, under "halts": CancelledSagaIsSurfaced and FailedOutcomeHonest.
    it('a cancellation in the phase halts the saga, and the outcome says what was left', async () => {
      const halted = await rollingBack(f)
      expect(await f.store.cancelTask(Q, halted.taskId)).toBe(true)
      const finished = await rollingBack(f)
      await checkpointOwned(f.store, Q, finished.pass, rollbackOf('a'), 'null', 60)
      expect(await f.store.cancelTask(Q, finished.taskId)).toBe(true)
      expect({
        halted: (await f.store.getTaskResult(Q, halted.taskId))?.rollback,
        finished: (await f.store.getTaskResult(Q, finished.taskId))?.rollback,
        states: [
          (await taskRow(f, halted.taskId))?.state,
          (await taskRow(f, finished.taskId))?.state,
        ],
      }).toEqual({
        halted: { outcome: 'failed' },
        finished: { outcome: 'complete' },
        states: ['cancelled', 'cancelled'],
      })
    })

    it('revives a failed task whose saga never began, as before', async () => {
      const spawned = await f.store.spawn(Q, 'plain', '{}')
      const run = await claimActivated(f.store, Q, 'w-1')
      await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      expect((await f.store.retryTask(Q, spawned.taskId))?.attempt).toBe(2)
      await f.store.cancelTask(Q, spawned.taskId)
    })

    // InfraCap, under "rolls back": both sweep caps decide a failure, so both enter the
    // phase, and inside the phase each ends the saga where it stands.
    it('a sweep cap enters the phase when a rollback is owed, and ends the saga inside it', async () => {
      const observed: Record<string, unknown> = {}
      for (const cap of ['relaunch', 'infra'] as const) {
        const spawned = await f.store.spawn(Q, `saga-${cap}`, '{}', { maxAttempts: 3 })
        const seedCap = async (run: ClaimedRun) => {
          if (cap === 'relaunch') {
            await f.raw.batch('seed-relaunch-cap', [
              {
                sql: 'UPDATE runs SET relaunch_count = ? WHERE run_id = ?',
                args: [RELAUNCH_CAP, run.runId],
              },
            ])
          }
        }
        let now = Number(await f.admin.nowEpochMs())
        const expire = async () => {
          now += 1_000_000
          await f.admin.setFakeNowEpochMs(now)
        }
        const first = await claimActivated(f.store, Q, `w-${cap}-1`)
        if (cap === 'infra') {
          await f.raw.batch('seed-infra-cap', [
            {
              sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
              args: [INFRA_RETRY_CAP, first.taskId],
            },
            {
              sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
              args: [INFRA_RETRY_CAP + 1, first.runId],
            },
          ])
          await checkpointOwned(f.store, Q, first, startMarker('a'), '1', 60)
        } else {
          await startStep(f, first, 'a', 1)
          await f.store.fail(Q, first.runId, first.claimToken, CAUSE, { delaySeconds: 0 })
          await seedCap(await claimOne(f.store, Q, `w-${cap}-2`))
        }
        await expire()
        const entered = (await f.store.sweep(Q, 10)).map((swept) => swept.kind)
        const entering = {
          task: (await taskRow(f, spawned.taskId))?.state,
          marker: (
            await rowsOf(
              f.raw,
              'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
              [spawned.taskId, SAGA_PHASE_CHECKPOINT],
            )
          )[0]?.state,
        }
        const pass =
          cap === 'relaunch'
            ? await claimOne(f.store, Q, `w-${cap}-pass`)
            : await claimActivated(f.store, Q, `w-${cap}-pass`)
        await seedCap(pass)
        if (cap === 'infra') {
          await f.raw.batch('seed-infra-cap-again', [
            {
              sql: 'UPDATE tasks SET infra_retries = ?, attempts = ? WHERE task_id = ?',
              args: [INFRA_RETRY_CAP, pass.attempt - 1 - INFRA_RETRY_CAP, pass.taskId],
            },
          ])
        }
        await expire()
        observed[cap] = {
          entered,
          entering,
          ended: (await f.store.sweep(Q, 10)).map((swept) => swept.kind),
          result: await f.store.getTaskResult(Q, spawned.taskId),
        }
      }
      expect(observed).toEqual({
        relaunch: {
          entered: ['rollback-started'],
          entering: { task: 'pending', marker: REASON_RELAUNCH_CAP },
          ended: ['relaunch-cap-exhausted'],
          result: {
            state: 'failed',
            failureReasonJson: REASON_RELAUNCH_CAP,
            rollback: { outcome: 'failed' },
          },
        },
        infra: {
          entered: ['rollback-started'],
          entering: { task: 'pending', marker: REASON_INFRA_CAP },
          ended: ['infra-cap-exhausted'],
          result: {
            state: 'failed',
            failureReasonJson: REASON_INFRA_CAP,
            rollback: { outcome: 'failed' },
          },
        },
      })
    })

    it('names the reason a finished pass ends its run with', () => {
      expect(JSON.parse(REASON_ROLLED_BACK)).toEqual({ name: '$RolledBack' })
    })
  })
}
