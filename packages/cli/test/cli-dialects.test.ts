import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecordingExecutor } from '@durablerun/core/testing'
import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { COMMANDS, declaresLabel } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import {
  QUEUE,
  SELECTED,
  STORE_COMMANDS,
  commandLine,
  comparedLines,
  openCliDb,
  openerWrapping,
  plantNullPayload,
  runCli,
  seedTasks,
  withoutDialect,
} from './support.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'durablerun.ts')

/** The answers of every compared command line, run through main against one seeded database. */
async function answersOn(dialect: (typeof SELECTED)[number]): Promise<Map<string, string>> {
  const db = await openCliDb(dialect, 'same-json')
  try {
    const seeded = await seedTasks(db)
    const answers = new Map<string, string>()
    for (const line of comparedLines(seeded)) {
      const run = await runCli(line, db.env)
      answers.set(line.join(' '), run.stdout)
    }
    return answers
  } finally {
    await db.close()
  }
}

/**
 * Exit test line 32 on every selected dialect. libSQL needs no server, so it is the
 * reference on every run, and a run narrowed to one server dialect still compares it with
 * something.
 */
describe('the CLI on every selected dialect', () => {
  it('doctor, result and checkpoints print the JSON libSQL prints, apart from the fields under dialect', async () => {
    const reference = await answersOn('libsql')
    for (const dialect of SELECTED) {
      const answers = dialect === 'libsql' ? reference : await answersOn(dialect)
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
            const recorders: RecordingExecutor[] = []
            const opener = openerWrapping((real) => {
              const recorder = new RecordingExecutor(real)
              recorders.push(recorder)
              return recorder
            })
            const run = await runCli(commandLine(spec, db, seeded.completed), db.env, opener)
            expect(run.exit, `${spec.verb}: ${run.stdout}`).toBe(0)
            const sent = recorders.flatMap((recorder) => recorder.batches)
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

      it('every store command exits 5 on a database a newer build migrated, and changes no table', async () => {
        const db = await openCliDb(dialect, 'newer')
        try {
          const seeded = await seedTasks(db)
          await db.recordNewer()
          const before = await db.dump()
          for (const spec of STORE_COMMANDS) {
            const run = await runCli(commandLine(spec, db, seeded.completed), db.env)
            expect({ verb: spec.verb, exit: run.exit }).toEqual({ verb: spec.verb, exit: 5 })
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

          const recorder: RecordingExecutor[] = []
          const opener = openerWrapping((real) => {
            const next = new RecordingExecutor(real)
            recorder.push(next)
            return next
          })
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
          expect(applied.stderr).toContain('version 10')
          for (const batch of recorder.flatMap((next) => next.batches)) {
            expect(declaresLabel(COMMANDS.migrate, batch.label), batch.label).toBe(true)
          }
          const text = await runCli(['migrate', '--yes', '--target', db.target], db.env)
          expect(text.exit).toBe(0)
          expect(text.stdout).toContain('nothing to apply')
        } finally {
          await db.close()
        }
      })

      it('bin/durablerun.ts exits with the code the exit table names for each outcome', async () => {
        const db = await openCliDb(dialect, 'bin')
        const older = await openCliDb(dialect, 'bin-null-payload', 9)
        try {
          const seeded = await seedTasks(db)
          await plantNullPayload(older)
          const unreachable: Record<string, string> = {
            libsql: 'libsql://127.0.0.1:1',
            postgres: 'postgresql://postgres:postgres@127.0.0.1:1/durablerun',
            mysql: 'mysql://root:durablerun@127.0.0.1:1/durablerun',
          }
          const cases: [string, Record<string, string>, string[]][] = [
            ['done', db.env, ['doctor', '--queue', QUEUE]],
            ['done', db.env, ['result', seeded.completed, '--queue', QUEUE]],
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
          expect(new Set([...seen, 'schema']).size).toBe(7)
        } finally {
          await older.close()
          await db.close()
        }
      }, 120_000)
    })
  }
})
