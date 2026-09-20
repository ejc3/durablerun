import { describe, expect, it } from 'vitest'
import { engineHistoryViolations } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const NOW = 1_000_000

/**
 * `engineHistoryViolations` is what every walk, matrix cell, and scenario judges its rows
 * by, so a checker it left out would be left out of all of them at once. The rows here
 * are written by hand with one defect for each checker, and the helper must name all
 * three.
 */
describe('the one helper that judges the rows of a history', () => {
  it('names a defect of each of its three checkers', async () => {
    const f = await makeLibsqlFixture('engine-history')
    try {
      await f.raw.batch('hand-written-history', [
        {
          // For the invariant library: a run whose task does not exist.
          sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, created_at_ms)
                VALUES ('orphan', 'q', 'missing-task', 1, 'completed', ?)`,
          args: [NOW],
        },
        {
          // For the child-task checker: a terminal task with no completion event.
          sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
                  state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
                VALUES ('ended', 'q', 'saga', '{}', '{"kind":"none"}', 3, 'failed', 3, 0, ?, ?)`,
          args: [NOW, NOW],
        },
        {
          // For the saga checker: a rollback of a step that never started.
          sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                  owner_run_id, owner_attempt, updated_at_ms)
                VALUES ('ended', '$rollback:a', 'q', 'null', 'committed', 'run-2', 2, ?)`,
          args: [NOW],
        },
      ])
      expect(await engineHistoryViolations(f.raw)).toEqual(
        expect.arrayContaining([
          'run-owner-missing: orphan',
          'terminal-task-without-completion-event: ended',
          'saga/rollback-of-a-step-that-never-started: ended/a',
        ]),
      )
    } finally {
      await f.close()
    }
  })
})
