import { LaunchOutcome, systemClock } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it, vi } from 'vitest'
import { inlineLauncher, inlineTick } from '../src/index.js'

const Q = 'inline'

async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  await admin.setFakeNowEpochMs(1_000_000)
  return { raw, ids, store, clock: systemClock(), close: () => raw.close() }
}

describe('inline worker composition', () => {
  it('runs a claimed invocation through runClaimedRun and returns an opaque ending', async () => {
    const f = await fx('inline-launcher')
    try {
      const spawned = await f.store.spawn(Q, 'job', '{"input":1}')
      const [run] = await f.store.claim(Q, 'claim-token', { leaseSeconds: 60, limit: 1 })
      if (run === undefined) throw new Error('test setup did not claim its run')
      const handler = vi.fn(async () => ({ ok: true }))
      const outcomes: string[] = []
      const launcher = inlineLauncher(
        { store: f.store, clock: f.clock, registry: new Map([['job', handler]]) },
        { onOutcome: (outcome) => outcomes.push(outcome.kind) },
      )
      const invocation = {
        queue: Q,
        runId: run.runId,
        attempt: run.attempt,
        claimToken: run.claimToken,
        claimGen: run.claimGen,
        deadlineHintEpochMs: run.claimExpiresAtEpochMs,
      }

      const first = await launcher.launch(invocation)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(outcomes).toEqual(['completed'])
      expect(Object.keys(first)).toEqual([])
      expect((first as unknown as { kind?: unknown }).kind).toBeUndefined()
      expect(Object.isFrozen(first)).toBe(true)
      await expect(LaunchOutcome.reconcile(f.store, Q, run, first)).resolves.toBe('ended')
      await expect(f.store.getTaskResult(Q, spawned.taskId)).resolves.toMatchObject({
        state: 'completed',
        completedPayloadJson: '{"ok":true}',
      })

      // A duplicate delivery still performs one runtime pass for that
      // invocation, whose activation gate classifies it as superseded; user
      // code never runs twice.
      const duplicate = await launcher.launch(invocation)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(outcomes).toEqual(['completed', 'superseded'])
      await expect(LaunchOutcome.reconcile(f.store, Q, run, duplicate)).resolves.toBe('ended')
    } finally {
      f.close()
    }
  })

  it('owns one slot per tick invocation and does not detach the worker pass', async () => {
    const f = await fx('inline-one-slot')
    try {
      await f.store.spawn(Q, 'job', '{"ordinal":1}')
      await f.store.spawn(Q, 'job', '{"ordinal":2}')
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let started: (() => void) | undefined
      const workerStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const handler = vi.fn(async () => {
        started?.()
        await gate
        return 'done'
      })

      let settled = false
      const pending = inlineTick(
        {
          store: f.store,
          ids: f.ids,
          clock: f.clock,
          registry: new Map([['job', handler]]),
        },
        { queue: Q, sweepLimit: 10, leaseSeconds: 60 },
      ).finally(() => {
        settled = true
      })
      await workerStarted
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(handler).toHaveBeenCalledTimes(1)

      release?.()
      await expect(pending).resolves.toMatchObject({
        claimed: 1,
        ended: 1,
        launched: 0,
        launchFailed: 0,
        backlog: true,
        workerOutcome: { kind: 'completed' },
      })

      const [tasks] = await f.raw.batch('inline:test-task-counts', [
        {
          sql: `SELECT state, COUNT(*) AS total
                FROM tasks WHERE queue = ? GROUP BY state ORDER BY state`,
          args: [Q],
        },
      ])
      expect(tasks?.rows).toEqual([
        { state: 'completed', total: 1 },
        { state: 'pending', total: 1 },
      ])
    } finally {
      f.close()
    }
  })
})
