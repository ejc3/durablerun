import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { openCliDb, recordingOpener, runCli } from './support.js'

/**
 * migrate is the one command that changes the schema, so it names its store again and asks
 * for --yes. Both refusals leave every table as it was. cli-dialects.test.ts runs the same
 * on every selected dialect.
 */
describe('migrate on libSQL', () => {
  it('without --yes prints the versions it would apply and changes nothing', async () => {
    const db = await openCliDb('libsql', 'migrate-yes', 9)
    try {
      const before = await db.dump()
      const run = await runCli(['migrate', '--target', db.target, '--json'], db.env)
      expect(
        { exit: run.exit, dumpUnchanged: (await db.dump()) === before },
        'mutation-verdict:behavior:cli-migrate-needs-yes',
      ).toEqual({ exit: 2, dumpUnchanged: true })
      expect(JSON.parse(run.stdout)).toMatchObject({
        error: { kind: 'confirmation-required' },
        from: 9,
        wouldApply: [10],
      })
      expect(run.stderr).toContain('version 10')
    } finally {
      await db.close()
    }
  })

  it('without --yes, of a file that is not there yet, prints every version and creates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-migrate-'))
    try {
      const file = join(dir, 'db.sqlite')
      const run = await runCli(['migrate', '--target', file, '--json'], {
        DURABLERUN_STORE_URL: `file:${file}`,
      })
      expect({ exit: run.exit, files: readdirSync(dir) }).toEqual({ exit: 2, files: [] })
      expect(JSON.parse(run.stdout)).toMatchObject({
        error: { kind: 'confirmation-required' },
        from: 0,
        wouldApply: Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with a --target that is not its store opens nothing and changes nothing', async () => {
    const db = await openCliDb('libsql', 'migrate-target', 9)
    try {
      const before = await db.dump()
      const { opener, sent } = recordingOpener()
      const run = await runCli(
        ['migrate', '--yes', '--target', `${db.target}.other`, '--json'],
        db.env,
        opener,
      )
      expect(
        { exit: run.exit, sent: sent().length, dumpUnchanged: (await db.dump()) === before },
        'mutation-verdict:behavior:cli-migrate-needs-its-target',
      ).toEqual({ exit: 2, sent: 0, dumpUnchanged: true })
      expect(JSON.parse(run.stdout)).toMatchObject({ error: { kind: 'target-mismatch' } })
    } finally {
      await db.close()
    }
  })

  it('refuses a database over a stored NULL payload with exit 7, and leaves version 9', async () => {
    const db = await openCliDb('libsql', 'migrate-null', 9)
    try {
      await db.raw.batch('fixture:null-payload', [
        {
          sql: 'INSERT INTO events (queue, event_name, payload) VALUES (?, ?, NULL)',
          args: ['q', 'e'],
        },
      ])
      const run = await runCli(['migrate', '--yes', '--target', db.target, '--json'], db.env)
      expect(run.exit).toBe(7)
      expect(JSON.parse(run.stdout)).toMatchObject({ error: { kind: 'permanent-store-error' } })
      expect(await db.admin.schemaVersion()).toBe(9)
    } finally {
      await db.close()
    }
  })
})
