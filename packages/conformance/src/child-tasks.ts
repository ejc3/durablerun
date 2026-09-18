import {
  ChildAwaitRefusedError,
  type ClaimedRun,
  INFRA_RETRY_CAP,
  REASON_CANCELLED,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_CAP,
  type SqlExecutor,
  type TaskOutcome,
  decodeTaskOutcome,
  encodeTaskOutcome,
  isTerminalState,
  taskDoneEventName,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { SimWorld } from '@durablerun/harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_BATCH_LABELS } from './fault-matrix.js'
import { type StoreFixture, type StoreFixtureFactory, interposeAfterBatch } from './fixture.js'
import { engineInvariantViolations, eventKey } from './invariants.js'
import {
  awaitTaskOwned,
  claimActivated,
  claimOne,
  readOne,
  refusalName,
  withFixture,
} from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000
const STEP = '$await-task'

/**
 * What specs/ChildTasks.tla requires of any history the engine itself produced, read
 * from the shared schema. It is not part of the invariant library, because that library
 * also judges states the poison matrix writes by hand, and a hand-written terminal task
 * has no batch that could have written its event. Every walk and scenario whose rows
 * only the engine wrote runs this beside the library.
 *
 * - TerminalImpliesDone: a terminal task has its completion event, in its own queue.
 * - DoneAuthority, as far as rows can show it: a completion event names a task of its
 *   queue, and its payload is an outcome `encodeTaskOutcome` wrote.
 */
export async function childTaskViolations(raw: SqlExecutor): Promise<string[]> {
  const [tasks, events] = await raw.batch(
    'child-task-violations',
    [
      { sql: 'SELECT task_id, queue, state FROM tasks', args: [] },
      { sql: 'SELECT queue, event_name, payload FROM events', args: [] },
    ],
    'read',
  )
  const violations: string[] = []
  const done = new Map<string, { eventName: string; payload: string }>()
  for (const event of events?.rows ?? []) {
    const eventName = String(event.event_name)
    if (taskIdOfDoneEvent(eventName) === null) continue
    done.set(eventKey(String(event.queue), eventName), {
      eventName,
      payload: String(event.payload),
    })
  }
  for (const task of tasks?.rows ?? []) {
    const taskId = String(task.task_id)
    const key = eventKey(String(task.queue), taskDoneEventName(taskId))
    const event = done.get(key)
    done.delete(key)
    if (event === undefined) {
      if (isTerminalState(task.state)) {
        violations.push(`terminal-task-without-completion-event: ${taskId}`)
      }
      continue
    }
    try {
      decodeTaskOutcome(taskId, event.payload)
    } catch (error) {
      violations.push(`completion-event-undecodable: ${taskId}: ${String(error)}`)
    }
  }
  for (const { eventName } of done.values()) {
    violations.push(`completion-event-without-task: ${eventName}`)
  }
  return violations
}

/** A store over the fixture's real executor that records every batch label, in order. */
function recordingLabels(f: StoreFixture): { store: StoreFixture['store']; labels: string[] } {
  const labels: string[] = []
  const store = f.storeOver({
    batch: (label, statements, control) => {
      labels.push(label)
      return f.raw.batch(label, statements, control)
    },
  })
  return { store, labels }
}

function awaitChild(
  store: StoreFixture['store'],
  queue: string,
  parent: ClaimedRun,
  childTaskId: string,
  timeoutSeconds: number | null,
) {
  return awaitTaskOwned(store, queue, parent, STEP, childTaskId, timeoutSeconds)
}

/** Park an activated parent on `childTaskId`. The parent is claimed before the child is spawned. */
async function parkedParent(
  f: StoreFixture,
  parent: ClaimedRun,
  childTaskId: string,
  timeoutSeconds: number | null = null,
): Promise<void> {
  const outcome = await awaitChild(f.store, Q, parent, childTaskId, timeoutSeconds)
  expect(outcome, 'a same-queue child that has not ended parks its parent').toEqual({
    emitted: false,
  })
}

async function claimedParent(f: StoreFixture): Promise<ClaimedRun> {
  await f.store.spawn(Q, 'parent', '{}')
  return claimActivated(f.store, Q, 'w-parent')
}

/** Why a child await was refused, or 'accepted'. */
function childRefusal(awaited: Promise<unknown>): Promise<string> {
  return awaited.then(
    () => 'accepted',
    (error: unknown) => (error instanceof ChildAwaitRefusedError ? error.reason : String(error)),
  )
}

/** A child made ready for one terminal batch to end. */
export interface ReadyChild {
  readonly childTaskId: string
  /** How the batch will end it. */
  readonly outcome: TaskOutcome
  /** How far the clock moves before `end`, for a batch that a deadline or a lease expiry triggers. */
  readonly advanceMs: number
  /** End the child through `store`, by the batch under test and no other. */
  readonly end: (store: StoreFixture['store']) => Promise<void>
}

export interface TerminalBatch {
  /** The batch label that ends the child. */
  readonly label: (typeof TERMINAL_BATCH_LABELS)[number]
  /** Spawn a child in `queue` and bring it to where this batch ends it. Claim any parent first. */
  readonly prepare: (f: StoreFixture, queue: string) => Promise<ReadyChild>
}

const FAILURE = '{"name":"ChildBoom"}'

/** A sweep of `queue` that must do exactly one thing. */
async function sweepOnce(store: StoreFixture['store'], queue: string, kind: string): Promise<void> {
  expect((await store.sweep(queue, 10)).map((swept) => swept.kind)).toEqual([kind])
}

/**
 * One entry for each batch that can end a task (ChildTasks.tla's ledger block). Each
 * owes the task's parent the same thing, so every case below that ends a child is
 * generated from this list and not written once for the batch someone thought of.
 */
export const TERMINAL_BATCHES: readonly TerminalBatch[] = [
  {
    label: 'complete',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}')
      const run = await claimActivated(f.store, queue, `w-child-${queue}`)
      return {
        childTaskId: child.taskId,
        outcome: { state: 'completed', completedPayloadJson: '{"out":7}' },
        advanceMs: 0,
        end: (store) => store.complete(queue, run.runId, run.claimToken, '{"out":7}'),
      }
    },
  },
  {
    label: 'fail',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}')
      const run = await claimActivated(f.store, queue, `w-child-${queue}`)
      return {
        childTaskId: child.taskId,
        outcome: { state: 'failed', failureReasonJson: FAILURE },
        advanceMs: 0,
        end: (store) => store.fail(queue, run.runId, run.claimToken, FAILURE, null),
      }
    },
  },
  {
    label: 'cancel-task',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}')
      return {
        childTaskId: child.taskId,
        outcome: { state: 'cancelled', failureReasonJson: REASON_CANCELLED },
        advanceMs: 0,
        end: async (store) => {
          expect(await store.cancelTask(queue, child.taskId)).toBe(true)
        },
      }
    },
  },
  {
    label: 'sweep:cancel',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}', {
        cancellation: { maxDelaySeconds: 5 },
      })
      return {
        childTaskId: child.taskId,
        outcome: { state: 'cancelled', failureReasonJson: REASON_CANCELLED },
        advanceMs: 10_000,
        end: (store) => sweepOnce(store, queue, 'cancelled'),
      }
    },
  },
  {
    label: 'sweep:lost-launch',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}')
      const run = await claimOne(f.store, queue, `w-child-${queue}`)
      await f.raw.batch('seed-relaunch-cap', [
        {
          sql: 'UPDATE runs SET relaunch_count = ? WHERE run_id = ?',
          args: [RELAUNCH_CAP, run.runId],
        },
      ])
      return {
        childTaskId: child.taskId,
        outcome: { state: 'failed', failureReasonJson: REASON_RELAUNCH_CAP },
        advanceMs: 100_000,
        end: (store) => sweepOnce(store, queue, 'relaunch-cap-exhausted'),
      }
    },
  },
  {
    label: 'sweep:claim-timeout',
    prepare: async (f, queue) => {
      const child = await f.store.spawn(queue, 'child', '{}')
      const run = await claimActivated(f.store, queue, `w-child-${queue}`)
      await f.raw.batch('seed-infra-cap', [
        {
          sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
          args: [INFRA_RETRY_CAP, run.taskId],
        },
        {
          sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
          args: [INFRA_RETRY_CAP + 1, run.runId],
        },
      ])
      return {
        childTaskId: child.taskId,
        outcome: { state: 'failed', failureReasonJson: REASON_INFRA_CAP },
        advanceMs: 100_000,
        end: (store) => sweepOnce(store, queue, 'infra-cap-exhausted'),
      }
    },
  },
]

/** Move the clock to where `ready`'s batch fires, then end the child through `store`. */
async function endChild(
  f: StoreFixture,
  ready: ReadyChild,
  store: StoreFixture['store'],
): Promise<void> {
  if (ready.advanceMs > 0) await f.admin.setFakeNowEpochMs(START_MS + ready.advanceMs)
  await ready.end(store)
}

async function storedDoneEvent(f: StoreFixture, childTaskId: string, queue = Q) {
  return readOne(f.raw, 'SELECT payload FROM events WHERE queue = ? AND event_name = ?', [
    queue,
    taskDoneEventName(childTaskId),
  ])
}

async function waitCount(f: StoreFixture): Promise<number> {
  const counted = await readOne(f.raw, 'SELECT COUNT(*) AS n FROM waits', [])
  return Number(counted?.n)
}

async function runState(f: StoreFixture, runId: string): Promise<unknown> {
  return (await readOne(f.raw, 'SELECT state FROM runs WHERE run_id = ?', [runId]))?.state
}

/**
 * The executable twins of specs/ChildTasks.tla, for every dialect. The model's ledger
 * block is read by nothing (`scripts/spec-ledger.py` reads Scheduler.tla), so each of
 * its actions and guards is held here by a case that names it.
 */
export function childTaskConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`child task conformance [${dialect}]`, () => {
    let f: StoreFixture

    beforeEach(async () => {
      f = await makeFixture('child-tasks')
      await f.admin.setFakeNowEpochMs(START_MS)
    })

    // A case that already failed has said what it found, and it may have stopped partway
    // through a history. Judging that half-made history too would put a second failure
    // beside the first, and a verdict must have exactly one. Every case that passes its
    // own assertions is still judged.
    afterEach(async ({ task }) => {
      const violations = await childTaskViolations(f.raw)
      await f.close()
      if (task.result?.state !== 'fail') expect(violations).toEqual([])
    })

    it('has one way to end a child for every terminal batch label', () => {
      expect(TERMINAL_BATCHES.map((batch) => batch.label)).toEqual([...TERMINAL_BATCH_LABELS])
    })

    // ChildTerminal, with AtomicEmit: the batch that ends the child writes its completion
    // event and wakes the registered waiter. TerminalImpliesDone and WaitIntegrity. One
    // case over every terminal batch, so a batch added to the list is held to it.
    it('every terminal batch writes the completion event and wakes a registered waiter', async () => {
      const observed: Record<string, unknown> = {}
      const expected: Record<string, unknown> = {}
      for (const batch of TERMINAL_BATCHES) {
        await withFixture(makeFixture, `child-terminal-${batch.label}`, async (fx) => {
          await fx.admin.setFakeNowEpochMs(START_MS)
          const parent = await claimedParent(fx)
          const recorded = recordingLabels(fx)
          const ready = await batch.prepare(fx, Q)
          const { childTaskId, outcome } = ready
          await parkedParent(fx, parent, childTaskId)
          await endChild(fx, ready, recorded.store)
          const payloadJson = encodeTaskOutcome(outcome)
          const eventName = taskDoneEventName(childTaskId)
          const parentRun = await readOne(
            fx.raw,
            'SELECT state, wake_event, event_payload FROM runs WHERE run_id = ?',
            [parent.runId],
          )
          // ParentClaimWoken: the claim hands the parent the parked outcome.
          const [woken] = await fx.store.claim(Q, 'w-parent-again', { leaseSeconds: 60, limit: 1 })
          observed[batch.label] = {
            ran: recorded.labels.includes(batch.label),
            event: (await storedDoneEvent(fx, childTaskId))?.payload,
            parent: parentRun,
            waits: await waitCount(fx),
            woken: woken?.runId === parent.runId ? woken.wake : 'the parent was not claimable',
            violations: [
              ...(await engineInvariantViolations(fx.raw)),
              ...(await childTaskViolations(fx.raw)),
            ],
          }
          expected[batch.label] = {
            ran: true,
            event: payloadJson,
            parent: { state: 'pending', wake_event: eventName, event_payload: payloadJson },
            waits: 0,
            woken: { event: eventName, step: STEP, payloadJson },
            violations: [],
          }
        })
      }
      expect(
        observed,
        'mutation-verdict:behavior:terminal-batch-writes-the-completion-event',
      ).toEqual(expected)
    })

    for (const batch of TERMINAL_BATCHES) {
      // The same batch with nobody waiting still writes the event: AwaitHit reads it later.
      it(`${batch.label} writes the completion event with no waiter, and a later await hits it`, async () => {
        const ready = await batch.prepare(f, Q)
        const { childTaskId, outcome } = ready
        await endChild(f, ready, f.store)
        // Claimed only now: a sweep that ends the child moves the clock past any lease.
        const parent = await claimedParent(f)
        const hit = await awaitChild(f.store, Q, parent, childTaskId, null)
        expect(hit).toEqual({ emitted: true, payloadJson: encodeTaskOutcome(outcome) })
        expect(await runState(f, parent.runId), 'a hit suspends nothing').toBe('running')
        expect(await waitCount(f)).toBe(0)
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })
    }

    // A terminal path that names the wrong task, or the wrong terminal statement, ends
    // the task and inserts no event, and an insert that matches nothing passes every
    // row-count audit. The executor here makes `complete`'s event insert match nothing,
    // which is what such a path would send. The write still answers as its batch did, so
    // what reports the missing event is the check this surface runs after every case,
    // and the fuzz and the SDK harness run over every history. This is that check, seen
    // failing.
    it('reports a batch that ended a task and recorded no completion event', async () => {
      const child = await f.store.spawn(Q, 'child', '{}')
      const run = await claimActivated(f.store, Q, 'w-child')
      const mislabelled = f.storeOver({
        batch: (label, statements, control) =>
          f.raw.batch(
            label,
            label !== 'complete'
              ? statements
              : statements.map((statement) =>
                  /^insert into ["`]events["`]/i.test(statement.sql)
                    ? { sql: 'SELECT 1 WHERE 1 = 0', args: [] }
                    : statement,
                ),
            control,
          ),
      })
      await mislabelled.complete(Q, run.runId, run.claimToken, '{}')
      expect(await childTaskViolations(f.raw)).toEqual([
        `terminal-task-without-completion-event: ${child.taskId}`,
      ])
      // The task did end with nothing recorded, which is the state an await repairs.
      const parent = await claimedParent(f)
      expect((await awaitChild(f.store, Q, parent, child.taskId, null)).emitted).toBe(true)
    })

    // A terminal write's answer is its batch's answer. A task that was revived and ends
    // again inserts no event, because its first outcome stands. Whatever the store reads
    // once that batch has committed, a failure of the read is not a failure of the write:
    // the run is complete, and the cancellation happened.
    it('answers a committed terminal write as committed when a read after it fails', async () => {
      const answers: Record<string, unknown> = {}
      for (const how of ['complete', 'cancel'] as const) {
        const child = await f.store.spawn(Q, `child-${how}`, '{}', { maxAttempts: 1 })
        const first = await claimActivated(f.store, Q, `w-first-${how}`)
        await f.store.fail(Q, first.runId, first.claimToken, FAILURE, null)
        expect(await f.store.retryTask(Q, child.taskId)).not.toBeNull()
        const second = await claimActivated(f.store, Q, `w-second-${how}`)
        const readsFail = f.storeOver({
          batch: (label, statements, control) =>
            label === 'task-done-state'
              ? Promise.reject(new Error('the connection dropped after the commit'))
              : f.raw.batch(label, statements, control),
        })
        const answer = await (how === 'complete'
          ? readsFail.complete(Q, second.runId, second.claimToken, '{}')
          : readsFail.cancelTask(Q, child.taskId)
        ).then(
          (value) => value ?? 'accepted',
          (error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
        )
        const task = await readOne(f.raw, 'SELECT state FROM tasks WHERE task_id = ?', [
          child.taskId,
        ])
        answers[how] = { answer, state: task?.state }
      }
      expect(answers).toEqual({
        complete: { answer: 'accepted', state: 'completed' },
        cancel: { answer: true, state: 'cancelled' },
      })
    })

    // A failure that retries ends nothing: the task is live, so it has no outcome yet.
    it('a failure that schedules a retry writes no completion event and wakes nobody', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn(Q, 'child', '{}', { maxAttempts: 2 })
      await parkedParent(f, parent, child.taskId)
      const run = await claimActivated(f.store, Q, 'w-child')
      const retrying = await refusalName(
        f.store.fail(Q, run.runId, run.claimToken, FAILURE, { delaySeconds: 0 }),
      )
      expect(
        {
          retrying,
          event: await storedDoneEvent(f, child.taskId),
          parent: await runState(f, parent.runId),
          waits: await waitCount(f),
        },
        'mutation-verdict:behavior:task-done-event-follows-the-terminal-statement',
      ).toEqual({ retrying: 'accepted', event: undefined, parent: 'sleeping', waits: 1 })
      // The retry's own failure is terminal, and that batch writes the event.
      const retried = await claimActivated(f.store, Q, 'w-child-2')
      await f.store.fail(Q, retried.runId, retried.claimToken, FAILURE, { delaySeconds: 0 })
      expect((await storedDoneEvent(f, child.taskId))?.payload).toBe(
        encodeTaskOutcome({ state: 'failed', failureReasonJson: FAILURE }),
      )
      expect(await runState(f, parent.runId)).toBe('pending')
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // ReviveChild, DoneIsFirstOutcome, DoneImmutable: a revived child that ends again
    // leaves the event alone, so an await before or after the revival reads one outcome.
    it('keeps the first outcome after retryTask revives the child and it completes', async () => {
      const child = await f.store.spawn(Q, 'child', '{}', { maxAttempts: 1 })
      const first = await claimActivated(f.store, Q, 'w-child')
      await f.store.fail(Q, first.runId, first.claimToken, FAILURE, null)
      expect(await f.store.retryTask(Q, child.taskId)).not.toBeNull()
      const revived = await claimActivated(f.store, Q, 'w-child-2')
      const secondEnding = await refusalName(
        f.store.complete(Q, revived.runId, revived.claimToken, '{"late":true}'),
      )
      const parent = await claimedParent(f)
      const hit = await awaitChild(f.store, Q, parent, child.taskId, null)
      expect(
        { secondEnding, hit, result: await f.store.getTaskResult(Q, child.taskId) },
        'mutation-verdict:behavior:task-done-event-first-write-wins',
      ).toEqual({
        secondEnding: 'accepted',
        hit: {
          emitted: true,
          payloadJson: encodeTaskOutcome({ state: 'failed', failureReasonJson: FAILURE }),
        },
        result: { state: 'completed', completedPayloadJson: '{"late":true}' },
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // UserMayForge is FALSE: the emit port refuses the reserved name. That case needs
    // nothing but the emit port, so it lives with the event cases of the scheduler suite.

    // The queue rule cannot be skipped by awaiting the reserved name directly.
    it('refuses to await a reserved event name through awaitEvent, and registers nothing', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn('other', 'child', '{}')
      const refused = await refusalName(
        f.store.awaitEvent(
          Q,
          parent.taskId,
          parent.runId,
          parent.claimToken,
          STEP,
          taskDoneEventName(child.taskId),
          null,
        ),
      )
      expect({
        refused,
        parent: await runState(f, parent.runId),
        waits: await waitCount(f),
      }).toEqual({ refused: 'RangeError', parent: 'running', waits: 0 })
    })

    // AwaitRefused and RefusedNeverWaits: a child in another queue is refused for good,
    // and registers nothing. The rule is decided inside the await batch, whose
    // compare-and-set requires a live child in the parent's queue. Only an await that
    // neither registered nor hit reads the child, to say why.
    it('refuses to await a child in another queue, and registers nothing', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn('other', 'child', '{}')
      const recorded = recordingLabels(f)
      const refusal = await childRefusal(awaitChild(recorded.store, Q, parent, child.taskId, 30))
      expect(
        {
          refusal,
          labels: recorded.labels,
          parent: await runState(f, parent.runId),
          waits: await waitCount(f),
        },
        'mutation-verdict:behavior:child-await-refuses-another-queue',
      ).toEqual({
        refusal: 'other-queue',
        labels: ['await-event', 'task-done-state'],
        parent: 'running',
        waits: 0,
      })
      // The child ends in its own queue, where its event is written, and the parent's
      // queue hears nothing of it.
      const childRun = await claimActivated(f.store, 'other', 'w-child')
      await f.store.complete('other', childRun.runId, childRun.claimToken, '{}')
      expect({
        there: (await storedDoneEvent(f, child.taskId, 'other')) !== undefined,
        here: await storedDoneEvent(f, child.taskId),
      }).toEqual({ there: true, here: undefined })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    it('refuses to await a task that does not exist', async () => {
      const parent = await claimedParent(f)
      const refusal = await childRefusal(awaitChild(f.store, Q, parent, 'no-such-task', null))
      expect(
        { refusal, waits: await waitCount(f) },
        'mutation-verdict:behavior:child-await-refuses-an-unknown-task',
      ).toEqual({
        refusal: 'no-such-task',
        waits: 0,
      })
    })

    // RefusalIsTheRule: an allowed await is never refused. Without this direction a
    // store that refused every child await would satisfy the case above.
    it('never refuses a same-queue child', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn(Q, 'child', '{}')
      const recorded = recordingLabels(f)
      const parked = await childRefusal(awaitChild(recorded.store, Q, parent, child.taskId, null))
      expect(
        { parked, waits: await waitCount(f) },
        'mutation-verdict:behavior:child-await-allows-the-same-queue',
      ).toEqual({ parked: 'accepted', waits: 1 })
      // The child's existence, queue, and state are read inside the batch, under the
      // event lock, so the common await is one batch and no read.
      expect(recorded.labels).toEqual(['await-event'])
    })

    /**
     * A child that is terminal with no completion event: a build older than this
     * protocol ended it, in a rolling deploy or before the protocol existed. It is made
     * here by ending the child through the store and deleting the event, which leaves
     * every other row as the engine wrote it.
     */
    async function endedWithNoEvent(how: 'completed' | 'failed'): Promise<string> {
      const child = await f.store.spawn(Q, 'child', '{}', { maxAttempts: 1 })
      const run = await claimActivated(f.store, Q, `w-old-build-${how}`)
      if (how === 'completed') await f.store.complete(Q, run.runId, run.claimToken, '{"old":1}')
      else await f.store.fail(Q, run.runId, run.claimToken, FAILURE, null)
      await f.raw.batch('an-older-build-wrote-no-event', [
        {
          sql: 'DELETE FROM events WHERE queue = ? AND event_name = ?',
          args: [Q, taskDoneEventName(child.taskId)],
        },
      ])
      return child.taskId
    }

    // AwaitMaterialize and WaitIsWakeable: no terminal batch will ever fire for such a
    // child again, so an await that registered a wait would sleep forever. The await
    // writes the event from the child's current outcome and answers as a hit.
    it('records the outcome of a child an older build ended, and never parks on it', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('completed')
      const payloadJson = encodeTaskOutcome({
        state: 'completed',
        completedPayloadJson: '{"old":1}',
      })
      const answer = await awaitChild(f.store, Q, parent, childTaskId, null)
      await f.store.spawn(Q, 'second-parent', '{}')
      const second = await claimActivated(f.store, Q, 'w-second-parent')
      expect(
        {
          answer,
          event: (await storedDoneEvent(f, childTaskId))?.payload,
          parent: await runState(f, parent.runId),
          waits: await waitCount(f),
          secondAnswer: await awaitChild(f.store, Q, second, childTaskId, null),
        },
        'mutation-verdict:behavior:child-await-records-an-unrecorded-ending',
      ).toEqual({
        answer: { emitted: true, payloadJson },
        event: payloadJson,
        parent: 'running',
        waits: 0,
        secondAnswer: { emitted: true, payloadJson },
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // The recorded outcome is the first outcome from then on (DoneImmutable): a revival
    // that ends differently afterwards does not rewrite it.
    it('keeps the outcome it recorded after the child is revived and ends again', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('failed')
      const recordedFailure = encodeTaskOutcome({ state: 'failed', failureReasonJson: FAILURE })
      expect(await awaitChild(f.store, Q, parent, childTaskId, null)).toEqual({
        emitted: true,
        payloadJson: recordedFailure,
      })
      expect(await f.store.retryTask(Q, childTaskId)).not.toBeNull()
      const revived = await claimActivated(f.store, Q, 'w-revived')
      await f.store.complete(Q, revived.runId, revived.claimToken, '{"late":true}')
      expect((await storedDoneEvent(f, childTaskId))?.payload).toBe(recordedFailure)
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // The outcome is read before the batch that records it, and that batch is fenced on
    // the child's row being the one that was read. A child revived in between is live
    // again, so nothing is recorded and the await registers like any other.
    it('records nothing when the child is revived between the read and the batch', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('failed')
      const interposed = interposeAfterBatch(f.raw, 'task-done-state', async () => {
        expect(await f.store.retryTask(Q, childTaskId)).not.toBeNull()
      })
      const answer = await awaitChild(
        f.storeOver(interposed.executor),
        Q,
        parent,
        childTaskId,
        null,
      )
      expect(
        {
          revivedInBetween: interposed.fired(),
          answer,
          event: await storedDoneEvent(f, childTaskId),
          parent: await runState(f, parent.runId),
          waits: await waitCount(f),
        },
        'mutation-verdict:behavior:child-await-records-only-the-row-it-read',
      ).toEqual({
        revivedInBetween: true,
        answer: { emitted: false },
        event: undefined,
        parent: 'sleeping',
        waits: 1,
      })
      // The revived child ends under this build, and that batch wakes the parent.
      const revived = await claimActivated(f.store, Q, 'w-revived')
      await f.store.complete(Q, revived.runId, revived.claimToken, '{}')
      expect(await runState(f, parent.runId)).toBe('pending')
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // The other side of the same race: the child is revived before the read that says why
    // the await neither registered nor hit. It is live again, so the next round registers
    // on it. Answering with the claim's loss would make a parent that holds a live claim
    // abandon its pass, and the sweep would charge it an infrastructure retry.
    it('registers on a child that is revived before the read that says why', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('failed')
      const interposed = interposeAfterBatch(f.raw, 'await-event', async () => {
        expect(await f.store.retryTask(Q, childTaskId)).not.toBeNull()
      })
      const answer = await awaitChild(
        f.storeOver(interposed.executor),
        Q,
        parent,
        childTaskId,
        null,
      ).catch((error: unknown) => (error instanceof Error ? error.name : String(error)))
      expect(
        {
          revivedInBetween: interposed.fired(),
          answer,
          parent: await runState(f, parent.runId),
          waits: await waitCount(f),
        },
        'mutation-verdict:behavior:child-await-registers-on-a-revived-child',
      ).toEqual({
        revivedInBetween: true,
        answer: { emitted: false },
        parent: 'sleeping',
        waits: 1,
      })
      // The revived child ends under this build, and that batch wakes the parent.
      const revived = await claimActivated(f.store, Q, 'w-revived')
      await f.store.complete(Q, revived.runId, revived.claimToken, '{}')
      expect(await runState(f, parent.runId)).toBe('pending')
    })

    // The record batch requires that no event exists. A terminal batch of this build may
    // have written one since the read, and then that event is the answer.
    it('answers with an event a terminal batch wrote between the read and the batch', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('completed')
      const written = encodeTaskOutcome({
        state: 'completed',
        completedPayloadJson: '{"written":"since"}',
      })
      const interposed = interposeAfterBatch(f.raw, 'task-done-state', async () => {
        await f.raw.batch('a-batch-wrote-the-event-since', [
          {
            sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                  VALUES (?, ?, ?, ?)`,
            args: [Q, taskDoneEventName(childTaskId), written, START_MS],
          },
        ])
      })
      const answer = await awaitChild(
        f.storeOver(interposed.executor),
        Q,
        parent,
        childTaskId,
        null,
      ).catch((error: unknown) => String(error))
      expect(
        { answer, event: (await storedDoneEvent(f, childTaskId))?.payload },
        'mutation-verdict:behavior:child-await-keeps-an-event-written-since-the-read',
      ).toEqual({ answer: { emitted: true, payloadJson: written }, event: written })
    })

    // Only a run that still holds its claim records anything. A zombie whose lease was
    // swept reads the same ended child and must write nothing.
    // fenceTwin('AwaitMaterialize'): a zombie whose claim was swept records nothing.
    it('records nothing for a run whose claim is gone', async () => {
      const parent = await claimedParent(f)
      const childTaskId = await endedWithNoEvent('completed')
      await f.store.expireLeaseNow(Q, parent.runId, parent.claimToken)
      await f.store.sweep(Q, 10)
      const zombie = await refusalName(awaitChild(f.store, Q, parent, childTaskId, null))
      expect(
        { zombie, event: await storedDoneEvent(f, childTaskId) },
        'mutation-verdict:behavior:child-await-records-only-under-a-live-claim',
      ).toEqual({ zombie: 'LeaseLostError', event: undefined })
      // The successor holds a live claim, and its await records the ending.
      await f.admin.setFakeNowEpochMs(START_MS + 10_000)
      const successor = await claimActivated(f.store, Q, 'w-successor')
      expect((await awaitChild(f.store, Q, successor, childTaskId, null)).emitted).toBe(true)
    })

    // AwaitTimeout: the claim that finds the wait due consumes it and returns no
    // outcome, and the child's later terminal batch finds no wait row to wake.
    it('a timed child await that comes due returns no outcome, and the late event wakes nobody', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn(Q, 'child', '{}')
      await parkedParent(f, parent, child.taskId, 30)
      await f.admin.setFakeNowEpochMs(START_MS + 31_000)
      const claimed = await f.store.claim(Q, 'w-timeout', { leaseSeconds: 60, limit: 5 })
      const woken = claimed.find((run) => run.runId === parent.runId)
      expect(woken?.wake).toEqual({
        event: taskDoneEventName(child.taskId),
        step: STEP,
        timedOut: true,
      })
      const childRun = claimed.find((run) => run.taskId === child.taskId)
      if (childRun === undefined) throw new Error('expected the child run in the same claim')
      await f.store.complete(Q, childRun.runId, childRun.claimToken, '{}')
      // AnswerIsFinal: the timeout was the answer, and the emit moves the parent nowhere.
      expect({ parent: await runState(f, parent.runId), waits: await waitCount(f) }).toEqual({
        parent: 'running',
        waits: 0,
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // CancelParent: the parent's cancellation deletes its wait, so the child's
    // terminal batch wakes nobody and resurrects nothing.
    it('cancelling a waiting parent removes its wait, and the child ending wakes nobody', async () => {
      const parent = await claimedParent(f)
      const child = await f.store.spawn(Q, 'child', '{}')
      await parkedParent(f, parent, child.taskId)
      expect(await f.store.cancelTask(Q, parent.taskId)).toBe(true)
      const childRun = await claimActivated(f.store, Q, 'w-child')
      await f.store.complete(Q, childRun.runId, childRun.claimToken, '{}')
      expect({ parent: await runState(f, parent.runId), waits: await waitCount(f) }).toEqual({
        parent: 'cancelled',
        waits: 0,
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // Not modeled, because each wait is its own row: one child wakes every parent.
    it('wakes every parent that awaits the same child', async () => {
      await f.store.spawn(Q, 'parent-a', '{}')
      await f.store.spawn(Q, 'parent-b', '{}')
      const parents = [
        await claimActivated(f.store, Q, 'w-a'),
        await claimActivated(f.store, Q, 'w-b'),
      ]
      const child = await f.store.spawn(Q, 'child', '{}')
      for (const parent of parents) await parkedParent(f, parent, child.taskId)
      expect(await f.store.cancelTask(Q, child.taskId)).toBe(true)
      const woken = await f.store.claim(Q, 'w-both', { leaseSeconds: 60, limit: 5 })
      expect(woken.map((run) => run.runId).sort()).toEqual(parents.map((run) => run.runId).sort())
      expect(await waitCount(f)).toBe(0)
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    })

    // The model's actions are atomic and mutually exclusive. Every interleaving of the
    // parent's await with the child's terminal batch ends delivered: a hit, or a wake.
    it('no lost wakeup: the child ending races the await, every interleaving, ends delivered', async () => {
      for (let seed = 0; seed < 10; seed++) {
        await withFixture(makeFixture, `child-race-${seed}`, async (fx) => {
          await fx.admin.setFakeNowEpochMs(START_MS)
          await fx.store.spawn(Q, 'parent', '{}')
          const parent = await claimActivated(fx.store, Q, 'w-parent')
          const child = await fx.store.spawn(Q, 'child', '{}')
          const childRun = await claimActivated(fx.store, Q, 'w-child')
          const world = new SimWorld(fx.raw, seed)
          let inline: string | null = null
          world.actor('parent', async (simDb) => {
            const out = await awaitChild(fx.storeOver(simDb), Q, parent, child.taskId, null).catch(
              () => null,
            )
            if (out?.emitted) inline = out.payloadJson
          })
          world.actor('child', async (simDb) => {
            await fx.storeOver(simDb).complete(Q, childRun.runId, childRun.claimToken, '{"r":1}')
          })
          await world.run()
          const payloadJson = encodeTaskOutcome({
            state: 'completed',
            completedPayloadJson: '{"r":1}',
          })
          if (inline === null) {
            const [woken] = await fx.store.claim(Q, 'w-parent-2', { leaseSeconds: 60, limit: 1 })
            expect(woken?.runId, `seed ${seed}`).toBe(parent.runId)
            expect(woken?.wake, `seed ${seed}`).toEqual({
              event: taskDoneEventName(child.taskId),
              step: STEP,
              payloadJson,
            })
          } else {
            expect(inline, `seed ${seed}`).toBe(payloadJson)
          }
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          expect(await childTaskViolations(fx.raw), `seed ${seed}`).toEqual([])
        })
      }
    })

    // SimWorld schedules whole batches, so it cannot show the transaction prelude that
    // serializes two real PostgreSQL clients. Without the event lock in a terminal batch,
    // a parent reads no event, the child inserts it and sees no wait row, and the parent
    // sleeps forever. SQLite's single writer hides that race, so it runs on both. Every
    // terminal batch is raced, because each takes the lock at its own site.
    it('serializes a real concurrent await against every terminal batch without losing a wakeup', async () => {
      const RACES = 12
      const observed: Record<string, unknown> = {}
      const expected: Record<string, unknown> = {}
      for (const batch of TERMINAL_BATCHES) {
        await withFixture(makeFixture, `child-native-race-${batch.label}`, async (fx) => {
          await fx.admin.setFakeNowEpochMs(START_MS)
          const races = []
          for (let index = 0; index < RACES; index++) {
            const queue = `native-child-${index}`
            await fx.store.spawn(queue, 'parent', '{}')
            // A lease that outlives the clock move a sweep needs.
            const parent = await claimActivated(fx.store, queue, `native-parent-${index}`, 3600)
            races.push({ queue, parent, ready: await batch.prepare(fx, queue) })
          }
          const advanceMs = Math.max(...races.map(({ ready }) => ready.advanceMs))
          if (advanceMs > 0) await fx.admin.setFakeNowEpochMs(START_MS + advanceMs)
          await Promise.all(
            Array.from({ length: RACES }, (_, index) =>
              fx.raw.batch(
                `native-child:warm-${index}`,
                [{ sql: 'SELECT 1 AS ready', args: [] }],
                'read',
              ),
            ),
          )
          const outcomes = await Promise.all(
            races.map(async ({ queue, parent, ready }) => {
              const [awaited] = await Promise.all([
                awaitChild(fx.store, queue, parent, ready.childTaskId, null),
                ready.end(fx.store),
              ])
              const stored = await readOne(
                fx.raw,
                'SELECT state, event_payload FROM runs WHERE run_id = ?',
                [parent.runId],
              )
              const payloadJson = encodeTaskOutcome(ready.outcome)
              // Either the await read the event inline, or the batch woke the parked run.
              return awaited.emitted
                ? awaited.payloadJson === payloadJson && stored?.state === 'running'
                : stored?.state === 'pending' && stored.event_payload === payloadJson
            }),
          )
          observed[batch.label] = {
            delivered: outcomes.filter(Boolean).length,
            strandedWaits: await waitCount(fx),
            violations: [
              ...(await engineInvariantViolations(fx.raw)),
              ...(await childTaskViolations(fx.raw)),
            ],
          }
          expected[batch.label] = { delivered: RACES, strandedWaits: 0, violations: [] }
        })
      }
      // A smoke of real concurrency on every dialect. Whether an unlocked batch loses a
      // wakeup here is a matter of timing, and four of the five PostgreSQL lock sites
      // were seen to survive it. The PostgreSQL case that holds the window open is the
      // one that holds each lock.
      expect(observed).toEqual(expected)
    })
  })
}
