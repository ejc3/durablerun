import { createHash } from 'node:crypto'
import {
  WEEK_DIGEST_UNIT_ROWS,
  WEEK_TABLES,
  type WeekRows,
  digestKey,
  digestPeriod,
  sealOf,
} from '../../../apps/dogfood/src/week-receipt.js'

/**
 * A well-formed week receipt, made by code: a model of one week of the recurring workflow,
 * printed as the documents the operator CLI prints. Every doctored receipt of the tests is
 * this one with one thing broken by one function, so a change to the receipt's format
 * changes them all together.
 *
 * The week it models: a digest is enqueued each hour from the start sample on. A sample of
 * `stats` and `sizes` is taken each day, and after it a purge under a window of a day. One
 * period failed after five attempts, and a purge with no failed window keeps it. One
 * period was tried twice. One task was injected before the start sample, so the start
 * sample counts its rows.
 */

export const QUEUE = 'digest'
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The start sample: twenty minutes past an hour. */
export const START_MS = Date.UTC(2026, 0, 5, 9, 20)
/** The completed window of the week's purges, in hours. */
export const WINDOW_HOURS = 24
/** The period that failed, which no purge of the week takes. */
export const FAILED_PERIOD = 30
/** The period whose first attempt failed and whose second completed. */
export const RETRIED_PERIOD = 50
/** The runs a unit holds: five when it failed, two when it was tried again, and otherwise one. */
const runsOf = (index: number): number =>
  index === FAILED_PERIOD ? 5 : index === RETRIED_PERIOD ? 2 : 1
/** The rows a unit holds: a digest unit's, with a run for each attempt. */
const rowsOf = (index: number): WeekRows => ({ ...WEEK_DIGEST_UNIT_ROWS, runs: runsOf(index) })
/** The runs the week's units held beyond the first of each. */
export const RUNS_BEYOND_THE_FIRST = runsOf(FAILED_PERIOD) - 1 + runsOf(RETRIED_PERIOD) - 1
/** What the queue held at the start sample: the injected task, parked on its event. */
export const START_ROWS: WeekRows = { tasks: 1, runs: 1, checkpoints: 1, waits: 1, events: 0 }

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** The sha256 of the key the task of the week's `index`th period is enqueued under. */
export const keyOfPeriod = (index: number): string =>
  sha256(digestKey(digestPeriod(START_MS + index * HOUR_MS)))

type Json = Record<string, unknown>

const dialect = { scheme: 'libsql:', schemaWindow: { oldest: 5, newest: 12 } }

const stats = (atEpochMs: number): Json => ({
  command: 'stats',
  exit: 'done',
  queue: QUEUE,
  dialect,
  databaseNowEpochMs: atEpochMs,
  fakeClock: false,
  summary: 'active',
})

const sizes = (rows: WeekRows): Json => ({
  command: 'sizes',
  exit: 'done',
  queue: QUEUE,
  dialect,
  cap: 1_000_000,
  tables: Object.fromEntries(
    WEEK_TABLES.map((table) => [table, { count: rows[table], atLeast: false }]),
  ),
})

const unit = (index: number, state: string): Json => ({
  taskId: `task-of-period-${index}`,
  taskName: 'periodic-digest',
  state,
  endedAtMs: START_MS + index * HOUR_MS + 61_000,
  idempotencyKeySha256: keyOfPeriod(index),
})

const policy = (failedSeconds: number | null): Json => ({
  completedSeconds: WINDOW_HOURS * 3_600,
  cancelledSeconds: WINDOW_HOURS * 3_600,
  failedSeconds,
})

const purged = (periods: readonly number[]): Json => ({
  command: 'purge',
  exit: 'done',
  queue: QUEUE,
  dialect,
  execute: true,
  policy: policy(null),
  limit: 100,
  examined: periods.length,
  purged: periods.map((index) => ({ ...unit(index, 'completed'), rows: rowsOf(index) })),
  kept: [],
  gone: [],
  outcomeNotKnown: [],
  finished: true,
  more: false,
})

const lookup = (index: number): Json => ({
  command: 'inspect',
  exit: 'done',
  queue: QUEUE,
  dialect,
  task: {
    taskId: `task-of-period-${index}`,
    state: index === FAILED_PERIOD ? 'failed' : 'completed',
    idempotencyKey: { bytes: 20, sha256: keyOfPeriod(index) },
  },
  runs: Array.from({ length: runsOf(index) }, (_, attempt) => ({ attempt: attempt + 1 })),
})

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset)

/** The periods the purge of day `day` takes: the completed ones that ended a window before it. */
const purgedOn = (day: number): number[] =>
  range((day - 2) * 24, (day - 1) * 24).filter((index) => index >= 0 && index !== FAILED_PERIOD)

/**
 * The rows the queue holds at the sample of day `day`, which is taken before that day's
 * purge: the start sample's, and a unit's for every period enqueued and not purged yet.
 */
function rowsOn(day: number): WeekRows {
  const enqueued = range(0, day * 24 + 1)
  const gone = new Set(range(1, day).flatMap(purgedOn))
  const standing = enqueued.filter((index) => !gone.has(index))
  return Object.fromEntries(
    WEEK_TABLES.map((table) => [
      table,
      START_ROWS[table] + standing.reduce((sum, index) => sum + rowsOf(index)[table], 0),
    ]),
  ) as WeekRows
}

export const INJECTION = {
  taskId: 'task-injected',
  cause: 'awaiting-an-untimed-event',
  nonce: 'a-nonce-of-the-second-person',
}

/** A day of the receipt as the tests name it: the sample and the purge reports after it. */
export interface Day {
  stats: Json
  sizes: Json
  purges: Json[]
}

export interface WeekReceipt {
  kind: string
  queue: string
  selftest?: Json
  start: { stats: Json; sizes: Json }
  days: Day[]
  end: { stats: Json; sizes: Json }
  failedDryRun: Json
  lookups: Json[]
  seal: { sha256: string }
  injection: { taskId: string; cause: string; nonce: string }
  explanation: Json
  attestation: { attestedBy: string; sealPublishedAtEpochMs: number }
}

/** The well-formed receipt. Each call makes a new one, so a test may change what it gets. */
export function genuineWeek(): WeekReceipt {
  const days = range(1, 7).map((day) => ({
    stats: stats(START_MS + day * DAY_MS),
    sizes: sizes(rowsOn(day)),
    purges: [purged(purgedOn(day))],
  }))
  const lastPurged = Math.max(...range(1, 7).flatMap(purgedOn))
  return {
    kind: 'week',
    queue: QUEUE,
    selftest: {
      command: 'selftest',
      exit: 'done',
      queue: 'selftest-before-the-week',
      dialect,
      passed: true,
    },
    start: { stats: stats(START_MS), sizes: sizes(START_ROWS) },
    days,
    end: { stats: stats(START_MS + 7 * DAY_MS + 5 * 60_000), sizes: sizes(rowsOn(7)) },
    failedDryRun: {
      command: 'purge',
      exit: 'done',
      queue: QUEUE,
      dialect,
      execute: false,
      policy: policy(3_600),
      limit: 1_000,
      examined: 1,
      wouldPurge: [unit(FAILED_PERIOD, 'failed')],
      kept: [],
      gone: [],
      outcomeNotKnown: [],
      finished: true,
      more: false,
    },
    // Every period no purge report names: the failed one, and those still within the window.
    lookups: [FAILED_PERIOD, ...range(lastPurged + 1, 168)].map(lookup),
    seal: { sha256: sealOf(INJECTION) },
    injection: { ...INJECTION },
    explanation: {
      command: 'explain',
      exit: 'done',
      queue: QUEUE,
      dialect,
      taskId: INJECTION.taskId,
      cause: INJECTION.cause,
      verdict: 'waiting',
    },
    attestation: { attestedBy: 'the maintainer', sealPublishedAtEpochMs: START_MS - HOUR_MS },
  }
}
