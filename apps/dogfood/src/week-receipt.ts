import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DEFAULT_MAX_ATTEMPTS, QUEUE_TABLES, type QueueTable } from '@durablerun/core'

/**
 * The receipt of a week of the recurring workflow on a deployment, and its checker
 * (BUILD.md exit test line 44 and receipt M1, README "Operating a deployment").
 *
 * A week receipt is one JSON document that holds the documents the operator CLI printed
 * with `--json` during the week, as they were printed: the report of `selftest` on a branch
 * or a snapshot before the week, a sample of `stats` and `sizes` at the start, one each day
 * and one at the end, each day's `purge --execute` reports, a dry run of `purge` under a
 * failed window, an `inspect --key` for each period no purge report names, and the
 * `explain` of the one injected task. Beside them it holds the sealed injection: the hash
 * a second person published before the week, and the task id, the cause and the nonce
 * that person revealed after it.
 *
 * The checker reads every member once into the few fields it uses and refuses a receipt
 * for each thing that is wrong with it, by a name. A receipt whose kind it does not know,
 * that lacks a member, or that holds a member of the wrong type is refused: nothing it
 * cannot read counts as evidence. It can prove only what the documents say. That the hash
 * was published before the operator started is the maintainer's attestation, which the
 * receipt carries and the checker holds to the start sample's instant.
 */

/** A count for each table whose rows `sizes` counts, which are core's tables of a queue. */
export type WeekRows = Readonly<Record<QueueTable, number>>

/** The periods of a week, one an hour. */
export const WEEK_PERIODS = 168
/** How many of them must be found. */
export const WEEK_PERIODS_REQUIRED = 160

export const HOUR_MS = 3_600_000
/** The least a week spans, from the start sample to the end sample. */
export const WEEK_SPAN_MS = WEEK_PERIODS * HOUR_MS
/** The most hours that may pass between one sample and the next: a day and an hour. */
export const WEEK_SAMPLE_GAP_HOURS = 25
export const WEEK_SAMPLE_GAP_MS = WEEK_SAMPLE_GAP_HOURS * HOUR_MS

/**
 * The rows one digest unit holds once it ended: its task, one run, the checkpoint of its
 * read and of its sleep, and its completion event. The simulated week of exit test line 43
 * measures the same shape, and a test holds these counts equal to that measure. A unit
 * that was tried again holds a run for each attempt, and so does one a sweep took back
 * from a worker that died. The bound allows those runs where the receipt shows them: see
 * `runsBeyondTheFirst`.
 */
export const WEEK_DIGEST_UNIT_ROWS: WeekRows = Object.freeze({
  tasks: 1,
  runs: 1,
  checkpoints: 2,
  waits: 0,
  events: 1,
})

/**
 * The rows the injected task comes to hold after it is enqueued, up to and past the
 * operator's cancel, beyond the task and the run it holds when enqueued. The start sample
 * counts the task as it stands then, and the README's steps of the sealed injection go on
 * to add rows: the deployment parks a task that awaits an event, which is a wait, and the
 * operator's `cancel` writes the event of the task's ending. The week on the release
 * alpha.1 measures both kinds of injected task, one of a name no handler is registered
 * for and one that awaits an event nobody emits, and holds this to the most either held
 * of each table.
 */
export const WEEK_INJECTED_UNIT_ROWS: WeekRows = Object.freeze({
  tasks: 0,
  runs: 0,
  checkpoints: 0,
  waits: 1,
  events: 1,
})

/** The name of the period an instant falls in: its hour, in UTC, as `YYYY-MM-DDTHH`. */
export const digestPeriod = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 13)

/** The idempotency key a period's task is enqueued under. */
export const digestKey = (period: string): string => `digest-${period}`

/** The sha256 of a text, in hex, as the CLI prints the digest of a key. */
export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** The sealed injection: what a second person hashes before the week and reveals after it. */
export interface WeekInjection {
  readonly taskId: string
  /** The cause as `explain` names it. */
  readonly cause: string
  readonly nonce: string
}

/**
 * The hash a second person publishes: the sha256 of the task id, the cause and the nonce,
 * each followed by a line feed. `printf '%s\n%s\n%s\n' "$TASK_ID" "$CAUSE" "$NONCE" |
 * sha256sum` prints the same.
 */
export const sealOf = ({ taskId, cause, nonce }: WeekInjection): string =>
  sha256(`${taskId}\n${cause}\n${nonce}\n`)

/** Why a receipt is refused. `malformed` is every member that is missing or of the wrong type. */
export const WEEK_REFUSALS = [
  'unknown-kind',
  'malformed',
  'test-clock-set',
  'span-under-seven-days',
  'missing-daily-snapshot',
  'sizes-over-bound',
  'periods-missing',
  'seal-mismatch',
  'seal-published-after-the-start',
  'explanation-differs-from-the-seal',
  'day-without-purge',
  'no-selftest-record',
] as const
export type WeekRefusalCause = (typeof WEEK_REFUSALS)[number]

export interface WeekRefusal {
  readonly cause: WeekRefusalCause
  readonly detail: string
}

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** A document the CLI printed for `command`, about `queue` when one is given, or null. */
function documentOf(value: unknown, command: string, queue?: string): Json | null {
  if (!isRecord(value) || value.command !== command) return null
  return queue === undefined || value.queue === queue ? value : null
}

/** What the checker reads of a `stats` report: the database's instant, and whether a test clock is set. */
export interface StatsRead {
  readonly atEpochMs: number
  readonly fakeClock: boolean
}

export function readStats(value: unknown, queue: string): StatsRead | null {
  const document = documentOf(value, 'stats', queue)
  if (document === null || document.exit !== 'done') return null
  const { databaseNowEpochMs, fakeClock } = document
  return isCount(databaseNowEpochMs) && typeof fakeClock === 'boolean'
    ? { atEpochMs: databaseNowEpochMs, fakeClock }
    : null
}

/**
 * What the checker reads of a `sizes` report: each table's count. A count the command
 * capped is at least what it printed and not a count, and it reads as infinite, which no
 * bound allows.
 */
export function readSizes(value: unknown, queue: string): WeekRows | null {
  const document = documentOf(value, 'sizes', queue)
  if (document === null || document.exit !== 'done' || !isRecord(document.tables)) return null
  const counts: Partial<Record<QueueTable, number>> = {}
  for (const table of QUEUE_TABLES) {
    const gauge = document.tables[table]
    if (!isRecord(gauge) || !isCount(gauge.count) || typeof gauge.atLeast !== 'boolean') return null
    counts[table] = gauge.atLeast ? Number.POSITIVE_INFINITY : gauge.count
  }
  return counts as WeekRows
}

/**
 * A unit a purge report names: its state, the sha256 of the key it was spawned under, and
 * how many runs went with it, which a report prints of a unit it purged and of no other.
 */
export interface UnitRead {
  readonly state: string
  readonly keySha256: string | null
  readonly runs: number | null
}

/** The units of one list of a purge report. A list of purged units prints each one's rows. */
function readUnits(value: unknown, purged: boolean): UnitRead[] | null {
  if (!Array.isArray(value)) return null
  const units: UnitRead[] = []
  for (const unit of value) {
    if (!isRecord(unit) || !isText(unit.state)) return null
    const key = unit.idempotencyKeySha256
    if (key !== null && !isText(key)) return null
    let runs: number | null = null
    if (purged) {
      if (!isRecord(unit.rows) || !isCount(unit.rows.runs)) return null
      runs = unit.rows.runs
    }
    units.push({ state: unit.state, keySha256: key, runs })
  }
  return units
}

/** What the checker reads of a `purge` report. */
export interface PurgeRead {
  readonly execute: boolean
  readonly finished: boolean
  readonly more: boolean
  readonly completedSeconds: number
  /** Null when the policy names no failed window, and then a purge keeps every failed unit. */
  readonly failedSeconds: number | null
  /** The units it purged, or with no `--execute` the units it would purge. */
  readonly taken: readonly UnitRead[]
  /** The units whose purge was sent and not answered: each may have gone. */
  readonly outcomeNotKnown: readonly UnitRead[]
}

export function readPurge(value: unknown, queue: string): PurgeRead | null {
  const document = documentOf(value, 'purge', queue)
  if (document === null || !isRecord(document.policy)) return null
  const { execute, finished, more, policy } = document
  const { completedSeconds, failedSeconds } = policy
  if (typeof execute !== 'boolean' || typeof finished !== 'boolean' || typeof more !== 'boolean') {
    return null
  }
  if (!isCount(completedSeconds) || (failedSeconds !== null && !isCount(failedSeconds))) return null
  const taken = readUnits(execute ? document.purged : document.wouldPurge, execute)
  const outcomeNotKnown = readUnits(document.outcomeNotKnown, false)
  if (taken === null || outcomeNotKnown === null) return null
  return { execute, finished, more, completedSeconds, failedSeconds, taken, outcomeNotKnown }
}

/** What the checker reads of an `inspect --key` that found a task: the key's sha256, and how many runs the task holds. */
export interface LookupRead {
  readonly keySha256: string
  readonly runs: number
}

export function readLookup(value: unknown, queue: string): LookupRead | null {
  const document = documentOf(value, 'inspect', queue)
  if (document === null || document.exit !== 'done' || !isRecord(document.task)) return null
  const key = document.task.idempotencyKey
  return isRecord(key) && isText(key.sha256) && Array.isArray(document.runs)
    ? { keySha256: key.sha256, runs: document.runs.length }
    : null
}

/** The task an `explain` is of, and the cause it names. */
export interface ExplanationRead {
  readonly taskId: string
  readonly cause: string
}

export function readExplanation(value: unknown, queue: string): ExplanationRead | null {
  const document = documentOf(value, 'explain', queue)
  if (document === null || document.exit !== 'done') return null
  const { taskId, cause } = document
  return isText(taskId) && isText(cause) ? { taskId, cause } : null
}

/** Whether a document is the report of a `selftest` that passed. It ran on a queue of its own. */
export function readSelftest(value: unknown): boolean {
  const document = documentOf(value, 'selftest')
  return document !== null && document.exit === 'done' && document.passed === true
}

/** One sample of the week: the instant, the row counts, and that day's purge reports. */
interface Sample {
  readonly name: string
  readonly stats: StatsRead
  readonly sizes: WeekRows
  readonly purges: readonly PurgeRead[]
}

/** A receipt as the checker read it: every member once, into what the checks use. */
interface WeekRead {
  readonly start: Sample
  /** Each day's sample, with that day's purge reports, in the receipt's order. */
  readonly days: readonly Sample[]
  readonly end: Sample
  readonly selftest: boolean
  readonly failedDryRun: PurgeRead
  readonly lookups: readonly LookupRead[]
  readonly sealSha256: string
  readonly injection: WeekInjection
  readonly explanation: ExplanationRead
  readonly sealPublishedAtEpochMs: number
}

/** The receipt read once, or what of it is missing or of the wrong type. */
function readWeek(receipt: Json): { read: WeekRead } | { malformed: string[] } {
  const malformed: string[] = []
  const missing = <T>(what: string, fallback: T): T => {
    malformed.push(what)
    return fallback
  }
  const queue = isText(receipt.queue) ? receipt.queue : missing('queue is not a name', '')
  /** A list read item by item: each item that does not read is named, and left out. */
  const listOf = <T>(
    name: string,
    value: unknown,
    what: string,
    readOne: (item: unknown) => T | null,
  ): T[] => {
    if (!Array.isArray(value)) return missing(`${name} is not a list`, [])
    return value.flatMap((item, index) => {
      const one = readOne(item)
      return one === null ? missing(`${name}[${index}] is not ${what}`, []) : [one]
    })
  }

  const sample = (name: string, value: unknown, withPurges: boolean): Sample | null => {
    if (!isRecord(value)) return missing(`${name} is not a sample`, null)
    const stats = readStats(value.stats, queue)
    const sizes = readSizes(value.sizes, queue)
    const purges = withPurges
      ? listOf(`${name}.purges`, value.purges, 'a purge report of the queue', (report) =>
          readPurge(report, queue),
        )
      : []
    if (stats === null) malformed.push(`${name}.stats is not a stats report of the queue`)
    if (sizes === null) malformed.push(`${name}.sizes is not a sizes report of the queue`)
    return stats === null || sizes === null ? null : { name, stats, sizes, purges }
  }
  const start = sample('start', receipt.start, false)
  const listed = Array.isArray(receipt.days) ? receipt.days : missing('days is not a list', [])
  const days = listed.flatMap((day, index) => {
    const one = sample(`days[${index}]`, day, true)
    return one === null ? [] : [one]
  })
  const end = sample('end', receipt.end, false)

  const failedDryRun = readPurge(receipt.failedDryRun, queue)
  if (failedDryRun === null) malformed.push('failedDryRun is not a purge report of the queue')

  const lookups = listOf('lookups', receipt.lookups, 'an inspect of a task of the queue', (one) =>
    readLookup(one, queue),
  )

  const seal = isRecord(receipt.seal) ? receipt.seal.sha256 : undefined
  const sealSha256 = isText(seal) ? seal : missing('seal.sha256 is not a hash', '')

  const revealed = isRecord(receipt.injection) ? receipt.injection : {}
  // The hash is over three lines, so a member that holds a line feed could be read two ways.
  const line = (name: string): string => {
    const value = revealed[name]
    return isText(value) && !value.includes('\n')
      ? value
      : missing(`injection.${name} is not one line of text`, '')
  }
  const injection = { taskId: line('taskId'), cause: line('cause'), nonce: line('nonce') }

  const explanation = readExplanation(receipt.explanation, queue)
  if (explanation === null) malformed.push('explanation is not an explain of a task of the queue')

  const attested = isRecord(receipt.attestation) ? receipt.attestation : {}
  if (!isText(attested.attestedBy)) malformed.push('attestation.attestedBy is not a name')
  const published = attested.sealPublishedAtEpochMs
  const sealPublishedAtEpochMs = isCount(published)
    ? published
    : missing('attestation.sealPublishedAtEpochMs is not an instant', 0)

  // Every member that did not read is named above, so a null here has its line already.
  if (
    malformed.length > 0 ||
    start === null ||
    end === null ||
    failedDryRun === null ||
    explanation === null
  ) {
    return { malformed }
  }
  return {
    read: {
      start,
      days,
      end,
      selftest: readSelftest(receipt.selftest),
      failedDryRun,
      lookups,
      sealSha256,
      injection,
      explanation,
      sealPublishedAtEpochMs,
    },
  }
}

/** The purge reports of the week that deleted: every day's, with `--execute`. */
const executed = (week: WeekRead): PurgeRead[] =>
  week.days.flatMap((one) => one.purges.filter((purge) => purge.execute))

/**
 * The runs the receipt shows its units held beyond the first of each. A purge report
 * prints the rows that went with a unit, and a lookup lists a task's runs. A unit named by
 * both, looked up one day and purged on a later one, counts once, at the most either shows.
 * A unit whose purge was sent and not answered is printed without its rows, and no later
 * document shows it once it went, so it is allowed the attempts of the default retry
 * policy.
 */
function runsBeyondTheFirst(week: WeekRead): number {
  const byKey = new Map<string, number>()
  let unkeyed = 0
  const shown = (keySha256: string | null, runs: number | null): void => {
    if (runs === null || runs <= 1) return
    if (keySha256 === null) unkeyed += runs - 1
    else byKey.set(keySha256, Math.max(byKey.get(keySha256) ?? 0, runs - 1))
  }
  for (const purge of executed(week)) {
    for (const unit of purge.taken) shown(unit.keySha256, unit.runs)
    for (const unit of purge.outcomeNotKnown) shown(unit.keySha256, DEFAULT_MAX_ATTEMPTS)
  }
  for (const lookup of week.lookups) shown(lookup.keySha256, lookup.runs)
  return [...byKey.values()].reduce((sum, runs) => sum + runs, unkeyed)
}

/**
 * The most rows each table may hold at any sample of the week: the start sample's count,
 * plus a digest unit's rows for each hour of the completed window and 25 more, since a
 * daily purge leaves standing the units of its window and of the day and the hour until
 * the next, plus a unit's rows for each failed unit the dry run lists, which a purge with
 * no failed window keeps. A unit's rows count one run, so the bound of runs also allows
 * every run the receipt shows a unit held beyond its first. And the injected task is
 * allowed the rows it comes to hold after the start sample.
 */
function boundOf(week: WeekRead): WeekRows {
  const windowHours = Math.ceil(
    Math.max(0, ...executed(week).map((purge) => purge.completedSeconds)) / 3_600,
  )
  const failedUnits = week.failedDryRun.taken.filter((unit) => unit.state === 'failed').length
  const beyondTheFirst = runsBeyondTheFirst(week)
  return Object.fromEntries(
    QUEUE_TABLES.map((table) => [
      table,
      week.start.sizes[table] +
        (windowHours + WEEK_SAMPLE_GAP_HOURS + failedUnits) * WEEK_DIGEST_UNIT_ROWS[table] +
        (table === 'runs' ? beyondTheFirst : 0) +
        WEEK_INJECTED_UNIT_ROWS[table],
    ]),
  ) as WeekRows
}

/** How many of the week's periods the receipt's purge reports and lookups name. */
function periodsFound(week: WeekRead, startEpochMs: number): number {
  const named = new Set<string>(week.lookups.map((lookup) => lookup.keySha256))
  for (const purge of executed(week)) {
    // A unit whose purge was not answered was named by the listing: its period ran.
    for (const unit of [...purge.taken, ...purge.outcomeNotKnown]) {
      if (unit.keySha256 !== null) named.add(unit.keySha256)
    }
  }
  let found = 0
  for (let hour = 0; hour < WEEK_PERIODS; hour++) {
    if (named.has(sha256(digestKey(digestPeriod(startEpochMs + hour * HOUR_MS))))) found++
  }
  return found
}

/** Every reason a week receipt is refused, or none for one the checker accepts. */
export function weekReceiptErrors(candidate: unknown): readonly WeekRefusal[] {
  if (!isRecord(candidate) || candidate.kind !== 'week') {
    return [{ cause: 'unknown-kind', detail: 'the receipt is not an object of kind week' }]
  }
  const read = readWeek(candidate)
  if ('malformed' in read) {
    return read.malformed.map((detail) => ({ cause: 'malformed', detail }))
  }
  const week = read.read
  const refusals: WeekRefusal[] = []
  const refuse = (cause: WeekRefusalCause, detail: string): void => {
    refusals.push({ cause, detail })
  }
  const { start, days, end } = week
  const samples = [start, ...days, end]

  for (const one of samples) {
    if (one.stats.fakeClock) {
      refuse('test-clock-set', `${one.name} was taken under a test clock, which is no instant`)
    }
  }
  if (end.stats.atEpochMs - start.stats.atEpochMs < WEEK_SPAN_MS) {
    refuse(
      'span-under-seven-days',
      `the end sample is ${end.stats.atEpochMs - start.stats.atEpochMs} ms after the start sample, under ${WEEK_SPAN_MS}`,
    )
  }
  let before = start
  for (const one of [...days, end]) {
    const gap = one.stats.atEpochMs - before.stats.atEpochMs
    if (gap <= 0 || gap > WEEK_SAMPLE_GAP_MS) {
      refuse(
        'missing-daily-snapshot',
        `${one.name} is ${gap} ms after the sample before it, and a sample follows the last within ${WEEK_SAMPLE_GAP_MS}`,
      )
    }
    before = one
  }
  const bound = boundOf(week)
  for (const one of samples) {
    for (const table of QUEUE_TABLES) {
      if (one.sizes[table] > bound[table]) {
        refuse(
          'sizes-over-bound',
          `${one.name} counts ${one.sizes[table]} rows of ${table}, over the bound of ${bound[table]}`,
        )
      }
    }
  }
  const { failedDryRun } = week
  if (
    failedDryRun.execute ||
    failedDryRun.failedSeconds === null ||
    failedDryRun.more ||
    !failedDryRun.finished
  ) {
    refuse(
      'malformed',
      'failedDryRun is not a whole dry run under a failed window: it must name --failed-after, no --execute, and say no more remain',
    )
  }
  const found = periodsFound(week, start.stats.atEpochMs)
  if (found < WEEK_PERIODS_REQUIRED) {
    refuse(
      'periods-missing',
      `${found} of the ${WEEK_PERIODS} periods from the start sample are named by a purge report or a lookup, under ${WEEK_PERIODS_REQUIRED}`,
    )
  }
  if (sealOf(week.injection) !== week.sealSha256) {
    refuse('seal-mismatch', 'the hash is not the sha256 of the task id, the cause and the nonce')
  }
  if (week.sealPublishedAtEpochMs > start.stats.atEpochMs) {
    refuse(
      'seal-published-after-the-start',
      'the hash is attested as published after the start sample was taken',
    )
  }
  if (
    week.explanation.taskId !== week.injection.taskId ||
    week.explanation.cause !== week.injection.cause
  ) {
    refuse(
      'explanation-differs-from-the-seal',
      'the explanation is not of the sealed task, or names another cause than the sealed one',
    )
  }
  for (const one of days) {
    if (!one.purges.some((purge) => purge.execute && purge.finished)) {
      refuse('day-without-purge', `${one.name} holds no purge --execute that finished`)
    }
  }
  if (!week.selftest) {
    refuse('no-selftest-record', 'the receipt holds no report of a selftest that passed')
  }
  return refusals
}

/** Where the command that checks a receipt file prints. */
export interface WeekReceiptIo {
  out(text: string): void
  err(text: string): void
}

/**
 * Check the week receipt in the file named. It exits 0 when the checker accepts the
 * receipt, 1 when it refuses it, with each refusal on a line of its own, and 2 when the
 * command line names no one file, or the file is not there or is not JSON.
 */
export function checkWeekReceiptFile(argv: readonly string[], io: WeekReceiptIo): number {
  const [path, ...more] = argv
  if (path === undefined || more.length > 0) {
    io.err('usage: pnpm week-receipt <receipt.json>\n')
    return 2
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    io.err('the file is not there, or is not JSON\n')
    return 2
  }
  const refusals = weekReceiptErrors(candidate)
  if (refusals.length === 0) {
    io.out('the week receipt is accepted\n')
    return 0
  }
  for (const { cause, detail } of refusals) io.err(`refused: ${cause}: ${detail}\n`)
  io.err(
    `the week receipt is refused, for ${refusals.length} ${refusals.length === 1 ? 'reason' : 'reasons'}\n`,
  )
  return 1
}
