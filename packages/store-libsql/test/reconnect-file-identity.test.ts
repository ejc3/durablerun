import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { type DatabaseFile, fixedFile, sameFile } from '../src/executor.js'
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
  try {
    await holder.execute('BEGIN IMMEDIATE')
  } catch (error) {
    holder.close()
    throw error
  }
  return async () => {
    try {
      await holder.execute('ROLLBACK')
    } finally {
      holder.close()
    }
  }
}

/** A database file with the case's table and a row of its own, written by a client of its own. */
async function anotherDatabase(file: string, id: number): Promise<void> {
  const other = createClient({ url: `file:${file}` })
  try {
    await other.batch([createTable, insert(id)], 'write')
  } finally {
    other.close()
  }
}

/** A database file in write-ahead logging mode with one row, checkpointed and closed. */
async function walDatabase(file: string, id: number): Promise<void> {
  const seed = createClient({ url: `file:${file}` })
  try {
    await seed.execute('PRAGMA journal_mode=WAL')
    await seed.batch([createTable, insert(id)], 'write')
    await seed.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    seed.close()
  }
}

/** The rows of the case's table as a new connection to the path reads them. */
async function idsOnTheFile(file: string): Promise<unknown> {
  const reader = createClient({ url: `file:${file}` })
  try {
    return (await reader.execute('SELECT id FROM t ORDER BY id')).rows.map((row) => row.id)
  } finally {
    reader.close()
  }
}

/** An executor on a file of the case's table with one row, whose next write fails busy. */
async function brokenByALockWait(file: string, url: string): Promise<LibsqlExecutor> {
  const victim = LibsqlExecutor.open(url)
  try {
    await victim.batch('setup', [createTable, insert(1)])
    await victim.batch('shorten', [shorten], 'read')
    const release = await holdTheWriteLock(file)
    try {
      expect(await outcome(victim.batch('write', [insert(2)]))).toMatchObject(BUSY)
    } finally {
      await release()
    }
  } catch (error) {
    victim.close()
    throw error
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

  it('refuses another file put in place of its own, and never serves from it', async () => {
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

  it('refuses to create a file in place of its own that was removed', async () => {
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

  it('keeps a client handed to it with a relative path to the file that path named when it was made', async () => {
    const home = process.cwd()
    const opened = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-handed-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-handed-elsewhere-'))
    let victim: LibsqlExecutor | undefined
    try {
      process.chdir(opened)
      const handed = new LibsqlExecutor(createClient({ url: 'file:rel.db' }), true, 'file:rel.db')
      victim = handed
      await handed.batch('setup', [createTable, insert(1)])
      for (const where of ['where it was made', 'after a change of directory']) {
        await handed.batch('shorten', [shorten], 'read')
        const release = await holdTheWriteLock(join(opened, 'rel.db'))
        if (where !== 'where it was made') process.chdir(elsewhere)
        try {
          expect(await outcome(handed.batch('write', [insert(2)])), where).toMatchObject(BUSY)
        } finally {
          await release()
        }
        if (where === 'where it was made') expect(await ids(handed), where).toEqual([1])
      }
      // The client reopens its relative path in the directory the process is in now, which
      // no longer names the file the executor fixed, so nothing is opened.
      expect(await ids(handed)).toEqual({ name: 'StoreUnavailableError' })
      expect(await ids(handed)).toEqual({ name: 'StoreUnavailableError' })
      expect(
        existsSync(join(elsewhere, 'rel.db')),
        'no file is created where the relative path now leads',
      ).toBe(false)
    } finally {
      process.chdir(home)
      victim?.close()
      rmSync(opened, { recursive: true, force: true })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('never serves a file put in place of its own between its making and its first batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-early-'))
    const file = join(dir, 'db.sqlite')
    let victim: LibsqlExecutor | undefined
    try {
      await walDatabase(file, 1)
      await walDatabase(join(dir, 'other.sqlite'), 7)
      victim = LibsqlExecutor.open(`file:${file}`)
      // Replaced after the executor opened its file and before its first batch.
      renameSync(join(dir, 'other.sqlite'), file)
      expect(await ids(victim)).toEqual([1])
      // An EXPLAIN of a writing statement stays in progress, so the connection is broken.
      expect(
        await outcome(
          victim.batch('explain', [{ sql: 'EXPLAIN UPDATE t SET id = id', args: [] }], 'read'),
        ),
      ).toMatchObject(BUSY)
      for (const attempt of ['first', 'second']) {
        expect(await ids(victim), attempt).not.toEqual([7])
      }
      expect(await outcome(victim.batch('write', [insert(8)]))).not.toBe('answered')
      expect(await idsOnTheFile(file), 'the file put in its place is untouched').toEqual([7])
    } finally {
      victim?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens nothing where a directory its path passes through now points', async () => {
    const root = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-link-'))
    const first = join(root, 'first')
    const second = join(root, 'second')
    const link = join(root, 'link')
    let victim: LibsqlExecutor | undefined
    try {
      mkdirSync(first)
      mkdirSync(second)
      symlinkSync(first, link)
      victim = await brokenByALockWait(join(first, 'db.sqlite'), `file:${join(link, 'db.sqlite')}`)
      rmSync(link)
      symlinkSync(second, link)
      expect(await ids(victim)).toEqual({ name: 'StoreUnavailableError' })
      expect(
        existsSync(join(second, 'db.sqlite')),
        'no file is created where the link now points',
      ).toBe(false)
    } finally {
      victim?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('closes a new connection that opened another file, and connects again once its own file is back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-swapped-'))
    const file = join(dir, 'db.sqlite')
    const kept = join(dir, 'kept.sqlite')
    let swapAtTheNextReconnect = false
    const client = createClient({ url: `file:${file}` })
    // Between the check before the reopen and the reopen, the path comes to name another file.
    const swapping = new Proxy(client, {
      get(target, key) {
        if (key === 'reconnect') {
          return async () => {
            if (swapAtTheNextReconnect) {
              swapAtTheNextReconnect = false
              renameSync(file, kept)
              await anotherDatabase(file, 7)
            }
            return target.reconnect()
          }
        }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let handed: LibsqlExecutor | undefined
    try {
      handed = new LibsqlExecutor(swapping, true, `file:${file}`)
      await handed.batch('setup', [createTable, insert(1)])
      const checkpoint = createClient({ url: `file:${file}` })
      try {
        await checkpoint.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        checkpoint.close()
      }
      await handed.batch('shorten', [shorten], 'read')
      const release = await holdTheWriteLock(file)
      try {
        expect(await outcome(handed.batch('write', [insert(2)]))).toMatchObject(BUSY)
      } finally {
        await release()
      }
      for (const leftover of [`${file}-wal`, `${file}-shm`]) rmSync(leftover, { force: true })
      swapAtTheNextReconnect = true
      expect(await ids(handed), 'the new connection opened another file').toEqual({
        name: 'StoreUnavailableError',
      })
      expect(swapAtTheNextReconnect, 'the reconnect happened').toBe(false)
      expect(client.closed, 'the refused connection is closed').toBe(true)
      for (const leftover of [file, `${file}-wal`, `${file}-shm`]) rmSync(leftover, { force: true })
      renameSync(kept, file)
      expect(await ids(handed), 'the next call connects again, to its own file').toEqual([1])
    } finally {
      handed?.close()
      client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reconnects to the file a percent-encoded path names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-encoded-'))
    const file = join(dir, 'my db.sqlite')
    let victim: LibsqlExecutor | undefined
    try {
      victim = await brokenByALockWait(file, pathToFileURL(file).href)
      expect(await ids(victim)).toEqual([1])
    } finally {
      victim?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a file::memory: database in its one connection: never a file, and never a new connection', async () => {
    const home = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-reconnect-memory-'))
    let memory: LibsqlExecutor | undefined
    try {
      process.chdir(dir)
      memory = LibsqlExecutor.open('file::memory:')
      await memory.batch('setup', [createTable, insert(1)])
      const [listed] = await memory.batch(
        'list',
        [{ sql: 'PRAGMA database_list', args: [] }],
        'read',
      )
      expect(listed?.rows[0]?.file, 'an in-memory database has no file').toBe('')
      expect(
        await outcome(
          memory.batch('explain', [{ sql: 'EXPLAIN UPDATE t SET id = id', args: [] }], 'read'),
        ),
      ).toMatchObject(BUSY)
      expect(
        await outcome(memory.batch('read', [{ sql: 'SELECT id FROM t', args: [] }], 'read')),
      ).toMatchObject({ ...BUSY, message: expect.stringContaining('SQL statements in progress') })
    } finally {
      process.chdir(home)
      memory?.close()
      rmSync(dir, { recursive: true, force: true })
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

describe('the database file an executor fixes', () => {
  const had: DatabaseFile = { path: '/a/db.sqlite', real: '/a/db.sqlite', device: 7n, inode: 11n }

  it('is the same file only by the same path, real path, device and inode', () => {
    expect({
      same: sameFile(had, { ...had }),
      anotherPath: sameFile(had, { ...had, path: '/b/db.sqlite' }),
      anotherRealPath: sameFile(had, { ...had, real: '/b/db.sqlite' }),
      anotherDevice: sameFile(had, { ...had, device: 8n }),
      anotherInode: sameFile(had, { ...had, inode: 12n }),
      nothing: sameFile(had, undefined),
    }).toEqual({
      same: true,
      anotherPath: false,
      anotherRealPath: false,
      anotherDevice: false,
      anotherInode: false,
      nothing: false,
    })
  })

  it('is none when its path named one file before the open and another after it', () => {
    expect({
      created: fixedFile(undefined, had),
      unchanged: fixedFile({ ...had }, had),
      replaced: fixedFile({ ...had, inode: 12n }, had),
      gone: fixedFile(had, undefined),
    }).toEqual({ created: had, unchanged: had, replaced: null, gone: null })
  })
})
