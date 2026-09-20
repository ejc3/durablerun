import { PermanentStoreError, StoreUnavailableError } from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlExecutor } from '../src/index.js'

/**
 * Executor contract tests (prevention suite): the SqlResult normalizations
 * exist because backends diverge — the local client hardcodes rowsAffected=0
 * for DML…RETURNING and returns blobs as ArrayBuffer. Fence checks and blob
 * consumers rely on the normalized contract, so it is pinned here and (Phase
 * C) re-run against remote Turso.
 */

let db: LibsqlExecutor

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  await db.batch('setup', [
    { sql: `CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, b BLOB)`, args: [] },
    { sql: `INSERT INTO t (id, v) VALUES (1, 10), (2, 20)`, args: [] },
  ])
})

afterEach(() => {
  db.close()
})

describe('rowsAffected contract', () => {
  it('plain UPDATE reports the affected-row count', async () => {
    const [r] = await db.batch('t', [{ sql: `UPDATE t SET v = v + 1`, args: [] }])
    expect(r?.rowsAffected).toBe(2)
  })

  it('UPDATE…RETURNING reports rows.length (the local client natively lies)', async () => {
    const [r] = await db.batch('t', [
      { sql: `UPDATE t SET v = v + 1 WHERE id = 1 RETURNING id, v`, args: [] },
    ])
    expect(r?.rows).toHaveLength(1)
    expect(r?.rowsAffected).toBe(1)
  })

  it('a zero-match UPDATE…RETURNING reports 0 — the fence-lost signal', async () => {
    const [r] = await db.batch('t', [
      { sql: `UPDATE t SET v = 0 WHERE id = 99 RETURNING id`, args: [] },
    ])
    expect(r?.rowsAffected).toBe(0)
  })

  it('SELECT reports rows.length', async () => {
    const [r] = await db.batch('t', [{ sql: `SELECT * FROM t`, args: [] }], 'read')
    expect(r?.rowsAffected).toBe(2)
  })
})

describe('value normalization', () => {
  it('blobs round-trip as Uint8Array, never ArrayBuffer', async () => {
    const payload = new Uint8Array([1, 2, 3, 255])
    await db.batch('t', [{ sql: `UPDATE t SET b = ? WHERE id = 1`, args: [payload] }])
    const [r] = await db.batch('t', [{ sql: `SELECT b FROM t WHERE id = 1`, args: [] }], 'read')
    const value = r?.rows[0]?.b
    expect(value).toBeInstanceOf(Uint8Array)
    expect([...(value as Uint8Array)]).toEqual([1, 2, 3, 255])
  })
})

describe('error typing, by the result code and never by the message', () => {
  const kindOf = (error: unknown) =>
    error instanceof PermanentStoreError
      ? 'permanent'
      : error instanceof StoreUnavailableError
        ? 'outage'
        : String(error)
  const thrownBy = (sql: string) =>
    db.batch('typed', [{ sql, args: [] }]).then(
      () => 'answered',
      (error: unknown) => ({
        kind: kindOf(error),
        code: ((error as Error).cause as { code?: unknown } | undefined)?.code,
      }),
    )

  it('types a broken constraint and a datatype mismatch permanent, and every other code an outage', async () => {
    await db.batch('setup', [
      {
        sql: `CREATE TABLE strict (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER CHECK (n < 10))`,
        args: [],
      },
      { sql: `INSERT INTO strict VALUES (1, 'a', 1)`, args: [] },
    ])
    expect(
      {
        primaryKey: await thrownBy(`INSERT INTO strict VALUES (1, 'b', 1)`),
        unique: await thrownBy(`INSERT INTO strict VALUES (2, 'a', 1)`),
        notNull: await thrownBy(`INSERT INTO strict VALUES (3, NULL, 1)`),
        check: await thrownBy(`INSERT INTO strict VALUES (4, 'd', 99)`),
        mismatch: await thrownBy(`INSERT INTO strict VALUES ('not a rowid', 'e', 1)`),
        // SQLite's generic code. It also names a transaction state error that a new
        // connection cures, so a syntax error cannot be told from one by its code.
        syntax: await thrownBy(`SELEC 1`),
      },
      'mutation-verdict:behavior:libsql-permanent-result-code-is-typed',
    ).toEqual({
      primaryKey: { kind: 'permanent', code: 'SQLITE_CONSTRAINT_PRIMARYKEY' },
      unique: { kind: 'permanent', code: 'SQLITE_CONSTRAINT_UNIQUE' },
      notNull: { kind: 'permanent', code: 'SQLITE_CONSTRAINT_NOTNULL' },
      check: { kind: 'permanent', code: 'SQLITE_CONSTRAINT_CHECK' },
      mismatch: { kind: 'permanent', code: 'SQLITE_MISMATCH' },
      syntax: { kind: 'outage', code: 'SQLITE_ERROR' },
    })
  })

  it('types a batch on a closed client an outage', async () => {
    const closed = LibsqlExecutor.open(':memory:')
    closed.close()
    const refusal = await closed
      .batch('typed', [{ sql: `SELECT 1`, args: [] }], 'read')
      .catch((error: unknown) => error)
    expect(kindOf(refusal)).toBe('outage')
    expect(refusal).toMatchObject({ cause: { code: 'CLIENT_CLOSED' } })
  })
})
