import { spawnSync } from 'node:child_process'
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_NOTES as LIBSQL_NOTES,
} from '@durablerun/store-libsql'
import { SCHEMA_VERSION_NOTES as MYSQL_NOTES } from '@durablerun/store-mysql'
import { SCHEMA_VERSION_NOTES as POSTGRES_NOTES } from '@durablerun/store-postgres'
import { describe, expect, it } from 'vitest'
import { RETRY_COUNTER_EXTREMES } from '../../conformance/src/operator-admission.js'
import { COMMANDS, declaresLabel } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import type { SchemaVersionNotes } from '../src/open-store.js'
import { EXPLAIN_SEEDS, onSeed, parkedOnAnEvent } from './explain-seeds.js'
import { OWED_AT_MS, owedQueue } from './queue-seeds.js'
import {
  BIN,
  NOW_MS,
  QUEUE,
  ROOT,
  SELECTED,
  STORE_COMMANDS,
  commandLine,
  comparedLines,
  openCliDb,
  plantNullPayload,
  recordingOpener,
  runCli,
  seedRefused,
  seedSagas,
  seedTasks,
  withoutDialect,
  writeFlags,
} from './support.js'

const NOTES: Readonly<Record<(typeof SELECTED)[number], SchemaVersionNotes>> = {
  libsql: LIBSQL_NOTES,
  postgres: POSTGRES_NOTES,
  mysql: MYSQL_NOTES,
}

/** One seeded database's tasks by the name of their seed, and what every compared command line printed. */
interface Answers {
  readonly seeded: Readonly<Record<string, string>>
  readonly printed: ReadonlyMap<string, string>
}

/**
 * The answers of every compared command line, run through main against one seeded database
 * of a dialect. A dialect is asked once, and every case that reads its answers shares them.
 */
const asked = new Map<string, Promise<Answers>>()
function answersOn(dialect: (typeof SELECTED)[number]): Promise<Answers> {
  const ask = async (): Promise<Answers> => {
    const db = await openCliDb(dialect, 'same-json')
    try {
      const seeded = {
        ...(await seedTasks(db)),
        ...(await seedSagas(db)),
        refused: await seedRefused(db),
      }
      const printed = new Map<string, string>()
      for (const line of comparedLines(seeded)) {
        printed.set(line.join(' '), (await runCli(line, db.env)).stdout)
      }
      return { seeded, printed }
    } finally {
      await db.close()
    }
  }
  const answers = asked.get(dialect) ?? ask()
  asked.set(dialect, answers)
  return answers
}

/** The reads of a queue, as they are compared across dialects on a queue with a move owed in every leg. */
const OWED_LINES: readonly (readonly string[])[] = [
  ['stuck', '--queue', QUEUE, '--json'],
  ['stuck', '--queue', QUEUE, '--json', '--grace', '0s'],
  ['stuck', '--queue', QUEUE, '--json', '--grace', '0s', '--fail-if-any'],
  ['stuck', '--queue', QUEUE, '--json', '--grace', '30s', '--limit', '1'],
  ['stuck', '--queue', QUEUE, '--json', '--older-than', '1m', '--fail-if-any'],
  ['stats', '--queue', QUEUE, '--json'],
  ['sizes', '--queue', QUEUE, '--json'],
]

/** What each of those lines exits with and prints on one dialect, asked once. */
const owedAsked = new Map<string, Promise<ReadonlyMap<string, { exit: number; stdout: string }>>>()
function owedAnswersOn(dialect: (typeof SELECTED)[number]) {
  const ask = async () => {
    const db = await openCliDb(dialect, 'owed-queue')
    try {
      await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      const printed = new Map<string, { exit: number; stdout: string }>()
      for (const line of OWED_LINES) {
        const run = await runCli(line, db.env)
        printed.set(line.join(' '), { exit: run.exit, stdout: run.stdout })
      }
      return printed
    } finally {
      await db.close()
    }
  }
  const answers = owedAsked.get(dialect) ?? ask()
  owedAsked.set(dialect, answers)
  return answers
}

/**
 * Exit test line 32 on every selected dialect. libSQL needs no server, so it is the
 * reference on every run, and a run narrowed to one server dialect still compares it with
 * something.
 */
describe('the CLI on every selected dialect', () => {
  it('every read prints the JSON libSQL prints, apart from the fields under dialect', async () => {
    const { printed: reference } = await answersOn('libsql')
    for (const dialect of SELECTED) {
      const { printed: answers } = await answersOn(dialect)
      expect([...answers.keys()]).toEqual([...reference.keys()])
      for (const [line, stdout] of answers) {
        const parsed = JSON.parse(stdout) as { dialect?: Record<string, unknown> }
        expect(Object.keys(parsed.dialect ?? {}).sort(), `${dialect}: ${line}`).toEqual([
          'schemaWindow',
          'scheme',
        ])
        expect(withoutDialect(stdout), `${dialect}: ${line}`).toEqual(
          withoutDialect(reference.get(line) ?? '{}'),
        )
      }
    }
  }, 120_000)

  for (const dialect of SELECTED) {
    describe(`[${dialect}]`, () => {
      it('a read command sends only read batches, each with a label the command table declares', async () => {
        const db = await openCliDb(dialect, 'read-spy')
        try {
          const seeded = await seedTasks(db)
          for (const spec of STORE_COMMANDS.filter((command) => !command.writes)) {
            const { opener, sent: batches } = recordingOpener()
            const run = await runCli(commandLine(spec, db, seeded.completed), db.env, opener)
            expect(run.exit, `${spec.verb}: ${run.stdout}`).toBe(0)
            const sent = batches()
            expect(sent.length, spec.verb).toBeGreaterThan(0)
            for (const batch of sent) {
              expect({ verb: spec.verb, label: batch.label, mode: batch.mode }).toEqual({
                verb: spec.verb,
                label: batch.label,
                mode: 'read',
              })
              expect(declaresLabel(spec, batch.label), `${spec.verb} sent ${batch.label}`).toBe(
                true,
              )
            }
          }
        } finally {
          await db.close()
        }
      })

      it('stuck, stats and sizes print the JSON libSQL prints, and exit as it exits, for a queue with a move owed in every leg', async () => {
        const reference = await owedAnswersOn('libsql')
        const answers = await owedAnswersOn(dialect)
        expect([...answers.keys()]).toEqual(OWED_LINES.map((line) => line.join(' ')))
        for (const [line, { exit, stdout }] of answers) {
          const expected = reference.get(line)
          expect({ line, exit, answer: withoutDialect(stdout) }).toEqual({
            line,
            exit: expected?.exit,
            answer: withoutDialect(expected?.stdout ?? '{}'),
          })
        }
        // The comparison is of answers that hold rows: five are listed, the run of the task
        // past its deadline among them as one no claim admits, and that exits 9 when it was
        // asked to. A grace of 30 seconds and a limit of one list the two runs due for a
        // minute and the sleeper due for half of one.
        const listed = (line: readonly string[]) => {
          const { exit, stdout } = answers.get(line.join(' ')) ?? { exit: -1, stdout: '{}' }
          return { exit, listed: (JSON.parse(stdout) as { listed?: number }).listed }
        }
        expect(OWED_LINES.slice(0, 5).map(listed)).toEqual([
          { exit: 0, listed: 0 },
          { exit: 0, listed: 5 },
          { exit: exitCode('found'), listed: 5 },
          { exit: 0, listed: 3 },
          // The four live tasks, each a minute old, and no row of a leg under the default grace.
          { exit: exitCode('found'), listed: 4 },
        ])
      }, 120_000)

      // Exit test line 37: the tasks waiting on an event, as `explain` lists them.
      it('explain of any of three tasks parked on one event names all three, and no task parked on another', async () => {
        const db = await openCliDb(dialect, 'three-waiters')
        try {
          const parked = [
            await parkedOnAnEvent(db, null),
            await parkedOnAnEvent(db, 300),
            await parkedOnAnEvent(db, null),
          ]
          await parkedOnAnEvent(db, null, {}, 'another-approval')
          const byTask = (ids: readonly string[]) => [...ids].sort()
          for (const taskId of parked) {
            const run = await runCli(['explain', taskId, '--queue', QUEUE, '--json'], db.env)
            const answer = JSON.parse(run.stdout) as {
              cause: string
              facts: {
                event: string
                waiters: { taskId: string; step: string; timeoutAtMs: number | null }[]
                moreWaiters: boolean
              }
            }
            expect(
              {
                asked: taskId,
                exit: run.exit,
                event: answer.facts.event,
                waiters: byTask(answer.facts.waiters.map((waiter) => waiter.taskId)),
                more: answer.facts.moreWaiters,
              },
              'mutation-verdict:behavior:cli-explain-lists-every-waiter-of-the-event',
            ).toEqual({
              asked: taskId,
              exit: 0,
              event: 'approval',
              waiters: byTask(parked),
              more: false,
            })
            // Each waiter prints with the step that awaits and when its wait times out.
            expect(
              answer.facts.waiters
                .map((waiter) => [waiter.step, waiter.timeoutAtMs])
                .sort((left, right) => Number(left[1]) - Number(right[1])),
            ).toEqual([
              ['approve', null],
              ['approve', null],
              ['approve', NOW_MS + 300_000],
            ])
            // In text the list prints on stdout with the rest of the answer.
            const text = await runCli(['explain', taskId, '--queue', QUEUE], db.env)
            expect({
              exit: text.exit,
              stderr: text.stderr,
              named: parked.every((id) => text.stdout.includes(`taskId: ${id}`)),
            }).toEqual({ exit: 0, stderr: '', named: true })
          }
        } finally {
          await db.close()
        }
      }, 120_000)

      it("inspect prints the outcome result prints for every seeded outcome, a saga's rollback and a row the decoders refuse among them", async () => {
        const { seeded, printed } = await answersOn(dialect)
        const outcomes: string[] = []
        for (const [seed, taskId] of Object.entries(seeded)) {
          for (const reveal of [[], ['--reveal']]) {
            const answerOf = (verb: string) =>
              JSON.parse(
                printed.get([verb, taskId, '--queue', QUEUE, '--json', ...reveal].join(' ')) ??
                  '{}',
              ) as Record<string, unknown>
            // What `result` printed of the task, less what names the command and the task:
            // its exit and its outcome.
            const {
              command: _command,
              queue: _queue,
              taskId: _taskId,
              dialect: _dialect,
              ...result
            } = answerOf('result')
            const facts = answerOf('inspect')
            expect({
              seed,
              reveal: reveal.length > 0,
              outcome: { exit: facts.exit, ...(facts.outcome as object) },
              corrupt: facts.corrupt,
            }).toEqual({ seed, reveal: reveal.length > 0, outcome: result, corrupt: [] })
            if (reveal.length === 0) {
              const rollback = (result.rollback as { outcome?: string } | undefined)?.outcome
              outcomes.push(
                `${seed}: ${result.state}${rollback === undefined ? '' : `, rollback ${rollback}`}, exit ${result.exit}`,
              )
            }
          }
        }
        // The seeds reach every kind of outcome, so the comparison above was asked of each.
        expect(outcomes).toEqual([
          'completed: completed, exit done',
          'failed: failed, exit done',
          'cancelled: cancelled, exit done',
          'pending: pending, exit done',
          'rolledBack: failed, rollback complete, exit done',
          'halted: failed, rollback failed, exit done',
          'refused: unreadable, exit unreadable',
        ])
      }, 120_000)

      // Exit test line 36: one seed for every cause of the table, each on every dialect.
      describe('explain names the seeded cause', () => {
        for (const seed of EXPLAIN_SEEDS) {
          it(
            `${seed.cause}: ${seed.name}`,
            () =>
              onSeed(dialect, seed, async (db, taskId) => {
                const line = ['explain', taskId, '--queue', QUEUE]
                const run = await runCli([...line, '--json'], db.env)
                const answer = JSON.parse(run.stdout) as { cause?: string; verdict?: string }
                expect({ cause: answer.cause, verdict: answer.verdict }, seed.marker).toEqual({
                  cause: seed.cause,
                  verdict: seed.verdict,
                })
                // A verdict is not an exit code: only a row that is not readable exits
                // `unreadable`. In text the answer prints on stdout either way.
                const exit = exitCode(seed.cause === 'unreadable' ? 'unreadable' : 'done')
                const text = await runCli(line, db.env)
                expect({ json: run.exit, text: text.exit, stderr: text.stderr }).toEqual({
                  json: exit,
                  text: exit,
                  stderr: '',
                })
                const lines = text.stdout.split('\n')
                expect(lines).toContain(`cause: ${seed.cause}`)
                expect(lines).toContain(`verdict: ${seed.verdict}`)
              }),
            60_000,
          )
        }
      })

      it('retry names the counter of a failed task that is at the least or the greatest value its column holds', async () => {
        const db = await openCliDb(dialect, 'retry-at-a-bound')
        try {
          const named: unknown[] = []
          for (const extreme of RETRY_COUNTER_EXTREMES) {
            const taskId = await extreme.build(db)
            const run = await runCli(
              ['retry', taskId, '--yes', ...writeFlags(db), '--json'],
              db.env,
            )
            const answer = JSON.parse(run.stdout) as {
              error?: { cause?: string }
              conjunctsNotHeld?: string[]
            }
            named.push([extreme.what, run.exit, answer.error?.cause, answer.conjunctsNotHeld])
          }
          expect(named).toEqual(
            RETRY_COUNTER_EXTREMES.map((extreme) => [
              extreme.what,
              exitCode('refused'),
              'counter-out-of-range',
              extreme.leavesFalse,
            ]),
          )
        } finally {
          await db.close()
        }
      }, 120_000)

      it('every store command exits 5 on a database a newer build migrated, and changes no table', async () => {
        const db = await openCliDb(dialect, 'newer')
        try {
          const seeded = await seedTasks(db)
          await db.recordNewer()
          const before = await db.dump()
          for (const spec of STORE_COMMANDS) {
            const line = commandLine(spec, db, seeded.completed)
            const run = await runCli(line, db.env)
            expect({ verb: spec.verb, exit: run.exit }).toEqual({ verb: spec.verb, exit: 5 })
            // In text the refusal prints on stderr, though it names the version recorded.
            const text = await runCli(
              line.filter((argument) => argument !== '--json'),
              db.env,
            )
            expect({
              verb: spec.verb,
              exit: text.exit,
              stdout: text.stdout,
              namesTheVersion: text.stderr.includes('recordedSchemaVersion: '),
            }).toEqual({ verb: spec.verb, exit: 5, stdout: '', namesTheVersion: true })
          }
          expect(await db.dump()).toBe(before)
        } finally {
          await db.close()
        }
      })

      it('migrate without --yes changes nothing, and with --yes prints each version applied', async () => {
        const db = await openCliDb(dialect, 'migrate', 'empty')
        try {
          const before = await db.dump()
          const asked = await runCli(['migrate', '--target', db.target, '--json'], db.env)
          expect(asked.exit).toBe(2)
          expect(JSON.parse(asked.stdout)).toMatchObject({
            error: { kind: 'confirmation-required' },
            from: 0,
          })
          expect(await db.dump()).toBe(before)
          const wrongTarget = await runCli(['migrate', '--yes', '--target', 'elsewhere'], db.env)
          expect(wrongTarget.exit).toBe(2)
          expect(await db.dump()).toBe(before)

          const { opener, sent } = recordingOpener()
          const applied = await runCli(
            ['migrate', '--yes', '--target', db.target, '--json'],
            db.env,
            opener,
          )
          expect(applied.exit, applied.stdout).toBe(0)
          const versions = Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1)
          expect(JSON.parse(applied.stdout)).toMatchObject({
            from: 0,
            to: CURRENT_SCHEMA_VERSION,
            applied: versions,
          })
          // A database that was never initialized holds no rows, so no note prints for it.
          expect(applied.stderr).not.toContain('warning')
          for (const batch of sent()) {
            expect(declaresLabel(COMMANDS.migrate, batch.label), batch.label).toBe(true)
          }
          const text = await runCli(['migrate', '--yes', '--target', db.target], db.env)
          expect(text.exit).toBe(0)
          expect(text.stdout).toContain('nothing to apply')
        } finally {
          await db.close()
        }
      })

      if (dialect !== 'libsql') {
        it('a wrong password exits 6 today, and prints in no stream', async () => {
          const db = await openCliDb(dialect, 'wrong-password')
          try {
            const url = new URL(db.url)
            url.password = 'wrong-pw-9c1e'
            for (const extra of [[], ['--reveal']]) {
              const run = await runCli(['doctor', '--queue', QUEUE, '--json', ...extra], {
                DURABLERUN_STORE_URL: url.href,
              })
              expect({
                exit: run.exit,
                printed: `${run.stdout}${run.stderr}`.includes('wrong-pw-9c1e'),
              }).toEqual({ exit: 6, printed: false })
            }
          } finally {
            await db.close()
          }
        })
      }

      it("migrate prints the store's own note before the version it names", async () => {
        const db = await openCliDb(dialect, 'notes', CURRENT_SCHEMA_VERSION - 1)
        try {
          const asked = await runCli(['migrate', '--target', db.target, '--json'], db.env)
          expect(asked.exit).toBe(2)
          const note = NOTES[dialect][CURRENT_SCHEMA_VERSION]
          expect(asked.stderr).toBe(note === undefined ? '' : `warning: ${note}\n`)
        } finally {
          await db.close()
        }
      })

      it('bin/durablerun.ts exits with the code the exit table names for each outcome', async () => {
        const db = await openCliDb(dialect, 'bin')
        const older = await openCliDb(dialect, 'bin-null-payload', 9)
        try {
          const seeded = await seedTasks(db)
          // A task that is due from this instant, for `stuck` to find.
          await db.store.spawn(QUEUE, 'report', '{}')
          await plantNullPayload(older)
          const named = writeFlags(db)
          const unreachable: Record<string, string> = {
            libsql: 'libsql://127.0.0.1:1',
            postgres: 'postgresql://postgres:postgres@127.0.0.1:1/durablerun',
            mysql: 'mysql://root:durablerun@127.0.0.1:1/durablerun',
          }
          const cases: [string, Record<string, string>, string[]][] = [
            ['done', db.env, ['doctor', '--queue', QUEUE]],
            ['done', db.env, ['result', seeded.completed, '--queue', QUEUE]],
            ['done', db.env, ['inspect', seeded.completed, '--queue', QUEUE]],
            ['done', db.env, ['explain', seeded.completed, '--queue', QUEUE]],
            ['done', db.env, ['stuck', '--queue', QUEUE]],
            ['found', db.env, ['stuck', '--queue', QUEUE, '--grace', '0s', '--fail-if-any']],
            ['done', db.env, ['stats', '--queue', QUEUE]],
            ['done', db.env, ['sizes', '--queue', QUEUE]],
            ['not-found', db.env, ['inspect', '--key', 'a-key-no-task-has', '--queue', QUEUE]],
            ['usage', older.env, ['migrate', '--target', older.target]],
            ['usage', db.env, ['result', '--queue', QUEUE]],
            ['refused', db.env, ['result', 'x'.repeat(256), '--queue', QUEUE]],
            ['not-found', db.env, ['checkpoints', 'no-such-task', '--queue', QUEUE]],
            [
              'unavailable',
              { DURABLERUN_STORE_URL: unreachable[dialect] ?? '' },
              ['doctor', '--queue', QUEUE],
            ],
            ['permanent', older.env, ['migrate', '--yes', '--target', older.target]],
            // The drive verbs, last, because they write: each names its store again.
            ['done', db.env, ['enqueue', 'report', '--key', 'a-bin-key', ...named]],
            ['usage', db.env, ['emit', 'a-bin-event', ...named]],
            ['done', db.env, ['emit', 'a-bin-event', '--yes', ...named]],
            ['done', db.env, ['cancel', seeded.pending, '--yes', ...named]],
            ['done', db.env, ['retry', seeded.failed, '--yes', ...named]],
            ['refused', db.env, ['retry', seeded.completed, '--yes', ...named]],
            ['done', db.env, ['sweep', ...named]],
            ['usage', db.env, ['sweep', '--queue', QUEUE, '--target', 'not-its-store']],
          ]
          const seen: string[] = []
          for (const [exit, env, argv] of cases) {
            const child = spawnSync(process.execPath, ['--import', 'tsx', BIN, ...argv], {
              cwd: ROOT,
              env: { PATH: process.env.PATH ?? '', ...env },
              encoding: 'utf8',
            })
            expect({ argv: argv.join(' '), exit: child.status }, child.stderr).toEqual({
              argv: argv.join(' '),
              exit: exitCode(exit as Parameters<typeof exitCode>[0]),
            })
            seen.push(exit)
          }
          await db.recordNewer()
          const newer = spawnSync(
            process.execPath,
            ['--import', 'tsx', BIN, 'doctor', '--queue', QUEUE],
            {
              cwd: ROOT,
              env: { PATH: process.env.PATH ?? '', ...db.env },
              encoding: 'utf8',
            },
          )
          expect(newer.status).toBe(exitCode('schema'))
          expect(new Set([...seen, 'schema']).size).toBe(8)
        } finally {
          await older.close()
          await db.close()
        }
      }, 120_000)
    })
  }
})
