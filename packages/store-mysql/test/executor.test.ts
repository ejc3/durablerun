import type { FieldPacket, Pool } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'

const OK = [{ affectedRows: 0, info: '' }, undefined] as const
const rows = (values: Record<string, unknown>[], name: string) =>
  [values, [{ name, columnType: 253 } as unknown as FieldPacket]] as const

/** A connection that records what it is sent and answers what a server would. */
class FakeConnection {
  readonly sent: string[] = []
  released = 0

  async query(sql: string) {
    this.sent.push(sql)
    return sql.startsWith('SELECT') ? rows([{ value: '5' }], 'value') : OK
  }

  async execute(sql: string) {
    this.sent.push(sql)
    return sql.includes('GET_LOCK') ? rows([{ acquired: 1 }], 'acquired') : OK
  }

  release() {
    this.released += 1
  }

  destroy() {}
}

function executorOver(connection: FakeConnection): MysqlExecutor {
  const pool = { getConnection: async () => connection, end: async () => undefined }
  return MysqlExecutor.fromPool(pool as unknown as Pool)
}

/** What a batch sent after the session settings every new connection gets first. */
const afterSessionSetup = (connection: FakeConnection) =>
  connection.sent.filter((sql) => !sql.startsWith('SET SESSION'))

describe('MysqlExecutor transactions', () => {
  it('reads the schema version under READ COMMITTED, with no snapshot taken ahead of the statement', async () => {
    const connection = new FakeConnection()
    const results = await executorOver(connection).batch(
      'migrate:version',
      [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
      'read',
    )
    expect(results).toEqual([{ rows: [{ value: '5' }], rowsAffected: 1 }])
    expect(
      afterSessionSetup(connection),
      'mutation-verdict:construction:mysql-version-read-is-read-committed',
    ).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'START TRANSACTION READ ONLY',
      SCHEMA_VERSION_READ_SQL,
      'COMMIT',
    ])
    expect(connection.released).toBe(1)
  })

  it('gives every other read batch one consistent read-only snapshot', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'next-wake',
      [{ sql: 'SELECT 1 AS value', args: [] }],
      'read',
    )
    expect(afterSessionSetup(connection)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      'SELECT 1 AS value',
      'COMMIT',
    ])
  })

  it('holds the migration lock from before a migration transaction until after it', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch('migrate:v1', [
      { sql: 'CREATE TABLE IF NOT EXISTS t (a INT)', args: [] },
    ])
    const sent = afterSessionSetup(connection)
    expect(
      sent.map((sql) =>
        sql.includes('GET_LOCK') ? 'lock' : sql.includes('RELEASE_LOCK') ? 'unlock' : sql,
      ),
    ).toEqual([
      'lock',
      'START TRANSACTION',
      'CREATE TABLE IF NOT EXISTS t (a INT)',
      'COMMIT',
      'unlock',
    ])
  })

  it('takes no lock for the version read', async () => {
    const connection = new FakeConnection()
    await executorOver(connection).batch(
      'migrate:version',
      [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }],
      'read',
    )
    expect(connection.sent.some((sql) => sql.includes('GET_LOCK'))).toBe(false)
  })
})
