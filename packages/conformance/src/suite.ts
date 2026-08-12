import {
  type ClaimedRun,
  INFRA_RETRY_CAP,
  LeaseLostError,
  MAX_COUNT,
  MAX_DURATION_MS,
  MAX_RUN_ORDINAL,
  RELAUNCH_CAP,
  type SqlExecutor,
} from '@durablerun/core'
import {
  attributeExpectedFailure,
  attributeReplacedFailure,
  requireExpectedFailure,
} from '@durablerun/core/testing'
import { Rng, SimWorld, seededBuggify } from '@durablerun/harness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type StoreFixture,
  type StoreFixtureFactory,
  executeStorageCorruption,
  interposeAfterBatch,
} from './fixture.js'
import { engineInvariantViolations } from './invariants.js'

const Q = 'q'

async function snapshot(f: StoreFixture, taskId: string): Promise<unknown> {
  const [tasks, runs] = await f.raw.batch(
    'snap',
    [
      { sql: `SELECT * FROM tasks WHERE task_id = ?`, args: [taskId] },
      { sql: `SELECT * FROM runs WHERE task_id = ? ORDER BY attempt`, args: [taskId] },
    ],
    'read',
  )
  return { tasks: tasks?.rows, runs: runs?.rows }
}

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

      it('rejects retry durations above the durable bound without writing', async () => {
        await requireExpectedFailure(
          { kind: 'behavior', mutation: 'retry-spawn-normalization' },
          /exceeds the 100-year duration bound/,
          async () =>
            f.store.spawn(Q, 'oversized-retry', '{}', {
              retryStrategy: {
                kind: 'exponential',
                baseSeconds: MAX_DURATION_MS / 1000 + 1,
                factor: 2,
                maxSeconds: MAX_DURATION_MS / 1000 + 1,
              },
            }),
        )

        const [count] = await f.raw.batch(
          'retry-bound-probe',
          [{ sql: `SELECT COUNT(*) AS n FROM tasks`, args: [] }],
          'read',
        )
        expect(Number(count?.rows[0]?.n)).toBe(0)
      })

      it('rejects an explicit null retry strategy without writing', async () => {
        await requireExpectedFailure(
          { kind: 'behavior', mutation: 'retry-spawn-null' },
          /retry strategy must be an object/,
          async () =>
            f.store.spawn(Q, 'null-retry', '{}', {
              retryStrategy: null as never,
            }),
        )

        const [count] = await f.raw.batch(
          'retry-null-probe',
          [{ sql: `SELECT COUNT(*) AS n FROM tasks`, args: [] }],
          'read',
        )
        expect(Number(count?.rows[0]?.n)).toBe(0)
      })

      it('reads cancellation once and persists the value it validated', async () => {
        let reads = 0
        const valid = { maxDelaySeconds: 30 }
        const changed = { maxDurationSeconds: -1 }
        const opts = Object.defineProperty({}, 'cancellation', {
          enumerable: true,
          get: () => {
            reads += 1
            return reads <= 4 ? valid : changed
          },
        }) as { cancellation: { maxDelaySeconds?: number; maxDurationSeconds?: number } }

        const spawned = await f.store.spawn(Q, 'changing-cancellation', '{}', opts)
        const [rows] = await f.raw.batch(
          'changing-cancellation:probe',
          [
            {
              sql: `SELECT cancellation, cancel_at_ms FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )

        expect(
          {
            reads,
            cancellation: rows?.rows[0]?.cancellation,
            cancelAtEpochMs: rows?.rows[0]?.cancel_at_ms,
          },
          'mutation-verdict:behavior:spawn-cancellation-single-read',
        ).toEqual({
          reads: 1,
          cancellation: JSON.stringify(valid),
          cancelAtEpochMs: 1_030_000,
        })
      })
    })

    describe('claim', () => {
      it('leaves a candidate with a corrupt persisted retry strategy unclaimed', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-retry', '{}', {
          retryStrategy: {
            kind: 'fixed',
            baseSeconds: 1,
          },
        })
        await f.raw.batch('corrupt-retry-strategy', [
          {
            sql: `UPDATE tasks SET retry_strategy = ? WHERE task_id = ?`,
            args: [
              JSON.stringify({
                kind: 'fixed',
                baseSeconds: MAX_DURATION_MS / 1000 + 1,
              }),
              spawned.taskId,
            ],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store
          .claim(Q, 'corrupt-retry-token', { leaseSeconds: 60, limit: 1 })
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:claim-payload-validation-atomic',
        ).toEqual({
          observed: { kind: 'resolved', value: [] },
          after: before,
        })
      })

      it('leaves a candidate with corrupt persisted headers unclaimed', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-candidate-headers', '{}', {
          headers: { trace: 'valid' },
        })
        await f.raw.batch('corrupt-candidate-headers', [
          {
            sql: `UPDATE tasks SET headers = ? WHERE task_id = ?`,
            args: [JSON.stringify({ trace: 1 }), spawned.taskId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store
          .claim(Q, 'corrupt-candidate-headers-token', { leaseSeconds: 60, limit: 1 })
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:claim-candidate-headers-admissible',
        ).toEqual({
          observed: { kind: 'resolved', value: [] },
          after: before,
        })
      })

      it('same-token receipt refuses a corrupt persisted retry strategy', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-receipt-retry', '{}', {
          retryStrategy: { kind: 'fixed', baseSeconds: 1 },
        })
        const [run] = await f.store.claim(Q, 'corrupt-receipt-retry-token', {
          leaseSeconds: 60,
          limit: 1,
        })
        if (!run) throw new Error('expected a claimable run')
        await f.raw.batch('corrupt-receipt-retry', [
          {
            sql: `UPDATE tasks SET retry_strategy = ? WHERE task_id = ?`,
            args: [
              JSON.stringify({
                kind: 'fixed',
                baseSeconds: MAX_DURATION_MS / 1000 + 1,
              }),
              spawned.taskId,
            ],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store
          .claim(Q, run.claimToken, { leaseSeconds: 60, limit: 1 })
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:claim-receipt-retry-admissible',
        ).toEqual({
          observed: { kind: 'resolved', value: [] },
          after: before,
        })
      })

      it('same-token receipt refuses corrupt persisted headers', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-receipt-headers', '{}', {
          headers: { trace: 'valid' },
        })
        const [run] = await f.store.claim(Q, 'corrupt-receipt-headers-token', {
          leaseSeconds: 60,
          limit: 1,
        })
        if (!run) throw new Error('expected a claimable run')
        await f.raw.batch('corrupt-receipt-headers', [
          {
            sql: `UPDATE tasks SET headers = ? WHERE task_id = ?`,
            args: [JSON.stringify({ trace: 1 }), spawned.taskId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store
          .claim(Q, run.claimToken, { leaseSeconds: 60, limit: 1 })
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            () => ({ kind: 'rejected' as const }),
          )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:claim-receipt-headers-admissible',
        ).toEqual({
          observed: { kind: 'resolved', value: [] },
          after: before,
        })
      })

      it('normalizes an admissible persisted retry strategy before exposing it', async () => {
        const spawned = await f.store.spawn(Q, 'canonical-retry', '{}', {
          retryStrategy: { kind: 'fixed', baseSeconds: 1 },
        })
        await f.raw.batch('noncanonical-retry-strategy', [
          {
            sql: `UPDATE tasks SET retry_strategy = ? WHERE task_id = ?`,
            args: [
              JSON.stringify({ kind: 'fixed', baseSeconds: 0.0004, ignored: true }),
              spawned.taskId,
            ],
          },
        ])

        const [claimed] = await f.store.claim(Q, 'canonical-retry-token', {
          leaseSeconds: 60,
          limit: 1,
        })
        expect(
          claimed?.retryStrategy,
          'mutation-verdict:behavior:retry-persisted-normalization',
        ).toEqual({ kind: 'fixed', baseSeconds: 0 })
      })

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

      it('applies sole-live eligibility before the claim limit', async () => {
        const corrupt = await f.store.spawn(Q, 'corrupt', '{}')
        await f.raw.batch('t', [
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
                  VALUES ('corrupt-second', ?, ?, 2, 'pending', 1000000, 1000000)`,
            args: [Q, corrupt.taskId],
          },
        ])
        const corruptBefore = await snapshot(f, corrupt.taskId)

        await f.admin.setFakeNowEpochMs(1_000_001)
        const healthy = await f.store.spawn(Q, 'healthy', '{}')
        const claimed = await f.store.claim(Q, 'tick', { leaseSeconds: 60, limit: 1 })

        expect(
          claimed.map((run) => run.taskId),
          'regression:claim-eligibility-before-limit',
        ).toEqual([healthy.taskId])
        expect(await snapshot(f, corrupt.taskId)).toEqual(corruptBefore)
      })

      it('applies the activation-generation relation before the claim limit', async () => {
        const poisoned = await f.store.spawn(Q, 'activated-ahead', '{}')
        await f.raw.batch('corrupt-activation-generation', [
          {
            sql: `UPDATE runs SET activated_gen = claim_gen + 1 WHERE run_id = ?`,
            args: [poisoned.runId],
          },
        ])
        const poisonedBefore = await snapshot(f, poisoned.taskId)

        await f.admin.setFakeNowEpochMs(1_000_001)
        const healthy = await f.store.spawn(Q, 'healthy-after-activated-ahead', '{}')
        const claimed = await f.store.claim(Q, 'tick', { leaseSeconds: 60, limit: 1 })

        expect(
          claimed.map((run) => run.taskId),
          'mutation-verdict:behavior:claim-requires-activation-generation-order',
        ).toEqual([healthy.taskId])
        expect(await snapshot(f, poisoned.taskId)).toEqual(poisonedBefore)
      })

      it('does not return an activated-ahead run from a same-token claim receipt', async () => {
        const spawned = await f.store.spawn(Q, 'activated-ahead-receipt', '{}')
        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
        ).toHaveLength(1)
        await f.raw.batch('corrupt-receipt-activation-generation', [
          {
            sql: `UPDATE runs SET activated_gen = claim_gen + 1 WHERE run_id = ?`,
            args: [spawned.runId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
          'mutation-verdict:behavior:claim-receipt-requires-activation-generation-order',
        ).toEqual([])
        expect(await snapshot(f, spawned.taskId)).toEqual(before)
      })

      it('does not return an obsolete ordinal from a same-token claim receipt', async () => {
        const spawned = await f.store.spawn(Q, 'obsolete-ordinal-receipt', '{}')
        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
        ).toHaveLength(1)
        await f.raw.batch('corrupt-receipt-historical-ordinal', [
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, created_at_ms)
                  VALUES ('receipt-historical-higher', ?, ?, 3, 'failed', 999999)`,
            args: [Q, spawned.taskId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
          'mutation-verdict:behavior:claim-receipt-requires-highest-owned-ordinal',
        ).toEqual([])
        expect(await snapshot(f, spawned.taskId)).toEqual(before)
      })

      it('does not return an out-of-range relaunch counter from a same-token claim receipt', async () => {
        const spawned = await f.store.spawn(Q, 'relaunch-receipt', '{}')
        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
        ).toHaveLength(1)
        await f.raw.batch('corrupt-receipt-relaunch-count', [
          {
            sql: `UPDATE runs SET relaunch_count = ? WHERE run_id = ?`,
            args: [RELAUNCH_CAP + 1, spawned.runId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
          'mutation-verdict:behavior:claim-receipt-requires-relaunch-bound',
        ).toEqual([])
        expect(await snapshot(f, spawned.taskId)).toEqual(before)
      })

      it('returns a same-token receipt at the maximum claimed generation', async () => {
        const spawned = await f.store.spawn(Q, 'max-generation-receipt', '{}')
        await f.raw.batch('seed-max-receipt-generation', [
          {
            sql: `UPDATE runs SET claim_gen = ? WHERE run_id = ?`,
            args: [MAX_COUNT - 1, spawned.runId],
          },
        ])
        const [claimed] = await f.store.claim(Q, 'receipt-token', {
          leaseSeconds: 60,
          limit: 1,
        })
        expect(
          claimed?.claimGen,
          'mutation-verdict:behavior:claim-receipt-allows-max-generation',
        ).toBe(MAX_COUNT)

        expect(
          await f.store.claim(Q, 'receipt-token', { leaseSeconds: 60, limit: 1 }),
        ).toMatchObject([{ runId: spawned.runId, claimGen: MAX_COUNT }])
      })

      for (const claimGen of [MAX_COUNT, MAX_COUNT + 1]) {
        it(`leaves a due run unchanged when claim generation ${claimGen} cannot be incremented safely`, async () => {
          const spawned = await f.store.spawn(Q, `bounded-generation-${claimGen}`, '{}')
          await f.raw.batch('corrupt-claim-generation', [
            {
              sql: `UPDATE runs SET claim_gen = ? WHERE run_id = ?`,
              args: [claimGen, spawned.runId],
            },
          ])
          const before = await snapshot(f, spawned.taskId)

          const observed = await f.store
            .claim(Q, `bounded-claim-${claimGen}`, { leaseSeconds: 60, limit: 1 })
            .then(
              (value) => ({ kind: 'resolved' as const, value }),
              (error: unknown) => ({ kind: 'rejected' as const, error }),
            )

          expect(
            await snapshot(f, spawned.taskId),
            'mutation-verdict:behavior:claim-rejects-generation-overflow-atomically',
          ).toEqual(before)
          if (observed.kind === 'resolved') expect(observed.value).toEqual([])
        })
      }
    })

    describe('activate', () => {
      async function claimOne(token: string): Promise<ClaimedRun> {
        const claimed = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
        const run = claimed[0]
        if (!run) throw new Error('expected a claimable run')
        return run
      }

      it('rejects invalid claim-generation inputs before reaching the executor', async () => {
        let executorCalls = 0
        const forbiddenExecutor: SqlExecutor = {
          batch: async () => {
            executorCalls += 1
            throw new Error('invalid claim generation reached the SQL executor')
          },
        }
        const guardedStore = f.storeOver(forbiddenExecutor)
        const invalidClaimGenerations = [
          { name: 'string', value: '1' as unknown as number },
          { name: 'bigint', value: 1n as unknown as number },
          { name: 'fractional', value: 1.5 },
          { name: 'non-safe', value: Number.MAX_SAFE_INTEGER + 1 },
          { name: 'zero', value: 0 },
          { name: 'negative', value: -1 },
          { name: 'above-protocol-bound', value: MAX_COUNT + 1 },
        ]
        const observed: { name: string; rejectedBeforeSql: boolean }[] = []

        for (const { name, value } of invalidClaimGenerations) {
          const error = await guardedStore.activate(Q, 'run', 'token', value).then(
            () => null,
            (reason: unknown) => reason,
          )
          observed.push({ name, rejectedBeforeSql: error instanceof RangeError })
        }

        await f.raw.batch('invalid-activation-generation:seed', [
          {
            sql: `INSERT INTO tasks
                    (task_id, queue, task_name, params, retry_strategy, max_attempts,
                     cancellation, state, cancel_at_ms, enqueue_at_ms, created_at_ms)
                  VALUES ('invalid-activation-task', ?, 'job', '{}', '{"kind":"none"}', 3,
                    '{"maxDelaySeconds":30}', 'running', 1030000, 1000000, 1000000)`,
            args: [Q],
          },
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, claimed_by, claim_gen,
                     activated_gen, claim_expires_at_ms, lease_ms, created_at_ms)
                  VALUES ('invalid-activation-run', ?, 'invalid-activation-task', 1, 'running',
                    'invalid-activation-token', 1, 0, 1060000, 60000, 1000000)`,
            args: [Q],
          },
        ])
        const deadlineError = await f.store
          .activate(Q, 'invalid-activation-run', 'invalid-activation-token', 0)
          .then(
            () => null,
            (reason: unknown) => reason,
          )
        const [deadline] = await f.raw.batch(
          'invalid-activation-generation:deadline',
          [
            {
              sql: `SELECT cancel_at_ms FROM tasks WHERE task_id = 'invalid-activation-task'`,
              args: [],
            },
          ],
          'read',
        )

        expect(
          {
            invalidInputs: observed,
            executorCalls,
            deadline: {
              rejectedBeforeSql: deadlineError instanceof RangeError,
              cancelAtEpochMs: deadline?.rows[0]?.cancel_at_ms,
            },
          },
          'mutation-verdict:behavior:activate-validates-claim-generation-input',
        ).toEqual({
          invalidInputs: invalidClaimGenerations.map(({ name }) => ({
            name,
            rejectedBeforeSql: true,
          })),
          executorCalls: 0,
          deadline: {
            rejectedBeforeSql: true,
            cancelAtEpochMs: 1_030_000,
          },
        })
      })

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

      it('leaves a claim unactivated when its persisted retry strategy becomes invalid', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-before-activate', '{}', {
          retryStrategy: { kind: 'fixed', baseSeconds: 1 },
        })
        const run = await claimOne('tick-corrupt-before-activate')
        await f.raw.batch('corrupt-before-activate', [
          {
            sql: `UPDATE tasks SET retry_strategy = ? WHERE task_id = ?`,
            args: [
              JSON.stringify({
                kind: 'fixed',
                baseSeconds: MAX_DURATION_MS / 1000 + 1,
              }),
              spawned.taskId,
            ],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen).then(
          (value) => ({ kind: 'resolved' as const, value }),
          () => ({ kind: 'rejected' as const }),
        )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:activate-payload-validation-atomic',
        ).toEqual({
          observed: { kind: 'resolved', value: null },
          after: before,
        })
      })

      it('leaves a claim unactivated when its persisted headers become invalid', async () => {
        const spawned = await f.store.spawn(Q, 'corrupt-headers-before-activate', '{}', {
          headers: { trace: 'valid' },
        })
        const run = await claimOne('tick-corrupt-headers-before-activate')
        await f.raw.batch('corrupt-headers-before-activate', [
          {
            sql: `UPDATE tasks SET headers = ? WHERE task_id = ?`,
            args: [JSON.stringify({ trace: 1 }), spawned.taskId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)
        const observed = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen).then(
          (value) => ({ kind: 'resolved' as const, value }),
          () => ({ kind: 'rejected' as const }),
        )
        const after = await snapshot(f, spawned.taskId)

        expect(
          { observed, after },
          'mutation-verdict:behavior:activate-headers-admissible',
        ).toEqual({
          observed: { kind: 'resolved', value: null },
          after: before,
        })
      })

      // fenceTwin('Activate') — the per-claim generation CAS refuses the
      // old claim's token and generation once a re-claim has minted a new one.
      it('rejects stale tokens and stale generations after a re-claim', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const first = await claimOne('tick-1')
        expect(
          await f.store.activate(Q, first.runId, first.claimToken, first.claimGen),
        ).not.toBeNull()

        // Emulate a sleep wake by hand: back to claimable.
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

      it('leaves a claimed run unchanged when its stored lease is zero', async () => {
        const spawned = await f.store.spawn(Q, 'zero-lease', '{}')
        const run = await claimOne('tick-zero-lease')
        await f.raw.batch('corrupt-zero-lease', [
          {
            sql: `UPDATE runs SET lease_ms = 0 WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        const observed = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )

        expect(
          await snapshot(f, spawned.taskId),
          'mutation-verdict:behavior:activate-rejects-zero-lease-atomically',
        ).toEqual(before)
        if (observed.kind === 'resolved') expect(observed.value).toBeNull()
      })

      it('does not activate a claim whose relaunch counter became invalid', async () => {
        const spawned = await f.store.spawn(Q, 'invalid-relaunch-at-activation', '{}')
        const run = await claimOne('tick-invalid-relaunch')
        await f.raw.batch('corrupt-relaunch-before-activation', [
          {
            sql: `UPDATE runs SET relaunch_count = ? WHERE run_id = ?`,
            args: [RELAUNCH_CAP + 1, run.runId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        expect(
          await f.store.activate(Q, run.runId, run.claimToken, run.claimGen),
          'mutation-verdict:behavior:activate-requires-relaunch-bound',
        ).toBeNull()
        expect(await snapshot(f, spawned.taskId)).toEqual(before)
      })

      it('does not activate a claim whose live run is not the next accounted ordinal', async () => {
        const spawned = await f.store.spawn(Q, 'invalid-accounting-at-activation', '{}')
        const run = await claimOne('tick-invalid-accounting')
        await f.raw.batch('corrupt-accounting-before-activation', [
          {
            sql: `UPDATE tasks SET attempts = 1 WHERE task_id = ?`,
            args: [run.taskId],
          },
        ])
        const before = await snapshot(f, spawned.taskId)

        expect(
          await f.store.activate(Q, run.runId, run.claimToken, run.claimGen),
          'mutation-verdict:behavior:activate-requires-current-run-accounting',
        ).toBeNull()
        expect(await snapshot(f, spawned.taskId)).toEqual(before)
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

      // fenceTwin('Heartbeat') — a stale token never extends a lease.
      it('reports lease lost for a stale token — the AB002 signal', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'tick-1', { leaseSeconds: 60, limit: 1 })
        // A bare `if (!run) return` would make this test pass VACUOUSLY if
        // claim ever stopped returning the run — assert the precondition.
        expect(run).toBeDefined()
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

      it('quiesces an activated expired run under a terminal final-attempt owner', async () => {
        const spawned = await f.store.spawn(Q, 'terminal-timeout-owner', '{}')
        const run = await claimOne('tick-terminal-timeout-owner')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.raw.batch('terminalize-timeout-owner', [
          {
            sql: `UPDATE tasks
                  SET state = 'failed', attempts = max_attempts,
                      failure_reason = '{"name":"External"}'
                  WHERE task_id = ?`,
            args: [spawned.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [run.maxAttempts, run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)

        expect(await f.store.sweep(Q, 10)).toEqual([])
        const [task, runs] = await f.raw.batch(
          'terminal-timeout-owner:assert',
          [
            {
              sql: `SELECT state, attempts, max_attempts
                    FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT state, claimed_by FROM runs WHERE task_id = ?`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        expect(task?.rows[0]).toMatchObject({
          state: 'failed',
          attempts: run.maxAttempts,
          max_attempts: run.maxAttempts,
        })
        expect(
          runs?.rows,
          'mutation-verdict:behavior:sweep-quiesces-terminal-timeout-owner',
        ).toEqual([{ state: 'failed', claimed_by: null }])
      })

      it('quiesces a terminal activated timeout despite an unrelated corrupt relaunch counter', async () => {
        const spawned = await f.store.spawn(Q, 'terminal-timeout-corrupt-relaunch', '{}')
        const run = await claimOne('tick-terminal-timeout-corrupt-relaunch')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.raw.batch('terminalize-timeout-corrupt-relaunch', [
          {
            sql: `UPDATE tasks
                  SET state = 'failed', attempts = max_attempts,
                      failure_reason = '{"name":"External"}'
                  WHERE task_id = ?`,
            args: [spawned.taskId],
          },
        ])
        const disposition = await executeStorageCorruption(f, {
          table: 'runs',
          runId: run.runId,
          column: 'relaunch_count',
          invalidRepresentation: 'fractional-real',
        })
        if (disposition === 'structurally-rejected') return
        await f.admin.setFakeNowEpochMs(1_100_000)

        const swept = await attributeExpectedFailure(
          { kind: 'behavior', mutation: 'terminal-timeout-decode-ignores-relaunch' },
          (error) =>
            error instanceof RangeError &&
            error.message ===
              `sweep.relaunch_count must be an exact SQL integer in [0, ${RELAUNCH_CAP}], got number (not-an-exact-integer)`,
          () => f.store.sweep(Q, 10),
        )
        expect(
          swept,
          'mutation-verdict:behavior:sweep-terminal-timeout-ignores-unrelated-relaunch-corruption',
        ).toEqual([])
        const [task, storedRun] = await f.raw.batch(
          'terminal-timeout-corrupt-relaunch:assert',
          [
            {
              sql: `SELECT state, attempts, max_attempts, failure_reason
                    FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT state, claimed_by FROM runs WHERE run_id = ?`,
              args: [run.runId],
            },
          ],
          'read',
        )
        expect(task?.rows[0]).toMatchObject({
          state: 'failed',
          attempts: run.maxAttempts,
          max_attempts: run.maxAttempts,
          failure_reason: '{"name":"External"}',
        })
        expect(
          storedRun?.rows,
          'mutation-verdict:behavior:sweep-terminal-timeout-ignores-unrelated-relaunch-corruption',
        ).toEqual([{ state: 'failed', claimed_by: null }])
      })

      it('quiesces a relaunch-cap run under a terminal owner without reviving its task', async () => {
        const spawned = await f.store.spawn(Q, 'terminal-relaunch-cap-owner', '{}')
        const run = await claimOne('tick-terminal-relaunch-cap-owner')
        await f.raw.batch('terminalize-relaunch-cap-owner', [
          {
            sql: `UPDATE tasks
                  SET state = 'failed', attempts = max_attempts,
                      failure_reason = '{"name":"External"}'
                  WHERE task_id = ?`,
            args: [spawned.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ?, relaunch_count = ? WHERE run_id = ?`,
            args: [run.maxAttempts, RELAUNCH_CAP, run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)

        expect(
          await f.store.sweep(Q, 10),
          'mutation-verdict:behavior:sweep-quiesces-terminal-relaunch-cap-owner',
        ).toEqual([{ kind: 'relaunch-cap-exhausted', runId: run.runId, taskId: spawned.taskId }])
        const [task, runs] = await f.raw.batch(
          'terminal-relaunch-cap-owner:assert',
          [
            {
              sql: `SELECT state, attempts, max_attempts
                    FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT state, claimed_by FROM runs WHERE task_id = ?`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        expect(task?.rows[0]).toMatchObject({
          state: 'failed',
          attempts: run.maxAttempts,
          max_attempts: run.maxAttempts,
        })
        expect(runs?.rows).toEqual([{ state: 'failed', claimed_by: null }])
      })

      it('rechecks a terminal relaunch-cap generation after the advisory scan', async () => {
        const spawned = await f.store.spawn(Q, 'terminal-relaunch-cap-generation-race', '{}')
        const run = await claimOne('tick-terminal-relaunch-cap-generation-race')
        await f.raw.batch('terminalize-relaunch-cap-generation-race', [
          {
            sql: `UPDATE tasks
                  SET state = 'failed', attempts = max_attempts,
                      failure_reason = '{"name":"External"}'
                  WHERE task_id = ?`,
            args: [spawned.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ?, relaunch_count = ? WHERE run_id = ?`,
            args: [run.maxAttempts, RELAUNCH_CAP, run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)

        let afterCorruption: unknown
        const interposed = interposeAfterBatch(f.raw, 'sweep:scan', async () => {
          await f.raw.batch('corrupt-generation-after-terminal-cap-scan', [
            {
              sql: `UPDATE runs SET activated_gen = -1 WHERE run_id = ?`,
              args: [run.runId],
            },
          ])
          afterCorruption = await snapshot(f, spawned.taskId)
        })

        const swept = await f.storeOver(interposed.executor).sweep(Q, 10)
        expect(interposed.fired()).toBe(true)
        expect(
          swept,
          'mutation-verdict:behavior:sweep-terminal-cap-rechecks-generation-lower-bound',
        ).toEqual([])
        expect(afterCorruption).toBeDefined()
        expect(await snapshot(f, spawned.taskId)).toEqual(afterCorruption)
      })

      it('derives the timeout successor attempt from the fenced run, not the advisory scan', async () => {
        const spawned = await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.admin.setFakeNowEpochMs(1_100_000)

        const staleScan: SqlExecutor = {
          batch: async (label, statements, mode) => {
            const results = await f.raw.batch(label, statements, mode)
            if (label !== 'sweep:scan') return results
            return results.map((result, index) =>
              index === 1
                ? {
                    ...result,
                    rows: result.rows.map((row) =>
                      row.run_id === run.runId ? { ...row, attempt: 0 } : row,
                    ),
                  }
                : result,
            )
          },
        }

        const observed = await f
          .storeOver(staleScan)
          .sweep(Q, 10)
          .then(
            (value) => ({ kind: 'resolved' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
        expect(observed.kind, 'regression:sweep-successor-attempt-from-fenced-row').toBe('resolved')
        if (observed.kind !== 'resolved') return
        expect(observed.value).toMatchObject([
          {
            kind: 'claim-timeout',
            runId: run.runId,
            taskId: spawned.taskId,
          },
        ])

        const [runs, task] = await f.raw.batch(
          't',
          [
            {
              sql: `SELECT run_id, attempt, state FROM runs
                    WHERE task_id = ? ORDER BY attempt, run_id`,
              args: [spawned.taskId],
            },
            {
              sql: `SELECT state, attempts, infra_retries FROM tasks WHERE task_id = ?`,
              args: [spawned.taskId],
            },
          ],
          'read',
        )
        expect(runs?.rows).toMatchObject([
          { run_id: run.runId, attempt: 1, state: 'failed' },
          { attempt: 2, state: 'pending' },
        ])
        expect(task?.rows[0]).toMatchObject({
          state: 'pending',
          attempts: 0,
          infra_retries: 1,
        })
      })

      async function sweepAfterAccountingCorruption(activated: boolean) {
        const classification = activated ? 'claim-timeout' : 'lost-launch'
        const spawned = await f.store.spawn(Q, `${classification}-cas-recheck`, '{}')
        const run = await claimOne(`tick-${classification}-cas-recheck`)
        if (activated) {
          expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        }
        await f.admin.setFakeNowEpochMs(1_100_000)

        let afterCorruption: unknown
        const interposed = interposeAfterBatch(f.raw, 'sweep:scan', async () => {
          await f.raw.batch('corrupt-accounting-after-sweep-scan', [
            {
              sql: activated
                ? `UPDATE tasks SET infra_retries = ? WHERE task_id = ?`
                : `UPDATE tasks SET attempts = 1 WHERE task_id = ?`,
              args: activated ? [INFRA_RETRY_CAP, run.taskId] : [run.taskId],
            },
          ])
          afterCorruption = await snapshot(f, spawned.taskId)
        })
        const swept = await f.storeOver(interposed.executor).sweep(Q, 1)
        return {
          swept,
          interposed: interposed.fired(),
          afterCorruption,
          after: await snapshot(f, spawned.taskId),
        }
      }

      it('rechecks lost-launch accounting after the advisory sweep scan', async () => {
        const observed = await sweepAfterAccountingCorruption(false)
        expect(
          observed.swept,
          'mutation-verdict:behavior:sweep-lost-launch-rechecks-accounting',
        ).toEqual([])
        expect(observed.interposed).toBe(true)
        expect(observed.afterCorruption).toBeDefined()
        expect(observed.after).toEqual(observed.afterCorruption)
      })

      it('rechecks claim-timeout accounting after the advisory sweep scan', async () => {
        const observed = await sweepAfterAccountingCorruption(true)
        expect(
          observed.swept,
          'mutation-verdict:behavior:sweep-claim-timeout-rechecks-accounting',
        ).toEqual([])
        expect(observed.interposed).toBe(true)
        expect(observed.afterCorruption).toBeDefined()
        expect(observed.after).toEqual(observed.afterCorruption)
      })

      it('rechecks a corrupt stored attempt after discovery without partially sweeping the expired claim', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.admin.setFakeNowEpochMs(1_100_000)
        let injected = false
        let afterCorruption: unknown
        const interposed = interposeAfterBatch(f.raw, 'sweep:scan', async () => {
          const disposition = await executeStorageCorruption(f, {
            table: 'runs',
            runId: run.runId,
            column: 'attempt',
            invalidRepresentation: 'non-integer',
          })
          injected = disposition === 'injected'
          if (injected) afterCorruption = await snapshot(f, run.taskId)
        })
        const swept = await f.storeOver(interposed.executor).sweep(Q, 10)

        expect(interposed.fired()).toBe(true)
        if (!injected) return
        expect(swept, 'mutation-verdict:behavior:sweep-rejects-noninteger-attempt').toEqual([])
        expect(afterCorruption).toBeDefined()
        expect(await snapshot(f, run.taskId)).toEqual(afterCorruption)
      })

      it('leaves an expired claim unchanged when its ordinal exceeds the protocol bound', async () => {
        const spawned = await f.store.spawn(Q, 'overflowed-run-ordinal', '{}')
        const run = await claimOne('tick-overflowed-run-ordinal')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.raw.batch('corrupt-run-ordinal', [
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [MAX_RUN_ORDINAL + 1, run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)
        const before = await snapshot(f, spawned.taskId)

        const observed = await f.store.sweep(Q, 10).then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )

        expect(
          await snapshot(f, spawned.taskId),
          'regression:sweep-rejects-attempt-overflow-atomically',
        ).toEqual(before)
        if (observed.kind === 'resolved') expect(observed.value).toEqual([])
      })

      it('accepts the maximum ordinal at the terminal infra-cap branch', async () => {
        await f.store.spawn(Q, 'max-run-ordinal', '{}', { maxAttempts: MAX_COUNT })
        const run = await claimOne('tick-max-run-ordinal')
        expect(await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)).not.toBeNull()
        await f.raw.batch('seed-max-run-ordinal', [
          {
            sql: `UPDATE tasks
                  SET attempts = ?, max_attempts = ?, infra_retries = ?
                  WHERE task_id = ?`,
            args: [MAX_COUNT - 1, MAX_COUNT, INFRA_RETRY_CAP, run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [MAX_RUN_ORDINAL, run.runId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_100_000)

        expect(
          await f.store.sweep(Q, 10),
          'mutation-verdict:behavior:sweep-accepts-max-ordinal-at-infra-cap',
        ).toEqual([{ kind: 'infra-cap-exhausted', runId: run.runId, taskId: run.taskId }])
      })

      it('fails the task terminally at the infra-retry cap, no successor', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const run = await claimOne('tick-1')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.raw.batch('t', [
          {
            sql: `UPDATE tasks SET infra_retries = ? WHERE task_id = ?`,
            args: [INFRA_RETRY_CAP, run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [INFRA_RETRY_CAP + 1, run.runId],
          },
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

      it('refuses both suspension paths after the task cancellation deadline', async () => {
        const spawned = await f.store.spawn(Q, 'deadline', '{}', {
          cancellation: { maxDelaySeconds: 10 },
        })
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 600, limit: 1 })
        if (!run) throw new Error('expected a claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.raw.batch('t', [
          {
            sql: `UPDATE tasks SET cancel_at_ms = ? WHERE task_id = ?`,
            args: [1_000_001, spawned.taskId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_005_000)

        await expect(
          f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 1 }),
        ).rejects.toThrow(LeaseLostError)
        await expect(
          f.store.suspendRun(
            Q,
            run.runId,
            run.claimToken,
            { inSeconds: 1 },
            { key: '$sleep', stateJson: '{}' },
          ),
        ).rejects.toThrow(LeaseLostError)

        const [after] = await f.raw.batch(
          't',
          [{ sql: `SELECT state FROM runs WHERE run_id = ?`, args: [run.runId] }],
          'read',
        )
        expect(after?.rows[0]?.state).toBe('running')
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

    describe('transitions: complete / fail / reschedule', () => {
      async function activatedRun(token = 'w1') {
        await f.store.spawn(Q, 'job', '{"p":1}')
        const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        if (!activated) throw new Error('expected activation')
        return activated
      }

      it('complete finishes run and task and exposes the result', async () => {
        const run = await activatedRun()
        await f.store.complete(Q, run.runId, run.claimToken, '{"out":42}')
        const result = await f.store.getTaskResult(Q, run.taskId)
        expect(result).toMatchObject({ state: 'completed', completedPayloadJson: '{"out":42}' })
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      // fenceTwin('CompleteRun') — the swept zombie's complete is refused
      // with a before/after snapshot proving zero state change.
      it('a zombie complete after the sweep throws LeaseLostError and changes nothing', async () => {
        const run = await activatedRun()
        await f.admin.setFakeNowEpochMs(1_100_000)
        const swept = await f.store.sweep(Q, 10)
        expect(swept[0]?.kind).toBe('claim-timeout')
        const before = await snapshot(f, run.taskId)
        await expect(f.store.complete(Q, run.runId, run.claimToken, '{}')).rejects.toThrow(
          LeaseLostError,
        )
        expect(await snapshot(f, run.taskId)).toEqual(before)
      })

      it('fail with retry inserts the successor and is the ONLY mover of attempts', async () => {
        const run = await activatedRun()
        // A carried wake must be a LEGAL wake: the payload's source event
        // exists in the store (wake-payload-mismatch enforces provenance —
        // stamping the columns alone constructs an impossible world).
        await f.raw.batch('t', [
          {
            sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                  VALUES (?, 'e1', '{"x":1}', 1000000)`,
            args: [Q],
          },
          {
            sql: `UPDATE runs SET wake_event = 'e1', event_payload = '{"x":1}' WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        await f.store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 30 })
        const [rows] = await f.raw.batch('t', [
          {
            sql: `SELECT state, attempt, available_at_ms, wake_event FROM runs
                  WHERE task_id = ? ORDER BY attempt`,
            args: [run.taskId],
          },
        ])
        expect(rows?.rows[0]).toMatchObject({ state: 'failed', attempt: 1 })
        expect(rows?.rows[1]).toMatchObject({
          state: 'sleeping',
          attempt: 2,
          wake_event: 'e1',
        })
        const [task] = await f.raw.batch('t', [
          { sql: `SELECT attempts, state FROM tasks WHERE task_id = ?`, args: [run.taskId] },
        ])
        expect(task?.rows[0]).toMatchObject({ attempts: 1, state: 'sleeping' })
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('leaves a claimed run unchanged when infrastructure retries exceed the protocol cap', async () => {
        const run = await activatedRun('w-over-infra-cap')
        await f.raw.batch('corrupt-infra-retry-cap', [
          {
            sql: `UPDATE tasks SET infra_retries = ? WHERE task_id = ?`,
            args: [INFRA_RETRY_CAP + 1, run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [INFRA_RETRY_CAP + 2, run.runId],
          },
        ])
        const before = await snapshot(f, run.taskId)

        const observed = await f.store
          .fail(Q, run.runId, run.claimToken, '{"name":"CorruptAccounting"}', {
            delaySeconds: 0,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )

        expect(
          await snapshot(f, run.taskId),
          'regression:fail-rejects-infra-cap-overflow-atomically',
        ).toEqual(before)
        expect(observed.kind).toBe('rejected')
      })

      it('quiesces a claimed run under a terminal final-attempt owner', async () => {
        const run = await activatedRun('w-terminal-owner')
        await f.raw.batch('terminalize-fail-owner', [
          {
            sql: `UPDATE tasks
                  SET state = 'failed', attempts = max_attempts,
                      failure_reason = '{"name":"External"}'
                  WHERE task_id = ?`,
            args: [run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [run.maxAttempts, run.runId],
          },
        ])

        const observed = await f.store
          .fail(Q, run.runId, run.claimToken, '{"name":"WorkerExit"}', {
            delaySeconds: 0,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
        expect(observed.kind, 'mutation-verdict:behavior:fail-quiesces-terminal-owner').toBe(
          'resolved',
        )

        const [task, runs] = await f.raw.batch(
          'terminal-fail-owner:assert',
          [
            {
              sql: `SELECT state, attempts, max_attempts, failure_reason
                    FROM tasks WHERE task_id = ?`,
              args: [run.taskId],
            },
            {
              sql: `SELECT state, claimed_by, failure_reason
                    FROM runs WHERE task_id = ? ORDER BY attempt`,
              args: [run.taskId],
            },
          ],
          'read',
        )
        expect(task?.rows[0]).toMatchObject({
          state: 'failed',
          attempts: run.maxAttempts,
          max_attempts: run.maxAttempts,
          failure_reason: '{"name":"External"}',
        })
        expect(runs?.rows).toEqual([
          { state: 'failed', claimed_by: null, failure_reason: '{"name":"WorkerExit"}' },
        ])
      })

      it('fail without retry is terminal and exposes the failure', async () => {
        const run = await activatedRun()
        await f.store.fail(Q, run.runId, run.claimToken, '{"name":"Fatal"}', null)
        const result = await f.store.getTaskResult(Q, run.taskId)
        expect(result).toMatchObject({ state: 'failed', failureReasonJson: '{"name":"Fatal"}' })
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('reschedule sleeps attempt-neutral, mirrors the task, and re-claims on a fresh gen', async () => {
        const run = await activatedRun()
        await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 50 })
        const [row] = await f.raw.batch('t', [
          {
            sql: `SELECT r.state AS run_state, r.attempt, r.available_at_ms, t.state AS task_state
                  FROM runs r JOIN tasks t ON t.task_id = r.task_id WHERE r.run_id = ?`,
            args: [run.runId],
          },
        ])
        expect(row?.rows[0]).toMatchObject({
          run_state: 'sleeping',
          attempt: 1,
          available_at_ms: 1_050_000,
          task_state: 'sleeping',
        })
        await f.admin.setFakeNowEpochMs(1_051_000)
        const [again] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
        expect(again?.runId).toBe(run.runId)
        expect(again?.claimGen).toBe(2)
        expect(again?.attempt).toBe(1)
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('reschedule with atEpochMs writes the user absolute verbatim (sleepUntil)', async () => {
        const run = await activatedRun()
        await f.store.reschedule(Q, run.runId, run.claimToken, { atEpochMs: 1_777_000 })
        const [row] = await f.raw.batch('t', [
          { sql: `SELECT available_at_ms FROM runs WHERE run_id = ?`, args: [run.runId] },
        ])
        expect(Number(row?.rows[0]?.available_at_ms)).toBe(1_777_000)
      })

      it('a chain ({inSeconds: 0}) is immediately claimable as pending', async () => {
        const run = await activatedRun()
        await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 0 })
        const [again] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
        expect(again?.runId).toBe(run.runId)
      })

      // fenceTwin('FailRun') fenceTwin('SleepSuspend') fenceTwin('VoluntaryChain')
      // — the executable twins of the modeled CAS guards: every park/terminal
      // disposition refuses a stale token, including the immediate chain
      // (inSeconds: 0) and the marker-carrying suspend, which share the CAS.
      it('stale-token transitions throw LeaseLostError', async () => {
        const run = await activatedRun()
        await expect(f.store.reschedule(Q, run.runId, 'stale', { inSeconds: 1 })).rejects.toThrow(
          LeaseLostError,
        )
        await expect(f.store.reschedule(Q, run.runId, 'stale', { inSeconds: 0 })).rejects.toThrow(
          LeaseLostError,
        )
        await expect(
          f.store.suspendRun(
            Q,
            run.runId,
            'stale',
            { inSeconds: 1 },
            { key: 's', stateJson: '{}' },
          ),
        ).rejects.toThrow(LeaseLostError)
        await expect(f.store.complete(Q, run.runId, 'stale', '{}')).rejects.toThrow(LeaseLostError)
        await expect(f.store.fail(Q, run.runId, 'stale', '{}', null)).rejects.toThrow(
          LeaseLostError,
        )
      })

      it('suspendRun rejects a non-integer stored attempt atomically', async () => {
        const run = await activatedRun()
        const disposition = await executeStorageCorruption(f, {
          table: 'runs',
          runId: run.runId,
          column: 'attempt',
          invalidRepresentation: 'non-integer',
        })
        if (disposition === 'injected') {
          const observed = await f.store
            .suspendRun(
              Q,
              run.runId,
              run.claimToken,
              { inSeconds: 1 },
              { key: 'poison-attempt', stateJson: '{}' },
            )
            .then(
              () => ({ kind: 'resolved' as const }),
              (error: unknown) => ({ kind: 'rejected' as const, error }),
            )
          expect(
            observed.kind,
            'mutation-verdict:behavior:suspend-rejects-noninteger-attempt',
          ).toBe('rejected')
          if (observed.kind === 'rejected') {
            expect(observed.error).toBeInstanceOf(LeaseLostError)
          }
        }

        const [storedRun, checkpoints] = await f.raw.batch(
          'suspend-poison-attempt:assert',
          [
            { sql: `SELECT state FROM runs WHERE run_id = ?`, args: [run.runId] },
            {
              sql: `SELECT COUNT(*) AS n FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = 'poison-attempt'`,
              args: [run.taskId],
            },
          ],
          'read',
        )
        expect(storedRun?.rows[0]?.state).toBe('running')
        expect(Number(checkpoints?.rows[0]?.n)).toBe(0)
      })
    })

    describe('checkpoints', () => {
      async function checkpointWithNewerOwner(checkpointName: string, corruptOwner: boolean) {
        await f.store.spawn(Q, `corrupt-${checkpointName}`, '{}')
        const [run] = await f.store.claim(Q, `worker-${checkpointName}`, {
          leaseSeconds: 60,
          limit: 1,
        })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.raw.batch('checkpoint-corrupt-owner:seed', [
          {
            sql: `UPDATE tasks SET attempts = 1 WHERE task_id = ?`,
            args: [run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = 2 WHERE run_id = ?`,
            args: [run.runId],
          },
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, created_at_ms)
                  VALUES (?, ?, ?, 3, 'failed', 1000000)`,
            args: [`newer-owner-${checkpointName}`, Q, run.taskId],
          },
          {
            sql: `INSERT INTO checkpoints
                    (task_id, checkpoint_name, queue, state,
                     owner_run_id, owner_attempt, updated_at_ms)
                  VALUES (?, ?, ?, '{"newer":true}', ?, 3, 1000000)`,
            args: [run.taskId, checkpointName, Q, `newer-owner-${checkpointName}`],
          },
        ])
        if (corruptOwner) {
          const disposition = await executeStorageCorruption(f, {
            table: 'checkpoints',
            taskId: run.taskId,
            checkpointName,
            column: 'owner_attempt',
            invalidRepresentation: 'fractional-real',
          })
          if (disposition === 'structurally-rejected') return null
        }
        const [checkpoint] = await f.raw.batch(
          'checkpoint-corrupt-owner:before',
          [
            {
              sql: `SELECT checkpoint_name, state, owner_run_id, owner_attempt,
                           updated_at_ms
                    FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = ?`,
              args: [run.taskId, checkpointName],
            },
          ],
          'read',
        )
        return {
          run,
          before: await snapshot(f, run.taskId),
          checkpointBefore: checkpoint?.rows,
        }
      }

      type CheckpointConflictOperationId = 'checkpoint-write' | 'suspend'
      type CheckpointConflictVerdict = (action: () => Promise<unknown>) => Promise<void>
      type InvalidCheckpointConflictCase = Readonly<{
        id: string
        owner: Readonly<{
          task: 'current' | 'foreign'
          queue: string
          attempt: number
          id?: 'decoy'
        }> | null
        checkpointQueue: string
        ownerAttempt: number
        fractionalStorage?: true
        requireFailure: Readonly<Record<CheckpointConflictOperationId, CheckpointConflictVerdict>>
      }>

      const invalidCheckpointConflictCases: readonly InvalidCheckpointConflictCase[] = [
        {
          id: 'missing-owner',
          owner: null,
          checkpointQueue: Q,
          ownerAttempt: 3,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-exists',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-exists',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-id-mismatch',
          owner: { task: 'current', queue: Q, attempt: 3, id: 'decoy' },
          checkpointQueue: Q,
          ownerAttempt: 3,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-id',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-id',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-task-mismatch',
          owner: { task: 'foreign', queue: Q, attempt: 3 },
          checkpointQueue: Q,
          ownerAttempt: 3,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-task',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-task',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-queue-mismatch',
          owner: { task: 'current', queue: 'q-owner-mismatch', attempt: 3 },
          checkpointQueue: Q,
          ownerAttempt: 3,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-queue',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-queue',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-attempt-mismatch',
          owner: { task: 'current', queue: Q, attempt: 3 },
          checkpointQueue: Q,
          ownerAttempt: 4,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-attempt',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-attempt',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-attempt-out-of-range',
          owner: { task: 'current', queue: Q, attempt: MAX_RUN_ORDINAL + 1 },
          checkpointQueue: Q,
          ownerAttempt: MAX_RUN_ORDINAL + 1,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-attempt-upper',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-attempt-upper',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-attempt-below-range',
          owner: { task: 'current', queue: Q, attempt: 0 },
          checkpointQueue: Q,
          ownerAttempt: 0,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-attempt-lower',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-attempt-lower',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'owner-attempt-fractional-storage',
          owner: { task: 'current', queue: Q, attempt: 3 },
          checkpointQueue: Q,
          ownerAttempt: 3,
          fractionalStorage: true,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-owner-attempt-storage',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-owner-attempt-storage',
                },
                /suspendRun/,
                action,
              ),
          },
        },
        {
          id: 'conflict-queue-mismatch',
          owner: { task: 'current', queue: 'q-conflict-mismatch', attempt: 3 },
          checkpointQueue: 'q-conflict-mismatch',
          ownerAttempt: 3,
          requireFailure: {
            'checkpoint-write': (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'checkpoint-write-validates-existing-lww-owner-conflict-queue',
                },
                /setCheckpoint/,
                action,
              ),
            suspend: (action) =>
              requireExpectedFailure(
                {
                  kind: 'behavior',
                  mutation: 'suspend-validates-existing-lww-owner-conflict-queue',
                },
                /suspendRun/,
                action,
              ),
          },
        },
      ]

      const checkpointConflictOperations: readonly Readonly<{
        id: CheckpointConflictOperationId
        execute: (run: ClaimedRun, checkpointName: string) => Promise<unknown>
      }>[] = [
        {
          id: 'checkpoint-write',
          execute: (run: ClaimedRun, checkpointName: string) =>
            f.store.setCheckpoint(
              Q,
              run.taskId,
              run.runId,
              run.claimToken,
              checkpointName,
              '{"incoming":true}',
              90,
            ),
        },
        {
          id: 'suspend',
          execute: (run: ClaimedRun, checkpointName: string) =>
            f.store.suspendRun(
              Q,
              run.runId,
              run.claimToken,
              { inSeconds: 10 },
              { key: checkpointName, stateJson: '{"incoming":true}' },
            ),
        },
      ]

      it('roundtrips, extends the lease, and sorts by name', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.admin.setFakeNowEpochMs(1_010_000)
        await f.store.setCheckpoint(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          'b-step',
          '{"b":1}',
          90,
        )
        await f.store.setCheckpoint(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          'a-step',
          '{"a":1}',
          90,
        )
        const checkpoints = await f.store.getCheckpoints(Q, run.taskId, run.attempt)
        expect(checkpoints.map((c) => c.checkpointName)).toEqual(['a-step', 'b-step'])
        expect(checkpoints[0]).toMatchObject({ ownerRunId: run.runId, ownerAttempt: 1 })
        const [lease] = await f.raw.batch('t', [
          { sql: `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`, args: [run.runId] },
        ])
        expect(Number(lease?.rows[0]?.claim_expires_at_ms)).toBe(1_010_000 + 90_000)
      })

      it('an older attempt never overwrites a newer attempt (LWW tiebreak)', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{"v":1}', 60)
        // Simulate a newer attempt having already committed this name.
        await f.raw.batch('t', [
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, created_at_ms)
                  VALUES ('newer-checkpoint-owner', ?, ?, 5, 'failed', 1000000)`,
            args: [Q, run.taskId],
          },
          {
            sql: `UPDATE checkpoints
                  SET owner_run_id = 'newer-checkpoint-owner',
                      owner_attempt = 5,
                      state = '{"v":5}'
                  WHERE task_id = ? AND checkpoint_name = 's'`,
            args: [run.taskId],
          },
        ])
        await f.admin.setFakeNowEpochMs(1_010_000)
        await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{"v":1}', 60)
        const checkpoints = await f.store.getCheckpoints(Q, run.taskId, 5)
        expect(checkpoints[0]?.stateJson).toBe('{"v":5}')
        const [lease] = await f.raw.batch('t', [
          {
            sql: `SELECT heartbeat_at_ms, claim_expires_at_ms FROM runs WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        expect(lease?.rows[0]).toMatchObject({
          heartbeat_at_ms: 1_010_000,
          claim_expires_at_ms: 1_070_000,
        })
      })

      it('a stale token writes nothing and throws LeaseLostError', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await expect(
          f.store.setCheckpoint(Q, run.taskId, run.runId, 'stale', 's', '{}', 60),
        ).rejects.toThrow(LeaseLostError)
        expect(await f.store.getCheckpoints(Q, run.taskId, 9)).toEqual([])
      })

      it('rejects a fractional stored owner attempt before extending the lease', async () => {
        await f.store.spawn(Q, 'fractional-checkpoint-owner', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        const disposition = await executeStorageCorruption(f, {
          table: 'runs',
          runId: run.runId,
          column: 'attempt',
          invalidRepresentation: 'fractional-real',
        })
        if (disposition === 'structurally-rejected') return
        const before = await snapshot(f, run.taskId)

        await requireExpectedFailure(
          { kind: 'behavior', mutation: 'checkpoint-write-rejects-fractional-owner-attempt' },
          /setCheckpoint/,
          () =>
            f.store.setCheckpoint(
              Q,
              run.taskId,
              run.runId,
              run.claimToken,
              'fractional-owner',
              '{}',
              60,
            ),
        )

        expect(await snapshot(f, run.taskId)).toEqual(before)
        expect(await f.store.getCheckpoints(Q, run.taskId, MAX_RUN_ORDINAL)).toEqual([])
      })

      it('rejects an out-of-range stored owner attempt before extending the lease', async () => {
        await f.store.spawn(Q, 'overflowed-checkpoint-owner', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.raw.batch('corrupt-checkpoint-owner-bound', [
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [MAX_RUN_ORDINAL + 1, run.runId],
          },
        ])
        const before = await snapshot(f, run.taskId)

        await requireExpectedFailure(
          { kind: 'behavior', mutation: 'checkpoint-write-rejects-owner-attempt-overflow' },
          /setCheckpoint/,
          () =>
            f.store.setCheckpoint(
              Q,
              run.taskId,
              run.runId,
              run.claimToken,
              'overflowed-owner',
              '{}',
              60,
            ),
        )

        expect(await snapshot(f, run.taskId)).toEqual(before)
        const [checkpoints] = await f.raw.batch(
          'checkpoint-owner-bound:assert',
          [
            {
              sql: `SELECT COUNT(*) AS n FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = 'overflowed-owner'`,
              args: [run.taskId],
            },
          ],
          'read',
        )
        expect(Number(checkpoints?.rows[0]?.n)).toBe(0)
      })

      it('refuses a corrupt existing LWW owner before extending the lease', async () => {
        const seeded = await checkpointWithNewerOwner('corrupt-lww-set', true)
        if (!seeded) return

        await expect(
          f.store.setCheckpoint(
            Q,
            seeded.run.taskId,
            seeded.run.runId,
            seeded.run.claimToken,
            'corrupt-lww-set',
            '{"stale":true}',
            90,
          ),
        ).rejects.toThrow(/setCheckpoint/)

        expect(await snapshot(f, seeded.run.taskId)).toEqual(seeded.before)
        const [checkpoint] = await f.raw.batch(
          'checkpoint-corrupt-owner:set-assert',
          [
            {
              sql: `SELECT checkpoint_name, state, owner_run_id, owner_attempt,
                           updated_at_ms
                    FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = 'corrupt-lww-set'`,
              args: [seeded.run.taskId],
            },
          ],
          'read',
        )
        expect(checkpoint?.rows).toEqual(seeded.checkpointBefore)
      })

      it('refuses a corrupt existing LWW owner before suspending with a marker', async () => {
        const seeded = await checkpointWithNewerOwner('corrupt-lww-suspend', true)
        if (!seeded) return

        await expect(
          f.store.suspendRun(
            Q,
            seeded.run.runId,
            seeded.run.claimToken,
            { inSeconds: 10 },
            { key: 'corrupt-lww-suspend', stateJson: '{"stale":true}' },
          ),
        ).rejects.toThrow(/suspendRun/)

        expect(await snapshot(f, seeded.run.taskId)).toEqual(seeded.before)
        const [checkpoint] = await f.raw.batch(
          'checkpoint-corrupt-owner:suspend-assert',
          [
            {
              sql: `SELECT checkpoint_name, state, owner_run_id, owner_attempt,
                           updated_at_ms
                    FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = 'corrupt-lww-suspend'`,
              args: [seeded.run.taskId],
            },
          ],
          'read',
        )
        expect(checkpoint?.rows).toEqual(seeded.checkpointBefore)
      })

      for (const relation of invalidCheckpointConflictCases) {
        for (const operation of checkpointConflictOperations) {
          it(`atomically refuses ${operation.id}/${relation.id} checkpoint ownership`, async () => {
            await f.store.spawn(Q, `invalid-${relation.id}`, '{}')
            const [run] = await f.store.claim(Q, `worker-${relation.id}`, {
              leaseSeconds: 60,
              limit: 1,
            })
            if (!run) throw new Error('expected claim')
            await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)

            const checkpointName = `invalid-${relation.id}`
            const ownerRunId = `owner-${relation.id}`
            if (relation.owner) {
              await f.raw.batch('checkpoint-invalid-owner:seed-run', [
                {
                  sql: `INSERT INTO runs
                        (run_id, queue, task_id, attempt, state, created_at_ms)
                      VALUES (?, ?, ?, ?, 'failed', 1000000)`,
                  args: [
                    relation.owner.id === 'decoy' ? `decoy-${relation.id}` : ownerRunId,
                    relation.owner.queue,
                    relation.owner.task === 'current' ? run.taskId : `foreign-task-${relation.id}`,
                    relation.owner.attempt,
                  ],
                },
              ])
            }
            await f.raw.batch('checkpoint-invalid-owner:seed-checkpoint', [
              {
                sql: `INSERT INTO checkpoints
                      (task_id, checkpoint_name, queue, state,
                       owner_run_id, owner_attempt, updated_at_ms)
                    VALUES (?, ?, ?, '{"existing":true}', ?, ?, 1000000)`,
                args: [
                  run.taskId,
                  checkpointName,
                  relation.checkpointQueue,
                  ownerRunId,
                  relation.ownerAttempt,
                ],
              },
            ])
            if (relation.fractionalStorage) {
              const runDisposition = await executeStorageCorruption(f, {
                table: 'runs',
                runId: ownerRunId,
                column: 'attempt',
                invalidRepresentation: 'fractional-real',
              })
              if (runDisposition === 'structurally-rejected') return
              const checkpointDisposition = await executeStorageCorruption(f, {
                table: 'checkpoints',
                taskId: run.taskId,
                checkpointName,
                column: 'owner_attempt',
                invalidRepresentation: 'fractional-real',
              })
              if (checkpointDisposition === 'structurally-rejected') return
            }

            const before = await snapshot(f, run.taskId)
            const readCheckpoint = async () =>
              (
                await f.raw.batch(
                  'checkpoint-invalid-owner:read',
                  [
                    {
                      sql: `SELECT checkpoint_name, queue, state, owner_run_id,
                                 owner_attempt, updated_at_ms
                          FROM checkpoints
                          WHERE task_id = ? AND checkpoint_name = ?`,
                      args: [run.taskId, checkpointName],
                    },
                  ],
                  'read',
                )
              )[0]?.rows
            const checkpointBefore = await readCheckpoint()

            await relation.requireFailure[operation.id](() =>
              operation.execute(run, checkpointName),
            )
            expect(await snapshot(f, run.taskId), `${operation.id}/${relation.id}: run`).toEqual(
              before,
            )
            expect(await readCheckpoint(), `${operation.id}/${relation.id}: checkpoint`).toEqual(
              checkpointBefore,
            )
          })
        }
      }

      it('suspends under a valid higher LWW owner without replacing its checkpoint', async () => {
        const seeded = await checkpointWithNewerOwner('valid-lww-suspend', false)
        if (!seeded) throw new Error('valid checkpoint owner was unexpectedly rejected')

        await attributeExpectedFailure(
          { kind: 'behavior', mutation: 'suspend-preserves-valid-higher-lww' },
          /suspendRun/,
          () =>
            f.store.suspendRun(
              Q,
              seeded.run.runId,
              seeded.run.claimToken,
              { inSeconds: 10 },
              { key: 'valid-lww-suspend', stateJson: '{"stale":true}' },
            ),
        )

        const [run, checkpoint] = await f.raw.batch(
          'checkpoint-valid-owner:suspend-assert',
          [
            {
              sql: `SELECT state FROM runs WHERE run_id = ?`,
              args: [seeded.run.runId],
            },
            {
              sql: `SELECT checkpoint_name, state, owner_run_id, owner_attempt, updated_at_ms
                    FROM checkpoints
                    WHERE task_id = ? AND checkpoint_name = 'valid-lww-suspend'`,
              args: [seeded.run.taskId],
            },
          ],
          'read',
        )
        expect(
          run?.rows[0]?.state,
          'mutation-verdict:behavior:suspend-preserves-valid-higher-lww',
        ).toBe('sleeping')
        expect(checkpoint?.rows).toEqual(seeded.checkpointBefore)
      })

      it('validates checkpoint visibility through the run-ordinal input domain', async () => {
        let executorCalls = 0
        const forbiddenExecutor: SqlExecutor = {
          batch: async () => {
            executorCalls += 1
            throw new Error('invalid run ordinal reached the SQL executor')
          },
        }
        const guardedStore = f.storeOver(forbiddenExecutor)

        for (const invalidAttempt of [
          0,
          1.5,
          MAX_RUN_ORDINAL + 1,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          1n as unknown as number,
        ]) {
          await attributeReplacedFailure(
            { kind: 'behavior', mutation: 'checkpoint-read-validates-run-attempt-input' },
            /runs\.attempt/,
            /invalid run ordinal reached/,
            () => guardedStore.getCheckpoints(Q, 'missing-task', invalidAttempt),
          )
        }
        expect(executorCalls).toBe(0)

        expect(await f.store.getCheckpoints(Q, 'missing-task', 1)).toEqual([])
        expect(await f.store.getCheckpoints(Q, 'missing-task', MAX_RUN_ORDINAL)).toEqual([])
      })

      it('visibility filters by owner attempt', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{}', 60)
        await f.raw.batch('t', [
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, created_at_ms)
                  VALUES ('visible-checkpoint-owner', ?, ?, 3, 'failed', 1000000)`,
            args: [Q, run.taskId],
          },
          {
            sql: `UPDATE checkpoints
                  SET owner_run_id = 'visible-checkpoint-owner', owner_attempt = 3
                  WHERE task_id = ?`,
            args: [run.taskId],
          },
        ])
        expect(await f.store.getCheckpoints(Q, run.taskId, 2)).toEqual([])
        expect(await f.store.getCheckpoints(Q, run.taskId, 3)).toHaveLength(1)
      })

      it('does not surface a checkpoint whose owner ordinal is forged', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{}', 60)
        await f.raw.batch('forge-checkpoint-owner-attempt', [
          {
            sql: `UPDATE checkpoints SET owner_attempt = owner_attempt + 1
                  WHERE task_id = ? AND checkpoint_name = 's'`,
            args: [run.taskId],
          },
        ])

        expect(
          await f.store.getCheckpoints(Q, run.taskId, run.attempt + 1),
          'mutation-verdict:behavior:checkpoint-read-validates-owner-attempt',
        ).toEqual([])
      })

      it('accepts the maximum legal run ordinal in checkpoint ownership', async () => {
        await f.store.spawn(Q, 'job', '{}')
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await f.store.setCheckpoint(Q, run.taskId, run.runId, run.claimToken, 's', '{}', 60)
        await f.raw.batch('t', [
          {
            sql: `INSERT INTO runs
                    (run_id, queue, task_id, attempt, state, created_at_ms)
                  VALUES ('max-checkpoint-owner', ?, ?, ?, 'failed', 1000000)`,
            args: [Q, run.taskId, MAX_RUN_ORDINAL],
          },
          {
            sql: `UPDATE checkpoints
                  SET owner_run_id = 'max-checkpoint-owner', owner_attempt = ?
                  WHERE task_id = ? AND checkpoint_name = 's'`,
            args: [MAX_RUN_ORDINAL, run.taskId],
          },
        ])

        expect(await f.store.getCheckpoints(Q, run.taskId, MAX_RUN_ORDINAL)).toMatchObject([
          { checkpointName: 's', ownerAttempt: MAX_RUN_ORDINAL },
        ])
      })
    })

    describe('events (the TLC-verified emit/await protocol)', () => {
      async function claimActivate(token: string) {
        const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        return run
      }

      it('await-before-emit parks; the emit wakes it with the stored payload', async () => {
        await f.store.spawn(Q, 'waiter', '{}')
        const run = await claimActivate('w1')
        const first = await f.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          's',
          'go',
          null,
        )
        expect(first).toEqual({ emitted: false })
        // Parked, unclaimed, untimed: no wake source.
        expect(await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })).toHaveLength(0)
        await f.store.emitEvent(Q, 'go', '{"n":1}')
        const [woken] = await f.store.claim(Q, 'w3', { leaseSeconds: 60, limit: 1 })
        expect(woken?.runId).toBe(run.runId)
        expect(woken?.wake).toEqual({ event: 'go', step: 's', payloadJson: '{"n":1}' })
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('emit-before-await returns the payload inline with nothing suspended', async () => {
        await f.store.emitEvent(Q, 'ready', '{"x":2}')
        await f.store.spawn(Q, 'late', '{}')
        const run = await claimActivate('w1')
        const outcome = await f.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          's',
          'ready',
          null,
        )
        expect(outcome).toEqual({ emitted: true, payloadJson: '{"x":2}' })
        const [row] = await f.raw.batch('t', [
          { sql: `SELECT state FROM runs WHERE run_id = ?`, args: [run.runId] },
        ])
        expect(row?.rows[0]?.state).toBe('running') // still ours, not parked
      })

      // fenceTwin('EmitEvent') — the later emit may establish a delivery
      // fence, but the stored payload stays the first writer's.
      it('first write wins: a later emit cannot replace the payload', async () => {
        await f.store.emitEvent(Q, 'once', '{"v":"first"}')
        await f.store.emitEvent(Q, 'once', '{"v":"second"}')
        await f.store.spawn(Q, 'late', '{}')
        const run = await claimActivate('w1')
        const outcome = await f.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          's',
          'once',
          null,
        )
        expect(outcome).toEqual({ emitted: true, payloadJson: '{"v":"first"}' })
      })

      it('a timed wait that expires claims as the timeout wake and cannot be resurrected', async () => {
        await f.store.spawn(Q, 'timed', '{}')
        const run = await claimActivate('w1')
        expect(
          await f.store.awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'never', 30),
        ).toEqual({ emitted: false })
        await f.admin.setFakeNowEpochMs(1_031_000)
        const [woken] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
        expect(woken?.wake).toEqual({ event: 'never', step: 's', timedOut: true })
        // The expired wait row is gone: a late emit wakes NOTHING.
        await f.store.emitEvent(Q, 'never', '{"late":true}')
        const [rows] = await f.raw.batch('t', [
          { sql: `SELECT COUNT(*) AS n FROM waits WHERE status = 'waiting'`, args: [] },
        ])
        expect(Number(rows?.rows[0]?.n)).toBe(0)
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('no resurrection: cancelling a waiting task removes its wait; emit wakes nothing', async () => {
        const spawned = await f.store.spawn(Q, 'doomed', '{}')
        const run = await claimActivate('w1')
        await f.store.awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'later', null)
        expect(await f.store.cancelTask(Q, spawned.taskId)).toBe(true)
        await f.store.emitEvent(Q, 'later', '{}')
        expect(await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })).toHaveLength(0)
        const [task] = await f.raw.batch('t', [
          { sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
        ])
        expect(task?.rows[0]?.state).toBe('cancelled')
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })

      it('no lost wakeup: emit racing await, every interleaving, ends delivered', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`ev-race-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          await fx.store.spawn(Q, 'racer', '{}')
          const [run] = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
          if (!run) throw new Error('claim')
          await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          const world = new SimWorld(fx.raw, seed)
          let inline: string | null = null
          world.actor('awaiter', async (simDb) => {
            const out = await fx
              .storeOver(simDb)
              .awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'race', null)
              .catch(() => null)
            if (out?.emitted) inline = out.payloadJson
          })
          world.actor('emitter', async (simDb) => {
            await fx.storeOver(simDb).emitEvent(Q, 'race', '{"r":1}')
          })
          await world.run()
          // EITHER the await saw the event inline OR the emit woke the
          // parked run — never neither (the model's no-lost-wakeup).
          if (inline === null) {
            const [woken] = await fx.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
            expect(woken?.runId, `seed ${seed}`).toBe(run.runId)
            expect(woken?.wake, `seed ${seed}`).toEqual({
              event: 'race',
              step: 's',
              payloadJson: '{"r":1}',
            })
          } else {
            expect(inline, `seed ${seed}`).toBe('{"r":1}')
          }
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          fx.close()
        }
      })

      it('timeout-vs-emit race: the wake is exactly one of payload or timeout, never both', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`ev-timeout-race-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          await fx.store.spawn(Q, 'timed', '{}')
          const [run] = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
          if (!run) throw new Error('claim')
          await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          await fx.store.awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'late', 30)
          await fx.admin.setFakeNowEpochMs(1_030_000) // exactly at the deadline
          const world = new SimWorld(fx.raw, seed)
          world.actor('emitter', async (simDb) => {
            await fx.storeOver(simDb).emitEvent(Q, 'late', '{"won":"emit"}')
          })
          world.actor('claimer', async (simDb) => {
            await fx
              .storeOver(simDb)
              .claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
              .catch(() => {})
          })
          await world.run()
          // Whoever won, the run woke EXACTLY ONCE with a consistent wake:
          // payload delivery or timeout — and the wait row is settled.
          const [rows, waits] = await fx.raw.batch('t', [
            {
              sql: `SELECT wake_event, event_payload, state FROM runs WHERE run_id = ?`,
              args: [run.runId],
            },
            { sql: `SELECT COUNT(*) AS n FROM waits WHERE status = 'waiting'`, args: [] },
          ])
          expect(rows?.rows[0]?.wake_event, `seed ${seed}`).toBe('late')
          expect(Number(waits?.rows[0]?.n), `seed ${seed}: wait settled exactly once`).toBe(0)
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          fx.close()
        }
      })

      // fenceTwin('AwaitEventMiss') — the un-emitted path: a swept zombie's
      // awaitEvent registers no wait and parks nothing.
      it('a zombie awaitEvent is fence-refused (lease authority)', async () => {
        await f.store.spawn(Q, 'z', '{}')
        const run = await claimActivate('w1')
        await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
        await f.store.sweep(Q, 10) // claim-timeout successor takes over
        await expect(
          f.store.awaitEvent(Q, run.taskId, run.runId, run.claimToken, 's', 'e', null),
        ).rejects.toThrow()
        expect(await engineInvariantViolations(f.raw)).toEqual([])
      })
    })

    describe('driver registry', () => {
      it('a heartbeat is visible, refreshes, and buries expired rows', async () => {
        await f.admin.setFakeNowEpochMs(1_000_000)
        await f.store.driverHeartbeat(Q, 'd1', 10)
        const read = async () =>
          (
            await f.raw.batch(
              't',
              [
                {
                  sql: `SELECT driver_id, expires_at_ms FROM drivers ORDER BY driver_id`,
                  args: [],
                },
              ],
              'read',
            )
          )[0]?.rows ?? []
        expect(await read()).toMatchObject([{ driver_id: 'd1', expires_at_ms: 1_010_000 }])
        // Refresh extends; a second driver appears; the expired one is
        // buried by any later beat (self-cleaning registry).
        await f.admin.setFakeNowEpochMs(1_011_000)
        await f.store.driverHeartbeat(Q, 'd2', 10)
        expect(await read()).toMatchObject([{ driver_id: 'd2' }])
      })
    })

    describe('nextWakeAtEpochMs', () => {
      it('is null on an empty queue and the true min across all wake sources', async () => {
        expect(await f.store.nextWakeAtEpochMs(Q)).toBeNull()
        // A pending run due at 1_500_000...
        await f.store.spawn(Q, 'a', '{}', { startDelaySeconds: 500 })
        expect(await f.store.nextWakeAtEpochMs(Q)).toBe(1_500_000)
        // ...a running lease expiring at 1_060_000 beats it...
        await f.store.spawn(Q, 'c', '{}', { cancellation: { maxDurationSeconds: 20 } })
        const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        expect(run?.taskName).toBe('c')
        expect(await f.store.nextWakeAtEpochMs(Q)).toBe(1_060_000)
        // ...and activation arms c's max_duration deadline at 1_020_000,
        // which beats them all (the cancel-deadline wake source).
        if (!run) throw new Error('expected claim')
        await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        expect(await f.store.nextWakeAtEpochMs(Q)).toBe(1_020_000)
        // ...and a SLEEPING run is a wake source too (codex: this leg of the
        // UNION had no test constructing it): c sleeps until 1_010_000,
        // clearing its lease/deadline sources, and the sleep wins.
        await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 10 })
        expect(await f.store.nextWakeAtEpochMs(Q)).toBe(1_010_000)
      })
    })

    describe('deferred coverage: races and accounting depth', () => {
      it('sweep vs live heartbeat: exactly one of them wins, never both', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`hb-race-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          await fx.store.spawn(Q, 'job', '{}')
          const [run] = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
          if (!run) throw new Error('expected claim')
          await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          await fx.admin.setFakeNowEpochMs(1_060_000) // exactly at expiry
          const world = new SimWorld(fx.raw, seed)
          let held: boolean | null = null
          world.actor('worker', async (simDb) => {
            const lease = await fx.storeOver(simDb).heartbeat(Q, run.runId, run.claimToken, 60)
            held = lease.held
          })
          let swept: number | null = null
          world.actor('sweeper', async (simDb) => {
            swept = (await fx.storeOver(simDb).sweep(Q, 10)).length
          })
          await world.run()
          // XOR: a revived lease means nothing was swept; a swept run means
          // the zombie heartbeat reported lease-lost.
          expect([held, swept], `seed ${seed}`).not.toEqual([true, 1])
          expect([held, swept], `seed ${seed}`).not.toEqual([false, 0])
          expect(await engineInvariantViolations(fx.raw)).toEqual([])
          fx.close()
        }
      })

      it('a duplicated activation delivery leaves an ownerless activated run that the sweep reclaims', async () => {
        const fx = await makeFixture('dup-activate')
        await fx.admin.setFakeNowEpochMs(1_000_000)
        await fx.store.spawn(Q, 'job', '{}')
        const [run] = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        const world = new SimWorld(fx.raw, 1)
        world.injectDuplicate({ label: 'activate' })
        let outcome: unknown = 'unset'
        world.actor('worker', async (simDb) => {
          outcome = await fx.storeOver(simDb).activate(Q, run.runId, run.claimToken, run.claimGen)
        })
        await world.run()
        // The retry-after-lost-response duplicate consumed the CAS: the
        // caller sees null and must exit — yet the run IS activated.
        expect(outcome).toBeNull()
        const [row] = await fx.raw.batch('t', [
          { sql: `SELECT activated_gen FROM runs WHERE run_id = ?`, args: [run.runId] },
        ])
        expect(Number(row?.rows[0]?.activated_gen)).toBe(run.claimGen)
        // Recovery is the sweep's claim-timeout path — an infra retry, never
        // a lost-launch reopen and never a user attempt.
        await fx.admin.setFakeNowEpochMs(1_100_000)
        const swept = await fx.store.sweep(Q, 10)
        expect(swept[0]?.kind).toBe('claim-timeout')
        expect(await engineInvariantViolations(fx.raw)).toEqual([])
        fx.close()
      })

      it('a sweeper crashing mid-sweep leaves a resweepable, invariant-clean state', async () => {
        for (let seed = 0; seed < 10; seed++) {
          const fx = await makeFixture(`crash-sweep-${seed}`)
          await fx.admin.setFakeNowEpochMs(1_000_000)
          for (let i = 0; i < 2; i++) {
            await fx.store.spawn(Q, `job-${i}`, '{}')
          }
          const claimed = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 2 })
          for (const run of claimed) {
            await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          }
          await fx.admin.setFakeNowEpochMs(1_100_000)
          const world = new SimWorld(fx.raw, seed, { strictSpecs: false })
          world.injectCrash({ actor: 'sweeper-a', label: 'sweep:claim-timeout', when: 'after' })
          for (const name of ['sweeper-a', 'sweeper-b']) {
            world.actor(name, async (simDb) => {
              await fx
                .storeOver(simDb)
                .sweep(Q, 10)
                .catch(() => {})
            })
          }
          await world.run()
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          // A fresh sweep finishes whatever the crash stranded.
          await fx.store.sweep(Q, 10)
          const [successors] = await fx.raw.batch('t', [
            {
              sql: `SELECT COUNT(*) AS n FROM runs WHERE attempt = 2 AND state = 'pending'`,
              args: [],
            },
          ])
          expect(Number(successors?.rows[0]?.n), `seed ${seed}`).toBe(2)
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          fx.close()
        }
      })

      it('accounting depth: two infra cycles then a user failure', async () => {
        const fx = await makeFixture('accounting')
        await fx.admin.setFakeNowEpochMs(1_000_000)
        const spawned = await fx.store.spawn(Q, 'job', '{}')
        let now = 1_000_000
        for (let cycle = 0; cycle < 2; cycle++) {
          const [run] = await fx.store.claim(Q, `w${cycle}`, { leaseSeconds: 60, limit: 1 })
          if (!run) throw new Error('expected claim')
          await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          now += 100_000
          await fx.admin.setFakeNowEpochMs(now)
          const swept = await fx.store.sweep(Q, 10)
          expect(swept[0]?.kind).toBe('claim-timeout')
          now += 10_000
          await fx.admin.setFakeNowEpochMs(now)
        }
        const [run] = await fx.store.claim(Q, 'w-final', { leaseSeconds: 60, limit: 1 })
        if (!run) throw new Error('expected claim')
        expect(run.attempt).toBe(3)
        expect(run.infraRetries).toBe(2)
        await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        await fx.store.fail(Q, run.runId, run.claimToken, '{"name":"Boom"}', { delaySeconds: 1 })
        const [task] = await fx.raw.batch('t', [
          {
            sql: `SELECT attempts, infra_retries FROM tasks WHERE task_id = ?`,
            args: [spawned.taskId],
          },
        ])
        // attempts counts USER failures only; infra successors never touched it.
        expect(task?.rows[0]).toMatchObject({ attempts: 1, infra_retries: 2 })
        fx.close()
      })

      it('expireLeaseNow is advisory: a live heartbeat revives the lease', async () => {
        const fx = await makeFixture('revive')
        await fx.admin.setFakeNowEpochMs(1_000_000)
        await fx.store.spawn(Q, 'job', '{}')
        const [run] = await fx.store.claim(Q, 'w1', { leaseSeconds: 600, limit: 1 })
        if (!run) throw new Error('expected claim')
        await fx.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        expect(await fx.store.expireLeaseNow(Q, run.runId, run.claimToken)).toBe(true)
        // The still-alive worker heartbeats before any sweep: revival is the
        // intended §3.9 semantics (the lease is the sole authority).
        expect((await fx.store.heartbeat(Q, run.runId, run.claimToken, 600)).held).toBe(true)
        expect(await fx.store.sweep(Q, 10)).toEqual([])
        fx.close()
      })

      it('relaunch backoff arithmetic is pinned: 5s then 10s', async () => {
        const fx = await makeFixture('backoff')
        await fx.admin.setFakeNowEpochMs(1_000_000)
        await fx.store.spawn(Q, 'job', '{}')
        await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        await fx.admin.setFakeNowEpochMs(1_100_000)
        expect((await fx.store.sweep(Q, 10))[0]?.kind).toBe('lost-launch')
        const [first] = await fx.raw.batch('t', [
          { sql: `SELECT available_at_ms FROM runs`, args: [] },
        ])
        expect(Number(first?.rows[0]?.available_at_ms)).toBe(1_100_000 + 5_000)
        await fx.admin.setFakeNowEpochMs(1_200_000)
        await fx.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
        await fx.admin.setFakeNowEpochMs(1_300_000)
        expect((await fx.store.sweep(Q, 10))[0]?.kind).toBe('lost-launch')
        const [second] = await fx.raw.batch('t', [
          { sql: `SELECT available_at_ms FROM runs`, args: [] },
        ])
        expect(Number(second?.rows[0]?.available_at_ms)).toBe(1_300_000 + 10_000)
        fx.close()
      })

      it('a stale nonzero activated_gen still classifies a lost launch correctly', async () => {
        const fx = await makeFixture('stale-gen')
        await fx.admin.setFakeNowEpochMs(1_000_000)
        const spawned = await fx.store.spawn(Q, 'job', '{}')
        const [gen1] = await fx.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        if (!gen1) throw new Error('expected claim')
        await fx.store.activate(Q, gen1.runId, gen1.claimToken, gen1.claimGen)
        await fx.store.reschedule(Q, gen1.runId, gen1.claimToken, { inSeconds: 0 })
        // Second generation claimed but its launch is lost.
        const [gen2] = await fx.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })
        expect(gen2?.claimGen).toBe(2)
        await fx.admin.setFakeNowEpochMs(1_100_000)
        const swept = await fx.store.sweep(Q, 10)
        // activated_gen = 1 < claim_gen = 2: a LOST LAUNCH — reopen, no
        // successor, no infra retry (an '= 0' classifier would misfire here).
        expect(swept[0]?.kind).toBe('lost-launch')
        const [task] = await fx.raw.batch('t', [
          { sql: `SELECT infra_retries FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
        ])
        expect(Number(task?.rows[0]?.infra_retries)).toBe(0)
        fx.close()
      })
    })

    describe('concurrent sweep exclusivity (simulated)', () => {
      // fenceTwin('SweepLostLaunch') fenceTwin('SweepClaimTimeout') — racing
      // sweepers reopen or succeed a timed-out run EXACTLY once each; the
      // loser's CAS matches zero rows on every seed.
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
          // Invariants at quiescence, not only the scenario's own counts.
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
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
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
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
          expect(await engineInvariantViolations(fx.raw), `seed ${seed}`).toEqual([])
          fx.close()
        }
      })
    })
  })
}

const WAKE_EVENT = 'go'
const WAKE_STEP = '$await:go'
const WAKE_NOW = 1_000_000
const WAKE_FIELDS = ['queue', 'event_name', 'status', 'step_name', 'timeout_at_ms'] as const
type WakeField = (typeof WAKE_FIELDS)[number]

interface WakeRow {
  queue: string
  event_name: string
  status: string
  step_name: string
  timeout_at_ms: number | null
}

interface WakeDeadline {
  label: string
  healthy: number | null
  corrupt: number | null
}

interface WakePark {
  state: string
  wake_event: string
  wake_step: string | null
  available_at_ms: number | null
}

interface WakeOwner {
  label: string
  state: string
  live: boolean
}

export interface WakeWitnessCase {
  label: string
  owner: WakeOwner
  park: WakePark
  rows: WakeRow[]
  preserveSplitRowEvidence?: boolean
}

const WAKE_DEADLINES: readonly WakeDeadline[] = [
  { label: 'untimed', healthy: null, corrupt: WAKE_NOW + 5_000 },
  { label: 'timed', healthy: WAKE_NOW + 30_000, corrupt: null },
]

const WAKE_OWNERS: readonly WakeOwner[] = [
  { label: 'live-owner', state: 'running', live: true },
  { label: 'terminal-owner', state: 'completed', live: false },
]

function healthyWakeRow(deadline: WakeDeadline): WakeRow {
  return {
    queue: Q,
    event_name: WAKE_EVENT,
    status: 'waiting',
    step_name: WAKE_STEP,
    timeout_at_ms: deadline.healthy,
  }
}

function corruptWakeRow(deadline: WakeDeadline, fields: readonly WakeField[]): WakeRow {
  const row = healthyWakeRow(deadline)
  const wrong: WakeRow = {
    queue: 'elsewhere',
    event_name: 'other-event',
    status: 'delivered',
    step_name: `${WAKE_STEP}#stale`,
    timeout_at_ms: deadline.corrupt,
  }
  for (const field of fields) Object.assign(row, { [field]: wrong[field] })
  return row
}

function wakeParks(deadline: WakeDeadline): Record<string, WakePark> {
  const parked = {
    wake_event: WAKE_EVENT,
    wake_step: WAKE_STEP,
    available_at_ms: deadline.healthy,
  }
  return {
    parked: { state: 'sleeping', ...parked },
    'other-event': { state: 'sleeping', ...parked, wake_event: 'other-event' },
    'legacy-null-step': { state: 'sleeping', ...parked, wake_step: null },
    timer: { state: 'sleeping', ...parked, available_at_ms: deadline.corrupt },
    running: { state: 'running', ...parked },
    pending: { state: 'pending', ...parked },
  }
}

function shouldWake(owner: WakeOwner, park: WakePark, rows: readonly WakeRow[]): boolean {
  if (!owner.live || park.state !== 'sleeping' || park.wake_event !== WAKE_EVENT) return false
  const matching = rows.filter(
    (row) =>
      row.queue === Q &&
      row.event_name === WAKE_EVENT &&
      row.status === 'waiting' &&
      row.timeout_at_ms === park.available_at_ms,
  )
  if (park.wake_step === null) return matching.length === 1
  return matching.some((row) => row.step_name === park.wake_step)
}

const WAKE_SUBSETS: WakeField[][] = Array.from({ length: 1 << WAKE_FIELDS.length }, (_, mask) =>
  WAKE_FIELDS.filter((_field, index) => mask & (1 << index)),
)

function wakeFieldName(fields: readonly WakeField[]): string {
  return fields.length === 0 ? 'healthy' : fields.join('+')
}

const WAKE_AXES = WAKE_DEADLINES.flatMap((deadline) =>
  WAKE_OWNERS.flatMap((owner) =>
    Object.entries(wakeParks(deadline)).map(([parkLabel, park]) => ({
      deadline,
      owner,
      parkLabel,
      park,
    })),
  ),
)

export const WAKE_SINGLE_CASES: readonly WakeWitnessCase[] = WAKE_AXES.flatMap(
  ({ deadline, owner, parkLabel, park }) =>
    WAKE_SUBSETS.map((fields) => ({
      label: `${deadline.label} / ${owner.label} / ${parkLabel} / ${wakeFieldName(fields)}`,
      owner,
      park,
      rows: [corruptWakeRow(deadline, fields)],
    })),
)

const WAKE_AT_STEP = WAKE_SUBSETS.filter((fields) => !fields.includes('step_name'))
// The exact step-only disagreement belongs to the dedicated historical case
// below. The general pair matrix keeps every other cross-row combination
// without duplicating that case or the legacy null-step ambiguity cases.
const WAKE_AT_OTHER = WAKE_SUBSETS.filter(
  (fields) => fields.includes('step_name') && fields.length > 1,
)

// Legacy parks have no step to correlate. Two otherwise identical matching
// registrations at different steps are therefore their own pair dimension:
// the scalar must decline to invent either step. Keeping this separate from
// WAKE_AT_OTHER keeps the legacy null-step cardinality rule explicit in the
// same correlated-witness surface.
const WAKE_LEGACY_AMBIGUITY_CASES: readonly WakeWitnessCase[] = WAKE_AXES.filter(
  ({ owner, park }) => owner.live && park.state === 'sleeping' && park.wake_step === null,
).map(({ deadline, owner, parkLabel, park }) => ({
  label: `${deadline.label} / ${owner.label} / ${parkLabel} / healthy | step_name`,
  owner,
  park,
  rows: [healthyWakeRow(deadline), corruptWakeRow(deadline, ['step_name'])],
}))

const WAKE_SPLIT_ROW_CASES: readonly WakeWitnessCase[] = WAKE_AXES.filter(
  ({ deadline, owner, parkLabel }) =>
    deadline.label === 'untimed' && owner.live && parkLabel === 'parked',
).map(({ deadline, owner, parkLabel, park }) => ({
  label: `${deadline.label} / ${owner.label} / ${parkLabel} / queue | step_name`,
  owner,
  park,
  rows: [corruptWakeRow(deadline, ['queue']), corruptWakeRow(deadline, ['step_name'])],
  preserveSplitRowEvidence: true,
}))

export const WAKE_PAIR_CASES: readonly WakeWitnessCase[] = [
  ...WAKE_AXES.flatMap(({ deadline, owner, parkLabel, park }) =>
    WAKE_AT_STEP.flatMap((left) =>
      WAKE_AT_OTHER.map((right) => ({
        label: `${deadline.label} / ${owner.label} / ${parkLabel} / ${wakeFieldName(left)} | ${wakeFieldName(right)}`,
        owner,
        park,
        rows: [corruptWakeRow(deadline, left), corruptWakeRow(deadline, right)],
      })),
    ),
  ),
  ...WAKE_SPLIT_ROW_CASES,
  ...WAKE_LEGACY_AMBIGUITY_CASES,
]

async function wakeWitnessWrote(
  fixture: StoreFixture,
  queue: string,
  owner: WakeOwner,
  park: WakePark,
  rows: readonly WakeRow[],
  preserveSplitRowEvidence = false,
): Promise<{
  wrote: boolean
  splitRowEvidence?: {
    state: unknown
    eventPayload: unknown
    priorViolationsPreserved: boolean
    firedEventViolation: boolean
  }
}> {
  const id = queue
  await fixture.raw.batch('setup', [
    {
      sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
              max_attempts, cancellation, state, enqueue_at_ms, created_at_ms)
            VALUES (?, ?, 'job', '{}', '{"kind":"none"}', 3,
              '{"maxDurationSeconds":1}', ?, ?, ?)`,
      args: [id, queue, owner.state, WAKE_NOW, WAKE_NOW],
    },
    {
      sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claim_gen, activated_gen,
              wake_event, wake_step, available_at_ms, created_at_ms)
            VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?)`,
      args: [
        id,
        queue,
        id,
        park.state,
        park.wake_event,
        park.wake_step,
        park.available_at_ms,
        WAKE_NOW,
      ],
    },
    ...rows.map((row) => ({
      sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
              timeout_at_ms, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        row.step_name,
        row.queue === Q ? queue : row.queue,
        id,
        row.event_name,
        row.status,
        row.timeout_at_ms,
        WAKE_NOW,
      ],
    })),
  ])

  const snapshot = async (): Promise<string> => {
    const [result] = await fixture.raw.batch(
      'probe',
      [
        {
          sql: `SELECT state, available_at_ms, event_payload, wake_event, fence_stamp
                FROM runs WHERE run_id = ?`,
          args: [id],
        },
      ],
      'read',
    )
    const row = result?.rows[0]
    if (!row) throw new Error('wake witness run vanished')
    return JSON.stringify(row)
  }

  const before = await snapshot()
  const priorViolations = preserveSplitRowEvidence
    ? await engineInvariantViolations(fixture.raw)
    : undefined
  await fixture.store.emitEvent(queue, WAKE_EVENT, '{"x":1}')
  const after = await snapshot()
  if (priorViolations === undefined) return { wrote: after !== before }

  const [run] = await fixture.raw.batch(
    'split-row-evidence',
    [
      {
        sql: `SELECT state, event_payload FROM runs WHERE run_id = ?`,
        args: [id],
      },
    ],
    'read',
  )
  const currentViolations = await engineInvariantViolations(fixture.raw)
  return {
    wrote: after !== before,
    splitRowEvidence: {
      state: run?.rows[0]?.state,
      eventPayload: run?.rows[0]?.event_payload,
      priorViolationsPreserved: priorViolations.every((violation) =>
        currentViolations.includes(violation),
      ),
      firedEventViolation: currentViolations.includes(
        `wait-for-fired-event: ${id}/${WAKE_STEP}#stale`,
      ),
    },
  }
}

export async function wakeWitnessDisagreements(
  makeFixture: StoreFixtureFactory,
  cases: readonly WakeWitnessCase[],
): Promise<string[]> {
  const fixture = await makeFixture('wake-witness')
  try {
    await fixture.admin.setFakeNowEpochMs(WAKE_NOW)
    const wrong: string[] = []
    for (const [index, testCase] of cases.entries()) {
      const observation = await wakeWitnessWrote(
        fixture,
        `${Q}-wake-${index}`,
        testCase.owner,
        testCase.park,
        testCase.rows,
        testCase.preserveSplitRowEvidence,
      )
      if (observation.wrote !== shouldWake(testCase.owner, testCase.park, testCase.rows)) {
        wrong.push(`${testCase.label}: woke=${observation.wrote}`)
      }
      if (
        testCase.preserveSplitRowEvidence &&
        (observation.splitRowEvidence?.state !== 'sleeping' ||
          observation.splitRowEvidence.eventPayload !== null ||
          !observation.splitRowEvidence.priorViolationsPreserved ||
          !observation.splitRowEvidence.firedEventViolation)
      ) {
        wrong.push(
          `${testCase.label}: split-row evidence=${JSON.stringify(observation.splitRowEvidence)}`,
        )
      }
    }
    return wrong
  } finally {
    fixture.close()
  }
}

export function wakeWitnessConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`wake witness conformance [${dialect}]`, () => {
    it('decides every park through one correlated wait witness', async () => {
      expect(
        {
          single: await wakeWitnessDisagreements(makeFixture, WAKE_SINGLE_CASES),
          pairs: await wakeWitnessDisagreements(makeFixture, WAKE_PAIR_CASES),
        },
        'mutation-verdict:behavior:emit-wake-one-witness',
      ).toEqual({ single: [], pairs: [] })
    }, 30_000)
  })
}
