import { type SqlExecutor, taskDoneEventName } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { openTestDb } from '../src/testing.js'

/**
 * A child await is an await of the engine's own event, whose name a task never sees
 * (DESIGN.md §3.2). An error the await throws reaches the task's code, so it names the
 * child task and not that event. A stored payload that is not TEXT can only come from a
 * writer that is not the engine, and SQLite's dynamic typing lets one exist.
 */
describe("a child await's error", () => {
  it('names the child task, and never the engine event, on both paths that read the payload', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const store = new LibsqlSchedulerStore(raw, ids)
      const ready = async (name: string, worker: string) => {
        const task = await store.spawn('q', name, '{}')
        const [run] = await store.claim('q', worker, { leaseSeconds: 60, limit: 1 })
        if (run === undefined || run.taskId !== task.taskId) throw new Error(`${name} not claimed`)
        await store.activate('q', run.runId, run.claimToken, run.claimGen)
        return { taskId: task.taskId, run }
      }
      const parent = await ready('parent', 'w-parent')
      const child = await ready('child', 'w-child')
      await store.complete('q', child.run.runId, child.run.claimToken, '{}')
      const doneEvent = taskDoneEventName(child.taskId)
      await raw.batch('a-writer-that-is-not-the-engine', [
        { sql: `UPDATE events SET payload = x'00' WHERE event_name = ?`, args: [doneEvent] },
      ])
      const awaited = (through: LibsqlSchedulerStore) =>
        through
          .awaitTaskDone(
            'q',
            parent.taskId,
            parent.run.runId,
            parent.run.claimToken,
            's',
            child.taskId,
            null,
          )
          .then(
            () => 'accepted',
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
      // The await that hits the event.
      const hit = await awaited(store)
      // The await that records an outcome reads the event too, because a terminal batch
      // may have written it since the child was read. The event is out of sight here
      // until that read has happened.
      await raw.batch('out-of-sight', [
        { sql: `UPDATE events SET event_name = 'aside' WHERE event_name = ?`, args: [doneEvent] },
      ])
      const writtenSinceTheRead: SqlExecutor = {
        batch: async (label, statements, control) => {
          const results = await raw.batch(label, statements, control)
          if (label === 'task-done-state') {
            await raw.batch('back-in-sight', [
              {
                sql: `UPDATE events SET event_name = ? WHERE event_name = 'aside'`,
                args: [doneEvent],
              },
            ])
          }
          return results
        },
      }
      const recorded = await awaited(new LibsqlSchedulerStore(writtenSinceTheRead, ids))
      const named = `awaitTaskDone q/task ${child.taskId} found a non-TEXT stored payload`
      expect(
        { hit, recorded },
        'mutation-verdict:behavior:child-await-error-names-the-task',
      ).toEqual({ hit: named, recorded: named })
    } finally {
      close()
    }
  })
})
