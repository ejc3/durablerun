import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Client, createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { LibsqlExecutor } from '../src/index.js'

/**
 * A connection the executor replaces after a failed batch must be a connection to the same
 * database. The client's `reconnect()` opens the path the client was given, so a relative
 * path after the process changed directory, a file removed or replaced while the executor
 * had it open, and an empty path, which SQLite gives a private database of its own, would
 * each land on a different database. Every case runs on real files, through the executor as
 * production opens it, and breaks the connection the way production does, with a write that
 * waits out a lowered busy timeout, or with a statement SQLite leaves in progress.
 */

type Outcome = 'answered' | { name: string; code: unknown; message: string }

function outcome(call: Promise<unknown>): Promise<Outcome> {
  return call.then(
    () => 'answered' as const,
    (error: unknown) => {
      const cause = (error as Error).cause as { code?: unknown; message?: unknown } | undefined
      return { name: (error as Error).name, code: cause?.code, message: String(cause?.message) }
    },
  )
}

/** The rows of the case's table, or the failure that stood in their place. */
function ids(db: LibsqlExecutor): Promise<unknown> {
  return db.batch('read', [{ sql: 'SELECT id FROM t ORDER BY id', args: [] }], 'read').then(
    ([result]) => result?.rows.map((row) => row.id),
    (error: unknown) => ({ name: (error as Error).name }),
  )
}

const LOWERED_WAIT_MS = 10
const createTable = { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', args: [] }
const insert = (id: number) => ({ sql: 'INSERT INTO t (id) VALUES (?)', args: [id] })
const shorten = { sql: `PRAGMA busy_timeout=${LOWERED_WAIT_MS}`, args: [] }
const BUSY = { name: 'StoreUnavailableError', code: 'SQLITE_BUSY' }

/** Another connection takes the database's write lock. The returned call gives it back. */
async function holdTheWriteLock(file: string): Promise<() => Promise<void>> {
  const holder: Client = createClient({ url: `file:${file}` })
  await holder.execute('BEGIN IMMEDIATE')
  return async () => {
    await holder.execute('ROLLBACK')
    holder.close()
  }
}

/** A database file with the case's table and a row of its own, written by a client of its own. */
async function anotherDatabase(file: string, id: number): Promise<void> {
  const other = createClient({ url: `file:${file}` })
  await other.batch([createTable, insert(id)], 'write')
  other.close()
}

/** An executor on a file of the case's table with one row, whose next write fails busy. */
async function brokenByALockWait(file: string, url: string): Promise<LibsqlExecutor> {
  const victim = LibsqlExecutor.open(url)
  await victim.batch('setup', [createTable, insert(1)])
  await victim.batch('shorten', [shorten], 'read')
  const release = await holdTheWriteLock(file)
  try {
    expect(await outcome(victim.batch('write', [insert(2)]))).toMatchObject(BUSY)
  } finally {
    await release()
  }
  return victim
}

describe('a connection replaced after a failed batch', () => {
  it('reaches the file the executor opened after the process changes directory, and creates none where it went', async () => {
    const home = process.cwd()
    const opened = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-opened-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-elsewhere-'))
    let victim: LibsqlExecutor | undefined
    try {
      process.chdir(opened)
      const victimOpened = LibsqlExecutor.open('file:rel.db')
      victim = victimOpened
      await victimOpened.batch('setup', [createTable, insert(1)])
      await victimOpened.batch('shorten', [shorten], 'read')
      const release = await holdTheWriteLock(join(opened, 'rel.db'))
      process.chdir(elsewhere)
      try {
        expect(await outcome(victimOpened.batch('write', [insert(2)]))).toMatchObject(BUSY)
      } finally {
        await release()
      }
      expect(await ids(victimOpened)).toEqual([1])
      expect(await outcome(victimOpened.batch('write', [insert(3)]))).toBe('answered')
      expect(await ids(victimOpened)).toEqual([1, 3])
      expect(existsSync(join(elsewhere, 'rel.db'))).toBe(false)
    } finally {
      process.chdir(home)
      victim?.close()
      rmSync(opened, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses another file put in place of its own, as an outage on every call, and never serves from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-replaced-'))
    const file = join(dir, 'db.sqlite')
    let victim: LibsqlExecutor | undefined
    try {
      victim = await brokenByALockWait(file, `file:${file}`)
      await anotherDatabase(join(dir, 'other.sqlite'), 7)
      rmSync(`${file}-wal`, { force: true })
      rmSync(`${file}-shm`, { force: true })
      renameSync(join(dir, 'other.sqlite'), file)
      expect(await ids(victim)).toEqual({ name: 'StoreUnavailableError' })
      expect(await ids(victim)).toEqual({ name: 'StoreUnavailableError' })
    } finally {
      victim?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to create a file in place of its own that was removed, as an outage on every call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-removed-'))
    const file = join(dir, 'db.sqlite')
    let victim: LibsqlExecutor | undefined
    try {
      victim = await brokenByALockWait(file, `file:${file}`)
      for (const leftover of [file, `${file}-wal`, `${file}-shm`]) rmSync(leftover, { force: true })
      expect(await ids(victim)).toEqual({ name: 'StoreUnavailableError' })
      expect(await ids(victim)).toEqual({ name: 'StoreUnavailableError' })
      expect(
        existsSync(file),
        'mutation-verdict:behavior:libsql-reconnect-refuses-another-file',
      ).toBe(false)
    } finally {
      victim?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a new connection that opened another file, when the client handed to it names its file by a relative path', async () => {
    const home = process.cwd()
    const opened = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-handed-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-handed-elsewhere-'))
    let victim: LibsqlExecutor | undefined
    try {
      process.chdir(opened)
      const handed = new LibsqlExecutor(createClient({ url: 'file:rel.db' }), true)
      victim = handed
      await handed.batch('setup', [createTable, insert(1)])
      await handed.batch('shorten', [shorten], 'read')
      const release = await holdTheWriteLock(join(opened, 'rel.db'))
      process.chdir(elsewhere)
      try {
        expect(await outcome(handed.batch('write', [insert(2)]))).toMatchObject(BUSY)
      } finally {
        await release()
      }
      // The client reopens its relative path in the directory the process is in now. That
      // file is not the one the executor had, so the new connection is closed and refused.
      expect(await ids(handed)).toEqual({ name: 'StoreUnavailableError' })
      expect(await ids(handed)).toEqual({ name: 'StoreUnavailableError' })
    } finally {
      process.chdir(home)
      victim?.close()
      rmSync(opened, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('never gives an empty-path database, which SQLite keeps private to its one connection, a connection of its own', async () => {
    const temp = LibsqlExecutor.open('file:')
    try {
      await temp.batch('setup', [createTable, insert(1)])
      // An EXPLAIN of a writing statement stays in progress after its last row, so this
      // batch's own COMMIT is refused and the connection is left as a lock wait leaves it.
      expect(
        await outcome(
          temp.batch('explain', [{ sql: 'EXPLAIN UPDATE t SET id = id', args: [] }], 'read'),
        ),
      ).toMatchObject(BUSY)
      // The next call meets that same connection, which still refuses its COMMIT, and not a
      // new and empty database.
      expect(
        await outcome(temp.batch('read', [{ sql: 'SELECT id FROM t', args: [] }], 'read')),
      ).toMatchObject({ ...BUSY, message: expect.stringContaining('SQL statements in progress') })
    } finally {
      temp.close()
    }
  })
})
