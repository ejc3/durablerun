import {
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  MIGRATIONS,
} from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'

/**
 * Rows an OLDER SCHEMA VERSION wrote.
 *
 * A migration that adds a nullable column backfills nothing, so every row
 * written before it reads NULL there — forever, on every upgraded database,
 * and on every rolling deploy where an older process writes a row after a
 * newer one has migrated. Engine code written after the column exists tends
 * to assume it is populated, and a comparison against NULL is never true, so
 * the row is quietly skipped rather than loudly rejected.
 *
 * That happened: correlating an event wake on `runs.wake_step` meant a run
 * parked before that column existed could never be woken again, while the
 * same batch deleted its wait row — an untimed await stranded forever, with
 * the event immutable so re-emitting could not recover it. Nothing in this
 * repo could have caught it. The fault matrix varies faults, states and
 * labels; the conformance suite always starts from a freshly migrated
 * database. Schema version was a dimension nothing varied.
 *
 * This is that dimension. The column list is DERIVED from MIGRATIONS, so a
 * future migration that adds one enrols automatically and cannot ship without
 * an answer here.
 */

const Q = 'q'
const NOW = 1_000_000

/** Every column added by a migration to a table an earlier one created. */
function columnsAddedAfterTheirTable(): { table: string; column: string; version: number }[] {
  const out: { table: string; column: string; version: number }[] = []
  for (const m of MIGRATIONS) {
    for (const s of m.statements) {
      const match = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(s.trim())
      if (match?.[1] && match[2])
        out.push({ table: match[1], column: match[2], version: m.version })
    }
  }
  return out
}

async function fixture() {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  await admin.setFakeNowEpochMs(NOW)
  let n = 0
  return {
    raw,
    admin,
    store: new LibsqlSchedulerStore(raw, { uuidv7: () => `id-${++n}`, token: () => `tok-${n}` }),
    close: () => raw.close(),
  }
}

const ADDED = columnsAddedAfterTheirTable()

describe('rows written before a column existed', () => {
  it('finds the columns to test from the migrations themselves', () => {
    // If this is empty the suite below is vacuous, which is the failure mode
    // a generated surface is most prone to.
    expect(ADDED.length).toBeGreaterThan(0)
  })

  for (const { table, column, version } of ADDED) {
    it(`an event wake still reaches a run whose ${table}.${column} is NULL (pre-v${version})`, async () => {
      const f = await fixture()
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected a claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await f.store.awaitEvent(
        Q,
        spawned.taskId,
        run.runId,
        run.claimToken,
        '$await:go',
        'go',
        null,
      )

      // Exactly what a row written by the older schema looks like.
      await f.raw.batch('legacy', [{ sql: `UPDATE ${table} SET ${column} = NULL`, args: [] }])

      await f.store.emitEvent(Q, 'go', '{"x":1}')

      const [after] = await f.raw.batch(
        't',
        [{ sql: `SELECT state FROM runs WHERE run_id = ?`, args: [run.runId] }],
        'read',
      )
      // The run must be reachable again. A run left sleeping with its wait
      // row deleted is unreachable forever, which is the shape that shipped.
      const [waits] = await f.raw.batch(
        't',
        [{ sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: [run.runId] }],
        'read',
      )
      const stranded = after?.rows[0]?.state === 'sleeping' && Number(waits?.rows[0]?.n) === 0
      expect(
        stranded,
        `${table}.${column} NULL leaves the run asleep with no wait to wake it`,
      ).toBe(false)
      expect(await engineInvariantViolations(f.raw)).toEqual([])
      f.close()
    })

    it(`the lifecycle still completes when ${table}.${column} is NULL (pre-v${version})`, async () => {
      const f = await fixture()
      const spawned = await f.store.spawn(Q, 'job', '{}')
      await f.raw.batch('legacy', [{ sql: `UPDATE ${table} SET ${column} = NULL`, args: [] }])

      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error(`no claim with ${table}.${column} NULL`)
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await f.raw.batch('legacy', [{ sql: `UPDATE ${table} SET ${column} = NULL`, args: [] }])
      await f.store.complete(Q, run.runId, run.claimToken, '{"ok":true}')

      const result = await f.store.getTaskResult(Q, spawned.taskId)
      expect(result?.state).toBe('completed')
      expect(await engineInvariantViolations(f.raw)).toEqual([])
      f.close()
    })
  }
})
