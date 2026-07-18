import type { ClaimedRun } from '@absurd-lite/core'
import { Rng, seededIdSource, SimWorld } from '@absurd-lite/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@absurd-lite/store-libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const Q = 'q'

let db: LibsqlExecutor
let admin: LibsqlStoreAdmin
let store: LibsqlSchedulerStore

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  admin = new LibsqlStoreAdmin(db)
  await admin.migrate()
  await admin.setFakeNowEpochMs(1_000_000)
  store = new LibsqlSchedulerStore(db, seededIdSource(new Rng('fixture')))
})

afterEach(() => {
  db.close()
})

describe('spawn', () => {
  it('creates a task with an initial pending run', async () => {
    const result = await store.spawn(Q, 'send-email', '{"to":"x"}')
    expect(result.created).toBe(true)
    const [runs] = await db.batch('t', [
      {
        sql: `SELECT state, attempt, available_at_ms FROM runs WHERE task_id = ?`,
        args: [result.taskId],
      },
    ])
    expect(runs?.rows[0]).toMatchObject({
      state: 'pending',
      attempt: 1,
      available_at_ms: 1_000_000,
    })
  })

  it('is idempotent per (queue, idempotency_key)', async () => {
    const first = await store.spawn(Q, 'once', '{}', { idempotencyKey: 'k1' })
    const second = await store.spawn(Q, 'once', '{}', { idempotencyKey: 'k1' })
    expect(second.created).toBe(false)
    expect(second.taskId).toBe(first.taskId)
    const [count] = await db.batch('t', [{ sql: `SELECT COUNT(*) AS n FROM tasks`, args: [] }])
    expect(Number(count?.rows[0]?.n)).toBe(1)
  })

  it('same key on different queues creates distinct tasks', async () => {
    const a = await store.spawn('qa', 'x', '{}', { idempotencyKey: 'k' })
    const b = await store.spawn('qb', 'x', '{}', { idempotencyKey: 'k' })
    expect(a.taskId).not.toBe(b.taskId)
    expect(b.created).toBe(true)
  })
})

describe('claim', () => {
  it('claims due runs oldest-first with claim_gen 1 and full task data', async () => {
    await store.spawn(Q, 'a', '{"n":1}')
    await store.spawn(Q, 'b', '{"n":2}')
    const claimed = await store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 10 })
    expect(claimed).toHaveLength(2)
    for (const run of claimed) {
      expect(run.claimGen).toBe(1)
      expect(run.claimToken).toBe('tick-1')
      expect(run.maxAttempts).toBeGreaterThan(0)
    }
    expect(claimed.map((r) => r.taskName)).toEqual(['a', 'b'])
    expect(claimed[0]?.claimExpiresAtEpochMs).toBe(1_000_000 + 60_000)
    expect(claimed[0]?.infraRetries).toBe(0)
    expect(await store.claim(Q, 'tick-2', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
  })

  it('does not claim runs deferred by startDelaySeconds until engine time passes', async () => {
    await store.spawn(Q, 'later', '{}', { startDelaySeconds: 1000 })
    expect(await store.claim(Q, 't1', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
    await admin.setFakeNowEpochMs(2_000_001)
    expect(await store.claim(Q, 't1', { leaseSeconds: 60, limit: 10 })).toHaveLength(1)
  })

  it('respects the batch limit', async () => {
    for (let i = 0; i < 5; i++) await store.spawn(Q, `t${i}`, '{}')
    expect(await store.claim(Q, 't1', { leaseSeconds: 60, limit: 2 })).toHaveLength(2)
    expect(await store.claim(Q, 't2', { leaseSeconds: 60, limit: 10 })).toHaveLength(3)
  })
})

describe('activate', () => {
  async function claimOne(token: string): Promise<ClaimedRun> {
    const claimed = await store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
    const run = claimed[0]
    if (!run) throw new Error('expected a claimable run')
    return run
  }

  it('passes exactly once per claim generation and returns the worker payload', async () => {
    await store.spawn(Q, 'job', '{"k":1}')
    const run = await claimOne('tick-1')
    const activated = await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    expect(activated).not.toBeNull()
    // The worker learns its run from activation — the launch carries only ids.
    expect(activated?.taskName).toBe('job')
    expect(activated?.paramsJson).toBe('{"k":1}')
    // The duplicate delivery of the SAME claim must die on the CAS.
    expect(await store.activate(Q, run.runId, run.claimToken, run.claimGen)).toBeNull()
  })

  it('rejects stale tokens and stale generations after a re-claim', async () => {
    await store.spawn(Q, 'job', '{}')
    const first = await claimOne('tick-1')
    expect(await store.activate(Q, first.runId, first.claimToken, first.claimGen)).not.toBeNull()

    // Emulate a sleep wake (reschedule lands in PR1.5): back to claimable.
    await db.batch('t', [
      {
        sql: `UPDATE runs SET state = 'sleeping', claimed_by = NULL, claim_expires_at_ms = NULL,
              available_at_ms = 1000000 WHERE run_id = ?`,
        args: [first.runId],
      },
    ])

    const second = await claimOne('tick-2')
    expect(second.runId).toBe(first.runId)
    expect(second.claimGen).toBe(2)
    // The one-shot-latch regression: the OLD generation must fail, the new
    // one must pass — a run is re-claimed many times across its life.
    expect(await store.activate(Q, first.runId, first.claimToken, first.claimGen)).toBeNull()
    expect(await store.activate(Q, second.runId, second.claimToken, second.claimGen)).not.toBeNull()
  })

  it('re-extends the lease at activation (late launch delivery)', async () => {
    await store.spawn(Q, 'job', '{}')
    const run = await claimOne('tick-1')
    // Lease was stamped at claim: expires at 1_000_000 + 60s.
    await admin.setFakeNowEpochMs(1_040_000)
    expect(await store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
    const [row] = await db.batch('t', [
      { sql: `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`, args: [run.runId] },
    ])
    expect(Number(row?.rows[0]?.claim_expires_at_ms)).toBe(1_040_000 + 60_000)
  })

  it('stamps first_started_at_ms on the task exactly once', async () => {
    await store.spawn(Q, 'job', '{}')
    const run = await claimOne('tick-1')
    await store.activate(Q, run.runId, run.claimToken, run.claimGen)
    const [row] = await db.batch('t', [
      { sql: `SELECT first_started_at_ms FROM tasks WHERE task_id = ?`, args: [run.taskId] },
    ])
    expect(Number(row?.rows[0]?.first_started_at_ms)).toBe(1_000_000)
  })
})

describe('heartbeat', () => {
  it('extends a held lease and reports remaining time', async () => {
    await store.spawn(Q, 'job', '{}')
    const [run] = await store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 1 })
    expect(run).toBeDefined()
    if (!run) return
    const lease = await store.heartbeat(Q, run.runId, run.claimToken, 120)
    expect(lease.held).toBe(true)
    expect(lease.remainingMs).toBe(120_000)
  })

  it('reports lease lost for a stale token — the AB002 signal', async () => {
    await store.spawn(Q, 'job', '{}')
    const [run] = await store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 1 })
    if (!run) return
    expect(await store.heartbeat(Q, run.runId, 'stale-token', 60)).toEqual({
      held: false,
      remainingMs: 0,
    })
  })
})

describe('concurrent claim exclusivity (simulated)', () => {
  it('never double-claims a run across concurrent ticks, any seed', async () => {
    for (let seed = 0; seed < 10; seed++) {
      const real = LibsqlExecutor.open(':memory:')
      const realAdmin = new LibsqlStoreAdmin(real)
      await realAdmin.migrate()
      await realAdmin.setFakeNowEpochMs(1_000_000)
      const ids = seededIdSource(new Rng(seed))
      const setup = new LibsqlSchedulerStore(real, ids)
      for (let i = 0; i < 4; i++) await setup.spawn(Q, `job-${i}`, '{}')

      const world = new SimWorld(real, seed)
      const claimedBy = new Map<string, string[]>()
      for (const tick of ['tick-a', 'tick-b', 'tick-c']) {
        world.actor(tick, async (simDb) => {
          const actorStore = new LibsqlSchedulerStore(simDb, ids)
          const claimed = await actorStore.claim(Q, tick, { leaseSeconds: 60, limit: 2 })
          claimedBy.set(
            tick,
            claimed.map((r) => r.runId),
          )
        })
      }
      await world.run()

      const all = [...claimedBy.values()].flat()
      expect(all.length, `seed ${seed}: total claims`).toBe(4)
      expect(new Set(all).size, `seed ${seed}: distinct runs`).toBe(4)
      real.close()
    }
  })
})
