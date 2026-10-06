import {
  MAX_EPOCH_MS,
  MAX_PURGE_UNIT_CHECKPOINTS,
  type PurgeUnitTarget,
  type RetentionPolicy,
  type SqlRow,
  isLiveState,
  parseChildSpawnKey,
  taskDoneEventName,
} from '@durablerun/core'
import type { ProtocolSnapshot } from './poison-matrix.js'

/**
 * What a purge may remove, said a second time, from the model and not from the SQL
 * (specs/Retention.tla, DESIGN.md §3.12). It reads a dump of every table, taken before
 * the purge, and never a live row, so nothing a store does while it purges can agree with
 * it by reading the same thing. The grid, the fuzz walk and the contest hold every purge
 * to it: the answer, and every table afterwards.
 */

/** What keeps a unit, by the condition of the model that keeps it, in the barrier's order. */
export const KEPT_BY = [
  /** No task of that id is in the queue. */
  'no-such-task',
  /** B1, Admitted: the task is live, or ended in a state the policy does not name. */
  'state',
  /** B1: the stamp its age is read from is no stored instant in range. */
  'stamp',
  /** B1, Aged: the stamp is less than its state's window old. */
  'age',
  /** B2: a run of the task is live. */
  'live-run',
  /** B3: a run of another unit in the queue holds the task's outcome. */
  'carry',
  /** B4: a wait in the queue names the task's completion event. */
  'wait',
  /** B5, ParentAllows: the task that spawned it is live or failed, or its key names no parent. */
  'parent',
  /** The key the caller named is not the key the task was spawned under. */
  'key',
  /** A run of the task is in another queue, where the purge deletes nothing. */
  'foreign-run',
  /** The unit holds more checkpoints than one batch deletes. */
  'cap',
] as const
export type KeptBy = (typeof KEPT_BY)[number]

/** The tables a unit has rows in. */
export const UNIT_TABLES = ['tasks', 'runs', 'checkpoints', 'waits', 'events'] as const
export type UnitTable = (typeof UNIT_TABLES)[number]

export interface PurgeOracle {
  /** Every condition that keeps the unit. Empty when the model lets it go. */
  readonly keptBy: readonly KeptBy[]
  /** How many rows of each table the unit holds, which is what a purge of it deletes. */
  readonly rows: Readonly<Record<UnitTable, number>>
  /** Every table as the purge must leave it: less the unit when it goes, untouched when it is kept. */
  readonly after: ProtocolSnapshot
}

/** The engine's reserved prefix of the key a parent spawns a child under. */
const CHILD_KEY_PREFIX = '$spawn:'

const text = (value: unknown): string | null => (value === null ? null : String(value))

/** A stored instant in range, as a number, or null for anything else a column can hold. */
function instant(value: unknown): number | null {
  const stored = typeof value === 'bigint' ? Number(value) : value
  return typeof stored === 'number' &&
    Number.isSafeInteger(stored) &&
    stored >= 0 &&
    stored <= MAX_EPOCH_MS
    ? stored
    : null
}

/** The window of a state under a policy, in milliseconds, or null for a state it keeps. */
function windowMs(policy: RetentionPolicy, state: unknown): number | null {
  const seconds =
    state === 'completed'
      ? policy.completedSeconds
      : state === 'cancelled'
        ? policy.cancelledSeconds
        : state === 'failed'
          ? policy.failedSeconds
          : undefined
  return seconds === undefined ? null : seconds * 1_000
}

/**
 * What the model says of one purge: the unit of `unit.taskId` in `queue`, under `policy`,
 * at database time `nowMs`, over `dump`.
 */
export function purgeOracle(
  dump: ProtocolSnapshot,
  nowMs: number,
  queue: string,
  unit: PurgeUnitTarget,
  policy: RetentionPolicy,
): PurgeOracle {
  const none = { tasks: 0, runs: 0, checkpoints: 0, waits: 0, events: 0 }
  const task = dump.tasks.find((row) => row.task_id === unit.taskId && row.queue === queue)
  if (task === undefined) return { keptBy: ['no-such-task'], rows: none, after: dump }

  const eventName = taskDoneEventName(unit.taskId)
  const itsRuns = dump.runs.filter((row) => row.task_id === unit.taskId)
  const inQueue = itsRuns.filter((row) => row.queue === queue)
  const runIds = new Set(inQueue.map((row) => String(row.run_id)))
  const isOfUnit: Readonly<Record<UnitTable, (row: SqlRow) => boolean>> = {
    tasks: (row) => row.task_id === unit.taskId,
    runs: (row) => row.task_id === unit.taskId && row.queue === queue,
    checkpoints: (row) => row.task_id === unit.taskId,
    waits: (row) => runIds.has(String(row.run_id)),
    events: (row) => row.queue === queue && row.event_name === eventName,
  }
  const rows = Object.fromEntries(
    UNIT_TABLES.map((table) => [table, dump[table].filter(isOfUnit[table]).length]),
  ) as Record<UnitTable, number>

  const keptBy = new Set<KeptBy>()
  const window = windowMs(policy, task.state)
  const stamped = instant(task.fence_at_ms)
  if (window === null) keptBy.add('state')
  if (stamped === null) keptBy.add('stamp')
  if (window !== null && stamped !== null && stamped > nowMs - window) keptBy.add('age')
  if (itsRuns.some((row) => isLiveState(row.state))) keptBy.add('live-run')
  if (
    dump.runs.some(
      (row) =>
        row.queue === queue &&
        row.task_id !== unit.taskId &&
        row.wake_event === eventName &&
        row.event_payload !== null,
    )
  ) {
    keptBy.add('carry')
  }
  if (dump.waits.some((row) => row.queue === queue && row.event_name === eventName)) {
    keptBy.add('wait')
  }
  // The spawning parent is found by its id in every queue. A key in the reserved
  // namespace that names nobody keeps the unit: it is not known whose child the task is.
  const storedKey = text(task.idempotency_key)
  if (storedKey?.startsWith(CHILD_KEY_PREFIX)) {
    const named = parseChildSpawnKey(storedKey)
    const parent = dump.tasks.find((row) => row.task_id === named?.parentTaskId)
    if (named === null || (parent !== undefined && !canNoLongerRun(parent))) keptBy.add('parent')
  }
  if ((unit.idempotencyKey ?? null) !== storedKey) keptBy.add('key')
  if (itsRuns.length !== inQueue.length) keptBy.add('foreign-run')
  if (rows.checkpoints > MAX_PURGE_UNIT_CHECKPOINTS) keptBy.add('cap')

  const kept = KEPT_BY.filter((condition) => keptBy.has(condition))
  if (kept.length > 0) return { keptBy: kept, rows, after: dump }
  return {
    keptBy: [],
    rows,
    after: {
      ...dump,
      ...Object.fromEntries(
        UNIT_TABLES.map((table) => [table, dump[table].filter((row) => !isOfUnit[table](row))]),
      ),
    } as ProtocolSnapshot,
  }
}

/** ParentAllows: a parent that completed or was cancelled never runs its code again. */
function canNoLongerRun(parent: SqlRow): boolean {
  return parent.state === 'completed' || parent.state === 'cancelled'
}

/** One row as text that two dumps of one database can be compared by. */
const shown = (row: SqlRow): string =>
  JSON.stringify(row, (_, value: unknown) =>
    typeof value === 'bigint' ? String(value) : value instanceof Uint8Array ? [...value] : value,
  )

/**
 * How two dumps differ, row by row: every row one holds that the other does not, named by
 * its table. Empty when every table of every queue holds the same rows.
 */
export function dumpDifferences(expected: ProtocolSnapshot, observed: ProtocolSnapshot): string[] {
  const differences: string[] = []
  for (const table of Object.keys(expected) as (keyof ProtocolSnapshot)[]) {
    const wanted = new Set(expected[table].map(shown))
    const found = new Set(observed[table].map(shown))
    for (const row of wanted) if (!found.has(row)) differences.push(`${table} lost ${row}`)
    for (const row of found) if (!wanted.has(row)) differences.push(`${table} gained ${row}`)
  }
  return differences.sort()
}
