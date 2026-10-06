import {
  type ClaimedRun,
  type HeldRetention,
  type HeldSchedulerStore,
  type PurgedUnit,
  type RetentionPolicy,
  type SqlRow,
  isLiveState,
  isTerminalState,
  purgeWalk,
} from '@durablerun/core'
import { Rng } from '@durablerun/harness'
import { describe, expect, it } from 'vitest'
import { engineHistoryViolations } from './engine-history.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { type ProtocolSnapshot, snapshot } from './poison-matrix.js'
import {
  type KeptBy,
  UNIT_TABLES,
  type UnitTable,
  dumpDifferences,
  purgeOracle,
} from './retention-oracle.js'
import { awaitTaskOwned, checkpointOwned, withFixture } from './scenario.js'

/**
 * The simulated week (DESIGN.md §3.12, BUILD.md exit test line 43): 168 hourly arrivals of
 * a seeded mix of tasks, driven through the store's own ports under fake time, with a
 * purge pass every simulated hour. The same week is run a second time with no purge, the
 * control, and everything said of the purged week is said beside it: what each pass took
 * equals what the model lets go, the rows a queue holds at each day boundary are at most
 * the control's rows for the units the model still holds, and every arrival ends in the
 * state and at the instant its seed assigns.
 *
 * The two runs mint different ids, because a purge takes a token from the fixture's id
 * stream. So nothing here is keyed by a task's id: every task is named by its slot, the
 * hour its arrival came in and its part in that arrival.
 */

const Q = 'soak'
const START_MS = 1_000_000
const HOUR_MS = 3_600_000

/** How many hours the week has, and so how many arrivals. */
export const SOAK_HOURS = 168

/** The seed the mix is drawn from. */
export const SOAK_SEED = 1

/**
 * The windows of the soak: 12 hours for a completed and for a cancelled task, 48 for a
 * failed one. They are test values. The windows of a deployment are its operator's.
 */
export const SOAK_POLICY: RetentionPolicy = Object.freeze({
  completedSeconds: 12 * 3_600,
  cancelledSeconds: 12 * 3_600,
  failedSeconds: 48 * 3_600,
})

/** The longest window of the soak's policy, in hours. */
const LONGEST_WINDOW_HOURS =
  Math.max(
    SOAK_POLICY.completedSeconds,
    SOAK_POLICY.cancelledSeconds,
    SOAK_POLICY.failedSeconds ?? 0,
  ) / 3_600

/**
 * The last hour a pass runs at. No arrival comes after the week, and the passes go on for
 * the longest window, by when everything the week left has ended and been let go.
 */
export const SOAK_LAST_HOUR = SOAK_HOURS + LONGEST_WINDOW_HOURS

/** The hours the bound is read at: each day boundary after hour 48. */
export const SOAK_DAY_BOUNDARIES = [72, 96, 120, 144, 168] as const

/**
 * What an arrival is.
 *
 * - `digest`: one task under an idempotency key that takes one step, sleeps once and
 *   completes inside its hour. It is the shape of a recurring workflow's period.
 * - `awaited-child`: a parent that spawns a child, awaits it, and completes when the
 *   child's completion wakes it.
 * - `parent-fails`: a parent that spawns a child, awaits it, and fails for good in the pass
 *   the child's completion woke. Its failed run holds the child's outcome and it is a
 *   failed parent, so the child's unit is kept by both until the parent's own unit goes.
 * - `parent-sleeps`: a parent whose child completes at once and that then sleeps past the
 *   child's window before it reads the child and completes. A live parent keeps its child.
 * - `retried`: a task that fails for good and that an operator revives hours later.
 * - `cancelled`: a task that an operator cancels an hour after it arrived, asleep.
 */
export const SOAK_KINDS = [
  'digest',
  'awaited-child',
  'parent-fails',
  'parent-sleeps',
  'retried',
  'cancelled',
] as const
export type SoakKind = (typeof SOAK_KINDS)[number]

const DIGEST_SLEEP_SECONDS = 600
/**
 * How long an awaited child works: past the end of the hour it arrived in, so its parent
 * is parked on it, with a wait, when the next hour's rows are read.
 */
const CHILD_WORK_SECONDS = 5_400
/** Past the 12 hours a completed child is kept for. */
const PARENT_SLEEP_HOURS = 14
const RETRIED_AFTER_HOURS = 6
const CANCELLED_AFTER_HOURS = 1
/** A cancelled task sleeps past the hour its cancellation comes in. */
const CANCELLED_SLEEP_HOURS = 3

type Role = 'main' | 'child'
type Rows = Record<UnitTable, number>
/** How a task ended: its state, and the instant. */
type Ending = { state: string; endedAtMs: number }

const NO_ROWS: Rows = Object.freeze({ tasks: 0, runs: 0, checkpoints: 0, waits: 0, events: 0 })

/** The kind of each hour's arrival, drawn from the seed. */
export function soakMix(seed: number | string = SOAK_SEED): SoakKind[] {
  const rng = new Rng(`retention-soak-${seed}`)
  return Array.from({ length: SOAK_HOURS }, () => rng.pick(SOAK_KINDS))
}

const instantOf = (hour: number): number => START_MS + hour * HOUR_MS
const slotOf = (hour: number, role: Role): string => `${hour}/${role}`

/** How one task of an arrival ends: its state, and the instant by the database's clock. */
export interface AssignedEnding {
  readonly slot: string
  readonly state: 'completed' | 'failed' | 'cancelled'
  readonly endedAtMs: number
}

/** What the seed assigns each task of an arrival: the state it ends in, and when. */
export function assignedEndings(hour: number, kind: SoakKind): AssignedEnding[] {
  const at = instantOf(hour)
  const main = (state: AssignedEnding['state'], afterMs: number): AssignedEnding => ({
    slot: slotOf(hour, 'main'),
    state,
    endedAtMs: at + afterMs,
  })
  const child = (afterMs: number): AssignedEnding => ({
    slot: slotOf(hour, 'child'),
    state: 'completed',
    endedAtMs: at + afterMs,
  })
  const childWorkMs = CHILD_WORK_SECONDS * 1_000
  switch (kind) {
    case 'digest':
      return [main('completed', DIGEST_SLEEP_SECONDS * 1_000)]
    case 'awaited-child':
      return [main('completed', childWorkMs), child(childWorkMs)]
    case 'parent-fails':
      return [main('failed', childWorkMs), child(childWorkMs)]
    case 'parent-sleeps':
      return [main('completed', PARENT_SLEEP_HOURS * HOUR_MS), child(0)]
    case 'retried':
      return [main('completed', RETRIED_AFTER_HOURS * HOUR_MS)]
    case 'cancelled':
      return [main('cancelled', CANCELLED_AFTER_HOURS * HOUR_MS)]
  }
}

/** One task of the week, as the scripted worker knows it. */
interface Actor {
  readonly slot: string
  readonly hour: number
  readonly kind: SoakKind
  readonly role: Role
  /** How many passes of the task the worker has run. */
  passes: number
}

const FAILURE = '{"name":"SoakFailure"}'
const SPAWN_MEMO = '$spawn:child'
const SLEEP_MARKER = '$sleep'

/** The week's driver, worker and operator over one fixture. Everything goes through a port. */
class Week {
  readonly store: HeldSchedulerStore
  readonly actors = new Map<string, Actor>()
  readonly taskOf = new Map<string, string>()
  /** What an operator does at the start of an hour, by hour. */
  private readonly operatorActs = new Map<number, (() => Promise<void>)[]>()
  private claims = 0
  swept = 0
  /** Operator acts that changed nothing: a revival or a cancellation the store refused. */
  operatorMisses = 0
  /** What the history checkers found, at each day boundary and at the end. */
  readonly violations: string[] = []

  constructor(private readonly f: StoreFixture) {
    this.store = f.storeOver(f.raw)
  }

  private enrol(taskId: string, hour: number, kind: SoakKind, role: Role): void {
    const slot = slotOf(hour, role)
    this.actors.set(taskId, { slot, hour, kind, role, passes: 0 })
    this.taskOf.set(slot, taskId)
  }

  private at(hour: number, act: () => Promise<void>): void {
    const acts = this.operatorActs.get(hour) ?? []
    acts.push(act)
    this.operatorActs.set(hour, acts)
  }

  /** The hour's arrival, and what an operator will do to it later. */
  async arrive(hour: number, kind: SoakKind): Promise<void> {
    const spawned = await this.store.spawn(
      Q,
      kind === 'digest' ? 'periodic-digest' : kind,
      JSON.stringify({ period: hour }),
      {
        ...(kind === 'digest' ? { idempotencyKey: `digest-${hour}` } : {}),
        ...(kind === 'parent-fails' || kind === 'retried' ? { maxAttempts: 1 } : {}),
      },
    )
    if (!spawned.created) throw new Error(`soak: the arrival of hour ${hour} found its task there`)
    this.enrol(spawned.taskId, hour, kind, 'main')
    if (kind === 'retried') {
      this.at(hour + RETRIED_AFTER_HOURS, async () => {
        if ((await this.store.retryTask(Q, spawned.taskId)) === null) this.operatorMisses += 1
      })
    }
    if (kind === 'cancelled') {
      this.at(hour + CANCELLED_AFTER_HOURS, async () => {
        if (!(await this.store.cancelTask(Q, spawned.taskId))) this.operatorMisses += 1
      })
    }
  }

  async operate(hour: number): Promise<void> {
    for (const act of this.operatorActs.get(hour) ?? []) await act()
  }

  /**
   * The driver from one instant to the end of its hour: sweep, claim what is due and run
   * each claimed run's next pass, and when nothing is due move the clock to the queue's
   * next wake, for as long as that wake is inside the hour.
   */
  async drive(fromMs: number, untilMs: number): Promise<void> {
    let now = fromMs
    for (;;) {
      await this.runWhatIsDue()
      const next = await this.store.nextWakeAtEpochMs(Q)
      if (next === null || next >= untilMs) return
      if (next <= now) throw new Error(`soak: the next wake ${next} is not after ${now}`)
      now = next
      await this.f.admin.setFakeNowEpochMs(now)
    }
  }

  private async runWhatIsDue(): Promise<void> {
    for (;;) {
      this.swept += (await this.store.sweep(Q, 100)).length
      this.claims += 1
      const runs = await this.store.claim(Q, `soak-worker-${this.claims}`, {
        leaseSeconds: 60,
        limit: 50,
      })
      if (runs.length === 0) return
      for (const run of runs) {
        const started = await this.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        if (started === null) throw new Error(`soak: the run of ${run.taskId} did not start`)
        await this.pass(started)
      }
    }
  }

  private async sleep(run: ClaimedRun, seconds: number): Promise<void> {
    const wake = { inSeconds: seconds }
    await this.store.suspendRun(Q, run.runId, run.claimToken, wake, {
      key: SLEEP_MARKER,
      stateJson: JSON.stringify(wake),
    })
  }

  private step(run: ClaimedRun, name: string, state: unknown): Promise<void> {
    return checkpointOwned(this.store, Q, run, name, JSON.stringify(state), 60)
  }

  /** Spawn the arrival's child as `ctx.spawn` does: under the parent's claim, with its memo. */
  private async spawnChild(run: ClaimedRun, actor: Actor): Promise<string> {
    const child = await this.store.spawn(Q, 'child', JSON.stringify({ period: actor.hour }), {
      childOf: {
        parentQueue: Q,
        parentTaskId: run.taskId,
        runId: run.runId,
        claimToken: run.claimToken,
        replayKey: SPAWN_MEMO,
      },
    })
    if (!child.created) throw new Error(`soak: ${actor.slot} found its child there`)
    this.enrol(child.taskId, actor.hour, actor.kind, 'child')
    await this.step(run, SPAWN_MEMO, { taskId: child.taskId, queue: Q })
    return child.taskId
  }

  private childOf(actor: Actor): string {
    const child = this.taskOf.get(slotOf(actor.hour, 'child'))
    if (child === undefined) throw new Error(`soak: ${actor.slot} has no child`)
    return child
  }

  /** The next pass of a claimed run, by its task's part in its arrival. */
  private async pass(run: ClaimedRun): Promise<void> {
    const actor = this.actors.get(run.taskId)
    if (actor === undefined)
      throw new Error(`soak: a claim took ${run.taskId}, which no arrival made`)
    actor.passes += 1
    const first = actor.passes === 1
    const { store } = this
    const complete = () =>
      store.complete(Q, run.runId, run.claimToken, JSON.stringify({ [actor.role]: actor.hour }))
    const awaitStep = (child: string) => `$await-task:${child}`
    if (actor.role === 'child') {
      if (first) {
        await this.step(run, 'work', { period: actor.hour })
        if (actor.kind === 'parent-sleeps') return complete()
        return this.sleep(run, CHILD_WORK_SECONDS)
      }
      return complete()
    }
    switch (actor.kind) {
      case 'digest': {
        if (!first) return complete()
        await this.step(run, 'observe', { ref: `ref-${actor.hour}` })
        return this.sleep(run, DIGEST_SLEEP_SECONDS)
      }
      case 'awaited-child':
      case 'parent-fails': {
        if (first) {
          const child = await this.spawnChild(run, actor)
          const parked = await awaitTaskOwned(store, Q, run, awaitStep(child), child, null)
          if (parked.emitted) throw new Error(`soak: ${actor.slot} found its child ended`)
          return
        }
        if (run.wake === undefined || !('payloadJson' in run.wake)) {
          throw new Error(`soak: ${actor.slot} was claimed with no outcome of its child`)
        }
        if (actor.kind === 'parent-fails') {
          const failed = await store.fail(Q, run.runId, run.claimToken, FAILURE, null)
          if (failed.rollingBack) throw new Error(`soak: ${actor.slot} began a saga`)
          return
        }
        await this.step(run, run.wake.step, { payloadJson: run.wake.payloadJson })
        return complete()
      }
      case 'parent-sleeps': {
        if (first) {
          await this.spawnChild(run, actor)
          return this.sleep(run, PARENT_SLEEP_HOURS * 3_600)
        }
        const child = this.childOf(actor)
        const read = await awaitTaskOwned(store, Q, run, awaitStep(child), child, null)
        if (!read.emitted) throw new Error(`soak: ${actor.slot} parked on a child that had ended`)
        await this.step(run, awaitStep(child), { payloadJson: read.payloadJson })
        return complete()
      }
      case 'retried': {
        if (!first) return complete()
        await this.step(run, 'try', { period: actor.hour })
        await store.fail(Q, run.runId, run.claimToken, FAILURE, null)
        return
      }
      case 'cancelled': {
        if (!first) throw new Error(`soak: ${actor.slot} ran after its cancellation`)
        await this.step(run, 'work', { period: actor.hour })
        return this.sleep(run, CANCELLED_SLEEP_HOURS * 3_600)
      }
    }
  }
}

/** A task's row as a sample: `live`, or its ended state with what it ended with. */
function sampleOf(task: SqlRow): string {
  if (isLiveState(task.state)) return 'live'
  return `${String(task.state)} payload=${String(task.completed_payload)} reason=${String(task.failure_reason)}`
}

const tasksOf = (dump: ProtocolSnapshot): SqlRow[] => dump.tasks.filter((task) => task.queue === Q)

const unitOf = (task: SqlRow) => ({
  taskId: String(task.task_id),
  ...(task.idempotency_key === null ? {} : { idempotencyKey: String(task.idempotency_key) }),
})

/**
 * The waits of the queue in a dump, by whether their run is live. A run's waits go in the
 * batch that ends the run, so a wait of a run that is not live is a row no engine path
 * leaves, and it is the only kind of wait a purge could take with a unit.
 */
function waitsByRun(dump: ProtocolSnapshot): { ofLiveRuns: number; ofEndedRuns: number } {
  const live = new Set(
    dump.runs.filter((run) => isLiveState(run.state)).map((run) => String(run.run_id)),
  )
  const waits = dump.waits.filter((wait) => wait.queue === Q)
  const ofLiveRuns = waits.filter((wait) => live.has(String(wait.run_id))).length
  return { ofLiveRuns, ofEndedRuns: waits.length - ofLiveRuns }
}

/** How many rows of each counted table the queue holds, as `sizes --queue` reads them. */
async function sizes(f: StoreFixture): Promise<Rows> {
  const { tables } = await f.operatorReadsOver(f.raw).tableRows(Q)
  return Object.fromEntries(UNIT_TABLES.map((table) => [table, tables[table].count])) as Rows
}

/** Options of a week, for a case that shows a hold can fail. */
export interface SoakOptions {
  readonly policy?: RetentionPolicy
  /** Hours, from the first to before the second, in which the driver claims nothing. */
  readonly driverStopped?: readonly [number, number]
}

/** What the control run leaves for the purged run to be read beside. */
export interface SoakControl {
  readonly mix: readonly SoakKind[]
  /** Each hour's samples of every task there is, by slot, read at the start of the hour. */
  readonly samples: readonly Readonly<Record<string, string>>[]
  /** At each day boundary: the queue's rows, and each unit's rows by slot. */
  readonly boundaries: ReadonlyMap<
    number,
    {
      readonly sizes: Rows
      readonly unitRows: ReadonlyMap<string, Rows>
      readonly strayWaits: number
    }
  >
  readonly violations: readonly string[]
  /** How each slot ended, read at the end. */
  readonly ended: ReadonlyMap<string, Ending>
  /** The rows of each `digest` unit at the end, as distinct shapes. */
  readonly digestUnits: readonly Rows[]
  readonly swept: number
  readonly operatorMisses: number
}

/**
 * The hours of a week, each with what both runs do in it, in order. The history checkers
 * read at each day boundary, before that hour's own work, and once more at the end.
 */
async function hours(
  f: StoreFixture,
  mix: readonly SoakKind[],
  options: SoakOptions,
  startOfHour: (hour: number, nowMs: number) => Promise<void>,
): Promise<Week> {
  const week = new Week(f)
  const [stoppedFrom, stoppedTo] = options.driverStopped ?? [0, 0]
  for (let hour = 0; hour <= SOAK_LAST_HOUR; hour++) {
    const now = instantOf(hour)
    await f.admin.setFakeNowEpochMs(now)
    if (hour > 0 && hour % 24 === 0) {
      // A week is thousands of batches inside one fixture, and on a store whose batches
      // never leave the process none of them lets the event loop turn. Every fixture gives
      // it a turn here, once a simulated day.
      await f.turn()
      for (const found of await engineHistoryViolations(f.raw)) {
        week.violations.push(`day ${hour / 24}: ${found}`)
      }
    }
    await startOfHour(hour, now)
    const kind = mix[hour]
    if (kind !== undefined) await week.arrive(hour, kind)
    await week.operate(hour)
    if (hour >= stoppedFrom && hour < stoppedTo) continue
    await week.drive(now, instantOf(hour + 1))
  }
  await f.admin.setFakeNowEpochMs(instantOf(SOAK_LAST_HOUR + 1))
  for (const found of await engineHistoryViolations(f.raw))
    week.violations.push(`the end: ${found}`)
  return week
}

function endedOf(bySlot: ReadonlyMap<string, SqlRow>, into: Map<string, Ending>) {
  for (const [slot, task] of bySlot) {
    if (isTerminalState(task.state)) {
      into.set(slot, { state: String(task.state), endedAtMs: Number(task.fence_at_ms) })
    } else {
      into.delete(slot)
    }
  }
}

/** The week with no purge: what every answer about the purged week is read beside. */
export async function soakControl(
  makeFixture: StoreFixtureFactory,
  seed: number | string = SOAK_SEED,
): Promise<SoakControl> {
  const mix = soakMix(seed)
  return withFixture(makeFixture, `soak-control-${seed}`, async (f) => {
    const samples: Record<string, string>[] = []
    const boundaries = new Map<
      number,
      { sizes: Rows; unitRows: Map<string, Rows>; strayWaits: number }
    >()
    const unitRowsOf = (dump: ProtocolSnapshot, nowMs: number, bySlot: Map<string, SqlRow>) =>
      new Map(
        [...bySlot].map(([slot, task]) => [
          slot,
          purgeOracle(dump, nowMs, Q, unitOf(task), SOAK_POLICY).rows,
        ]),
      )
    const made = await hours(f, mix, {}, async (hour, nowMs) => {
      const dump = await snapshot(f.raw)
      const bySlot = slotsByRow(dump)
      samples.push(Object.fromEntries([...bySlot].map(([slot, task]) => [slot, sampleOf(task)])))
      if ((SOAK_DAY_BOUNDARIES as readonly number[]).includes(hour)) {
        boundaries.set(hour, {
          sizes: await sizes(f),
          unitRows: unitRowsOf(dump, nowMs, bySlot),
          strayWaits: waitsByRun(dump).ofEndedRuns,
        })
      }
    })
    const end = await snapshot(f.raw)
    const bySlot = slotsByRow(end)
    // The two namings agree: the slot read from a task's own row is the slot its week gave it.
    for (const [slot, task] of bySlot) {
      const given = made.actors.get(String(task.task_id))?.slot
      if (given !== slot) throw new Error(`soak: ${slot} was made as ${String(given)}`)
    }
    const ended = new Map<string, Ending>()
    endedOf(bySlot, ended)
    const digestUnits = new Map<string, Rows>()
    for (const [slot, rows] of unitRowsOf(end, instantOf(SOAK_LAST_HOUR + 1), bySlot)) {
      const hour = Number(slot.slice(0, slot.indexOf('/')))
      if (mix[hour] === 'digest') digestUnits.set(JSON.stringify(rows), rows)
    }
    return {
      mix,
      samples,
      boundaries,
      violations: made.violations,
      ended,
      digestUnits: [...digestUnits.values()],
      swept: made.swept,
      operatorMisses: made.operatorMisses,
    }
  })
}

/**
 * The slot of a task, read from its own row: the period its parameters name, and whether
 * a task spawned it. Every task of the week is spawned with its period in its parameters.
 */
function slotByRow(task: SqlRow): string {
  const { period } = JSON.parse(String(task.params)) as { period: number }
  return slotOf(period, task.task_name === 'child' ? 'child' : 'main')
}

/** Every task of the queue in a dump, by its slot. */
function slotsByRow(dump: ProtocolSnapshot): Map<string, SqlRow> {
  return new Map(tasksOf(dump).map((task) => [slotByRow(task), task]))
}

/** The most units one pass of the week may take: more than the week ever holds. */
const SOAK_PASS_LIMIT = 1_000

/**
 * One pass of the purge: core's one walk, which is the pass an operator's `purge` runs. It
 * is applied until it lets nothing more go, within bounds no pass of the week reaches, and
 * a pass that stopped at one fails the week.
 */
async function purgePass(retention: HeldRetention, policy: RetentionPolicy): Promise<PurgedUnit[]> {
  const walked = await purgeWalk(retention, Q, policy, { limit: SOAK_PASS_LIMIT, execute: true })
  if (walked.failed !== null) throw walked.failed.error
  if (walked.more) throw new Error('soak: a pass stopped at a bound of the walk')
  return walked.taken.map(({ candidate, rows }) => {
    if (rows === null) throw new Error(`soak: the purge of ${candidate.taskId} answered no rows`)
    return { taskId: candidate.taskId, rows }
  })
}

/**
 * What the model lets one pass take: every unit the oracle lets go over the dump, and
 * then every unit it lets go once those are gone, until it lets nothing more go. A parent's
 * purge lets its child go, so one pass takes both.
 */
function modelPass(
  dump: ProtocolSnapshot,
  nowMs: number,
  policy: RetentionPolicy,
): { gone: string[]; after: ProtocolSnapshot; kept: Map<string, readonly KeptBy[]> } {
  let after = dump
  const gone: string[] = []
  // What keeps each unit that is left. The last walk lets nothing go, so every entry it
  // writes is read over the rows the pass leaves.
  const kept = new Map<string, readonly KeptBy[]>()
  for (let changed = true; changed; ) {
    changed = false
    kept.clear()
    for (const task of tasksOf(after)) {
      const oracle = purgeOracle(after, nowMs, Q, unitOf(task), policy)
      if (oracle.keptBy.length > 0) {
        kept.set(String(task.task_id), oracle.keptBy)
        continue
      }
      after = oracle.after
      gone.push(String(task.task_id))
      changed = true
    }
  }
  return { gone, after, kept }
}

/** What a purged week showed, each list empty and each count as measured when it is clean. */
export interface SoakReport {
  readonly arrivals: number
  readonly slots: number
  /** A pass whose purged set is not the model's, or that left a table other than the model's. */
  readonly passMismatches: readonly string[]
  readonly passesThatPurged: number
  /** A sample, read before a pass, that is not the control's for that slot and hour. */
  readonly outcomeMismatches: readonly string[]
  /** How many samples of an ended task were compared. */
  readonly outcomesCompared: number
  /** At each day boundary: the queue's rows, the bound, and the control's rows. */
  readonly boundaries: readonly {
    readonly hour: number
    readonly retained: Rows
    readonly bound: Rows
    readonly control: Rows
  }[]
  readonly violations: readonly string[]
  /** The rows the purges of the week reported, summed by table. */
  readonly purgedRows: Rows
  readonly purgedUnits: number
  /** Units a pass kept that were a window old: by their parent alone, by their parent, by a run that holds their outcome. */
  readonly keptByParentAlone: number
  readonly keptByParent: number
  readonly keptByCarry: number
  /** Ended units a pass kept as younger than their window. */
  readonly keptByAge: number
  /** A unit a pass kept for a reason the week's mix does not hold. */
  readonly keptOtherwise: readonly string[]
  /** Slots that did not end in the state and at the instant the seed assigns. */
  readonly notAsAssigned: readonly string[]
  readonly endedAsAssigned: number
  /** Waits of a run that is not live, over every dump read before a pass, and in the control's boundaries. */
  readonly strayWaits: { readonly retained: number; readonly control: number }
  /** Waits of a live run, over every dump read before a pass: a parent parked on its child. */
  readonly liveWaits: number
  /** What the queue holds once the last window has passed. */
  readonly left: Rows
  readonly swept: number
  readonly operatorMisses: number
}

const sum = (rows: Iterable<Rows>): Rows => {
  const total = { ...NO_ROWS }
  for (const one of rows) for (const table of UNIT_TABLES) total[table] += one[table]
  return total
}

/** The purged week, read beside the control. */
export async function soakWeek(
  makeFixture: StoreFixtureFactory,
  control: SoakControl,
  options: SoakOptions = {},
): Promise<SoakReport> {
  const policy = options.policy ?? SOAK_POLICY
  return withFixture(makeFixture, 'soak-retained', async (f) => {
    const retention = f.retentionOver(f.raw)
    const passMismatches: string[] = []
    const outcomeMismatches: string[] = []
    const boundaries: { hour: number; retained: Rows; bound: Rows; control: Rows }[] = []
    /** Slots the model has let go, through the pass before this hour's. */
    const modelGone = new Set<string>()
    const ended = new Map<string, Ending>()
    const keptByParentAlone = new Set<string>()
    const keptByParent = new Set<string>()
    const keptByCarry = new Set<string>()
    const keptByAge = new Set<string>()
    const keptOtherwise = new Set<string>()
    const purged: PurgedUnit[] = []
    let passesThatPurged = 0
    let outcomesCompared = 0
    let strayWaits = 0
    let liveWaits = 0

    const week = await hours(f, control.mix, options, async (hour, nowMs) => {
      const dump = await snapshot(f.raw)
      const waits = waitsByRun(dump)
      strayWaits += waits.ofEndedRuns
      liveWaits += waits.ofLiveRuns
      const bySlot = slotsByRow(dump)
      const slotById = new Map([...bySlot].map(([slot, task]) => [String(task.task_id), slot]))
      const slotOfTask = (taskId: string): string => slotById.get(taskId) ?? `no task ${taskId}`
      endedOf(bySlot, ended)

      // Outcomes, sampled before the pass, beside the control's of the same hour.
      for (const [slot, expected] of Object.entries(control.samples[hour] ?? {})) {
        const task = bySlot.get(slot)
        const observed = task === undefined ? 'gone' : sampleOf(task)
        const wanted = modelGone.has(slot) ? 'gone' : expected
        if (wanted !== 'gone' && wanted !== 'live') outcomesCompared += 1
        if (observed !== wanted && outcomeMismatches.length < 20) {
          outcomeMismatches.push(`hour ${hour}, ${slot}: ${observed}, and the control ${wanted}`)
        }
      }

      // The bound, at a day boundary, before the pass: the control's rows of every unit the
      // model still held after the pass an hour ago.
      const boundary = control.boundaries.get(hour)
      if (boundary !== undefined) {
        boundaries.push({
          hour,
          retained: await sizes(f),
          bound: sum(
            [...boundary.unitRows].filter(([slot]) => !modelGone.has(slot)).map(([, rows]) => rows),
          ),
          control: boundary.sizes,
        })
      }

      // The pass, beside what the model lets it take.
      const model = modelPass(dump, nowMs, policy)
      const won = await purgePass(retention, policy)
      purged.push(...won)
      if (won.length > 0) passesThatPurged += 1
      const took = won.map((unit) => slotOfTask(unit.taskId)).sort()
      const letGo = model.gone.map(slotOfTask).sort()
      if (JSON.stringify(took) !== JSON.stringify(letGo) && passMismatches.length < 20) {
        passMismatches.push(
          `hour ${hour}: the pass took [${took.join(', ')}], and the model lets go [${letGo.join(', ')}]`,
        )
      }
      const differences = dumpDifferences(model.after, await snapshot(f.raw))
      if (differences.length > 0 && passMismatches.length < 20) {
        passMismatches.push(
          `hour ${hour}: ${differences.length} rows differ from what the model leaves: ${differences.slice(0, 2).join('; ')}`,
        )
      }
      for (const slot of letGo) modelGone.add(slot)
      for (const [taskId, keptBy] of model.kept) {
        const slot = slotOfTask(taskId)
        if (keptBy.includes('state')) continue
        if (keptBy.includes('age')) {
          keptByAge.add(slot)
          continue
        }
        if (keptBy.includes('parent')) keptByParent.add(slot)
        if (keptBy.includes('carry')) keptByCarry.add(slot)
        if (keptBy.length === 1 && keptBy[0] === 'parent') keptByParentAlone.add(slot)
        const others = keptBy.filter((by) => by !== 'parent' && by !== 'carry')
        if (others.length > 0) keptOtherwise.add(`${slot}: ${others.join(', ')}`)
      }
    })

    const assigned = control.mix.flatMap((kind, hour) => assignedEndings(hour, kind))
    const notAsAssigned = assigned
      .filter(({ slot, state, endedAtMs }) => {
        const found = ended.get(slot)
        return found?.state !== state || found.endedAtMs !== endedAtMs
      })
      .map(({ slot, state, endedAtMs }) => {
        const found = ended.get(slot)
        return `${slot}: ${found === undefined ? 'not ended' : `${found.state} at ${found.endedAtMs}`}, assigned ${state} at ${endedAtMs}`
      })
    return {
      arrivals: control.mix.length,
      slots: assigned.length,
      passMismatches,
      passesThatPurged,
      outcomeMismatches,
      outcomesCompared,
      boundaries,
      violations: week.violations,
      purgedRows: sum(purged.map((unit) => unit.rows as Rows)),
      purgedUnits: purged.length,
      keptByParentAlone: keptByParentAlone.size,
      keptByParent: keptByParent.size,
      keptByCarry: keptByCarry.size,
      keptByAge: keptByAge.size,
      keptOtherwise: [...keptOtherwise].sort(),
      notAsAssigned: notAsAssigned.slice(0, 20),
      endedAsAssigned: assigned.length - notAsAssigned.length,
      strayWaits: {
        retained: strayWaits,
        control: [...control.boundaries.values()].reduce((all, one) => all + one.strayWaits, 0),
      },
      liveWaits,
      left: await sizes(f),
      swept: week.swept,
      operatorMisses: week.operatorMisses,
    }
  })
}

/** The tables an ended unit holds rows in. A run's waits go when the run ends, so `waits` is not one. */
export const ENDED_UNIT_TABLES = ['tasks', 'runs', 'checkpoints', 'events'] as const

/** Each counted table that held more rows at a day boundary than its bound. */
export function overTheBound(report: SoakReport): string[] {
  return report.boundaries.flatMap(({ hour, retained, bound }) =>
    UNIT_TABLES.filter((table) => retained[table] > bound[table]).map(
      (table) =>
        `hour ${hour}: ${table} holds ${retained[table]}, and the bound is ${bound[table]}`,
    ),
  )
}

/**
 * How far the control exceeds the bound, and what the purged week holds, at the end of day
 * 7, for each table an ended unit holds rows in, to one decimal place and rounded down. A
 * bound the control does not exceed says nothing: either the policy lets nothing go, and
 * the first ratio shows it, or the purge deletes nothing, and the second does.
 */
export function vacuityRatios(report: SoakReport): {
  controlOverTheBound: Record<string, number>
  controlOverThePurgedWeek: Record<string, number>
} {
  const day7 = report.boundaries.find(({ hour }) => hour === SOAK_HOURS)
  // A ratio is asked only of a control above zero. A control that holds no rows of a table
  // exceeds nothing, whatever it is read beside, so its ratio is 0 and not without bound.
  const ratio = (over: number, under: number): number =>
    over === 0 ? 0 : under === 0 ? Number.POSITIVE_INFINITY : Math.floor((over / under) * 10) / 10
  const ratios = (under: Rows | undefined) =>
    Object.fromEntries(
      ENDED_UNIT_TABLES.map((table) => [
        table,
        day7 === undefined || under === undefined ? 0 : ratio(day7.control[table], under[table]),
      ]),
    )
  return {
    controlOverTheBound: ratios(day7?.bound),
    controlOverThePurgedWeek: ratios(day7?.retained),
  }
}

/**
 * Why a week says nothing, each reason named: a table of which the control holds no rows
 * at the end of day 7, and each ratio of `vacuityRatios` that is under three for a table
 * the control does hold rows of.
 */
export function vacuous(report: SoakReport): string[] {
  const day7 = report.boundaries.find(({ hour }) => hour === SOAK_HOURS)
  const empty = ENDED_UNIT_TABLES.filter((table) => (day7?.control[table] ?? 0) === 0)
  return [
    ...empty.map((table) => `the control holds no rows of ${table}`),
    ...Object.entries(vacuityRatios(report)).flatMap(([which, byTable]) =>
      Object.entries(byTable)
        .filter(([table, ratio]) => ratio < 3 && !(empty as readonly string[]).includes(table))
        .map(([table, ratio]) => `${which} is ${ratio} for ${table}`),
    ),
  ]
}

/**
 * How long one case of the week may take. The first case that asks runs both weeks, and
 * the rest read what it left. In one run of the week's final form on each dialect, on a
 * loaded shared machine, both weeks took 19 seconds on libSQL, 35 on PostgreSQL and 21 on
 * MySQL, so this is seventeen times the slowest. The timing is kept here, and BUILD.md's
 * exit test line 43 states the same numbers.
 */
export const SOAK_TIMEOUT_MS = 600_000

/**
 * The rows one unit of the `digest` kind holds, which is the shape of one period of a
 * recurring workflow: a task, its one run, the checkpoint of its one step and the marker
 * of its one sleep, no wait, and its completion event.
 */
export const DIGEST_UNIT_ROWS: Readonly<Record<UnitTable, number>> = Object.freeze({
  tasks: 1,
  runs: 1,
  checkpoints: 2,
  waits: 0,
  events: 1,
})

/**
 * The simulated week on one dialect (BUILD.md exit test line 43). Every number below was
 * measured, and is the same on every dialect, because the week runs under fake time and
 * names its tasks by their slot. A case that shows each hold failing is in
 * `test/retention-soak-reds.test.ts`.
 */
export function retentionSoakConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`the simulated week [${dialect}]`, () => {
    let weeks: Promise<{ control: SoakControl; report: SoakReport }> | undefined
    const bothWeeks = async () => {
      const control = await soakControl(makeFixture)
      return { control, report: await soakWeek(makeFixture, control) }
    }
    const week = () => {
      weeks = weeks ?? bothWeeks()
      return weeks
    }

    it('draws 168 hourly arrivals from its seed, every kind among them, which make 253 tasks', () => {
      const mix = soakMix()
      const counted = Object.fromEntries(
        SOAK_KINDS.map((kind) => [kind, mix.filter((drawn) => drawn === kind).length]),
      )
      expect({
        counted,
        tasks: mix.flatMap((kind, hour) => assignedEndings(hour, kind)).length,
      }).toEqual({
        counted: {
          digest: 23,
          'awaited-child': 23,
          'parent-fails': 33,
          'parent-sleeps': 29,
          retried: 26,
          cancelled: 34,
        },
        tasks: 253,
      })
    })

    it(
      'each hourly pass takes exactly the units the model lets go, and leaves every table as the model leaves it',
      async () => {
        const { report } = await week()
        expect(
          {
            mismatches: report.passMismatches,
            passesThatPurged: report.passesThatPurged,
            purgedUnits: report.purgedUnits,
          },
          'mutation-verdict:behavior:retention-soak-holds-each-pass-to-the-age-of-its-units',
        ).toEqual({ mismatches: [], passesThatPurged: 131, purgedUnits: 253 })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      "at each day boundary after hour 48, every counted table holds at most the control's rows of the units the model still holds",
      async () => {
        const { report } = await week()
        expect(
          {
            over: overTheBound(report),
            readAt: report.boundaries.map(({ hour }) => hour),
            day7: report.boundaries[report.boundaries.length - 1],
          },
          'mutation-verdict:behavior:retention-soak-holds-the-rows-of-a-queue-to-the-bound',
        ).toEqual({
          over: [],
          readAt: [...SOAK_DAY_BOUNDARIES],
          day7: {
            hour: SOAK_HOURS,
            retained: { tasks: 43, runs: 44, checkpoints: 74, waits: 0, events: 39 },
            bound: { tasks: 43, runs: 44, checkpoints: 74, waits: 0, events: 39 },
            control: { tasks: 253, runs: 278, checkpoints: 443, waits: 0, events: 249 },
          },
        })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'by day 7 the control holds at least three times the bound, and three times what the purged week holds, in every table an ended unit holds rows in',
      async () => {
        const { report } = await week()
        const measured = { tasks: 5.8, runs: 6.3, checkpoints: 5.9, events: 6.3 }
        expect(
          { vacuous: vacuous(report), ratios: vacuityRatios(report) },
          'mutation-verdict:behavior:retention-soak-fails-as-vacuous-when-nothing-is-purged',
        ).toEqual({
          vacuous: [],
          ratios: { controlOverTheBound: measured, controlOverThePurgedWeek: measured },
        })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      "the outcomes sampled before each pass are the control's",
      async () => {
        const { report } = await week()
        expect({
          mismatches: report.outcomeMismatches,
          compared: report.outcomesCompared,
        }).toEqual({ mismatches: [], compared: 5_790 })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'the history checkers find nothing on any simulated day, in the purged week or in the control',
      async () => {
        const { control, report } = await week()
        expect({ purgedWeek: report.violations, control: control.violations }).toEqual({
          purgedWeek: [],
          control: [],
        })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'the purges take rows of every table an ended unit holds rows in, and the passes keep units by a parent, by a held outcome and by their age',
      async () => {
        const { report } = await week()
        const { waits: _waits, ...purgedRows } = report.purgedRows
        expect({
          purgedRows,
          keptByParentAlone: report.keptByParentAlone,
          keptByParent: report.keptByParent,
          keptByCarry: report.keptByCarry,
          keptByAge: report.keptByAge,
          keptOtherwise: report.keptOtherwise,
        }).toEqual({
          purgedRows: { tasks: 253, runs: 279, checkpoints: 447, events: 253 },
          // The children of the parents that sleep, while their parent is live.
          keptByParentAlone: 29,
          // And the children of the parents that fail, which a held outcome keeps too.
          keptByParent: 62,
          keptByCarry: 33,
          keptByAge: 253,
          keptOtherwise: [],
        })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'no wait outlives its run: every wait read belongs to a live run, and no purged unit held one',
      async () => {
        const { report } = await week()
        expect({
          ofEndedRuns: report.strayWaits,
          ofLiveRuns: report.liveWaits,
          purgedWaits: report.purgedRows.waits,
        }).toEqual({ ofEndedRuns: { retained: 0, control: 0 }, ofLiveRuns: 56, purgedWaits: 0 })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'all 168 arrivals end in the state and at the instant their seed assigns',
      async () => {
        const { control, report } = await week()
        const assigned = control.mix.flatMap((kind, hour) => assignedEndings(hour, kind))
        expect({
          arrivals: report.arrivals,
          notAsAssigned: report.notAsAssigned,
          endedAsAssigned: report.endedAsAssigned,
          inTheControl: assigned.filter(({ slot, state, endedAtMs }) => {
            const ended = control.ended.get(slot)
            return ended?.state === state && ended.endedAtMs === endedAtMs
          }).length,
          operatorMisses: [report.operatorMisses, control.operatorMisses],
          sweptByTheDriver: [report.swept, control.swept],
        }).toEqual({
          arrivals: SOAK_HOURS,
          notAsAssigned: [],
          endedAsAssigned: 253,
          inTheControl: 253,
          operatorMisses: [0, 0],
          sweptByTheDriver: [0, 0],
        })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'once the longest window has passed, the queue holds nothing',
      async () => {
        const { report } = await week()
        expect(report.left).toEqual({ tasks: 0, runs: 0, checkpoints: 0, waits: 0, events: 0 })
      },
      SOAK_TIMEOUT_MS,
    )

    it(
      'a unit of the digest kind holds one task, one run, two checkpoints, no wait and one completion event',
      async () => {
        const { control } = await week()
        expect(control.digestUnits).toEqual([DIGEST_UNIT_ROWS])
      },
      SOAK_TIMEOUT_MS,
    )
  })
}
