import { mkdtempSync, rmSync } from 'node:fs'
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
 * and the write batch fails with SQLITE_BUSY.
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

let dir: string
let url: string
let victim: LibsqlExecutor
let holderClient: Client
let holder: Transaction

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'durablerun-failed-batch-'))
  url = `file:${join(dir, 'db.sqlite')}`
  victim = LibsqlExecutor.open(url)
  await victim.batch('setup', [{ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)', args: [] }])
  await victim.batch('shorten', [{ sql: 'PRAGMA busy_timeout=100', args: [] }], 'read')
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
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject({
      name: 'StoreUnavailableError',
      code: 'SQLITE_BUSY',
    })
    expect(await outcome(victim.batch('read', [count], 'read'))).toBe('answered')
  })

  it('is an outage, and the next write on its executor is answered once the lock is free', async () => {
    expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject({
      name: 'StoreUnavailableError',
      code: 'SQLITE_BUSY',
    })
    await holder.rollback()
    expect(await outcome(victim.batch('write', [insert(2)]))).toBe('answered')
    const [rows] = await victim.batch('read', [{ sql: 'SELECT id FROM t', args: [] }], 'read')
    expect(rows?.rows).toEqual([{ id: 2 }])
  })

  it('leaves a third executor answering reads, while the lock is held and after it is free', async () => {
    const third = LibsqlExecutor.open(url)
    try {
      expect(await outcome(victim.batch('write', [insert(1)]))).toMatchObject({
        name: 'StoreUnavailableError',
        code: 'SQLITE_BUSY',
      })
      expect(await outcome(third.batch('read', [count], 'read'))).toBe('answered')
      await holder.rollback()
      expect(await outcome(third.batch('write', [insert(3)]))).toBe('answered')
    } finally {
      third.close()
    }
  })
})
