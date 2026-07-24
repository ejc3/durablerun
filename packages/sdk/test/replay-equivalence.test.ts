import { EventTimeoutError, type SchedulerStore, StoreUnavailableError } from '@durablerun/core'
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

/**
 * The enrollment gate (events postmortem, mechanism 2): every member of
 * TaskContext must be classified here — `satisfies` makes an unclassified
 * new method a TYPE error, and the inventory test below requires every
 * 'generated' method to actually appear in the program generator. The
 * events round shipped five bugs in a method this harness never generated;
 * growing the interface without growing the surface is now unwritable.
 */
const CTX_COVERAGE = {
  step: 'generated',
  sleepFor: 'generated',
  sleepUntil: 'generated',
  awaitEvent: 'generated',
  emitEvent: 'generated',
  attempt: 'observed-property',
  taskName: 'observed-property',
} as const satisfies Record<keyof TaskContext, 'generated' | 'observed-property'>

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

/**
 * Adversarial (legal) name corpus: reserved-adjacent but valid — '$' only
 * refuses as a PREFIX, '#' refuses anywhere. 'op' repeats to keep the
 * repeat-counter machinery under pressure.
 */
const STEP_NAMES = ['op', 'op', 'a$b', 'sp ace', 'näme', '']

interface ProgramOp {
  kind:
    | 'step'
    | 'sleep'
    | 'sleep-until'
    | 'emit'
    | 'await-inline'
    | 'await-external'
    | 'await-timeout'
  valueIndex: number
  nameIndex: number
  sleepSeconds?: number
  atEpochMs?: number
  eventName?: string
  timeoutSeconds?: number
}

const KIND_TO_METHOD: Record<ProgramOp['kind'], keyof TaskContext> = {
  step: 'step',
  sleep: 'sleepFor',
  'sleep-until': 'sleepUntil',
  emit: 'emitEvent',
  'await-inline': 'awaitEvent',
  'await-external': 'awaitEvent',
  'await-timeout': 'awaitEvent',
}

function generateProgram(rng: Rng): ProgramOp[] {
  const length = 3 + rng.int(5)
  const ops: ProgramOp[] = []
  const emitted: string[] = []
  for (let i = 0; i < length; i++) {
    const roll = rng.next()
    const valueIndex = rng.int(VALUES.length)
    const nameIndex = rng.int(STEP_NAMES.length)
    if (roll < 0.14) {
      ops.push({ kind: 'sleep', valueIndex, nameIndex, sleepSeconds: 5 + rng.int(20) })
    } else if (roll < 0.22) {
      // Absolute wakes near the fake-clock base: some already past (due
      // immediately), some ahead — both legal, both deterministic.
      ops.push({
        kind: 'sleep-until',
        valueIndex,
        nameIndex,
        atEpochMs: 1_000_000 + (i + 1) * 15_000,
      })
    } else if (roll < 0.34) {
      const eventName = `ev${i}`
      emitted.push(eventName)
      ops.push({ kind: 'emit', valueIndex, nameIndex, eventName })
    } else if (roll < 0.44 && emitted.length > 0) {
      // Awaiting an event this program already emitted: the inline-hit path.
      ops.push({
        kind: 'await-inline',
        valueIndex,
        nameIndex,
        eventName: emitted[rng.int(emitted.length)] ?? 'ev0',
      })
    } else if (roll < 0.52) {
      // The park→wake path: the driver loop emits ext* names every round
      // (first-write-wins makes the repeats no-ops), so whether a schedule
      // parks first or arrives late, the await resolves to the SAME payload.
      const base = { kind: 'await-external' as const, valueIndex, nameIndex, eventName: `ext${i}` }
      ops.push(rng.next() < 0.5 ? { ...base, timeoutSeconds: 120 } : base)
    } else if (roll < 0.58) {
      // Nothing ever emits never*: the timeout wake is the only exit.
      ops.push({
        kind: 'await-timeout',
        valueIndex,
        nameIndex,
        eventName: `never${i}`,
        timeoutSeconds: 20,
      })
    } else {
      ops.push({ kind: 'step', valueIndex, nameIndex })
    }
  }
  ops.push({ kind: 'step', valueIndex: rng.int(VALUES.length), nameIndex: 0 }) // always end with output
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
    for (const op of ops) {
      switch (op.kind) {
        case 'sleep':
          await ctx.sleepFor(op.sleepSeconds ?? 5)
          break
        case 'sleep-until':
          await ctx.sleepUntil(op.atEpochMs ?? 1_000_000)
          break
        case 'emit':
          await ctx.emitEvent(
            op.eventName as string,
            JSON.stringify(VALUES[op.valueIndex]) ?? 'null',
          )
          break
        case 'await-inline':
        case 'await-external': {
          const payload = await ctx.awaitEvent(
            op.eventName as string,
            op.timeoutSeconds !== undefined ? { timeoutSeconds: op.timeoutSeconds } : undefined,
          )
          observed.push(`ev:${op.eventName}:${payload}`)
          break
        }
        case 'await-timeout':
          try {
            await ctx.awaitEvent(op.eventName as string, {
              timeoutSeconds: op.timeoutSeconds ?? 20,
            })
            observed.push(`unexpected-delivery:${op.eventName}`)
          } catch (error) {
            if (!(error instanceof EventTimeoutError)) throw error
            observed.push(`timeout:${op.eventName}`)
          }
          break
        case 'step':
          observed.push(
            fingerprint(
              await ctx.step(STEP_NAMES[op.nameIndex] ?? 'op', () => VALUES[op.valueIndex]),
            ),
          )
          break
      }
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
    const externals = ops
      .filter((op) => op.kind === 'await-external')
      .map((op) => op.eventName as string)

    // Drive to termination: claim, pass, advance, sweep — the plain loop.
    for (let round = 0; round < 60; round++) {
      const done = await real.getTaskResult(Q, spawned.taskId)
      if (done && done.state !== 'pending' && done.state !== 'running' && done.state !== 'sleeping')
        break
      // External wakes, delivered on a fixed cadence from round 2 on:
      // first-write-wins makes the re-emits no-ops, so EVERY schedule sees
      // the same payload whether its await parked early or arrived late.
      if (round >= 2) {
        for (const name of externals) {
          await real.emitEvent(Q, name, JSON.stringify({ ext: name }))
        }
      }
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

describe('context-method enrollment (the inventory gate)', () => {
  it('every generated-classified method appears in the program generator', () => {
    const generatedMethods = new Set(Object.values(KIND_TO_METHOD))
    const classified = new Set(
      (Object.keys(CTX_COVERAGE) as (keyof typeof CTX_COVERAGE)[]).filter(
        (k) => CTX_COVERAGE[k] === 'generated',
      ),
    )
    expect([...classified].sort()).toEqual([...generatedMethods].sort())
  })

  it('every op kind is actually reachable by generation (no dead weights)', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 300; seed++) {
      for (const op of generateProgram(new Rng(`inventory-${seed}`))) seen.add(op.kind)
    }
    expect([...seen].sort()).toEqual((Object.keys(KIND_TO_METHOD) as string[]).sort())
  })
})

describe('replay equivalence (generated programs x fault points x adversarial values)', () => {
  for (let seed = 0; seed < 6; seed++) {
    it(`program ${seed}: every fault point yields the reference outcome`, async () => {
      const ops = generateProgram(new Rng(`program-${seed}`))
      const reference = await runProgram(ops, `ref-${seed}`, 0)
      // Fault every store call the reference lifetime made (bounded scan).
      for (let call = 3; call <= 28; call += 2) {
        const faulted = await runProgram(ops, `fault-${seed}-${call}`, call)
        expect(faulted.result, `fault at call ${call}`).toBe(reference.result)
        expect(faulted.checkpoints, `fault at call ${call}`).toEqual(reference.checkpoints)
      }
    }, 60_000)
  }
})
