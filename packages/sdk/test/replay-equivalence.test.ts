import { engineHistoryViolations } from '@durablerun/conformance'
import {
  EventTimeoutError,
  FatalTaskError,
  type IdSource,
  PermanentStoreError,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  StoreUnavailableError,
  taskDoneEventName,
} from '@durablerun/core'
import { FakeClock, Rng, seededIdSource, withStoreOverrides } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { type ChildTask, type TaskContext, type TaskRegistry, runClaimedRun } from '../src/index.js'
import { LONGEST_NAME_BUILT, roomOf } from './name-rooms.js'

const Q = 'q'

/** A wait on a real timer. It is not durable: nothing of it is stored, and a replay waits again. */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Two tries, the second at once: a task whose first attempt fails, and every rollback. */
const TWO_TRIES_AT_ONCE = {
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
   * `Promise.all`; a failure of the task's first attempt, which its retry gets past; flows,
   * which are functions started together that each await and then go on; or a wait on a timer,
   * which is not durable.
   */
  kind: CallKind | 'group' | 'fail-once' | 'flows' | 'wait' | 'spawn-own'
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
  /** Flows: each is ops run one after the other, and all of them are started together. */
  flows?: ProgramOp[][]
  /** A call whose refusal the task catches, and answers 'caught' for. */
  catches?: boolean
  /** Flows whose answers are gathered with `Promise.allSettled`, a rejection answering 'REJ'. */
  settled?: boolean
  /** How long a wait lasts, in milliseconds of a real timer. */
  waitMs?: number
  /** A wait of this many microtask turns, in place of a timer: the task's own work between two calls. */
  hops?: number
  /** A step whose body takes this many milliseconds of a real timer before it returns. */
  bodyMs?: number
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

/**
 * A program's calls in the order the task writes them: a group's members stand in its place,
 * and so do the ops of its flows, one flow after another.
 */
function flat<Op extends { kind: string; members?: Op[]; flows?: Op[][] }>(
  ops: readonly Op[],
): Op[] {
  return ops.flatMap((op) =>
    op.kind === 'group' ? (op.members ?? []) : op.kind === 'flows' ? (op.flows ?? []).flat() : [op],
  )
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

/** Calls started together and awaited together, in the order the task writes them. */
const group = <Op>(...members: Op[]) => ({
  kind: 'group' as const,
  valueIndex: 0,
  nameIndex: 0,
  members,
})

/** The grammar's recipes, which a shape draws as the random ops do. */
const sleepSeconds = (rng: Rng): number => 5 + rng.int(20)
const childFails = (rng: Rng): boolean => rng.next() < 0.3
const externalEvent = (at: number): string => `ext${at}`
/** An absolute wake near the fake clock's base: some are already past, some are ahead. */
const wakeAt = (at: number): number => 1_000_000 + (at + 1) * 15_000

/**
 * A step of a refused group has a name no other op has, so that its key is its name and the
 * comparison can name its row.
 */
const FIRST_OF_A_REFUSED_GROUP = 'the first of a refused group'
const LATER_IN_A_REFUSED_GROUP = 'the later of a refused group'

/** A group whose first call is a step, so that the engine refuses the call made after it. */
const refusedAfterAStep = (d: Drawing, later: ProgramOp): ProgramOp[] => [
  group(drawn(d, { kind: 'step', name: FIRST_OF_A_REFUSED_GROUP }), later),
]

/**
 * The group of a program that the engine refuses, when it has one. A durable call made while
 * a step runs is refused, so it is a group with a step ahead of its last call. The refusal
 * fails the task for good, so nothing of a program runs after it.
 */
function refusedGroupOf<Op extends { kind: string; members?: Op[] }>(
  ops: readonly Op[],
): (Op & { members: Op[] }) | undefined {
  return ops.find(
    (op): op is Op & { members: Op[] } =>
      op.kind === 'group' &&
      (op.members ?? [])
        .slice(0, -1)
        .some((member) => member.kind === 'step' || member.kind === 'registered'),
  )
}

const twoSpawns = (d: Drawing): ProgramOp[] => {
  d.spawned += 2
  return [
    group(
      drawn(d, { kind: 'spawn', childFails: childFails(d.rng) }),
      drawn(d, { kind: 'spawn', childFails: childFails(d.rng) }),
    ),
  ]
}

/**
 * The shapes a grammar of one call after another cannot draw. A group is durable calls
 * started together and awaited together, which a task writes as `Promise.all`. Every call of
 * a group takes its key when it is made, in the order written, so a group replays by
 * position, and the handler observes it by position: the order its calls are answered in may
 * differ between two schedules for no defect. A durable call made while a step runs is
 * refused (DESIGN.md section 3.10), whether the pass runs the step or replays it, so a group
 * that starts its step first is refused on every schedule, and one that starts its step last
 * is admitted. Every other call may be started beside another. The members of a group do not
 * depend on one another: a task that awaits, in a group, the event the same group emits can
 * park before its emit lands, and nothing else will wake it.
 */
const PROGRAM_SHAPES = {
  'two awaits of one event, which park the run': (d) => {
    const eventName = externalEvent(d.at)
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
  // The first suspension ends the pass, so the second sleep is reached by the pass after it.
  'two sleeps, which run one after the other': (d) => [
    group(
      drawn(d, { kind: 'sleep', sleepSeconds: sleepSeconds(d.rng) }),
      drawn(d, { kind: 'sleep', sleepSeconds: sleepSeconds(d.rng) }),
    ),
  ],
  'a sleep beside a step': (d) => [
    group(
      d.rng.next() < 0.5
        ? drawn(d, { kind: 'sleep', sleepSeconds: sleepSeconds(d.rng) })
        : drawn(d, { kind: 'sleep-until', atEpochMs: wakeAt(d.at) }),
      drawn(d, { kind: 'step' }),
    ),
  ],
  'an await beside a step': (d) => [
    group(
      drawn(d, { kind: 'await-external', eventName: externalEvent(d.at) }),
      drawn(d, { kind: 'step' }),
    ),
  ],
  'a step named after the attempt, on an attempt that fails and on the one after it': (d) => [
    drawn(d, { kind: 'step', namedAfterAttempt: true }),
    drawn(d, { kind: 'fail-once' }),
    drawn(d, { kind: 'step', namedAfterAttempt: true }),
  ],
  'a step and then a step, which the engine refuses': (d) =>
    refusedAfterAStep(d, drawn(d, { kind: 'step', name: LATER_IN_A_REFUSED_GROUP })),
  'a step and then a sleep, which the engine refuses': (d) =>
    refusedAfterAStep(d, drawn(d, { kind: 'sleep', sleepSeconds: sleepSeconds(d.rng) })),
  'a step and then an await, which the engine refuses': (d) =>
    refusedAfterAStep(d, drawn(d, { kind: 'await-external', eventName: externalEvent(d.at) })),
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
    // A refused group fails the task for good, so it is the last thing a program holds.
    if (refusedGroupOf(ops) !== undefined) break
    if (forced !== undefined && i === forcedAt) {
      ops.push(...drawShape(forced, d))
      continue
    }
    const roll = rng.next()
    const valueIndex = rng.int(VALUES.length)
    const nameIndex = rng.int(STEP_NAMES.length)
    if (roll < 0.14) {
      ops.push({ kind: 'sleep', valueIndex, nameIndex, sleepSeconds: sleepSeconds(rng) })
    } else if (roll < 0.22) {
      ops.push({ kind: 'sleep-until', valueIndex, nameIndex, atEpochMs: wakeAt(i) })
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
      const base = {
        kind: 'await-external' as const,
        valueIndex,
        nameIndex,
        eventName: externalEvent(i),
      }
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
      ops.push({ kind: 'spawn', valueIndex, nameIndex, childFails: childFails(rng) })
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
      ops.push(...drawShape(rng.pick(PROGRAM_SHAPE_NAMES), d))
    } else if (roll >= 0.88 && roll < 0.9 && !ops.some((op) => op.kind === 'fail-once')) {
      // The first attempt fails here and the second gets past, so the ops after it run as
      // attempt 2, and a step named after the attempt is another step there.
      ops.push({ kind: 'fail-once', valueIndex, nameIndex })
    } else {
      ops.push({ kind: 'step', valueIndex, nameIndex, namedAfterAttempt: rng.next() < 0.3 })
    }
  }
  if (refusedGroupOf(ops) !== undefined) return ops
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

/** `Promise.allSettled`, with a rejected flow answering 'REJ' in its place. */
async function allSettled(
  flows: Promise<(string | ChildTask | undefined)[]>[],
): Promise<(string | ChildTask | undefined)[][]> {
  return (await Promise.allSettled(flows)).map((flow) =>
    flow.status === 'fulfilled' ? flow.value : ['REJ'],
  )
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
    const call = async (
      op: ProgramOp,
      index: number,
      position = 0,
    ): Promise<string | ChildTask | undefined> => {
      if (op.catches !== true) return await callOnce(op, index, position)
      try {
        return await callOnce(op, index, position)
      } catch {
        return 'caught'
      }
    }
    const callOnce = async (
      op: ProgramOp,
      index: number,
      position = 0,
    ): Promise<string | ChildTask | undefined> => {
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
          const ran = () => {
            watch?.bodies.push(index)
            watch?.members?.push(`${index}.${position}`)
            return VALUES[op.valueIndex]
          }
          return fingerprint(
            await ctx.step(
              op.namedAfterAttempt ? `${name}-${ctx.attempt}` : name,
              op.bodyMs === undefined ? ran : () => wait(op.bodyMs ?? 0).then(ran),
              op.registersRollback ? { rollback: () => {} } : undefined,
            ),
          )
        }
        case 'spawn-own': {
          // A child spawned and awaited by the same call site: what the flow observes is
          // the outcome of the child IT spawned, so a flow handed another flow's child says so.
          const child = await ctx.spawn(op.name ?? 'child', {
            valueIndex: op.valueIndex,
            fails: op.childFails === true,
          })
          const outcome = await ctx.awaitTask(child)
          return `own:${outcome.state}:${outcome.completedPayloadJson ?? outcome.failureReasonJson}`
        }
        case 'wait':
          if (op.hops !== undefined) for (let hop = 0; hop < op.hops; hop++) await Promise.resolve()
          else await wait(op.waitMs ?? 1)
          return undefined
        case 'group':
        case 'flows':
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
      // A flow is a function of its own: it makes its next call when its last one is answered,
      // so the calls of two flows are made at moments the store and the timers decide. Flows
      // are observed by position too, each flow's answers in the order it got them.
      const answers =
        op.kind === 'group'
          ? await Promise.all(
              (op.members ?? []).map((member, position) => call(member, index, position)),
            )
          : op.kind === 'flows'
            ? (
                await (op.settled === true ? allSettled : Promise.all.bind(Promise))(
                  (op.flows ?? []).map(async (flow, position) => {
                    const seen: (string | ChildTask | undefined)[] = []
                    for (const member of flow) {
                      // A flow may start flows of its own, and answers what they answered.
                      if (member.kind === 'flows') {
                        const inner = await Promise.all(
                          (member.flows ?? []).map(async (nested) => {
                            const answers: (string | ChildTask | undefined)[] = []
                            for (const call2 of nested)
                              answers.push(await call(call2, index, position))
                            return answers
                          }),
                        )
                        seen.push(...inner.flat())
                      } else seen.push(await call(member, index, position))
                    }
                    return seen
                  }),
                )
              ).flat()
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
/** A checkpoint row as the executor answers it. */
type StoredRow = Record<string, unknown>

/** A task's spawn memos in the order of their keys: each key, and the id of the child it holds. */
function spawnMemos(rows: readonly StoredRow[]): { name: string; taskId: string }[] {
  return rows
    .filter((row) => String(row.checkpoint_name).startsWith('$spawn:'))
    .map((row) => ({
      name: String(row.checkpoint_name),
      taskId: (JSON.parse(String(row.state)) as { taskId: string }).taskId,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * The rows without the engine's order markers. A marker says in which order results reached
 * the task, which a fault changes without changing the task's outcome, so two schedules of one
 * program differ in the numbers and in which results have one. The markers are held apart
 * (`orderMarkersHold`).
 */
const ORDER_MARKER = '$order:'
function withoutOrderMarkers<Row extends StoredRow>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => !String(row.checkpoint_name).startsWith(ORDER_MARKER))
}

function withoutChildIds(rows: readonly StoredRow[]): Row[] {
  const ids = spawnMemos(rows).map((memo) => memo.taskId)
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
  /** The same, as `index.position`, which tells the members of a group apart. */
  readonly members?: string[]
  /** The user attempts the task was charged. */
  attempts?: number
}

/** The trace's mark for the store call the harness failed. */
const INJECTED_OUTAGE = 'injected outage'

/**
 * The kinds of store fault a run can inject. A permanent answer of the store must end a pass
 * exactly as an outage does, so every sampled fault point is run once with each kind. The
 * sample is `faultPoints`: the odd calls from the third, and the last call. It is not every
 * call.
 */
const FAULT_KINDS = ['outage', 'permanent'] as const
type FaultKind = (typeof FAULT_KINDS)[number]
const injectedFault = (kind: FaultKind): Error =>
  kind === 'permanent'
    ? new PermanentStoreError('injected permanent answer')
    : new StoreUnavailableError('injected outage')
/** The outage's run keeps the seed it has always had, and the other kind's run names its kind. */
const faultSeed = (seed: string, kind: FaultKind): string =>
  kind === 'outage' ? seed : `${seed}-${kind}`

/**
 * Which kinds of fault each store method has met, over every run of this file. A sweep is
 * only evidence about a method for the kinds of fault that landed on it, and the last case
 * of the file holds the sweeps to that: every method they failed met both kinds.
 */
const faultsMet = new Map<string, Set<string>>()
/** The fault that landed last, so a sweep can hold each run to the kind it asked for. */
let faultLanded: string | undefined
const meetsFault = (method: string, fault: Error): Error => {
  const kinds = faultsMet.get(method) ?? new Set<string>()
  kinds.add(fault.name)
  faultsMet.set(method, kinds)
  faultLanded = fault.name
  return fault
}
/** Run one faulted run of a sweep, and require that the kind it asked for is the kind that landed. */
async function landing<T>(fault: FaultKind, run: () => Promise<T>): Promise<T> {
  faultLanded = undefined
  const faulted = await run()
  expect(faultLanded, `the fault that landed, where the sweep asked for ${fault}`).toBe(
    injectedFault(fault).name,
  )
  return faulted
}

interface RunOptions {
  readonly tamper?: (store: SchedulerStore) => SchedulerStore
  /**
   * Every generated program completes. A name past its room fails its task for good. 'either'
   * leaves the ending to the caller, who compares it between schedules.
   */
  readonly ends?: 'completed' | 'failed' | 'either'
  readonly watch?: Watch
  /** The kind of fault the failed call meets. An outage, unless a sweep says otherwise. */
  readonly fault?: FaultKind
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
  checkpoints: Row[]
  /** How many tasks of each name exist at the end: a second child is a second row here. */
  tasks: string[]
  /** Which child each spawn's key holds, told by the params the child was spawned with. */
  spawned: string[]
  /** The longest checkpoint name, emitted event name and task id the run left, in characters. */
  longestCheckpointName: number
  longestEmittedName: number
  longestTaskId: number
  calls: number
  state: string | undefined
}> {
  const {
    tamper = (store: SchedulerStore) => store,
    ends = 'completed',
    watch,
    fault = 'outage',
  } = options
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
            return Promise.reject(meetsFault(String(prop), injectedFault(fault)))
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
        (op.kind === 'spawn' || op.kind === 'spawn-own') && op.name !== undefined
          ? [[op.name, childHandler] as const]
          : [],
      ),
    ])
    const spawned = await real.spawn(
      Q,
      'prog',
      '{}',
      ops.some((op) => op.kind === 'fail-once') ? TWO_TRIES_AT_ONCE : undefined,
    )
    const settleMs = 3 * Math.max(0, ...written.map((op) => op.bodyMs ?? 0))
    const externals = [
      ...new Set(
        written.filter((op) => op.kind === 'await-external').map((op) => op.eventName as string),
      ),
    ]

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
        // A body on a timer can outlast its pass. The lease is still held, so what it writes
        // lands, and the round waits for it as a worker's process would go on running it.
        if (settleMs > 0) await wait(settleMs)
      }
      // Moves time without firing sleeps: the pump parks until its pass ends.
      clock.advance(70_000)
      await admin.setFakeNowEpochMs(clock.now)
      await real.sweep(Q, 10)
    }
    const outcome = await real.getTaskResult(Q, spawned.taskId)
    expect(
      ends === 'either' ? ['completed', 'failed'] : [ends],
      `program must terminate (fault at call ${failAtCall})`,
    ).toContain(outcome?.state)
    const [cps, spawnedWith] = await raw.batch(
      't',
      [
        {
          sql: `SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ?
                ORDER BY checkpoint_name`,
          args: [spawned.taskId],
        },
        { sql: 'SELECT task_id, params FROM tasks', args: [] },
      ],
      'read',
    )
    expect(await engineHistoryViolations(raw)).toEqual([])
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
    const paramsOf = new Map(
      (spawnedWith?.rows ?? []).map((row) => [String(row.task_id), String(row.params)]),
    )
    if (watch !== undefined) watch.attempts = Number(measured?.rows[0]?.attempts)
    return {
      calls,
      state: outcome?.state,
      tasks: (counted?.rows ?? []).map((row) => `${String(row.task_name)} x ${Number(row.n)}`),
      spawned: spawnMemos(cps?.rows ?? []).map(
        (memo) => `${memo.name} -> ${paramsOf.get(memo.taskId)}`,
      ),
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
      checkpoints: withoutChildIds(withoutOrderMarkers(cps?.rows ?? [])),
    }
  } finally {
    raw.close()
  }
}

/**
 * A generated program that owns a registered mutant fails under it wherever the defect first
 * shows: where a run checks how it ended, at a row checker, or at the comparison between two
 * schedules. The failure is the program's, so it is reported under the program's verdict,
 * with the assertion that failed as its cause.
 */
async function owning(verdict: string | undefined, body: () => Promise<unknown>): Promise<void> {
  try {
    await body()
  } catch (error) {
    // Only a failed assertion is the program's verdict. A timeout, or a fault of the harness's
    // own, is reported as itself, so that it is never booked as a mutant caught.
    const failedAssertion = error instanceof Error && error.name === 'AssertionError'
    throw verdict !== undefined && failedAssertion ? new Error(verdict, { cause: error }) : error
  }
}

/**
 * The harness's one comparison: a program interrupted at any sampled store call ends as its
 * reference run did. It answers the reference, so a caller can say more about it.
 */
async function everyFaultPointYieldsTheReference(
  label: string,
  run: (seed: string, failAtCall: number, fault: FaultKind) => ReturnType<typeof runProgram>,
  points: (measuredCalls: number) => number[] = faultPoints,
): ReturnType<typeof runProgram> {
  const reference = await run(`ref-${label}`, 0, 'outage')
  for (const call of points(reference.calls)) {
    for (const fault of FAULT_KINDS) {
      const faulted = await landing(fault, () =>
        run(faultSeed(`fault-${label}-${call}`, fault), call, fault),
      )
      // Everything a run reports, but for how many store calls it took, which a fault changes.
      expect({ ...faulted, calls: reference.calls }, `${fault} at call ${call}`).toEqual(reference)
    }
  }
  return reference
}

/** What a program holds, for the inventory: every kind, a group's members among them, and every shape. */
function inventoryOf(ops: readonly ProgramOp[]): string[] {
  return [...ops, ...flat(ops)].flatMap((op) => [
    op.kind,
    ...(op.shape === undefined ? [] : [op.shape]),
    ...(op.namedAfterAttempt ? [NAMED_AFTER_THE_ATTEMPT] : []),
  ])
}

const NAMED_AFTER_THE_ATTEMPT = 'a step named after the attempt'
/** What a program can hold beside a kind of call and a shape. */
const OTHER_HOLDINGS = ['group', 'fail-once', NAMED_AFTER_THE_ATTEMPT]

const flowsOf = (...flows: ProgramOp[][]): ProgramOp => ({
  kind: 'flows',
  valueIndex: 0,
  nameIndex: 0,
  flows,
})
const inAFlow = (op: Omit<ProgramOp, 'valueIndex' | 'nameIndex'>, valueIndex = 0): ProgramOp => ({
  valueIndex,
  nameIndex: 0,
  ...op,
})

/**
 * What the engine does with a program that it does not run the same at every fault point:
 * how many store calls the run with no fault makes, how it ends, and the store calls at which
 * an outage makes it end the other way. Every store call is tried.
 */
interface KnownGap {
  readonly calls: number
  readonly reference: 'completed' | 'refused'
  readonly otherwiseAt: readonly number[]
}

/**
 * A program of concurrent flows that no generator draws, and the one gap that is left in the
 * engine's handling of them. The engine refuses a call made while a step's callback runs,
 * because a call nested in a step advances counters that a replay, which skips the callback,
 * never sees. That is one flag, and it cannot tell a nested call from a call that a sibling
 * flow makes while the step runs. A flow whose step waits on a timer is refused by its
 * sibling's call at some store calls and not at others. The test says exactly what the
 * engine does (`theEngineDoesWhatTheGapSays`), so a change that closes the gap, or widens it,
 * is seen. Every other flow program of this file completes at every store call
 * (ORDERED_FLOW_PROGRAMS).
 */
const FLOW_PROGRAMS: Record<string, { ops: ProgramOp[]; gap: KnownGap }> = {
  'flows one of which starts two flows of its own, each awaiting an event and then recording it in a step under one name':
    {
      gap: { calls: 22, reference: 'completed', otherwiseAt: [16] },
      ops: [
        inAFlow({ kind: 'emit', eventName: 'e1' }),
        inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
        inAFlow({ kind: 'emit', eventName: 'e3' }, 2),
        flowsOf(
          [
            flowsOf(
              [
                inAFlow({ kind: 'await-inline', eventName: 'e1' }),
                inAFlow({ kind: 'step', name: 'rec' }),
              ],
              [
                inAFlow({ kind: 'await-inline', eventName: 'e2' }),
                inAFlow({ kind: 'step', name: 'rec' }, 1),
              ],
            ),
          ],
          [
            inAFlow({ kind: 'await-inline', eventName: 'e3' }),
            inAFlow({ kind: 'step', name: 'rec' }, 2),
          ],
        ),
      ],
    },
  'flows that each wait on a timer of its own length and then run a step whose body takes time': {
    gap: { calls: 5, reference: 'refused', otherwiseAt: [4] },
    ops: [
      flowsOf(
        [
          inAFlow({ kind: 'wait', waitMs: 1 }),
          inAFlow({ kind: 'step', name: 'item-1', bodyMs: 10 }),
        ],
        [
          inAFlow({ kind: 'wait', waitMs: 4 }),
          inAFlow({ kind: 'step', name: 'item-4', bodyMs: 10 }, 1),
        ],
      ),
    ],
  },
}

/**
 * Flows that make calls under a name they share. A repeated name is numbered in the order
 * the calls arrive (`record`, then `record#2`), and two flows reach their calls in an order
 * that the results they awaited decide. A first pass answers those awaits in the order they
 * settle, and a replay answers them from memos, so a replay that did not follow the first pass
 * would number the two calls the other way and hand each flow the other's result (DESIGN.md
 * section 3.2). Each program below is run with an outage at EVERY store call, under both kinds
 * of fault, and a task that completes must complete with exactly its `answers`: what each flow
 * observed, flow after flow. Each flow's values are its own (flow 0 carries value 0, flow 1
 * value 1), so a swap shows in the answers. Every run must also complete: none is refused.
 * The answers of one program are written out and never derived from a run, so a program that
 * ends the same wrong way at every fault point fails too.
 */
const ORDERED_FLOW_PROGRAMS: Record<string, { ops: ProgramOp[]; answers: string[] }> = {
  'flows that each await a child and then record it in a step under its own name, and then a sleep':
    {
      answers: ['child:completed:42', 'number:42', 'child:completed:"plain"', 'string:plain'],
      ops: [
        group<ProgramOp>(inAFlow({ kind: 'spawn' }, 0), inAFlow({ kind: 'spawn' }, 1)),
        flowsOf(
          [
            inAFlow({ kind: 'await-child', childIndex: 0 }),
            inAFlow({ kind: 'step', name: 'record-0' }),
          ],
          [
            inAFlow({ kind: 'await-child', childIndex: 1 }),
            inAFlow({ kind: 'step', name: 'record-1' }, 1),
          ],
        ),
        inAFlow({ kind: 'sleep', sleepSeconds: 5 }),
      ],
    },
  'flows that each await an event the program has emitted and then record it in a step, and then a sleep':
    {
      answers: ['ev:e1:42', 'number:42', 'ev:e2:"plain"', 'string:plain'],
      ops: [
        inAFlow({ kind: 'emit', eventName: 'e1' }),
        inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
        flowsOf(
          [
            inAFlow({ kind: 'await-inline', eventName: 'e1' }),
            inAFlow({ kind: 'step', name: 'record-e1' }),
          ],
          [
            inAFlow({ kind: 'await-inline', eventName: 'e2' }),
            inAFlow({ kind: 'step', name: 'record-e2' }, 1),
          ],
        ),
        inAFlow({ kind: 'sleep', sleepSeconds: 5 }),
      ],
    },
  'flows that each await a child and then record it in a step under one name, and then a sleep': {
    answers: ['child:completed:42', 'number:42', 'child:completed:"plain"', 'string:plain'],
    ops: [
      group<ProgramOp>(inAFlow({ kind: 'spawn' }, 0), inAFlow({ kind: 'spawn' }, 1)),
      flowsOf(
        [
          inAFlow({ kind: 'await-child', childIndex: 0 }),
          inAFlow({ kind: 'step', name: 'record' }),
        ],
        [
          inAFlow({ kind: 'await-child', childIndex: 1 }),
          inAFlow({ kind: 'step', name: 'record' }, 1),
        ],
      ),
      inAFlow({ kind: 'sleep', sleepSeconds: 5 }),
    ],
  },
  'flows that each await an event the program has emitted and then record it in a step under one name, and then a sleep':
    {
      answers: ['ev:e1:42', 'number:42', 'ev:e2:"plain"', 'string:plain'],
      ops: [
        inAFlow({ kind: 'emit', eventName: 'e1' }),
        inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
        flowsOf(
          [
            inAFlow({ kind: 'await-inline', eventName: 'e1' }),
            inAFlow({ kind: 'step', name: 'record' }),
          ],
          [
            inAFlow({ kind: 'await-inline', eventName: 'e2' }),
            inAFlow({ kind: 'step', name: 'record' }, 1),
          ],
        ),
        inAFlow({ kind: 'sleep', sleepSeconds: 5 }),
      ],
    },
  'the same flows, each catching what its step throws': {
    answers: ['ev:e1:42', 'number:42', 'ev:e2:"plain"', 'string:plain'],
    ops: [
      inAFlow({ kind: 'emit', eventName: 'e1' }),
      inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
      flowsOf(
        [
          inAFlow({ kind: 'await-inline', eventName: 'e1' }),
          inAFlow({ kind: 'step', name: 'record', catches: true }),
        ],
        [
          inAFlow({ kind: 'await-inline', eventName: 'e2' }),
          inAFlow({ kind: 'step', name: 'record', catches: true }, 1),
        ],
      ),
    ],
  },
  'the same flows, gathered with allSettled': {
    answers: ['ev:e1:42', 'number:42', 'ev:e2:"plain"', 'string:plain'],
    ops: [
      inAFlow({ kind: 'emit', eventName: 'e1' }),
      inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
      {
        ...flowsOf(
          [
            inAFlow({ kind: 'await-inline', eventName: 'e1' }),
            inAFlow({ kind: 'step', name: 'record' }),
          ],
          [
            inAFlow({ kind: 'await-inline', eventName: 'e2' }),
            inAFlow({ kind: 'step', name: 'record' }, 1),
          ],
        ),
        settled: true,
      },
    ],
  },
  'flows that each await an event the program has emitted and then spawn and await a child under one task name':
    {
      answers: ['ev:e1:42', 'own:completed:42', 'ev:e2:"plain"', 'own:completed:"plain"'],
      ops: [
        inAFlow({ kind: 'emit', eventName: 'e1' }),
        inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
        flowsOf(
          [
            inAFlow({ kind: 'await-inline', eventName: 'e1' }),
            inAFlow({ kind: 'spawn-own', name: 'child' }, 0),
          ],
          [
            inAFlow({ kind: 'await-inline', eventName: 'e2' }),
            inAFlow({ kind: 'spawn-own', name: 'child' }, 1),
          ],
        ),
      ],
    },
  'flows that each await a child and then spawn and await a second child under one task name': {
    answers: [
      'child:completed:42',
      'own:completed:42',
      'child:completed:"plain"',
      'own:completed:"plain"',
    ],
    ops: [
      group<ProgramOp>(
        inAFlow({ kind: 'spawn', name: 'first' }, 0),
        inAFlow({ kind: 'spawn', name: 'first' }, 1),
      ),
      flowsOf(
        [
          inAFlow({ kind: 'await-child', childIndex: 0 }),
          inAFlow({ kind: 'spawn-own', name: 'second' }, 0),
        ],
        [
          inAFlow({ kind: 'await-child', childIndex: 1 }),
          inAFlow({ kind: 'spawn-own', name: 'second' }, 1),
        ],
      ),
    ],
  },
  'a flow that starts a few promise turns after another flow has begun to store its result': {
    answers: ['ev:e1:42', 'own:completed:42', 'ev:e2:"plain"', 'own:completed:"plain"'],
    ops: [
      inAFlow({ kind: 'emit', eventName: 'e1' }),
      inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
      flowsOf(
        [
          inAFlow({ kind: 'await-inline', eventName: 'e1' }),
          inAFlow({ kind: 'spawn-own', name: 'kid' }, 0),
        ],
        [
          inAFlow({ kind: 'wait', hops: 3 }),
          inAFlow({ kind: 'await-inline', eventName: 'e2' }),
          inAFlow({ kind: 'spawn-own', name: 'kid' }, 1),
        ],
      ),
    ],
  },
  'flows that each await a child, spawn another under one task name and await it, in a loop of two rounds':
    {
      answers: [
        'child:completed:42',
        'own:completed:42',
        'own:completed:42',
        'child:completed:"plain"',
        'own:completed:"plain"',
        'own:completed:"plain"',
      ],
      ops: [
        group<ProgramOp>(inAFlow({ kind: 'spawn' }, 0), inAFlow({ kind: 'spawn' }, 1)),
        flowsOf(
          [
            inAFlow({ kind: 'await-child', childIndex: 0 }),
            inAFlow({ kind: 'spawn-own', name: 'round' }, 0),
            inAFlow({ kind: 'spawn-own', name: 'round' }, 0),
          ],
          [
            inAFlow({ kind: 'await-child', childIndex: 1 }),
            inAFlow({ kind: 'spawn-own', name: 'round' }, 1),
            inAFlow({ kind: 'spawn-own', name: 'round' }, 1),
          ],
        ),
      ],
    },
  'flows that each await an event and then run steps under names of their own': {
    answers: [
      'ev:e1:42',
      'number:42',
      'number:42',
      'ev:e2:"plain"',
      'string:plain',
      'string:plain',
    ],
    ops: [
      inAFlow({ kind: 'emit', eventName: 'e1' }),
      inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
      flowsOf(
        [
          inAFlow({ kind: 'await-inline', eventName: 'e1' }),
          inAFlow({ kind: 'step', name: 'a1' }),
          inAFlow({ kind: 'step', name: 'a2' }),
        ],
        [
          inAFlow({ kind: 'await-inline', eventName: 'e2' }),
          inAFlow({ kind: 'step', name: 'b1' }, 1),
          inAFlow({ kind: 'step', name: 'b2' }, 1),
        ],
      ),
    ],
  },
  'flows whose work between a result and the next call takes a different number of promise turns': {
    answers: ['ev:e1:42', 'number:42', 'ev:e2:"plain"', 'string:plain'],
    ops: [
      inAFlow({ kind: 'emit', eventName: 'e1' }),
      inAFlow({ kind: 'emit', eventName: 'e2' }, 1),
      flowsOf(
        [
          inAFlow({ kind: 'await-inline', eventName: 'e1' }),
          inAFlow({ kind: 'wait', hops: 8 }),
          inAFlow({ kind: 'step', name: 'record' }),
        ],
        [
          inAFlow({ kind: 'await-inline', eventName: 'e2' }),
          inAFlow({ kind: 'step', name: 'record' }, 1),
        ],
      ),
    ],
  },
}

/**
 * Generated flows over shared names, checked by what each flow observes. A flow awaits an
 * event of its own, and then makes calls whose names are drawn from a pool that every flow
 * shares, and a flow's values are its own (flow N carries value N). The events are ones the
 * program emitted or ones that arrive from outside after the run has parked, and a flow may
 * sleep, so a run spans several passes. The first attempt may fail after the flows, so the
 * second replays what the first stored.
 */
const FLOW_VALUES = [0, 1, 2] // 42, 'plain', and an object: each with a plain JSON form

function drawSharedNameFlows(rng: Rng): { ops: ProgramOp[]; answers: string[] } {
  const flowCount = 2 + rng.int(2)
  const ops: ProgramOp[] = []
  const flows: ProgramOp[][] = []
  const answers: string[] = []
  const anyOf = <T>(list: readonly [T, ...T[]]): T => list[rng.int(list.length)] ?? list[0]
  for (let flow = 0; flow < flowCount; flow++) {
    const value = FLOW_VALUES[flow] ?? 0
    const json = JSON.stringify(VALUES[value]) ?? 'null'
    const name = `flow${flow}`
    const external = rng.next() < 0.3
    if (!external) ops.push(inAFlow({ kind: 'emit', eventName: name }, value))
    const mine: ProgramOp[] = [
      inAFlow({ kind: external ? 'await-external' : 'await-inline', eventName: name }, value),
    ]
    answers.push(`ev:${name}:${external ? JSON.stringify({ ext: name }) : json}`)
    for (let at = 1 + rng.int(3); at > 0; at--) {
      const pick = rng.int(5)
      if (pick === 0) {
        mine.push(inAFlow({ kind: 'wait', hops: rng.int(12) }, value))
      } else if (pick === 1) {
        mine.push(inAFlow({ kind: 'spawn-own', name: anyOf(['kid', 'kid', 'other']) }, value))
        answers.push(`own:completed:${json}`)
      } else if (pick === 2) {
        mine.push(inAFlow({ kind: 'sleep', sleepSeconds: 5 + rng.int(20) }, value))
      } else {
        mine.push(inAFlow({ kind: 'step', name: anyOf(['rec', 'rec', 'job']) }, value))
        answers.push(fingerprint(VALUES[value]))
      }
    }
    flows.push(mine)
  }
  ops.push(flowsOf(...flows))
  // The first attempt fails after the flows, and the second replays them from what they stored.
  if (rng.next() < 0.4) ops.push({ kind: 'fail-once', valueIndex: 0, nameIndex: 0 })
  return { ops, answers }
}

/** Every checkpoint write waits a turn of the event loop, as a store over a network does. */
const overANetwork = (store: SchedulerStore): SchedulerStore =>
  withStoreOverrides(store, {
    setCheckpoint: async (...args) => {
      await new Promise((resolve) => setImmediate(resolve))
      return store.setCheckpoint(...args)
    },
  })

/**
 * Run a program of flows with an outage at EVERY store call. A task must complete, and with
 * `answers`. Answers how many runs there were. A permanent answer of the store is not injected
 * here: it repeats on every retry, so the pass is not ended for it, and a one-shot answer in a
 * run with flows lets a sibling flow go on as it did before markers (permanent-answer.test.ts
 * holds what a task does with one).
 */
async function everyFaultPointKeepsEachFlowsResult(
  label: string,
  ops: ProgramOp[],
  answers: string[],
  tamper: (store: SchedulerStore) => SchedulerStore = (store) => store,
): Promise<number> {
  const reference = await runProgram(ops, `flows-${label}`, 0, { tamper })
  expect(JSON.parse(reference.result ?? 'null'), `${label}: the run with no fault`).toEqual(answers)
  let runs = 1
  for (const call of everyCall(reference.calls)) {
    for (const fault of ['outage'] as const) {
      const run = await landing(fault, () =>
        runProgram(ops, faultSeed(`flows-${label}-${call}`, fault), call, { fault, tamper }),
      )
      expect(JSON.parse(run.result ?? 'null'), `${label}: ${fault} at call ${call}`).toEqual(
        answers,
      )
      runs++
    }
  }
  return runs
}

/** Every store call of a run, where the sample of `faultPoints` takes every other one. */
const everyCall = (measuredCalls: number): number[] =>
  Array.from({ length: measuredCalls }, (_, at) => at + 1)

const SLEEPS_UNTIL_A_TIME: ProgramOp[] = [
  { kind: 'sleep-until', valueIndex: 0, nameIndex: 0, atEpochMs: 900_000 },
  { kind: 'sleep-until', valueIndex: 0, nameIndex: 0, atEpochMs: wakeAt(3) },
  { kind: 'step', valueIndex: 0, nameIndex: 0 },
]

const STEP_BESIDE_A_SLEEP: ProgramOp[] = [
  group<ProgramOp>(
    inAFlow({ kind: 'sleep', sleepSeconds: 5 }),
    inAFlow({ kind: 'step', name: 'x' }),
  ),
  inAFlow({ kind: 'step', name: 'x' }, 1),
]

const POLL_BESIDE_AN_AWAIT: ProgramOp[] = [
  inAFlow({ kind: 'emit', eventName: 'done' }),
  flowsOf(
    [inAFlow({ kind: 'await-inline', eventName: 'done' })],
    [
      inAFlow({ kind: 'step', name: 'poll' }),
      inAFlow({ kind: 'step', name: 'poll' }, 1),
      inAFlow({ kind: 'step', name: 'poll' }, 2),
    ],
  ),
]

const REPEATED_STEP: ProgramOp[] = [0, 1, 2].map((valueIndex) => ({
  kind: 'step',
  valueIndex,
  nameIndex: 0,
}))

/** The generated programs this file runs at every fault point: six of random ops, and one for each shape. */
const RUN_PROGRAMS: readonly (readonly [string, ProgramOp[]])[] = [
  ...[0, 1, 2, 3, 4, 5].map(
    (seed) => [`program ${seed}`, generateProgram(new Rng(`program-${seed}`))] as const,
  ),
  ...PROGRAM_SHAPE_NAMES.map(
    (shape) => [shape, generateProgram(new Rng(`shape-${shape}`), shape)] as const,
  ),
  // The six seeds draw no sleep until a time outside a group, so one program makes that call
  // one after another: to a time already past, and to one ahead.
  ['a sleep until a time, one call after another', SLEEPS_UNTIL_A_TIME] as const,
  // One step name, used one call after another, is an ordinary program, and so is one step
  // name used beside another flow's call, when only one flow uses it.
  ['a step name used again one call after another', REPEATED_STEP] as const,
  ['a step beside a sleep, and then the same step name again', STEP_BESIDE_A_SLEEP] as const,
  ['a poll loop of one step name, beside an await', POLL_BESIDE_AN_AWAIT] as const,
]

interface Row {
  checkpoint_name: string
  state: string
}

/**
 * What two runs of a program with a refused group may differ by. The refusal ends the pass
 * while the first member's own writes may still be in flight, so each row of that member may
 * be missing from a run. One that is there holds what the program says it holds, and the rows
 * that are left are compared whole, so no other row may differ.
 */
function withoutTheRowsInFlight(
  rows: readonly Row[],
  inFlight: ReadonlyMap<string, string>,
): Row[] {
  const left: Row[] = []
  for (const row of rows) {
    const holds = inFlight.get(row.checkpoint_name)
    if (holds === undefined) left.push(row)
    else
      expect(row.state, `the row '${row.checkpoint_name}', which a refusal may leave out`).toBe(
        holds,
      )
  }
  return left
}

/** What a step's checkpoint holds: the value as the engine serializes it. */
const storedValue = (valueIndex: number): string => JSON.stringify(VALUES[valueIndex]) ?? 'null'

/** How the engine names a call it refuses: a step by its name, any other call by its method. */
const refusedCallOf = (op: ProgramOp): string =>
  op.kind === 'step' ? `ctx.step('${op.name}')` : `ctx.${KIND_TO_METHOD[op.kind as CallKind]}`

/** The store call that is a run's first `fail`: the failing pass's own record of its failure. */
function firstFailCall(trace: readonly string[]): number {
  const calls = trace.filter(
    (entry) => entry !== 'attempt' && entry !== INJECTED_OUTAGE && !/^op \d+$/.test(entry),
  )
  const at = calls.indexOf('fail')
  if (at < 0) throw new Error('the run made no `fail` call')
  return at + 1
}

/**
 * A program whose group the engine refuses is held to this at every fault point but one: the
 * task fails for good with the same refusal, which names the later call; the later member
 * left nothing, no body and no row; and the checkpoint table is the reference's, but for the
 * first member's own row, which the refusal may leave out.
 *
 * The one is a KNOWN GAP, and the test says what the engine does at it. When the outage takes
 * the failing pass's own `fail` call, the next pass replays the first member from its memo,
 * which raises nothing, so the pass admits the later call and the task completes. Closing it
 * means making a replayed step refuse calls beside it, which also refuses an ordinary fan-out
 * written as concurrent flows (BUILD.md's PR3.4d entry names the options). The run with the
 * outage on that call must complete, so a change that closes the gap, or that admits the group
 * at any other call, fails here until this test is changed on purpose.
 */
async function everyFaultPointRefusesTheGroup(label: string, ops: ProgramOp[]): Promise<void> {
  const refused = refusedGroupOf(ops)
  const [first, later] = refused?.members ?? []
  if (refused === undefined || first === undefined || later === undefined)
    throw new Error('the program holds no refused group')
  const inFlight = new Map([[String(first.name), storedValue(first.valueIndex)]])
  const laterBody = `${ops.indexOf(refused)}.1`
  const measured: Watch = { trace: [], bodies: [] }
  await runProgram(ops, `ref-${label}`, 0, { ends: 'failed', watch: measured })
  const admittedAt = firstFailCall(measured.trace)
  const reference = await everyFaultPointYieldsTheReference(
    label,
    async (seed, failAtCall, fault) => {
      const watch: Watch = { trace: [], bodies: [], members: [] }
      const record = await runProgram(ops, seed, failAtCall, { ends: 'failed', watch, fault })
      expect(watch.members, `fault at call ${failAtCall}`).not.toContain(laterBody)
      return {
        ...record,
        checkpoints: withoutTheRowsInFlight(record.checkpoints, inFlight),
        // The longest name is the first member's own when its row is there, so it is not compared.
        longestCheckpointName: 0,
      }
    },
    (measuredCalls) => faultPoints(measuredCalls).filter((call) => call !== admittedAt),
  )
  const failure = JSON.parse(reference.failure ?? 'null') as { name?: string; message?: string }
  expect({
    name: failure?.name,
    refuses: failure?.message?.split(' called inside a step')[0],
  }).toEqual({ name: 'FatalTaskError', refuses: refusedCallOf(later) })
  for (const fault of FAULT_KINDS) {
    const admitted = await landing(fault, () =>
      runProgram(ops, faultSeed(`fault-${label}-${admittedAt}`, fault), admittedAt, {
        ends: 'either',
        fault,
      }),
    )
    expect(
      { state: admitted.state, failure: admitted.failure },
      `known gap: the ${fault} on the failing pass's own fail call (call ${admittedAt}) admits the group`,
    ).toEqual({ state: 'completed', failure: undefined })
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

  const drawnAtRandom = Array.from({ length: 300 }, (_, seed) =>
    generateProgram(new Rng(`inventory-${seed}`)),
  )

  it('every op kind and every shape is actually reachable by generation (no dead weights)', () => {
    const seen = new Set(drawnAtRandom.flatMap(inventoryOf))
    expect([...seen].sort()).toEqual(
      [...Object.keys(KIND_TO_METHOD), ...OTHER_HOLDINGS, ...PROGRAM_SHAPE_NAMES].sort(),
    )
  })

  it('every generated method that takes a key is a member of a generated group, or says why it is not', () => {
    const members = new Set(
      drawnAtRandom.flatMap((ops) =>
        ops.flatMap((op) =>
          (op.members ?? []).map((member) => KIND_TO_METHOD[member.kind as CallKind]),
        ),
      ),
    )
    const declared = (Object.keys(GROUPED) as GeneratedMethod[]).filter(
      (method) => GROUPED[method] === 'a member',
    )
    expect([...members].sort()).toEqual([...declared].sort())
  })

  it('draws these shapes and runs these flow programs, by name, so that taking one out of its table fails here', () => {
    expect({
      plain: PROGRAM_SHAPE_NAMES,
      saga: SAGA_SHAPE_NAMES,
      flows: Object.keys(FLOW_PROGRAMS),
      orderedFlows: Object.keys(ORDERED_FLOW_PROGRAMS),
    }).toEqual({
      plain: [
        'two awaits of one event, which park the run',
        'two awaits of one event the program has emitted',
        'two spawns',
        'two awaits of children',
        'two sleeps, which run one after the other',
        'a sleep beside a step',
        'an await beside a step',
        'a step named after the attempt, on an attempt that fails and on the one after it',
        'a step and then a step, which the engine refuses',
        'a step and then a sleep, which the engine refuses',
        'a step and then an await, which the engine refuses',
      ],
      saga: [
        'a registered step beside a sleep',
        'steps named after the attempt, and a rollback that fails once',
        'two registered steps started together, which the engine refuses',
      ],
      flows: [
        'flows one of which starts two flows of its own, each awaiting an event and then recording it in a step under one name',
        'flows that each wait on a timer of its own length and then run a step whose body takes time',
      ],
      orderedFlows: [
        'flows that each await a child and then record it in a step under its own name, and then a sleep',
        'flows that each await an event the program has emitted and then record it in a step, and then a sleep',
        'flows that each await a child and then record it in a step under one name, and then a sleep',
        'flows that each await an event the program has emitted and then record it in a step under one name, and then a sleep',
        'the same flows, each catching what its step throws',
        'the same flows, gathered with allSettled',
        'flows that each await an event the program has emitted and then spawn and await a child under one task name',
        'flows that each await a child and then spawn and await a second child under one task name',
        'a flow that starts a few promise turns after another flow has begun to store its result',
        'flows that each await a child, spawn another under one task name and await it, in a loop of two rounds',
        'flows that each await an event and then run steps under names of their own',
        'flows whose work between a result and the next call takes a different number of promise turns',
      ],
    })
  })

  it('every kind of call is made one call after another in a program this file runs, and not only inside a group', () => {
    const oneAfterAnother = new Set<string>(
      [
        ...RUN_PROGRAMS.flatMap(([, ops]) => ops),
        ...NAME_AXIS_MEMBERS.flatMap((call) => call.ops('n')),
      ].map((op) => op.kind),
    )
    expect(Object.keys(KIND_TO_METHOD).filter((kind) => !oneAfterAnother.has(kind))).toEqual([])
  })

  it('every shape, and a step named after the attempt, is in a program this file runs at every fault point', () => {
    const run = new Set(RUN_PROGRAMS.flatMap(([, ops]) => inventoryOf(ops)))
    expect([...PROGRAM_SHAPE_NAMES, ...OTHER_HOLDINGS].filter((held) => !run.has(held))).toEqual([])
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
    group<ProgramOp>(
      { kind: 'spawn', valueIndex: 0, nameIndex: 0 },
      { kind: 'spawn', valueIndex: 1, nameIndex: 0 },
    ),
    { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 0 },
    { kind: 'await-child', valueIndex: 0, nameIndex: 0, childIndex: 1 },
    { kind: 'step', valueIndex: 0, nameIndex: 0 },
  ]

  /** A store that answers a task's first spawn only after it has answered the second. */
  const answersTheFirstSpawnLast =
    (written: string[]) =>
    (store: SchedulerStore): SchedulerStore => {
      let spawns = 0
      let answerTheFirst = () => {}
      return withStoreOverrides(store, {
        spawn: (...args) => {
          const answer = store.spawn(...args)
          spawns++
          if (spawns === 1) {
            return new Promise((resolve) => {
              answerTheFirst = () => resolve(answer)
            })
          }
          if (spawns === 2) void answer.finally(() => answerTheFirst())
          return answer
        },
        setCheckpoint: (...args) => {
          written.push(args[4])
          return store.setCheckpoint(...args)
        },
      })
    }

  /** A store that spawns each of a task's first two children with the other's params. */
  const swapsTheParamsOfTwoSpawns = (store: SchedulerStore): SchedulerStore => {
    let spawns = 0
    let firstParams = ''
    let issueTheFirstWith = (_paramsJson: string) => {}
    return withStoreOverrides(store, {
      spawn: (queue, taskName, paramsJson, options) => {
        spawns++
        if (spawns === 1) {
          firstParams = paramsJson
          return new Promise((resolve) => {
            issueTheFirstWith = (other) => resolve(store.spawn(queue, taskName, other, options))
          })
        }
        if (spawns !== 2) return store.spawn(queue, taskName, paramsJson, options)
        issueTheFirstWith(paramsJson)
        return store.spawn(queue, taskName, firstParams, options)
      },
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
      writtenFirst: written.filter((name) => !name.startsWith(ORDER_MARKER)).slice(0, 2),
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
    for (const [title, ops] of RUN_PROGRAMS) {
      const ends = refusedGroupOf(ops) === undefined ? 'completed' : 'failed'
      const { calls } = await runProgram(ops, `window-${title}`, 0, { ends })
      const last = Math.max(...faultPoints(calls))
      if (last !== calls) uncovered.push(`${title}: ${calls} calls, faulted through ${last}`)
    }
    expect(uncovered, 'mutation-verdict:behavior:replay-harness-window-is-measured').toEqual([])
  }, 60_000)
})

describe('replay equivalence (generated programs x fault points x adversarial values)', () => {
  for (const [title, ops] of RUN_PROGRAMS) {
    it(`${title}: every fault point yields the reference outcome`, async () => {
      if (refusedGroupOf(ops) !== undefined) return everyFaultPointRefusesTheGroup(title, ops)
      await everyFaultPointYieldsTheReference(title, (runSeed, failAtCall, fault) =>
        runProgram(ops, runSeed, failAtCall, { fault }),
      )
    }, 60_000)
  }

  for (const [title, program] of Object.entries(FLOW_PROGRAMS)) {
    it(`${title}: an outage at every store call ends as the known gap says`, async () => {
      await theEngineDoesWhatTheGapSays(program.ops, program.gap)
    }, 120_000)
  }

  for (const [title, program] of Object.entries(ORDERED_FLOW_PROGRAMS)) {
    for (const network of [false, true]) {
      it(`${title}${network ? ', over a network' : ''}: an outage at every store call ends with each flow's own result`, async () => {
        await everyFaultPointKeepsEachFlowsResult(
          title,
          program.ops,
          program.answers,
          network ? overANetwork : undefined,
        )
      }, 300_000)
    }
  }

  for (const drawing of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    for (const network of [false, true]) {
      it(`generated flows over shared names ${drawing}${network ? ', over a network' : ''}: an outage at every store call ends with each flow's own result`, async () => {
        const { ops, answers } = drawSharedNameFlows(new Rng(`shared-name-flows-${drawing}`))
        await everyFaultPointKeepsEachFlowsResult(
          `${drawing}${network ? 'n' : ''}`,
          ops,
          answers,
          network ? overANetwork : undefined,
        )
      }, 300_000)
    }
  }
})

/** How a run ended: what it completed with, or the call the engine refused. */
function endingOf(run: Awaited<ReturnType<typeof runProgram>>): string {
  if (run.state === 'completed') return `completed ${run.result} ${run.spawned.join(',')}`
  const message = (JSON.parse(run.failure ?? 'null') as { message?: string } | null)?.message
  const refused = message?.match(/^(ctx\.\S+) called inside a step/)
  return refused?.[1] !== undefined ? `refused ${refused[1]}` : `${run.state} ${message}`
}

/**
 * The witness of a known gap. The run with no fault ends as the gap says. An outage at each
 * store call ends the same way, except at the calls the gap names, where the program ends the
 * other way: refused where the reference completed, and completed with the reference's
 * result where the reference was refused.
 */
async function theEngineDoesWhatTheGapSays(ops: ProgramOp[], gap: KnownGap): Promise<void> {
  const reference = await runProgram(ops, 'gap-ref', 0, { ends: 'either' })
  const referenceEnding = endingOf(reference)
  expect(
    { calls: reference.calls, ending: referenceEnding.split(' ')[0] },
    'the run with no fault',
  ).toEqual({ calls: gap.calls, ending: gap.reference })
  const otherwise: { call: number; ending: string }[] = []
  for (const call of everyCall(reference.calls)) {
    const ending = endingOf(await runProgram(ops, `gap-${call}`, call, { ends: 'either' }))
    if (ending !== referenceEnding) otherwise.push({ call, ending })
  }
  expect(
    otherwise.map((run) => run.call),
    'the store calls at which an outage ends it the other way',
  ).toEqual([...gap.otherwiseAt])
  // Every one of them ends the same one other way.
  expect(new Set(otherwise.map((run) => run.ending)).size).toBeLessThanOrEqual(1)
}

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
          (seed, failAtCall, fault) =>
            runProgram([...call.ops(name), PLAIN_STEP], seed, failAtCall, { fault }),
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
        async (seed, failAtCall, fault) => {
          const watch: Watch = { trace: [], bodies: [] }
          const run = await runProgram(ops, seed, failAtCall, { ends: 'failed', watch, fault })
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
  /** A name of the op's own, in place of the corpus's, so that the step's key is its name. */
  name?: string
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
    group(sagaDrawn(rng, { kind: 'sleep' }), sagaDrawn(rng, { kind: 'registered' })),
  ],
  'steps named after the attempt, and a rollback that fails once': (rng) => [
    sagaDrawn(rng, { kind: 'registered', namedAfterAttempt: true, rollbackFailsOnce: true }),
    sagaDrawn(rng, { kind: 'registered', namedAfterAttempt: true }),
  ],
  // A registered step comes first, so that the task has a rollback to run whether or not the
  // first member's start marker lands.
  'two registered steps started together, which the engine refuses': (rng) => [
    sagaDrawn(rng, { kind: 'registered' }),
    group(
      sagaDrawn(rng, { kind: 'registered', name: FIRST_OF_A_REFUSED_GROUP }),
      sagaDrawn(rng, { kind: 'registered', name: LATER_IN_A_REFUSED_GROUP }),
    ),
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
    // A refused group fails the task for good, so it is the last thing a program holds.
    if (refusedGroupOf(ops) !== undefined) break
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
    else ops.push(...drawSagaShape(rng.pick(SAGA_SHAPE_NAMES), rng))
  }
  // Every program has a rollback to run, and half of them fail inside a step's body, so
  // a step that started and never persisted is rolled back too.
  if (!flat(ops).some((op) => op.kind === 'registered')) {
    ops[0] = { kind: 'registered', nameIndex: 0, valueIndex: 0 }
  }
  const sites = flat(ops)
  // A body that can fail: a step at the top level, or a member of a group. Of a refused group
  // none is chosen, because the refusal ends the task first.
  const bodies = sites.flatMap((op, site) =>
    op.kind === 'registered' || op.kind === 'step' ? [site] : [],
  )
  const failsAt =
    forced !== undefined || refusedGroupOf(ops) !== undefined || rng.next() < 0.5
      ? sites.length
      : (bodies[rng.int(bodies.length)] ?? sites.length)
  return { ops, failsAt }
}

/**
 * A program that fails for good in the body of its group's registered step. A program
 * generated for a shape fails after every op, so without this one no member of a group is a
 * step that started and never persisted.
 */
function failingInsideItsGroup(program: SagaProgram): SagaProgram {
  const member = program.ops
    .flatMap((op) => (op.kind === 'group' ? (op.members ?? []) : []))
    .find((op) => op.kind === 'registered')
  if (member === undefined) throw new Error('the program has no group with a registered step')
  return { ...program, failsAt: flat(program.ops).indexOf(member) }
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
      const base =
        op.name ?? (op.rollbackFailsOnce ? `fails-once-${i}` : (STEP_NAMES[op.nameIndex] ?? 'op'))
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
          rollbackConfig: TWO_TRIES_AT_ONCE,
        })
      } else if (op.kind === 'step') {
        await ctx.step(name, body)
      } else if (op.kind === 'sleep') {
        await ctx.sleepFor(5)
      } else if (op.kind === 'emit') {
        await ctx.emitEvent(`saga-ev${i}`, JSON.stringify(VALUES[op.valueIndex]) ?? 'null')
      } else {
        throw new FatalTaskError(`the generator drew '${op.kind}' where a call goes`)
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
  // Of a refused group the first member starts, and with no fault its result never persists:
  // the refusal fails the task while the step's start marker is being written, and the body
  // runs after that. The later member is refused, so it never starts.
  const [first, later] = (refusedGroupOf(program.ops)?.members ?? []).map((op) => sites.indexOf(op))
  const started = sites.flatMap((op, i) =>
    op.kind === 'registered' && i <= program.failsAt && i !== later ? [i] : [],
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
        i === program.failsAt || i === first
          ? fingerprint(undefined)
          : fingerprint(JSON.parse(storedValue(sites[i as number]?.valueIndex ?? 0))),
      ]),
    ),
  }
}

/**
 * The rows of a refused group's first member, and its site. The refusal ends the pass while
 * the member's start marker is being written, so the marker, the step's result and the
 * record of its rollback may each be missing from a run, and one that is there holds this.
 */
function rowsARefusalMayLeaveOut(program: SagaProgram) {
  const sites = flat(program.ops)
  const first = refusedGroupOf(program.ops)?.members[0]
  if (first === undefined) return undefined
  const site = sites.indexOf(first)
  const startedBefore = sites.slice(0, site).filter((op) => op.kind === 'registered').length
  const key = String(first.name)
  return {
    site,
    key,
    rows: new Map([
      [key, storedValue(first.valueIndex)],
      [`${SAGA_STARTED_PREFIX}${key}`, String(startedBefore + 1)],
      [`${SAGA_ROLLBACK_PREFIX}${key}`, 'null'],
    ]),
  }
}

/**
 * What two schedules of a saga are compared by. With a refused group the first member's own
 * rows are left out of the table once each is seen to hold what it should, and the member is
 * left out of the order and of what the rollbacks were handed once it is seen to agree with
 * its rows: it was rolled back when and only when its start marker landed, and it was handed
 * its output when and only when its result landed.
 */
function comparable(
  run: Awaited<ReturnType<typeof runSagaProgram>>,
  inFlight: ReturnType<typeof rowsARefusalMayLeaveOut>,
) {
  const { state, failure, outcome, checkpoints, undone, handed } = run
  const whole = { state, failure, outcome, checkpoints, undone, handed }
  if (inFlight === undefined) return whole
  const { [inFlight.site]: handedTheFirst, ...handedTheRest } = handed
  const holds = (name: string): Row | undefined =>
    checkpoints.find((row) => row.checkpoint_name === name)
  const result = holds(inFlight.key)
  const rolledBack = undone.includes(inFlight.site)
  expect({
    startMarkerLanded: holds(`${SAGA_STARTED_PREFIX}${inFlight.key}`) !== undefined,
    rollbackRecorded: holds(`${SAGA_ROLLBACK_PREFIX}${inFlight.key}`) !== undefined,
    handed: handedTheFirst,
    place: undone.indexOf(inFlight.site),
  }).toEqual({
    startMarkerLanded: rolledBack,
    rollbackRecorded: rolledBack,
    // It started last of all, so it is rolled back first.
    place: rolledBack ? 0 : -1,
    handed: rolledBack
      ? fingerprint(result === undefined ? undefined : JSON.parse(result.state))
      : undefined,
  })
  return {
    ...whole,
    checkpoints: withoutTheRowsInFlight(checkpoints, inFlight.rows),
    undone: undone.filter((site) => site !== inFlight.site),
    handed: handedTheRest,
  }
}

async function runSagaProgram(
  program: SagaProgram,
  seed: string,
  failAtCall: number,
  fault: FaultKind = 'outage',
  tamper: (store: SchedulerStore) => SchedulerStore = (store) => store,
) {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const real = new LibsqlSchedulerStore(raw, seededIdSource(new Rng(seed)))
    let calls = 0
    const methods: string[] = []
    const store = new Proxy(tamper(real), {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          methods.push(String(prop))
          if (calls === failAtCall) {
            return Promise.reject(meetsFault(String(prop), injectedFault(fault)))
          }
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
    expect(await engineHistoryViolations(raw)).toEqual([])
    const undos = effects.log.filter((line) => line.startsWith('undo:'))
    return {
      calls,
      /** The SDK's store calls, by method, in the order they were made. */
      methods,
      state: result?.state,
      failure: result?.failureReasonJson,
      outcome: result?.rollback?.outcome,
      checkpoints: withoutOrderMarkers(cps?.rows ?? []).map(
        (row): Row => ({ checkpoint_name: String(row.checkpoint_name), state: String(row.state) }),
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

/** A generated saga does what its program says with no fault, and ends the same at every fault point. */
async function sagaReplaysAsItsReference(title: string, program: SagaProgram): Promise<void> {
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
  const inFlight = rowsARefusalMayLeaveOut(program)
  const comparedTo = comparable(reference, inFlight)
  // A refused group is admitted, as a plain program's is, when the outage takes the failing
  // pass's own `fail` call (see everyFaultPointRefusesTheGroup): both members start and the
  // task ends with the program's own failure. That call is run apart and pinned.
  const admittedAt = inFlight === undefined ? undefined : reference.methods.indexOf('fail') + 1
  for (const call of faultPoints(reference.calls).filter((point) => point !== admittedAt)) {
    for (const fault of FAULT_KINDS) {
      const faulted = await landing(fault, () =>
        runSagaProgram(program, faultSeed(`saga-fault-${title}-${call}`, fault), call, fault),
      )
      expect(
        comparable(faulted, inFlight),
        `${fault} at call ${call} of ${reference.calls}`,
      ).toEqual(comparedTo)
      // The record is exactly once, which the checkpoint table holds. The effect is at
      // least once, and a second run needs a fault between the handler and its record.
      const repeats = Object.values(faulted.undoCounts).filter((n) => n !== 1)
      expect(repeats.every((n) => n === 2) && repeats.length <= 1, `${fault} at call ${call}`).toBe(
        true,
      )
    }
  }
  if (admittedAt !== undefined) {
    const sites = flat(program.ops)
    const [, later] = (refusedGroupOf(program.ops)?.members ?? []).map((op) => sites.indexOf(op))
    for (const fault of FAULT_KINDS) {
      const admitted = await landing(fault, () =>
        runSagaProgram(
          program,
          faultSeed(`saga-fault-${title}-${admittedAt}`, fault),
          admittedAt,
          fault,
        ),
      )
      expect(
        {
          state: admitted.state,
          failure: (JSON.parse(admitted.failure ?? 'null') as { message?: string } | null)?.message,
          laterMemberStarted: admitted.undone.includes(later ?? -1),
        },
        `known gap: the ${fault} on the failing pass's own fail call (call ${admittedAt}) admits the group`,
      ).toEqual({
        state: 'failed',
        failure: 'the program failed for good',
        laterMemberStarted: true,
      })
    }
  }
}

/** The generated sagas this file runs at every fault point: eight of random ops, and one for each shape. */
const SAGA_RUN_PROGRAMS: readonly (readonly [string, SagaProgram])[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(
    (seed) =>
      [`saga program ${seed}`, generateSagaProgram(new Rng(`saga-program-${seed}`))] as const,
  ),
  ...SAGA_SHAPE_NAMES.map(
    (shape) => [shape, generateSagaProgram(new Rng(`saga-shape-${shape}`), shape)] as const,
  ),
  [
    'a registered step beside a sleep, whose body fails for good',
    failingInsideItsGroup(
      generateSagaProgram(
        new Rng('saga-shape-a registered step beside a sleep'),
        'a registered step beside a sleep',
      ),
    ),
  ] as const,
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
      // The registered mutants that the saga generated for a shape is the owner of.
      const verdict = (
        {
          'two registered steps started together, which the engine refuses':
            'mutation-verdict:behavior:saga-replay-harness-sees-two-steps-start-together',
          'steps named after the attempt, and a rollback that fails once':
            'mutation-verdict:behavior:saga-replay-harness-sees-the-attempt-a-pass-replays-as',
        } as Record<string, string | undefined>
      )[title]
      await owning(verdict, () => sagaReplaysAsItsReference(title, program))
    }, 120_000)
  }
})

describe('the fault sweeps of this file, taken together (a fault that never lands proves nothing)', () => {
  it('failed every store method they failed at all with an outage and with a permanent answer', () => {
    // This case reads what the cases above did, so it is the last one, and a run that
    // filters them out fails it: a floor met by nothing is not met.
    const lacking = [...faultsMet]
      .filter(([, kinds]) => kinds.size < 2)
      .map(([method, kinds]) => `${method} met only ${[...kinds].sort().join(', ')}`)
      .sort()
    expect({ methodsFailed: faultsMet.size >= 12, lacking }).toEqual({
      methodsFailed: true,
      lacking: [],
    })
  })
})
