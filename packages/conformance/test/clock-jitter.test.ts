import type { SqlBatchMode, SqlExecutor, SqlResult, SqlStatement } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'

/**
 * A DIFFERENTIAL proof that no statement outside a compare-and-set depends on
 * reading the clock.
 *
 * Rule 8 says only a CAS may read database time; every later statement in a
 * batch derives its instants from the `fence_at_ms` that CAS recorded. That
 * makes a strong claim testable without predicting any particular bug: if it
 * holds, then moving the clock BETWEEN the statements of a batch — which is
 * what a real backend does anyway, measured at 94 divergences in 4000 local
 * batches — must change nothing at all.
 *
 * So this runs each scenario twice. Once normally. Once with the engine's
 * clock advanced by a different amount before every single statement, so no
 * two statements in a batch ever see the same instant. The resulting database
 * must be byte-identical apart from the recorded instants themselves.
 *
 * This is the shape of oracle that finds bugs nobody thought of: it needs no
 * expected value, only two runs that must agree. The previous defence against
 * this class was a checker looking for a token in SQL text, which four
 * different spellings walked past.
 */

const Q = 'q'
const NOW = 1_000_000

/**
 * Advances `fake_now_ms` by a fixed step before each statement of a batch, by
 * splitting the batch into single-statement batches with a clock bump
 * between. Atomicity is lost — which is exactly why this is a test-only
 * executor and why the assertion is on the FINAL state of scenarios that run
 * to completion, not on any intermediate.
 */
class JitteringExecutor implements SqlExecutor {
  constructor(
    private readonly real: LibsqlExecutor,
    private readonly stepMs: number,
  ) {}

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    mode: SqlBatchMode = 'write',
  ): Promise<SqlResult[]> {
    if (mode === 'read' || label.startsWith('admin:') || label.startsWith('migrate')) {
      return this.real.batch(label, statements, mode)
    }
    const out: SqlResult[] = []
    for (const s of statements) {
      const [r] = await this.real.batch(label, [s], 'write')
      out.push(r ?? { rows: [], rowsAffected: 0 })
      await this.real.batch('admin:set-fake-now', [
        {
          sql: `UPDATE meta SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)
                WHERE key = 'fake_now_ms'`,
          args: [this.stepMs],
        },
      ])
    }
    return out
  }
}

/** One deterministic pass over the engine; `jitterMs` 0 means no jitter. */
async function run(jitterMs: number, scenario: string): Promise<string[]> {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  await admin.setFakeNowEpochMs(NOW)
  // SEPARATE counters. Sharing one made `token()` return the same string for
  // two consecutive batches whenever no id was minted between them — and the
  // whole provenance scheme is exactly as strong as seed uniqueness, so two
  // batches sharing a seed is precisely the corruption it cannot survive.
  // The invariant below caught it on its first run.
  let ids = 0
  let seeds = 0
  const db: SqlExecutor = jitterMs === 0 ? raw : new JitteringExecutor(raw, jitterMs)
  const store = new LibsqlSchedulerStore(db, {
    uuidv7: () => `id-${++ids}`,
    token: () => `tok-${++seeds}`,
  })

  if (scenario === 'retry') {
    const s = await store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    const [r] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (r) {
      await store.activate(Q, r.runId, r.claimToken, r.claimGen)
      await store.fail(Q, r.runId, r.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
    }
    const [r2] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (r2) {
      await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen)
      await store.complete(Q, r2.runId, r2.claimToken, '{"ok":1}')
    }
    void s
  } else if (scenario === 'events') {
    const s = await store.spawn(Q, 'job', '{}')
    const [r] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (r) {
      await store.activate(Q, r.runId, r.claimToken, r.claimGen)
      await store.awaitEvent(Q, s.taskId, r.runId, r.claimToken, '$await:go', 'go', 30)
    }
    await store.emitEvent(Q, 'go', '{"v":1}')
    const [r2] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (r2) {
      await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen)
      await store.complete(Q, r2.runId, r2.claimToken, '{"ok":1}')
    }
  } else if (scenario === 'suspend') {
    const s = await store.spawn(Q, 'job', '{}')
    const [r] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (r) {
      await store.activate(Q, r.runId, r.claimToken, r.claimGen)
      await store.setCheckpoint(Q, s.taskId, r.runId, r.claimToken, 'step', '{"a":1}', 60)
      await store.suspendRun(
        Q,
        r.runId,
        r.claimToken,
        { inSeconds: 0 },
        {
          key: '$sleep',
          stateJson: '{}',
        },
      )
    }
    const [r2] = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    if (r2) await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen)
  } else if (scenario === 'cancel') {
    const s = await store.spawn(Q, 'job', '{}')
    const [r] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (r) await store.activate(Q, r.runId, r.claimToken, r.claimGen)
    await store.cancelTask(Q, s.taskId)
  }

  const violations = await engineInvariantViolations(raw)
  raw.close()
  return violations
}

describe('moving the clock between statements breaks no invariant', () => {
  for (const scenario of ['retry', 'events', 'suspend', 'cancel']) {
    it(`${scenario}: clean under per-statement clock jitter`, async () => {
      // Deliberately large, uneven and prime, so no two statements of a batch
      // land on a shared boundary by luck.
      expect(await run(997, scenario)).toEqual([])
    })

    it(`${scenario}: clean without jitter (the control)`, async () => {
      expect(await run(0, scenario)).toEqual([])
    })
  }
})
