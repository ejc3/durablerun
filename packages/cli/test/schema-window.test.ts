import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  STORE_COMMANDS,
  commandLine,
  comparedLines,
  openCliDb,
  runCli,
  seedTasks,
  withoutDialect,
} from './support.js'

/**
 * The schema window is the CLI's safety property: a build reads only the versions its store
 * package says its reads accept, and refuses every other one before it sends anything that
 * could change a row. These cases run on libSQL, and cli-dialects.test.ts runs the same
 * property on every selected dialect.
 */
describe('the schema window on libSQL', () => {
  it('every store command exits 5 on a database a newer build migrated, and changes no table', async () => {
    const db = await openCliDb('libsql', 'window-newer')
    try {
      const seeded = await seedTasks(db)
      await db.recordNewer()
      const before = await db.dump()
      for (const spec of STORE_COMMANDS) {
        const run = await runCli(commandLine(spec, db, seeded.completed), db.env)
        expect(
          { command: spec.verb, exit: run.exit },
          'mutation-verdict:behavior:cli-refuses-a-newer-schema',
        ).toEqual({ command: spec.verb, exit: 5 })
      }
      expect(await db.dump()).toBe(before)
    } finally {
      await db.close()
    }
  })

  it('a read exits 5 on a database older than the window, and changes no table', async () => {
    const db = await openCliDb('libsql', 'window-older', 4)
    try {
      const before = await db.dump()
      for (const spec of STORE_COMMANDS.filter((command) => !command.writes)) {
        const run = await runCli(commandLine(spec, db, 'any-task'), db.env)
        expect(
          { command: spec.verb, exit: run.exit },
          'mutation-verdict:behavior:cli-refuses-an-older-schema',
        ).toEqual({ command: spec.verb, exit: 5 })
      }
      expect(await db.dump()).toBe(before)
    } finally {
      await db.close()
    }
  })

  it('a read exits 5 on a database that was never initialized, and creates no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-missing-'))
    try {
      const file = join(dir, 'never.sqlite')
      for (const spec of STORE_COMMANDS.filter((command) => !command.writes)) {
        const run = await runCli(commandLine(spec, { target: file }, 'any-task'), {
          DURABLERUN_STORE_URL: `file:${file}`,
        })
        expect({ command: spec.verb, exit: run.exit }).toEqual({ command: spec.verb, exit: 5 })
      }
      expect(existsSync(file), 'mutation-verdict:behavior:cli-read-creates-no-file').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const empty = await openCliDb('libsql', 'window-empty', 'empty')
    try {
      const before = await empty.dump()
      for (const spec of STORE_COMMANDS.filter((command) => !command.writes)) {
        const run = await runCli(commandLine(spec, empty, 'any-task'), empty.env)
        expect({ command: spec.verb, exit: run.exit }).toEqual({ command: spec.verb, exit: 5 })
      }
      expect(await empty.dump()).toBe(before)
    } finally {
      await empty.close()
    }
  })

  it('a read of a database migrated through the first five versions answers as it does at the current version', async () => {
    const answers = async (schema: 5 | 'current'): Promise<Map<string, unknown>> => {
      const db = await openCliDb('libsql', 'window-v5', schema)
      try {
        const seeded = await seedTasks(db)
        const found = new Map<string, unknown>()
        for (const line of comparedLines(seeded)) {
          const run = await runCli(line, db.env)
          expect(run.exit === 0 || run.exit === 8, `${line.join(' ')}: ${run.stdout}`).toBe(true)
          found.set(line.join(' '), withoutDialect(run.stdout))
        }
        return found
      } finally {
        await db.close()
      }
    }
    const atFive = await answers(5)
    const atCurrent = await answers('current')
    expect([...atFive.keys()]).toEqual([...atCurrent.keys()])
    for (const [line, answer] of atFive) {
      // doctor reports the version it found, and nothing else of its answer may differ.
      const expected = atCurrent.get(line) as Record<string, unknown>
      expect(answer, line).toEqual(
        line.startsWith('doctor') ? { ...expected, recordedSchemaVersion: 5 } : expected,
      )
    }
  })
})
