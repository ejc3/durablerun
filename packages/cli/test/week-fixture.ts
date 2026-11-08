import { QUEUE_TABLES } from '@durablerun/core'
import {
  HOUR_MS,
  WEEK_DIGEST_UNIT_ROWS,
  WEEK_PERIODS,
  type WeekRows,
  digestKey,
  digestPeriod,
  sealOf,
  sha256,
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
 * period was tried twice. One task that awaits an event nobody emits was injected, and the
 * deployment parked it, before the start sample, and the operator cancelled it after the
 * third day's sample, as the README's steps of the sealed injection say.
 */

const QUEUE = 'digest'
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
/**
 * What the queue held at the start sample: the injected task as the deployment parked it,
 * which the README's steps put before that sample. Its task, one run and its wait.
 */
export const START_ROWS: WeekRows = { tasks: 1, runs: 1, checkpoints: 0, waits: 1, events: 0 }
/**
 * The injected task after the start sample, as the week on the release alpha.1 measures
 * one: parked as it was, and once the operator cancelled it no wait and the event of its
 * ending.
 */
const PARKED: WeekRows = START_ROWS
const CANCELLED: WeekRows = { ...START_ROWS, waits: 0, events: 1 }
/** The operator cancels the injected task after the sample of this day. */
const CANCELLED_AFTER_DAY = 2
const injectedOn = (day: number): WeekRows => (day <= CANCELLED_AFTER_DAY ? PARKED : CANCELLED)
/** The most the injected task came to hold of each table beyond what the start sample counted. */
export const INJECTED_BEYOND_THE_START = Object.fromEntries(
  QUEUE_TABLES.map((table) => [
    table,
    Math.max(PARKED[table], CANCELLED[table]) - START_ROWS[table],
  ]),
) as WeekRows

/** The sha256 of the key the task of the week's `index`th period is enqueued under. */
export const keyOfPeriod = (index: number): string =>
  sha256(digestKey(digestPeriod(START_MS + index * HOUR_MS)))

type Json = Record<string, unknown>

/** A report as a command prints one that ended well, about the week's queue unless `rest` names another. */
const printed = (command: string, rest: Json): Json => ({
  command,
  exit: 'done',
  queue: QUEUE,
  dialect: { scheme: 'libsql:', schemaWindow: { oldest: 5, newest: 12 } },
  ...rest,
})

const stats = (atEpochMs: number): Json =>
  printed('stats', { databaseNowEpochMs: atEpochMs, fakeClock: false, summary: 'active' })

const sizes = (rows: WeekRows): Json =>
  printed('sizes', {
    cap: 1_000_000,
    tables: Object.fromEntries(
      QUEUE_TABLES.map((table) => [table, { count: rows[table], atLeast: false }]),
    ),
  })

const unit = (index: number, state: string): Json => ({
  taskId: `task-of-period-${index}`,
  taskName: 'periodic-digest',
  state,
  endedAtMs: START_MS + index * HOUR_MS + 61_000,
  idempotencyKeySha256: keyOfPeriod(index),
})

/** A purge report that finished: a dry run lists its units as ones it would purge. */
const purgeReport = (
  execute: boolean,
  failedSeconds: number | null,
  units: readonly Json[],
): Json =>
  printed('purge', {
    execute,
    policy: {
      completedSeconds: WINDOW_HOURS * 3_600,
      cancelledSeconds: WINDOW_HOURS * 3_600,
      failedSeconds,
    },
    limit: 100,
    examined: units.length,
    [execute ? 'purged' : 'wouldPurge']: units,
    kept: [],
    gone: [],
    outcomeNotKnown: [],
    finished: true,
    more: false,
  })

const purged = (periods: readonly number[]): Json =>
  purgeReport(
    true,
    null,
    periods.map((index) => ({ ...unit(index, 'completed'), rows: rowsOf(index) })),
  )

/** The `inspect --key` report of the task of the week's `index`th period, with a run for each attempt. */
export const lookup = (index: number): Json =>
  printed('inspect', {
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
 * purge: the injected task's as it stands that day, and a unit's for every period enqueued
 * and not purged yet.
 */
function rowsOn(day: number): WeekRows {
  const enqueued = range(0, day * 24 + 1)
  const gone = new Set(range(1, day).flatMap(purgedOn))
  const standing = enqueued.filter((index) => !gone.has(index))
  return Object.fromEntries(
    QUEUE_TABLES.map((table) => [
      table,
      injectedOn(day)[table] + standing.reduce((sum, index) => sum + rowsOf(index)[table], 0),
    ]),
  ) as WeekRows
}

export const INJECTION = {
  taskId: 'task-injected',
  cause: 'awaiting-an-untimed-event',
  nonce: 'a-nonce-of-the-second-person',
}

export interface WeekReceipt {
  kind: string
  queue: string
  selftest?: Json
  start: { stats: Json; sizes: Json }
  /** Each day's sample, and the purge reports after it. */
  days: { stats: Json; sizes: Json; purges: Json[] }[]
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
    selftest: printed('selftest', { queue: 'selftest-before-the-week', passed: true }),
    start: { stats: stats(START_MS), sizes: sizes(START_ROWS) },
    days,
    end: { stats: stats(START_MS + 7 * DAY_MS + 5 * 60_000), sizes: sizes(rowsOn(7)) },
    failedDryRun: purgeReport(false, 3_600, [unit(FAILED_PERIOD, 'failed')]),
    // Every period no purge report names: the failed one, and those still within the window.
    lookups: [FAILED_PERIOD, ...range(lastPurged + 1, WEEK_PERIODS)].map(lookup),
    seal: { sha256: sealOf(INJECTION) },
    injection: { ...INJECTION },
    explanation: printed('explain', {
      taskId: INJECTION.taskId,
      cause: INJECTION.cause,
      verdict: 'waiting',
    }),
    attestation: { attestedBy: 'the maintainer', sealPublishedAtEpochMs: START_MS - HOUR_MS },
  }
}
