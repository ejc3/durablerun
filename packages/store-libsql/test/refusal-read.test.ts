import {
  type SqlBatchControl,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  StoreUnavailableError,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { openTestDb } from '../src/testing.js'

/** Passes every batch through and records each batch's label and statements. */
class RecordingExecutor implements SqlExecutor {
  readonly batches: { label: string; statements: string[] }[] = []
  constructor(private readonly real: SqlExecutor) {}
  batch(
    label: string,
    statements: readonly SqlStatement[],
    control?: SqlBatchControl,
  ): Promise<SqlResult[]> {
    this.batches.push({ label, statements: statements.map((statement) => statement.sql) })
    return this.real.batch(label, statements, control)
  }
}

/** Fails the refusal read the way a dropped connection would. */
class FailingRefusalRead implements SqlExecutor {
  constructor(private readonly real: SqlExecutor) {}
  batch(
    label: string,
    statements: readonly SqlStatement[],
    control?: SqlBatchControl,
  ): Promise<SqlResult[]> {
    if (label === 'refusal-state') {
      return Promise.reject(new StoreUnavailableError('connection dropped during the refusal read'))
    }
    return this.real.batch(label, statements, control)
  }
}

describe('refused worker write classification', () => {
  it('a write that wins reads no refusal state, and a refused write still names why', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const recorder = new RecordingExecutor(raw)
      const store = new LibsqlSchedulerStore(recorder, ids)
      await store.spawn('q', 'job', '{}')
      const [claimed] = await store.claim('q', 'w1', { leaseSeconds: 60, limit: 1 })
      if (claimed === undefined) throw new Error('the spawned run was not claimed')
      const run = await store.activate('q', claimed.runId, 'w1', claimed.claimGen)
      if (run === null) throw new Error('the claimed run was not activated')
      recorder.batches.length = 0
      await store.complete('q', run.runId, 'w1', '{}')
      const winning = recorder.batches.splice(0)
      const refused = await store.complete('q', run.runId, 'w1', '{}').then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
      expect({
        winningLabels: winning.map((batch) => batch.label),
        winningTopLevelReads: winning
          .flatMap((batch) => batch.statements)
          .filter((sql) => /^\s*SELECT\b/i.test(sql)).length,
        refusedLabels: recorder.batches.map((batch) => batch.label),
        refused,
      }).toEqual({
        winningLabels: ['complete'],
        winningTopLevelReads: 0,
        // The store forgot the run when its first write ended it, so the repeat reads the
        // run's task again before it is refused.
        refusedLabels: ['run-task', 'complete', 'refusal-state'],
        refused: 'LeaseLostError',
      })
    } finally {
      close()
    }
  })

  it('a refused write still raises LeaseLostError when the refusal read fails', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const store = new LibsqlSchedulerStore(new FailingRefusalRead(raw), ids)
      await store.spawn('q', 'job', '{}')
      const [claimed] = await store.claim('q', 'w1', { leaseSeconds: 60, limit: 1 })
      if (claimed === undefined) throw new Error('the spawned run was not claimed')
      const run = await store.activate('q', claimed.runId, 'w1', claimed.claimGen)
      if (run === null) throw new Error('the claimed run was not activated')
      await store.complete('q', run.runId, 'w1', '{}')
      const refused = await store.complete('q', run.runId, 'w1', '{}').then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
      expect(refused).toBe('LeaseLostError')
    } finally {
      close()
    }
  })
})
