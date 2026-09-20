import {
  childTaskViolations,
  engineInvariantViolations,
  sagaViolations,
} from '@durablerun/conformance'
import {
  EventTimeoutError,
  FatalTaskError,
  type IdSource,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  StoreUnavailableError,
  taskDoneEventName,
} from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { type ChildTask, type TaskContext, type TaskRegistry, runClaimedRun } from '../src/index.js'
import { LONGEST_NAME_BUILT, roomOf } from './name-rooms.js'

const Q = 'q'

/** A task whose first attempt fails is tried again at once. */
const RETRIED_AT_ONCE = {
  maxAttempts: 2,
  retryStrategy: { kind: 'fixed', baseSeconds: 0 },
} as const

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

/**
 * Which generated methods a generated group starts beside another call. Every generated
 * method answers, so a new one does not compile until it says whether a group holds it.
 */
const GROUPED = {
  step: 'a member',
  sleepFor: 'a member',
  sleepUntil: 'a member',
  awaitEvent: 'a member',
  spawn: 'a member',
  awaitTask: 'a member',
  emitEvent: 'takes no key, so it has no place in the order a group takes its keys in',
} as const satisfies Record<GeneratedMethod, string>

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

/** One durable call of the context, made once. */
type CallKind =
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

interface ProgramOp {
  /**
   * A call; a group of calls started together and awaited together, which a task writes as
   * `Promise.all`; or a failure of the task's first attempt, which its retry gets past.
   */
  kind: CallKind | 'group' | 'fail-once'
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
  /** A step whose name ends in `ctx.attempt`, so every attempt of the task runs a step of its own. */
  namedAfterAttempt?: boolean
  /** A group's calls, in the order the task writes them. */
  members?: ProgramOp[]
  /** The shape this op was drawn as a part of, for the inventory. */
  shape?: string
}

const KIND_TO_METHOD: Record<CallKind, keyof TaskContext> = {
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

/** A program's calls in the order the task writes them: a group's members stand in its place. */
function flat<Op extends { kind: string; members?: Op[] }>(ops: readonly Op[]): Op[] {
  return ops.flatMap((op) => (op.kind === 'group' ? (op.members ?? []) : [op]))
}

/** What a shape is drawn from: the generator's stream, and what the program holds so far. */
interface Drawing {
  readonly rng: Rng
  /** The generator's position, which names an event that no other op of the program awaits. */
  at: number
  readonly emitted: string[]
  spawned: number
}

/** An op of a shape, with the value and the name that every op draws. */
const drawn = (d: Drawing, op: Omit<ProgramOp, 'valueIndex' | 'nameIndex'>): ProgramOp => ({
  valueIndex: d.rng.int(VALUES.length),
  nameIndex: d.rng.int(STEP_NAMES.length),
  ...op,
})

const group = (...members: ProgramOp[]): ProgramOp => ({
  kind: 'group',
  valueIndex: 0,
  nameIndex: 0,
  members,
})

const twoSpawns = (d: Drawing): ProgramOp[] => {
  d.spawned += 2
  return [
    group(
      drawn(d, { kind: 'spawn', childFails: d.rng.next() < 0.3 }),
      drawn(d, { kind: 'spawn', childFails: d.rng.next() < 0.3 }),
    ),
  ]
}

/**
 * The shapes a grammar of one call after another cannot draw. A group is durable calls
 * started together and awaited together, which a task writes as `Promise.all`. Every call of
 * a group takes its key when it is made, in the order written, so a group replays by
 * position, and the handler observes it by position: the order its calls are answered in may
 * differ between two schedules for no defect. A durable call made while a step runs is
 * refused (DESIGN.md section 3.10), so a group here starts its step last. Every other call
 * may be started beside another. The members of a group do not depend on one another: a
 * task that awaits, in a group, the event the same group emits can park before its emit
 * lands, and nothing else will wake it.
 */
const PROGRAM_SHAPES = {
  'two awaits of one event, which park the run': (d) => {
    const eventName = `ext${d.at}`
    return [
      group(
        drawn(d, { kind: 'await-external', eventName }),
        drawn(d, { kind: 'await-external', eventName }),
      ),
    ]
  },
  'two awaits of one event the program has emitted': (d) => {
    const eventName = `ev${d.at}`
    d.emitted.push(eventName)
    return [
      drawn(d, { kind: 'emit', eventName }),
      group(
        drawn(d, { kind: 'await-inline', eventName }),
        drawn(d, { kind: 'await-inline', eventName }),
      ),
    ]
  },
  'two spawns': twoSpawns,
  'two awaits of children': (d) => [
    ...(d.spawned < 2 ? twoSpawns(d) : []),
    group(
      drawn(d, { kind: 'await-child', childIndex: d.rng.int(d.spawned) }),
      drawn(d, { kind: 'await-child', childIndex: d.rng.int(d.spawned) }),
    ),
  ],
  'a sleep beside a step': (d) => [
    group(
      d.rng.next() < 0.5
        ? drawn(d, { kind: 'sleep', sleepSeconds: 5 + d.rng.int(20) })
        : drawn(d, { kind: 'sleep-until', atEpochMs: 1_000_000 + (d.at + 1) * 15_000 }),
      drawn(d, { kind: 'step' }),
    ),
  ],
  'an await beside a step': (d) => [
    group(
      drawn(d, { kind: 'await-external', eventName: `ext${d.at}` }),
      drawn(d, { kind: 'step' }),
    ),
  ],
  'a step named after the attempt, on an attempt that fails and on the one after it': (d) => [
    drawn(d, { kind: 'step', namedAfterAttempt: true }),
    drawn(d, { kind: 'fail-once' }),
    drawn(d, { kind: 'step', namedAfterAttempt: true }),
  ],
} satisfies Record<string, (d: Drawing) => ProgramOp[]>

type ProgramShape = keyof typeof PROGRAM_SHAPES

const PROGRAM_SHAPE_NAMES = Object.keys(PROGRAM_SHAPES) as ProgramShape[]

function drawShape(shape: ProgramShape, d: Drawing): ProgramOp[] {
  return PROGRAM_SHAPES[shape](d).map((op) => ({ ...op, shape }))
}

/**
 * A program of random ops. One generated for a shape holds that shape at a random place, and
 * is short, so that the shape is most of what its run costs.
 */
function generateProgram(rng: Rng, forced?: ProgramShape): ProgramOp[] {
  const length = forced === undefined ? 3 + rng.int(5) : 1 + rng.int(2)
  const forcedAt = forced === undefined ? -1 : rng.int(length)
  const ops: ProgramOp[] = []
  const d: Drawing = { rng, at: 0, emitted: [], spawned: 0 }
  for (let i = 0; i < length; i++) {
    d.at = i
    if (forced !== undefined && i === forcedAt) {
      ops.push(...drawShape(forced, d))
      continue
    }
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
      d.emitted.push(eventName)
      ops.push({ kind: 'emit', valueIndex, nameIndex, eventName })
    } else if (roll < 0.44 && d.emitted.length > 0) {
      // Awaiting an event this program already emitted: the inline-hit path.
      ops.push({
        kind: 'await-inline',
        valueIndex,
        nameIndex,
        eventName: d.emitted[rng.int(d.emitted.length)] ?? 'ev0',
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
      d.spawned++
    } else if (roll < 0.76 && d.spawned > 0) {
      // Untimed on purpose: a fault can delay the child past any timeout, and then
      // the faulted schedule would time out where the reference did not.
      ops.push({ kind: 'await-child', valueIndex, nameIndex, childIndex: rng.int(d.spawned) })
    } else if (roll < 0.8) {
      // A child that sleeps past the end of every schedule: the timeout is the only exit.
      ops.push({ kind: 'await-child-timeout', valueIndex, nameIndex, timeoutSeconds: 20 })
    } else if (roll < 0.88 && forced === undefined && !ops.some((op) => op.shape !== undefined)) {
      // One shape to a program, and one failed attempt, so that a program's size is bounded.
      ops.push(
        ...drawShape(PROGRAM_SHAPE_NAMES[rng.int(PROGRAM_SHAPE_NAMES.length)] as ProgramShape, d),
      )
    } else if (roll >= 0.88 && roll < 0.9 && !ops.some((op) => op.kind === 'fail-once')) {
      // The first attempt fails here and the second gets past, so the ops after it run as
      // attempt 2, and a step named after the attempt is another step there.
      ops.push({ kind: 'fail-once', valueIndex, nameIndex })
    } else {
      ops.push({ kind: 'step', valueIndex, nameIndex, namedAfterAttempt: rng.next() < 0.3 })
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
    /**
     * One op's durable call. The call is made before this function first awaits, so the
     * calls of a group are all made, in the order written, before any of them is answered.
     * It answers what the task observed, or the child it spawned.
     */
    const call = async (op: ProgramOp, index: number): Promise<string | ChildTask | undefined> => {
      switch (op.kind) {
        case 'spawn':
          return await ctx.spawn(op.name ?? 'child', {
            valueIndex: op.valueIndex,
            fails: op.childFails === true,
          })
        case 'await-child': {
          const child = children[op.childIndex ?? 0]
          if (child === undefined)
            throw new FatalTaskError('the generator awaited an unspawned child')
          const outcome = await ctx.awaitTask(child)
          return `child:${outcome.state}:${outcome.completedPayloadJson ?? outcome.failureReasonJson}`
        }
        case 'await-child-timeout': {
          const stuck = await ctx.spawn('stuck', null)
          try {
            await ctx.awaitTask(stuck, { timeoutSeconds: op.timeoutSeconds ?? 20 })
            return 'unexpected-child-outcome'
          } catch (error) {
            if (!(error instanceof EventTimeoutError)) throw error
            return 'child-timeout'
          }
        }
        case 'sleep':
          await ctx.sleepFor(op.sleepSeconds ?? 5)
          return undefined
        case 'sleep-until':
          await ctx.sleepUntil(op.atEpochMs ?? 1_000_000)
          return undefined
        case 'emit':
          await ctx.emitEvent(
            op.eventName as string,
            JSON.stringify(VALUES[op.valueIndex]) ?? 'null',
          )
          return undefined
        case 'await-inline':
        case 'await-external': {
          const payload = await ctx.awaitEvent(
            op.eventName as string,
            op.timeoutSeconds !== undefined ? { timeoutSeconds: op.timeoutSeconds } : undefined,
          )
          return `ev:${op.eventName}:${payload}`
        }
        case 'await-timeout':
          try {
            await ctx.awaitEvent(op.eventName as string, {
              timeoutSeconds: op.timeoutSeconds ?? 20,
            })
            return `unexpected-delivery:${op.eventName}`
          } catch (error) {
            if (!(error instanceof EventTimeoutError)) throw error
            return `timeout:${op.eventName}`
          }
        case 'step': {
          const name = op.name ?? STEP_NAMES[op.nameIndex] ?? 'op'
          return fingerprint(
            await ctx.step(
              op.namedAfterAttempt ? `${name}-${ctx.attempt}` : name,
              () => {
                watch?.bodies.push(index)
                return VALUES[op.valueIndex]
              },
              op.registersRollback ? { rollback: () => {} } : undefined,
            ),
          )
        }
        case 'group':
        case 'fail-once':
          throw new FatalTaskError(`the generator drew '${op.kind}' where a call goes`)
      }
    }
    for (const [index, op] of ops.entries()) {
      watch?.trace.push(`op ${index}`)
      if (op.kind === 'fail-once') {
        if (ctx.attempt === 1) throw new Error('the first attempt fails')
        continue
      }
      // A group is observed by position, as `Promise.all` answers it, and never in the order
      // its calls were answered in, which a fault may change.
      const answers =
        op.kind === 'group'
          ? await Promise.all((op.members ?? []).map((member) => call(member, index)))
          : [await call(op, index)]
      for (const answer of answers) {
        if (typeof answer === 'string') observed.push(answer)
        else if (answer !== undefined) children.push(answer)
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
   * starts its Nth call, and every store call the SDK makes in between, by method, with
   * `injected outage` after the one call the harness failed. Only the SDK's calls are counted
   * and traced: the loop that drives the task calls the store itself.
   */
  readonly trace: string[]
  /** The index of every step whose body ran, once for each time it ran. */
  readonly bodies: number[]
  /** The user attempts the task was charged. */
  attempts?: number
}

/** The trace's mark for the store call the harness failed. */
const INJECTED_OUTAGE = 'injected outage'

interface RunOptions {
  readonly tamper?: (store: SchedulerStore) => SchedulerStore
  /** Every generated program completes. A name past its room fails its task for good. */
  readonly ends?: 'completed' | 'failed'
  readonly watch?: Watch
}

/**
 * Run one program to completion, with the Nth store call (counted across
 * the whole lifetime, 0 = no fault) failing as a transient outage; recover
 * through the normal lease machinery until the task terminates.
 */
async function runProgram(
  ops: ProgramOp[],
  seed: string,
  failAtCall: number,
  options: RunOptions = {},
): Promise<{
  result: string | undefined
  failure: string | undefined
  checkpoints: unknown[]
  /** How many tasks of each name exist at the end: a second child is a second row here. */
  tasks: string[]
  /** Which child each spawn's key holds, told by the params the child was spawned with. */
  spawned: string[]
  /** The longest checkpoint name, emitted event name and task id the run left, in characters. */
  longestCheckpointName: number
  longestEmittedName: number
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
    const written = flat(ops)
    const longChildren = new Map(
      written.flatMap((op) =>
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
    const store = new Proxy(tamper(real), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          watch?.trace.push(String(prop))
          if (calls === failAtCall) {
            watch?.trace.push(INJECTED_OUTAGE)
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
      ...written.flatMap((op) =>
        op.kind === 'spawn' && op.name !== undefined ? [[op.name, childHandler] as const] : [],
      ),
    ])
    const spawned = await real.spawn(
      Q,
      'prog',
      '{}',
      ops.some((op) => op.kind === 'fail-once') ? RETRIED_AT_ONCE : undefined,
    )
    const externals = written
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
        await runClaimedRun(
          { store, clock, registry },
          { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
        ).catch(() => {})
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
    const [counted, measured, named] = await raw.batch(
      't',
      [
        {
          sql: 'SELECT task_name, COUNT(*) AS n FROM tasks GROUP BY task_name ORDER BY task_name',
          args: [],
        },
        {
          sql: `SELECT (SELECT MAX(LENGTH(task_id)) FROM tasks) AS id_width,
                       (SELECT attempts FROM tasks WHERE task_id = ?) AS attempts`,
          args: [spawned.taskId],
        },
        { sql: 'SELECT event_name FROM events', args: [] },
      ],
      'read',
    )
    const [spawnedWith] = await raw.batch(
      't',
      [{ sql: 'SELECT task_id, params FROM tasks', args: [] }],
      'read',
    )
    const paramsOf = new Map(
      (spawnedWith?.rows ?? []).map((row) => [String(row.task_id), String(row.params)]),
    )
    if (watch !== undefined) watch.attempts = Number(measured?.rows[0]?.attempts)
    return {
      calls,
      tasks: (counted?.rows ?? []).map((row) => `${String(row.task_name)} x ${Number(row.n)}`),
      spawned: (cps?.rows ?? [])
        .filter((row) => String(row.checkpoint_name).startsWith('$spawn:'))
        .map((row) => {
          const { taskId } = JSON.parse(String(row.state)) as { taskId: string }
          return `${String(row.checkpoint_name)} -> ${paramsOf.get(taskId)}`
        }),
      result: outcome?.completedPayloadJson,
      failure: outcome?.failureReasonJson,
      longestCheckpointName: Math.max(
        0,
        ...(cps?.rows ?? []).map((row) => [...String(row.checkpoint_name)].length),
      ),
      // The task's own emits only. An external event this loop emits, and the completion
      // event of a child that happened to run, are there or not by schedule, for no defect.
      longestEmittedName: Math.max(
        0,
        ...(named?.rows ?? [])
          .map((row) => String(row.event_name))
          .filter((name) => !externals.includes(name) && !name.startsWith(taskDoneEventName('')))
          .map((name) => [...name].length),
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
    // Everything a run reports, but for how many store calls it took, which a fault changes.
    expect({ ...faulted, calls: reference.calls }, `fault at call ${call}`).toEqual(reference)
  }
  return reference
}

/** What a program holds, for the inventory: every kind, a group's members among them, and every shape. */
function inventoryOf(ops: readonly ProgramOp[]): string[] {
  return [...ops, ...flat(ops)].flatMap((op) => [
    op.kind,
    ...(op.shape === undefined ? [] : [op.shape]),
    ...(op.namedAfterAttempt ? ['a step named after the attempt'] : []),
  ])
}

/** The generated programs this file runs at every fault point: six of random ops, and one for each shape. */
const RUN_PROGRAMS: readonly (readonly [string, ProgramOp[]])[] = [
  ...[0, 1, 2, 3, 4, 5].map(
    (seed) => [`program ${seed}`, generateProgram(new Rng(`program-${seed}`))] as const,
  ),
  ...PROGRAM_SHAPE_NAMES.map(
    (shape) => [shape, generateProgram(new Rng(`shape-${shape}`), shape)] as const,
  ),
]

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

  it('every op kind and every shape is actually reachable by generation (no dead weights)', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 300; seed++) {
      for (const held of inventoryOf(generateProgram(new Rng(`inventory-${seed}`)))) seen.add(held)
    }
    expect([...seen].sort()).toEqual(
      [
        ...Object.keys(KIND_TO_METHOD),
        'group',
        'fail-once',
        'a step named after the attempt',
        ...PROGRAM_SHAPE_NAMES,
      ].sort(),
    )
  })

  it('every generated method that takes a key is a member of a generated group, or says why it is not', () => {
    const members = new Set<keyof TaskContext>()
    for (let seed = 0; seed < 300; seed++) {
      for (const op of generateProgram(new Rng(`inventory-${seed}`))) {
        for (const member of op.members ?? []) members.add(KIND_TO_METHOD[member.kind as CallKind])
      }
    }
    const declared = (Object.keys(GROUPED) as GeneratedMethod[]).filter(
      (method) => GROUPED[method] === 'a member',
    )
    expect([...members].sort()).toEqual([...declared].sort())
  })

  it('every shape, and a step named after the attempt, is in a program this file runs at every fault point', () => {
    const run = new Set(RUN_PROGRAMS.flatMap(([, ops]) => inventoryOf(ops)))
    expect(
      [...PROGRAM_SHAPE_NAMES, 'group', 'fail-once', 'a step named after the attempt'].filter(
        (held) => !run.has(held),
      ),
    ).toEqual([])
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

  const SPAWNS_TWO_TOGETHER: ProgramOp[] = [
    group(
      { kind: 'spawn', valueIndex: 0, nameIndex: 0 },
      { kind: 'spawn', valueIndex: 1, nameIndex: 0 },
    ),
    { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 0 },
    { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 1 },
    { kind: 'step', valueIndex: 0, nameIndex: 0 },
  ]

  type AnyCall = (...args: unknown[]) => unknown

  /** A store whose spawns go through `spawn`, and whose other calls are the store's own. */
  const withSpawn = (
    store: SchedulerStore,
    spawn: (issue: AnyCall, args: unknown[]) => unknown,
    written: string[] = [],
  ): SchedulerStore =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        const issue: AnyCall = (...args) => (value as AnyCall).apply(target, args)
        if (prop === 'spawn') return (...args: unknown[]) => spawn(issue, args)
        if (prop !== 'setCheckpoint') return issue
        return (...args: unknown[]) => {
          written.push(String(args[4]))
          return issue(...args)
        }
      },
    })

  /** A store that answers a task's first spawn only after it has answered the second. */
  const answersTheFirstSpawnLast =
    (written: string[]) =>
    (store: SchedulerStore): SchedulerStore => {
      let spawns = 0
      let answerTheFirst = () => {}
      return withSpawn(
        store,
        (issue, args) => {
          const answer = issue(...args) as Promise<unknown>
          spawns++
          if (spawns === 1) {
            return new Promise((resolve) => {
              answerTheFirst = () => resolve(answer)
            })
          }
          if (spawns === 2) void answer.finally(() => answerTheFirst())
          return answer
        },
        written,
      )
    }

  /** A store that spawns each of a task's first two children with the other's params. */
  const swapsTheParamsOfTwoSpawns = (store: SchedulerStore): SchedulerStore => {
    let spawns = 0
    let firstParams: unknown
    let issueTheFirstWith = (_params: unknown) => {}
    return withSpawn(store, (issue, args) => {
      spawns++
      if (spawns === 1) {
        firstParams = args[2]
        return new Promise((resolve) => {
          issueTheFirstWith = (params) => resolve(issue(args[0], args[1], params, ...args.slice(3)))
        })
      }
      if (spawns !== 2) return issue(...args)
      issueTheFirstWith(args[2])
      return issue(args[0], args[1], firstParams, ...args.slice(3))
    })
  }

  it('sees a group whose keys do not follow the order its calls are written in', async () => {
    const inWrittenOrder = [
      '$spawn:child -> {"valueIndex":0,"fails":false}',
      '$spawn:child#2 -> {"valueIndex":1,"fails":false}',
    ]
    const reference = await runProgram(SPAWNS_TWO_TOGETHER, 'keys-ref', 0)
    // The second spawn is answered first, and its checkpoint is written first. The keys are
    // taken when the calls are made, so each child is still under the key of its own call.
    const written: string[] = []
    const reversed = await runProgram(SPAWNS_TWO_TOGETHER, 'keys-reversed', 0, {
      tamper: answersTheFirstSpawnLast(written),
    })
    expect({
      spawned: reference.spawned,
      writtenFirst: written.slice(0, 2),
      reversed: { ...reversed, calls: reference.calls },
    }).toEqual({
      spawned: inWrittenOrder,
      writtenFirst: ['$spawn:child#2', '$spawn:child'],
      reversed: reference,
    })
    // And the comparison can fail: with each child under the other's key it is not equal.
    const swapped = await runProgram(SPAWNS_TWO_TOGETHER, 'keys-swapped', 0, {
      tamper: swapsTheParamsOfTwoSpawns,
    })
    expect(swapped.spawned).not.toEqual(inWrittenOrder)
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
  for (const [title, ops] of RUN_PROGRAMS) {
    it(`${title}: every fault point yields the reference outcome`, async () => {
      await everyFaultPointYieldsTheReference(title, (runSeed, failAtCall) =>
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

/** A task id as this harness mints one. A stored child key holds its parent's id, by length. */
const SAMPLE_TASK_ID = seededIdSource(new Rng('name-length-axis')).uuidv7()

interface NamedCall {
  readonly id: string
  /** The longest durable name the engine builds from `name`, from name-rooms.ts. */
  longest(name: string): string
  /** The longest checkpoint name a program that completes leaves, when the call leaves one. */
  stored?(name: string): string
  /** The event name a program that completes leaves, when the call emits one. */
  emitted?(name: string): string
  /** The calls that pass the name. A name past its room is refused at the last of them. */
  ops(name: string): ProgramOp[]
  /**
   * What the failure says: what the task passed, or, for a child's task name, the store's
   * refusal of the child key it built from that name.
   */
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

/**
 * Every generated method answers here: the members that pass a name through it, or the fact
 * that it takes none. A new generated method does not compile without an answer.
 */
const NAME_AXIS: Record<GeneratedMethod, readonly [NamedCall, ...NamedCall[]] | 'takes no name'> = {
  step: [
    {
      id: 'step',
      longest: LONGEST_NAME_BUILT.step,
      stored: LONGEST_NAME_BUILT.step,
      ops: (name) => [namedStep(name)],
      names: 'step name',
      reaches: [],
    },
    {
      id: 'step used twice',
      longest: LONGEST_NAME_BUILT.stepUsedTwice,
      stored: LONGEST_NAME_BUILT.stepUsedTwice,
      ops: (name) => [namedStep(name), namedStep(name)],
      names: 'step name',
      reaches: [],
    },
    {
      id: 'step that registers a rollback',
      longest: LONGEST_NAME_BUILT.registeredStep,
      stored: (name) => `${SAGA_STARTED_PREFIX}${name}`,
      ops: (name) => [namedStep(name, true)],
      names: 'step name',
      reaches: [],
    },
  ],
  sleepFor: 'takes no name',
  sleepUntil: 'takes no name',
  awaitEvent: [
    {
      // The parked path, so the wait and the wake it carries hold the key as well as the memo.
      id: 'awaitEvent',
      longest: LONGEST_NAME_BUILT.awaitEvent,
      stored: LONGEST_NAME_BUILT.awaitEvent,
      ops: (name) => [{ kind: 'await-external', valueIndex: 0, nameIndex: 0, eventName: name }],
      names: 'event name',
      reaches: [],
    },
  ],
  emitEvent: [
    {
      id: 'emitEvent',
      longest: LONGEST_NAME_BUILT.emitEvent,
      emitted: LONGEST_NAME_BUILT.emitEvent,
      ops: (name) => [{ kind: 'emit', valueIndex: 0, nameIndex: 0, eventName: name }],
      names: 'event name',
      reaches: [],
    },
  ],
  spawn: [
    {
      id: 'spawn',
      longest: LONGEST_NAME_BUILT.spawnUnder(SAMPLE_TASK_ID),
      stored: (name) => `$spawn:${name}`,
      ops: (name) => [{ kind: 'spawn', valueIndex: 0, nameIndex: 0, name }],
      names: 'was refused: childOf.replayKey, as the stored child key',
      reaches: ['spawn'],
    },
  ],
  awaitTask: [
    {
      // The axis asks for the length of the child's id, and the run pads an id to it.
      id: 'awaitTask',
      longest: LONGEST_NAME_BUILT.awaitTask,
      stored: LONGEST_NAME_BUILT.awaitTask,
      ops: (id) => [
        { kind: 'spawn', valueIndex: 0, nameIndex: 0, childIdLength: id.length },
        { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 0 },
      ],
      names: 'child task id',
      reaches: [],
      taskIdLength: (id) => id.length,
    },
  ],
}

const NAME_AXIS_MEMBERS = Object.values(NAME_AXIS).flatMap((members) =>
  members === 'takes no name' ? [] : [...members],
)

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
  for (const call of NAME_AXIS_MEMBERS) {
    const room = roomOf(call.longest)

    it(`${call.id}: a name under its room and at it replays like any other, and one past it fails the task for good with nothing stored`, async () => {
      for (const length of [room - 1, room]) {
        const name = 'n'.repeat(length)
        const reference = await everyFaultPointYieldsTheReference(
          `${call.id}-${length}`,
          (seed, failAtCall) => runProgram([...call.ops(name), PLAIN_STEP], seed, failAtCall),
        )
        // The run really left what the member says it leaves, at the length it says.
        if (call.stored !== undefined) {
          expect(reference.longestCheckpointName, `a name of ${length}`).toBe(
            [...call.stored(name)].length,
          )
        }
        if (call.emitted !== undefined) {
          expect(reference.longestEmittedName, `a name of ${length}`).toBe(
            [...call.emitted(name)].length,
          )
        }
        expect(reference.longestTaskId, `a name of ${length}`).toBe(
          call.taskIdLength?.(name) ?? SAMPLE_TASK_ID.length,
        )
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
          // the failure, and nothing else. The one attempt the injected outage cut short made
          // some of those calls, in order, and stopped at the call the harness failed. The
          // task was charged one attempt, so nothing was retried.
          const thenCalled = [...call.reaches, 'fail']
          const after = callsAfter(watch.trace, `op ${refusedAt}`)
          const asExpected = (calls: readonly string[]): boolean => {
            const cutShort = calls.at(-1) === INJECTED_OUTAGE
            const made = cutShort ? calls.slice(0, -1) : calls
            return (
              (cutShort ? made.length > 0 : made.length === thenCalled.length) &&
              made.every((name, at) => name === thenCalled[at])
            )
          }
          expect(
            {
              faultAtCall: failAtCall,
              ranAtOrAfterTheRefusedCall: watch.bodies.filter((index) => index >= refusedAt),
              calledAnythingElse: after.filter((calls) => !asExpected(calls)),
              lastAttempt: after.at(-1),
              attempts: watch.attempts,
            },
            'mutation-verdict:behavior:a-name-past-its-room-is-refused-before-any-store-call',
          ).toEqual({
            faultAtCall: failAtCall,
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
  kind: 'step' | 'registered' | 'sleep' | 'emit' | 'group'
  nameIndex: number
  valueIndex: number
  /** A registered step whose rollback can never succeed halts the saga there. */
  rollbackAlwaysFails?: boolean
  /** A registered step whose rollback fails the first time it is tried, and succeeds the next. */
  rollbackFailsOnce?: boolean
  /**
   * A step whose name ends in `ctx.attempt`. A rollback pass replays as the run that failed,
   * so it finds the step's memo. A pass that replayed as any other attempt would find none,
   * register no rollback, and halt the saga with nothing compensated.
   */
  namedAfterAttempt?: boolean
  /** A group's calls, started together and awaited together, in the order the task writes them. */
  members?: SagaOp[]
  /** The shape this op was drawn as a part of, for the inventory. */
  shape?: string
}

interface SagaProgram {
  ops: SagaOp[]
  /**
   * The site whose body fails for good, or the number of sites for a failure after every op.
   * A site is a call's place among the program's calls in the order the task writes them,
   * a group's members standing in its place.
   */
  failsAt: number
}

/** An op of a saga shape, with the name and the value that every op draws. */
const sagaDrawn = (rng: Rng, op: Omit<SagaOp, 'nameIndex' | 'valueIndex'>): SagaOp => ({
  nameIndex: rng.int(STEP_NAMES.length),
  valueIndex: rng.int(VALUES.length),
  ...op,
})

/**
 * The saga shapes a grammar of one call after another cannot draw. A registered step writes
 * its start marker before its body runs, so beside a sleep its marker and the suspension are
 * in flight together. A step named after the attempt is what a pass must replay as the failed
 * run to find, and a rollback that fails once puts a second pass after the first, so both
 * terms of the attempt a pass replays as are in one program.
 */
const SAGA_SHAPES = {
  'a registered step beside a sleep': (rng) => [
    {
      kind: 'group',
      nameIndex: 0,
      valueIndex: 0,
      members: [sagaDrawn(rng, { kind: 'sleep' }), sagaDrawn(rng, { kind: 'registered' })],
    },
  ],
  'steps named after the attempt, and a rollback that fails once': (rng) => [
    sagaDrawn(rng, { kind: 'registered', namedAfterAttempt: true, rollbackFailsOnce: true }),
    sagaDrawn(rng, { kind: 'registered', namedAfterAttempt: true }),
  ],
} satisfies Record<string, (rng: Rng) => SagaOp[]>

type SagaShape = keyof typeof SAGA_SHAPES

const SAGA_SHAPE_NAMES = Object.keys(SAGA_SHAPES) as SagaShape[]

function drawSagaShape(shape: SagaShape, rng: Rng): SagaOp[] {
  return SAGA_SHAPES[shape](rng).map((op) => ({ ...op, shape }))
}

/** A saga of random ops. One generated for a shape holds it at a random place, is short, and fails after every op. */
function generateSagaProgram(rng: Rng, forced?: SagaShape): SagaProgram {
  const length = forced === undefined ? 3 + rng.int(4) : 1 + rng.int(2)
  const forcedAt = forced === undefined ? -1 : rng.int(length)
  const ops: SagaOp[] = []
  for (let i = 0; i < length; i++) {
    if (forced !== undefined && i === forcedAt) {
      ops.push(...drawSagaShape(forced, rng))
      continue
    }
    const roll = rng.next()
    const base = { nameIndex: rng.int(STEP_NAMES.length), valueIndex: rng.int(VALUES.length) }
    if (roll < 0.55) {
      const failing = rng.next()
      ops.push({
        ...base,
        kind: 'registered',
        rollbackAlwaysFails: failing < 0.15,
        // One to a program: each one puts another pass after the first.
        rollbackFailsOnce:
          failing >= 0.15 && failing < 0.25 && !flat(ops).some((op) => op.rollbackFailsOnce),
        namedAfterAttempt: rng.next() < 0.25,
      })
    } else if (roll < 0.72)
      ops.push({ ...base, kind: 'step', namedAfterAttempt: rng.next() < 0.25 })
    else if (roll < 0.85) ops.push({ ...base, kind: 'sleep' })
    else if (roll < 0.93 || forced !== undefined || ops.some((op) => op.shape !== undefined))
      ops.push({ ...base, kind: 'emit' })
    else
      ops.push(
        ...drawSagaShape(SAGA_SHAPE_NAMES[rng.int(SAGA_SHAPE_NAMES.length)] as SagaShape, rng),
      )
  }
  // Every program has a rollback to run, and half of them fail inside a step's body, so
  // a step that started and never persisted is rolled back too.
  if (!flat(ops).some((op) => op.kind === 'registered')) {
    ops[0] = { kind: 'registered', nameIndex: 0, valueIndex: 0 }
  }
  const sites = flat(ops)
  const bodies = ops.flatMap((op) =>
    op.kind === 'registered' || op.kind === 'step' ? [sites.indexOf(op)] : [],
  )
  const failsAt =
    forced !== undefined || rng.next() < 0.5
      ? sites.length
      : (bodies[rng.int(bodies.length)] ?? sites.length)
  return { ops, failsAt }
}

/** What the world outside the store saw: bodies that ran, and rollbacks that ran or failed. */
interface SagaEffects {
  log: string[]
  handed: Record<number, string>
}

function sagaHandler(
  program: SagaProgram,
  effects: SagaEffects,
  triedBefore: (stepKey: string) => Promise<boolean>,
) {
  const sites = flat(program.ops)
  return async (ctx: TaskContext) => {
    /** One op's durable call, made before this function first awaits, as a group needs. */
    const call = async (op: SagaOp): Promise<void> => {
      const i = sites.indexOf(op)
      const body = () => {
        effects.log.push(`do:${i}`)
        if (i === program.failsAt) throw new FatalTaskError(`op ${i} failed for good`)
        return VALUES[op.valueIndex]
      }
      // A rollback that fails once asks the store whether it has failed before, by its step's
      // key. Its step has a name no other op has, so that the key is the name.
      const base = op.rollbackFailsOnce ? `fails-once-${i}` : (STEP_NAMES[op.nameIndex] ?? 'op')
      const name = op.namedAfterAttempt ? `${base}-${ctx.attempt}` : base
      if (op.kind === 'registered') {
        await ctx.step(name, body, {
          rollback: async (input) => {
            effects.handed[i] = fingerprint(input.output)
            // What a rollback does is a function of what the store holds, so that a pass an
            // outage repeats does what the pass it repeats did.
            if (op.rollbackAlwaysFails || (op.rollbackFailsOnce && !(await triedBefore(name)))) {
              effects.log.push(`try:${i}`)
              throw new Error(
                `rollback ${i} ${op.rollbackAlwaysFails ? 'cannot succeed' : 'fails once'}`,
              )
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
    for (const op of program.ops) {
      if (op.kind === 'group') await Promise.all((op.members ?? []).map(call))
      else await call(op)
    }
    throw new FatalTaskError('the program failed for good')
  }
}

/** What Sagas.tla and §3.10 say this program's rollbacks must be, from the program alone. */
function expectedSaga(program: SagaProgram) {
  const sites = flat(program.ops)
  const started = sites.flatMap((op, i) =>
    op.kind === 'registered' && i <= program.failsAt ? [i] : [],
  )
  const undone: number[] = []
  let halted = false
  for (const i of [...started].reverse()) {
    if (sites[i]?.rollbackAlwaysFails) {
      halted = true
      break
    }
    undone.push(i)
  }
  return {
    undone,
    // A task none of whose registered steps started has nothing to roll back, and its result
    // holds no rollback outcome.
    outcome: started.length === 0 ? undefined : halted ? 'failed' : 'complete',
    handed: Object.fromEntries(
      (halted ? [...undone, started[started.length - 1 - undone.length]] : undone).map((i) => [
        i,
        i === program.failsAt
          ? fingerprint(undefined)
          : fingerprint(
              JSON.parse(JSON.stringify(VALUES[sites[i as number]?.valueIndex ?? 0]) ?? 'null'),
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
    const triedBefore = async (stepKey: string): Promise<boolean> => {
      const [tries] = await raw.batch(
        't',
        [
          {
            sql: 'SELECT 1 AS tried FROM checkpoints WHERE checkpoint_name = ?',
            args: [`${SAGA_TRIES_PREFIX}${stepKey}`],
          },
        ],
        'read',
      )
      return (tries?.rows.length ?? 0) > 0
    }
    const registry: TaskRegistry = new Map([['saga', sagaHandler(program, effects, triedBefore)]])
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

/** The generated sagas this file runs at every fault point: six of random ops, and one for each shape. */
const SAGA_RUN_PROGRAMS: readonly (readonly [string, SagaProgram])[] = [
  ...[0, 1, 2, 3, 4, 5].map(
    (seed) =>
      [`saga program ${seed}`, generateSagaProgram(new Rng(`saga-program-${seed}`))] as const,
  ),
  ...SAGA_SHAPE_NAMES.map(
    (shape) => [shape, generateSagaProgram(new Rng(`saga-shape-${shape}`), shape)] as const,
  ),
]

describe('saga replay equivalence (generated programs x fault points across the phase)', () => {
  it('generates registered steps, failing bodies, rollbacks that cannot succeed or fail once, groups, and steps named after the attempt', () => {
    const seen = {
      registered: 0,
      failsInABody: 0,
      failsAfter: 0,
      halts: 0,
      sleeps: 0,
      groups: 0,
      rollbacksThatFailOnce: 0,
      namedAfterTheAttempt: 0,
    }
    const shapes = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      const program = generateSagaProgram(new Rng(`saga-inventory-${seed}`))
      const sites = flat(program.ops)
      if (sites.some((op) => op.kind === 'registered')) seen.registered++
      if (program.failsAt < sites.length) seen.failsInABody++
      else seen.failsAfter++
      if (expectedSaga(program).outcome === 'failed') seen.halts++
      if (sites.some((op) => op.kind === 'sleep')) seen.sleeps++
      if (program.ops.some((op) => op.kind === 'group')) seen.groups++
      if (sites.some((op) => op.rollbackFailsOnce)) seen.rollbacksThatFailOnce++
      if (sites.some((op) => op.namedAfterAttempt)) seen.namedAfterTheAttempt++
      for (const op of program.ops) if (op.shape !== undefined) shapes.add(op.shape)
    }
    expect(Object.entries(seen).filter(([, n]) => n === 0)).toEqual([])
    expect(seen.registered).toBe(200)
    expect([...shapes].sort()).toEqual([...SAGA_SHAPE_NAMES].sort())
    // And every shape is in a program this file runs at every fault point.
    const run = new Set(
      SAGA_RUN_PROGRAMS.flatMap(([, program]) => program.ops.map((op) => op.shape)),
    )
    expect(SAGA_SHAPE_NAMES.filter((shape) => !run.has(shape))).toEqual([])
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

  for (const [title, program] of SAGA_RUN_PROGRAMS) {
    it(`${title}: rollbacks run in reverse start order, once each, at every fault point`, async () => {
      const expected = expectedSaga(program)
      const reference = await runSagaProgram(program, `saga-ref-${title}`, 0)
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
        const faulted = await runSagaProgram(program, `saga-fault-${title}-${call}`, call)
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
