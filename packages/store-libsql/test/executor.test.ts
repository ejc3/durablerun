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
