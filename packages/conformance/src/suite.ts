import type { ClaimedRun } from '@durablerun/core'
import { Rng, seededBuggify, SimWorld } from '@durablerun/harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

const Q = 'q'

/**
 * The dialect-agnostic scheduler conformance suite. Every store dialect —
 * and eventually every language port — must pass this battery unchanged;
 * raw-SQL assertions rely only on the shared schema (DESIGN.md §3.4), which
 * is part of the contract.
 */
export function schedulerConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`scheduler conformance [${dialect}]`, () => {
    let f: StoreFixture

    beforeEach(async () => {
      f = await makeFixture('fixture')
      await f.admin.setFakeNowEpochMs(1_000_000)
    })

    afterEach(() => {
      f.close()
    })

    describe('spawn', () => {
      it('creates a task with an initial pending run', async () => {
        const result = await f.store.spawn(Q, 'send-email', '{"to":"x"}')
        expect(result.created).toBe(true)
        const [runs] = await f.raw.batch('t', [
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
        const first = await f.store.spawn(Q, 'once', '{}', { idempotencyKey: 'k1' })
        const second = await f.store.spawn(Q, 'once', '{}', { idempotencyKey: 'k1' })
        expect(second.created).toBe(false)
        expect(second.taskId).toBe(first.taskId)
        const [count] = await f.raw.batch('t', [
          { sql: `SELECT COUNT(*) AS n FROM tasks`, args: [] },
        ])
        expect(Number(count?.rows[0]?.n)).toBe(1)
      })

      it('same key on different queues creates distinct tasks', async () => {
        const a = await f.store.spawn('qa', 'x', '{}', { idempotencyKey: 'k' })
        const b = await f.store.spawn('qb', 'x', '{}', { idempotencyKey: 'k' })
        expect(a.taskId).not.toBe(b.taskId)
        expect(b.created).toBe(true)
      })
    })

    describe('claim', () => {
      it('claims due runs oldest-first with claim_gen 1 and full task data', async () => {
        await f.store.spawn(Q, 'a', '{"n":1}')
        await f.store.spawn(Q, 'b', '{"n":2}')
        const claimed = await f.store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 10 })
        expect(claimed).toHaveLength(2)
        for (const run of claimed) {
          expect(run.claimGen).toBe(1)
          expect(run.claimToken).toBe('tick-1')
          expect(run.maxAttempts).toBeGreaterThan(0)
        }
        expect(claimed.map((r) => r.taskName)).toEqual(['a', 'b'])
        expect(claimed[0]?.claimExpiresAtEpochMs).toBe(1_000_000 + 60_000)
        expect(claimed[0]?.infraRetries).toBe(0)
        expect(await f.store.claim(Q, 'tick-2', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
      })

      it('does not claim runs deferred by startDelaySeconds until engine time passes', async () => {
        await f.store.spawn(Q, 'later', '{}', { startDelaySeconds: 1000 })
        expect(await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
        await f.admin.setFakeNowEpochMs(2_000_001)
        expect(await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 10 })).toHaveLength(1)
      })

      it('respects the batch limit', async () => {
        for (let i = 0; i < 5; i++) await f.store.spawn(Q, `t${i}`, '{}')
        expect(await f.store.claim(Q, 't1', { leaseSeconds: 60, limit: 2 })).toHaveLength(2)
        expect(await f.store.claim(Q, 't2', { leaseSeconds: 60, limit: 10 })).toHaveLength(3)
      })
    })

    describe('activate', () => {
      async function claimOne(token: string): Promise<ClaimedRun> {
        const claimed = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
        const run = claimed[0]
        if (!run) throw new Error('expected a claimable run')
        return run
      }

      it('passes exactly once per claim generation and returns the worker payload', async () => {
        await f.store.spawn(Q, 'job', '{"k":1}')
        const run = await claimOne('tick-1')
        const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        expect(activated).not.toBeNull()
        // The worker learns its run from activation — launches carry only ids.
        expect(activated?.taskName).toBe('job')
        expect(activated?.paramsJson).toBe('{"k":1}')
        // The duplicate delivery of the SAME claim must die on the CAS.
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).toBeNull()
      })

      it('rejects stale tokens and stale generations after a re-claim', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const first = await claimOne('tick-1')
        expect(
          await f.store.activate(Q, first.runId, first.claimToken, first.claimGen),
        ).not.toBeNull()

        // Emulate a sleep wake (reschedule lands in PR1.5): back to claimable.
        await f.raw.batch('t', [
          {
            sql: `UPDATE runs SET state = 'sleeping', claimed_by = NULL,
                  claim_expires_at_ms = NULL, available_at_ms = 1000000 WHERE run_id = ?`,
            args: [first.runId],
          },
        ])

        const second = await claimOne('tick-2')
        expect(second.runId).toBe(first.runId)
        expect(second.claimGen).toBe(2)
        // The one-shot-latch regression: the OLD generation must fail, the
        // new one must pass — runs are re-claimed many times across a life.
        expect(await f.store.activate(Q, first.runId, first.claimToken, first.claimGen)).toBeNull()
        expect(
          await f.store.activate(Q, second.runId, second.claimToken, second.claimGen),
        ).not.toBeNull()
      })

      it('re-extends the lease at activation (late launch delivery)', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        // Lease was stamped at claim: expires at 1_000_000 + 60s.
        await f.admin.setFakeNowEpochMs(1_040_000)
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        const [row] = await f.raw.batch('t', [
          { sql: `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`, args: [run.runId] },
        ])
        expect(Number(row?.rows[0]?.claim_expires_at_ms)).toBe(1_040_000 + 60_000)
      })

      it('stamps first_started_at_ms on the task exactly once', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        const [row] = await f.raw.batch('t', [
          { sql: `SELECT first_started_at_ms FROM tasks WHERE task_id = ?`, args: [run.taskId] },
        ])
        expect(Number(row?.rows[0]?.first_started_at_ms)).toBe(1_000_000)
      })
    })

    describe('heartbeat', () => {
      it('extends a held lease and reports remaining time', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 1 })
        expect(run).toBeDefined()
        if (!run) return
        const lease = await f.store.heartbeat(Q, run.runId, run.claimToken, 120)
        expect(lease.held).toBe(true)
        expect(lease.remainingMs).toBe(120_000)
      })

      it('reports lease lost for a stale token — the AB002 signal', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 1 })
        if (!run) return
        expect(await f.store.heartbeat(Q, run.runId, 'stale-token', 60)).toEqual({
          held: false,
          remainingMs: 0,
        })
      })
    })

    describe('sweep classification', () => {
      async function claimOne(token: string): Promise<ClaimedRun> {
        const claimed = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
        const run = claimed[0]
        if (!run) throw new Error('expected a claimable run')
        return run
      }

      it('reopens a lost launch without consuming an attempt', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1') // claimed, never activated
        await f.admin.setFakeNowEpochMs(1_100_000) // lease (60s) long expired
        const swept = await f.store.sweep(Q, 10)
        expect(swept).toEqual([
          { kind: 'lost-launch', runId: run.runId, taskId: run.taskId, relaunchCount: 1 },
        ])
        const [row] = await f.raw.batch('t', [
          {
            sql: `SELECT state, attempt, relaunch_count, claimed_by FROM runs WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        // Same row reopened: no successor, no attempt burn, backoff applied.
        // claimed_by carries the sweep's fence stamp (never the old worker's
        // token) — nothing reads claimed_by off non-running runs and the
        // next claim overwrites it.
        expect(row?.rows[0]).toMatchObject({
          state: 'pending',
          attempt: 1,
          relaunch_count: 1,
        })
        expect(row?.rows[0]?.claimed_by).not.toBe('tick-1')
        const [task] = await f.raw.batch('t', [
          {
            sql: `SELECT attempts, infra_retries FROM tasks WHERE task_id = ?`,
            args: [run.taskId],
          },
        ])
        expect(task?.rows[0]).toMatchObject({ attempts: 0, infra_retries: 0 })
        // The stale generation is dead: re-claim gets gen 2, old gen fails.
        await f.admin.setFakeNowEpochMs(1_200_000)
        const again = await claimOne('tick-2')
        expect(again.claimGen).toBe(2)
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).toBeNull()
      })

      it('fails the run AND task terminally past the relaunch cap', async () => {
        await f.store.spawn(Q, 'job', '{}')
        let now = 1_000_000
        // Default cap is 5: burn exactly cap reopens, then the terminal one.
        for (let i = 0; i < 5; i++) {
          await claimOne(`tick-${i}`)
          now += 200_000
          await f.admin.setFakeNowEpochMs(now)
          const swept = await f.store.sweep(Q, 10)
          expect(swept[0]?.kind).toBe('lost-launch')
          now += 400_000 // past the relaunch backoff
          await f.admin.setFakeNowEpochMs(now)
        }
        const last = await claimOne('tick-final')
        await f.admin.setFakeNowEpochMs(now + 200_000)
        const swept = await f.store.sweep(Q, 10)
        expect(swept).toEqual([
          { kind: 'relaunch-cap-exhausted', runId: last.runId, taskId: last.taskId },
        ])
        const [task] = await f.raw.batch('t', [
          { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [last.taskId] },
        ])
        expect(task?.rows[0]?.state).toBe('failed')
      })

      it('classifies a died-mid-run as claim-timeout: successor on infra budget', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        // Park an event wake to prove successors carry it (§3.8.2).
        await f.raw.batch('t', [
          {
            sql: `UPDATE runs SET wake_event = 'e1', event_payload = '{"x":1}' WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)
        const swept = await f.store.sweep(Q, 10)
        expect(swept).toHaveLength(1)
        const outcome = swept[0]
        if (outcome?.kind !== 'claim-timeout') throw new Error(`got ${outcome?.kind}`)
        const [rows] = await f.raw.batch('t', [
          {
            sql: `SELECT run_id, state, attempt, wake_event, event_payload,
                         failure_reason FROM runs WHERE task_id = ? ORDER BY attempt`,
            args: [run.taskId],
          },
        ])
        expect(rows?.rows).toHaveLength(2)
        expect(rows?.rows[0]).toMatchObject({
          state: 'failed',
          failure_reason: '{"name":"$ClaimTimeout"}',
        })
        expect(rows?.rows[1]).toMatchObject({
          run_id: outcome.successorRunId,
          state: 'pending',
          attempt: 2,
          wake_event: 'e1',
          event_payload: '{"x":1}',
        })
        const [task] = await f.raw.batch('t', [
          {
            sql: `SELECT attempts, infra_retries FROM tasks WHERE task_id = ?`,
            args: [run.taskId],
          },
        ])
        // Infra accounting: the successor never touches the user budget.
        expect(task?.rows[0]).toMatchObject({ attempts: 0, infra_retries: 1 })
        // Claiming the successor never touches attempts (user failures only).
        await f.admin.setFakeNowEpochMs(1_200_000)
        const successor = await claimOne('tick-2')
        expect(successor.attempt).toBe(2)
        expect(successor.infraRetries).toBe(1)
        const [after] = await f.raw.batch('t', [
          { sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [run.taskId] },
        ])
        expect(after?.rows[0]?.attempts).toBe(0)
      })

      it('fails the task terminally at the infra-retry cap, no successor', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.raw.batch('t', [
          { sql: `UPDATE tasks SET infra_retries = 20 WHERE task_id = ?`, args: [run.taskId] },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)
        const swept = await f.store.sweep(Q, 10)
        expect(swept).toEqual([
          { kind: 'infra-cap-exhausted', runId: run.runId, taskId: run.taskId },
        ])
        const [rows] = await f.raw.batch('t', [
          {
            sql: `SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND state = 'pending'`,
            args: [run.taskId],
          },
        ])
        expect(Number(rows?.rows[0]?.n)).toBe(0)
        const [task] = await f.raw.batch('t', [
          { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [run.taskId] },
        ])
        expect(task?.rows[0]?.state).toBe('failed')
      })

      it('a swept zombie learns lease-lost on its next heartbeat', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.admin.setFakeNowEpochMs(1_100_000)
        await f.store.sweep(Q, 10)
        expect(await f.store.heartbeat(Q, run.runId, run.claimToken, 60)).toEqual({
          held: false,
          remainingMs: 0,
        })
      })
    })

    describe('cancellation', () => {
      it('enforces max_delay: never-started tasks cancel at the deadline', async () => {
        const spawned = await f.store.spawn(Q, 'slow-start', '{}', {
          cancellation: { maxDelaySeconds: 30 },
        })
        expect(await f.store.sweep(Q, 10)).toEqual([]) // not yet due
        await f.admin.setFakeNowEpochMs(1_031_000)
        const swept = await f.store.sweep(Q, 10)
        expect(swept).toEqual([{ kind: 'cancelled', taskId: spawned.taskId, runId: spawned.runId }])
        const [task] = await f.raw.batch('t', [
          { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
        ])
        expect(task?.rows[0]?.state).toBe('cancelled')
        expect(await f.store.claim(Q, 't', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
      })

      it('enforces max_duration from first activation, even while running', async () => {
        await f.store.spawn(Q, 'runaway', '{}', {
          cancellation: { maxDurationSeconds: 100 },
        })
        const [run] = await f.store.claim(Q, 'tick-1', { leaseSeconds: 600, limit: 1 })
        if (!run) throw new Error('expected run')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.admin.setFakeNowEpochMs(1_101_000) // 101s after first start
        const swept = await f.store.sweep(Q, 10)
        expect(swept.map((s) => s.kind)).toEqual(['cancelled'])
        // The cancelled worker's writes are fenced out from here on.
        expect((await f.store.heartbeat(Q, run.runId, run.claimToken, 60)).held).toBe(false)
      })

      it('cancelTask cancels explicitly regardless of deadlines', async () => {
        const spawned = await f.store.spawn(Q, 'job', '{}')
        expect(await f.store.cancelTask(Q, spawned.taskId)).toBe(true)
        expect(await f.store.cancelTask(Q, spawned.taskId)).toBe(false) // already terminal
        expect(await f.store.claim(Q, 't', { leaseSeconds: 60, limit: 10 })).toHaveLength(0)
      })
    })

    describe('expireLeaseNow (the advisory write)', () => {
      it('accelerates sweep pickup with a valid token; stale tokens no-op', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'tick-1', { leaseSeconds: 600, limit: 1 })
        if (!run) throw new Error('expected run')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        expect(await f.store.expireLeaseNow(Q, run.runId, 'wrong-token')).toBe(false)
        expect(await f.store.sweep(Q, 10)).toEqual([]) // lease still healthy
        expect(await f.store.expireLeaseNow(Q, run.runId, run.claimToken)).toBe(true)
        const swept = await f.store.sweep(Q, 10)
        expect(swept.map((s) => s.kind)).toEqual(['claim-timeout'])
      })
    })

    describe('concurrent sweep exclusivity (simulated)', () => {
      it('exactly one successor per timed-out run under racing sweepers, any seed', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`sweep-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          // Two activated runs (→ claim-timeout) and one never-activated
          // (→ lost-launch reopen), all with expired leases.
          for (let i = 0; i < 3; i++) await fx.store.spawn(Q, `job-${i}`, '{}')
          const claimed = await fx.store.claim(Q, 'tick-0', { leaseSeconds: 60, limit: 3 })
          expect(claimed).toHaveLength(3)
          for (const run of claimed.slice(0, 2)) {
            await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          }
          await fx.admin.setFakeNowEpochMs(1_100_000)

          const world = new SimWorld(fx.raw, seed)
          for (const sweeper of ['sweeper-a', 'sweeper-b']) {
            world.actor(sweeper, async (simDb) => {
              await fx.storeOver(simDb).sweep(Q, 10)
            })
          }
          await world.run()

          // Invariants regardless of schedule: each activated run failed with
          // EXACTLY one successor (unique (task_id, attempt) is the backstop);
          // the never-activated run reopened exactly once (relaunch_count 1).
          const [counts] = await fx.raw.batch('t', [
            {
              sql: `SELECT t.task_id,
                           SUM(CASE WHEN r.attempt = 2 THEN 1 ELSE 0 END) AS successors,
                           MAX(r.relaunch_count) AS relaunches,
                           MAX(t.infra_retries) AS infra
                    FROM tasks t JOIN runs r ON r.task_id = t.task_id
                    GROUP BY t.task_id ORDER BY t.task_id`,
              args: [],
            },
          ])
          const rows = counts?.rows ?? []
          expect(rows, `seed ${seed}`).toHaveLength(3)
          let successorTasks = 0
          let reopenedTasks = 0
          for (const row of rows) {
            const successors = Number(row.successors)
            const relaunches = Number(row.relaunches)
            if (successors > 0) {
              successorTasks++
              expect(successors, `seed ${seed}: one successor`).toBe(1)
              expect(Number(row.infra), `seed ${seed}: one infra retry`).toBe(1)
            } else {
              reopenedTasks++
              expect(relaunches, `seed ${seed}: reopened exactly once`).toBe(1)
            }
          }
          expect(successorTasks, `seed ${seed}`).toBe(2)
          expect(reopenedTasks, `seed ${seed}`).toBe(1)
          fx.close()
        }
      })
    })

    describe('concurrent claim exclusivity (simulated)', () => {
      it('never double-claims a run across concurrent ticks, any seed', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(seed)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          for (let i = 0; i < 4; i++) await fx.store.spawn(Q, `job-${i}`, '{}')

          const world = new SimWorld(fx.raw, seed)
          const claimedBy = new Map<string, string[]>()
          for (const tick of ['tick-a', 'tick-b', 'tick-c']) {
            world.actor(tick, async (simDb) => {
              const actorStore = fx.storeOver(simDb)
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
          fx.close()
        }
      })

      it('upholds exclusivity under buggification (legal-rare paths forced)', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`buggy-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          for (let i = 0; i < 4; i++) await fx.store.spawn(Q, `job-${i}`, '{}')

          const world = new SimWorld(fx.raw, seed)
          const buggify = seededBuggify(new Rng(`buggy-${seed}`), 0.3)
          const claimedBy = new Map<string, string[]>()
          for (const tick of ['tick-a', 'tick-b', 'tick-c']) {
            world.actor(tick, async (simDb) => {
              const actorStore = fx.storeOver(simDb, buggify)
              const claimed = await actorStore.claim(Q, tick, { leaseSeconds: 60, limit: 2 })
              claimedBy.set(
                tick,
                claimed.map((r) => r.runId),
              )
            })
          }
          await world.run()

          // Short claims mean coverage may be partial — the INVARIANT is
          // exclusivity: no run ever claimed by two ticks.
          const all = [...claimedBy.values()].flat()
          expect(new Set(all).size, `seed ${seed}: no double-claims`).toBe(all.length)
          const [running] = await fx.raw.batch('t', [
            {
              sql: `SELECT COUNT(*) AS n FROM runs WHERE state = 'running' AND claimed_by IS NULL`,
              args: [],
            },
          ])
          expect(Number(running?.rows[0]?.n), `seed ${seed}: no ownerless running run`).toBe(0)
          fx.close()
        }
      })
    })
  })
}
