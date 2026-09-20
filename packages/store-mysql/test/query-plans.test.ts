import type { SqlExecutor, SqlResult, SqlStatement } from '@durablerun/core'
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
  table: 'tasks' | 'runs',
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

describe("the claim's candidate legs on MySQL", () => {
  const RECORD_LOCKS = {
    sql: "SELECT COUNT(*) AS held FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = DATABASE() AND OBJECT_NAME = 'runs' AND LOCK_TYPE = 'RECORD'",
    args: [],
  }

  /**
   * Claim through the store, measuring the batch's first statement, which owns the legs:
   * the rows it walked, and the record locks on `runs` the batch held straight after it.
   * Both are read inside the batch's own transaction, so every gate index moves by what
   * was put ahead of it.
   */
  async function claimMeasuringTheLegs(db: TestDb, limit: number) {
    let legs = { walked: Number.NaN, locksHeld: Number.NaN }
    const measuring: SqlExecutor = {
      batch: async (label, statements, control) => {
        const [first, ...rest] = statements
        if (label !== 'claim' || first === undefined) {
          return db.raw.batch(label, statements, control)
        }
        const moved = (gate: number) => (gate === 0 ? 1 : gate + 3)
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
    // This is the plan where the limit is a small part of the `runs` table. Where it is a
    // large part, MySQL scans `runs` for the rows the statement updates and locks every
    // one of them: measured with a limit of one at five rows and fewer, and with a limit
    // of half the table at 20, 120, and 400 rows, where a quarter of the table was still
    // read by key. This case does not pin that plan.
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
    //
    // The limit is a small part of the table here too, so the statement reads the rows it
    // updates by key, and this case does not pin the scan a large limit brings either.
    const db = await openMysqlTestDb({ idNamespace: 'plan-claim-legs-small', nowMs: 1_000_000 })
    try {
      const LIMIT = 2
      const BACKLOG = 40
      const seed = await new MysqlSchedulerStore(db.raw, db.ids).spawn(Q, 'seed', '{}')
      await cloneRows(
        db,
        'tasks',
        `src.task_id = '${seed.taskId}'`,
        { task_id: "CONCAT('small-task-', seq.n)", idempotency_key: 'NULL' },
        BACKLOG - 1,
      )
      await cloneRows(
        db,
        'runs',
        `src.run_id = '${seed.runId}'`,
        {
          run_id: "CONCAT('small-run-', LPAD(seq.n, 4, '0'))",
          task_id: "CONCAT('small-task-', seq.n)",
          available_at_ms: '1000000 - seq.n',
        },
        BACKLOG - 1,
      )
      // The server counts a table in the background, some time after a load. This is that
      // count, taken now.
      await db.raw.batch('fixture:analyze', [{ sql: 'ANALYZE TABLE runs, tasks', args: [] }])
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
