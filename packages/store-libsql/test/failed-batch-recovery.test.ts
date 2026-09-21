import {
  constants,
  accessSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemClock } from '@durablerun/core'
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

/** How long a case lets a write wait for the lock before SQLite refuses it. */
const LOWERED_WAIT_MS = 10
const insert = (id: number) => ({ sql: 'INSERT INTO t (id) VALUES (?)', args: [id] })
const count = { sql: 'SELECT count(*) AS n FROM t', args: [] }
const shorten = { sql: `PRAGMA busy_timeout=${LOWERED_WAIT_MS}`, args: [] }
const BUSY = { name: 'StoreUnavailableError', code: 'SQLITE_BUSY' }
const CLOSED = { name: 'StoreUnavailableError', code: 'CLIENT_CLOSED' }

async function readBack(db: LibsqlExecutor, pragma: 'busy_timeout' | 'journal_mode') {
  const [result] = await db.batch('pragma', [{ sql: `PRAGMA ${pragma}`, args: [] }], 'read')
  return Object.values(result?.rows[0] ?? {})[0]
}

/**
 * The two settings the executor applies to each connection it opens. The file keeps
 * write-ahead logging once it is set, so the journal mode says only that the file is still in
 * WAL mode. The busy timeout is what tells a new connection, which has the executor's five
 * seconds, from the one a case lowered.
 */
async function connectionPragmas(db: LibsqlExecutor) {
  return {
    busyTimeout: await readBack(db, 'busy_timeout'),
    journalMode: await readBack(db, 'journal_mode'),
  }
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
})

afterEach(() => {
  victim.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Another connection takes the write lock for each case and holds it until the case frees it. */
function holdTheWriteLock(): void {
  beforeEach(async () => {
    holderClient = createClient({ url })
    holder = await holderClient.transaction('write')
  })
  afterEach(() => {
    holder.close()
    holderClient.close()
  })
}

describe('a write batch that fails busy on a file database', () => {
  holdTheWriteLock()

  it('is an outage, and the next read on its executor is answered while the lock is still held', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
  })

  it('is an outage, and the next write on its executor is answered once the lock is free', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    await holder.rollback()
    expect(
      await outcome(victim.batch('write', [insert(2)])),
      'mutation-verdict:behavior:libsql-suspect-connection-is-asked',
    ).toBe('answered')
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
    expect(read, 'mutation-verdict:behavior:libsql-file-batches-run-one-at-a-time').toBe('answered')
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
    expect(await readBack(victim, 'busy_timeout')).toBe(LOWERED_WAIT_MS)
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject(BUSY)
    expect(await connectionPragmas(victim)).toEqual({ busyTimeout: 5000, journalMode: 'wal' })
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
      // The file is still the one the executor opened, so a new connection is asked for,
      // and this process may not open it.
      chmodSync(file, 0)
      try {
        expect(
          () => accessSync(file, constants.R_OK),
          'this process cannot open the file',
        ).toThrow()
        // Two calls. The first finds the connection broken and cannot open another, and the
        // second meets the client that the failed open left closed, which must refuse the call
        // itself and not end the process, as a closed connection used through the native
        // binding would. The binding gives the error no code, so its type is all that is held.
        for (const attempt of ['first', 'second']) {
          const unopened = await outcome(victim.batch('read', [count], 'read'))
          expect(unopened, attempt).toMatchObject({ name: 'StoreUnavailableError' })
          expect(unopened, attempt).not.toMatchObject(BUSY)
        }
      } finally {
        chmodSync(file, 0o644)
      }
      expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
      expect({ ...(await connectionPragmas(victim)), ids: await ids(victim) }).toEqual({
        busyTimeout: 5000,
        journalMode: 'wal',
        ids: [2],
      })
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
      await systemClock().yieldTurn()
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
    expect(await outcome(victim.batch('write', [insert(1)]))).toBe('answered')
    expect(await outcome(victim.batch('write', [insert(2), insert(1)]))).toMatchObject({
      name: 'PermanentStoreError',
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    })
    // The lowered wait is still there, so this is the connection the batch failed on.
    expect({ busyTimeout: await readBack(victim, 'busy_timeout'), ids: await ids(victim) }).toEqual(
      {
        busyTimeout: LOWERED_WAIT_MS,
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
  holdTheWriteLock()

  it('still leaves a statement whose step failed busy in progress on its connection', async () => {
    const raw = createClient({ url })
    try {
      await raw.execute(shorten)
      expect(await outcome(raw.batch([insert(1)], 'write'))).toMatchObject({ code: 'SQLITE_BUSY' })
      expect(
        await outcome(raw.batch([count], 'read')),
        'The client library now finishes a statement whose step failed busy, so a read behind a failed write is answered on the same client. BUILD.md, under PR3.15, says what to delete from LibsqlExecutor, this canary included.',
      ).toMatchObject({
        code: 'SQLITE_BUSY',
        message: expect.stringContaining('SQL statements in progress'),
      })
    } finally {
      raw.close()
    }
  })
})
