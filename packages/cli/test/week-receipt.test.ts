import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUEUE_TABLES, type QueueTable } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
// The checker is taken from receipt.ts, which exit test line 44 names as its home.
import { weekReceiptErrors } from '../../../apps/dogfood/src/receipt.js'
import {
  HOUR_MS,
  WEEK_DIGEST_UNIT_ROWS,
  WEEK_PERIODS,
  WEEK_PERIODS_REQUIRED,
  WEEK_SPAN_MS,
  type WeekRefusalCause,
  checkWeekReceiptFile,
  digestKey,
  digestPeriod,
  sealOf,
} from '../../../apps/dogfood/src/week-receipt.js'
import { ROOT } from './support.js'
import {
  FAILED_PERIOD,
  INJECTION,
  RETRIED_PERIOD,
  RUNS_BEYOND_THE_FIRST,
  START_MS,
  START_ROWS,
  WINDOW_HOURS,
  type WeekReceipt,
  genuineWeek,
  keyOfPeriod,
  lookup,
} from './week-fixture.js'

/**
 * Exit test line 44's receipt checker. One well-formed receipt is accepted. Each doctored
 * receipt is the well-formed one with one thing broken by one function, and it is refused
 * for the cause its name gives and for no other. The checker fails closed: a kind it does
 * not know, and every member it reads, taken away or of the wrong type, is refused.
 */

type Json = Record<string, unknown>

const causes = (receipt: unknown): WeekRefusalCause[] =>
  weekReceiptErrors(receipt).map((refusal) => refusal.cause)

/** The units a day's purge reports name as purged. */
const purgedOf = (receipt: WeekReceipt, day: number): Json[] =>
  (receipt.days[day]?.purges[0]?.purged ?? []) as Json[]

/** Move a day's purge reports to the day after it, so no unit they name leaves the receipt. */
function purgesMovedToTheNextDay(receipt: WeekReceipt, day: number): void {
  const from = receipt.days[day]
  const to = receipt.days[day + 1]
  if (from === undefined || to === undefined) throw new Error(`the week has no day ${day + 1}`)
  to.purges.unshift(...from.purges)
  from.purges = []
}

/**
 * The bound of the well-formed receipt, said here a second time from what the fixture
 * models: the start sample's rows, a unit's rows for each hour of the window and 25 more
 * and for the one failed unit, and of runs the ones its units held beyond their first.
 */
const boundOf = (table: QueueTable): number =>
  START_ROWS[table] +
  (WINDOW_HOURS + 25 + 1) * WEEK_DIGEST_UNIT_ROWS[table] +
  (table === 'runs' ? RUNS_BEYOND_THE_FIRST : 0)

const setCount = (sample: { sizes: Json }, table: string, count: number): void => {
  ;((sample.sizes.tables as Json)[table] as Json).count = count
}

const setInstant = (sample: { stats: Json }, atEpochMs: number): void => {
  sample.stats.databaseNowEpochMs = atEpochMs
}

const instantOf = (sample: { stats: Json }): number => sample.stats.databaseNowEpochMs as number

/** Take `count` purged units out of the receipt's purge reports, from the first day that holds any. */
function unitsDropped(receipt: WeekReceipt, count: number): void {
  let left = count
  for (const [day] of receipt.days.entries()) {
    const units = purgedOf(receipt, day)
    left -= units.splice(0, left).length
  }
  if (left !== 0) throw new Error('the week purged fewer units than the test drops')
}

interface Doctored {
  /** What is wrong with the receipt, as BUILD.md's line 44 lists it. */
  readonly name: string
  readonly cause: WeekRefusalCause
  breaks(receipt: WeekReceipt): void
}

/** The eight doctored receipts of line 44, each the well-formed one with one thing broken. */
const DOCTORED: readonly Doctored[] = [
  {
    name: 'six days between the first snapshot and the last',
    cause: 'span-under-seven-days',
    // Every sample moves toward the start by the same ratio, so the samples stay in order
    // and under a day apart, and the purge reports and the periods they name are untouched.
    breaks: (receipt) => {
      const span = instantOf(receipt.end) - START_MS
      const squeeze = (sample: { stats: Json }): void =>
        setInstant(
          sample,
          START_MS + Math.floor(((instantOf(sample) - START_MS) * 6 * 24 * HOUR_MS) / span),
        )
      receipt.days.forEach(squeeze)
      squeeze(receipt.end)
    },
  },
  {
    name: 'a missing daily snapshot',
    cause: 'missing-daily-snapshot',
    // The third day's sample goes, and its purge reports stay, with the day after it.
    breaks: (receipt) => {
      purgesMovedToTheNextDay(receipt, 2)
      receipt.days.splice(2, 1)
    },
  },
  {
    name: 'a sizes count one row over the bound',
    cause: 'sizes-over-bound',
    breaks: (receipt) => {
      const day = receipt.days[3]
      if (day === undefined) throw new Error('the week has no fourth day')
      setCount(day, 'runs', boundOf('runs') + 1)
    },
  },
  {
    name: 'fewer than 160 of 168 periods found',
    cause: 'periods-missing',
    breaks: (receipt) => unitsDropped(receipt, WEEK_PERIODS - WEEK_PERIODS_REQUIRED + 1),
  },
  {
    name: 'a sealed hash that is not the sha256 of the injected task id, cause and nonce',
    cause: 'seal-mismatch',
    breaks: (receipt) => {
      receipt.seal.sha256 = sealOf({ ...INJECTION, nonce: 'another-nonce' })
    },
  },
  {
    name: 'an explanation that names another cause than the seal',
    cause: 'explanation-differs-from-the-seal',
    breaks: (receipt) => {
      receipt.explanation.cause = 'never-started'
    },
  },
  {
    name: 'a day with no purge --execute',
    cause: 'day-without-purge',
    // The fourth day ran no purge, and the day after it took what that purge would have.
    breaks: (receipt) => purgesMovedToTheNextDay(receipt, 3),
  },
  {
    name: 'no selftest record',
    cause: 'no-selftest-record',
    breaks: (receipt) => {
      // biome-ignore lint/performance/noDelete: the member is taken away, not set to undefined.
      delete receipt.selftest
    },
  },
]

const doctored = (one: Doctored): WeekReceipt => {
  const receipt = genuineWeek()
  one.breaks(receipt)
  return receipt
}

/** The doctored receipt of that cause is refused for it, and for no other. */
function refusedForItsCause(cause: WeekRefusalCause, marker: string): void {
  const one = DOCTORED.find((entry) => entry.cause === cause)
  if (one === undefined) throw new Error(`no doctored receipt is refused for ${cause}`)
  expect({ name: one.name, causes: causes(doctored(one)) }, marker).toEqual({
    name: one.name,
    causes: [one.cause],
  })
}

describe('the week receipt checker', () => {
  it('accepts the well-formed receipt', () => {
    expect(weekReceiptErrors(genuineWeek())).toEqual([])
    // The receipt is plain JSON: what a file holds is what the checker accepted.
    expect(weekReceiptErrors(JSON.parse(JSON.stringify(genuineWeek())))).toEqual([])
  })

  it('refuses six days between the first snapshot and the last, for that cause and no other', () => {
    refusedForItsCause(
      'span-under-seven-days',
      'mutation-verdict:behavior:week-receipt-refuses-a-span-under-seven-days',
    )
  })

  it('refuses a missing daily snapshot, for that cause and no other', () => {
    refusedForItsCause(
      'missing-daily-snapshot',
      'mutation-verdict:behavior:week-receipt-refuses-a-missing-daily-snapshot',
    )
  })

  it('refuses a sizes count one row over the bound, for that cause and no other', () => {
    refusedForItsCause(
      'sizes-over-bound',
      'mutation-verdict:behavior:week-receipt-refuses-a-count-over-the-bound',
    )
  })

  it('refuses fewer than 160 of 168 periods found, for that cause and no other', () => {
    refusedForItsCause(
      'periods-missing',
      'mutation-verdict:behavior:week-receipt-refuses-fewer-than-160-periods',
    )
  })

  it('refuses a sealed hash that is not the sha256 of the injected task id, cause and nonce, for that cause and no other', () => {
    refusedForItsCause(
      'seal-mismatch',
      'mutation-verdict:behavior:week-receipt-refuses-a-seal-that-does-not-match',
    )
  })

  it('refuses an explanation that names another cause than the seal, for that cause and no other', () => {
    refusedForItsCause(
      'explanation-differs-from-the-seal',
      'mutation-verdict:behavior:week-receipt-refuses-an-explanation-of-another-cause',
    )
  })

  it('refuses a day with no purge --execute, for that cause and no other', () => {
    refusedForItsCause(
      'day-without-purge',
      'mutation-verdict:behavior:week-receipt-refuses-a-day-without-a-purge',
    )
  })

  it('refuses no selftest record, for that cause and no other', () => {
    refusedForItsCause(
      'no-selftest-record',
      'mutation-verdict:behavior:week-receipt-refuses-no-selftest-record',
    )
  })

  it('accepts a count at the bound, and 160 periods found: each refusal starts one past its floor', () => {
    const atTheBound = genuineWeek()
    for (const table of QUEUE_TABLES) {
      const day = atTheBound.days[3]
      if (day !== undefined) setCount(day, table, boundOf(table))
    }
    expect(weekReceiptErrors(atTheBound)).toEqual([])
    const enough = genuineWeek()
    unitsDropped(enough, WEEK_PERIODS - WEEK_PERIODS_REQUIRED)
    expect(weekReceiptErrors(enough)).toEqual([])
    // A week and no less: one millisecond under seven days is refused, and seven days is not.
    const short = genuineWeek()
    setInstant(short.end, START_MS + WEEK_SPAN_MS - 1)
    expect(causes(short)).toEqual(['span-under-seven-days'])
    setInstant(short.end, START_MS + WEEK_SPAN_MS)
    expect(weekReceiptErrors(short)).toEqual([])
  })

  it("fails the period count when one day's purge report is dropped, and says that day ran no purge", () => {
    const receipt = genuineWeek()
    const day = receipt.days[2]
    if (day === undefined) throw new Error('the week has no third day')
    day.purges = []
    expect(causes(receipt).sort()).toEqual(['day-without-purge', 'periods-missing'])
  })

  it('counts a period whose purge was sent and not answered: a lost answer loses no period', () => {
    const receipt = genuineWeek()
    const report = receipt.days[3]?.purges[0]
    if (report === undefined) throw new Error('the week has no fourth day')
    // The store failed partway: the report holds what it reached and the units in doubt.
    const units = report.purged as Json[]
    report.outcomeNotKnown = units.splice(0, units.length)
    report.finished = false
    report.exit = 'unavailable'
    receipt.days[3]?.purges.push({ ...report, purged: [], outcomeNotKnown: [], finished: true })
    expect(
      weekReceiptErrors(receipt),
      'mutation-verdict:behavior:week-receipt-counts-a-unit-whose-answer-was-lost',
    ).toEqual([])
    // The report in doubt printed no rows of the unit that was tried twice, which is among
    // its units, and the bound of runs still allows that unit its attempts.
    expect(
      (report.outcomeNotKnown as Json[]).some(
        (unit) => unit.idempotencyKeySha256 === keyOfPeriod(RETRIED_PERIOD),
      ),
    ).toBe(true)
  })

  it('allows a unit the runs its purge report or its lookup shows beyond the first, and no run the receipt does not show', () => {
    // The well-formed week is at its bound of runs on the fourth day, with a unit that was
    // tried twice and a failed one that was tried five times.
    expect(
      weekReceiptErrors(genuineWeek()),
      'mutation-verdict:behavior:week-receipt-allows-the-runs-it-shows',
    ).toEqual([])
    const day = genuineWeek().days[3]
    expect(((day?.sizes.tables as Json).runs as Json).count).toBe(boundOf('runs'))
    // The purge report of the unit tried twice says one run went: the second is not allowed.
    const purged = genuineWeek()
    for (const [index] of purged.days.entries()) {
      for (const unit of purgedOf(purged, index)) {
        if (unit.idempotencyKeySha256 === keyOfPeriod(RETRIED_PERIOD)) {
          ;(unit.rows as Json).runs = 1
        }
      }
    }
    expect(causes(purged)).toEqual(['sizes-over-bound'])
    // The lookup of the failed unit lists one run: its other four are not allowed.
    const looked = genuineWeek()
    const ofTheFailed = looked.lookups.find(
      (one) => ((one.task as Json).idempotencyKey as Json).sha256 === keyOfPeriod(FAILED_PERIOD),
    )
    if (ofTheFailed === undefined) throw new Error('the week looks up no failed period')
    ofTheFailed.runs = [(ofTheFailed.runs as unknown[])[0]]
    expect([...new Set(causes(looked))]).toEqual(['sizes-over-bound'])
    // A unit looked up one day and purged on a later one counts once.
    const both = genuineWeek()
    const report = both.days[3]?.purges[0]
    const retried = (report?.purged as Json[] | undefined)?.find(
      (unit) => unit.idempotencyKeySha256 === keyOfPeriod(RETRIED_PERIOD),
    )
    if (retried === undefined) throw new Error('the fourth day purges no retried period')
    both.lookups.push(lookup(RETRIED_PERIOD))
    const fourth = both.days[3]
    if (fourth !== undefined) setCount(fourth, 'runs', boundOf('runs') + 1)
    expect(causes(both)).toEqual(['sizes-over-bound'])
  })

  it('counts a period by the sha256 of its key, named for the UTC hour of each hour from the start sample', () => {
    expect(digestPeriod(Date.UTC(2026, 0, 5, 9, 20))).toBe('2026-01-05T09')
    expect(digestPeriod(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31T23')
    expect(digestKey('2026-01-05T09')).toBe('digest-2026-01-05T09')
    // A lookup of a period of another week is no period of this one.
    const receipt = genuineWeek()
    unitsDropped(receipt, 9)
    for (const index of [-3, -2, -1, 169, 170, 171, 172, 173, 174]) {
      receipt.lookups.push(lookup(index))
    }
    expect(causes(receipt)).toEqual(['periods-missing'])
  })

  it('refuses a sample taken under a test clock, a hash attested as published after the start sample, an explanation of another task, and a selftest that did not pass', () => {
    const clock = genuineWeek()
    if (clock.days[1] !== undefined) clock.days[1].stats.fakeClock = true
    expect(causes(clock), 'mutation-verdict:behavior:week-receipt-refuses-a-test-clock').toEqual([
      'test-clock-set',
    ])
    const late = genuineWeek()
    late.attestation.sealPublishedAtEpochMs = START_MS + 1
    expect(causes(late)).toEqual(['seal-published-after-the-start'])
    late.attestation.sealPublishedAtEpochMs = START_MS
    expect(causes(late)).toEqual([])
    const other = genuineWeek()
    other.explanation.taskId = 'another-task'
    expect(causes(other)).toEqual(['explanation-differs-from-the-seal'])
    const failed = genuineWeek()
    if (failed.selftest !== undefined) failed.selftest.passed = false
    expect(causes(failed)).toEqual(['no-selftest-record'])
  })

  it('refuses a count the command capped, a dry run that is no whole dry run under a failed window, and a document of another queue', () => {
    const capped = genuineWeek()
    ;((capped.end.sizes.tables as Json).tasks as Json).atLeast = true
    expect(causes(capped)).toEqual(['sizes-over-bound'])
    for (const change of [
      (dryRun: Json) => {
        dryRun.execute = true
        dryRun.purged = dryRun.wouldPurge
      },
      (dryRun: Json) => {
        ;(dryRun.policy as Json).failedSeconds = null
      },
      (dryRun: Json) => {
        dryRun.more = true
      },
      (dryRun: Json) => {
        dryRun.finished = false
      },
    ]) {
      const receipt = genuineWeek()
      change(receipt.failedDryRun)
      expect(causes(receipt)).toEqual(['malformed'])
    }
    const elsewhere = genuineWeek()
    const report = elsewhere.days[2]?.purges[0]
    if (report !== undefined) report.queue = 'another-queue'
    expect(causes(elsewhere)).toEqual(['malformed'])
    // Each failed unit the dry run lists raises the bound by a unit's rows, and no more.
    const twoFailed = genuineWeek()
    const listed = twoFailed.failedDryRun.wouldPurge as Json[]
    listed.push({ ...(listed[0] as Json), taskId: 'another-failed-task' })
    const day = twoFailed.days[3]
    if (day === undefined) throw new Error('the week has no fourth day')
    for (const table of QUEUE_TABLES) {
      setCount(day, table, boundOf(table) + WEEK_DIGEST_UNIT_ROWS[table])
    }
    expect(causes(twoFailed)).toEqual([])
    setCount(day, 'tasks', boundOf('tasks') + WEEK_DIGEST_UNIT_ROWS.tasks + 1)
    expect(causes(twoFailed)).toEqual(['sizes-over-bound'])
  })
})

/** Every path of a value, to its containers and its leaves. */
function pathsOf(value: unknown, path: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return [[...path], ...value.flatMap((item, index) => pathsOf(item, [...path, index]))]
  }
  if (typeof value === 'object' && value !== null) {
    return [
      [...path],
      ...Object.entries(value).flatMap(([key, item]) => pathsOf(item, [...path, key])),
    ]
  }
  return [[...path]]
}

/** A copy of the receipt whose every member read is recorded, by its path. */
function recording(value: unknown, path: string, read: Set<string>): unknown {
  if (typeof value !== 'object' || value === null) return value
  return new Proxy(value, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver)
      if (typeof key !== 'string' || !Object.hasOwn(target, key)) return member
      const at = path === '' ? key : `${path}.${key}`
      read.add(at)
      return recording(member, at, read)
    },
  })
}

const at = (
  receipt: unknown,
  path: readonly (string | number)[],
): { parent: Json; key: string } => {
  let parent = receipt as Json
  for (const step of path.slice(0, -1)) parent = parent[step] as Json
  return { parent, key: String(path.at(-1)) }
}

/** A value of another type than the one given, and of no type a member that may be null takes. */
const ofAnotherType = (value: unknown): unknown => (typeof value === 'string' ? 7 : 'x')

describe('the week receipt checker fails closed', () => {
  it('refuses a receipt of a kind it does not know, of no kind, and one that is no object', () => {
    for (const candidate of [
      { ...genuineWeek(), kind: 'dogfood' },
      { ...genuineWeek(), kind: undefined },
      { ...genuineWeek(), kind: 7 },
      null,
      [],
      'week',
      7,
    ]) {
      expect(
        causes(candidate),
        'mutation-verdict:behavior:week-receipt-refuses-an-unknown-kind',
      ).toEqual(['unknown-kind'])
    }
  })

  it('refuses the receipt with any member it reads taken away, or of another type', () => {
    const read = new Set<string>()
    expect(weekReceiptErrors(recording(genuineWeek(), '', read))).toEqual([])
    const paths = pathsOf(genuineWeek()).filter(
      (path) => path.length > 0 && read.has(path.join('.')),
    )
    // The checker reads the members of every document it holds: well over a hundred.
    expect(paths.length).toBeGreaterThan(100)
    for (const path of paths) {
      const name = path.join('.')
      const missing = genuineWeek()
      const gone = at(missing, path)
      if (Array.isArray(gone.parent)) gone.parent.splice(Number(gone.key), 1, undefined)
      else delete gone.parent[gone.key]
      expect(
        { name, refused: weekReceiptErrors(missing).length > 0 },
        'mutation-verdict:behavior:week-receipt-fails-closed',
      ).toEqual({ name, refused: true })
      const wrong = genuineWeek()
      const changed = at(wrong, path)
      changed.parent[changed.key] = ofAnotherType(changed.parent[changed.key])
      expect(
        { name, refused: weekReceiptErrors(wrong).length > 0 },
        'mutation-verdict:behavior:week-receipt-fails-closed',
      ).toEqual({ name, refused: true })
    }
  })
})

describe('the week receipt checker as a command', () => {
  const ENTRY = join(ROOT, 'apps', 'dogfood', 'src', 'week-receipt-cli.ts')

  const check = (argv: readonly string[]): { exit: number; out: string; err: string } => {
    let out = ''
    let err = ''
    const exit = checkWeekReceiptFile(argv, {
      out: (text) => {
        out += text
      },
      err: (text) => {
        err += text
      },
    })
    return { exit, out, err }
  }

  it('exits 0 for the well-formed receipt and 1 for each doctored one, naming its cause', () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-week-receipt-'))
    try {
      const file = (name: string, receipt: unknown): string => {
        const path = join(dir, `${name}.json`)
        writeFileSync(path, JSON.stringify(receipt))
        return path
      }
      expect(check([file('well-formed', genuineWeek())])).toEqual({
        exit: 0,
        out: 'the week receipt is accepted\n',
        err: '',
      })
      // Line 44 lists eight, and each is refused for a cause of its own.
      expect(new Set(DOCTORED.map((one) => one.cause)).size).toBe(8)
      for (const [index, one] of DOCTORED.entries()) {
        const run = check([file(`doctored-${index}`, doctored(one))])
        expect({ name: one.name, exit: run.exit, out: run.out }).toEqual({
          name: one.name,
          exit: 1,
          out: '',
        })
        expect(run.err.split('\n').filter((line) => line !== '').length).toBe(2)
        expect(run.err).toContain(`refused: ${one.cause}: `)
      }
      // No file named, two files named, a file that is not there, and one that is not JSON.
      expect(check([]).exit).toBe(2)
      expect(check([file('a', {}), file('b', {})]).exit).toBe(2)
      expect(check([join(dir, 'not-there.json')]).exit).toBe(2)
      const text = join(dir, 'text.json')
      writeFileSync(text, 'not JSON')
      expect(check([text]).exit).toBe(2)
      // The entry a person runs gives the same exits.
      const run = (path: string) =>
        spawnSync(process.execPath, ['--import', 'tsx', ENTRY, path], { encoding: 'utf8' })
      const first = DOCTORED[0]
      if (first === undefined) throw new Error('no doctored receipt')
      expect(run(file('well-formed', genuineWeek())).status).toBe(0)
      expect(run(file('doctored', doctored(first))).status).toBe(1)
      expect(run(join(dir, 'not-there.json')).status).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
