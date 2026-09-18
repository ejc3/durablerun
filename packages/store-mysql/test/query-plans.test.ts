import { describe, expect, it } from 'vitest'
import { countMysqlPlaceholders } from '../src/executor.js'
import { MysqlSchedulerStore, SWEEP_SCAN_CANCELS_SQL } from '../src/store.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * What the hot reads cost on a MySQL server, measured and never estimated: the rows a
 * statement read, from the session's own handler counters, around the EXACT production
 * SQL. An EXPLAIN is the optimizer's guess over statistics a test database does not have.
 * These cases need a server, as real-server.test.ts does, and are never conditional.
 */

const Q = 'plans'
const HISTORY = 400
const READ_COUNTERS = {
  sql: "SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_first', 'Handler_read_key', 'Handler_read_next', 'Handler_read_rnd_next')",
  args: [],
}

type TestDb = Awaited<ReturnType<typeof openMysqlTestDb>>

/** Rows the statement read by walking an index or a table, and what it returned. */
async function measured(db: TestDb, sql: string, args: readonly (string | number)[]) {
  const [before, result, after] = await db.raw.batch(
    'fixture:measure',
    [READ_COUNTERS, { sql, args: [...args] }, READ_COUNTERS],
    'read',
  )
  const walked = (rows: typeof before) =>
    (rows?.rows ?? [])
      .filter((row) => row.Variable_name !== 'Handler_read_key')
      .reduce((sum, row) => sum + Number(row.Value), 0)
  return { rows: result?.rows ?? [], walked: walked(after) - walked(before) }
}

/** Copy one row of a table `HISTORY` times, with some columns replaced by SQL. */
async function cloneRows(
  db: TestDb,
  table: 'tasks' | 'runs',
  where: string,
  replaced: Readonly<Record<string, string>>,
) {
  const [columns] = await db.raw.batch(
    'fixture:columns',
    [
      {
        sql: `SELECT COLUMN_NAME AS name FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`,
        args: [table],
      },
    ],
    'read',
  )
  const names = (columns?.rows ?? []).map((row) => String(row.name))
  expect(names.length).toBeGreaterThan(3)
  const [copied] = await db.raw.batch('fixture:clone', [
    {
      sql: `INSERT INTO ${table} (${names.map((name) => `\`${name}\``).join(', ')})
            WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY})
            SELECT ${names.map((name) => replaced[name] ?? `src.\`${name}\``).join(', ')}
            FROM ${table} src CROSS JOIN seq WHERE ${where}`,
      args: [],
    },
  ])
  expect(copied?.rowsAffected).toBe(HISTORY)
}

describe('production sweep scans on MySQL (exact shipped SQL)', () => {
  it('the cancel scan does not walk the dead tasks whose deadline has passed', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'plan-cancel', nowMs: 1_000_000 })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      const live = await store.spawn(Q, 'live', '{}', {
        cancellation: { maxDelaySeconds: 3600 },
      })
      // Only completion and cancellation clear a deadline. A failed task keeps its own,
      // so the history of a queue is dead tasks with a deadline in the past.
      await cloneRows(db, 'tasks', `src.task_id = '${live.taskId}'`, {
        task_id: "CONCAT('dead-', seq.n)",
        state: "'failed'",
        cancel_at_ms: '1',
        idempotency_key: 'NULL',
      })
      const binds = countMysqlPlaceholders(SWEEP_SCAN_CANCELS_SQL)
      expect(binds).toBe(2)
      const nothingDue = await measured(db, SWEEP_SCAN_CANCELS_SQL, [Q, 10])
      expect(nothingDue.rows).toEqual([])
      expect(nothingDue.walked, 'rows walked with nothing due').toBeLessThan(20)
    } finally {
      await db.close()
    }
  })
})
