import {
  type ClaimedRun,
  INFRA_RETRY_CAP,
  MAX_COUNT,
  REASON_CANCELLED,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  REASON_ROLLED_BACK,
  RELAUNCH_CAP,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SpawnOptions,
  type SqlExecutor,
  type TaskOutcome,
  decodeRollbackTry,
  encodeRollbackTry,
  encodeTaskOutcome,
} from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childTaskViolations } from './child-tasks.js'
import { TERMINAL_BATCH_LABELS } from './fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { sagaViolations } from './saga-rows.js'
import {
  awaitOwned,
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  refusalName,
  withFixture,
} from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000
const CAUSE = '{"name":"ForwardBoom"}'
const ROLLBACK_BOOM = '{"name":"RollbackBoom"}'

async function rowsOf(raw: SqlExecutor, sql: string, args: (string | number)[] = []) {
  const [result] = await raw.batch('saga-rows', [{ sql, args }], 'read')
  return result?.rows ?? []
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

/** How one batch that can end a task ends a task that is rolling back, with one rollback owed. */
interface SagaEnding {
  readonly spawn?: SpawnOptions
  /** Put the forward run where this batch needs it, before its step starts. */
  readonly seedForward?: (f: StoreFixture, forward: ClaimedRun) => Promise<void>
  /** The pass is claimed and never activated, as a lost launch is. */
  readonly unlaunched?: boolean
  readonly seedPass?: (f: StoreFixture, pass: ClaimedRun) => Promise<void>
  readonly advanceMs?: number
  readonly end: (f: StoreFixture, taskId: string, pass: ClaimedRun) => Promise<unknown>
  /** What `end` answers. */
  readonly ended: unknown
  /** The outcome the batch gives the task, or null when the phase refuses the batch. */
  readonly outcome: TaskOutcome | null
  readonly rollback?: { outcome: 'complete' | 'failed'; errorJson?: string }
}

const sweepKinds = async (f: StoreFixture) =>
  (await f.store.sweep(Q, 10)).map((swept) => swept.kind)

const SAGA_ENDINGS: Record<(typeof TERMINAL_BATCH_LABELS)[number], SagaEnding> = {
  // A task that is rolling back cannot complete.
  complete: {
    end: (f, _taskId, pass) => refusalName(f.store.complete(Q, pass.runId, pass.claimToken, '"x"')),
    ended: 'LeaseLostError',
    outcome: null,
  },
  // FinishSaga: the pass ran every rollback, and ends the task with the deciding failure.
  fail: {
    end: async (f, _taskId, pass) => {
      await checkpointOwned(f.store, Q, pass, rollbackOf('a'), 'null', 60)
      return f.store.fail(Q, pass.runId, pass.claimToken, CAUSE, null)
    },
    ended: { rollingBack: false },
    outcome: { state: 'failed', failureReasonJson: CAUSE },
    rollback: { outcome: 'complete' },
  },
  // RollbackHalts.
  'fail-rollback': {
    end: (f, _taskId, pass) =>
      f.store.failRollback(Q, pass.runId, pass.claimToken, CAUSE, null, triesOf('a', 1)),
    ended: { rollingBack: false },
    outcome: { state: 'failed', failureReasonJson: CAUSE },
    rollback: { outcome: 'failed', errorJson: ROLLBACK_BOOM },
  },
  // Cancel, under "halts".
  'cancel-task': {
    end: (f, taskId) => f.store.cancelTask(Q, taskId),
    ended: true,
    outcome: { state: 'cancelled', failureReasonJson: REASON_CANCELLED },
    rollback: { outcome: 'failed' },
  },
  'sweep:cancel': {
    spawn: { cancellation: { maxDurationSeconds: 30 } },
    advanceMs: 100_000,
    end: sweepKinds,
    ended: ['cancelled'],
    outcome: { state: 'cancelled', failureReasonJson: REASON_CANCELLED },
    rollback: { outcome: 'failed' },
  },
  // An infrastructure cap inside the phase ends the saga where it stands.
  'sweep:lost-launch': {
    unlaunched: true,
    seedPass: async (f, pass) => {
      await f.raw.batch('seed-relaunch-cap', [
        {
          sql: 'UPDATE runs SET relaunch_count = ? WHERE run_id = ?',
          args: [RELAUNCH_CAP, pass.runId],
        },
      ])
    },
    advanceMs: 100_000,
    end: sweepKinds,
    ended: ['relaunch-cap-exhausted'],
    outcome: { state: 'failed', failureReasonJson: REASON_RELAUNCH_CAP },
    rollback: { outcome: 'failed' },
  },
  'sweep:claim-timeout': {
    // The forward run is already the last infrastructure retry, so the pass that
    // follows it dies at the cap.
    seedForward: async (f, forward) => {
      await f.raw.batch('seed-infra-cap', [
        {
          sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
          args: [INFRA_RETRY_CAP, forward.taskId],
        },
        {
          sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
          args: [INFRA_RETRY_CAP + 1, forward.runId],
        },
      ])
    },
    advanceMs: 4_000_000,
    end: sweepKinds,
    ended: ['infra-cap-exhausted'],
    outcome: { state: 'failed', failureReasonJson: REASON_INFRA_CAP },
    rollback: { outcome: 'failed' },
  },
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

    afterEach(async ({ task }) => {
      const violations = {
        saga: await sagaViolations(f.raw),
        childTasks: await childTaskViolations(f.raw),
        engine: await engineInvariantViolations(f.raw),
      }
      await f.close()
      // A case that already failed says why in its own assertion. The rows it leaves are
      // the defect's, and a second failure here would blur which assertion caught it.
      if (task.result?.state !== 'pass') return
      expect(violations).toEqual({ saga: [], childTasks: [], engine: [] })
    })

    // UserTerminal with AtomicEnter: the decision and the phase marker are one batch.
    it('enters the phase in the batch that decides the failure, and ends nothing', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const forward = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, forward, 'a', 1)
      await checkpointOwned(f.store, Q, forward, 'a', '"a-result"', 60)
      const decided = await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
      // Read from the rows before anything claims the pass. A batch that also ended the task
      // leaves no pass to claim, and this comparison must be what says so.
      expect(
        {
          decided,
          task: await taskRow(f, spawned.taskId),
          runs: (
            await rowsOf(
              f.raw,
              'SELECT attempt, state FROM runs WHERE task_id = ? ORDER BY attempt',
              [spawned.taskId],
            )
          ).map((row) => `${Number(row.attempt)}:${String(row.state)}`),
          checkpoints: await checkpointNames(f, spawned.taskId),
          marker: (
            await rowsOf(
              f.raw,
              'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
              [spawned.taskId, SAGA_PHASE_CHECKPOINT],
            )
          )[0]?.state,
          completionEvents: await doneEvents(f),
          result: await f.store.getTaskResult(Q, spawned.taskId),
        },
        'mutation-verdict:behavior:saga-phase-entry',
      ).toEqual({
        decided: { rollingBack: true },
        // The pass runs past the user budget, so the budget is the pass's own ordinal.
        task: { state: 'pending', attempts: 1, maxAttempts: 2, failureReason: null },
        runs: ['1:failed', '2:pending'],
        checkpoints: [SAGA_PHASE_CHECKPOINT, startMarker('a'), 'a'].sort(),
        marker: CAUSE,
        completionEvents: 0,
        result: { state: 'pending' },
      })
      const pass = await claimActivated(f.store, Q, 'w-pass')
      expect(pass.taskId === spawned.taskId && pass.attempt === forward.attempt + 1).toBe(true)
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
      expect(
        {
          afterRetry,
          plain: await f.store.getTaskResult(Q, plain.taskId),
          plainCheckpoints: await checkpointNames(f, plain.taskId),
        },
        'mutation-verdict:behavior:saga-only-an-owed-terminal-failure-enters',
      ).toEqual({
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
      // A rollback is recorded only for a task whose failure was decided. Asserted here, on
      // its own: a rollback recorded this early would leave nothing owed, and no pass below.
      expect(before, 'mutation-verdict:behavior:saga-rollback-only-inside-the-phase').toBe(
        'LeaseLostError',
      )
      await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      const pass = await claimActivated(f.store, Q, 'w-pass')
      const frozen = {
        step: await refusalName(checkpointOwned(f.store, Q, pass, 'b', '"late"', 60)),
        start: await refusalName(startStep(f, pass, 'b', 2)),
        complete: await refusalName(f.store.complete(Q, pass.runId, pass.claimToken, '"done"')),
        // What a worker of an older build would try next: a durable sleep, which commits
        // a marker, and an await, which parks the pass on an event that may never come.
        suspend: await refusalName(
          f.store.suspendRun(
            Q,
            pass.runId,
            pass.claimToken,
            { inSeconds: 5 },
            { key: '$sleep', stateJson: '{"inSeconds":5}' },
          ),
        ),
        await: await refusalName(awaitOwned(f.store, Q, pass, '$await:never', 'never', null)),
      }
      const rollback = await refusalName(
        checkpointOwned(f.store, Q, pass, rollbackOf('a'), 'null', 60),
      )
      expect(
        {
          frozen,
          rollback,
          task: (await taskRow(f, spawned.taskId))?.state,
          checkpoints: await checkpointNames(f, spawned.taskId),
        },
        'mutation-verdict:behavior:saga-forward-phase-is-frozen',
      ).toEqual({
        frozen: {
          step: 'LeaseLostError',
          start: 'LeaseLostError',
          complete: 'LeaseLostError',
          suspend: 'LeaseLostError',
          await: 'LeaseLostError',
        },
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
      expect(
        {
          eventsBefore,
          events: await doneEvents(f),
          result: await f.store.getTaskResult(Q, taskId),
          revived: await f.store.retryTask(Q, taskId),
        },
        'mutation-verdict:behavior:saga-finish-is-honest',
      ).toEqual({
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
      expect(
        {
          refused: await refusalName(
            f.store.failRollback(Q, run.runId, run.claimToken, CAUSE, null, triesOf('a', 1)),
          ),
          task: (await taskRow(f, spawned.taskId))?.state,
          checkpoints: await checkpointNames(f, spawned.taskId),
        },
        'mutation-verdict:behavior:saga-failed-rollback-needs-the-phase',
      ).toEqual({ refused: 'LeaseLostError', task: 'running', checkpoints: [startMarker('a')] })
      await f.store.cancelTask(Q, spawned.taskId)
    })

    it('caps a failure in the phase that carries no attempt record, which halts the saga', async () => {
      const { taskId, pass } = await rollingBack(f)
      await f.store.fail(Q, pass.runId, pass.claimToken, ROLLBACK_BOOM, { delaySeconds: 0 })
      expect(
        await f.store.getTaskResult(Q, taskId),
        'mutation-verdict:behavior:saga-phase-is-entered-once',
      ).toEqual({
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
        const [claimed] = await f.store.claim(Q, `w-${cap}-pass`, { leaseSeconds: 60, limit: 1 })
        if (!claimed) {
          // No pass is claimable, so the phase was not entered as this case expects. The
          // comparison below says so, where the marker is, and nothing throws here.
          observed[cap] = {
            entered,
            entering,
            ended: 'no pass was claimable',
            result: await f.store.getTaskResult(Q, spawned.taskId),
          }
          continue
        }
        const pass =
          cap === 'relaunch'
            ? claimed
            : ((await f.store.activate(Q, claimed.runId, claimed.claimToken, claimed.claimGen)) ??
              claimed)
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
      expect(observed, 'mutation-verdict:behavior:saga-sweep-cap-enters').toEqual({
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

    // Only a rollback that is owed begins a saga. A cap that fails a task with no started
    // step ends it as it always did, and its result says nothing of a rollback.
    it('ends a task at a sweep cap when nothing is owed a rollback', async () => {
      const observed: Record<string, unknown> = {}
      let now = START_MS
      for (const cap of ['relaunch', 'infra'] as const) {
        const spawned = await f.store.spawn(Q, `plain-${cap}`, '{}')
        const run =
          cap === 'relaunch'
            ? await claimOne(f.store, Q, `w-${cap}`)
            : await claimActivated(f.store, Q, `w-${cap}`)
        await f.raw.batch(
          'seed-the-cap',
          cap === 'relaunch'
            ? [
                {
                  sql: 'UPDATE runs SET relaunch_count = ? WHERE run_id = ?',
                  args: [RELAUNCH_CAP, run.runId],
                },
              ]
            : [
                {
                  sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
                  args: [INFRA_RETRY_CAP, run.taskId],
                },
                {
                  sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
                  args: [INFRA_RETRY_CAP + 1, run.runId],
                },
              ],
        )
        now += 1_000_000
        await f.admin.setFakeNowEpochMs(now)
        observed[cap] = {
          swept: (await f.store.sweep(Q, 10)).map((one) => one.kind),
          result: await f.store.getTaskResult(Q, spawned.taskId),
          checkpoints: await checkpointNames(f, spawned.taskId),
        }
      }
      expect(
        observed,
        'mutation-verdict:behavior:saga-cap-with-nothing-owed-ends-the-task',
      ).toEqual({
        relaunch: {
          swept: ['relaunch-cap-exhausted'],
          result: { state: 'failed', failureReasonJson: REASON_RELAUNCH_CAP },
          checkpoints: [],
        },
        infra: {
          swept: ['infra-cap-exhausted'],
          result: { state: 'failed', failureReasonJson: REASON_INFRA_CAP },
          checkpoints: [],
        },
      })
    })

    // Only a TERMINAL failure begins a saga. A worker that dies and a launch that is lost,
    // each below its cap, are retried by the lease story as they always were, with the
    // rollback still owed and no phase begun.
    it('retries a death and a lost launch below their caps, and rolls nothing back', async () => {
      const dies = await f.store.spawn(Q, 'dies', '{}')
      const died = await claimActivated(f.store, Q, 'w-dies')
      await startStep(f, died, 'a', 1)
      await f.admin.setFakeNowEpochMs(START_MS + 100_000)
      const afterTheDeath = (await f.store.sweep(Q, 10)).map((one) => one.kind)
      await f.admin.setFakeNowEpochMs(START_MS + 5_000_000)
      const relaunched = await claimOne(f.store, Q, 'w-lost')
      await f.admin.setFakeNowEpochMs(START_MS + 5_100_000)
      const afterTheLostLaunch = (await f.store.sweep(Q, 10)).map((one) => one.kind)
      expect({
        afterTheDeath,
        relaunchedIsTheInfrastructureSuccessor:
          relaunched.taskId === dies.taskId && relaunched.attempt === died.attempt + 1,
        afterTheLostLaunch,
        checkpoints: await checkpointNames(f, dies.taskId),
        task: (await taskRow(f, dies.taskId))?.state,
        result: await f.store.getTaskResult(Q, dies.taskId),
      }).toEqual({
        afterTheDeath: ['claim-timeout'],
        relaunchedIsTheInfrastructureSuccessor: true,
        afterTheLostLaunch: ['lost-launch'],
        checkpoints: [startMarker('a')],
        task: 'pending',
        result: { state: 'pending' },
      })
      await f.store.cancelTask(Q, dies.taskId)
    })

    // The pass runs one ordinal past the budget, so placing it raises the budget by one. A
    // task already at the top of the budget a task may have cannot be given a pass, and it
    // ends where it stands, as it did before sagas, with no rollback outcome to report. The
    // bound keeps a stored counter an exact integer. Nothing reaches it by running, so
    // the rows are moved there by hand, and they stay a state the engine could have left.
    it('ends a task whose budget cannot be raised, and places no pass', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: MAX_COUNT })
      const run = await claimActivated(f.store, Q, 'w-last')
      await f.raw.batch('the-last-attempt-the-budget-allows', [
        {
          sql: 'UPDATE tasks SET attempts = ? WHERE task_id = ?',
          args: [MAX_COUNT - 1, spawned.taskId],
        },
        { sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?', args: [MAX_COUNT, run.runId] },
      ])
      await startStep(f, run, 'a', 1)
      const decided = await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      expect(
        {
          decided,
          task: await taskRow(f, spawned.taskId),
          checkpoints: await checkpointNames(f, spawned.taskId),
          result: await f.store.getTaskResult(Q, spawned.taskId),
        },
        'mutation-verdict:behavior:saga-budget-boundary',
      ).toEqual({
        decided: { rollingBack: false },
        task: {
          state: 'failed',
          attempts: MAX_COUNT,
          maxAttempts: MAX_COUNT,
          failureReason: CAUSE,
        },
        checkpoints: [startMarker('a')],
        result: { state: 'failed', failureReasonJson: CAUSE },
      })
    })

    // The budget the pass is checked against is the one its batch writes, the failed run's
    // user ordinal plus one, and not the one the task was spawned with.
    it('rolls back a task spawned with the largest budget a task may have', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: MAX_COUNT })
      const run = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, run, 'a', 1)
      const decided = await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      expect({ decided, task: await taskRow(f, spawned.taskId) }).toEqual({
        decided: { rollingBack: true },
        task: { state: 'pending', attempts: 1, maxAttempts: 2, failureReason: null },
      })
    })

    // The engine alone writes the phase marker and a rollback's attempt record, each from
    // the batch that decides a failure. A caller of the port that holds a lease is refused
    // both names in either phase, so it cannot forge a saga or spend a rollback's budget.
    it('refuses the phase marker and an attempt record through a plain checkpoint write', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 3 })
      const forward = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, forward, 'a', 1)
      const tried = triesOf('a', 1)
      const forgedBy = async (run: ClaimedRun) => ({
        marker: await refusalName(
          checkpointOwned(f.store, Q, run, SAGA_PHASE_CHECKPOINT, '"forged"', 60),
        ),
        attemptRecord: await refusalName(
          checkpointOwned(f.store, Q, run, tried.key, tried.stateJson, 60),
        ),
      })
      expect((await forgedBy(forward)).marker).toBe('LeaseLostError')
      expect((await forgedBy(forward)).attemptRecord).toBe('LeaseLostError')
      await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
      const pass = await claimActivated(f.store, Q, 'w-pass')
      expect({
        inThePhase: await forgedBy(pass),
        checkpoints: await checkpointNames(f, spawned.taskId),
      }).toEqual({
        inThePhase: { marker: 'LeaseLostError', attemptRecord: 'LeaseLostError' },
        checkpoints: [SAGA_PHASE_CHECKPOINT, startMarker('a')].sort(),
      })
    })

    // A crash between batches changes nothing durable, and the next rollback is a function
    // of durable state alone (Sagas.tla, NOT MODELED: leases, claims, and crashes). A pass
    // that dies is recovered by the lease story like any run, and the pass that follows
    // finds what ran and carries on from there.
    it('resumes a rollback pass that died where it died', async () => {
      const { taskId, pass } = await rollingBack(f, ['a', 'b'])
      await checkpointOwned(f.store, Q, pass, rollbackOf('b'), 'null', 60)
      await f.admin.setFakeNowEpochMs(START_MS + 100_000)
      const swept = (await f.store.sweep(Q, 10)).map((one) => one.kind)
      const recovering = await taskRow(f, taskId)
      await f.admin.setFakeNowEpochMs(START_MS + 5_000_000)
      const next = await claimActivated(f.store, Q, 'w-pass-2')
      const found = (await f.store.getCheckpoints(Q, taskId, next.attempt)).map(
        (checkpoint) => checkpoint.checkpointName,
      )
      await checkpointOwned(f.store, Q, next, rollbackOf('a'), 'null', 60)
      await f.store.fail(Q, next.runId, next.claimToken, CAUSE, null)
      expect({
        swept,
        recovering: { attempts: recovering?.attempts, maxAttempts: recovering?.maxAttempts },
        nextIsTheInfrastructureSuccessor:
          next.attempt === pass.attempt + 1 && next.infraRetries === 1,
        found: found.sort(),
        result: await f.store.getTaskResult(Q, taskId),
      }).toEqual({
        swept: ['claim-timeout'],
        // An infrastructure retry spends none of the budget the pass runs under.
        recovering: { attempts: 1, maxAttempts: 2 },
        nextIsTheInfrastructureSuccessor: true,
        found: [
          SAGA_PHASE_CHECKPOINT,
          rollbackOf('b'),
          startMarker('a'),
          startMarker('b'),
          'a',
          'b',
        ].sort(),
        result: { state: 'failed', failureReasonJson: CAUSE, rollback: { outcome: 'complete' } },
      })
    })

    // Rolling deploys. A build that predates sagas decides a terminal failure with no saga
    // arm, so a step a newer build started is left as it is: the task ends, nothing rolls
    // back, and the result says nothing of a rollback, because no saga began. The rows are
    // the ones that build leaves: its own `fail` of a task with no marker, and the marker
    // beside it. The rollback stays owed, and the next build that knows sagas and decides
    // a terminal failure of this task enters the phase.
    it('leaves a failure an older build decided alone, and rolls back once a newer one decides', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const run = await claimActivated(f.store, Q, 'w-older-build')
      await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null)
      await f.raw.batch('a-newer-build-started-this-step', [
        {
          sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                  owner_run_id, owner_attempt, updated_at_ms)
                VALUES (?, ?, ?, '1', 'committed', ?, ?, ?)`,
          args: [spawned.taskId, startMarker('a'), Q, run.runId, run.attempt, START_MS],
        },
      ])
      const asTheOlderBuildLeftIt = await f.store.getTaskResult(Q, spawned.taskId)
      const revived = await f.store.retryTask(Q, spawned.taskId)
      const again = await claimActivated(f.store, Q, 'w-newer-build')
      const forward = await refusalName(checkpointOwned(f.store, Q, again, 'b', '"forward"', 60))
      const decided = await f.store.fail(Q, again.runId, again.claimToken, CAUSE, null)
      expect({
        asTheOlderBuildLeftIt,
        revivedAttempt: revived?.attempt,
        forward,
        decided,
        task: (await taskRow(f, spawned.taskId))?.state,
      }).toEqual({
        asTheOlderBuildLeftIt: { state: 'failed', failureReasonJson: CAUSE },
        revivedAttempt: 2,
        forward: 'accepted',
        decided: { rollingBack: true },
        task: 'pending',
      })
      await f.store.cancelTask(Q, spawned.taskId)
    })

    // The completion event is the task's first terminal outcome, so the batch that enters
    // the phase writes none, and each batch that can end a task writes exactly one when it
    // ends a task that is rolling back. One case over every terminal label: a label added
    // to the list does not compile until it says how it ends a saga.
    it('a parent awaiting a rolling-back child sees nothing until the saga ends, then one outcome', async () => {
      const observed: Record<string, unknown> = {}
      const expected: Record<string, unknown> = {}
      for (const label of TERMINAL_BATCH_LABELS) {
        const ending = SAGA_ENDINGS[label]
        await withFixture(makeFixture, `saga-ending-${label}`, async (fx) => {
          await fx.admin.setFakeNowEpochMs(START_MS)
          await fx.store.spawn(Q, 'parent', '{}')
          const parent = await claimActivated(fx.store, Q, 'w-parent', 3600)
          const child = await fx.store.spawn(Q, 'child', '{}', ending.spawn ?? {})
          const forward = await claimActivated(fx.store, Q, 'w-child')
          await ending.seedForward?.(fx, forward)
          await startStep(fx, forward, 'a', 1)
          const parked = await awaitTaskOwned(fx.store, Q, parent, 's', child.taskId, null)
          const entered = await fx.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
          const whileRollingBack = {
            events: await doneEvents(fx),
            parent: (
              await rowsOf(fx.raw, 'SELECT state FROM runs WHERE run_id = ?', [parent.runId])
            )[0]?.state,
          }
          const pass = ending.unlaunched
            ? await claimOne(fx.store, Q, 'w-pass')
            : await claimActivated(fx.store, Q, 'w-pass', 3600)
          await ending.seedPass?.(fx, pass)
          if (ending.advanceMs !== undefined) {
            await fx.admin.setFakeNowEpochMs(START_MS + ending.advanceMs)
          }
          const ended = await ending.end(fx, child.taskId, pass)
          const [parentRun] = await rowsOf(
            fx.raw,
            'SELECT state, event_payload FROM runs WHERE run_id = ?',
            [parent.runId],
          )
          observed[label] = {
            parked,
            entered,
            whileRollingBack,
            ended,
            events: await doneEvents(fx),
            parent: { state: parentRun?.state, payload: parentRun?.event_payload },
            result: await fx.store.getTaskResult(Q, child.taskId),
            violations: await sagaViolations(fx.raw),
          }
          const outcome = ending.outcome
          expected[label] = {
            parked: { emitted: false },
            entered: { rollingBack: true },
            whileRollingBack: { events: 0, parent: 'sleeping' },
            ended: ending.ended,
            events: outcome === null ? 0 : 1,
            parent:
              outcome === null
                ? { state: 'sleeping', payload: null }
                : { state: 'pending', payload: encodeTaskOutcome(outcome) },
            result:
              outcome === null ? { state: 'running' } : { ...outcome, rollback: ending.rollback },
            violations: [],
          }
        })
      }
      expect(observed, 'mutation-verdict:behavior:saga-endings').toEqual(expected)
    })

    it('names the reason a finished pass ends its run with', () => {
      expect(JSON.parse(REASON_ROLLED_BACK)).toEqual({ name: '$RolledBack' })
    })
  })
}
