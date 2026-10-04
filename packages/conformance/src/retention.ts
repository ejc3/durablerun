import {
  TERMINAL_STATES,
  type TerminalState,
  encodeTaskOutcome,
  taskDoneEventName,
} from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { TERMINAL_BATCHES, type TerminalBatch } from './child-tasks.js'
import { engineHistoryViolations } from './engine-history.js'
import { MATRIX_WRITE_LABELS, TERMINAL_BATCH_LABELS } from './fault-matrix.js'
import type { StoreFixtureFactory } from './fixture.js'
import {
  type EndedTaskStamp,
  POISON_INVOCATION,
  type TerminalPreStateObservation,
  observeTerminalPreState,
} from './poison-matrix.js'
import { readOne, withFixture } from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000

/**
 * How long after a task was made ready its ending comes. Every earlier write of the task's
 * row stamped it at the starting instant, so an ending that left the stamp alone, or left
 * it NULL, reads differently from one that stamped it.
 */
const ENDING_GAP_MS = 2_500

type WriteLabel = (typeof MATRIX_WRITE_LABELS)[number]

/** An instant as a number, whatever the driver hands back for an integer column. */
function instant(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** What a stamp case reads once a terminal batch has ended a task. */
export interface EndingStamp {
  /** The batch under the label ran. */
  readonly ran: boolean
  /** The stamp of the task's row before the ending. */
  readonly stampedBeforeAtMs: number | null
  readonly state: unknown
  /** `tasks.fence_at_ms` after the ending, which retention reads a unit's age from. */
  readonly stampedAtMs: number | null
  /** The instant of the completion event the same batch wrote. */
  readonly eventAtMs: number | null
  readonly violations: readonly string[]
}

/**
 * End one task by `batch` at an instant of its own, and read what the ending left on the
 * task's row. The expected answer is written from what the scenario did: the clock it set.
 */
export async function endingStampCase(
  makeFixture: StoreFixtureFactory,
  batch: TerminalBatch,
): Promise<{ observed: EndingStamp; expected: EndingStamp }> {
  return withFixture(makeFixture, `ending-stamp-${batch.label}`, async (f) => {
    await f.admin.setFakeNowEpochMs(START_MS)
    const ready = await batch.prepare(f, Q)
    const stamp = () =>
      readOne(f.raw, 'SELECT state, fence_at_ms FROM tasks WHERE task_id = ?', [ready.childTaskId])
    const before = await stamp()
    const endedAtMs = START_MS + ready.advanceMs + ENDING_GAP_MS
    await f.admin.setFakeNowEpochMs(endedAtMs)
    const recorded = new RecordingExecutor(f.raw)
    await ready.end(f.storeOver(recorded))
    const after = await stamp()
    const event = await readOne(
      f.raw,
      'SELECT emitted_at_ms FROM events WHERE queue = ? AND event_name = ?',
      [Q, taskDoneEventName(ready.childTaskId)],
    )
    return {
      observed: {
        ran: recorded.labels.includes(batch.label),
        stampedBeforeAtMs: instant(before?.fence_at_ms),
        state: after?.state,
        stampedAtMs: instant(after?.fence_at_ms),
        eventAtMs: instant(event?.emitted_at_ms),
        violations: await engineHistoryViolations(f.raw),
      },
      expected: {
        ran: true,
        stampedBeforeAtMs: START_MS,
        state: ready.outcome.state,
        stampedAtMs: endedAtMs,
        eventAtMs: endedAtMs,
        violations: [],
      },
    }
  })
}

/** What a terminal pre-state cell compares: whether the label ran, and each ended task's stamp. */
export type TerminalPreStateVerdict = Pick<
  TerminalPreStateObservation,
  'fired' | 'healthy' | 'tasks'
>

/**
 * Run one write label over a task the engine had already ended, and say what its stamp
 * must read afterwards. `retry-task` moves a failed task's stamp to the instant of the
 * revival, which restarts its age. Nothing else moves the stamp of a task that had ended.
 */
export async function terminalPreStateCase(
  makeFixture: StoreFixtureFactory,
  label: WriteLabel,
  state: TerminalState,
): Promise<{ observed: TerminalPreStateVerdict; expected: TerminalPreStateVerdict }> {
  const { fired, healthy, tasks, endedAtMs, invokedAtMs } = await observeTerminalPreState(
    makeFixture,
    label,
    state,
  )
  const stays = (before: EndedTaskStamp): EndedTaskStamp =>
    label === 'retry-task' && before.state === 'failed'
      ? { state: 'pending', stampedAtMs: invokedAtMs }
      : before
  const expected: Record<string, { before: EndedTaskStamp; after: EndedTaskStamp }> = {}
  for (const [taskId, seen] of Object.entries(tasks)) {
    // The task the cell is about was ended by the engine, at the instant the cell set.
    const before =
      taskId === POISON_INVOCATION.taskId ? { state, stampedAtMs: endedAtMs } : seen.before
    expected[taskId] = { before, after: stays(before) }
  }
  if (!Object.hasOwn(tasks, POISON_INVOCATION.taskId)) {
    throw new Error(`${label} from ${state}: the cell's task had not ended before the label ran`)
  }
  return {
    observed: { fired, healthy, tasks },
    expected: { fired: true, healthy: 'fulfilled', tasks: expected },
  }
}

/** The title of one terminal pre-state cell. */
export function terminalPreStateTitle(label: WriteLabel, state: TerminalState): string {
  return label === 'retry-task' && state === 'failed'
    ? 'retry-task moves the stamp of the failed task it revives to the instant of the revival'
    : `${label} leaves the stamp of a ${state} task where its ending put it`
}

const TASK_COLUMNS = `task_id, queue, task_name, params, retry_strategy, max_attempts,
  state, attempts, infra_retries, completed_payload, enqueue_at_ms, created_at_ms`

/** A task row written by hand, with nothing else of its unit. */
function taskRow(taskId: string, state: string, completedPayload: string | null = null) {
  return {
    sql: `INSERT INTO tasks (${TASK_COLUMNS})
          VALUES (?, ?, 'hand-written', '{}', '{"kind":"none"}', 3, ?, 0, 0, ?, ?, ?)`,
    args: [taskId, Q, state, completedPayload, START_MS, START_MS],
  }
}

/** A sleeping run written by hand, parked on `wake` when it names one. */
function sleepingRun(
  runId: string,
  taskId: string,
  wake: { event: string; step: string } | null = null,
) {
  return {
    sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, available_at_ms,
            wake_event, wake_step, created_at_ms)
          VALUES (?, ?, ?, 1, 'sleeping', NULL, ?, ?, ?)`,
    args: [runId, Q, taskId, wake?.event ?? null, wake?.step ?? null, START_MS],
  }
}

/**
 * What retention will rely on before any store can purge (DESIGN.md §3.12): the stamp a
 * unit's age is read from, and the row checks that see what a wrong purge would leave.
 * The stamp cases are generated from the terminal batch labels and the cells from the
 * write labels, so a label added to either list is held here without a case being written.
 */
export function retentionConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`retention conformance [${dialect}]`, () => {
    describe('the stamp of an ending', () => {
      for (const label of TERMINAL_BATCH_LABELS) {
        it(`${label} stamps the task it ends with the ending instant`, async () => {
          const batch = TERMINAL_BATCHES.find((candidate) => candidate.label === label)
          if (batch === undefined) throw new Error(`nothing here ends a task by ${label}`)
          const { observed, expected } = await endingStampCase(makeFixture, batch)
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
              taskRow('kept-row', 'completed', outcome.completedPayloadJson),
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
              taskRow('parent', 'sleeping'),
              sleepingRun('parent-run', 'parent'),
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
              taskRow('waiter', 'sleeping'),
              sleepingRun('waiter-run', 'waiter', { event, step }),
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
    })
  })
}
