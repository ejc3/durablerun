import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runClaimedRun, type TaskContext, type TaskRegistry } from '../src/index.js'

const Q = 'q'

/**
 * The user-boundary contract, enumerated per context method: a
 * deterministic bad input (reserved name, invalid knob) fails the task
 * PERMANENTLY on its first attempt — never a retry loop, never a park.
 * The classification lives at one chokepoint (core's user* validators and
 * UserName.parse), and this table is its executable enumeration: a new
 * context method that takes a name or a knob adds its rows here.
 */
const INVALID_CALLS: { title: string; call: (ctx: TaskContext) => Promise<unknown> }[] = [
  { title: "step name '#x'", call: (ctx) => ctx.step('#x', () => 1) },
  { title: "step name 'a#b'", call: (ctx) => ctx.step('a#b', () => 1) },
  { title: "step name '$x'", call: (ctx) => ctx.step('$x', () => 1) },
  { title: "awaitEvent name 'x#y'", call: (ctx) => ctx.awaitEvent('x#y') },
  { title: "awaitEvent name '$go'", call: (ctx) => ctx.awaitEvent('$go') },
  { title: "emitEvent name 'x#y'", call: (ctx) => ctx.emitEvent('x#y', '{}') },
  { title: "emitEvent name '$go'", call: (ctx) => ctx.emitEvent('$go', '{}') },
  {
    title: 'awaitEvent timeout NaN',
    call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: Number.NaN }),
  },
  { title: 'awaitEvent timeout -1', call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: -1 }) },
  { title: 'awaitEvent timeout 0', call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: 0 }) },
  {
    title: 'awaitEvent timeout Infinity',
    call: (ctx) => ctx.awaitEvent('go', { timeoutSeconds: Number.POSITIVE_INFINITY }),
  },
  { title: 'sleepFor NaN', call: (ctx) => ctx.sleepFor(Number.NaN) },
  { title: 'sleepFor -1', call: (ctx) => ctx.sleepFor(-1) },
  { title: 'sleepFor Infinity', call: (ctx) => ctx.sleepFor(Number.POSITIVE_INFINITY) },
  { title: 'sleepUntil NaN', call: (ctx) => ctx.sleepUntil(Number.NaN) },
  { title: 'sleepUntil fractional', call: (ctx) => ctx.sleepUntil(1.5) },
  { title: 'sleepUntil -1', call: (ctx) => ctx.sleepUntil(-1) },
]

class OneShotClock {
  now = 1_000_000
  nowEpochMs(): number {
    return this.now
  }
  yieldTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }
  sleep(_ms: number, interrupt?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (interrupt?.aborted) return resolve()
      interrupt?.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}

describe('user-boundary: every invalid context input fails permanently at attempt 1', () => {
  for (const { title, call } of INVALID_CALLS) {
    it(title, async () => {
      const raw = LibsqlExecutor.open(':memory:')
      try {
        const admin = new LibsqlStoreAdmin(raw)
        await admin.migrate()
        await admin.setFakeNowEpochMs(1_000_000)
        const store = new LibsqlSchedulerStore(raw, seededIdSource(new Rng(`ub-${title}`)))
        const registry: TaskRegistry = new Map([['bad', (ctx: TaskContext) => call(ctx)]])
        const spawned = await store.spawn(Q, 'bad', '{}', { maxAttempts: 5 })
        const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
        expect(run).toBeDefined()
        if (!run) return
        await runClaimedRun(
          { store, clock: new OneShotClock(), registry },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        )
        const result = await store.getTaskResult(Q, spawned.taskId)
        // Permanent: terminal despite maxAttempts 5, on the first attempt.
        expect(result?.state).toBe('failed')
        const [tasks] = await raw.batch(
          't',
          [{ sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] }],
          'read',
        )
        expect(tasks?.rows[0]?.attempts).toBe(1)
      } finally {
        raw.close()
      }
    })
  }
})
