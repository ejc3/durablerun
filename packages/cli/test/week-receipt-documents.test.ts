import { QUEUE_TABLES, STORE_FAILURE_TYPES, type StoreFailureKind } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  WEEK_DIGEST_UNIT_ROWS,
  readExplanation,
  readLookup,
  readPurge,
  readSelftest,
  readSizes,
  readStats,
  sha256,
} from '../../../apps/dogfood/src/week-receipt.js'
import { DIGEST_UNIT_ROWS } from '../../conformance/src/retention-soak.js'
import { exitCode } from '../src/exit.js'
import { STORE_FAILURE_ANSWERS } from '../src/main.js'
import {
  COMPLETED_KEY,
  type CliDb,
  OWN_QUEUE,
  PURGE_EVERY_STATE,
  PURGE_WINDOWS,
  QUEUE,
  faulting,
  onDb,
  openerWrapping,
  rowsByQueue,
  runCli,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * The week receipt (BUILD.md exit test line 44) holds the documents this CLI prints with
 * `--json`, and its checker reads a few members of each. The checker's own cases run on a
 * receipt made by code. These run the commands against a database and hand the checker's
 * readers what the commands printed, so a member the CLI renames is one a reader no longer
 * finds, and the case fails.
 */

/** What a command prints with `--json`. */
async function printed(db: CliDb, argv: readonly string[]): Promise<unknown> {
  const run = await runCli([...argv, '--json'], db.env)
  return JSON.parse(run.stdout)
}

describe('the week receipt reads what the CLI prints', () => {
  it(
    'reads the reports of stats, sizes, purge, inspect, explain and selftest as the commands print them',
    () =>
      onDb('week-receipt-documents', async (db) => {
        const seeded = await seedTasks(db)

        // Under the seeds' test clock, `stats` says so, and the receipt refuses such a sample.
        expect(readStats(await printed(db, ['stats', '--queue', QUEUE]), QUEUE)?.fakeClock).toBe(
          true,
        )
        await db.admin.setFakeNowEpochMs(null)
        const before = Date.now()
        const stats = readStats(await printed(db, ['stats', '--queue', QUEUE]), QUEUE)
        expect(
          stats?.fakeClock,
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toBe(false)
        expect(Math.abs((stats?.atEpochMs ?? 0) - before)).toBeLessThan(60_000)

        // `sizes` counts the queue's rows, table by table.
        const rows = rowsByQueue(await db.dump(), QUEUE).ofTheQueue
        const counted = Object.fromEntries(
          QUEUE_TABLES.map((table) => [
            table,
            rows.filter((row) => row.startsWith(`${table} `)).length,
          ]),
        )
        expect(
          readSizes(await printed(db, ['sizes', '--queue', QUEUE]), QUEUE),
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toEqual(counted)
        expect(counted.tasks).toBe(4)

        // `explain` names the task and a cause, and `inspect --key` the key's digest.
        const explained = (await printed(db, ['explain', seeded.pending, '--queue', QUEUE])) as {
          cause?: unknown
        }
        expect(typeof explained.cause).toBe('string')
        expect(
          readExplanation(explained, QUEUE),
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toEqual({
          taskId: seeded.pending,
          cause: explained.cause,
        })
        expect(
          readLookup(
            await printed(db, ['inspect', '--key', COMPLETED_KEY, '--queue', QUEUE]),
            QUEUE,
          ),
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toEqual({ keySha256: sha256(COMPLETED_KEY), runs: 1 })
        // A key no task holds is found by no lookup.
        expect(
          readLookup(
            await printed(db, ['inspect', '--key', 'no-such-key', '--queue', QUEUE]),
            QUEUE,
          ),
        ).toBeNull()

        // A dry run under a failed window lists the failed unit, and a purge without one keeps
        // it. A purge prints the rows that went with each unit, and a dry run prints none.
        const dryRun = readPurge(
          await printed(db, ['purge', ...PURGE_EVERY_STATE, ...writeFlags(db)]),
          QUEUE,
        )
        expect(
          dryRun,
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toMatchObject({
          execute: false,
          finished: true,
          more: false,
          completedSeconds: 3_600,
          failedSeconds: 3_600,
          outcomeNotKnown: [],
        })
        expect([...(dryRun?.taken ?? [])].sort((a, b) => a.state.localeCompare(b.state))).toEqual([
          { state: 'cancelled', keySha256: null, runs: null },
          { state: 'completed', keySha256: sha256(COMPLETED_KEY), runs: null },
          { state: 'failed', keySha256: null, runs: null },
        ])
        const purge = readPurge(
          await printed(db, ['purge', ...PURGE_WINDOWS, '--execute', ...writeFlags(db)]),
          QUEUE,
        )
        expect(
          purge,
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toMatchObject({
          execute: true,
          finished: true,
          more: false,
          completedSeconds: 3_600,
          failedSeconds: null,
        })
        expect([...(purge?.taken ?? [])].sort((a, b) => a.state.localeCompare(b.state))).toEqual([
          { state: 'cancelled', keySha256: null, runs: 1 },
          { state: 'completed', keySha256: sha256(COMPLETED_KEY), runs: 1 },
        ])

        // A selftest that passed reads as one, and one that was refused does not.
        const target = ['--target', db.target]
        expect(
          readSelftest(await printed(db, ['selftest', '--queue', OWN_QUEUE, ...target])),
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toBe(true)
        expect(readSelftest(await printed(db, ['selftest', '--queue', QUEUE, ...target]))).toBe(
          false,
        )

        // A purge the store fails before any unit prints its failure and no queue, and
        // reads as a run that took nothing and did not finish. One refused under a test
        // clock prints its failure beside what was asked, and reads as that refusal.
        const tookNothing = {
          execute: false,
          finished: false,
          more: false,
          completedSeconds: 0,
          failedSeconds: null,
          taken: [],
          outcomeNotKnown: [],
          underATestClock: false,
        }
        const purgeLine = ['purge', ...PURGE_WINDOWS, '--execute', ...writeFlags(db), '--json']
        const outage = await runCli(
          purgeLine,
          db.env,
          openerWrapping((real) =>
            faulting(real, { label: 'purge-candidates', occurrence: 1 }, 'crash-before'),
          ),
        )
        const failed = JSON.parse(outage.stdout) as Record<string, unknown>
        expect({ exit: outage.exit, members: Object.keys(failed).sort() }).toEqual({
          exit: 6,
          members: ['command', 'dialect', 'error', 'exit'],
        })
        expect(
          readPurge(failed, QUEUE),
          'mutation-verdict:behavior:week-receipt-reads-what-the-cli-prints',
        ).toEqual(tookNothing)
        await db.admin.setFakeNowEpochMs(1_700_000_000_000)
        const underATestClock = await runCli(purgeLine, db.env)
        expect(underATestClock.exit).toBe(2)
        expect(readPurge(JSON.parse(underATestClock.stdout), QUEUE)).toEqual({
          ...tookNothing,
          underATestClock: true,
        })
        expect(readPurge(JSON.parse(underATestClock.stdout), 'another-queue')).toBeNull()
        await db.admin.setFakeNowEpochMs(null)

        // A document of another queue, or of another command, is none a reader takes.
        const sizes = await printed(db, ['sizes', '--queue', QUEUE])
        expect(readSizes(sizes, 'another-queue')).toBeNull()
        expect(readStats(sizes, QUEUE)).toBeNull()
      }),
    120_000,
  )

  /**
   * The reader keeps its own list of the kinds a store failure prints under, so it is held
   * to the CLI here: for every kind of store failure core names, the purge is failed that
   * way, and the reader is handed what the CLI printed. A kind the CLI renames, or one core
   * adds, fails this case until the reader is looked at again.
   */
  it(
    'reads what the CLI prints when a purge meets each kind of store failure: a run that took nothing for an outage, a refused credential and a permanent answer, and no run for a schema error',
    () =>
      onDb('week-receipt-store-failures', async (db) => {
        await seedTasks(db)
        await db.admin.setFakeNowEpochMs(null)
        // A kind core adds has no entry here, which fails the typecheck until one is written.
        const reads: Record<StoreFailureKind, 'a run that took nothing' | 'no run of a purge'> = {
          unavailable: 'a run that took nothing',
          'access-refused': 'a run that took nothing',
          permanent: 'a run that took nothing',
          // The schema's version refuses the command: the purge did not run.
          'schema-mismatch': 'no run of a purge',
          'schema-not-initialized': 'no run of a purge',
        }
        const tookNothing = {
          execute: false,
          finished: false,
          more: false,
          completedSeconds: 0,
          failedSeconds: null,
          taken: [],
          outcomeNotKnown: [],
          underATestClock: false,
        }
        const purgeLine = ['purge', ...PURGE_WINDOWS, '--execute', ...writeFlags(db), '--json']
        const observed: Record<string, unknown> = {}
        const expected: Record<string, unknown> = {}
        for (const kind of Object.keys(STORE_FAILURE_TYPES) as StoreFailureKind[]) {
          const Failure = STORE_FAILURE_TYPES[kind]
          // The purge's first read of what it may take fails as this kind of failure.
          const run = await runCli(
            purgeLine,
            db.env,
            openerWrapping((real) => ({
              batch: (label, statements, control) =>
                label === 'purge-candidates'
                  ? Promise.reject(new Failure(`batch(${label}) met ${kind}`))
                  : real.batch(label, statements, control),
            })),
          )
          const document = JSON.parse(run.stdout) as { error?: { kind?: unknown } }
          const read = readPurge(document, QUEUE)
          observed[kind] = {
            exit: run.exit,
            printedKind: document.error?.kind,
            members: Object.keys(document).sort(),
            read: read === null ? 'no run of a purge' : read,
          }
          expected[kind] = {
            exit: exitCode(STORE_FAILURE_ANSWERS[kind].exit),
            printedKind: STORE_FAILURE_ANSWERS[kind].kind,
            members: ['command', 'dialect', 'error', 'exit'],
            read: reads[kind] === 'a run that took nothing' ? tookNothing : reads[kind],
          }
        }
        expect(
          observed,
          'mutation-verdict:behavior:week-receipt-reads-a-purge-a-refused-credential-stopped',
        ).toEqual(expected)
      }),
    120_000,
  )

  it("holds the receipt's rows of a digest unit equal to what the simulated week measures", () => {
    expect(
      WEEK_DIGEST_UNIT_ROWS,
      'mutation-verdict:behavior:week-receipt-unit-rows-are-the-measured-rows',
    ).toEqual(DIGEST_UNIT_ROWS)
    expect([...QUEUE_TABLES].sort()).toEqual(Object.keys(DIGEST_UNIT_ROWS).sort())
  })
})
