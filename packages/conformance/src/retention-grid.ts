import {
  type ClaimedRun,
  MAX_PURGE_UNIT_CHECKPOINTS,
  type PurgeUnitTarget,
  type RetentionPolicy,
  SAGA_STARTED_PREFIX,
  type SqlStatement,
  taskDoneEventName,
} from '@durablerun/core'
import { engineHistoryViolations } from './engine-history.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { type ProtocolSnapshot, snapshot } from './poison-matrix.js'
import { type KeptBy, type UnitTable, dumpDifferences, purgeOracle } from './retention-oracle.js'
import { NAMING_FAILED, SHORTEST_WINDOW_MS } from './retention-policies.js'
import {
  awaitTaskOwned,
  checkpointOwned,
  handWrittenRun,
  handWrittenTask,
  withFixture,
} from './scenario.js'

/**
 * The barrier grid (DESIGN.md §3.12, BUILD.md exit test line 42): every state a purge can
 * meet a unit in, crossed, each built through the store's own ports and the clock, and
 * each purge held to the oracle over a dump of every table.
 */

/** The policy of the grid: every ended state named, at the shortest window core takes. */
export const GRID_POLICY: RetentionPolicy = NAMING_FAILED
const WINDOW_MS = SHORTEST_WINDOW_MS
const START_MS = 1_000_000
/** The instant every cell's unit ends at, which is the stamp its age is read from. */
const ENDED_AT_MS = START_MS + 10_000
const BOOM = '{"name":"Boom"}'
/** The key a cell's parent spawns its child under. */
export const REPLAY_KEY = 'child#1'
/** The step a cell's parent or holder awaits the child at. */
export const AWAIT_STEP = 'await-child'

export const UNIT_STATES = ['completed', 'failed with a saga', 'failed', 'cancelled'] as const
export type UnitState = (typeof UNIT_STATES)[number]

/** The task that spawned the unit's task: none, or one in each state a purge can find it in. */
export const PARENT_STATES = [
  'none',
  'absent',
  'live',
  'rolling back',
  'completed',
  'cancelled',
  'failed',
  'failed with a saga',
] as const
export type ParentState = (typeof PARENT_STATES)[number]

export const PARENT_QUEUES = ["the child's", 'another'] as const
export type ParentQueue = (typeof PARENT_QUEUES)[number]

/** What else names the unit's completion event. */
export const HOLDERS = [
  /** A run of another unit that was woken with the outcome and still holds it. It blocks. */
  'a run that holds the outcome',
  /** A run of another unit that names the event and holds no payload. It must not block. */
  'a run that names the event with no payload',
  /** A wait that names the event, as a build older than the event leaves one. It blocks. */
  'a wait that names the event',
  'none',
] as const
export type Holder = (typeof HOLDERS)[number]

/** How far past its window the unit is when the purge is sent, in milliseconds. */
export const AGES = [-1, 0, 1] as const
export type Age = (typeof AGES)[number]

/** How many checkpoints a size cell's unit holds, beside the cap. */
export const UNIT_SIZES = [-1, 0, 1] as const
export type UnitSize = (typeof UNIT_SIZES)[number]

export interface GridCell {
  readonly unit: UnitState
  readonly parent: ParentState
  readonly parentQueue: ParentQueue
  readonly holder: Holder
  readonly age: Age
  /** Set for a size cell: the unit holds the cap's worth of checkpoints, plus this many. */
  readonly size?: UnitSize
}

export const cellName = (cell: GridCell): string =>
  cell.size === undefined
    ? `parent ${cell.parent} in ${cell.parentQueue} queue, holder ${cell.holder}, age ${cell.age}`
    : `${MAX_PURGE_UNIT_CHECKPOINTS + cell.size} checkpoints`

/** The cells of one unit state and one parent state: both queues, every holder, every age. */
export function barrierCells(unit: UnitState, parent: ParentState): GridCell[] {
  return PARENT_QUEUES.flatMap((parentQueue) =>
    HOLDERS.flatMap((holder) => AGES.map((age) => ({ unit, parent, parentQueue, holder, age }))),
  )
}

/** The size cells of one unit state: nothing in the barrier's way, at the cap and either side of it. */
export function sizeCells(unit: UnitState): GridCell[] {
  return UNIT_SIZES.map((size) => ({
    unit,
    parent: 'none',
    parentQueue: "the child's",
    holder: 'none',
    age: 1,
    size,
  }))
}

/** Every cell of the grid. */
export const GRID_CELLS: readonly GridCell[] = [
  ...UNIT_STATES.flatMap((unit) => PARENT_STATES.flatMap((parent) => barrierCells(unit, parent))),
  ...UNIT_STATES.flatMap(sizeCells),
]

/**
 * What keeps a cell's unit, said from the cell alone: the reading of the model that the
 * grid was laid out by. The oracle reads the same answer from the rows the cell built, and
 * a cell whose rows say otherwise was not built as it is named.
 */
export function keptByOf(cell: GridCell): KeptBy[] {
  const kept: KeptBy[] = []
  if (cell.age < 0) kept.push('age')
  if (cell.holder === 'a run that holds the outcome') kept.push('carry')
  if (cell.holder === 'a wait that names the event') kept.push('wait')
  // B5: a parent that is live, or failed, with a saga or without, keeps its child.
  if (['live', 'rolling back', 'failed', 'failed with a saga'].includes(cell.parent)) {
    kept.push('parent')
  }
  if ((cell.size ?? 0) > 0) kept.push('cap')
  return kept
}

/** A cell as it was built: where its unit is, and who else stands in it. */
export interface BuiltCell {
  readonly queue: string
  readonly parentQueue: string
  /** The unit's task and the key it was spawned under, which is what a purge is given. */
  readonly target: PurgeUnitTarget
  /** The parent's task and the run that spawned the child, when the cell has a parent. */
  readonly parent: ClaimedRun | null
  /** The run of another unit that awaited the child, when the cell has one. */
  readonly holder: ClaimedRun | null
  /** The instant the cell's purge is sent at. */
  readonly purgeAtMs: number
}

/** Claim what is due in a queue under a worker of the cell's own, and start the run of `taskId`. */
export async function startOf(
  f: StoreFixture,
  queue: string,
  taskId: string,
  worker: string,
): Promise<ClaimedRun> {
  const claimed = await f.store.claim(queue, worker, { leaseSeconds: 60, limit: 10 })
  const run = claimed.find((candidate) => candidate.taskId === taskId)
  if (run === undefined) throw new Error(`grid: ${worker} claimed no run of ${taskId}`)
  const started = await f.store.activate(queue, run.runId, run.claimToken, run.claimGen)
  if (started === null) throw new Error(`grid: ${worker} could not start the run of ${taskId}`)
  return started
}

/** A task whose forward phase failed for good with a registered step started: it is rolling back. */
async function enterRollback(f: StoreFixture, queue: string, run: ClaimedRun): Promise<void> {
  await checkpointOwned(f.store, queue, run, `${SAGA_STARTED_PREFIX}a`, '1', 60)
  const entered = await f.store.fail(queue, run.runId, run.claimToken, BOOM, null)
  if (!entered.rollingBack) throw new Error(`grid: ${run.taskId} did not enter its rollback`)
}

/** The rollback of a task that is rolling back fails for good, which ends the task failed with a saga. */
async function haltRollback(
  f: StoreFixture,
  queue: string,
  taskId: string,
  worker: string,
): Promise<void> {
  const pass = await startOf(f, queue, taskId, worker)
  await f.store.failRollback(queue, pass.runId, pass.claimToken, BOOM, null, {
    stepKey: 'a',
    errorJson: BOOM,
  })
}

const UNIT_ROW_STATE: Readonly<Record<UnitState, string>> = {
  completed: 'completed',
  'failed with a saga': 'failed',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * Build one cell in queues of its own, through the store's ports and the clock: the
 * parent, the child it spawns, whoever awaits the child, the parent's state, and last the
 * child's ending, at the instant every cell ends its unit at. `id` names the cell's queues,
 * so many cells share one database and none sees another's rows.
 */
export async function buildCell(f: StoreFixture, cell: GridCell, id: string): Promise<BuiltCell> {
  const queue = `q-${id}`
  const parentQueue = cell.parentQueue === 'another' ? `p-${id}` : queue
  const worker = (who: string) => `w-${id}-${who}`
  await f.admin.setFakeNowEpochMs(START_MS)

  let parent: ClaimedRun | null = null
  if (cell.parent !== 'none') {
    const spawned = await f.store.spawn(parentQueue, 'parent', '{}', { maxAttempts: 1 })
    parent = await startOf(f, parentQueue, spawned.taskId, worker('parent'))
  }
  const child = await f.store.spawn(
    queue,
    'child',
    '{}',
    parent === null
      ? { idempotencyKey: `key-${id}`, maxAttempts: 1 }
      : {
          maxAttempts: 1,
          childOf: {
            parentQueue,
            parentTaskId: parent.taskId,
            runId: parent.runId,
            claimToken: parent.claimToken,
            replayKey: REPLAY_KEY,
          },
        },
  )
  if (!child.created) throw new Error(`grid: cell ${id} found its child already there`)
  const childRun = await startOf(f, queue, child.taskId, worker('child'))
  await checkpointOwned(f.store, queue, childRun, 'step', '1', 60)

  // Whoever awaits the child parks on it while it is live. A run that names the event
  // with no payload is one whose task was cancelled while it was parked.
  let holder: ClaimedRun | null = null
  if (
    cell.holder === 'a run that holds the outcome' ||
    cell.holder === 'a run that names the event with no payload'
  ) {
    const spawned = await f.store.spawn(queue, 'holder', '{}', { maxAttempts: 1 })
    holder = await startOf(f, queue, spawned.taskId, worker('holder'))
    const parked = await awaitTaskOwned(f.store, queue, holder, AWAIT_STEP, child.taskId, null)
    if (parked.emitted) throw new Error(`grid: cell ${id} found its child ended before it ended`)
    if (cell.holder === 'a run that names the event with no payload') {
      await f.store.cancelTask(queue, spawned.taskId)
    }
  }

  if (parent !== null) {
    const { runId, claimToken, taskId } = parent
    switch (cell.parent) {
      case 'live':
        break
      case 'completed':
      case 'absent':
        await f.store.complete(parentQueue, runId, claimToken, '"parent"')
        break
      case 'cancelled':
        await f.store.cancelTask(parentQueue, taskId)
        break
      case 'failed':
        await f.store.fail(parentQueue, runId, claimToken, BOOM, null)
        break
      case 'rolling back':
        await enterRollback(f, parentQueue, parent)
        break
      case 'failed with a saga':
        await enterRollback(f, parentQueue, parent)
        await haltRollback(f, parentQueue, taskId, worker('parent-pass'))
        break
    }
    if (cell.parent === 'absent') {
      // An absent parent is one whose own unit was purged, a window after it completed.
      await f.admin.setFakeNowEpochMs(START_MS + WINDOW_MS)
      const gone = await f.retentionOver(f.raw).purgeUnit(parentQueue, { taskId }, GRID_POLICY)
      if (gone === null) throw new Error(`grid: cell ${id} could not purge its parent`)
    }
  }

  // The child ends last, at the one instant every cell's unit ends at.
  await f.admin.setFakeNowEpochMs(ENDED_AT_MS)
  switch (cell.unit) {
    case 'completed':
      await f.store.complete(queue, childRun.runId, childRun.claimToken, '"child"')
      break
    case 'failed':
      await f.store.fail(queue, childRun.runId, childRun.claimToken, BOOM, null)
      break
    case 'cancelled':
      await f.store.cancelTask(queue, child.taskId)
      break
    case 'failed with a saga':
      await enterRollback(f, queue, childRun)
      await haltRollback(f, queue, child.taskId, worker('child-pass'))
      break
  }
  // A run that holds the outcome holds it in any state. The oldest cells keep it as the
  // ending left it, woken and unclaimed, and the cell past its window cancels its task,
  // which leaves a cancelled run that never clears what it holds.
  if (cell.holder === 'a run that holds the outcome' && cell.age > 0 && holder !== null) {
    await f.store.cancelTask(queue, holder.taskId)
  }
  if (cell.holder === 'a wait that names the event') {
    // A wait on an ended task is what a build older than the event leaves, and no port of
    // this build writes one, so the waiter and its wait are written as rows.
    const waiter = `waiter-${id}`
    const event = taskDoneEventName(child.taskId)
    const rows: SqlStatement[] = [
      handWrittenTask({ taskId: waiter, state: 'sleeping', atMs: ENDED_AT_MS, queue }),
      handWrittenRun({
        runId: `${waiter}-run`,
        taskId: waiter,
        state: 'sleeping',
        atMs: ENDED_AT_MS,
        queue,
        wake: { event, step: AWAIT_STEP },
      }),
      {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                timeout_at_ms, created_at_ms)
              VALUES (?, ?, ?, ?, ?, 'waiting', NULL, ?)`,
        args: [`${waiter}-run`, AWAIT_STEP, queue, waiter, event, ENDED_AT_MS],
      },
    ]
    await f.raw.batch('grid:an-older-build-left-a-wait', rows, 'write')
  }

  const dump = await snapshot(f.raw)
  const row = dump.tasks.find((task) => task.task_id === child.taskId)
  if (row?.state !== UNIT_ROW_STATE[cell.unit]) {
    throw new Error(`grid: cell ${id} ended its unit ${String(row?.state)}, not ${cell.unit}`)
  }
  if (cell.size !== undefined) await fillCheckpoints(f, dump, child.taskId, cell.size)
  const key = row.idempotency_key === null ? undefined : String(row.idempotency_key)
  return {
    queue,
    parentQueue,
    target:
      key === undefined ? { taskId: child.taskId } : { taskId: child.taskId, idempotencyKey: key },
    parent,
    holder,
    purgeAtMs: ENDED_AT_MS + WINDOW_MS + cell.age,
  }
}

/**
 * Bring a unit to the cap's worth of checkpoints, plus `size`. The rows are written as
 * rows, two thousand to a statement, under the run that owns the unit's own checkpoint:
 * writing each through the port would take longer than the purge it is there to measure.
 */
async function fillCheckpoints(
  f: StoreFixture,
  dump: ProtocolSnapshot,
  taskId: string,
  size: UnitSize,
): Promise<void> {
  const held = dump.checkpoints.filter((row) => row.task_id === taskId)
  const owned = held.find((row) => row.checkpoint_name === 'step')
  if (owned === undefined) throw new Error(`grid: ${taskId} holds no checkpoint of its own`)
  const wanted = MAX_PURGE_UNIT_CHECKPOINTS + size - held.length
  const PER_STATEMENT = 2_000
  for (let written = 0; written < wanted; written += PER_STATEMENT) {
    const count = Math.min(PER_STATEMENT, wanted - written)
    await f.raw.batch(
      'grid:fill-checkpoints',
      [
        {
          sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                  owner_run_id, owner_attempt, updated_at_ms)
                VALUES ${Array.from({ length: count }, () => "(?, ?, ?, '1', 'committed', ?, ?, ?)").join(', ')}`,
          args: Array.from({ length: count }, (_, index) => [
            taskId,
            `filler-${written + index}`,
            String(owned.queue),
            String(owned.owner_run_id),
            Number(owned.owner_attempt),
            ENDED_AT_MS,
          ]).flat(),
        },
      ],
      'write',
    )
  }
}

/** What one cell's purge did, beside what the model says of the rows the cell built. */
export interface CellOutcome {
  readonly cell: string
  /** What keeps the unit: by the oracle over the dump, and in `expected` by the cell's name. */
  readonly keptBy: readonly KeptBy[]
  /** The rows the purge answered that it deleted, or null when it took nothing. */
  readonly purged: Readonly<Record<UnitTable, number>> | null
  /** How every table afterwards differs from the dump less what the oracle lets go. */
  readonly differences: readonly string[]
  /** What the history checkers say of the rows before the purge, and after it. */
  readonly violations: { readonly before: readonly string[]; readonly after: readonly string[] }
}

/** The one finding a cell's own rows carry: the wait that an older build left on an event that exists. */
const violationsOf = (cell: GridCell, id: string): string[] =>
  cell.holder === 'a wait that names the event'
    ? [`wait-for-fired-event: waiter-${id}-run/${AWAIT_STEP}`]
    : []

/**
 * Build each cell, send its purge, and say what happened beside what must: the oracle's
 * reading of the rows equals the cell's name, the purge answered what the oracle lets go,
 * every table of every queue is the dump less exactly that, and the history checkers say
 * of the rows afterwards what they said before.
 *
 * The cells share one database, and the history checkers read all of it. So the cells
 * whose rows carry a known finding, the ones with a wait an older build left, are built
 * last: every other cell is judged over a history with nothing wrong in it, and each of
 * those over exactly the findings of the waits written so far.
 */
export async function runGridCells(
  makeFixture: StoreFixtureFactory,
  name: string,
  cells: readonly GridCell[],
): Promise<{ observed: CellOutcome[]; expected: CellOutcome[] }> {
  return withFixture(makeFixture, `grid ${name}`, async (f) => {
    const retention = f.retentionOver(f.raw)
    const observed: CellOutcome[] = []
    const expected: CellOutcome[] = []
    const leavesAFinding = (cell: GridCell) => cell.holder === 'a wait that names the event'
    const inOrder = [
      ...cells.filter((cell) => !leavesAFinding(cell)),
      ...cells.filter(leavesAFinding),
    ]
    const known: string[] = []
    for (const [index, cell] of inOrder.entries()) {
      const id = String(index)
      const built = await buildCell(f, cell, id)
      await f.admin.setFakeNowEpochMs(built.purgeAtMs)
      const before = await snapshot(f.raw)
      const violationsBefore = await engineHistoryViolations(f.raw)
      const oracle = purgeOracle(before, built.purgeAtMs, built.queue, built.target, GRID_POLICY)
      const answer = await retention.purgeUnit(built.queue, built.target, GRID_POLICY)
      const after = await snapshot(f.raw)
      const keptBy = keptByOf(cell)
      known.push(...violationsOf(cell, id))
      observed.push({
        cell: cellName(cell),
        keptBy: oracle.keptBy,
        purged: answer === null ? null : answer.rows,
        differences: dumpDifferences(oracle.after, after),
        violations: {
          before: [...violationsBefore].sort(),
          after: [...(await engineHistoryViolations(f.raw))].sort(),
        },
      })
      expected.push({
        cell: cellName(cell),
        keptBy,
        purged: keptBy.length === 0 ? oracle.rows : null,
        differences: [],
        violations: { before: [...known].sort(), after: [...known].sort() },
      })
    }
    return { observed, expected }
  })
}
