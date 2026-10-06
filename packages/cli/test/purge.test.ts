import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PURGE_UNIT_CHECKPOINTS,
  PURGE_BARRIER_CONDITIONS,
  type PurgeBarrierCondition,
  type SqlStatement,
  taskDoneEventName,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { CURRENT_SCHEMA_VERSION, READABLE_SCHEMA_WINDOW } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { NAMING_FAILED } from '../../conformance/src/retention-policies.js'
import { handWrittenRun, handWrittenTask } from '../../conformance/src/scenario.js'
import { COMMANDS, PURGE_DEFAULT_LIMIT, VERBS } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import { type StoreOpener, openStore } from '../src/open-store.js'
import { REASON_OF_CONDITION } from '../src/purge.js'
import { runOf } from './queue-seeds.js'
import {
  COMPLETED_KEY,
  type CliDb,
  type FaultSite,
  type JsonAnswer,
  NOW_MS,
  PURGE_EVERY_STATE,
  PURGE_WINDOWS,
  QUEUE,
  SENTINEL,
  type SeededTasks,
  changedBy,
  childrenOfARunningParent,
  claimActivated,
  faulting,
  onDb,
  openCliDb,
  openerWrapping,
  recordingOpener,
  runCli,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * `purge` through `main` on libSQL (exit test line 43): the one command by which an
 * operator deletes durable state. What it must not do is held as closely as what it does.
 * A dry run and every refusal leave a dump of every table as it was and send no purge
 * batch, and each is shown beside the same command line with the refusal's cause taken
 * away, which changes the database. That the command is the retention port's calls and
 * nothing else is held on every dialect by purge-twin.test.ts.
 *
 * A purge refuses under a test clock, and every database of these tests starts with one
 * set. So a case seeds its tasks under that clock, at an instant years in the past, and
 * then clears it: by the database's own clock every seeded ending is then far older than
 * any window a case names.
 */

interface Unit {
  readonly taskId: string
  readonly taskName: string
  readonly state: string
  readonly endedAtMs: number
  readonly idempotencyKeySha256: string | null
  readonly rows?: Readonly<Record<string, number>>
  readonly reasons?: readonly string[]
  readonly conditionsNotHeld?: readonly string[]
}

type PurgeAnswer = JsonAnswer & {
  readonly purged?: readonly Unit[]
  readonly wouldPurge?: readonly Unit[]
  readonly kept?: readonly Unit[]
  readonly gone?: readonly Unit[]
  readonly outcomeNotKnown?: readonly Unit[]
  readonly examined?: number
  readonly more?: boolean
  readonly resumeAfter?: string | null
  readonly finished?: boolean
  readonly stoppedAt?: { readonly call: string; readonly taskId?: string }
}

let asked = 0
/** Run `purge` with --json. Each run is a process of its own, so each mints ids of its own. */
async function purge(db: CliDb, flags: readonly string[], opener: StoreOpener = openStore) {
  asked += 1
  const run = await runCli(
    ['purge', ...flags, ...writeFlags(db), '--json'],
    db.env,
    opener,
    testIdSource(`purge-${asked}`),
  )
  return { exit: run.exit, stderr: run.stderr, answer: JSON.parse(run.stdout) as PurgeAnswer }
}

/** The same in human text, which is what an operator at a terminal reads. */
const purgeText = (db: CliDb, flags: readonly string[], opener: StoreOpener = openStore) =>
  runCli(['purge', ...flags, ...writeFlags(db)], db.env, opener)

const idsOf = (units: readonly Unit[] | undefined): string[] =>
  (units ?? []).map((unit) => unit.taskId)

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const write = (db: CliDb, ...statements: SqlStatement[]) =>
  db.raw.batch('fixture:planted', statements)

async function column(db: CliDb, sql: string, args: SqlStatement['args'] = []): Promise<string[]> {
  const [read] = await db.raw.batch('fixture:read', [{ sql, args }], 'read')
  return (read?.rows ?? []).map((row) => String(row.value))
}

const tasksLeft = (db: CliDb) =>
  column(db, 'SELECT task_id AS value FROM tasks WHERE queue = ? ORDER BY task_id', [QUEUE])

/** Clear the test clock: the database's own clock then reads years past every seeded ending. */
const aged = (db: CliDb) => db.admin.setFakeNowEpochMs(null)

/** Tasks that complete at the instant the clock stands at, in the order their ids sort in. */
async function completedTasks(db: CliDb, count: number, name: string): Promise<string[]> {
  const tasks: string[] = []
  for (let index = 0; index < count; index++) {
    const task = await db.store.spawn(QUEUE, name, '{}')
    const run = await claimActivated(db, `${name}-${index}`, task.taskId)
    await db.store.complete(QUEUE, run.runId, run.claimToken, '{}')
    tasks.push(task.taskId)
  }
  return tasks
}

/** An opener whose store runs `hook` once, straight after the first batch it sends under `label`. */
function afterFirst(label: string, hook: () => Promise<void>): StoreOpener {
  let fired = false
  return openerWrapping((real) => ({
    batch: async (name, statements, control) => {
      const results = await real.batch(name, statements, control)
      if (name === label && !fired) {
        fired = true
        await hook()
      }
      return results
    },
  }))
}

/** The same, straight after the first listing of candidates. */
const afterTheListing = (hook: () => Promise<void>) => afterFirst('purge-candidates', hook)

const faultAt = (site: FaultSite, fault: Parameters<typeof faulting>[2]): StoreOpener =>
  openerWrapping((real) => faulting(real, site, fault))

describe('purge on libSQL', () => {
  it('is the one command that calls the retention port, and it requires its store, its queue and two windows, and takes no --yes', () => {
    expect(
      VERBS.filter((verb) =>
        COMMANDS[verb].ports.some((port) => port.call.startsWith('retention.')),
      ),
    ).toEqual(['purge'])
    const { flags, ports, writes, opensStore } = COMMANDS.purge
    expect({
      writes,
      opensStore,
      required: Object.entries(flags)
        .filter(([, flag]) => flag.required === true)
        .map(([name]) => name)
        .sort(),
      // The dry run is the default and --execute is the one confirmation: a --yes beside
      // it would be a second spelling of the same word.
      yes: Object.hasOwn(flags, 'yes'),
      execute: flags.execute?.type,
      failedAfter: flags['failed-after']?.required,
      calls: ports.map((port) => port.call).filter((call) => call.startsWith('retention.')),
      defaultLimit: PURGE_DEFAULT_LIMIT,
    }).toEqual({
      writes: true,
      opensStore: true,
      required: ['cancelled-after', 'completed-after', 'queue', 'target'],
      yes: false,
      execute: 'boolean',
      failedAfter: undefined,
      calls: ['retention.purgeCandidates', 'retention.purgeUnit', 'retention.purgeAdmission'],
      defaultLimit: 100,
    })
  })

  it('without --execute it lists each candidate with what the barrier says of it, sends only read batches, and leaves every table as it was', () =>
    onDb('purge-dry-run', async (db) => {
      const seeded = await seedTasks(db)
      const [child] = await childrenOfARunningParent(db, 1)
      await aged(db)
      const recorded = recordingOpener()
      const dry = await changedBy(db, () => purge(db, PURGE_EVERY_STATE, recorded.opener))
      const sent = recorded.sent()
      expect(
        {
          exit: dry.out.exit,
          unchanged: dry.unchanged,
          modes: [...new Set(sent.map((batch) => batch.mode))],
          purgeBatches: sent.filter((batch) => batch.label === 'purge-unit').length,
          readsOfTheBarrier: sent.filter((batch) => batch.label === 'purge-admission').length,
          undeclared: sent
            .map((batch) => batch.label)
            .filter((label) => !COMMANDS.purge.ports.some((port) => port.labels.includes(label))),
        },
        'mutation-verdict:behavior:cli-purge-deletes-nothing-without-execute',
      ).toEqual({
        exit: 0,
        unchanged: true,
        modes: ['read'],
        purgeBatches: 0,
        readsOfTheBarrier: 4,
        undeclared: [],
      })
      const { answer } = dry.out
      expect({
        execute: answer.execute,
        wouldPurge: idsOf(answer.wouldPurge).sort(),
        kept: answer.kept,
        gone: answer.gone,
        more: answer.more,
        finished: answer.finished,
        saysItIsOfThisRead: String(answer.dryRun).includes('as of this read'),
        purged: answer.purged,
      }).toEqual({
        execute: false,
        wouldPurge: [seeded.completed, seeded.failed, seeded.cancelled].sort(),
        kept: [
          {
            taskId: child,
            taskName: 'child',
            state: 'completed',
            endedAtMs: NOW_MS,
            idempotencyKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            reasons: ['parent-can-run-again'],
            conditionsNotHeld: ['parentCannotRunAgain'],
          },
        ],
        gone: [],
        more: false,
        finished: true,
        saysItIsOfThisRead: true,
        purged: undefined,
      })
      // In text the dry run prints on stdout, and says what it is.
      const text = await purgeText(db, PURGE_EVERY_STATE)
      expect({
        exit: text.exit,
        stderr: text.stderr,
        saysNothingWasDeleted: text.stdout.includes('dryRun: nothing was deleted'),
        namesTheReason: text.stdout.includes('reasons: parent-can-run-again'),
      }).toEqual({ exit: 0, stderr: '', saysNothingWasDeleted: true, namesTheReason: true })
      // The control: with --execute the same command line changes the database.
      const executed = await changedBy(db, () => purge(db, [...PURGE_EVERY_STATE, '--execute']))
      expect({ exit: executed.out.exit, unchanged: executed.unchanged }).toEqual({
        exit: 0,
        unchanged: false,
      })
    }))

  it('with --execute it purges each unit the barrier lets go, prints each with its id, name, state, ending instant, key digest and rows, and reports a unit the barrier keeps as kept', () =>
    onDb('purge-execute', async (db) => {
      const seeded = await seedTasks(db)
      const [child] = await childrenOfARunningParent(db, 1)
      await aged(db)
      const recorded = recordingOpener()
      const { exit, answer } = await purge(db, [...PURGE_EVERY_STATE, '--execute'], recorded.opener)
      const unit = (taskId: string, state: string, key: string | null, checkpoints: number) => ({
        taskId,
        taskName: 'report',
        state,
        endedAtMs: NOW_MS,
        idempotencyKeySha256: key === null ? null : sha256(key),
        rows: { tasks: 1, runs: 1, checkpoints, waits: 0, events: 1 },
      })
      expect({
        exit,
        execute: answer.execute,
        purged: answer.purged,
        kept: (answer.kept ?? []).map(({ taskId, reasons }) => ({ taskId, reasons })),
        gone: answer.gone,
        more: answer.more,
        finished: answer.finished,
        wouldPurge: answer.wouldPurge,
        dryRun: answer.dryRun,
      }).toEqual({
        exit: 0,
        execute: true,
        purged: [
          unit(seeded.completed, 'completed', COMPLETED_KEY, 1),
          unit(seeded.failed, 'failed', null, 0),
          unit(seeded.cancelled, 'cancelled', null, 0),
        ],
        kept: [{ taskId: child, reasons: ['parent-can-run-again'] }],
        gone: [],
        more: false,
        finished: true,
        wouldPurge: undefined,
        dryRun: undefined,
      })
      // One purge batch to a candidate, and the barrier read of the one the port kept.
      const labels = recorded.sent().map((batch) => batch.label)
      expect({
        purges: labels.filter((label) => label === 'purge-unit').length,
        readsOfTheBarrier: labels.filter((label) => label === 'purge-admission').length,
      }).toEqual({ purges: 4, readsOfTheBarrier: 1 })
      // What went is gone for every command, and what was kept is whole.
      const left = await tasksLeft(db)
      expect(left).toHaveLength(3)
      expect(left).toEqual(expect.arrayContaining([seeded.pending, String(child)]))
      const gone = await runCli(['inspect', seeded.completed, '--queue', QUEUE, '--json'], db.env)
      expect(gone.exit).toBe(exitCode('not-found'))
      // Run again, it finds the kept unit alone, takes nothing, and exits 0.
      const again = await changedBy(db, () => purge(db, [...PURGE_EVERY_STATE, '--execute']))
      expect({
        exit: again.out.exit,
        unchanged: again.unchanged,
        purged: again.out.answer.purged,
        kept: idsOf(again.out.answer.kept),
      }).toEqual({ exit: 0, unchanged: true, purged: [], kept: [child] })
    }))

  it('prints what it purged on stdout in human text, each unit with the rows that went', () =>
    onDb('purge-execute-text', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      const text = await purgeText(db, [...PURGE_WINDOWS, '--execute'])
      expect({
        exit: text.exit,
        stderr: text.stderr,
        namesTheTask: text.stdout.includes(`taskId: ${seeded.completed}`),
        printsTheRows: text.stdout.includes('checkpoints: 1'),
        printsTheDigest: text.stdout.includes(`idempotencyKeySha256: ${sha256(COMPLETED_KEY)}`),
      }).toEqual({
        exit: 0,
        stderr: '',
        namesTheTask: true,
        printsTheRows: true,
        printsTheDigest: true,
      })
    }))

  it('prints an idempotency key as its sha256 and never as itself, with --reveal or without, in a dry run and in a purge', () =>
    onDb('purge-key-digest', async (db) => {
      await seedTasks(db)
      await aged(db)
      const printed: string[] = []
      for (const more of [[], ['--execute']]) {
        for (const output of [[], ['--json']]) {
          for (const reveal of [[], ['--reveal']]) {
            const line = [
              'purge',
              ...PURGE_EVERY_STATE,
              ...more,
              ...writeFlags(db),
              ...output,
              ...reveal,
            ]
            const run = await runCli(line, db.env)
            expect(run.exit, line.join(' ')).toBe(0)
            printed.push(`${run.stdout}${run.stderr}`)
          }
        }
      }
      expect(
        {
          runs: printed.length,
          printedTheKey: printed.some((text) => text.includes(SENTINEL)),
          // The first four runs are dry, and each lists the completed task under its digest.
          printedTheDigest: printed
            .slice(0, 4)
            .every((text) => text.includes(sha256(COMPLETED_KEY))),
        },
        'mutation-verdict:behavior:cli-purge-prints-a-key-only-as-its-digest',
      ).toEqual({ runs: 8, printedTheKey: false, printedTheDigest: true })
    }))

  it('keeps a failed task under a policy that names no failed window: it is never listed, and never purged', () =>
    onDb('purge-failed-kept', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      const dry = await purge(db, PURGE_WINDOWS)
      const executed = await purge(db, [...PURGE_WINDOWS, '--execute'])
      expect({
        policy: dry.answer.policy,
        listed: [...idsOf(dry.answer.wouldPurge), ...idsOf(dry.answer.kept)].includes(
          seeded.failed,
        ),
        purged: idsOf(executed.answer.purged).sort(),
        left: await tasksLeft(db),
      }).toEqual({
        policy: { completedSeconds: 3_600, cancelledSeconds: 3_600, failedSeconds: null },
        listed: false,
        purged: [seeded.completed, seeded.cancelled].sort(),
        left: [seeded.failed, seeded.pending].sort(),
      })
    }))

  it('prints the waits that went with a unit, which is 0 for every unit the engine ends and more for a unit that holds one', () =>
    onDb('purge-waits', async (db) => {
      const seeded = await seedTasks(db)
      // A wait on a run that has ended is a row no engine path leaves: it is written by hand.
      const runId = await runOf(db, seeded.completed)
      await write(db, {
        sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                timeout_at_ms, created_at_ms)
              VALUES (?, 'left-behind', ?, ?, 'left-behind', 'waiting', NULL, ?)`,
        args: [String(runId), QUEUE, seeded.completed, NOW_MS],
      })
      await aged(db)
      const { answer } = await purge(db, [...PURGE_WINDOWS, '--execute'])
      expect(
        Object.fromEntries((answer.purged ?? []).map((unit) => [unit.taskId, unit.rows?.waits])),
      ).toEqual({ [seeded.completed]: 1, [seeded.cancelled]: 0 })
    }))
})

describe('what purge refuses, each beside the command that is not refused', () => {
  /** What a refusal must leave: the exit, no purge batch, and every table as it was. */
  async function refused(db: CliDb, flags: readonly string[]) {
    const recorded = recordingOpener()
    const run = await changedBy(db, () => purge(db, flags, recorded.opener))
    const labels = recorded.sent().map((batch) => batch.label)
    return {
      exit: run.out.exit,
      kind: run.out.answer.error?.kind,
      message: run.out.answer.error?.message ?? '',
      unchanged: run.unchanged,
      labels,
      purgeBatches: labels.filter((label) => label.startsWith('purge-')).length,
    }
  }

  /** The control of a refusal: the command line that is not refused changes the database. */
  async function control(db: CliDb, flags: readonly string[]) {
    const run = await changedBy(db, () => purge(db, flags))
    return { exit: run.out.exit, unchanged: run.unchanged }
  }

  it('refuses under a test clock, though every unit is a window old by that clock, and purges once the clock is cleared', () =>
    onDb('purge-fake-clock', async (db) => {
      await seedTasks(db)
      // Two hours on by the test clock: with no refusal, this purge would take every unit.
      await db.admin.setFakeNowEpochMs(NOW_MS + 7_200_000)
      const asked = await refused(db, [...PURGE_EVERY_STATE, '--execute'])
      expect(
        {
          exit: asked.exit,
          kind: asked.kind,
          unchanged: asked.unchanged,
          purgeBatches: asked.purgeBatches,
        },
        'mutation-verdict:behavior:cli-purge-refuses-under-a-test-clock',
      ).toEqual({ exit: 2, kind: 'fake-clock', unchanged: true, purgeBatches: 0 })
      // A dry run is refused the same way: its verdicts would be read against the test clock.
      const dry = await refused(db, PURGE_EVERY_STATE)
      expect({ exit: dry.exit, kind: dry.kind, purgeBatches: dry.purgeBatches }).toEqual({
        exit: 2,
        kind: 'fake-clock',
        purgeBatches: 0,
      })
      // In text the refusal prints on stderr.
      const text = await purgeText(db, [...PURGE_EVERY_STATE, '--execute'])
      expect({
        exit: text.exit,
        stdout: text.stdout,
        names: text.stderr.includes('kind: fake-clock'),
      }).toEqual({ exit: 2, stdout: '', names: true })
      await aged(db)
      expect(await control(db, [...PURGE_EVERY_STATE, '--execute'])).toEqual({
        exit: 0,
        unchanged: false,
      })
    }))

  it("refuses a database that is not at the build's schema version, at every older version its store's reads accept, and names both versions", async () => {
    const versions = Array.from(
      { length: CURRENT_SCHEMA_VERSION - READABLE_SCHEMA_WINDOW.oldest },
      (_, index) => READABLE_SCHEMA_WINDOW.oldest + index,
    )
    expect([versions[0], versions.at(-1)]).toEqual([5, CURRENT_SCHEMA_VERSION - 1])
    for (const version of versions) {
      const db = await openCliDb('libsql', `purge-version-${version}`, version)
      try {
        await seedTasks(db)
        await aged(db)
        const asked = await refused(db, [...PURGE_EVERY_STATE, '--execute'])
        expect(
          {
            version,
            exit: asked.exit,
            kind: asked.kind,
            unchanged: asked.unchanged,
            labels: asked.labels,
            namesItsOwn: asked.message.includes(`version ${version}`),
            namesTheBuilds: asked.message.includes(`version ${CURRENT_SCHEMA_VERSION}`),
          },
          'mutation-verdict:behavior:cli-purge-refuses-a-schema-that-is-not-the-builds',
        ).toEqual({
          version,
          exit: exitCode('schema'),
          kind: 'schema',
          unchanged: true,
          labels: ['migrate:version'],
          namesItsOwn: true,
          namesTheBuilds: true,
        })
      } finally {
        await db.close()
      }
    }
    // The control: at the build's version the same command line purges.
    await onDb('purge-version-current', async (db) => {
      await seedTasks(db)
      await aged(db)
      expect(await control(db, [...PURGE_EVERY_STATE, '--execute'])).toEqual({
        exit: 0,
        unchanged: false,
      })
    })
  }, 120_000)

  it('refuses a --target that is not its store, or none, before anything opens', () =>
    onDb('purge-target', async (db) => {
      await seedTasks(db)
      await aged(db)
      const line = ['purge', ...PURGE_EVERY_STATE, '--execute', '--queue', QUEUE, '--json']
      const recorded = recordingOpener()
      const elsewhere = await changedBy(db, () =>
        runCli([...line, '--target', `${db.target}.other`], db.env, recorded.opener),
      )
      const unnamed = await changedBy(db, () => runCli(line, db.env, recorded.opener))
      expect(
        {
          elsewhere: [
            elsewhere.out.exit,
            (JSON.parse(elsewhere.out.stdout) as JsonAnswer).error?.kind,
            elsewhere.unchanged,
          ],
          unnamed: [unnamed.out.exit, unnamed.unchanged],
          sent: recorded.sent().length,
        },
        'mutation-verdict:behavior:cli-purge-names-its-store',
      ).toEqual({
        elsewhere: [2, 'target-mismatch', true],
        unnamed: [2, true],
        sent: 0,
      })
      expect(await control(db, [...PURGE_EVERY_STATE, '--execute'])).toEqual({
        exit: 0,
        unchanged: false,
      })
    }))

  it('refuses a window under an hour, a window it cannot read and a missing window, and sends nothing', () =>
    onDb('purge-windows', async (db) => {
      await seedTasks(db)
      await aged(db)
      const cases: Readonly<Record<string, readonly string[]>> = {
        'a completed window one second under an hour': [
          '--completed-after',
          '3599s',
          '--cancelled-after',
          '1h',
        ],
        'a cancelled window a minute under an hour': [
          '--completed-after',
          '1h',
          '--cancelled-after',
          '59m',
        ],
        'a failed window of nothing': [...PURGE_WINDOWS, '--failed-after', '0s'],
        'a window with no unit': ['--completed-after', '3600', '--cancelled-after', '1h'],
        'a window that is no duration': ['--completed-after', 'soon', '--cancelled-after', '1h'],
        'no completed window': ['--cancelled-after', '1h'],
        'no cancelled window': ['--completed-after', '1h'],
        'no window at all': [],
      }
      const answered: Record<string, unknown> = {}
      for (const [what, windows] of Object.entries(cases)) {
        const asked = await refused(db, [...windows, '--execute'])
        answered[what] = [asked.exit, asked.kind, asked.unchanged, asked.labels.length]
      }
      expect(
        answered,
        'mutation-verdict:behavior:cli-purge-refuses-a-window-under-the-floor',
      ).toEqual(Object.fromEntries(Object.keys(cases).map((what) => [what, [2, 'usage', true, 0]])))
      // A missing window says there is no default, and a short one names the floor.
      const missing = await refused(db, ['--completed-after', '1h', '--execute'])
      const short = await refused(db, ['--completed-after', '59m', '--cancelled-after', '1h'])
      expect({
        missing: missing.message.includes('no default window'),
        short: short.message.includes('at least 3600 seconds'),
      }).toEqual({ missing: true, short: true })
      // The control: an hour exactly, written in seconds, is taken.
      expect(
        await control(db, [
          '--completed-after',
          '3600s',
          '--cancelled-after',
          '60m',
          '--failed-after',
          '1h',
          '--execute',
        ]),
      ).toEqual({ exit: 0, unchanged: false })
    }))

  it('refuses --yes and a limit it cannot read, and sends nothing', () =>
    onDb('purge-flags', async (db) => {
      await seedTasks(db)
      await aged(db)
      const answered: unknown[] = []
      for (const more of [['--yes'], ['--limit', '0'], ['--limit', '1001'], ['--limit', 'many']]) {
        const asked = await refused(db, [...PURGE_EVERY_STATE, '--execute', ...more])
        answered.push([more.join(' '), asked.exit, asked.unchanged, asked.labels.length])
      }
      expect(answered).toEqual([
        ['--yes', 2, true, 0],
        ['--limit 0', 2, true, 0],
        ['--limit 1001', 2, true, 0],
        ['--limit many', 2, true, 0],
      ])
      expect(await control(db, [...PURGE_EVERY_STATE, '--execute', '--limit', '1000'])).toEqual({
        exit: 0,
        unchanged: false,
      })
    }))

  it('refuses an --after that is no place a purge printed, before anything is sent, and takes one that is', () =>
    onDb('purge-cursor', async (db) => {
      await completedTasks(db, 2, 'job')
      await aged(db)
      const places = [
        'nowhere',
        '12',
        ':a-task',
        '5:',
        '1e3:a-task',
        '1.5:a-task',
        '007:a-task',
        // Past the last instant the engine stores, in sixteen digits and in seventeen.
        '9999999999999999:a-task',
        '99999999999999999:a-task',
        `1:${'x'.repeat(300)}`,
      ]
      const answered: unknown[] = []
      for (const place of places) {
        const asked = await refused(db, [...PURGE_WINDOWS, '--execute', '--after', place])
        // The refusal does not quote what it was given.
        answered.push([
          asked.exit,
          asked.kind,
          asked.unchanged,
          asked.labels.length,
          asked.message.includes(place),
        ])
      }
      expect(answered).toEqual(places.map(() => [2, 'usage', true, 0, false]))
      // The control: a place before every task is taken, and the purge begins there.
      expect(await control(db, [...PURGE_WINDOWS, '--execute', '--after', '0:a-task'])).toEqual({
        exit: 0,
        unchanged: false,
      })
    }))

  it('creates no database: a purge of a file that is not there exits 5 and leaves no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-purge-missing-'))
    try {
      const file = join(dir, 'never.sqlite')
      const run = await runCli(
        ['purge', ...PURGE_EVERY_STATE, '--execute', '--queue', QUEUE, '--target', file, '--json'],
        { DURABLERUN_STORE_URL: `file:${file}` },
      )
      expect([run.exit, existsSync(file)]).toEqual([exitCode('schema'), false])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('how far one purge goes', () => {
  it('takes at most --limit units, oldest first, and says whether more remain', () =>
    onDb('purge-limit', async (db) => {
      const tasks = await completedTasks(db, 5, 'job')
      await aged(db)
      const dry = await changedBy(db, () => purge(db, [...PURGE_WINDOWS, '--limit', '2']))
      const runs: unknown[] = []
      for (let run = 0; run < 4; run++) {
        const { answer } = await purge(db, [...PURGE_WINDOWS, '--limit', '2', '--execute'])
        runs.push([idsOf(answer.purged), answer.more])
      }
      expect(
        {
          dry: [idsOf(dry.out.answer.wouldPurge), dry.out.answer.more, dry.unchanged],
          limit: dry.out.answer.limit,
          runs,
        },
        'mutation-verdict:behavior:cli-purge-holds-its-limit',
      ).toEqual({
        dry: [tasks.slice(0, 2), true, true],
        limit: 2,
        runs: [
          [tasks.slice(0, 2), true],
          [tasks.slice(2, 4), true],
          [tasks.slice(4), false],
          [[], false],
        ],
      })
    }))

  it('says no more remain when the limit is exactly what there was, and takes 100 when no limit is given', () =>
    onDb('purge-limit-exact', async (db) => {
      const tasks = await completedTasks(db, 3, 'job')
      await aged(db)
      const exact = await purge(db, [...PURGE_WINDOWS, '--limit', '3', '--execute'])
      const none = await purge(db, [...PURGE_WINDOWS, '--execute'])
      expect({
        exact: [idsOf(exact.answer.purged), exact.answer.more],
        defaultLimit: none.answer.limit,
      }).toEqual({ exact: [tasks, false], defaultLimit: 100 })
    }))

  it('goes past the units the barrier keeps: a queue whose oldest candidates are all kept still purges what stands behind them', () =>
    onDb('purge-past-kept', async (db) => {
      // Three children of a running parent end first, and three plain tasks a second later.
      const kept = await childrenOfARunningParent(db, 3)
      await db.admin.setFakeNowEpochMs(NOW_MS + 1_000)
      const behind = await completedTasks(db, 3, 'job')
      await aged(db)
      const recorded = recordingOpener()
      // The three kept units stand first among the candidates the walk lists.
      const { exit, answer } = await purge(
        db,
        [...PURGE_WINDOWS, '--limit', '2', '--execute'],
        recorded.opener,
      )
      // Past the kept units, something goes.
      expect(
        { exit, kept: idsOf(answer.kept), purgedSome: idsOf(answer.purged).length > 0 },
        'mutation-verdict:behavior:cli-purge-walks-past-the-units-the-barrier-keeps',
      ).toEqual({ exit: 0, kept, purgedSome: true })
      // And where its limit is reached, inside the page, it stops, with one listing sent.
      expect(
        {
          purged: idsOf(answer.purged),
          more: answer.more,
          pages: recorded.sent().filter((batch) => batch.label === 'purge-candidates').length,
        },
        'mutation-verdict:behavior:cli-purge-stops-at-its-limit-inside-a-page',
      ).toEqual({ purged: behind.slice(0, 2), more: true, pages: 1 })
      // A dry run walks the same way, and says the same of what is left.
      const dry = await purge(db, [...PURGE_WINDOWS, '--limit', '2'])
      expect({
        wouldPurge: idsOf(dry.answer.wouldPurge),
        kept: idsOf(dry.answer.kept),
        more: dry.answer.more,
      }).toEqual({ wouldPurge: behind.slice(2), kept, more: false })
    }))
})

/** The reason the CLI names for each condition of the barrier, written out and not read from the code. */
const REASON_NAMED: Readonly<Record<PurgeBarrierCondition, string>> = {
  endedAWindowAgo: 'not-ended-a-window-ago',
  stampInRange: 'unstamped',
  noLiveRun: 'live-run',
  noRunHoldsTheOutcome: 'outcome-held',
  noWaitOnTheOutcome: 'awaited',
  parentCannotRunAgain: 'parent-can-run-again',
  spawnedUnderThisKey: 'key-changed',
  ownsEveryRun: 'run-in-another-queue',
  withinTheCheckpointCap: 'oversized',
}

interface Planted {
  readonly what: string
  /**
   * Make one unit that this condition alone keeps, and answer its task. A condition that is
   * always true of a unit a listing names is made false after the listing, by
   * `afterListing`, as a row that moves between the listing and the read of the barrier does.
   */
  plant(
    db: CliDb,
    seeded: SeededTasks,
  ): Promise<{ readonly taskId: string; readonly afterListing?: () => Promise<void> }>
}

/** A unit kept by each condition of the barrier, by the engine where an engine path reaches it. */
const PLANTED: Readonly<Record<PurgeBarrierCondition, Planted>> = {
  endedAWindowAgo: {
    what: 'a task stamped again, at this instant, between the listing and the read',
    plant: async (db, seeded) => ({
      taskId: seeded.completed,
      afterListing: async () => {
        await write(db, {
          sql: 'UPDATE tasks SET fence_at_ms = ? WHERE task_id = ?',
          args: [await db.admin.nowEpochMs(), seeded.completed],
        })
      },
    }),
  },
  stampInRange: {
    what: 'a task whose stamp is set below every instant between the listing and the read, fixture-built',
    plant: async (db, seeded) => ({
      taskId: seeded.completed,
      afterListing: async () => {
        await write(db, {
          sql: 'UPDATE tasks SET fence_at_ms = -5 WHERE task_id = ?',
          args: [seeded.completed],
        })
      },
    }),
  },
  noLiveRun: {
    what: 'a completed task one of whose runs is set live, fixture-built',
    plant: async (db, seeded) => {
      await write(db, {
        sql: "UPDATE runs SET state = 'pending' WHERE task_id = ?",
        args: [seeded.completed],
      })
      return { taskId: seeded.completed }
    },
  },
  noRunHoldsTheOutcome: {
    what: 'a child whose completion woke a run that has not been claimed since',
    plant: async (db) => {
      const holder = await db.store.spawn(QUEUE, 'holder', '{}')
      const run = await claimActivated(db, 'purge-holder', holder.taskId)
      const [child] = await completedTasksAwaitedBy(db, run)
      return { taskId: String(child) }
    },
  },
  noWaitOnTheOutcome: {
    what: 'a completed task whose completion event a wait still names, fixture-built',
    plant: async (db, seeded) => {
      const event = taskDoneEventName(seeded.completed)
      await write(
        db,
        handWrittenTask({ taskId: 'waiter', state: 'sleeping', atMs: NOW_MS, queue: QUEUE }),
        handWrittenRun({
          runId: 'waiter-run',
          taskId: 'waiter',
          state: 'sleeping',
          atMs: NOW_MS,
          queue: QUEUE,
          wake: { event, step: 'await-it' },
        }),
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                  timeout_at_ms, created_at_ms)
                VALUES ('waiter-run', 'await-it', ?, 'waiter', ?, 'waiting', NULL, ?)`,
          args: [QUEUE, event, NOW_MS],
        },
      )
      return { taskId: seeded.completed }
    },
  },
  parentCannotRunAgain: {
    what: 'a child that completed under a parent that is still running',
    plant: async (db) => ({ taskId: String((await childrenOfARunningParent(db, 1))[0]) }),
  },
  spawnedUnderThisKey: {
    what: 'a task whose key is changed between the listing and the read, fixture-built',
    plant: async (db, seeded) => ({
      taskId: seeded.completed,
      afterListing: async () => {
        await write(db, {
          sql: "UPDATE tasks SET idempotency_key = 'another-key' WHERE task_id = ?",
          args: [seeded.completed],
        })
      },
    }),
  },
  ownsEveryRun: {
    what: 'a completed task one of whose runs is moved to another queue, fixture-built',
    plant: async (db, seeded) => {
      await write(db, {
        sql: "UPDATE runs SET queue = 'elsewhere' WHERE task_id = ?",
        args: [seeded.completed],
      })
      return { taskId: seeded.completed }
    },
  },
  withinTheCheckpointCap: {
    what: `a completed task with ${MAX_PURGE_UNIT_CHECKPOINTS + 1} checkpoints, fixture-built`,
    plant: async (db, seeded) => {
      const runId = await runOf(db, seeded.completed)
      // The seeded task holds one checkpoint, and these bring it one past the cap.
      const wanted = MAX_PURGE_UNIT_CHECKPOINTS
      const perStatement = 2_000
      for (let written = 0; written < wanted; written += perStatement) {
        const count = Math.min(perStatement, wanted - written)
        await write(db, {
          sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                  owner_run_id, owner_attempt, updated_at_ms)
                VALUES ${Array.from({ length: count }, () => "(?, ?, ?, '1', 'committed', ?, 1, ?)").join(', ')}`,
          args: Array.from({ length: count }, (_, index) => [
            seeded.completed,
            `filler-${written + index}`,
            QUEUE,
            String(runId),
            NOW_MS,
          ]).flat(),
        })
      }
      return { taskId: seeded.completed }
    },
  },
}

/** A task that a claimed run awaits and that then completes, which wakes that run with its outcome. */
async function completedTasksAwaitedBy(
  db: CliDb,
  run: { readonly taskId: string; readonly runId: string; readonly claimToken: string },
): Promise<string[]> {
  const child = await db.store.spawn(QUEUE, 'awaited', '{}')
  const parked = await db.store.awaitTaskDone(
    QUEUE,
    run.taskId,
    run.runId,
    run.claimToken,
    'await-it',
    child.taskId,
    null,
  )
  if (parked.emitted) throw new Error('the awaited task had ended already')
  const worked = await claimActivated(db, 'purge-awaited', child.taskId)
  await db.store.complete(QUEUE, worked.runId, worked.claimToken, '{}')
  return [child.taskId]
}

describe('a unit the barrier keeps is named by the condition that is false, as of the read', () => {
  it('plants a unit for every condition of the barrier, and names a reason for each', () => {
    expect(Object.keys(PLANTED)).toEqual([...PURGE_BARRIER_CONDITIONS])
    expect(REASON_OF_CONDITION).toEqual(REASON_NAMED)
    // No two conditions give one reason, so a reason names its condition.
    expect(new Set(Object.values(REASON_NAMED)).size).toBe(PURGE_BARRIER_CONDITIONS.length)
  })

  it('names each planted unit by the one condition that keeps it, in a dry run and in a purge, for every condition of the barrier', async () => {
    for (const condition of PURGE_BARRIER_CONDITIONS) {
      // A dry run and a purge each on a database of its own: what is moved after a listing
      // stays moved.
      for (const mode of ['a dry run', 'a purge'] as const) {
        await onDb(
          `purge-kept-${condition}-${mode === 'a purge' ? 'execute' : 'dry'}`,
          async (db) => {
            const seeded = await seedTasks(db)
            const { taskId, afterListing } = await PLANTED[condition].plant(db, seeded)
            await aged(db)
            const { exit, answer } = await purge(
              db,
              mode === 'a purge' ? [...PURGE_EVERY_STATE, '--execute'] : PURGE_EVERY_STATE,
              afterListing === undefined ? openStore : afterTheListing(afterListing),
            )
            const taken = mode === 'a purge' ? answer.purged : answer.wouldPurge
            expect(
              {
                condition,
                mode,
                exit,
                kept: (answer.kept ?? [])
                  .filter((unit) => unit.taskId === taskId)
                  .map(({ reasons, conditionsNotHeld }) => ({ reasons, conditionsNotHeld })),
                taken: idsOf(taken).includes(taskId),
                stillThere: (await tasksLeft(db)).includes(taskId),
              },
              'mutation-verdict:behavior:cli-purge-names-the-condition-that-keeps-a-unit',
            ).toEqual({
              condition,
              mode,
              exit: 0,
              kept: [{ reasons: [REASON_NAMED[condition]], conditionsNotHeld: [condition] }],
              taken: false,
              stillThere: true,
            })
          },
        )
      }
    }
  }, 300_000)
})

describe('a purge whose store answers otherwise than a clean run', () => {
  it('reports a unit that is not there at the read after its purge as gone, and not as kept: one this call delivered twice, and one another purge took', async () => {
    await onDb('purge-gone-duplicate', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      const { exit, answer } = await purge(
        db,
        [...PURGE_EVERY_STATE, '--execute'],
        faultAt({ label: 'purge-unit', occurrence: 1 }, 'duplicate'),
      )
      expect({
        exit,
        gone: idsOf(answer.gone),
        purged: idsOf(answer.purged).sort(),
        kept: answer.kept,
        left: await tasksLeft(db),
      }).toEqual({
        exit: 0,
        gone: [seeded.completed],
        purged: [seeded.failed, seeded.cancelled].sort(),
        kept: [],
        left: [seeded.pending],
      })
    })
    await onDb('purge-gone-another', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      const other = db.retentionWith(testIdSource('another-purger'))
      const { exit, answer } = await purge(
        db,
        [...PURGE_EVERY_STATE, '--execute'],
        afterTheListing(async () => {
          const took = await other.purgeUnit(
            QUEUE,
            { taskId: seeded.completed, idempotencyKey: COMPLETED_KEY },
            NAMING_FAILED,
          )
          if (took === null) throw new Error('the other purger took nothing')
        }),
      )
      expect({ exit, gone: idsOf(answer.gone), purged: idsOf(answer.purged).sort() }).toEqual({
        exit: 0,
        gone: [seeded.completed],
        purged: [seeded.failed, seeded.cancelled].sort(),
      })
    })
  })

  it('prints the units that went before an outage, exits 6 and says where it stopped, and run again purges what is left', async () => {
    for (const fault of ['crash-before', 'crash-after'] as const) {
      await onDb(`purge-outage-${fault}`, async (db) => {
        const seeded = await seedTasks(db)
        await aged(db)
        const { exit, answer } = await purge(
          db,
          [...PURGE_EVERY_STATE, '--execute'],
          faultAt({ label: 'purge-unit', occurrence: 2 }, fault),
        )
        const left = await tasksLeft(db)
        expect(
          {
            fault,
            exit,
            kind: answer.error?.kind,
            purged: idsOf(answer.purged),
            finished: answer.finished,
            stoppedAt: answer.stoppedAt,
            // Before the batch the unit is still there. After it, the unit went and its
            // answer was lost, so it is in neither list.
            secondIsThere: left.includes(seeded.failed),
          },
          'mutation-verdict:behavior:cli-purge-reports-what-went-before-an-outage',
        ).toEqual({
          fault,
          exit: exitCode('unavailable'),
          kind: 'store-unavailable',
          purged: [seeded.completed],
          finished: false,
          stoppedAt: { call: 'purge-unit', taskId: seeded.failed },
          secondIsThere: fault === 'crash-before',
        })
        const again = await purge(db, [...PURGE_EVERY_STATE, '--execute'])
        expect({
          exit: again.exit,
          finished: again.answer.finished,
          left: await tasksLeft(db),
        }).toEqual({ exit: 0, finished: true, left: [seeded.pending] })
      })
    }
  })

  it('prints that report on stdout in human text, though the command exits 6', () =>
    onDb('purge-outage-text', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      const text = await purgeText(
        db,
        [...PURGE_EVERY_STATE, '--execute'],
        faultAt({ label: 'purge-unit', occurrence: 2 }, 'crash-before'),
      )
      expect({
        exit: text.exit,
        stderr: text.stderr,
        printsWhatWent: text.stdout.includes(`taskId: ${seeded.completed}`),
        saysItDidNotFinish: text.stdout.includes('finished: false'),
      }).toEqual({
        exit: exitCode('unavailable'),
        stderr: '',
        printsWhatWent: true,
        saysItDidNotFinish: true,
      })
    }))

  it('exits 6 with nothing purged when the listing or the read of the barrier meets an outage', async () => {
    await onDb('purge-outage-listing', async (db) => {
      await seedTasks(db)
      await aged(db)
      const run = await changedBy(db, () =>
        purge(
          db,
          [...PURGE_EVERY_STATE, '--execute'],
          faultAt({ label: 'purge-candidates', occurrence: 1 }, 'crash-before'),
        ),
      )
      // No unit was reached, so there is no report: the failure is the whole answer.
      expect({
        exit: run.out.exit,
        kind: run.out.answer.error?.kind,
        purged: run.out.answer.purged,
        unchanged: run.unchanged,
      }).toEqual({
        exit: exitCode('unavailable'),
        kind: 'store-unavailable',
        purged: undefined,
        unchanged: true,
      })
    })
    await onDb('purge-outage-barrier', async (db) => {
      await seedTasks(db)
      const [child] = await childrenOfARunningParent(db, 1)
      await aged(db)
      // The child is listed last, the port answers kept, and the read of why is lost.
      const { exit, answer } = await purge(
        db,
        [...PURGE_EVERY_STATE, '--execute'],
        faultAt({ label: 'purge-admission', occurrence: 1 }, 'crash-before'),
      )
      expect({
        exit,
        purged: idsOf(answer.purged).length,
        kept: answer.kept,
        stoppedAt: answer.stoppedAt,
      }).toEqual({
        exit: exitCode('unavailable'),
        purged: 3,
        kept: [],
        stoppedAt: { call: 'purge-admission', taskId: child },
      })
    })
  })
})

describe('after a purge', () => {
  it('retry of a purged failed task answers not-found, and says the task may have been retained out', () =>
    onDb('purge-then-retry', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      await purge(db, [...PURGE_EVERY_STATE, '--execute'])
      const line = ['retry', seeded.failed, ...writeFlags(db)]
      const answers: unknown[] = []
      for (const more of [[], ['--yes']]) {
        const run = await runCli([...line, ...more, '--json'], db.env)
        const answer = JSON.parse(run.stdout) as JsonAnswer
        answers.push([run.exit, answer.error?.kind, answer.error?.message])
      }
      const said = `no task ${seeded.failed} in queue ${QUEUE}: it was never there, or it ended and a purge retained it out`
      expect(
        answers,
        'mutation-verdict:behavior:cli-retry-says-a-task-may-have-been-retained-out',
      ).toEqual([
        [exitCode('not-found'), 'not-found', said],
        [exitCode('not-found'), 'not-found', said],
      ])
      // In text the refusal prints on stderr.
      const text = await runCli([...line, '--yes'], db.env)
      expect({
        exit: text.exit,
        stdout: text.stdout,
        says: text.stderr.includes('a purge retained it out'),
      }).toEqual({ exit: exitCode('not-found'), stdout: '', says: true })
    }))

  it('inspect and explain by a key whose task a purge takes between their two reads answer not-found, and say the task the key named is gone', () =>
    onDb('purge-between-reads', async (db) => {
      // Four tasks under keys of their own, each completed: one for each command and stream.
      const keyed: Record<string, string> = {}
      for (const key of ['inspect-json', 'inspect-text', 'explain-json', 'explain-text']) {
        const task = await db.store.spawn(QUEUE, 'report', '{}', { idempotencyKey: key })
        const run = await claimActivated(db, `worker-${key}`, task.taskId)
        await db.store.complete(QUEUE, run.runId, run.claimToken, '{}')
        keyed[key] = task.taskId
      }
      await aged(db)
      /** An opener whose store purges the task of `key` straight after the read of its id by its key. */
      const purgedBetween = (key: string): StoreOpener =>
        afterFirst('task-id-by-key', async () => {
          const took = await db
            .retentionWith(testIdSource(`between-${key}`))
            .purgeUnit(QUEUE, { taskId: String(keyed[key]), idempotencyKey: key }, NAMING_FAILED)
          if (took === null) throw new Error(`the purge between the reads took nothing of ${key}`)
        })
      const said = (taskId: string | undefined) =>
        `the idempotency key named task ${taskId} in queue ${QUEUE}, and the task is gone as of the next read: it may have been retained out`
      const answers: unknown[] = []
      for (const verb of ['inspect', 'explain']) {
        const key = `${verb}-json`
        const run = await runCli(
          [verb, '--key', key, '--queue', QUEUE, '--json'],
          db.env,
          purgedBetween(key),
        )
        const answer = JSON.parse(run.stdout) as JsonAnswer
        answers.push([verb, run.exit, answer.error?.kind, answer.taskId, answer.error?.message])
      }
      expect(answers, 'mutation-verdict:behavior:cli-a-read-by-key-says-its-task-is-gone').toEqual(
        ['inspect', 'explain'].map((verb) => [
          verb,
          exitCode('not-found'),
          'not-found',
          keyed[`${verb}-json`],
          said(keyed[`${verb}-json`]),
        ]),
      )
      // In text the refusal prints on stderr, with the exit of a task that is not there.
      for (const verb of ['inspect', 'explain']) {
        const key = `${verb}-text`
        const text = await runCli(
          [verb, '--key', key, '--queue', QUEUE],
          db.env,
          purgedBetween(key),
        )
        expect({
          verb,
          exit: text.exit,
          stdout: text.stdout,
          says: text.stderr.includes('is gone as of the next read'),
        }).toEqual({ verb, exit: exitCode('not-found'), stdout: '', says: true })
      }
      // The neighbours answer as they did. A key that names no task is answered by the
      // first read, and a task named by its id that is not there is not said to be gone.
      for (const verb of ['inspect', 'explain']) {
        const noKey = await runCli(
          [verb, '--key', 'a-key-no-task-has', '--queue', QUEUE, '--json'],
          db.env,
        )
        const byId = await runCli([verb, 'no-such-task', '--queue', QUEUE, '--json'], db.env)
        expect({
          verb,
          noKey: [noKey.exit, (JSON.parse(noKey.stdout) as JsonAnswer).error?.message],
          byId: [byId.exit, (JSON.parse(byId.stdout) as JsonAnswer).error?.message],
        }).toEqual({
          verb,
          noKey: [8, `no task in queue ${QUEUE} was spawned under that idempotency key`],
          byId: [8, `no task no-such-task in queue ${QUEUE}`],
        })
      }
    }))

  it('result and inspect, by id and by key, answer not-found for a purged task', () =>
    onDb('purge-then-read', async (db) => {
      const seeded = await seedTasks(db)
      await aged(db)
      await purge(db, [...PURGE_EVERY_STATE, '--execute'])
      const exits: number[] = []
      for (const line of [
        ['result', seeded.completed],
        ['inspect', seeded.completed],
        ['inspect', '--key', COMPLETED_KEY],
      ]) {
        exits.push((await runCli([...line, '--queue', QUEUE, '--json'], db.env)).exit)
      }
      expect(exits).toEqual([8, 8, 8])
    }))
})

describe('one invocation is one pass, within its bounds', () => {
  /** A parent of one attempt that failed a second after its child completed, both then years old. */
  async function childOfAFailedParent(db: CliDb) {
    const parent = await db.store.spawn(QUEUE, 'parent', '{}', { maxAttempts: 1 })
    const running = await claimActivated(db, 'failing-parent', parent.taskId)
    const child = await db.store.spawn(QUEUE, 'child', '{}', {
      childOf: {
        parentQueue: QUEUE,
        parentTaskId: parent.taskId,
        runId: running.runId,
        claimToken: running.claimToken,
        replayKey: 'child#0',
      },
    })
    const worked = await claimActivated(db, 'its-child', child.taskId)
    await db.store.complete(QUEUE, worked.runId, worked.claimToken, '{}')
    await db.admin.setFakeNowEpochMs(NOW_MS + 1_000)
    await db.store.fail(QUEUE, running.runId, running.claimToken, '{"name":"E"}', null)
    await aged(db)
    return { parent: parent.taskId, child: child.taskId }
  }

  it('takes a unit that a unit it took had kept: the child of a failed parent goes with its parent, and a repeat takes nothing', () =>
    onDb('purge-pass-failed-parent', async (db) => {
      const { parent, child } = await childOfAFailedParent(db)
      const dry = await purge(db, PURGE_EVERY_STATE)
      const first = await purge(db, [...PURGE_EVERY_STATE, '--execute'])
      const left = await tasksLeft(db)
      const again = await purge(db, [...PURGE_EVERY_STATE, '--execute'])
      const said = ({ answer }: { answer: PurgeAnswer }) => ({
        taken: idsOf(answer.purged ?? answer.wouldPurge),
        kept: (answer.kept ?? []).map(({ taskId, reasons }) => [taskId, reasons]),
        more: answer.more,
        finished: answer.finished,
      })
      expect({ dry: said(dry), first: said(first), left, again: said(again) }).toEqual({
        // A dry run deletes nothing, so the child is read under a parent that is still there.
        dry: {
          taken: [parent],
          kept: [[child, ['parent-can-run-again']]],
          more: false,
          finished: true,
        },
        // The child is listed first and kept, its parent goes, and the child is tried again.
        first: { taken: [parent, child], kept: [], more: false, finished: true },
        left: [],
        again: { taken: [], kept: [], more: false, finished: true },
      })
    }))

  it('sends one listing, a purge for each candidate it reaches and a read of the barrier for each it keeps: 30 kept children in front of two tasks, at a limit of 1 and of 100', async () => {
    const reached: unknown[] = []
    for (const limit of [1, 100]) {
      await onDb(`purge-pass-kept-${limit}`, async (db) => {
        await childrenOfARunningParent(db, 30)
        await db.admin.setFakeNowEpochMs(NOW_MS + 1_000)
        const behind = await completedTasks(db, 2, 'job')
        await aged(db)
        const counted = async (flags: readonly string[]) => {
          const recorded = recordingOpener()
          const { exit, answer } = await purge(db, flags, recorded.opener)
          const labels = recorded.sent().map((batch) => batch.label)
          const count = (label: string) => labels.filter((sent) => sent === label).length
          return {
            exit,
            purged: idsOf(answer.purged),
            kept: (answer.kept ?? []).length,
            examined: answer.examined,
            more: answer.more,
            resumes: typeof answer.resumeAfter === 'string',
            listings: count('purge-candidates'),
            purges: count('purge-unit'),
            barrierReads: count('purge-admission'),
            resumeAfter: answer.resumeAfter,
          }
        }
        const { resumeAfter, ...first } = await counted([
          ...PURGE_WINDOWS,
          '--limit',
          String(limit),
          '--execute',
        ])
        // Where the first stopped with more behind it, the next begins: it reaches what
        // stands behind the kept units without reading one of them again.
        const { resumeAfter: _next, ...resumed } =
          typeof resumeAfter === 'string'
            ? await counted([...PURGE_WINDOWS, '--after', resumeAfter, '--execute'])
            : { resumeAfter: null }
        reached.push({ limit, behind: behind.length, first, resumed })
      })
    }
    const [one, two] = [reached[0], reached[1]] as {
      first: { purged: string[] }
      resumed: { purged?: string[] }
    }[]
    expect(reached).toEqual([
      {
        limit: 1,
        behind: 2,
        first: {
          exit: 0,
          purged: one?.first.purged,
          kept: 30,
          examined: 31,
          more: true,
          resumes: true,
          listings: 1,
          purges: 31,
          barrierReads: 30,
        },
        resumed: {
          exit: 0,
          purged: one?.resumed.purged,
          kept: 0,
          examined: 1,
          more: false,
          resumes: false,
          listings: 1,
          purges: 1,
          barrierReads: 0,
        },
      },
      {
        limit: 100,
        behind: 2,
        first: {
          exit: 0,
          purged: two?.first.purged,
          kept: 30,
          examined: 32,
          more: false,
          resumes: false,
          listings: 1,
          purges: 32,
          barrierReads: 30,
        },
        resumed: {},
      },
    ])
    expect([
      one?.first.purged.length,
      one?.resumed.purged?.length,
      two?.first.purged.length,
    ]).toEqual([1, 1, 2])
  }, 120_000)
})

describe('a purge whose answer was lost', () => {
  it('prints the unit whole, with the digest of its key, as one whose outcome is not known, and a repeat says which it was', async () => {
    for (const fault of ['crash-before', 'crash-after'] as const) {
      await onDb(`purge-in-doubt-${fault}`, async (db) => {
        const seeded = await seedTasks(db)
        await aged(db)
        const lost = faultAt({ label: 'purge-unit', occurrence: 1 }, fault)
        const { exit, answer } = await purge(db, [...PURGE_EVERY_STATE, '--execute'], lost)
        const there = (await tasksLeft(db)).includes(seeded.completed)
        const again = await purge(db, [...PURGE_EVERY_STATE, '--execute'])
        expect({
          fault,
          exit,
          purged: idsOf(answer.purged),
          notKnown: (answer.outcomeNotKnown ?? []).map((unit) => [
            unit.taskId,
            unit.state,
            unit.idempotencyKeySha256,
          ]),
          finished: answer.finished,
          stoppedAt: answer.stoppedAt,
          there,
          // A repeat lists the unit again if it stands, and does not if it went.
          againPurgedIt: idsOf(again.answer.purged).includes(seeded.completed),
        }).toEqual({
          fault,
          exit: exitCode('unavailable'),
          purged: [],
          notKnown: [[seeded.completed, 'completed', sha256(COMPLETED_KEY)]],
          finished: false,
          stoppedAt: { call: 'purge-unit', taskId: seeded.completed },
          there: fault === 'crash-before',
          againPurgedIt: fault === 'crash-before',
        })
      })
    }
    await onDb('purge-in-doubt-text', async (db) => {
      await seedTasks(db)
      await aged(db)
      const text = await purgeText(
        db,
        [...PURGE_EVERY_STATE, '--execute'],
        faultAt({ label: 'purge-unit', occurrence: 1 }, 'crash-after'),
      )
      expect({
        exit: text.exit,
        stderr: text.stderr,
        printsTheDigest: text.stdout.includes(sha256(COMPLETED_KEY)),
      }).toEqual({ exit: exitCode('unavailable'), stderr: '', printsTheDigest: true })
    })
  })
})

describe('an outage with no unit in the report', () => {
  it('prints as any failure does: in text on stderr with nothing on stdout, and with --json as the failure alone', async () => {
    const atTheFirstListing = () =>
      faultAt({ label: 'purge-candidates', occurrence: 1 }, 'crash-before')
    await onDb('purge-empty-outage', async (db) => {
      await seedTasks(db)
      await aged(db)
      const text = await purgeText(db, [...PURGE_EVERY_STATE, '--execute'], atTheFirstListing())
      const json = await purge(db, [...PURGE_EVERY_STATE, '--execute'], atTheFirstListing())
      expect({
        text: [text.exit, text.stdout, text.stderr.includes('store-unavailable')],
        json: [json.exit, Object.keys(json.answer).sort(), json.answer.error?.kind],
      }).toEqual({
        text: [exitCode('unavailable'), '', true],
        json: [
          exitCode('unavailable'),
          ['command', 'dialect', 'error', 'exit'],
          'store-unavailable',
        ],
      })
    })
  })
})
