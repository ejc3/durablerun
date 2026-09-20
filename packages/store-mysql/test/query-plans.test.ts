import {
  type IdSource,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  sqlBatchMode,
  systemIdSource,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { countMysqlPlaceholders } from '../src/executor.js'
import { MysqlSchedulerStore } from '../src/store.js'
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

/** Rows a statement read by walking an index or a table. A key lookup is not a walk. */
const walkedRows = (counters: SqlResult | undefined): number =>
  (counters?.rows ?? [])
    .filter((row) => row.Variable_name !== 'Handler_read_key')
    .reduce((sum, row) => sum + Number(row.Value), 0)

/** Rows the statement read by walking an index or a table, and what it returned. */
async function measured(db: TestDb, sql: string, args: SqlStatement['args']) {
  const [before, result, after] = await db.raw.batch(
    'fixture:measure',
    [READ_COUNTERS, { sql, args: [...args] }, READ_COUNTERS],
    'read',
  )
  return { rows: result?.rows ?? [], walked: walkedRows(after) - walkedRows(before) }
}

/**
 * The statements one labelled batch of a real operation sends, recorded from the store.
 * A measurement of these is a measurement of what ships, which a statement typed into
 * this file could drift from.
 */
async function shippedBatch(
  db: TestDb,
  label: string,
  act: (store: MysqlSchedulerStore) => Promise<unknown>,
): Promise<SqlStatement[]> {
  const seen: SqlStatement[] = []
  const recorder: SqlExecutor = {
    batch: (sent, statements, control) => {
      if (sent === label) seen.push(...statements)
      return db.raw.batch(sent, statements, control)
    },
  }
  await act(new MysqlSchedulerStore(recorder, db.ids))
  return seen
}

/** Copy one row of a table `count` times, with some columns replaced by SQL. */
async function cloneRows(
  db: TestDb,
  table: 'tasks' | 'runs' | 'waits',
  where: string,
  replaced: Readonly<Record<string, string>>,
  count = HISTORY,
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
            WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count})
            SELECT ${names.map((name) => replaced[name] ?? `src.\`${name}\``).join(', ')}
            FROM ${table} src CROSS JOIN seq WHERE ${where}`,
      args: [],
    },
  ])
  expect(copied?.rowsAffected).toBe(count)
}

/**
 * A queue of `count` due runs, each with a task of its own, because a task with many live
 * runs is not claimable. The longest waiting is the last: `<prefix>-run-<count - 1>`.
 */
async function seedDueRuns(db: TestDb, prefix: string, count: number) {
  const seed = await new MysqlSchedulerStore(db.raw, db.ids).spawn(Q, 'seed', '{}')
  await cloneRows(
    db,
    'tasks',
    `src.task_id = '${seed.taskId}'`,
    { task_id: `CONCAT('${prefix}-task-', seq.n)`, idempotency_key: 'NULL' },
    count - 1,
  )
  await cloneRows(
    db,
    'runs',
    `src.run_id = '${seed.runId}'`,
    {
      run_id: `CONCAT('${prefix}-run-', LPAD(seq.n, 4, '0'))`,
      task_id: `CONCAT('${prefix}-task-', seq.n)`,
      available_at_ms: '1000000 - seq.n',
    },
    count - 1,
  )
  // The server counts a table in the background, some time after a load. This is that
  // count, taken now.
  await db.raw.batch('fixture:analyze', [{ sql: 'ANALYZE TABLE runs, tasks', args: [] }])
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
      const [cancels] = await shippedBatch(db, 'sweep:scan', (sweeper) => sweeper.sweep(Q, 10))
      if (cancels === undefined) throw new Error('the sweep sent no discovery read')
      expect(cancels.sql).toContain('from `tasks` as `t`')
      expect(countMysqlPlaceholders(cancels.sql)).toBe(2)
      expect(cancels.args).toEqual([Q, 10])
      const nothingDue = await measured(db, cancels.sql, cancels.args)
      expect(nothingDue.rows).toEqual([])
      expect(nothingDue.walked, 'rows walked with nothing due').toBeLessThan(20)
    } finally {
      await db.close()
    }
  })
})

describe('the next-wake read on MySQL, which every driver tick runs', () => {
  it('seeks the earliest instant of each wake source, whatever the queue holds', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'plan-wake', nowMs: 1_000_000 })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      const spawned = await store.spawn(Q, 'waiting', '{}', { startDelaySeconds: 5 })
      const source = `src.run_id = '${spawned.runId}'`
      // A busy queue: many runs waiting, many under a lease, and as many tasks.
      await cloneRows(db, 'runs', source, {
        run_id: "CONCAT('later-', seq.n)",
        attempt: 'seq.n + 1',
        available_at_ms: '2000000 + seq.n',
      })
      await cloneRows(db, 'runs', source, {
        run_id: "CONCAT('leased-', seq.n)",
        attempt: 'seq.n + 1000',
        state: "'running'",
        claimed_by: "'worker'",
        claim_expires_at_ms: '3000000 + seq.n',
      })
      await cloneRows(db, 'tasks', `src.task_id = '${spawned.taskId}'`, {
        task_id: "CONCAT('task-', seq.n)",
        idempotency_key: 'NULL',
        cancel_at_ms: '4000000 + seq.n',
      })
      expect(await store.nextWakeAtEpochMs(Q)).toBe(1_005_000)
      const [sent] = await shippedBatch(db, 'next-wake', (driver) => driver.nextWakeAtEpochMs(Q))
      if (sent === undefined) throw new Error('next-wake sent no statement')
      expect(sent.sql.match(/FORCE INDEX/g)?.length).toBe(sent.args.length)
      const wake = await measured(db, sent.sql, sent.args)
      expect(wake.rows).toEqual([{ wake_ms: 1_005_000 }])
      expect(wake.walked, 'rows walked to find the next wake').toBeLessThan(20)
    } finally {
      await db.close()
    }
  })
})

describe('the wake a terminal batch owes the parent of its task, on MySQL', () => {
  it('finds the runs it woke by their event, beside a backlog of pending runs', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'plan-woken', nowMs: 1_000_000 })
    try {
      // The follow-ons after the wake are built inside the batch, so the batch itself is
      // measured: the counters are read as its first and last statements, in its own
      // transaction, and every gate index moves by the one statement put ahead of it.
      let walked = Number.NaN
      const measuring: SqlExecutor = {
        batch: async (label, statements, control) => {
          if (label !== 'complete') return db.raw.batch(label, statements, control)
          const shifted: SqlStatement[] = statements.map((statement) =>
            statement.skipUnlessWrote === undefined
              ? statement
              : { ...statement, skipUnlessWrote: statement.skipUnlessWrote + 1 },
          )
          const all = await db.raw.batch(label, [READ_COUNTERS, ...shifted, READ_COUNTERS], control)
          walked = walkedRows(all[all.length - 1]) - walkedRows(all[0])
          return all.slice(1, -1)
        },
      }
      const store = new MysqlSchedulerStore(measuring, db.ids)
      const parentTask = await store.spawn(Q, 'parent', '{}')
      const [parent] = await store.claim(Q, 'w-parent', { leaseSeconds: 60, limit: 1 })
      if (parent === undefined) throw new Error('the parent was not claimed')
      await store.activate(Q, parent.runId, parent.claimToken, parent.claimGen)
      const child = await store.spawn(Q, 'child', '{}', {
        childOf: {
          parentQueue: Q,
          parentTaskId: parentTask.taskId,
          runId: parent.runId,
          claimToken: parent.claimToken,
          replayKey: 'site',
        },
      })
      expect(
        await store.awaitTaskDone(
          Q,
          parentTask.taskId,
          parent.runId,
          parent.claimToken,
          'step',
          child.taskId,
          null,
        ),
      ).toEqual({ emitted: false })
      // The backlog is another task's: pending runs that were never woken, and as many
      // that other events woke. A task with many live runs is not claimable, so none of
      // them is taken by the claim below.
      const bulk = await store.spawn(Q, 'bulk', '{}')
      const source = `src.run_id = '${bulk.runId}'`
      await cloneRows(db, 'runs', source, {
        run_id: "CONCAT('backlog-', seq.n)",
        attempt: 'seq.n + 1',
        available_at_ms: '9000000 + seq.n',
      })
      await cloneRows(db, 'runs', source, {
        run_id: "CONCAT('woken-', seq.n)",
        attempt: 'seq.n + 1000',
        available_at_ms: '9000000 + seq.n',
        wake_event: "CONCAT('other-', seq.n)",
      })
      const [childRun] = await store.claim(Q, 'w-child', { leaseSeconds: 60, limit: 1 })
      expect(childRun?.taskId).toBe(child.taskId)
      if (childRun === undefined) throw new Error('the child was not claimed')
      await store.activate(Q, childRun.runId, childRun.claimToken, childRun.claimGen)
      await store.complete(Q, childRun.runId, childRun.claimToken, '"done"')
      const [woken] = await db.raw.batch(
        'fixture:read',
        [{ sql: 'SELECT state FROM runs WHERE run_id = ?', args: [parent.runId] }],
        'read',
      )
      expect(woken?.rows).toEqual([{ state: 'pending' }])
      // Measured on MySQL 8.4 beside this backlog of 800: 35 rows through the index
      // runs_woken (queue, wake_event, state), and 3,243 without it.
      expect(walked, 'rows the terminal batch walked').toBeLessThan(150)
    } finally {
      await db.close()
    }
  })
})

const RECORD_LOCKS = {
  sql: "SELECT COUNT(*) AS held, COALESCE(SUM(INDEX_NAME = 'PRIMARY'), 0) AS `rows` FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE() AND OBJECT_NAME = 'runs' AND LOCK_TYPE = 'RECORD'",
  args: [],
}

/**
 * Claim through the store, measuring the batch's first statement, which owns the legs:
 * the rows it walked, and the record locks on `runs` the batch held straight after it,
 * with how many of them are rows, which is what a lock on the primary key is. Both are
 * read inside the batch's own transaction, so every gate index moves by what was put
 * ahead of it. The server's plan for the statement is read first, when asked for, because
 * a statement explained ahead of itself walks less than one that arrives cold.
 */
async function claimMeasuringTheLegs(db: TestDb, limit: number, explained = false) {
  let legs = {
    walked: Number.NaN,
    locksHeld: Number.NaN,
    rowsLocked: Number.NaN,
    target: null as string | null,
  }
  const measuring: SqlExecutor = {
    batch: async (label, statements, control) => {
      const [first, ...rest] = statements
      if (label !== 'claim' || first === undefined) {
        return db.raw.batch(label, statements, control)
      }
      const moved = (gate: number) => (gate === 0 ? 1 : gate + 3)
      const [plan] = explained
        ? await db.raw.batch('fixture:explain', [
            { sql: `EXPLAIN ${first.sql}`, args: [...first.args] },
          ])
        : []
      const updated = plan?.rows.find((row) => row.select_type === 'UPDATE')
      const shifted: SqlStatement[] = rest.map((statement) =>
        statement.skipUnlessWrote === undefined
          ? statement
          : { ...statement, skipUnlessWrote: moved(statement.skipUnlessWrote) },
      )
      const [before, claimed, after, locks, ...followOns] = await db.raw.batch(
        label,
        [READ_COUNTERS, first, READ_COUNTERS, RECORD_LOCKS, ...shifted],
        control,
      )
      if (claimed === undefined) throw new Error('the claim batch answered with no result')
      legs = {
        walked: walkedRows(after) - walkedRows(before),
        locksHeld: Number(locks?.rows[0]?.held),
        rowsLocked: Number(locks?.rows[0]?.rows),
        target: updated === undefined ? null : `${String(updated.type)} on ${String(updated.key)}`,
      }
      return [claimed, ...followOns]
    },
  }
  const claimed = await new MysqlSchedulerStore(measuring, db.ids).claim(Q, 'worker', {
    leaseSeconds: 60,
    limit,
  })
  return { ...legs, claimed: claimed.map((run) => run.runId).sort() }
}

/** The lock waits of this database, as the server holds them at this instant. */
const LOCK_WAITS = {
  sql: `SELECT l.OBJECT_NAME AS held_table, l.INDEX_NAME AS held_index, l.LOCK_MODE AS wanted
        FROM performance_schema.data_lock_waits w
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA = DATABASE()`,
  args: [],
}
const SESSIONS_ASLEEP = {
  sql: "SELECT COUNT(*) AS asleep FROM performance_schema.threads WHERE PROCESSLIST_DB = DATABASE() AND PROCESSLIST_STATE = 'User sleep'",
  args: [],
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Claim once through an executor that holds the claim's transaction open for a second, and
 * claim again beside it. What the second claim waited for is the server's own account of
 * its lock waits, read while that claim is pending, so nothing here depends on how two
 * claimers happen to interleave.
 */
async function claimBesideAHeldClaim(db: TestDb) {
  const holding: SqlExecutor = {
    batch: async (label, statements, control) => {
      if (label !== 'claim') return db.raw.batch(label, statements, control)
      const held = [...statements, { sql: 'SELECT SLEEP(1) AS held', args: [] }]
      return (await db.raw.batch(label, held, control)).slice(0, statements.length)
    },
  }
  const settled = <T>(work: Promise<T>) =>
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
  const lease = { leaseSeconds: 60, limit: 1 }
  const holder = settled(new MysqlSchedulerStore(holding, db.ids).claim(Q, 'holder', lease))
  for (let tries = 0; ; tries++) {
    const [sessions] = await db.raw.batch('fixture:asleep', [SESSIONS_ASLEEP], 'read')
    if (Number(sessions?.rows[0]?.asleep) > 0) break
    if (tries > 400) throw new Error('the holder never reached its sleep')
    await pause(5)
  }
  let pending = true
  const second = settled(new MysqlSchedulerStore(db.raw, db.ids).claim(Q, 'second', lease)).finally(
    () => {
      pending = false
    },
  )
  const waitedFor = new Set<string>()
  while (pending) {
    const [waits] = await db.raw.batch('fixture:lock-waits', [LOCK_WAITS], 'read')
    for (const row of waits?.rows ?? []) {
      waitedFor.add(`${String(row.held_table)}.${String(row.held_index)} ${String(row.wanted)}`)
    }
    await pause(10)
  }
  const claimed = [await holder, await second].map((answer) => {
    if ('error' in answer) throw answer.error
    return answer.value.length
  })
  return { waitedFor: [...waitedFor].sort(), claimed }
}

describe("the claim's candidate legs on MySQL", () => {
  it('walks each state in claim order and stops at the limit, locking only the runs it takes, beside a backlog of due runs', async () => {
    // InnoDB locks a row when it reads it, before any sort or LIMIT, so a leg that reads
    // more than it returns locks more than it claims, and concurrent claimers skip those
    // rows. Each state is its own leg over `runs_poll`, in claim order, with its own LIMIT.
    // Measured on MySQL 8.4 beside 800 due runs and as many again that are not due or
    // belong to another queue: the compare-and-set that owns the legs walked 56 rows and
    // held 8 record locks on `runs`, an index record and a row for each of two runs in
    // each leg. A leg with no LIMIT of its own walked 3,246 rows and held 1,602 locks for
    // the same two claimed runs. Removing the index hint changed neither number here,
    // under statistics the server had not yet recalculated or under analyzed ones, so the
    // next case holds the hint.
    //
    // The statement that owns the legs reads the rows it updates by key, whatever the size
    // of the table and of the limit, which the keyed-write cases below hold.
    const db = await openMysqlTestDb({ idNamespace: 'plan-claim-legs', nowMs: 1_000_000 })
    try {
      const LIMIT = 2
      const seed = await new MysqlSchedulerStore(db.raw, db.ids).spawn(Q, 'seed', '{}')
      // A task with many live runs is not claimable, so every run of the backlog has a
      // task of its own. Due runs in both claimable states, then runs that are not due,
      // and due runs of another queue.
      for (const [prefix, replaced] of [
        ['pending', { available_at_ms: '1000000 - seq.n' }],
        ['sleeping', { state: "'sleeping'", available_at_ms: '999000 - seq.n' }],
        ['later', { available_at_ms: '2000000 + seq.n' }],
        ['elsewhere', { queue: "'elsewhere'", available_at_ms: '1' }],
      ] as const) {
        await cloneRows(db, 'tasks', `src.task_id = '${seed.taskId}'`, {
          task_id: `CONCAT('${prefix}-task-', seq.n)`,
          idempotency_key: 'NULL',
          ...('state' in replaced ? { state: replaced.state } : {}),
          ...('queue' in replaced ? { queue: replaced.queue } : {}),
        })
        await cloneRows(db, 'runs', `src.run_id = '${seed.runId}'`, {
          run_id: `CONCAT('${prefix}-run-', LPAD(seq.n, 4, '0'))`,
          task_id: `CONCAT('${prefix}-task-', seq.n)`,
          ...replaced,
        })
      }
      const legs = await claimMeasuringTheLegs(db, LIMIT)
      // The two that have waited longest, which are sleeping runs here.
      expect(legs.claimed).toEqual(['sleeping-run-0399', 'sleeping-run-0400'])
      // The batch holds at least the rows it took, so the lock table was really read. Each
      // leg may hold an index record and a row for every run up to the limit.
      expect(legs.locksHeld, 'record locks on runs held by a claim of two').toBeGreaterThan(0)
      expect(
        legs.locksHeld,
        'mutation-verdict:behavior:mysql-claim-leg-stops-at-the-limit',
      ).toBeLessThanOrEqual(2 * 2 * LIMIT)
      expect(legs.walked, `rows the legs walked beside ${2 * HISTORY} due runs`).toBeLessThan(150)
    } finally {
      await db.close()
    }
  })

  it('walks the index over a small backlog too, where the server alone would scan the table and lock every due run', async () => {
    // The legs name their index because the plan the server picks for itself moves with
    // its statistics and with the size of the table. Measured on MySQL 8.4 over a `runs`
    // table that is forty due runs of one queue, once the server has counted them: a leg
    // with no hint is a table scan and a sort, which read and locked all forty runs for a
    // claim of two, and concurrent claimers skip those rows. It walked 166 rows and held 40
    // record locks, where the leg as shipped walked 49 and held 4. With no hint the scan
    // was the plan from twelve due runs to eighty at a limit of one or two, and beside 120
    // and 400 once the limit reached five and ten. It was not the plan at eight runs, under
    // statistics the server had not yet recalculated, or where half the table belonged to
    // another queue, which is why the case beside a backlog cannot hold the hint.
    const db = await openMysqlTestDb({ idNamespace: 'plan-claim-legs-small', nowMs: 1_000_000 })
    try {
      const LIMIT = 2
      const BACKLOG = 40
      await seedDueRuns(db, 'small', BACKLOG)
      const legs = await claimMeasuringTheLegs(db, LIMIT)
      // The two that have waited longest.
      expect(legs.claimed).toEqual(['small-run-0038', 'small-run-0039'])
      expect(legs.locksHeld, 'record locks on runs held by a claim of two').toBeGreaterThan(0)
      expect(
        legs.locksHeld,
        'mutation-verdict:behavior:mysql-claim-leg-names-its-index',
      ).toBeLessThanOrEqual(2 * 2 * LIMIT)
      expect(legs.walked, `rows the legs walked beside ${BACKLOG} due runs`).toBeLessThan(100)
    } finally {
      await db.close()
    }
  })
})

/** A keyed write's table and key column: `update` or `delete`, then a required `column in (subquery)`. */
const KEYED_WRITE =
  /^(?:update|delete)\b[^`]*`(\w+)`[\s\S]*?(?<![.\w])`(\w+)` in \(\s*\(?\s*select\b/i

/** The index each keyed write should reach its target through, by table and key column. */
const KEY_OF: Readonly<Record<string, string>> = {
  'runs.run_id': 'PRIMARY',
  'runs.task_id': 'runs_task_attempt',
  'tasks.task_id': 'PRIMARY',
  'waits.run_id': 'PRIMARY',
}

describe('a keyed write on MySQL', () => {
  it('locks the runs a claim takes and no other run, over two rows, over four, and at a limit of half the table', async () => {
    // A write keyed by a subquery, `WHERE key IN (SELECT ...)`, is a join to the server,
    // and the server picks its order. Measured on MySQL 8.4: over a small `runs` table, or
    // with a limit that is a large part of the table, it read `runs` first, by a scan, and
    // the claim's update then held a lock on every run of the table, where a claimer
    // already holds the run its locking leg chose. Two claimers each waited for the
    // other's run, and InnoDB rolled one back. Every row was locked at one to five rows
    // with a limit of one, and at 20, 120, and 400 rows with a limit of half the table.
    const claims: { claimed: number; rowsLocked: number; target: string | null }[] = []
    for (const [rows, limit] of [
      [2, 1],
      [4, 1],
      [20, 10],
    ] as const) {
      const db = await openMysqlTestDb({
        idNamespace: `plan-keyed-claim-${rows}`,
        nowMs: 1_000_000,
      })
      try {
        await seedDueRuns(db, 'keyed', rows)
        const claim = await claimMeasuringTheLegs(db, limit, true)
        claims.push({
          claimed: claim.claimed.length,
          rowsLocked: claim.rowsLocked,
          target: claim.target,
        })
      } finally {
        await db.close()
      }
    }
    expect(claims.map((claim) => claim.claimed)).toEqual([1, 1, 10])
    // The plan over four rows, beside the locks it explains. It is soft so that a failure
    // shows both.
    expect
      .soft(claims[1]?.target, 'how the update reaches the runs of a four-row table')
      .toBe('eq_ref on PRIMARY')
    expect(
      claims.map((claim) => claim.rowsLocked),
      'mutation-verdict:behavior:mysql-keyed-write-reads-its-target-last',
    ).toEqual([1, 1, 10])
  })

  it('reaches its target through its key in every keyed write a small database sends', async () => {
    // The class, and not the claim alone: every update or delete the store keys by a
    // subquery. Each is explained inside its own batch, just ahead of itself, over the few
    // rows a new database holds, which is where the server would sooner read the target
    // first. Measured as shipped over such a database: 16 of 165 keyed writes did not take
    // their key, in claim, complete, emit-event, and cancel-task, and an emit held a lock
    // on four runs to write one.
    const db = await openMysqlTestDb({ idNamespace: 'plan-keyed-class', nowMs: 1_000_000 })
    try {
      const seen: { write: string; key: string; target: string; warnings: string[] }[] = []
      const explaining: SqlExecutor = {
        batch: async (label, statements, control) => {
          if (sqlBatchMode(control) === 'read') return db.raw.batch(label, statements, control)
          const sent: SqlStatement[] = []
          const at: number[] = []
          const explained: { i: number; table: string; key: string; explainAt: number }[] = []
          statements.forEach((statement, i) => {
            const keyed = KEYED_WRITE.exec(statement.sql)
            if (keyed !== null) {
              explained.push({
                i,
                table: String(keyed[1]),
                key: String(keyed[2]),
                explainAt: sent.length,
              })
              sent.push(
                { sql: `EXPLAIN ${statement.sql}`, args: statement.args },
                { sql: 'SHOW WARNINGS', args: [] },
              )
            }
            at[i] = sent.length
            const gate =
              statement.skipUnlessWrote === undefined ? undefined : at[statement.skipUnlessWrote]
            sent.push(gate === undefined ? statement : { ...statement, skipUnlessWrote: gate })
          })
          const all = await db.raw.batch(label, sent, control)
          for (const { i, table, key, explainAt } of explained) {
            const target = all[explainAt]?.rows.find((row) => row.table === table)
            seen.push({
              write: `${label}[${i}] ${table}`,
              key: `${table}.${key}`,
              // A target the server read ahead of the statement has no row of its own.
              target: target === undefined ? 'read ahead' : `${target.type} on ${target.key}`,
              // 1003 is the rewritten statement, and 1276 a correlated reference resolved.
              warnings: (all[explainAt + 1]?.rows ?? [])
                .filter((warning) => ![1003, 1276].includes(Number(warning.Code)))
                .map((warning) => `${warning.Code} ${warning.Message}`),
            })
          }
          return statements.map((_statement, i) => {
            const result = all[at[i] ?? -1]
            if (result === undefined) throw new Error(`${label}: statement ${i} has no result`)
            return result
          })
        },
      }
      const store = new MysqlSchedulerStore(explaining, db.ids)
      const waiter = await store.spawn(Q, 'waiter', '{}')
      const job = await store.spawn(Q, 'job', '{}')
      const victim = await store.spawn(Q, 'victim', '{}')
      const claimed = await store.claim(Q, 'worker', { leaseSeconds: 60, limit: 3 })
      const runOf = (taskId: string) => {
        const run = claimed.find((candidate) => candidate.taskId === taskId)
        if (run === undefined) throw new Error(`${taskId} was not claimed`)
        return run
      }
      for (const run of claimed) await store.activate(Q, run.runId, run.claimToken, run.claimGen)
      const waiting = runOf(waiter.taskId)
      await store.awaitEvent(Q, waiter.taskId, waiting.runId, waiting.claimToken, 'step', 'go', 60)
      await store.emitEvent(Q, 'go', '{}')
      await store.complete(Q, runOf(job.taskId).runId, runOf(job.taskId).claimToken, '{}')
      await store.cancelTask(Q, victim.taskId)
      const [woken] = await store.claim(Q, 'worker', { leaseSeconds: 60, limit: 3 })
      if (woken === undefined) throw new Error('the woken run was not claimed')
      await store.activate(Q, woken.runId, woken.claimToken, woken.claimGen)
      await store.fail(Q, woken.runId, woken.claimToken, '{}', null)

      // The matcher saw every kind of keyed write, so an empty list below means something.
      expect([...new Set(seen.map((write) => write.key))].sort()).toEqual(
        Object.keys(KEY_OF).sort(),
      )
      const keyed = (write: (typeof seen)[number]) =>
        write.target === 'read ahead' ||
        ['const', 'eq_ref', 'ref'].some(
          (type) => write.target === `${type} on ${KEY_OF[write.key]}`,
        )
      expect(
        seen.filter((write) => !keyed(write)).map((write) => `${write.write}: ${write.target}`),
        'mutation-verdict:behavior:mysql-keyed-write-takes-its-key',
      ).toEqual([])
      expect(seen.flatMap((write) => write.warnings)).toEqual([])
    } finally {
      await db.close()
    }
  })

  it('lets a second claimer take its run beside a claim still open, waiting for no lock, beside an empty waits table and beside parked waiters', async () => {
    // A DELETE reads its subquery's table with shared locks, even under READ COMMITTED,
    // where a single-table UPDATE reads it with none. The claim deletes the expired waits
    // of the runs it took, and finds those runs by their stamp. Read through `runs_poll`,
    // that search covers every running run of the queue, and another claimer's run is one
    // its transaction still holds, so the second claimer waits for the first, and two that
    // wait for each other deadlock. Measured on MySQL 8.4 with the first claim held open:
    // before any of this the second claimer waited for `runs.PRIMARY`, because the claim's
    // own UPDATE scanned a four-row table and the holder held every row, and it took none
    // of three due runs. With that UPDATE keyed it waited for a shared lock on `runs_poll`
    // in both arrangements, as the unkeyed statements also did beside the parked waiters.
    // Read through the index of the stamp, the search finds this transaction's own entries
    // and no other, and the second claimer took its run in about 20 ms with no wait.
    const arrangements: Awaited<ReturnType<typeof claimBesideAHeldClaim>>[] = []
    for (const [due, parked] of [
      [4, 0],
      [40, 200],
    ] as const) {
      const db = await openMysqlTestDb({ idNamespace: `plan-held-${due}`, nowMs: 1_000_000 })
      try {
        const store = new MysqlSchedulerStore(db.raw, db.ids)
        if (parked > 0) {
          const waiter = await store.spawn(Q, 'waiter', '{}')
          const [run] = await store.claim(Q, 'parker', { leaseSeconds: 60, limit: 1 })
          if (run === undefined) throw new Error('the waiter was not claimed')
          await store.activate(Q, run.runId, run.claimToken, run.claimGen)
          await store.awaitEvent(Q, waiter.taskId, run.runId, run.claimToken, 'step', 'never', 3600)
          await cloneRows(
            db,
            'waits',
            "src.step_name = 'step'",
            { step_name: "CONCAT('step-', seq.n)" },
            parked - 1,
          )
        }
        for (let i = 0; i < due; i++) await store.spawn(Q, `job-${i}`, '{}')
        await db.raw.batch('fixture:analyze', [
          { sql: 'ANALYZE TABLE runs, tasks, waits', args: [] },
        ])
        arrangements.push(await claimBesideAHeldClaim(db))
      } finally {
        await db.close()
      }
    }
    expect(
      arrangements.map((arrangement) => arrangement.waitedFor),
      'mutation-verdict:behavior:mysql-keyed-delete-reads-its-keys-by-their-stamp',
    ).toEqual([[], []])
    expect(arrangements.map((arrangement) => arrangement.claimed)).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it("indexes a run's statement stamp by a prefix that holds what tells one call's stamp from another's", async () => {
    // The stamp is a LONGTEXT, so its index is a prefix. A call's stamp is the call's
    // token and the name of a fence, and the token is what differs between calls. While
    // the token lies inside the prefix, the entries of two calls never share a key, so a
    // search of the index for one call's stamp touches no entry of another's.
    const db = await openMysqlTestDb({ idNamespace: 'plan-stamp-index', nowMs: 1_000_000 })
    try {
      const [index] = await db.raw.batch(
        'fixture:index',
        [
          {
            sql: `SELECT COLUMN_NAME AS indexed, SUB_PART AS prefix FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = 'runs' AND index_name = 'runs_stamp'
                  ORDER BY SEQ_IN_INDEX`,
            args: [],
          },
        ],
        'read',
      )
      expect((index?.rows ?? []).map((row) => String(row.indexed))).toEqual(['fence_stamp'])
      const prefix = Number(index?.rows[0]?.prefix)
      const token = systemIdSource().token()
      const ids: IdSource = { ...db.ids, token: () => token }
      await new MysqlSchedulerStore(db.raw, db.ids).spawn(Q, 'one', '{}')
      const sent: SqlStatement[] = []
      const recorder: SqlExecutor = {
        batch: (label, statements, control) => {
          if (label === 'claim') sent.push(...statements)
          return db.raw.batch(label, statements, control)
        },
      }
      await new MysqlSchedulerStore(recorder, ids).claim(Q, 'worker', {
        leaseSeconds: 60,
        limit: 1,
      })
      const stamps = [
        ...new Set(
          sent
            .flatMap((statement) => statement.args)
            .filter((arg): arg is string => typeof arg === 'string' && arg !== token)
            .filter((arg) => arg.includes(token)),
        ),
      ]
      expect(stamps.length).toBeGreaterThan(0)
      expect(
        stamps.map((stamp) => stamp.indexOf(token) + token.length <= prefix),
        'mutation-verdict:behavior:mysql-stamp-index-holds-the-token',
      ).toEqual(stamps.map(() => true))
    } finally {
      await db.close()
    }
  })
})

describe('the hot path beside a history of tasks, on MySQL', () => {
  it('claims, activates, and completes without walking the tasks of the database', async () => {
    // On libSQL the generated task follow-ons scanned `tasks` until their call sites
    // bound the queue, because SQLite cannot drive a write from a correlated subquery.
    // MySQL was keyed before that change and is keyed after it: measured on MySQL 8.4
    // beside 4,000 tasks, claim walked 54 rows, activate 14, and complete 27, with the
    // queue unbound. An EXPLAIN over empty tables says nothing, so the tables hold a
    // history, and every write batch is measured from inside its own transaction.
    const db = await openMysqlTestDb({ idNamespace: 'plan-hot-path', nowMs: 1_000_000 })
    try {
      const walked = new Map<string, number>()
      const measuring: SqlExecutor = {
        batch: async (label, statements, control) => {
          const mode = typeof control === 'string' ? control : (control?.mode ?? 'write')
          if (mode === 'read') return db.raw.batch(label, statements, control)
          const shifted: SqlStatement[] = statements.map((statement) =>
            statement.skipUnlessWrote === undefined
              ? statement
              : { ...statement, skipUnlessWrote: statement.skipUnlessWrote + 1 },
          )
          const all = await db.raw.batch(label, [READ_COUNTERS, ...shifted, READ_COUNTERS], control)
          walked.set(label, walkedRows(all[all.length - 1]) - walkedRows(all[0]))
          return all.slice(1, -1)
        },
      }
      const seed = await new MysqlSchedulerStore(db.raw, db.ids).spawn('history', 'old', '{}')
      for (const [prefix, queue] of [
        ['a', Q],
        ['b', Q],
        ['c', Q],
        ['d', 'elsewhere'],
        ['e', 'elsewhere'],
      ]) {
        await cloneRows(db, 'tasks', `src.task_id = '${seed.taskId}'`, {
          task_id: `CONCAT('old-${prefix}-', seq.n)`,
          queue: `'${queue}'`,
          state: "'completed'",
          idempotency_key: 'NULL',
        })
      }
      const store = new MysqlSchedulerStore(measuring, db.ids)
      await store.spawn(Q, 'job', '{}')
      const [run] = await store.claim(Q, 'worker', { leaseSeconds: 60, limit: 1 })
      if (run === undefined) throw new Error('the job was not claimed')
      await store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await store.complete(Q, run.runId, run.claimToken, '{}')
      const hot = ['claim', 'activate', 'complete'].map((label) => [label, walked.get(label)])
      for (const [label, rows] of hot) {
        expect(rows, `rows ${String(label)} walked beside ${5 * HISTORY} tasks`).toBeLessThan(150)
      }
    } finally {
      await db.close()
    }
  })
})

describe('the saga batches beside a history of tasks, on MySQL', () => {
  it('enters the rolling-back phase, and fails a rollback, without walking the tasks of the database', async () => {
    // A failure that enters the phase places the pass, writes the marker, and moves the
    // task, and a failed rollback does the same behind its attempt record. Each reaches
    // `tasks` and `runs` by key, and reads the task's own checkpoints, which are few.
    const db = await openMysqlTestDb({ idNamespace: 'plan-sagas', nowMs: 1_000_000 })
    try {
      const walked = new Map<string, number>()
      const measuring: SqlExecutor = {
        batch: async (label, statements, control) => {
          const mode = typeof control === 'string' ? control : (control?.mode ?? 'write')
          if (mode === 'read') return db.raw.batch(label, statements, control)
          const shifted: SqlStatement[] = statements.map((statement) =>
            statement.skipUnlessWrote === undefined
              ? statement
              : { ...statement, skipUnlessWrote: statement.skipUnlessWrote + 1 },
          )
          const all = await db.raw.batch(label, [READ_COUNTERS, ...shifted, READ_COUNTERS], control)
          walked.set(label, walkedRows(all[all.length - 1]) - walkedRows(all[0]))
          return all.slice(1, -1)
        },
      }
      const seed = await new MysqlSchedulerStore(db.raw, db.ids).spawn('history', 'old', '{}')
      for (const prefix of ['a', 'b', 'c', 'd', 'e']) {
        await cloneRows(db, 'tasks', `src.task_id = '${seed.taskId}'`, {
          task_id: `CONCAT('old-${prefix}-', seq.n)`,
          queue: `'${Q}'`,
          state: "'completed'",
          idempotency_key: 'NULL',
        })
      }
      const store = new MysqlSchedulerStore(measuring, db.ids)
      const task = await store.spawn(Q, 'job', '{}', { maxAttempts: 1 })
      const [run] = await store.claim(Q, 'forward', { leaseSeconds: 60, limit: 1 })
      if (run === undefined) throw new Error('the job was not claimed')
      await store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await store.setCheckpoint(
        Q,
        task.taskId,
        run.runId,
        run.claimToken,
        '$started:charge',
        '0',
        60,
      )
      expect(await store.fail(Q, run.runId, run.claimToken, '{}', null)).toEqual({
        rollingBack: true,
      })
      const [pass] = await store.claim(Q, 'pass', { leaseSeconds: 60, limit: 1 })
      if (pass === undefined) throw new Error('the rollback pass was not claimed')
      await store.activate(Q, pass.runId, pass.claimToken, pass.claimGen)
      expect(
        await store.failRollback(
          Q,
          pass.runId,
          pass.claimToken,
          '{}',
          { delaySeconds: 5 },
          {
            key: '$rollback-tries:charge',
            stateJson: '{"tries":1,"errorJson":"{}"}',
          },
        ),
      ).toEqual({ rollingBack: true })
      for (const label of ['set-checkpoint', 'fail', 'fail-rollback']) {
        expect(walked.get(label), `rows ${label} walked beside ${5 * HISTORY} tasks`).toBeLessThan(
          150,
        )
      }
    } finally {
      await db.close()
    }
  })
})
