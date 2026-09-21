import { mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Client, type Transaction, createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlExecutor } from '../src/index.js'

/**
 * A failed batch is reported once, and its executor serves the next call. These cases use a
 * real database FILE, the executor as production opens it, and a second connection that holds
 * the write lock, because the failure lives below anything a fake driver or a fault injected
 * above the driver can show: the client library leaves the statement that failed busy
 * unfinished on its connection.
 *
 * The executor waits five seconds for a lock. Each case lowers that wait on its executor's
 * own connection with a PRAGMA sent through the batch port, which no store statement does, so
 * a case takes a fraction of a second and the path is the production one: the wait runs out
 * and the write batch fails with SQLITE_BUSY. The lowered wait also tells a kept connection
 * from a new one, which has the executor's five seconds again.
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

const insert = (id: number) => ({ sql: 'INSERT INTO t (id) VALUES (?)', args: [id] })
const count = { sql: 'SELECT count(*) AS n FROM t', args: [] }
const shorten = { sql: 'PRAGMA busy_timeout=100', args: [] }
const BUSY = { name: 'StoreUnavailableError', code: 'SQLITE_BUSY' }
const CLOSED = { name: 'StoreUnavailableError', code: 'CLIENT_CLOSED' }

async function readBack(db: LibsqlExecutor, pragma: 'busy_timeout' | 'journal_mode') {
  const [result] = await db.batch('pragma', [{ sql: `PRAGMA ${pragma}`, args: [] }], 'read')
  return Object.values(result?.rows[0] ?? {})[0]
}

async function ids(db: LibsqlExecutor) {
  const [result] = await db.batch(
    'read',
    [{ sql: 'SELECT id FROM t ORDER BY id', args: [] }],
    'read',
  )
  return result?.rows.map((row) => row.id)
}

/**
 * The descriptors this process holds on the database file, its log and its index. Null where
 * there is no /proc to read, and a case then goes without the premise this gives it.
 */
function descriptorsOn(file: string): number | null {
  try {
    return readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`).startsWith(file)
      } catch {
        return false
      }
    }).length
  } catch {
    return null
  }
}

let dir: string
let file: string
let url: string
let victim: LibsqlExecutor
let holderClient: Client
let holder: Transaction

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'durablerun-failed-batch-'))
  file = join(dir, 'db.sqlite')
  url = `file:${file}`
  victim = LibsqlExecutor.open(url)
  await victim.batch('setup', [{ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', args: [] }])
  await victim.batch('shorten', [shorten], 'read')
  holderClient = createClient({ url })
  holder = await holderClient.transaction('write')
})

afterEach(() => {
  holder.close()
  holderClient.close()
  victim.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a write batch that fails busy on a file database', () => {
  it('is an outage, and the next read on its executor is answered while the lock is still held', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
  })

  it('is an outage, and the next write on its executor is answered once the lock is free', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    await holder.rollback()
    expect(await outcome(victim.batch('write', [insert(2)]))).toBe('answered')
    expect(await ids(victim)).toEqual([2])
  })

  it('is an outage for that call alone: a read made in the same tick, queued behind it, is answered', async () => {
    // Two store calls made together on one executor is an ordinary shape: a task that starts
    // two steps at once. The read is already waiting its turn when the write fails.
    const [write, read] = await Promise.all([
      outcome(victim.batch('write', [insert(1)])),
      outcome(victim.batch('read', [count], 'read')),
    ])
    expect(write).toMatchObject(BUSY)
    expect(read).toBe('answered')
  })

  it('leaves a third executor answering reads, while the lock is held and after it is free', async () => {
    const third = LibsqlExecutor.open(url)
    try {
      expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
      expect(await outcome(third.batch('read', [count], 'read'))).toBe('answered')
      await holder.rollback()
      expect(await outcome(third.batch('write', [insert(3)]))).toBe('answered')
    } finally {
      third.close()
    }
  })

  it('gets a new connection with the five second wait and write-ahead logging on it', async () => {
    expect(await readBack(victim, 'busy_timeout')).toBe(100)
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    expect({
      busyTimeout: await readBack(victim, 'busy_timeout'),
      journalMode: await readBack(victim, 'journal_mode'),
    }).toEqual({ busyTimeout: 5000, journalMode: 'wal' })
  })

  it('abandons a connection that holds no lock: another executor writes and a TRUNCATE checkpoint is not blocked', async () => {
    // Nothing between the failure and the checkpoint gives the event loop a turn, so the
    // abandoned connection and its unfinished statement cannot have been collected yet.
    // Where /proc exists, the descriptors still open on the file say so.
    const third = LibsqlExecutor.open(url)
    const checkpointer = createClient({ url })
    try {
      await third.batch('open', [count], 'read')
      const before = descriptorsOn(file)
      expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
      await holder.rollback()
      expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
      const after = descriptorsOn(file)
      if (before !== null && after !== null) expect(after).toBeGreaterThan(before)

      expect(await outcome(third.batch('write', [insert(3)]))).toBe('answered')
      const checkpoint = await checkpointer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(checkpoint.rows[0]).toMatchObject({ busy: 0, log: 0, checkpointed: 0 })
      expect(await ids(victim)).toEqual([3])
    } finally {
      checkpointer.close()
      third.close()
    }
  })

  it('is followed by a recovery that can fail too: that is an outage once, and the next call recovers before its batch', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    await holder.rollback()
    expect(await outcome(victim.batch('write', [insert(2)]))).toBe('answered')
    expect(await outcome(victim.batch('shorten', [shorten], 'read'))).toBe('answered')
    const again = await holderClient.transaction('write')
    try {
      expect(await outcome(victim.batch('write', [insert(3)]))).toMatchObject(BUSY)
      // The new connection cannot be opened while the directory is gone.
      renameSync(dir, `${dir}-gone`)
      try {
        // Two calls, because the second meets a client that holds a closed connection, and
        // using that one would abort the process inside the native binding. The binding
        // gives the error no code, so its type is all that is held here.
        for (const attempt of ['first', 'second']) {
          const unopened = await outcome(victim.batch('read', [count], 'read'))
          expect(unopened, attempt).toMatchObject({ name: 'StoreUnavailableError' })
          expect(unopened, attempt).not.toMatchObject(BUSY)
        }
      } finally {
        renameSync(`${dir}-gone`, dir)
      }
      expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
      expect({
        busyTimeout: await readBack(victim, 'busy_timeout'),
        journalMode: await readBack(victim, 'journal_mode'),
        ids: await ids(victim),
      }).toEqual({ busyTimeout: 5000, journalMode: 'wal', ids: [2] })
    } finally {
      again.close()
    }
  })

  it('does not break the queue behind it, and leaves no rejection unhandled', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      // Five calls made in one tick. The second write fails busy as well, on the new
      // connection, whose wait the call before it lowers again.
      const outcomes = await Promise.all([
        outcome(victim.batch('write', [insert(1)])),
        outcome(victim.batch('read', [count], 'read')),
        outcome(victim.batch('shorten', [shorten], 'read')),
        outcome(victim.batch('write', [insert(2)])),
        outcome(victim.batch('read', [count], 'read')),
      ])
      expect(outcomes).toMatchObject([BUSY, 'answered', 'answered', BUSY, 'answered'])
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('stays closed when it is closed with a failure behind it', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    victim.close()
    expect(await outcome(victim.batch('read', [count], 'read'))).toMatchObject(CLOSED)
    expect(await outcome(victim.batch('read', [count], 'read'))).toMatchObject(CLOSED)
  })
})

describe('a file database executor', () => {
  it('keeps the connection of a batch that failed and left nothing in progress', async () => {
    await holder.rollback()
    expect(await outcome(victim.batch('write', [insert(1)]))).toBe('answered')
    expect(await outcome(victim.batch('write', [insert(2), insert(1)]))).toMatchObject({
      name: 'PermanentStoreError',
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    })
    // The lowered wait is still there, so this is the connection the batch failed on.
    expect({ busyTimeout: await readBack(victim, 'busy_timeout'), ids: await ids(victim) }).toEqual(
      {
        busyTimeout: 100,
        ids: [1],
      },
    )
    expect(await outcome(victim.batch('write', [insert(2)]))).toBe('answered')
  })

  it('answers every call that is queued when it is closed, and hangs none', async () => {
    const queued = [
      outcome(victim.batch('read', [count], 'read')),
      outcome(victim.batch('write', [insert(1)])),
      outcome(victim.batch('read', [count], 'read')),
    ]
    victim.close()
    expect(await Promise.all(queued)).toMatchObject([CLOSED, CLOSED, CLOSED])
  })
})

describe('an in-memory database', () => {
  it('lives in its one connection, and keeps it and its rows through a failed batch', async () => {
    const memory = LibsqlExecutor.open(':memory:')
    try {
      await memory.batch('setup', [
        { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', args: [] },
        insert(1),
      ])
      expect(await outcome(memory.batch('write', [insert(2), insert(1)]))).toMatchObject({
        name: 'PermanentStoreError',
        code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
      })
      expect(await ids(memory)).toEqual([1])
      expect(await outcome(memory.batch('write', [insert(3)]))).toBe('answered')
      expect(await ids(memory)).toEqual([1, 3])
    } finally {
      memory.close()
    }
  })
})

describe('canary on the client library', () => {
  it('still leaves a statement whose step failed busy in progress on its connection', async () => {
    const raw = createClient({ url })
    const settled = (call: Promise<unknown>) =>
      call.then(
        () => 'answered',
        (error: unknown) => (error as { code?: unknown }).code,
      )
    try {
      await raw.execute('PRAGMA busy_timeout=100')
      expect(await settled(raw.batch(['INSERT INTO t (id) VALUES (1)'], 'write'))).toBe(
        'SQLITE_BUSY',
      )
      expect(
        await settled(raw.batch(['SELECT count(*) FROM t'], 'read')),
        'The client library now finishes a statement whose step failed busy, so a read behind a failed write is answered. LibsqlExecutor no longer needs to ask its connection and replace it: delete connectionIsWhole, the reconnect and this canary. BUILD.md names the condition under PR3.15.',
      ).toBe('SQLITE_BUSY')
    } finally {
      raw.close()
    }
  })
})
