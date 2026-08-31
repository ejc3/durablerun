import {
  MAX_EPOCH_MS,
  type SqlBatchControl,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  sqlBatchMode,
  sqlTransactionLock,
} from '@durablerun/core'
import { type LibsqlExecutor, LibsqlSchedulerStore, NOW_MS } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
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
 * clock advanced by a different amount before every later statement, then
 * restored before the next operation. The complete operation trace and every
 * protocol table — including recorded instants — must be byte-identical.
 *
 * This is the shape of oracle that finds bugs nobody thought of: it needs no
 * expected value, only two runs that must agree. The previous defence against
 * this class was a checker looking for a token in SQL text, which four
 * different spellings walked past.
 */

const Q = 'q'
const NOW = 1_000_000

/**
 * Advances `fake_now_ms` before each statement after the first, by splitting
 * the batch into single-statement batches. The original value is restored in
 * `finally`, so the next engine operation starts at the same logical instant
 * as the control. Correct code is therefore exactly comparable, timestamps
 * included; only an illegal later-statement clock read can observe the jitter.
 *
 * Atomicity is lost — which is exactly why this is a test-only executor and
 * why the assertion is on completed scenario traces and final state.
 */
class JitteringExecutor implements SqlExecutor {
  constructor(
    private readonly real: LibsqlExecutor,
    private readonly stepMs: number,
  ) {}

  async batch(
    label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    const mode = sqlBatchMode(control)
    if (sqlTransactionLock(control) !== undefined) {
      throw new Error(`clock-jitter executor cannot decompose a transaction-locked batch`)
    }
    if (mode === 'read' || label.startsWith('admin:') || label.startsWith('migrate')) {
      return this.real.batch(label, statements, control)
    }
    const [clock] = await this.real.batch(
      'jitter:clock',
      [{ sql: `SELECT value FROM meta WHERE key = 'fake_now_ms'`, args: [] }],
      'read',
    )
    const base = Number(clock?.rows[0]?.value)
    if (!Number.isSafeInteger(base)) throw new Error(`jitter clock is not an integer: ${base}`)

    const out: SqlResult[] = []
    try {
      for (const [index, statement] of statements.entries()) {
        if (index > 0) {
          await this.real.batch('admin:set-fake-now', [
            {
              sql: `UPDATE meta SET value = ? WHERE key = 'fake_now_ms'`,
              args: [String(base + this.stepMs * index)],
            },
          ])
        }
        const [result] = await this.real.batch(label, [statement], 'write')
        out.push(result ?? { rows: [], rowsAffected: 0 })
      }
      return out
    } finally {
      await this.real.batch('admin:set-fake-now', [
        {
          sql: `UPDATE meta SET value = ? WHERE key = 'fake_now_ms'`,
          args: [String(base)],
        },
      ])
    }
  }
}

type StatementMutator = (
  label: string,
  statements: readonly SqlStatement[],
) => readonly SqlStatement[]

function mutating(real: SqlExecutor, mutate: StatementMutator): SqlExecutor {
  return {
    batch: (label, statements, mode) => real.batch(label, mutate(label, statements), mode),
  }
}

const retryAvailabilityFromSecondClock: StatementMutator = (label, statements) => {
  if (label !== 'fail') return statements
  let changed = 0
  const mutated = statements.map((statement) => {
    const sql = statement.sql.replace('f.fence_at_ms + ?', () => {
      changed += 1
      return `${NOW_MS} + ?`
    })
    return { ...statement, sql }
  })
  if (changed !== 1) throw new Error(`retry clock mutation changed ${changed} statements`)
  return mutated
}

const SNAPSHOT_TABLES = [
  ['tasks', 'task_id'],
  ['runs', 'run_id'],
  ['checkpoints', 'task_id, checkpoint_name'],
  ['events', 'queue, event_name'],
  ['waits', 'run_id, step_name'],
  ['drivers', 'queue, driver_id'],
  ['meta', 'key'],
] as const

async function snapshot(raw: LibsqlExecutor) {
  const results = await raw.batch(
    'clock-jitter:snapshot',
    SNAPSHOT_TABLES.map(([table, order]) => ({
      sql: `SELECT * FROM ${table} ORDER BY ${order}`,
      args: [],
    })),
    'read',
  )
  return Object.fromEntries(
    SNAPSHOT_TABLES.map(([table], index) => [table, results[index]?.rows ?? []]),
  )
}

const SCENARIOS = [
  'retry',
  'events',
  'suspend',
  'cancel',
  'sweep-lost-launch',
  'sweep-claim-timeout',
] as const
type Scenario = (typeof SCENARIOS)[number]

/** One deterministic pass over the engine; `jitterMs` 0 means no jitter. */
async function run(
  jitterMs: number,
  scenario: Scenario,
  mutate?: StatementMutator,
): Promise<{
  trace: { operation: string; result: unknown }[]
  snapshot: Awaited<ReturnType<typeof snapshot>>
  violations: string[]
}> {
  const { raw, admin, ids } = await openTestDb({
    nowMs: NOW,
    idNamespace: `clock-${scenario}`,
  })
  const clocked: SqlExecutor = jitterMs === 0 ? raw : new JitteringExecutor(raw, jitterMs)
  const db = mutate ? mutating(clocked, mutate) : clocked
  const store = new LibsqlSchedulerStore(db, ids)
  const trace: { operation: string; result: unknown }[] = []
  const record = (operation: string, result: unknown = 'ok') => {
    trace.push({ operation, result: result === undefined ? null : result })
  }

  if (scenario === 'retry') {
    const s = await store.spawn(Q, 'job', '{}', { maxAttempts: 3 })
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    const [r] = claimed
    if (r) {
      record('activate:w1', await store.activate(Q, r.runId, r.claimToken, r.claimGen))
      await store.fail(Q, r.runId, r.claimToken, '{"name":"Boom"}', { delaySeconds: 0 })
      record('fail')
    }
    const retried = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    record('claim:w2', retried)
    const [r2] = retried
    if (r2) {
      record('activate:w2', await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen))
      await store.complete(Q, r2.runId, r2.claimToken, '{"ok":1}')
      record('complete')
    }
  } else if (scenario === 'events') {
    const s = await store.spawn(Q, 'job', '{}')
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    const [r] = claimed
    if (r) {
      record('activate:w1', await store.activate(Q, r.runId, r.claimToken, r.claimGen))
      record(
        'await',
        await store.awaitEvent(Q, s.taskId, r.runId, r.claimToken, '$await:go', 'go', 30),
      )
    }
    await store.emitEvent(Q, 'go', '{"v":1}')
    record('emit')
    const woken = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    record('claim:w2', woken)
    const [r2] = woken
    if (r2) {
      record('activate:w2', await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen))
      await store.complete(Q, r2.runId, r2.claimToken, '{"ok":1}')
      record('complete')
    }
  } else if (scenario === 'suspend') {
    const s = await store.spawn(Q, 'job', '{}')
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    const [r] = claimed
    if (r) {
      record('activate:w1', await store.activate(Q, r.runId, r.claimToken, r.claimGen))
      await store.setCheckpoint(Q, s.taskId, r.runId, r.claimToken, 'step', '{"a":1}', 60)
      record('checkpoint')
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
      record('suspend')
    }
    const resumed = await store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
    record('claim:w2', resumed)
    const [r2] = resumed
    if (r2) {
      record('activate:w2', await store.activate(Q, r2.runId, r2.claimToken, r2.claimGen))
    }
  } else if (scenario === 'cancel') {
    const s = await store.spawn(Q, 'job', '{}')
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    const [r] = claimed
    if (r) {
      record('activate:w1', await store.activate(Q, r.runId, r.claimToken, r.claimGen))
    }
    record('cancel', await store.cancelTask(Q, s.taskId))
  } else if (scenario === 'sweep-lost-launch') {
    const s = await store.spawn(Q, 'lost-launch', '{}')
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    await admin.setFakeNowEpochMs(NOW + 61_000)
    record('sweep', await store.sweep(Q, 10))
  } else if (scenario === 'sweep-claim-timeout') {
    const s = await store.spawn(Q, 'claim-timeout', '{}')
    record('spawn', s)
    const claimed = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    record('claim:w1', claimed)
    const [r] = claimed
    if (r) {
      record('activate:w1', await store.activate(Q, r.runId, r.claimToken, r.claimGen))
    }
    await admin.setFakeNowEpochMs(NOW + 61_000)
    record('sweep', await store.sweep(Q, 10))
  }

  const violations = await engineInvariantViolations(raw)
  const finalState = await snapshot(raw)
  raw.close()
  return { trace, snapshot: finalState, violations }
}

describe('moving the clock between statements changes neither progress nor state', () => {
  it('fails closed instead of stripping a transaction lock while decomposing a batch', async () => {
    const { raw } = await openTestDb({ nowMs: NOW, idNamespace: 'clock-locked-batch' })
    try {
      await expect(
        new JitteringExecutor(raw, 1).batch('emit-event', [], {
          mode: 'write',
          transactionLock: { kind: 'event', queue: Q, eventName: 'go' },
        }),
      ).rejects.toThrow(/cannot decompose a transaction-locked batch/)
    } finally {
      raw.close()
    }
  })

  it('distinguishes a retry stranded by a second database-clock read', async () => {
    const control = await run(997, 'retry')
    const broken = await run(997, 'retry', retryAvailabilityFromSecondClock)
    expect(control.violations).toEqual([])
    expect(broken.violations).toEqual([])
    expect(broken).not.toEqual(control)
  })

  for (const scenario of SCENARIOS) {
    it(`${scenario}: jitter and control are byte-equivalent`, async () => {
      // Deliberately large, uneven and prime, so no two statements of a batch
      // land on a shared boundary by luck.
      const jittered = await run(997, scenario)
      const control = await run(0, scenario)
      expect(jittered.violations).toEqual([])
      expect(control.violations).toEqual([])
      expect(jittered).toEqual(control)
    })
  }

  it('driver cleanup derives its decision from the heartbeat instant at the epoch ceiling', async () => {
    const { raw, ids } = await openTestDb({
      nowMs: MAX_EPOCH_MS - 1,
      idNamespace: 'driver-heartbeat-clock',
    })
    try {
      await raw.batch('seed-expired-driver', [
        {
          sql: `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
                VALUES (?, 'victim', 10, 20)`,
          args: [Q],
        },
      ])
      const store = new LibsqlSchedulerStore(new JitteringExecutor(raw, 1), ids)
      await store.driverHeartbeat(Q, 'source', 0.001)
      const [rows] = await raw.batch(
        'driver-heartbeat-clock:probe',
        [
          {
            sql: `SELECT driver_id FROM drivers WHERE queue = ? ORDER BY driver_id`,
            args: [Q],
          },
        ],
        'read',
      )

      expect(rows?.rows, 'mutation-verdict:behavior:driver-heartbeat-single-clock').toEqual([
        { driver_id: 'source' },
      ])
    } finally {
      raw.close()
    }
  })
})
