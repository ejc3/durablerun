import { LibsqlExecutor, LibsqlSchedulerStore, MIGRATIONS } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'
import { refusalName } from '../src/scenario.js'

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
 * no registration left for a later delivery to recover. Nothing in this repo
 * could have caught it. The fault matrix varies faults, states and labels;
 * the conformance suite always starts from a freshly migrated database.
 * Schema version was a dimension nothing varied.
 *
 * This is that dimension. The column list is DERIVED from MIGRATIONS, so a
 * future migration that adds one enrols automatically and cannot ship without
 * an answer here.
 */

const Q = 'q'
const NOW = 1_000_000

type Migration = { version: number; statements: readonly string[] }

async function schemaColumns(db: LibsqlExecutor): Promise<Map<string, Set<string>>> {
  const [result] = await db.batch(
    'legacy-schema-surface',
    [
      {
        sql: `SELECT m.name AS table_name, p.name AS column_name
              FROM sqlite_schema AS m
              JOIN pragma_table_info(m.name) AS p
              WHERE m.type = 'table'
                AND m.name NOT LIKE 'sqlite_%'
              ORDER BY m.name, p.cid`,
        args: [],
      },
    ],
    'read',
  )
  const columns = new Map<string, Set<string>>()
  for (const row of result?.rows ?? []) {
    const table = String(row.table_name)
    const column = String(row.column_name)
    const tableColumns = columns.get(table) ?? new Set<string>()
    tableColumns.add(column)
    columns.set(table, tableColumns)
  }
  return columns
}

/** Every column added by a migration to a table an earlier one created. */
async function columnsAddedAfterTheirTable(
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ table: string; column: string; version: number }[]> {
  const db = LibsqlExecutor.open(':memory:')
  const out: { table: string; column: string; version: number }[] = []
  try {
    for (const migration of migrations) {
      const before = await schemaColumns(db)
      await db.batch(
        `legacy-schema-v${migration.version}`,
        migration.statements.map((sql) => ({ sql, args: [] })),
      )
      const after = await schemaColumns(db)
      for (const [table, oldColumns] of before) {
        for (const column of after.get(table) ?? []) {
          if (!oldColumns.has(column)) out.push({ table, column, version: migration.version })
        }
      }
    }
  } finally {
    db.close()
  }
  return out
}

async function fixture() {
  const { raw, admin, ids } = await openTestDb({
    nowMs: NOW,
    idNamespace: 'legacy-rows',
  })
  return {
    raw,
    admin,
    store: new LibsqlSchedulerStore(raw, ids),
    close: async () => raw.close(),
  }
}

const ADDED = await columnsAddedAfterTheirTable()

async function ambiguousLegacyWait(timeoutSeconds: number | null) {
  const f = await fixture()
  const spawned = await f.store.spawn(Q, 'job', '{}')
  const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('expected a claim')
  await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)

  const currentStep = '$await:z-current'
  const staleStep = '$await:a-stale'
  await f.store.awaitEvent(
    Q,
    spawned.taskId,
    run.runId,
    run.claimToken,
    currentStep,
    'go',
    timeoutSeconds,
  )
  await f.raw.batch('legacy-ambiguous-wait', [
    { sql: `UPDATE runs SET wake_step = NULL WHERE run_id = ?`, args: [run.runId] },
    {
      sql: `INSERT INTO waits
              (run_id, step_name, queue, task_id, event_name, status,
               timeout_at_ms, created_at_ms)
            SELECT run_id, ?, queue, task_id, event_name, status,
                   timeout_at_ms, created_at_ms
            FROM waits WHERE run_id = ? AND step_name = ?`,
      args: [staleStep, run.runId, currentStep],
    },
  ])
  return { ...f, run, currentStep, staleStep }
}

describe('rows written before a column existed', () => {
  it('discovers added columns from SQL formatting it did not anticipate', async () => {
    expect(
      await columnsAddedAfterTheirTable([
        { version: 1, statements: [`CREATE TABLE runs (run_id TEXT)`] },
        { version: 2, statements: [`alter table runs\n  add column wake_kind TEXT`] },
      ]),
    ).toEqual([{ table: 'runs', column: 'wake_kind', version: 2 }])
  })

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
      await f.close()
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
      await f.close()
    })

    it(`a timed wake still decodes when ${table}.${column} is NULL (pre-v${version})`, async () => {
      const f = await fixture()
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected a claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      const step = '$await:go#2'
      await f.store.awaitEvent(Q, spawned.taskId, run.runId, run.claimToken, step, 'go', 30)

      // The wait row is the only pre-v3 record of the exact await step. Claim
      // must carry it into the run before consuming that row.
      await f.raw.batch('legacy', [{ sql: `UPDATE ${table} SET ${column} = NULL`, args: [] }])
      await f.admin.setFakeNowEpochMs(NOW + 30_000)
      const [woken] = await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 })

      expect(woken?.wake, 'mutation-verdict:behavior:legacy-wait-step-backfill').toEqual({
        event: 'go',
        step,
        timedOut: true,
      })
      const [waits] = await f.raw.batch(
        't',
        [{ sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: [run.runId] }],
        'read',
      )
      expect(Number(waits?.rows[0]?.n)).toBe(0)
      expect(await engineInvariantViolations(f.raw)).toEqual([])
      await f.close()
    })
  }
})

describe('ambiguous legacy wait registrations', () => {
  it('does not choose a timed wait step when several registrations match', async () => {
    const f = await ambiguousLegacyWait(30)
    await f.admin.setFakeNowEpochMs(NOW + 30_000)

    expect(
      await f.store.claim(Q, 'w2', { leaseSeconds: 60, limit: 1 }),
      'mutation-verdict:behavior:legacy-wait-claim-cardinality',
    ).toEqual([])

    const [run] = await f.raw.batch(
      't',
      [{ sql: `SELECT state, wake_step FROM runs WHERE run_id = ?`, args: [f.run.runId] }],
      'read',
    )
    expect(run?.rows[0]).toMatchObject({ state: 'sleeping', wake_step: null })
    const [waits] = await f.raw.batch(
      't',
      [
        {
          sql: `SELECT step_name FROM waits WHERE run_id = ? ORDER BY step_name`,
          args: [f.run.runId],
        },
      ],
      'read',
    )
    expect(waits?.rows).toEqual([{ step_name: f.staleStep }, { step_name: f.currentStep }])
    await f.close()
  })

  it('does not recover a legacy step from a foreign-owned registration', async () => {
    const f = await ambiguousLegacyWait(null)
    await f.raw.batch('legacy-foreign-wait', [
      {
        sql: `DELETE FROM waits WHERE run_id = ? AND step_name = ?`,
        args: [f.run.runId, f.staleStep],
      },
      {
        sql: `UPDATE waits SET task_id = 'foreign' WHERE run_id = ? AND step_name = ?`,
        args: [f.run.runId, f.currentStep],
      },
    ])

    await f.store.emitEvent(Q, 'go', '{"x":1}')

    const [run] = await f.raw.batch(
      't',
      [{ sql: `SELECT state, wake_step FROM runs WHERE run_id = ?`, args: [f.run.runId] }],
      'read',
    )
    expect(run?.rows[0]).toMatchObject({ state: 'sleeping', wake_step: null })
    const [waits] = await f.raw.batch(
      't',
      [{ sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: [f.run.runId] }],
      'read',
    )
    expect(Number(waits?.rows[0]?.n)).toBe(1)
    await f.close()
  })
})

/**
 * Names an older build stored before an identifier had a width.
 *
 * The width is held on the way in, at every entry of the port, so nothing rewrites a row
 * that already holds a longer name. Only libSQL and PostgreSQL can hold one: MySQL never
 * could. What that means differs by where the name is passed again. A name the engine
 * only hands back stays readable and its task finishes. A name a caller must pass to
 * reach the row, a queue above all, is refused like any other, so the row is out of the
 * port's reach until it is renamed in SQL. DESIGN.md states both, and this holds both.
 */
describe('names stored before an identifier had a width', () => {
  const LONG = 300

  it('hands a longer stored name back, and the task still finishes', async () => {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'key' })
      const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected a claim')
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await f.store.setCheckpoint(Q, spawned.taskId, run.runId, run.claimToken, 'step', '1', 60)
      const longKey = 'i'.repeat(LONG)
      const longStep = 'p'.repeat(LONG)
      await f.raw.batch('legacy-long-names', [
        {
          sql: 'UPDATE tasks SET idempotency_key = ? WHERE task_id = ?',
          args: [longKey, spawned.taskId],
        },
        {
          sql: 'UPDATE checkpoints SET checkpoint_name = ? WHERE task_id = ?',
          args: [longStep, spawned.taskId],
        },
      ])

      const read = await f.store.getCheckpoints(Q, spawned.taskId, run.attempt)
      const respawn = await refusalName(f.store.spawn(Q, 'job', '{}', { idempotencyKey: longKey }))
      const rewrite = await refusalName(
        f.store.setCheckpoint(Q, spawned.taskId, run.runId, run.claimToken, longStep, '2', 60),
      )
      await f.store.complete(Q, run.runId, run.claimToken, '"done"')
      expect({
        read: read.map((checkpoint) => [checkpoint.checkpointName, checkpoint.stateJson]),
        respawn,
        rewrite,
        result: await f.store.getTaskResult(Q, spawned.taskId),
        violations: await engineInvariantViolations(f.raw),
      }).toEqual({
        read: [[longStep, '1']],
        // The key is no longer deduplicated, because it can no longer be passed.
        respawn: 'InvalidDurableStringError',
        rewrite: 'InvalidDurableStringError',
        result: { state: 'completed', completedPayloadJson: '"done"' },
        violations: [],
      })
    } finally {
      await f.close()
    }
  })

  it('cannot reach a task in a longer stored queue, and leaves its rows as they were', async () => {
    const f = await fixture()
    try {
      const spawned = await f.store.spawn(Q, 'job', '{}')
      const longQueue = 'q'.repeat(LONG)
      await f.raw.batch('legacy-long-queue', [
        { sql: 'UPDATE tasks SET queue = ? WHERE task_id = ?', args: [longQueue, spawned.taskId] },
        { sql: 'UPDATE runs SET queue = ? WHERE task_id = ?', args: [longQueue, spawned.taskId] },
      ])
      const reached = {
        claim: await refusalName(f.store.claim(longQueue, 'w1', { leaseSeconds: 60, limit: 1 })),
        sweep: await refusalName(f.store.sweep(longQueue, 10)),
        getTaskResult: await refusalName(f.store.getTaskResult(longQueue, spawned.taskId)),
        cancelTask: await refusalName(f.store.cancelTask(longQueue, spawned.taskId)),
      }
      const [rows] = await f.raw.batch(
        'legacy-long-queue-read',
        [
          {
            sql: 'SELECT state, length(queue) AS width FROM tasks WHERE task_id = ?',
            args: [spawned.taskId],
          },
        ],
        'read',
      )
      expect({
        reached,
        row: rows?.rows.map((row) => [String(row.state), Number(row.width)]),
      }).toEqual({
        reached: {
          claim: 'InvalidDurableStringError',
          sweep: 'InvalidDurableStringError',
          getTaskResult: 'InvalidDurableStringError',
          cancelTask: 'InvalidDurableStringError',
        },
        row: [['pending', LONG]],
      })
    } finally {
      await f.close()
    }
  })
})
