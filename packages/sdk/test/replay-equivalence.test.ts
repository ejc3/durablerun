import { type SchedulerStore, StoreUnavailableError } from '@durablerun/core'
import { engineInvariantViolations } from '@durablerun/conformance'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runClaimedRun, type TaskContext, type TaskRegistry } from '../src/index.js'

const Q = 'q'

/**
 * The SDK's generated fault surface — its equivalent of the store's fault
 * matrix. A task program must produce the SAME final result and the same
 * checkpoint table whether it runs straight through or is interrupted (by
 * a store failure, then lease recovery) at ANY point. Programs and values
 * are generated, not curated: the whole point is covering the case nobody
 * suspected. This harness exists because thirteen residual findings —
 * value divergence between first pass and replay chief among them — lived
 * in exactly the layer the store-scoped machinery could not reach.
 */

/** Adversarial value corpus: JSON-clean AND lossy-under-serialization. */
const VALUES: unknown[] = [
  42,
  'plain',
  { nested: { list: [1, 2, 3] } },
  null,
  [],
  Number.NaN, // JSON: null
  { date: new Date(1_700_000_000_000) }, // JSON: string
  { u: undefined, kept: 1 }, // JSON: field dropped
  -0, // JSON: 0
]

interface ProgramOp {
  kind: 'step' | 'sleep'
  valueIndex: number
  sleepSeconds?: number
}

function generateProgram(rng: Rng): ProgramOp[] {
  const length = 2 + rng.int(4)
  const ops: ProgramOp[] = []
  for (let i = 0; i < length; i++) {
    if (rng.next() < 0.25) {
      ops.push({ kind: 'sleep', valueIndex: 0, sleepSeconds: 5 + rng.int(20) })
    } else {
      ops.push({ kind: 'step', valueIndex: rng.int(VALUES.length) })
    }
  }
  ops.push({ kind: 'step', valueIndex: rng.int(VALUES.length) }) // always end with output
  return ops
}

/**
 * What user code can OBSERVE about a value — the exact discriminators that
 * differ between a live JS value and its serialize-then-parse ghost. The
 * contract under test: every pass of every schedule observes the SAME
 * thing for the same step.
 */
function fingerprint(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'number:NaN'
    if (Object.is(v, -0)) return 'number:-0'
    return `number:${v}`
  }
  if (v instanceof Date) return 'DateObject'
  if (Array.isArray(v)) return `array[${v.map(fingerprint).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const entries = Object.keys(v)
      .sort()
      .map((k) => `${k}=${fingerprint((v as Record<string, unknown>)[k])}`)
    return `object{${entries.join(',')}}`
  }
  return `${typeof v}:${String(v)}`
}

function programHandler(ops: ProgramOp[]) {
  return async (ctx: TaskContext) => {
    const observed: string[] = []
    for (const [i, op] of ops.entries()) {
      if (op.kind === 'sleep') {
        await ctx.sleepFor(op.sleepSeconds ?? 5)
      } else {
        // Deliberately reuses one name: repeat counters are under test too.
        observed.push(fingerprint(await ctx.step('op', () => VALUES[op.valueIndex])))
      }
      void i
    }
    return observed
  }
}

class PumpClock {
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

/**
 * Run one program to completion, with the Nth store call (counted across
 * the whole lifetime, 0 = no fault) failing as a transient outage; recover
 * through the normal lease machinery until the task terminates. Returns
 * the final payload and the checkpoint table.
 */
async function runProgram(
  ops: ProgramOp[],
  seed: string,
  failAtCall: number,
): Promise<{ result: string | undefined; checkpoints: unknown[] }> {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const ids = seededIdSource(new Rng(seed))
    const real = new LibsqlSchedulerStore(raw, ids)
    let calls = 0
    const store = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          if (calls === failAtCall) {
            return Promise.reject(new StoreUnavailableError('injected outage'))
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as SchedulerStore
    const clock = new PumpClock()
    await admin.setFakeNowEpochMs(clock.now)
    const registry: TaskRegistry = new Map([['prog', programHandler(ops)]])
    const spawned = await real.spawn(Q, 'prog', '{}')

    // Drive to termination: claim, pass, advance, sweep — the plain loop.
    for (let round = 0; round < 60; round++) {
      const done = await real.getTaskResult(Q, spawned.taskId)
      if (done && done.state !== 'pending' && done.state !== 'running' && done.state !== 'sleeping')
        break
      const [run] = await real.claim(Q, `w${round}`, { leaseSeconds: 60, limit: 1 })
      if (run) {
        await runClaimedRun(
          { store, clock, registry },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        ).catch(() => {})
      }
      clock.now += 70_000
      await admin.setFakeNowEpochMs(clock.now)
      await real.sweep(Q, 10)
    }
    const outcome = await real.getTaskResult(Q, spawned.taskId)
    expect(outcome?.state, `program must terminate (fault at call ${failAtCall})`).toBe('completed')
    const [cps] = await raw.batch(
      't',
      [
        {
          sql: `SELECT checkpoint_name, state FROM checkpoints ORDER BY checkpoint_name`,
          args: [],
        },
      ],
      'read',
    )
    expect(await engineInvariantViolations(raw)).toEqual([])
    return { result: outcome?.completedPayloadJson, checkpoints: cps?.rows ?? [] }
  } finally {
    raw.close()
  }
}

describe('replay equivalence (generated programs x fault points x adversarial values)', () => {
  for (let seed = 0; seed < 6; seed++) {
    it(`program ${seed}: every fault point yields the reference outcome`, async () => {
      const ops = generateProgram(new Rng(`program-${seed}`))
      const reference = await runProgram(ops, `ref-${seed}`, 0)
      // Fault every store call the reference lifetime made (bounded scan).
      for (let call = 3; call <= 24; call += 2) {
        const faulted = await runProgram(ops, `fault-${seed}-${call}`, call)
        expect(faulted.result, `fault at call ${call}`).toBe(reference.result)
        expect(faulted.checkpoints, `fault at call ${call}`).toEqual(reference.checkpoints)
      }
    }, 30_000)
  }
})
