import type { SqlBatchControl, SqlExecutor, SqlResult, SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { openTestDb } from '../src/testing.js'

const REFUSAL_READ = 'SELECT state FROM runs WHERE run_id = ?'

/** Passes every batch through and records the SQL it carried. */
class RecordingExecutor implements SqlExecutor {
  readonly statements: string[] = []
  constructor(private readonly real: SqlExecutor) {}
  batch(
    label: string,
    statements: readonly SqlStatement[],
    control?: SqlBatchControl,
  ): Promise<SqlResult[]> {
    for (const statement of statements) this.statements.push(statement.sql)
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
      recorder.statements.length = 0
      await store.complete('q', run.runId, 'w1', '{}')
      const winningRefusalReads = recorder.statements.filter((sql) =>
        sql.includes(REFUSAL_READ),
      ).length
      const refused = await store.complete('q', run.runId, 'w1', '{}').then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
      expect({ winningRefusalReads, refused }).toEqual({
        winningRefusalReads: 0,
        refused: 'LeaseLostError',
      })
    } finally {
      close()
    }
  })
})
