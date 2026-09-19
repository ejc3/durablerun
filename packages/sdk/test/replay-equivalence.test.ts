import {
  childTaskViolations,
  engineInvariantViolations,
  sagaViolations,
} from '@durablerun/conformance'
import {
  EventTimeoutError,
  FatalTaskError,
  IDENTIFIER_CHARACTERS,
  type IdSource,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  StoreUnavailableError,
  childSpawnKey,
} from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { type ChildTask, type TaskContext, type TaskRegistry, runClaimedRun } from '../src/index.js'

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
  spawn: 'generated',
  awaitTask: 'generated',
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
  undefined, // JSON: top-level task result is pinned to null
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
    | 'spawn'
    | 'await-child'
    | 'await-child-timeout'
  valueIndex: number
  nameIndex: number
  sleepSeconds?: number
  atEpochMs?: number
  eventName?: string
  timeoutSeconds?: number
  /** A spawned child fails for good when set, so the parent reads a failed outcome. */
  childFails?: boolean
  /** Which of the program's spawned children an await-child awaits, in spawn order. */
  childIndex?: number
  /** The name-length axis: the step name or the child's task name, in place of the corpus's. */
  name?: string
  /** The name-length axis: a step that registers a rollback, so its key must leave its saga names room. */
  registersRollback?: boolean
  /** The name-length axis: a spawn whose child's task id has this many characters. */
  childIdLength?: number
}

const KIND_TO_METHOD: Record<ProgramOp['kind'], keyof TaskContext> = {
  step: 'step',
  sleep: 'sleepFor',
  'sleep-until': 'sleepUntil',
  emit: 'emitEvent',
  'await-inline': 'awaitEvent',
  'await-external': 'awaitEvent',
  'await-timeout': 'awaitEvent',
  spawn: 'spawn',
  'await-child': 'awaitTask',
  'await-child-timeout': 'awaitTask',
}

function generateProgram(rng: Rng): ProgramOp[] {
  const length = 3 + rng.int(5)
  const ops: ProgramOp[] = []
  const emitted: string[] = []
  let spawned = 0
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
      // (first-write-wins keeps the stored payload unchanged), so whether a
      // schedule parks first or arrives late, the await resolves to the SAME
      // payload even if delivery provenance refreshes.
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
    } else if (roll < 0.68) {
      // A child that completes with an adversarial value, or fails for good. Either
      // way it ends, so an untimed await of it resolves on every schedule.
      ops.push({ kind: 'spawn', valueIndex, nameIndex, childFails: rng.next() < 0.3 })
      spawned++
    } else if (roll < 0.76 && spawned > 0) {
      // Untimed on purpose: a fault can delay the child past any timeout, and then
      // the faulted schedule would time out where the reference did not.
      ops.push({ kind: 'await-child', valueIndex, nameIndex, childIndex: rng.int(spawned) })
    } else if (roll < 0.8) {
      // A child that sleeps past the end of every schedule: the timeout is the only exit.
      ops.push({ kind: 'await-child-timeout', valueIndex, nameIndex, timeoutSeconds: 20 })
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

function programHandler(ops: ProgramOp[], watch?: Watch) {
  return async (ctx: TaskContext) => {
    const observed: string[] = []
    const children: ChildTask[] = []
    for (const [index, op] of ops.entries()) {
      watch?.trace.push(`op ${index}`)
      switch (op.kind) {
        case 'spawn':
          children.push(
            await ctx.spawn(op.name ?? 'child', {
              valueIndex: op.valueIndex,
              fails: op.childFails === true,
            }),
          )
          break
        case 'await-child': {
          const child = children[op.childIndex ?? 0]
          if (child === undefined)
            throw new FatalTaskError('the generator awaited an unspawned child')
          const outcome = await ctx.awaitTask(child)
          observed.push(
            `child:${outcome.state}:${outcome.completedPayloadJson ?? outcome.failureReasonJson}`,
          )
          break
        }
        case 'await-child-timeout': {
          const stuck = await ctx.spawn('stuck', null)
          try {
            await ctx.awaitTask(stuck, { timeoutSeconds: op.timeoutSeconds ?? 20 })
            observed.push('unexpected-child-outcome')
          } catch (error) {
            if (!(error instanceof EventTimeoutError)) throw error
            observed.push('child-timeout')
          }
          break
        }
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
              await ctx.step(
                op.name ?? STEP_NAMES[op.nameIndex] ?? 'op',
                () => {
                  watch?.bodies.push(index)
                  return VALUES[op.valueIndex]
                },
                op.registersRollback ? { rollback: () => {} } : undefined,
              ),
            ),
          )
          break
      }
    }
    return observed
  }
}

/** A child ends with an adversarial value or fails for good, and checkpoints nothing. */
async function childHandler(_ctx: TaskContext, params: unknown): Promise<unknown> {
  const { valueIndex, fails } = params as { valueIndex: number; fails: boolean }
  if (fails) throw new FatalTaskError('child boom')
  return VALUES[valueIndex]
}

/** Sleeps past the end of every schedule, so an await of it can only time out. */
async function stuckHandler(ctx: TaskContext): Promise<unknown> {
  await ctx.sleepFor(1_000_000)
  return null
}

/**
 * Task ids come from a seeded id source, and the reference and each faulted run use
 * different seeds and consume ids differently. A spawn's memo holds its child's id and
 * a child await's key embeds it, so ids are replaced by the child's spawn order, which
 * is the same on every schedule.
 */
function withoutChildIds(rows: { checkpoint_name: unknown; state: unknown }[]): unknown[] {
  const spawns = rows
    .filter((row) => String(row.checkpoint_name).startsWith('$spawn:'))
    .map((row) => ({ name: String(row.checkpoint_name), state: String(row.state) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const ids = spawns.map((row) => (JSON.parse(row.state) as { taskId: string }).taskId)
  const normalize = (text: string): string =>
    ids.reduce((out, id, index) => out.replaceAll(id, `child-${index}`), text)
  return rows
    .map((row) => ({
      checkpoint_name: normalize(String(row.checkpoint_name)),
      state: normalize(String(row.state)),
    }))
    .sort((left, right) =>
      left.checkpoint_name < right.checkpoint_name
        ? -1
        : left.checkpoint_name > right.checkpoint_name
          ? 1
          : 0,
    )
}

/**
 * Run one program to completion, with the Nth store call (counted across
 * the whole lifetime, 0 = no fault) failing as a transient outage; recover
 * through the normal lease machinery until the task terminates. Returns
 * the final payload and the checkpoint table.
 */
/**
 * The store calls a fault is injected at: a bounded sample of a program's calls. It is
 * derived from the call count the reference run measured, and it always ends at the
 * last call, where the parent's final checkpoint and its completion are.
 */
function faultPoints(measuredCalls: number): number[] {
  const points: number[] = []
  for (let call = 3; call < measuredCalls; call += 2) points.push(call)
  points.push(measuredCalls)
  return points
}

/**
 * What one run is watched for, beside what it returns. It is kept out of the returned
 * record on purpose: that record is compared whole between two schedules, and how often a
 * body ran or a call was made differs between schedules for reasons that are no defect.
 */
interface Watch {
  /**
   * What the task did, in order: `attempt` as a worker takes the run, `op N` as the task
   * starts its Nth call, and every store call the SDK makes in between, by method.
   */
  readonly trace: string[]
  /** The index of every step whose body ran, once for each time it ran. */
  readonly bodies: number[]
  /** The user attempts the task was charged. */
  attempts?: number
}

interface RunOptions {
  readonly tamper?: (store: SchedulerStore) => SchedulerStore
  /** Every generated program completes. A name past its room fails its task for good. */
  readonly ends?: 'completed' | 'failed'
  readonly watch?: Watch
}

async function runProgram(
  ops: ProgramOp[],
  seed: string,
  failAtCall: number,
  options: RunOptions = {},
): Promise<{
  result: string | undefined
  state: string | undefined
  failure: string | undefined
  checkpoints: unknown[]
  /** How many tasks of each name exist at the end: a second child is a second row here. */
  tasks: string[]
  /** The longest checkpoint name and the longest task id the run left, in characters. */
  longestCheckpointName: number
  longestTaskId: number
  calls: number
}> {
  const { tamper = (store: SchedulerStore) => store, ends = 'completed', watch } = options
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    // A child's id is the engine's, so a child await has a key near the width only when the
    // engine mints a long id. A store's spawn mints the task's id first and before it
    // awaits anything, so the first id minted inside the spawn of such a child is padded.
    const seeded = seededIdSource(new Rng(seed))
    const longChildren = new Map(
      ops.flatMap((op) =>
        op.kind === 'spawn' && op.childIdLength !== undefined
          ? [[op.name ?? 'child', op.childIdLength] as const]
          : [],
      ),
    )
    let padNextIdTo: number | undefined
    const ids: IdSource = {
      token: () => seeded.token(),
      uuidv7: () => {
        const id = seeded.uuidv7()
        const length = padNextIdTo
        padNextIdTo = undefined
        return length === undefined ? id : id.padEnd(length, 'x')
      },
    }
    const real = new LibsqlSchedulerStore(raw, ids)
    let calls = 0
    // True while a worker runs the task, so the trace holds the SDK's calls and not this loop's.
    let inRun = false
    const store = new Proxy(tamper(real), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          if (inRun) watch?.trace.push(String(prop))
          if (calls === failAtCall) {
            return Promise.reject(new StoreUnavailableError('injected outage'))
          }
          if (prop === 'spawn') padNextIdTo = longChildren.get(String(args[1]))
          try {
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          } finally {
            padNextIdTo = undefined
          }
        }
      },
    }) as SchedulerStore
    const clock = new FakeClock()
    await admin.setFakeNowEpochMs(clock.now)
    const registry: TaskRegistry = new Map([
      ['prog', programHandler(ops, watch)],
      ['child', childHandler],
      ['stuck', stuckHandler],
      ...ops.flatMap((op) =>
        op.kind === 'spawn' && op.name !== undefined ? [[op.name, childHandler] as const] : [],
      ),
    ])
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
      // first-write-wins keeps the stored payload unchanged, so EVERY schedule
      // sees the same result whether its await parked early or arrived late,
      // even though a re-emit may refresh delivery provenance.
      if (round >= 2) {
        for (const name of externals) {
          await real.emitEvent(Q, name, JSON.stringify({ ext: name }))
        }
      }
      const [run] = await real.claim(Q, `w${round}`, { leaseSeconds: 60, limit: 1 })
      if (run) {
        watch?.trace.push('attempt')
        inRun = true
        await runClaimedRun(
          { store, clock, registry },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        ).catch(() => {})
        inRun = false
      }
      // Moves time without firing sleeps: the pump parks until its pass ends.
      clock.advance(70_000)
      await admin.setFakeNowEpochMs(clock.now)
      await real.sweep(Q, 10)
    }
    const outcome = await real.getTaskResult(Q, spawned.taskId)
    expect(outcome?.state, `program must terminate (fault at call ${failAtCall})`).toBe(ends)
    const [cps] = await raw.batch(
      't',
      [
        {
          sql: `SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ?
                ORDER BY checkpoint_name`,
          args: [spawned.taskId],
        },
      ],
      'read',
    )
    expect(await engineInvariantViolations(raw)).toEqual([])
    expect(await childTaskViolations(raw)).toEqual([])
    const [counted] = await raw.batch(
      't',
      [
        {
          sql: 'SELECT task_name, COUNT(*) AS n FROM tasks GROUP BY task_name ORDER BY task_name',
          args: [],
        },
      ],
      'read',
    )
    const [measured] = await raw.batch(
      't',
      [
        {
          sql: `SELECT (SELECT MAX(LENGTH(task_id)) FROM tasks) AS id_width,
                       (SELECT attempts FROM tasks WHERE task_id = ?) AS attempts`,
          args: [spawned.taskId],
        },
      ],
      'read',
    )
    if (watch !== undefined) watch.attempts = Number(measured?.rows[0]?.attempts)
    return {
      calls,
      tasks: (counted?.rows ?? []).map((row) => `${String(row.task_name)} x ${Number(row.n)}`),
      result: outcome?.completedPayloadJson,
      state: outcome?.state,
      failure: outcome?.failureReasonJson,
      longestCheckpointName: Math.max(
        0,
        ...(cps?.rows ?? []).map((row) => [...String(row.checkpoint_name)].length),
      ),
      longestTaskId: Number(measured?.rows[0]?.id_width),
      checkpoints: withoutChildIds(
        (cps?.rows ?? []) as { checkpoint_name: unknown; state: unknown }[],
      ),
    }
  } finally {
    raw.close()
  }
}

/**
 * The harness's one comparison: a program interrupted at any sampled store call ends as its
 * reference run did. It answers the reference, so a caller can say more about it.
 */
async function everyFaultPointYieldsTheReference(
  label: string,
  run: (seed: string, failAtCall: number) => ReturnType<typeof runProgram>,
): ReturnType<typeof runProgram> {
  const reference = await run(`ref-${label}`, 0)
  for (const call of faultPoints(reference.calls)) {
    const faulted = await run(`fault-${label}-${call}`, call)
    expect(faulted.result, `fault at call ${call}`).toBe(reference.result)
    expect(faulted.state, `fault at call ${call}`).toBe(reference.state)
    expect(faulted.failure, `fault at call ${call}`).toBe(reference.failure)
    expect(faulted.checkpoints, `fault at call ${call}`).toEqual(reference.checkpoints)
    expect(faulted.tasks, `fault at call ${call}`).toEqual(reference.tasks)
  }
  return reference
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

describe('the harness itself (a comparison nobody has seen fail proves nothing)', () => {
  const SPAWNS_ONE_CHILD: ProgramOp[] = [
    { kind: 'spawn', valueIndex: 0, nameIndex: 0 },
    { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 0 },
    { kind: 'step', valueIndex: 0, nameIndex: 0 },
  ]

  /** A store whose spawn forgets the child's key, so a replayed spawn makes a second child. */
  const forgetsTheChildKey = (store: SchedulerStore): SchedulerStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'spawn') return typeof value === 'function' ? value.bind(target) : value
        return (queue: string, taskName: string, paramsJson: string) =>
          target.spawn(queue, taskName, paramsJson)
      },
    })

  it('sees a duplicated child', async () => {
    const reference = await runProgram(SPAWNS_ONE_CHILD, 'dup-ref', 0)
    // The fault lands on the spawn's checkpoint, so the next pass spawns again.
    const duplicated = await runProgram(SPAWNS_ONE_CHILD, 'dup-fault', 5, {
      tamper: forgetsTheChildKey,
    })
    expect(
      JSON.stringify(duplicated) === JSON.stringify({ ...reference, calls: duplicated.calls }),
      'mutation-verdict:behavior:replay-harness-counts-tasks',
    ).toBe(false)
  })

  it('faults every program through its last store call', async () => {
    const uncovered: string[] = []
    for (let seed = 0; seed < 6; seed++) {
      const ops = generateProgram(new Rng(`program-${seed}`))
      const { calls } = await runProgram(ops, `window-${seed}`, 0)
      const last = Math.max(...faultPoints(calls))
      if (last !== calls) uncovered.push(`program ${seed}: ${calls} calls, faulted through ${last}`)
    }
    expect(uncovered, 'mutation-verdict:behavior:replay-harness-window-is-measured').toEqual([])
  }, 60_000)
})

describe('replay equivalence (generated programs x fault points x adversarial values)', () => {
  for (let seed = 0; seed < 6; seed++) {
    it(`program ${seed}: every fault point yields the reference outcome`, async () => {
      const ops = generateProgram(new Rng(`program-${seed}`))
      await everyFaultPointYieldsTheReference(String(seed), (runSeed, failAtCall) =>
        runProgram(ops, runSeed, failAtCall),
      )
    }, 60_000)
  }
})

/**
 * The name-length axis. A durable identifier holds 255 characters (DESIGN.md §3.4 rule 10),
 * and the SDK stores a task's names under keys that are longer than the names, so a name
 * that fits can have a key that does not. The corpus above draws every name from six short
 * ones, so no generated program built a key near the width, and a refusal that depends on a
 * name's length was met by no generated program. Every call that passes a name therefore
 * runs here with a name one character under its room, at its room, and one past it.
 *
 * A call's room is never typed. Each member says what the longest durable name built from a
 * name is, and its room is what that leaves of the width.
 */
type GeneratedMethod = {
  [Method in keyof typeof CTX_COVERAGE]: (typeof CTX_COVERAGE)[Method] extends 'generated'
    ? Method
    : never
}[keyof typeof CTX_COVERAGE]

/** Every generated method says which members pass a name through it. A new method must too. */
const NAMED_CALLS = {
  step: ['step', 'step used twice', 'step that registers a rollback'],
  sleepFor: 'takes no name',
  sleepUntil: 'takes no name',
  awaitEvent: ['awaitEvent'],
  emitEvent: ['emitEvent'],
  spawn: ['spawn'],
  awaitTask: ['awaitTask'],
} as const satisfies Record<GeneratedMethod, readonly string[] | 'takes no name'>

/** A task id as this harness mints one. A stored child key holds its parent's id, by length. */
const SAMPLE_TASK_ID = seededIdSource(new Rng('name-length-axis')).uuidv7()

interface NamedCall {
  readonly id: string
  /** The longest durable name the engine builds from `name`. */
  longest(name: string): string
  /** The longest checkpoint name a program that completes leaves, when the call leaves one. */
  stored?(name: string): string
  /** The calls that pass the name. A name past its room is refused at the last of them. */
  ops(name: string): ProgramOp[]
  /** What the failure names, which is what the task passed. */
  readonly names: string
  /**
   * The store calls the SDK makes for the refused call. There are none, except that a
   * child's task name is held by the store, which builds the longer child key: DESIGN.md's
   * one exception to a key being refused before any store call.
   */
  readonly reaches: readonly string[]
  /** The longest task id the run leaves: a harness id, or the long id an awaited child has. */
  taskIdLength?(name: string): number
}

const namedStep = (name: string, registersRollback = false): ProgramOp => ({
  kind: 'step',
  valueIndex: 0,
  nameIndex: 0,
  name,
  ...(registersRollback ? { registersRollback } : {}),
})

const NAME_AXIS: readonly NamedCall[] = [
  {
    id: 'step',
    longest: (name) => name,
    stored: (name) => name,
    ops: (name) => [namedStep(name)],
    names: 'step name',
    reaches: [],
  },
  {
    // The second use of a name is stored under a counter, which the name's own length hides.
    id: 'step used twice',
    longest: (name) => `${name}#2`,
    stored: (name) => `${name}#2`,
    ops: (name) => [namedStep(name), namedStep(name)],
    names: 'step name',
    reaches: [],
  },
  {
    // A registered step's key must leave room for the longest of its saga names.
    id: 'step that registers a rollback',
    longest: (name) => `${SAGA_TRIES_PREFIX}${name}`,
    stored: (name) => `${SAGA_STARTED_PREFIX}${name}`,
    ops: (name) => [namedStep(name, true)],
    names: 'step name',
    reaches: [],
  },
  {
    // The parked path, so the wait and the wake it carries hold the key as well as the memo.
    id: 'awaitEvent',
    longest: (name) => `$await:${name}`,
    stored: (name) => `$await:${name}`,
    ops: (name) => [{ kind: 'await-external', valueIndex: 0, nameIndex: 0, eventName: name }],
    names: 'event name',
    reaches: [],
  },
  {
    // An emit has no key. The name itself is what is stored.
    id: 'emitEvent',
    longest: (name) => name,
    ops: (name) => [{ kind: 'emit', valueIndex: 0, nameIndex: 0, eventName: name }],
    names: 'event name',
    reaches: [],
  },
  {
    id: 'spawn',
    longest: (name) => childSpawnKey(SAMPLE_TASK_ID, `$spawn:${name}`),
    stored: (name) => `$spawn:${name}`,
    ops: (name) => [{ kind: 'spawn', valueIndex: 0, nameIndex: 0, name }],
    names: "ctx.spawn('",
    reaches: ['spawn'],
  },
  {
    // The name here is the child's id, which is the engine's, so the axis asks for its length.
    id: 'awaitTask',
    longest: (id) => `$await-task:${id}`,
    stored: (id) => `$await-task:${id}`,
    ops: (id) => [
      { kind: 'spawn', valueIndex: 0, nameIndex: 0, childIdLength: id.length },
      { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 0 },
    ],
    names: 'child task id',
    reaches: [],
    taskIdLength: (id) => id.length,
  },
]

const PLAIN_STEP: ProgramOp = { kind: 'step', valueIndex: 0, nameIndex: 0 }

/** What each attempt did after it started the call at `marker`: one list for each such attempt. */
function callsAfter(trace: readonly string[], marker: string): string[][] {
  const attempts: string[][] = []
  let open: string[] | undefined
  for (const entry of trace) {
    if (entry === 'attempt') {
      open = undefined
    } else if (entry === marker) {
      open = []
      attempts.push(open)
    } else {
      open?.push(entry)
    }
  }
  return attempts
}

describe('the name-length axis (every call that passes a name: under its room, at it, and past it)', () => {
  it('has a member for every generated call that passes a name', () => {
    const owed = Object.values(NAMED_CALLS).flatMap((members) =>
      members === 'takes no name' ? [] : [...members],
    )
    expect(NAME_AXIS.map((call) => call.id).sort()).toEqual([...owed].sort())
  })

  for (const call of NAME_AXIS) {
    const room = IDENTIFIER_CHARACTERS - [...call.longest('')].length

    it(`${call.id}: a name under its room and at it replays like any other, and one past it fails the task for good with nothing stored`, async () => {
      for (const length of [room - 1, room]) {
        const name = 'n'.repeat(length)
        const reference = await everyFaultPointYieldsTheReference(
          `${call.id}-${length}`,
          (seed, failAtCall) => runProgram([...call.ops(name), PLAIN_STEP], seed, failAtCall),
        )
        // The run really built what the member says it builds, at the length it says.
        expect(
          {
            longestName: [...call.longest(name)].length,
            longestCheckpointName: reference.longestCheckpointName,
            longestTaskId: reference.longestTaskId,
          },
          `a name of ${length}`,
        ).toEqual({
          longestName: IDENTIFIER_CHARACTERS - (room - length),
          longestCheckpointName:
            call.stored === undefined
              ? reference.longestCheckpointName
              : [...call.stored(name)].length,
          longestTaskId: call.taskIdLength?.(name) ?? SAMPLE_TASK_ID.length,
        })
      }

      const name = 'n'.repeat(room + 1)
      const ops = [PLAIN_STEP, ...call.ops(name), PLAIN_STEP]
      const refusedAt = ops.length - 2
      const reference = await everyFaultPointYieldsTheReference(
        `${call.id}-past`,
        async (seed, failAtCall) => {
          const watch: Watch = { trace: [], bodies: [] }
          const run = await runProgram(ops, seed, failAtCall, { ends: 'failed', watch })
          // On every schedule: no body at or after the refused call ran. Every attempt that
          // started the refused call then made the store calls the member names and recorded
          // the failure, and nothing else: an attempt the injected outage cut short made the
          // first of those only. The task was charged one attempt, so nothing was retried.
          const thenCalled = [...call.reaches, 'fail']
          const after = callsAfter(watch.trace, `op ${refusedAt}`)
          expect(
            {
              ranAtOrAfterTheRefusedCall: watch.bodies.filter((index) => index >= refusedAt),
              calledAnythingElse: after.filter((calls) =>
                calls.some((made, at) => made !== thenCalled[at]),
              ),
              lastAttempt: after.at(-1),
              attempts: watch.attempts,
            },
            `fault at call ${failAtCall}`,
          ).toEqual({
            ranAtOrAfterTheRefusedCall: [],
            calledAnythingElse: [],
            lastAttempt: thenCalled,
            attempts: 1,
          })
          return run
        },
      )
      const failure = JSON.parse(reference.failure ?? 'null') as {
        name?: string
        message?: string
      } | null
      expect({
        name: failure?.name,
        namesWhatTheTaskPassed: failure?.message?.includes(call.names),
      }).toEqual({ name: 'FatalTaskError', namesWhatTheTaskPassed: true })
    }, 60_000)
  }
})

/**
 * Sagas (DESIGN.md §3.10, specs/Sagas.tla). A generated program registers rollbacks,
 * fails for good, and is rolled back, and the same harness rule holds across the whole
 * of it: interrupted at ANY store call, in the forward phase or in a rollback pass, the
 * task ends in the same state with the same checkpoint table. On top of that, what only a
 * saga owes: every rollback owed ran, in reverse order of step start, and is recorded
 * exactly once. A rollback's handler runs at least once for each time it commits, so under
 * a fault its effect may repeat, and the record may not.
 */
interface SagaOp {
  kind: 'step' | 'registered' | 'sleep' | 'emit'
  nameIndex: number
  valueIndex: number
  /** A registered step whose rollback can never succeed halts the saga there. */
  rollbackAlwaysFails?: boolean
}

interface SagaProgram {
  ops: SagaOp[]
  /** The op whose body fails for good, or `ops.length` for a failure after every op. */
  failsAt: number
}

function generateSagaProgram(rng: Rng): SagaProgram {
  const length = 3 + rng.int(4)
  const ops: SagaOp[] = []
  for (let i = 0; i < length; i++) {
    const roll = rng.next()
    const base = { nameIndex: rng.int(STEP_NAMES.length), valueIndex: rng.int(VALUES.length) }
    if (roll < 0.55)
      ops.push({ ...base, kind: 'registered', rollbackAlwaysFails: rng.next() < 0.15 })
    else if (roll < 0.75) ops.push({ ...base, kind: 'step' })
    else if (roll < 0.9) ops.push({ ...base, kind: 'sleep' })
    else ops.push({ ...base, kind: 'emit' })
  }
  // Every program has a rollback to run, and half of them fail inside a step's body, so
  // a step that started and never persisted is rolled back too.
  if (!ops.some((op) => op.kind === 'registered')) {
    ops[0] = { kind: 'registered', nameIndex: 0, valueIndex: 0 }
  }
  const bodies = ops.flatMap((op, i) => (op.kind === 'registered' || op.kind === 'step' ? [i] : []))
  const failsAt = rng.next() < 0.5 ? ops.length : (bodies[rng.int(bodies.length)] ?? ops.length)
  return { ops, failsAt }
}

/** What the world outside the store saw: bodies that ran, and rollbacks that ran or failed. */
interface SagaEffects {
  log: string[]
  handed: Record<number, string>
}

function sagaHandler(program: SagaProgram, effects: SagaEffects) {
  return async (ctx: TaskContext) => {
    for (const [i, op] of program.ops.entries()) {
      const body = () => {
        effects.log.push(`do:${i}`)
        if (i === program.failsAt) throw new FatalTaskError(`op ${i} failed for good`)
        return VALUES[op.valueIndex]
      }
      const name = STEP_NAMES[op.nameIndex] ?? 'op'
      if (op.kind === 'registered') {
        await ctx.step(name, body, {
          rollback: (input) => {
            effects.handed[i] = fingerprint(input.output)
            if (op.rollbackAlwaysFails) {
              effects.log.push(`try:${i}`)
              throw new Error(`rollback ${i} cannot succeed`)
            }
            effects.log.push(`undo:${i}`)
          },
          rollbackConfig: { maxAttempts: 2, retryStrategy: { kind: 'fixed', baseSeconds: 0 } },
        })
      } else if (op.kind === 'step') {
        await ctx.step(name, body)
      } else if (op.kind === 'sleep') {
        await ctx.sleepFor(5)
      } else {
        await ctx.emitEvent(`saga-ev${i}`, JSON.stringify(VALUES[op.valueIndex]) ?? 'null')
      }
    }
    throw new FatalTaskError('the program failed for good')
  }
}

/** What Sagas.tla and §3.10 say this program's rollbacks must be, from the program alone. */
function expectedSaga(program: SagaProgram) {
  const started = program.ops.flatMap((op, i) =>
    op.kind === 'registered' && i <= program.failsAt ? [i] : [],
  )
  const undone: number[] = []
  let halted = false
  for (const i of [...started].reverse()) {
    if (program.ops[i]?.rollbackAlwaysFails) {
      halted = true
      break
    }
    undone.push(i)
  }
  return {
    undone,
    outcome: halted ? 'failed' : 'complete',
    handed: Object.fromEntries(
      (halted ? [...undone, started[started.length - 1 - undone.length]] : undone).map((i) => [
        i,
        i === program.failsAt
          ? fingerprint(undefined)
          : fingerprint(
              JSON.parse(
                JSON.stringify(VALUES[program.ops[i as number]?.valueIndex ?? 0]) ?? 'null',
              ),
            ),
      ]),
    ),
  }
}

async function runSagaProgram(
  program: SagaProgram,
  seed: string,
  failAtCall: number,
  tamper: (store: SchedulerStore) => SchedulerStore = (store) => store,
) {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const real = new LibsqlSchedulerStore(raw, seededIdSource(new Rng(seed)))
    let calls = 0
    const store = new Proxy(tamper(real), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          if (calls === failAtCall)
            return Promise.reject(new StoreUnavailableError('injected outage'))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as SchedulerStore
    const clock = new FakeClock()
    await admin.setFakeNowEpochMs(clock.now)
    const effects: SagaEffects = { log: [], handed: {} }
    const registry: TaskRegistry = new Map([['saga', sagaHandler(program, effects)]])
    const spawned = await real.spawn(Q, 'saga', '{}')
    for (let round = 0; round < 80; round++) {
      const done = await real.getTaskResult(Q, spawned.taskId)
      if (done && !['pending', 'running', 'sleeping'].includes(done.state)) break
      const [run] = await real.claim(Q, `w${round}`, { leaseSeconds: 60, limit: 1 })
      if (run) {
        await runClaimedRun(
          { store, clock, registry },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        ).catch(() => {})
      }
      clock.advance(70_000)
      await admin.setFakeNowEpochMs(clock.now)
      await real.sweep(Q, 10)
    }
    const result = await real.getTaskResult(Q, spawned.taskId)
    const [cps] = await raw.batch(
      't',
      [
        {
          sql: `SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ?
                ORDER BY checkpoint_name`,
          args: [spawned.taskId],
        },
      ],
      'read',
    )
    expect(await engineInvariantViolations(raw)).toEqual([])
    expect(await childTaskViolations(raw)).toEqual([])
    expect(await sagaViolations(raw)).toEqual([])
    const undos = effects.log.filter((line) => line.startsWith('undo:'))
    return {
      calls,
      state: result?.state,
      failure: result?.failureReasonJson,
      outcome: result?.rollback?.outcome,
      checkpoints: (cps?.rows ?? []).map(
        (row) => `${String(row.checkpoint_name)} = ${String(row.state)}`,
      ),
      /** Each rollback in the order it first succeeded, and how often each ran. */
      undone: [...new Set(undos)].map((line) => Number(line.slice('undo:'.length))),
      undoCounts: Object.fromEntries(
        [...new Set(undos)].map((line) => [line, undos.filter((other) => other === line).length]),
      ),
      handed: effects.handed,
    }
  } finally {
    raw.close()
  }
}

describe('saga replay equivalence (generated programs x fault points across the phase)', () => {
  it('generates registered steps, failing bodies, and rollbacks that cannot succeed', () => {
    const seen = { registered: 0, failsInABody: 0, failsAfter: 0, halts: 0, sleeps: 0 }
    for (let seed = 0; seed < 200; seed++) {
      const program = generateSagaProgram(new Rng(`saga-inventory-${seed}`))
      if (program.ops.some((op) => op.kind === 'registered')) seen.registered++
      if (program.failsAt < program.ops.length) seen.failsInABody++
      else seen.failsAfter++
      if (expectedSaga(program).outcome === 'failed') seen.halts++
      if (program.ops.some((op) => op.kind === 'sleep')) seen.sleeps++
    }
    expect(Object.entries(seen).filter(([, n]) => n === 0)).toEqual([])
    expect(seen.registered).toBe(200)
  })

  it('says what a fixed program rolls back, in what order, and what each rollback is handed', async () => {
    // Two registered steps under one name, and an unregistered one between them.
    const program: SagaProgram = {
      ops: [
        { kind: 'registered', nameIndex: 0, valueIndex: 0 },
        { kind: 'step', nameIndex: 0, valueIndex: 1 },
        { kind: 'registered', nameIndex: 1, valueIndex: 2 },
      ],
      failsAt: 3,
    }
    const run = await runSagaProgram(program, 'saga-fixed', 0)
    expect(
      { state: run.state, outcome: run.outcome, undone: run.undone, handed: run.handed },
      'mutation-verdict:behavior:saga-replay-harness-reports-the-order',
    ).toEqual({
      state: 'failed',
      outcome: 'complete',
      undone: [2, 0],
      handed: { 0: fingerprint(VALUES[0]), 2: fingerprint(VALUES[2]) },
    })
  })

  for (let seed = 0; seed < 8; seed++) {
    it(`saga program ${seed}: rollbacks run in reverse start order, once each, at every fault point`, async () => {
      const program = generateSagaProgram(new Rng(`saga-program-${seed}`))
      const expected = expectedSaga(program)
      const reference = await runSagaProgram(program, `saga-ref-${seed}`, 0)
      // With no fault, the program alone says what ran, in what order, and how often.
      expect({
        state: reference.state,
        outcome: reference.outcome,
        undone: reference.undone,
        undoCounts: reference.undoCounts,
        handed: reference.handed,
      }).toEqual({
        state: 'failed',
        outcome: expected.outcome,
        undone: expected.undone,
        undoCounts: Object.fromEntries(expected.undone.map((i) => [`undo:${i}`, 1])),
        handed: expected.handed,
      })
      for (const call of faultPoints(reference.calls)) {
        const faulted = await runSagaProgram(program, `saga-fault-${seed}-${call}`, call)
        expect(
          {
            state: faulted.state,
            failure: faulted.failure,
            outcome: faulted.outcome,
            checkpoints: faulted.checkpoints,
            undone: faulted.undone,
            handed: faulted.handed,
          },
          `fault at call ${call} of ${reference.calls}`,
        ).toEqual({
          state: reference.state,
          failure: reference.failure,
          outcome: reference.outcome,
          checkpoints: reference.checkpoints,
          undone: reference.undone,
          handed: reference.handed,
        })
        // The record is exactly once, which the checkpoint table holds. The effect is at
        // least once, and a second run needs a fault between the handler and its record.
        const repeats = Object.values(faulted.undoCounts).filter((n) => n !== 1)
        expect(repeats.every((n) => n === 2) && repeats.length <= 1, `fault at call ${call}`).toBe(
          true,
        )
      }
    }, 120_000)
  }
})
