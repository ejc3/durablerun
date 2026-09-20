import {
  type ClaimedRun,
  INFRA_RETRY_CAP,
  MAX_COUNT,
  REASON_CANCELLED,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
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
  firstNamePast,
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
/** Where a saga case puts a task's children, so the next claim in `Q` is never one of them. */
const KIDS = 'kids'
const START_MS = 1_000_000
const CAUSE = '{"name":"ForwardBoom"}'
const ROLLBACK_BOOM = '{"name":"RollbackBoom"}'

async function rowsOf(raw: SqlExecutor, sql: string, args: (string | number)[] = []) {
  const [result] = await raw.batch('saga-rows', [{ sql, args }], 'read')
  return result?.rows ?? []
}

const startMarker = (step: string) => `${SAGA_STARTED_PREFIX}${step}`
const rollbackOf = (step: string) => `${SAGA_ROLLBACK_PREFIX}${step}`
/**
 * A rollback's attempt record as it is stored. The name is spelled here and not taken from
 * core, so a name that core derives wrongly is seen.
 */
const triesOf = (step: string, tries: number) => ({
  key: `${SAGA_TRIES_PREFIX}${step}`,
  stateJson: encodeRollbackTry({ tries, errorJson: ROLLBACK_BOOM }),
})
/** A failed rollback of `step`, as the port takes it. */
export const failedRollback = (step: string, errorJson: string = ROLLBACK_BOOM) => ({
  stepKey: step,
  errorJson,
})

/** A registered step starts: its marker commits, carrying its index, before its body runs. */
export function startStep(f: StoreFixture, run: ClaimedRun, step: string, index: number) {
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
export async function rollingBack(f: StoreFixture, steps: readonly string[] = ['a']) {
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
      f.store.failRollback(Q, pass.runId, pass.claimToken, CAUSE, null, failedRollback('a')),
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

    // A child spawn is forward progress, as a step is: inside the phase the store creates no
    // child, whoever asks. A child the forward phase spawned is still found, which is what a
    // replay asks, and a replay creates nothing.
    it('refuses a child spawn inside the phase, and still finds a child the forward phase spawned', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const forward = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, forward, 'a', 1)
      const childOf = (run: ClaimedRun, replayKey: string) => ({
        parentQueue: Q,
        parentTaskId: spawned.taskId,
        runId: run.runId,
        claimToken: run.claimToken,
        replayKey,
      })
      // The children live in a queue of their own, so the next claim in `Q` is the pass.
      const before = await f.store.spawn(KIDS, 'child', '{}', {
        childOf: childOf(forward, '$spawn:before'),
      })
      await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
      const pass = await claimActivated(f.store, Q, 'w-pass')
      const inThePhase = await refusalName(
        f.store.spawn(KIDS, 'child', '{}', { childOf: childOf(pass, '$spawn:late') }),
      )
      const replayed = await f.store.spawn(KIDS, 'child', '{}', {
        childOf: childOf(pass, '$spawn:before'),
      })
      const [children] = await rowsOf(f.raw, 'SELECT COUNT(*) AS n FROM tasks WHERE queue = ?', [
        KIDS,
      ])
      expect(
        {
          inThePhase,
          replayFindsTheChild: replayed.taskId === before.taskId && !replayed.created,
          children: Number(children?.n),
        },
        'mutation-verdict:behavior:saga-child-spawn-is-frozen',
      ).toEqual({ inThePhase: 'LeaseLostError', replayFindsTheChild: true, children: 1 })
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
        failedRollback('a'),
      )
      const retried = await taskRow(f, taskId)
      const again = await claimActivated(f.store, Q, 'w-pass-2')
      await f.store.failRollback(Q, again.runId, again.claimToken, CAUSE, null, failedRollback('a'))
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

    // Sagas.tla's RollbackRetry spends exactly one attempt of a rollback's budget, and
    // TriesOnlyGrow never gives one back. So the count is the store's to keep: one more than
    // the last one stored, and no caller hands one over.
    it("counts a rollback's failed attempts itself, one more than the last one stored", async () => {
      const { taskId, pass } = await rollingBack(f, ['a'])
      const record = triesOf('a', 1).key
      const stored = async () =>
        String(
          (
            await rowsOf(
              f.raw,
              'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
              [taskId, record],
            )
          )[0]?.state,
        )
      await f.store.failRollback(
        Q,
        pass.runId,
        pass.claimToken,
        CAUSE,
        { delaySeconds: 0 },
        failedRollback('a'),
      )
      const first = await stored()
      // A worker of an older build handed its store the count, and that store wrote what it
      // was handed. Its record has this name and this text, so a newer store counts on from
      // it: here from a fifth failed attempt.
      await f.raw.batch('a-record-an-older-build-wrote', [
        {
          sql: 'UPDATE checkpoints SET state = ? WHERE task_id = ? AND checkpoint_name = ?',
          args: [triesOf('a', 5).stateJson, taskId, record],
        },
      ])
      const again = await claimActivated(f.store, Q, 'w-pass-2')
      await f.store.failRollback(Q, again.runId, again.claimToken, CAUSE, null, failedRollback('a'))
      expect(
        { first, second: decodeRollbackTry(await stored()) },
        'mutation-verdict:behavior:saga-store-counts-failed-attempts',
      ).toEqual({
        // The one encoding, byte for byte: what a worker of any build reads and counts from.
        first: '{"tries":1,"errorJson":"{\\"name\\":\\"RollbackBoom\\"}"}',
        second: { tries: 6, errorJson: ROLLBACK_BOOM },
      })
    })

    // The store reads the last count before its batch, and the claim's fence is what keeps
    // that read current. A caller whose claim is gone may have read a count that is stale,
    // and it loses the compare-and-set, so a stale count is never written: not under a token
    // the claim never had, and not by the same call replayed after it won.
    it('refuses a failed rollback under a claim that is gone, and leaves the count as it was', async () => {
      const { taskId, pass } = await rollingBack(f, ['a'])
      const failedUnder = (claimToken: string) =>
        refusalName(
          f.store.failRollback(
            Q,
            pass.runId,
            claimToken,
            CAUSE,
            { delaySeconds: 0 },
            failedRollback('a'),
          ),
        )
      const underAnotherToken = await failedUnder('not-the-token')
      const held = await failedUnder(pass.claimToken)
      const replayed = await failedUnder(pass.claimToken)
      const [record] = await rowsOf(
        f.raw,
        'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
        [taskId, triesOf('a', 1).key],
      )
      expect({
        underAnotherToken,
        held,
        replayed,
        record: decodeRollbackTry(String(record?.state)),
      }).toEqual({
        underAnotherToken: 'LeaseLostError',
        held: 'accepted',
        replayed: 'LeaseLostError',
        record: { tries: 1, errorJson: ROLLBACK_BOOM },
      })
    })

    it('refuses a failed rollback of a task that is not rolling back, and writes nothing', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const run = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, run, 'a', 1)
      expect(
        {
          refused: await refusalName(
            f.store.failRollback(Q, run.runId, run.claimToken, CAUSE, null, failedRollback('a')),
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

    // FailedOutcomeHonest, for the error beside the outcome. `errorJson` is the failure of
    // the rollback that ended the task. An attempt that failed with budget left ended
    // nothing, because a pass followed it, so whatever halts the saga afterwards is not it.
    it('names no rollback error when a cancellation or a cap halts the saga after a failed attempt that had budget left', async () => {
      const failedWithBudgetLeft = async () => {
        const { taskId, pass } = await rollingBack(f)
        expect(
          await f.store.failRollback(
            Q,
            pass.runId,
            pass.claimToken,
            CAUSE,
            { delaySeconds: 0 },
            failedRollback('a'),
          ),
        ).toEqual({ rollingBack: true })
        return taskId
      }
      const cancelled = await failedWithBudgetLeft()
      expect(await f.store.cancelTask(Q, cancelled)).toBe(true)
      const capped = await failedWithBudgetLeft()
      const next = await claimActivated(f.store, Q, 'w-pass-2')
      await f.store.fail(Q, next.runId, next.claimToken, '{"name":"PassBoom"}', {
        delaySeconds: 0,
      })
      const read = async (taskId: string) => {
        const result = await f.store.getTaskResult(Q, taskId)
        return { state: result?.state, rollback: result?.rollback }
      }
      expect(
        { cancelled: await read(cancelled), capped: await read(capped) },
        'mutation-verdict:behavior:saga-error-is-the-ending-rollbacks',
      ).toEqual({
        cancelled: { state: 'cancelled', rollback: { outcome: 'failed' } },
        capped: { state: 'failed', rollback: { outcome: 'failed' } },
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

    // The pass runs one ordinal past the failed run, and its batch writes that ordinal as
    // the task's budget. A run that failed at the largest user ordinal a budget can hold
    // cannot be given a pass, and its task ends where it stands, as it did before sagas,
    // with no rollback outcome to report. The bound keeps a stored counter an exact
    // integer. Running there takes a million attempts, so the rows are moved there by
    // hand, and they stay a state the engine could have left.
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
      expect(
        { decided, task: await taskRow(f, spawned.taskId) },
        'mutation-verdict:behavior:saga-pass-fits-the-largest-budget',
      ).toEqual({
        decided: { rollingBack: true },
        task: { state: 'pending', attempts: 1, maxAttempts: 2, failureReason: null },
      })
    })

    // The ordinal the pass is checked against is the failed run's USER ordinal, which leaves
    // the task's infrastructure retries out. Both tasks here have one infrastructure retry
    // and sit at the bound: one user attempt below it, which rolls back, and at it, which
    // cannot. A guard that read the run's own ordinal would refuse the first.
    it('holds the pass to the user ordinal at the bound, for a task that has infrastructure retries', async () => {
      const failedAt = async (userOrdinal: number) => {
        // A queue of its own, so the claim below takes this task's run and no pass.
        const queue = `bound-${userOrdinal}`
        const spawned = await f.store.spawn(queue, 'saga', '{}', { maxAttempts: MAX_COUNT })
        const run = await claimActivated(f.store, queue, 'w-forward')
        // The accounting identity holds: a run's ordinal is its task's attempts and
        // infrastructure retries plus one.
        await f.raw.batch('one-infrastructure-retry-at-the-bound', [
          {
            sql: 'UPDATE tasks SET attempts = ?, infra_retries = 1 WHERE task_id = ?',
            args: [userOrdinal - 1, spawned.taskId],
          },
          {
            sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
            args: [userOrdinal + 1, run.runId],
          },
        ])
        await checkpointOwned(f.store, queue, run, startMarker('a'), '1', 60)
        const decided = await f.store.fail(queue, run.runId, run.claimToken, CAUSE, null)
        return { decided, task: await taskRow(f, spawned.taskId) }
      }
      expect(
        { below: await failedAt(MAX_COUNT - 1), at: await failedAt(MAX_COUNT) },
        'mutation-verdict:behavior:saga-pass-budget-counts-user-attempts',
      ).toEqual({
        below: {
          decided: { rollingBack: true },
          task: {
            state: 'pending',
            attempts: MAX_COUNT - 1,
            maxAttempts: MAX_COUNT,
            failureReason: null,
          },
        },
        at: {
          decided: { rollingBack: false },
          task: {
            state: 'failed',
            attempts: MAX_COUNT,
            maxAttempts: MAX_COUNT,
            failureReason: CAUSE,
          },
        },
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
      expect(
        (await forgedBy(forward)).marker,
        'mutation-verdict:behavior:saga-phase-marker-is-the-engines',
      ).toBe('LeaseLostError')
      expect(
        (await forgedBy(forward)).attemptRecord,
        'mutation-verdict:behavior:saga-attempt-record-is-the-engines',
      ).toBe('LeaseLostError')
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

    // A plain checkpoint write is one of two doors that take a caller's checkpoint name.
    // A suspension commits the caller's marker in its own batch, and it is refused the
    // engine's names too. A failed rollback was a third, until its port took the step.
    it('refuses an engine-only name as the marker of a suspension', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 3 })
      const forward = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, forward, 'a', 1)
      const tried = triesOf('a', 1)
      const suspendedAs = (key: string, stateJson: string) =>
        refusalName(
          f.store.suspendRun(
            Q,
            forward.runId,
            forward.claimToken,
            { inSeconds: 5 },
            { key, stateJson },
          ),
        )
      expect(
        await suspendedAs(SAGA_PHASE_CHECKPOINT, '"forged"'),
        'mutation-verdict:behavior:saga-suspension-marker-name-is-checked',
      ).toBe('LeaseLostError')
      expect(await suspendedAs(tried.key, tried.stateJson)).toBe('LeaseLostError')
      // The run is still running and its saga has not begun, so it suspends as any run does.
      expect({
        ordinary: await suspendedAs('$sleep', '{"inSeconds":5}'),
        checkpoints: await checkpointNames(f, spawned.taskId),
      }).toEqual({ ordinary: 'accepted', checkpoints: ['$sleep', startMarker('a')].sort() })
    })

    // A failed rollback was the third door: its port took the attempt record from its caller,
    // and the batch checked the record's name. The port now takes the step, and the store
    // builds the name, so no caller's name reaches that batch. A caller of the older port
    // hands over `{ key, stateJson }`, and the entry refuses it before anything is read or
    // sent, saying what the port takes.
    it("names a failed rollback's attempt record itself, and refuses the record an older caller hands over", async () => {
      const { taskId, pass } = await rollingBack(f, ['a'])
      const asAnOlderCaller = f.store.failRollback as unknown as (
        ...args: unknown[]
      ) => Promise<unknown>
      const refused = await asAnOlderCaller
        .call(f.store, Q, pass.runId, pass.claimToken, CAUSE, null, {
          key: SAGA_PHASE_CHECKPOINT,
          stateJson: '"forged"',
        })
        .then(
          () => 'accepted',
          (error: unknown) =>
            error instanceof TypeError && error.message.includes('{ stepKey, errorJson }')
              ? 'a TypeError that names the shape'
              : String(error),
        )
      const untouched = {
        task: (await taskRow(f, taskId))?.state,
        checkpoints: await checkpointNames(f, taskId),
      }
      // Held as an answer and not awaited bare: a caller that was wrongly let through above
      // has ended the pass, and the assertion below must say so, not a throw from here.
      const halts = await refusalName(
        f.store.failRollback(Q, pass.runId, pass.claimToken, CAUSE, null, failedRollback('a')),
      )
      expect(
        { refused, untouched, halts, halted: await checkpointNames(f, taskId) },
        'mutation-verdict:behavior:saga-store-names-the-attempt-record',
      ).toEqual({
        refused: 'a TypeError that names the shape',
        untouched: {
          task: 'running',
          checkpoints: [SAGA_PHASE_CHECKPOINT, startMarker('a'), 'a'].sort(),
        },
        halts: 'accepted',
        halted: [SAGA_PHASE_CHECKPOINT, startMarker('a'), 'a', triesOf('a', 1).key].sort(),
      })
    })

    // The first two cases above each hold one door. This one holds the table: every batch that
    // commits a checkpoint under a name its caller chose, against every reserved name, in
    // both phases. Each pair is refused, or admitted only in its phase. A store that gains a
    // batch which takes a caller's checkpoint name gains a door here, and the static count
    // of checkpoint writes in the conformance tests is what sends its author to this table.
    it('admits a reserved checkpoint name only at its door and in its phase, and matches it exactly', async () => {
      const tried = triesOf('a', 1)
      const reserved = {
        phaseMarker: { key: SAGA_PHASE_CHECKPOINT, stateJson: '"forged"' },
        startMarker: { key: startMarker('b'), stateJson: '2' },
        rollback: { key: rollbackOf('a'), stateJson: 'null' },
        attemptRecord: tried,
      }
      // Names that are no reserved name: a reserved one in another case, or padded. A store
      // that folds case or pads spaces when it compares a name answers these as reserved.
      const lookalikes = {
        upperPhaseMarker: { key: SAGA_PHASE_CHECKPOINT.toUpperCase(), stateJson: '"x"' },
        paddedPhaseMarker: { key: `${SAGA_PHASE_CHECKPOINT} `, stateJson: '"x"' },
        upperRollback: { key: rollbackOf('a').toUpperCase(), stateJson: '"x"' },
        upperAttemptRecord: { key: tried.key.toUpperCase(), stateJson: tried.stateJson },
      }
      const doors = {
        'set-checkpoint': (
          queue: string,
          run: ClaimedRun,
          write: { key: string; stateJson: string },
        ) => checkpointOwned(f.store, queue, run, write.key, write.stateJson, 60),
        suspend: (queue: string, run: ClaimedRun, write: { key: string; stateJson: string }) =>
          f.store.suspendRun(queue, run.runId, run.claimToken, { inSeconds: 5 }, write),
      }
      let cell = 0
      // Every cell has a task and a queue of its own: an admitted write parks, ends, or
      // retries its run, and a rollback pass is claimable work on the queue it sits on.
      const answer = async (
        door: keyof typeof doors,
        phase: 'forward' | 'rollingBack',
        write: { key: string; stateJson: string },
      ) => {
        const queue = `door-${++cell}`
        await f.store.spawn(queue, 'saga', '{}')
        let run = await claimActivated(f.store, queue, `w-forward-${cell}`)
        await checkpointOwned(f.store, queue, run, startMarker('a'), '1', 60)
        if (phase === 'rollingBack') {
          await f.store.fail(queue, run.runId, run.claimToken, CAUSE, null)
          run = await claimActivated(f.store, queue, `w-pass-${cell}`)
        }
        return refusalName(doors[door](queue, run, write))
      }
      const table = async (names: Record<string, { key: string; stateJson: string }>) => {
        const answers: Record<string, Record<string, Record<string, string>>> = {}
        for (const door of Object.keys(doors) as (keyof typeof doors)[]) {
          const byPhase: Record<string, Record<string, string>> = {}
          for (const phase of ['forward', 'rollingBack'] as const) {
            const cells: Record<string, string> = {}
            for (const [label, write] of Object.entries(names)) {
              cells[label] = await answer(door, phase, write)
            }
            byPhase[phase] = cells
          }
          answers[door] = byPhase
        }
        return answers
      }
      const REFUSED = 'LeaseLostError'
      const every = (names: object, outcome: string) =>
        Object.fromEntries(Object.keys(names).map((label) => [label, outcome]))
      const reservedAnswers = await table(reserved)
      const lookalikeAnswers = await table(lookalikes)
      expect(
        reservedAnswers,
        'mutation-verdict:behavior:saga-caller-named-checkpoint-doors',
      ).toEqual({
        'set-checkpoint': {
          forward: { ...every(reserved, REFUSED), startMarker: 'accepted' },
          rollingBack: { ...every(reserved, REFUSED), rollback: 'accepted' },
        },
        suspend: {
          forward: { ...every(reserved, REFUSED), startMarker: 'accepted' },
          rollingBack: every(reserved, REFUSED),
        },
      })
      // A lookalike is a plain name: a forward checkpoint, which the phase freezes, and no
      // attempt record.
      expect(
        lookalikeAnswers,
        'mutation-verdict:behavior:saga-reserved-names-match-exactly',
      ).toEqual({
        'set-checkpoint': {
          forward: every(lookalikes, 'accepted'),
          rollingBack: every(lookalikes, REFUSED),
        },
        suspend: {
          forward: every(lookalikes, 'accepted'),
          rollingBack: every(lookalikes, REFUSED),
        },
      })
    })

    // The names under a reserved prefix are read as a range of the checkpoints key where a
    // name compares by its bytes, and by a test of each name where it does not. Either
    // way the names beside that range are no start marker: the prefix in another case,
    // the prefix without its colon, the name just below the range, the first past it, and
    // the prefix with an accent in it, which a comparison that folds accents would admit.
    it('owes no rollback to a name that only looks like a start marker', async () => {
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const run = await claimActivated(f.store, Q, 'w-forward')
      for (const name of [
        startMarker('a').toUpperCase(),
        SAGA_STARTED_PREFIX.slice(0, -1),
        `${SAGA_STARTED_PREFIX.slice(0, -1)}9`,
        firstNamePast(SAGA_STARTED_PREFIX),
        '$startéd:a',
      ]) {
        await checkpointOwned(f.store, Q, run, name, '1', 60)
      }
      expect(
        {
          failed: await f.store.fail(Q, run.runId, run.claimToken, CAUSE, null),
          result: await f.store.getTaskResult(Q, spawned.taskId),
        },
        'mutation-verdict:behavior:saga-start-markers-are-the-names-under-the-prefix',
      ).toEqual({
        failed: { rollingBack: false },
        result: { state: 'failed', failureReasonJson: CAUSE },
      })
    })

    // The three databases compare a name's bytes, and core's unit test compares them only in
    // JavaScript. No character after the colon can leave the range, so a step key of two,
    // three and four byte characters starts a step like any other, and its rollback is
    // found under the name built from it.
    it('owes a rollback to a step whose key is multi-byte, and finds that it ran', async () => {
      const step = 'café € \u{1F600}'
      const spawned = await f.store.spawn(Q, 'saga', '{}')
      const forward = await claimActivated(f.store, Q, 'w-forward')
      await startStep(f, forward, step, 1)
      const entered = await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)
      const pass = await claimActivated(f.store, Q, 'w-pass')
      await checkpointOwned(f.store, Q, pass, rollbackOf(step), 'null', 60)
      await f.store.fail(Q, pass.runId, pass.claimToken, CAUSE, null)
      expect({
        entered,
        rollback: (await f.store.getTaskResult(Q, spawned.taskId))?.rollback,
      }).toEqual({ entered: { rollingBack: true }, rollback: { outcome: 'complete' } })
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
  })
}
