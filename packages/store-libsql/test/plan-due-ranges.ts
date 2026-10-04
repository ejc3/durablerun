import { readFileSync } from 'node:fs'
import { type Shipped, keyOf } from './plan-history.js'
import type { NestReading } from './plan-nests.js'

/**
 * What the plan test (`query-plans.test.ts`) and the measured surface
 * (`plan-reader-surface.test.ts`) both hold about a due range that drives no other step:
 * the table that names each statement with one, how a statement is named in it, and the
 * one rule for whether a reading's lone due ranges are the ones the table names. The plan
 * test holds the table to the shipped statements in both directions. The surface excuses a
 * statement that grew by it, and by nothing wider.
 */

/** The generated corpus of the statement trees this store compiles, by label and variant. */
export const CORPUS: Record<string, Record<string, { sql: string }[]>> = JSON.parse(
  readFileSync(new URL('../../conformance/corpus/libsql.json', import.meta.url), 'utf8'),
)

/** A range of tasks past their cancellation deadline, which the sweep's scan also drives by. */
export const TASKS_PAST_THEIR_DEADLINE =
  'SEARCH t USING INDEX tasks_cancel (queue=? AND cancel_at_ms>? AND cancel_at_ms<?)'
/** Every run of one state that holds an available instant: a range with no upper end. */
export const RUNS_COUNTED =
  'SEARCH r USING COVERING INDEX runs_poll (queue=? AND state=? AND available_at_ms>?)'
/** Every live task of one state, in the order they were enqueued: a range with no upper end. */
export const LIVE_TASKS =
  'SEARCH t USING INDEX tasks_live (queue=? AND state=? AND enqueue_at_ms>?)'
/** The same range for a gauge, which selects only what the index holds. */
export const LIVE_TASKS_COUNTED =
  'SEARCH t USING COVERING INDEX tasks_live (queue=? AND state=? AND enqueue_at_ms>?)'

/**
 * A due range that drives no other step is bounded the same way and shown no better, so
 * every statement that has one is named here too, with the lines and with what bounds
 * them: the statement's own LIMIT, which must then be the last thing its text holds, or
 * that the range is read for its first row alone, by a minimum over its column.
 */
export const A_DUE_RANGE_ALONE: Readonly<
  Record<string, { ranges: readonly string[]; boundedBy: 'LIMIT' | 'its first row' }>
> = {
  // Each source of the next wake is the minimum of one instant, which is its range's
  // first row.
  'next-wake/read#0': {
    ranges: [
      'SEARCH r USING COVERING INDEX runs_poll (queue=? AND state=? AND available_at_ms>? AND available_at_ms<?)',
      'SEARCH r USING COVERING INDEX runs_lease (queue=? AND claim_expires_at_ms>? AND claim_expires_at_ms<?)',
      TASKS_PAST_THEIR_DEADLINE,
    ],
    boundedBy: 'its first row',
  },
  // An operator's gauges. Each leg reads every row of one state that holds an instant,
  // earliest first, and stops one row past the gauge's cap: it grows with the backlog by
  // design, up to that limit.
  'queue-status/read#0': { ranges: [RUNS_COUNTED], boundedBy: 'LIMIT' },
  'queue-status/read#1': { ranges: [RUNS_COUNTED], boundedBy: 'LIMIT' },
  'queue-status/read#2': {
    ranges: ['SEARCH r USING COVERING INDEX runs_lease (queue=? AND claim_expires_at_ms>?)'],
    boundedBy: 'LIMIT',
  },
  'queue-status/read#3': {
    ranges: ['SEARCH t USING INDEX tasks_cancel (queue=? AND cancel_at_ms>?)'],
    boundedBy: 'LIMIT',
  },
  // The gauge of live tasks: the live tasks of each state, oldest first, up to one row
  // past the cap, answered by the index alone. The fifth statement of the batch reads
  // the clock and no table.
  'queue-status/read#5': { ranges: [LIVE_TASKS_COUNTED], boundedBy: 'LIMIT' },
  'queue-status/read#6': { ranges: [LIVE_TASKS_COUNTED], boundedBy: 'LIMIT' },
  'queue-status/read#7': { ranges: [LIVE_TASKS_COUNTED], boundedBy: 'LIMIT' },
  // An operator's read of a queue's oldest live tasks: each state's, oldest first, up to
  // one row past the limit it was asked for. It grows with the queue's live tasks by
  // design, up to that limit.
  'aged-tasks/read#0': { ranges: [LIVE_TASKS], boundedBy: 'LIMIT' },
  'aged-tasks/read#1': { ranges: [LIVE_TASKS], boundedBy: 'LIMIT' },
  'aged-tasks/read#2': { ranges: [LIVE_TASKS], boundedBy: 'LIMIT' },
}

/** A statement's name: where the corpus holds it, or for text its place in its batch. */
export const placeInCorpus = new Map<string, string>()
for (const [label, variants] of Object.entries(CORPUS)) {
  for (const [variant, signature] of Object.entries(variants)) {
    for (const [i, st] of signature.entries()) {
      if (!placeInCorpus.has(keyOf(label, st.sql))) {
        placeInCorpus.set(keyOf(label, st.sql), `${label}/${variant}#${i}`)
      }
    }
  }
}
export const nameOf = (st: Pick<Shipped, 'label' | 'sql' | 'index'>) =>
  placeInCorpus.get(keyOf(st.label, st.sql)) ?? `${st.label}#${st.index}`

/** The due ranges of a reading that drive no other step. */
export const loneDueRanges = (reading: NestReading): string[] =>
  reading.dueRanges.filter((range) => !reading.dueDrivers.includes(range))

/**
 * Whether a statement's text holds the bound its entry names: its own LIMIT, which must be
 * the last thing the text holds, or a minimum over the range's column.
 */
export const boundHolds = (boundedBy: 'LIMIT' | 'its first row', sql: string): boolean =>
  (boundedBy === 'LIMIT' ? / limit \?$/i : /\bmin\(/i).test(sql)

/**
 * Whether a reading's lone due ranges are excused by the table: the statement of that name
 * is in it, the reading has a lone due range, every one of them is a line the entry names,
 * and the text read still holds the entry's bound. A variation of a shipped statement that
 * reads a due range through another index, or that lost its LIMIT, is not.
 */
export function aloneAsNamed(name: string, reading: NestReading, sql: string): boolean {
  const entry = A_DUE_RANGE_ALONE[name]
  const lone = loneDueRanges(reading)
  return (
    entry !== undefined &&
    lone.length > 0 &&
    lone.every((range) => entry.ranges.includes(range)) &&
    boundHolds(entry.boundedBy, sql)
  )
}
