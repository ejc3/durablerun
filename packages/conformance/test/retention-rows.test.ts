import type { SqlStatement } from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'
import { retentionViolations } from '../src/retention-rows.js'
import type { StoreFixture } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * `retentionViolations` runs behind every surface that judges a history, and no engine path
 * leaves a row it names, so a condition nobody has seen fail holds nothing. The retention
 * surface writes the rows of each condition on every dialect. These cases are the edges of
 * each condition: the rows either side of what it names, written by hand, and judged by
 * this checker alone.
 */
const NOW = 1_000_000

function task(taskId: string, state: string, queue = 'q'): SqlStatement {
  return {
    sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
            state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
          VALUES (?, ?, 'hand-written', '{}', '{"kind":"none"}', 3, ?, 0, 0, ?, ?)`,
    args: [taskId, queue, state, NOW, NOW],
  }
}

function run(runId: string, taskId: string, state: string, queue = 'q', attempt = 1): SqlStatement {
  return {
    sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, created_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [runId, queue, taskId, attempt, state, NOW],
  }
}

/** One more run of the one waiting task: a task's runs differ in their attempt. */
function waiterRun(runId: string, attempt: number): SqlStatement {
  return run(runId, 'waiter', 'sleeping', 'q', attempt)
}

function checkpoint(taskId: string, name: string, state: string): SqlStatement {
  return {
    sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
            owner_run_id, owner_attempt, updated_at_ms)
          VALUES (?, ?, 'q', ?, 'committed', ?, 1, ?)`,
    args: [taskId, name, state, `${taskId}-run`, NOW],
  }
}

function wait(runId: string, eventName: string, status = 'waiting', queue = 'q'): SqlStatement {
  return {
    sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
            timeout_at_ms, created_at_ms)
          VALUES (?, 'step', ?, 'waiter', ?, ?, NULL, ?)`,
    args: [runId, queue, eventName, status, NOW],
  }
}

function event(eventName: string, queue = 'q'): SqlStatement {
  return {
    sql: 'INSERT INTO events (queue, event_name, payload, emitted_at_ms) VALUES (?, ?, ?, ?)',
    args: [queue, eventName, '{}', NOW],
  }
}

const HANDLE = JSON.stringify({ taskId: 'child', queue: 'q' })

describe('the retention row checker', () => {
  let f: StoreFixture

  beforeEach(async () => {
    f = await makeLibsqlFixture('retention-rows')
  })

  afterEach(async () => {
    await f.close()
  })

  async function violationsOf(rows: readonly SqlStatement[]): Promise<string[]> {
    await f.raw.batch('hand-written-rows', rows, 'write')
    return retentionViolations(f.raw)
  }

  it('names every task row that has no run, in any state, and no task that has one', async () => {
    expect(
      await violationsOf([
        task('live-with-none', 'pending'),
        task('completed-with-none', 'completed'),
        task('failed-with-none', 'failed'),
        task('cancelled-with-none', 'cancelled'),
        task('with-one', 'completed'),
        run('its-run', 'with-one', 'completed'),
      ]),
    ).toEqual([
      'task-without-a-run: cancelled-with-none',
      'task-without-a-run: completed-with-none',
      'task-without-a-run: failed-with-none',
      'task-without-a-run: live-with-none',
    ])
    // The invariant library reads the same fact for a live task only, and says so there
    // too: the live row passes neither checker, and the library has nothing to say of an
    // ended task with no run. These ended rows carry no payload and no reason, which the
    // library does name, and which is not what this case is about.
    expect(
      (await engineInvariantViolations(f.raw)).filter(
        (violation) => !violation.startsWith('task-outcome-'),
      ),
    ).toEqual(['live-task-without-exactly-one-live-run: live-with-none'])
  })

  // ReplayableParentKeepsChild reads a parent that can still run its code: a live one, a
  // rolling-back one included, and a failed one whose saga never began, which retry-task
  // revives. A completed or cancelled parent never reads its child again, and neither does
  // one that failed with a saga, which retry-task refuses.
  it('names a memo whose child is gone only for a parent that can still run its code', async () => {
    const parents: readonly [string, string, boolean][] = [
      ['pending-parent', 'pending', false],
      ['running-parent', 'running', false],
      ['sleeping-parent', 'sleeping', false],
      ['rolling-back-parent', 'pending', true],
      ['failed-parent', 'failed', false],
      ['saga-failed-parent', 'failed', true],
      ['completed-parent', 'completed', false],
      ['cancelled-parent', 'cancelled', false],
    ]
    expect(
      await violationsOf(
        parents.flatMap(([taskId, state, sagaBegan]) => [
          task(taskId, state),
          run(`${taskId}-run`, taskId, state),
          checkpoint(taskId, '$spawn:child', HANDLE),
          ...(sagaBegan ? [checkpoint(taskId, '$rolling-back', '{"name":"Boom"}')] : []),
        ]),
      ),
      'mutation-verdict:behavior:retention-rows-read-a-parent-that-can-still-run-its-code',
    ).toEqual(
      [
        'failed-parent',
        'pending-parent',
        'rolling-back-parent',
        'running-parent',
        'sleeping-parent',
      ].map((taskId) => `spawn-memo-without-its-task: ${taskId}/$spawn:child names child`),
    )
  })

  it('is silent once the child a memo names exists, in whatever queue', async () => {
    expect(
      await violationsOf([
        task('parent', 'sleeping'),
        run('parent-run', 'parent', 'sleeping'),
        checkpoint('parent', '$spawn:child', HANDLE),
        checkpoint('parent', '$spawn:child#2', JSON.stringify({ taskId: 'far', queue: 'q' })),
        task('child', 'completed'),
        run('child-run', 'child', 'completed'),
        task('far', 'pending', 'other-q'),
        run('far-run', 'far', 'pending', 'other-q'),
      ]),
    ).toEqual([])
  })

  it('names a spawn memo that holds no child handle, and reads no other checkpoint as one', async () => {
    const notHandles = ['"child"', 'null', '{"taskId":7,"queue":"q"}', '{"taskId":"child"}', '{']
    expect(
      await violationsOf([
        task('parent', 'sleeping'),
        run('parent-run', 'parent', 'sleeping'),
        ...notHandles.map((state, index) => checkpoint('parent', `$spawn:kid#${index + 2}`, state)),
        // Not spawn memos: a step of the same shape, and the engine's other names.
        checkpoint('parent', 'spawn:child', HANDLE),
        checkpoint('parent', '$await-task:child', HANDLE),
        checkpoint('parent', '$spawn', HANDLE),
      ]),
      'mutation-verdict:behavior:retention-rows-name-a-memo-that-holds-no-child-handle',
    ).toEqual(
      notHandles.map(
        (_, index) =>
          `spawn-memo-without-its-task: parent/$spawn:kid#${index + 2} holds no child handle`,
      ),
    )
  })

  // NoStrandedWaiter. A completion event lives in its task's queue, so only a task or an
  // event of the wait's own queue can ever wake it.
  it('names a wait on a completion event only when its queue holds neither the task nor the event', async () => {
    expect(
      await violationsOf([
        task('waiter', 'sleeping'),
        waiterRun('stranded', 1),
        wait('stranded', '$task-done:gone'),
        waiterRun('stranded-delivered', 2),
        wait('stranded-delivered', '$task-done:gone', 'delivered'),
        // The task is there, in the wait's queue.
        task('there', 'pending'),
        run('there-run', 'there', 'pending'),
        waiterRun('has-its-task', 3),
        wait('has-its-task', '$task-done:there'),
        // The task is gone and its event is there.
        event('$task-done:recorded'),
        waiterRun('has-its-event', 4),
        wait('has-its-event', '$task-done:recorded'),
        // The task and the event are both in another queue, where this wait is not.
        task('elsewhere', 'completed', 'other-q'),
        run('elsewhere-run', 'elsewhere', 'completed', 'other-q'),
        event('$task-done:elsewhere', 'other-q'),
        waiterRun('other-queue-only', 5),
        wait('other-queue-only', '$task-done:elsewhere'),
        // A caller's event is no completion event.
        waiterRun('callers-event', 6),
        wait('callers-event', 'task-done:gone'),
      ]),
      'mutation-verdict:behavior:retention-rows-read-a-wait-by-its-own-queue',
    ).toEqual([
      'completion-wait-without-its-task-or-event: other-queue-only/step awaits elsewhere',
      'completion-wait-without-its-task-or-event: stranded-delivered/step awaits gone',
      'completion-wait-without-its-task-or-event: stranded/step awaits gone',
    ])
  })
})
