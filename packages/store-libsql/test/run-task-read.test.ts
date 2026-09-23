import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { openTestDb } from '../src/testing.js'

/**
 * A terminal batch names its task's completion event, and `complete` and `fail` are
 * handed only the run. The store that activated the run already knows its task, so the
 * worker's own terminal write pays no read. Any other caller pays one.
 */
describe("a terminal batch's read of its run's task", () => {
  it('costs the store that activated the run nothing, and any other store one read', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const recorder = new RecordingExecutor(raw)
      const worker = new LibsqlSchedulerStore(recorder, ids)
      const stranger = new LibsqlSchedulerStore(recorder, ids)
      const terminal: Record<string, string[]> = {}
      for (const [name, ends] of [
        ['worker completes', (runId: string) => worker.complete('q', runId, 'w', '{}')],
        ['worker fails', (runId: string) => worker.fail('q', runId, 'w', '{}', null)],
        ['stranger completes', (runId: string) => stranger.complete('q', runId, 'w', '{}')],
      ] as const) {
        await worker.spawn('q', 'job', '{}')
        const [claimed] = await worker.claim('q', 'w', { leaseSeconds: 60, limit: 1 })
        if (claimed === undefined) throw new Error('the spawned run was not claimed')
        await worker.activate('q', claimed.runId, 'w', claimed.claimGen)
        recorder.batches.length = 0
        await ends(claimed.runId)
        terminal[name] = recorder.batches.splice(0).map((batch) => batch.label)
      }
      expect(terminal, 'mutation-verdict:behavior:activate-remembers-the-run-task').toEqual({
        'worker completes': ['complete'],
        'worker fails': ['fail'],
        'stranger completes': ['run-task', 'complete'],
      })
    } finally {
      close()
    }
  })

  it('refuses a run this queue does not have, like the batch would', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const store = new LibsqlSchedulerStore(raw, ids)
      const refused = await store.complete('q', 'no-such-run', 'w', '{}').then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
      expect(refused).toBe('LeaseLostError')
    } finally {
      close()
    }
  })
})
