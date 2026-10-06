import {
  MAX_EPOCH_MS,
  REASON_CANCELLED,
  SAGA_STARTED_PREFIX,
  type SqlExecutor,
  type SqlStatement,
  TERMINAL_STATES,
  type TerminalState,
  encodeTaskOutcome,
  parseFenceStamp,
  taskDoneEventName,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type ReadyChild, TERMINAL_BATCHES, type TerminalBatch } from './child-tasks.js'
import { engineHistoryViolations } from './engine-history.js'
import {
  MATRIX_RETENTION_POLICY,
  MATRIX_WRITE_LABELS,
  type MatrixWriteLabel,
  TERMINAL_BATCH_LABELS,
} from './fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import {
  ENDED_TASK_SHAPE_CELLS,
  type EndedChildReplayObservation,
  type EndedTaskStamp,
  type EndedTaskStamps,
  HEALTHY_INVOCATION,
  INVOCATION_SHAPES,
  POISON_INVOCATION,
  TERMINAL_PRE_STATE_ENDED_AT_MS,
  TERMINAL_PRE_STATE_INVOKED_AT_MS,
  type TerminalPreStateObservation,
  observeTerminalPreState,
  snapshot,
  storedInstant,
} from './poison-matrix.js'
import { purgeConformance } from './retention-purge.js'
import {
  checkpointOwned,
  claimActivated,
  handWrittenRun,
  handWrittenTask,
  readOne,
  withFixture,
} from './scenario.js'
import { corpusVariantOf, readCorpusDescriptor } from './sql-corpus.js'

const Q = 'q'
const START_MS = 1_000_000

/**
 * How long after a task was made ready its ending comes. Every earlier write of the task's
 * row stamped it at the starting instant, so an ending that left the stamp alone, or left
 * it NULL, reads differently from one that stamped it.
 */
const ENDING_GAP_MS = 2_500

const BOOM = '{"name":"Boom"}'

type TerminalLabel = (typeof TERMINAL_BATCH_LABELS)[number]

/** One way to end a task through one shape of a terminal label's batch. */
export interface EndingPath {
  /** What is ended and how, for the case's title. */
  readonly path: string
  /** The statement of the batch that the task's row must name as the one that ended it. */
  readonly endedBy: string
  /** The instant the case starts at, when the path needs another than the usual one. */
  readonly startMs?: number
  readonly prepare: TerminalBatch['prepare']
}

/** The way the child-task surface ends a task by `label`, which is that label's plainest path. */
const asTheChildSurfaceEndsIt =
  (label: TerminalLabel): TerminalBatch['prepare'] =>
  (f, queue) => {
    const batch = TERMINAL_BATCHES.find((candidate) => candidate.label === label)
    if (batch === undefined)
      throw new Error(`nothing in the child-task surface ends a task by ${label}`)
    return batch.prepare(f, queue)
  }

/** A task in the rolling-back phase, with the pass that rolls it back claimed and started. */
async function rollingBack(f: StoreFixture, queue: string) {
  const task = await f.store.spawn(queue, 'saga', '{}')
  const forward = await claimActivated(f.store, queue, `w-forward-${queue}`)
  await checkpointOwned(f.store, queue, forward, `${SAGA_STARTED_PREFIX}a`, '1', 60)
  await f.store.fail(queue, forward.runId, forward.claimToken, BOOM, null)
  return { taskId: task.taskId, pass: await claimActivated(f.store, queue, `w-pass-${queue}`) }
}

/**
 * A task that a cancellation asked to spare a saga ends, because its saga has not begun:
 * one no worker has claimed, or one whose registered step started and that has not failed.
 */
async function cancelledSparingASaga(
  f: StoreFixture,
  queue: string,
  stepStarted: boolean,
): Promise<ReadyChild> {
  const task = await f.store.spawn(queue, 'saga', '{}')
  if (stepStarted) {
    const run = await claimActivated(f.store, queue, `w-${queue}`)
    await checkpointOwned(f.store, queue, run, `${SAGA_STARTED_PREFIX}a`, '1', 60)
  }
  return {
    childTaskId: task.taskId,
    outcome: { state: 'cancelled', failureReasonJson: REASON_CANCELLED },
    advanceMs: 0,
    end: async (store) => {
      expect(await store.cancelTask(queue, task.taskId, { unlessSagaBegan: true })).toBe(true)
    },
  }
}

const failed = (childTaskId: string, end: ReadyChild['end']): ReadyChild => ({
  childTaskId,
  outcome: { state: 'failed', failureReasonJson: BOOM },
  advanceMs: 0,
  end,
})

/**
 * Every shape a terminal label's batch compiles to, as the SQL corpus names it, with the
 * ways a task is ended through it. A label is not a path: `fail` ends a task through one
 * statement when no retry is asked and through another when a retry is asked and the
 * budget refuses it, and each is a batch shape of its own in the corpus. The shapes come
 * from `corpus/labels.json`, which the corpus test holds to what every store compiles, so
 * a shape added there has no entry here and fails the inventory case by name. Reaching a
 * batch takes a scenario, so the paths are written by hand, and a second path through one
 * shape is listed where its pre-state differs: inside the rolling-back phase, or under a
 * worker's claim.
 */
export const ENDINGS: Readonly<Record<string, readonly EndingPath[]>> = {
  'complete/completed': [
    {
      path: 'a run its worker completes',
      endedBy: 'task',
      prepare: asTheChildSurfaceEndsIt('complete'),
    },
  ],
  'fail/retrying': [
    {
      path: 'a retry asked at the attempt cap',
      endedBy: 'task-terminal',
      prepare: async (f, queue) => {
        const task = await f.store.spawn(queue, 'job', '{}', { maxAttempts: 1 })
        const run = await claimActivated(f.store, queue, `w-${queue}`)
        return failed(task.taskId, async (store) => {
          await store.fail(queue, run.runId, run.claimToken, BOOM, { delaySeconds: 1 })
        })
      },
    },
  ],
  'fail/final': [
    {
      path: 'a failure no retry follows',
      endedBy: 'task',
      prepare: asTheChildSurfaceEndsIt('fail'),
    },
    {
      path: 'a failure no retry follows, inside the rolling-back phase',
      endedBy: 'task',
      prepare: async (f, queue) => {
        const { taskId, pass } = await rollingBack(f, queue)
        return failed(taskId, async (store) => {
          await store.fail(queue, pass.runId, pass.claimToken, BOOM, null)
        })
      },
    },
  ],
  'fail-rollback/retrying': [
    {
      // The pass that would retry the rollback is due after its delay, and an instant past
      // the last one the engine keeps cannot be stored, so no pass is placed and the task
      // ends where it stands.
      path: 'a retry of the rollback whose delay runs past the last instant the engine keeps',
      endedBy: 'task',
      startMs: MAX_EPOCH_MS - 100_000,
      prepare: async (f, queue) => {
        const { taskId, pass } = await rollingBack(f, queue)
        return failed(taskId, async (store) => {
          await store.failRollback(
            queue,
            pass.runId,
            pass.claimToken,
            BOOM,
            { delaySeconds: 100 },
            { stepKey: 'a', errorJson: '{"name":"RollbackBoom"}' },
          )
        })
      },
    },
  ],
  'fail-rollback/final': [
    {
      path: 'a failed rollback no retry follows',
      endedBy: 'task',
      prepare: asTheChildSurfaceEndsIt('fail-rollback'),
    },
  ],
  'cancel-task/cancelled': [
    {
      path: 'a task no worker has claimed',
      endedBy: 'cancel',
      prepare: asTheChildSurfaceEndsIt('cancel-task'),
    },
    {
      path: 'a task a worker is running',
      endedBy: 'cancel',
      prepare: async (f, queue) => {
        const ready = await asTheChildSurfaceEndsIt('cancel-task')(f, queue)
        const run = await claimActivated(f.store, queue, `w-${queue}`)
        if (run.taskId !== ready.childTaskId) throw new Error('the claim did not take the task')
        return ready
      },
    },
  ],
  'cancel-task/cancelled-unless-saga-began': [
    {
      path: 'a task no worker has claimed, by a cancellation asked to spare a saga',
      endedBy: 'cancel',
      prepare: (f, queue) => cancelledSparingASaga(f, queue, false),
    },
    {
      path: 'a task whose registered step started and whose saga has not begun, by the same',
      endedBy: 'cancel',
      prepare: (f, queue) => cancelledSparingASaga(f, queue, true),
    },
  ],
  'sweep:cancel/cancelled': [
    {
      path: 'a task past its cancellation deadline',
      endedBy: 'cancel',
      prepare: asTheChildSurfaceEndsIt('sweep:cancel'),
    },
  ],
  'sweep:lost-launch/swept': [
    {
      path: 'a launch lost at the relaunch cap',
      endedBy: 'task-fail',
      prepare: asTheChildSurfaceEndsIt('sweep:lost-launch'),
    },
  ],
  'sweep:claim-timeout/swept': [
    {
      path: 'a claim that timed out at the infrastructure cap',
      endedBy: 'task-terminal',
      prepare: asTheChildSurfaceEndsIt('sweep:claim-timeout'),
    },
  ],
}

/** One stamp case: a shape of a terminal label's batch, and one path through it. */
export interface EndingStampCase {
  readonly label: TerminalLabel
  readonly variant: string
  readonly ending: EndingPath
}

/** Every shape a terminal label's batch compiles to, from the corpus descriptor. */
export function terminalBatchShapes(): { label: TerminalLabel; variant: string }[] {
  const descriptor = readCorpusDescriptor()
  return TERMINAL_BATCH_LABELS.flatMap((label) =>
    (descriptor[label] ?? []).map((variant) => ({ label, variant })),
  )
}

/** The stamp cases: for each shape the corpus declares, each path listed for it. */
export function endingStampCases(): EndingStampCase[] {
  return terminalBatchShapes().flatMap(({ label, variant }) =>
    (ENDINGS[`${label}/${variant}`] ?? []).map((ending) => ({ label, variant, ending })),
  )
}

/** What a stamp case reads once a terminal batch has ended a task. */
export interface EndingStamp {
  /** The shape of the label's batch that was sent, as the corpus names it. */
  readonly sent: string
  /** The statement the ended task's row names as the one that wrote it last. */
  readonly endedBy: string | null
  /** The stamp of the task's row before the ending. */
  readonly stampedBeforeAtMs: number | null
  readonly state: unknown
  /** `tasks.fence_at_ms` after the ending, which retention reads a unit's age from. */
  readonly stampedAtMs: number | null
  /** The instant of the completion event the same batch wrote. */
  readonly eventAtMs: number | null
  readonly violations: readonly string[]
}

/** An executor that keeps the statements of every batch sent under `label`. */
function keeping(raw: SqlExecutor, label: string, kept: (readonly SqlStatement[])[]): SqlExecutor {
  return {
    batch: (name, statements, control) => {
      if (name === label) kept.push(statements)
      return raw.batch(name, statements, control)
    },
  }
}

/**
 * End one task by one path at an instant of its own, and read what the ending left on the
 * task's row. The expected answer is written from what the scenario did: the clock it set,
 * the shape of the batch its path is listed under, and the statement that path names.
 */
export async function endingStampCase(
  makeFixture: StoreFixtureFactory,
  { label, variant, ending }: EndingStampCase,
): Promise<{ observed: EndingStamp; expected: EndingStamp }> {
  return withFixture(makeFixture, `ending-stamp-${label}-${variant}`, async (f) => {
    const startMs = ending.startMs ?? START_MS
    await f.admin.setFakeNowEpochMs(startMs)
    const ready = await ending.prepare(f, Q)
    const row = () =>
      readOne(f.raw, 'SELECT state, fence_stamp, fence_at_ms FROM tasks WHERE task_id = ?', [
        ready.childTaskId,
      ])
    const before = await row()
    const endedAtMs = startMs + ready.advanceMs + ENDING_GAP_MS
    await f.admin.setFakeNowEpochMs(endedAtMs)
    const kept: (readonly SqlStatement[])[] = []
    await ready.end(f.storeOver(keeping(f.raw, label, kept)))
    const after = await row()
    const event = await readOne(
      f.raw,
      'SELECT emitted_at_ms FROM events WHERE queue = ? AND event_name = ?',
      [Q, taskDoneEventName(ready.childTaskId)],
    )
    const [statements, ...more] = kept
    const stamp = parseFenceStamp(String(after?.fence_stamp))
    return {
      observed: {
        sent:
          statements === undefined || more.length > 0
            ? `${kept.length} batches under ${label}`
            : `${label}/${corpusVariantOf(readCorpusDescriptor(), label, statements)}`,
        endedBy: stamp.ok ? stamp.statement : null,
        stampedBeforeAtMs: storedInstant(before?.fence_at_ms),
        state: after?.state,
        stampedAtMs: storedInstant(after?.fence_at_ms),
        eventAtMs: storedInstant(event?.emitted_at_ms),
        violations: await engineHistoryViolations(f.raw),
      },
      expected: {
        sent: `${label}/${variant}`,
        endedBy: ending.endedBy,
        stampedBeforeAtMs: startMs,
        state: ready.outcome.state,
        stampedAtMs: endedAtMs,
        eventAtMs: endedAtMs,
        violations: [],
      },
    }
  })
}

/** The one exit from a terminal state: `retry-task` revives a failed task. */
function revives(label: MatrixWriteLabel, state: string): boolean {
  return label === 'retry-task' && state === 'failed'
}

/**
 * Run one write label over a task the engine had already ended, and say what its stamp
 * must read afterwards. `retry-task` moves a failed task's stamp to the instant of the
 * revival, which restarts its age. Nothing else moves the stamp of a task that had ended.
 */
export async function terminalPreStateCase(
  makeFixture: StoreFixtureFactory,
  label: MatrixWriteLabel,
  state: TerminalState,
): Promise<{ observed: TerminalPreStateObservation; expected: TerminalPreStateObservation }> {
  const observed = await observeTerminalPreState(makeFixture, label, state)
  const after = (before: EndedTaskStamp): EndedTaskStamp =>
    revives(label, before.state)
      ? { state: 'pending', stampedAtMs: TERMINAL_PRE_STATE_INVOKED_AT_MS }
      : before
  const tasks: Record<string, EndedTaskStamps> = {}
  for (const [taskId, seen] of Object.entries(observed.tasks)) {
    tasks[taskId] = { before: seen.before, after: after(seen.before) }
  }
  // The purge is the one label that removes a task that had ended. Its healthy call names
  // a unit that completed at the cell's first instant, and is sent a window later, so that
  // unit goes. It is expected whether or not it was read, so a purge that took nothing
  // fails here.
  if (label === 'purge-unit') {
    tasks[HEALTHY_INVOCATION.taskId] = {
      before: { state: 'completed', stampedAtMs: TERMINAL_PRE_STATE_ENDED_AT_MS },
      after: null,
    }
  }
  // The task the cell is about was ended by the engine, at the instant the cell set. It is
  // expected whether or not it was read, so a cell whose task had not ended fails.
  const ended = { state, stampedAtMs: TERMINAL_PRE_STATE_ENDED_AT_MS }
  tasks[POISON_INVOCATION.taskId] = { before: ended, after: after(ended) }
  return {
    observed,
    expected: { reachedTheEndedTask: true, fired: true, healthy: 'fulfilled', tasks },
  }
}

function terminalPreStateTitle(label: MatrixWriteLabel, state: TerminalState): string {
  if (label === 'purge-unit') {
    return `purge-unit leaves a ${state} task younger than its window as its ending left it, and takes the unit that is a window old`
  }
  return revives(label, state)
    ? 'retry-task moves the stamp of the failed task it revives to the instant of the revival'
    : `${label} leaves the stamp of a ${state} task where its ending put it`
}

type OtherShape = keyof typeof ENDED_TASK_SHAPE_CELLS

/**
 * Replay a parent's spawn of a child that the engine has ended, and say what the replay
 * must answer and what the child's row must read: the same child, nothing created, and the
 * stamp its ending wrote.
 */
export async function endedChildReplayCase(
  makeFixture: StoreFixtureFactory,
  shape: OtherShape,
  state: TerminalState,
): Promise<{ observed: EndedChildReplayObservation; expected: EndedChildReplayObservation }> {
  const ended = { state, stampedAtMs: TERMINAL_PRE_STATE_ENDED_AT_MS }
  return {
    observed: await ENDED_TASK_SHAPE_CELLS[shape](makeFixture, state),
    expected: {
      sent: true,
      sameChild: true,
      created: false,
      child: { before: ended, after: ended },
    },
  }
}

/**
 * What retention will rely on before any store can purge (DESIGN.md §3.12): the stamp a
 * unit's age is read from, and the row checks that see what a wrong purge would leave.
 * The stamp cases are generated from the shapes the corpus declares for the terminal batch
 * labels, and the cells from the write labels and the call shapes, so a shape, a label or
 * a call shape added to one of those lists is held here without a case being written.
 */
export function retentionConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`retention conformance [${dialect}]`, () => {
    describe('the stamp of an ending', () => {
      // The shapes are the corpus's and the paths are listed by hand, so this is what
      // fails when a terminal label's batch gains a shape and no case ends a task by it.
      it('ends a task through every shape a terminal label compiles to', () => {
        expect(
          Object.keys(ENDINGS),
          'mutation-verdict:behavior:retention-every-terminal-batch-shape-has-a-stamp-case',
        ).toEqual(terminalBatchShapes().map(({ label, variant }) => `${label}/${variant}`))
      })

      for (const stampCase of endingStampCases()) {
        const { label, variant, ending } = stampCase
        it(`${label}/${variant}, ${ending.path}: the batch stamps the task it ends with the ending instant`, async () => {
          const { observed, expected } = await endingStampCase(makeFixture, stampCase)
          expect(
            observed,
            'mutation-verdict:behavior:terminal-batch-stamps-the-ending-instant',
          ).toEqual(expected)
        })
      }
    })

    describe('a write label over a task that had ended', () => {
      for (const label of MATRIX_WRITE_LABELS) {
        for (const state of TERMINAL_STATES) {
          it(terminalPreStateTitle(label, state), async () => {
            const { observed, expected } = await terminalPreStateCase(makeFixture, label, state)
            expect(observed).toEqual(expected)
          })
        }
      }

      for (const shape of Object.keys(ENDED_TASK_SHAPE_CELLS) as OtherShape[]) {
        for (const state of TERMINAL_STATES) {
          it(`spawn${INVOCATION_SHAPES[shape].form} finds a ${state} child by its reserved key, and leaves its stamp where its ending put it`, async () => {
            const { observed, expected } = await endedChildReplayCase(makeFixture, shape, state)
            expect(observed).toEqual(expected)
          })
        }
      }
    })

    // specs/Retention.tla's twins among the row checks. Each case writes by hand the rows a
    // wrong purge would leave, with nothing else wrong, so the one condition is all that
    // names them.
    describe('the rows a wrong purge would leave', () => {
      it('names a task row whose runs are gone', async () => {
        await withFixture(makeFixture, 'retention-rows-no-run', async (f) => {
          const outcome = { state: 'completed', completedPayloadJson: '{"out":1}' } as const
          await f.raw.batch(
            'hand-written-rows',
            [
              handWrittenTask({
                taskId: 'kept-row',
                state: 'completed',
                atMs: START_MS,
                completedPayload: outcome.completedPayloadJson,
              }),
              {
                sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                      VALUES (?, ?, ?, ?)`,
                args: [Q, taskDoneEventName('kept-row'), encodeTaskOutcome(outcome), START_MS],
              },
            ],
            'write',
          )
          expect(
            await engineHistoryViolations(f.raw),
            'mutation-verdict:behavior:retention-rows-name-a-task-without-a-run',
          ).toEqual(['task-without-a-run: kept-row'])
        })
      })

      it('names the spawn memo of a live task whose child is gone', async () => {
        await withFixture(makeFixture, 'retention-rows-memo', async (f) => {
          await f.raw.batch(
            'hand-written-rows',
            [
              handWrittenTask({ taskId: 'parent', state: 'sleeping', atMs: START_MS }),
              handWrittenRun({
                runId: 'parent-run',
                taskId: 'parent',
                state: 'sleeping',
                atMs: START_MS,
              }),
              {
                sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                        owner_run_id, owner_attempt, updated_at_ms)
                      VALUES ('parent', '$spawn:child', ?, ?, 'committed', 'parent-run', 1, ?)`,
                args: [Q, JSON.stringify({ taskId: 'purged-child', queue: Q }), START_MS],
              },
            ],
            'write',
          )
          expect(
            await engineHistoryViolations(f.raw),
            'mutation-verdict:behavior:retention-rows-name-a-spawn-memo-without-its-task',
          ).toEqual(['spawn-memo-without-its-task: parent/$spawn:child names purged-child'])
        })
      })

      it('names a wait on the completion event of a task that is gone with its event', async () => {
        await withFixture(makeFixture, 'retention-rows-wait', async (f) => {
          const event = taskDoneEventName('purged-child')
          const step = '$await-task:purged-child'
          await f.raw.batch(
            'hand-written-rows',
            [
              handWrittenTask({ taskId: 'waiter', state: 'sleeping', atMs: START_MS }),
              handWrittenRun({
                runId: 'waiter-run',
                taskId: 'waiter',
                state: 'sleeping',
                atMs: START_MS,
                wake: { event, step },
              }),
              {
                sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                        timeout_at_ms, created_at_ms)
                      VALUES ('waiter-run', ?, ?, 'waiter', ?, 'waiting', NULL, ?)`,
                args: [step, Q, event, START_MS],
              },
            ],
            'write',
          )
          expect(
            await engineHistoryViolations(f.raw),
            'mutation-verdict:behavior:retention-rows-name-a-stranded-completion-wait',
          ).toEqual([
            `completion-wait-without-its-task-or-event: waiter-run/${step} awaits purged-child`,
          ])
        })
      })

      it('names a completion event whose task is gone', async () => {
        await withFixture(makeFixture, 'retention-rows-event', async (f) => {
          const outcome = { state: 'completed', completedPayloadJson: '{"out":1}' } as const
          await f.raw.batch(
            'hand-written-rows',
            [
              {
                sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                      VALUES (?, ?, ?, ?)`,
                args: [Q, taskDoneEventName('purged-child'), encodeTaskOutcome(outcome), START_MS],
              },
            ],
            'write',
          )
          expect(
            await engineHistoryViolations(f.raw),
            'mutation-verdict:behavior:history-names-a-completion-event-without-its-task',
          ).toEqual([`completion-event-without-task: ${taskDoneEventName('purged-child')}`])
        })
      })
    })

    describe('the purge of a unit', () => {
      // fenceTwin('PurgeChild') fenceTwin('PurgeHolder'): this case is the executable twin of
      // the guard the two purge actions share against a caller that comes again. The first
      // purge of each unit takes it whole. The same call sent again finds no task row for
      // its compare-and-set, answers null, and leaves every table as it was.
      it('takes a child and its parent, each whole, and the same purge sent again takes nothing', async () => {
        await withFixture(makeFixture, 'retention-purge-again', async (f) => {
          await f.admin.setFakeNowEpochMs(START_MS)
          const parent = await f.store.spawn(Q, 'parent', '{}')
          const parentRun = await claimActivated(f.store, Q, 'w-parent')
          const child = await f.store.spawn(Q, 'child', '{}', {
            childOf: {
              parentQueue: Q,
              parentTaskId: parent.taskId,
              runId: parentRun.runId,
              claimToken: parentRun.claimToken,
              replayKey: 'child#1',
            },
          })
          const childRun = await claimActivated(f.store, Q, 'w-child')
          await checkpointOwned(f.store, Q, childRun, 'step', '1', 60)
          await f.store.complete(Q, childRun.runId, childRun.claimToken, '"child"')
          await f.store.complete(Q, parentRun.runId, parentRun.claimToken, '"parent"')

          await f.admin.setFakeNowEpochMs(
            START_MS + MATRIX_RETENTION_POLICY.completedSeconds * 1_000,
          )
          const retention = f.retentionOver(f.raw)
          const { candidates, next } = await retention.purgeCandidates(Q, MATRIX_RETENTION_POLICY, {
            limit: 10,
          })
          const purged = []
          for (const candidate of candidates) {
            purged.push(await retention.purgeUnit(Q, candidate, MATRIX_RETENTION_POLICY))
          }
          const left = await snapshot(f.raw)
          const again = []
          for (const candidate of candidates) {
            again.push(await retention.purgeUnit(Q, candidate, MATRIX_RETENTION_POLICY))
          }
          const whole = (taskId: string, checkpoints: number) => ({
            taskId,
            rows: { tasks: 1, runs: 1, checkpoints, waits: 0, events: 1 },
          })
          const byTask = (units: readonly ({ taskId: string } | null)[]) =>
            [...units].sort((a, b) => String(a?.taskId).localeCompare(String(b?.taskId)))
          expect({
            listed: candidates.map(({ taskId }) => taskId).sort(),
            next,
            purged: byTask(purged),
            left,
            again,
            rowsAfterwards: await snapshot(f.raw),
            violations: await engineHistoryViolations(f.raw),
          }).toEqual({
            listed: [child.taskId, parent.taskId].sort(),
            next: null,
            purged: byTask([whole(child.taskId, 1), whole(parent.taskId, 0)]),
            left: { tasks: [], runs: [], checkpoints: [], events: [], waits: [], drivers: [] },
            again: [null, null],
            rowsAfterwards: left,
            violations: [],
          })
        })
      })
    })
  })
  purgeConformance(dialect, makeFixture)
}
