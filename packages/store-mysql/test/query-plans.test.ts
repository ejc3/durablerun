import type { SqlExecutor, SqlStatement } from '@durablerun/core'
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

/** Rows the statement read by walking an index or a table, and what it returned. */
async function measured(db: TestDb, sql: string, args: SqlStatement['args']) {
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
          const total = (result: (typeof all)[number] | undefined) =>
            (result?.rows ?? [])
              .filter((row) => row.Variable_name !== 'Handler_read_key')
              .reduce((sum, row) => sum + Number(row.Value), 0)
          walked = total(all[all.length - 1]) - total(all[0])
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
          const total = (result: (typeof all)[number] | undefined) =>
            (result?.rows ?? [])
              .filter((row) => row.Variable_name !== 'Handler_read_key')
              .reduce((sum, row) => sum + Number(row.Value), 0)
          walked.set(label, total(all[all.length - 1]) - total(all[0]))
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
          const total = (result: (typeof all)[number] | undefined) =>
            (result?.rows ?? [])
              .filter((row) => row.Variable_name !== 'Handler_read_key')
              .reduce((sum, row) => sum + Number(row.Value), 0)
          walked.set(label, total(all[all.length - 1]) - total(all[0]))
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

/**
 * An executor that counts the rows each batch under one of `labels` walked, a read batch
 * included, from the session's handler counters around the batch.
 */
function countingRowsWalked(db: TestDb, labels: readonly string[]) {
  const walked = new Map<string, number>()
  const executor: SqlExecutor = {
    batch: async (label, statements, control) => {
      if (!labels.includes(label)) return db.raw.batch(label, statements, control)
      const shifted: SqlStatement[] = statements.map((statement) =>
        statement.skipUnlessWrote === undefined
          ? statement
          : { ...statement, skipUnlessWrote: statement.skipUnlessWrote + 1 },
      )
      const all = await db.raw.batch(label, [READ_COUNTERS, ...shifted, READ_COUNTERS], control)
      const total = (result: (typeof all)[number] | undefined) =>
        (result?.rows ?? [])
          .filter((row) => row.Variable_name !== 'Handler_read_key')
          .reduce((sum, row) => sum + Number(row.Value), 0)
      walked.set(label, total(all[all.length - 1]) - total(all[0]))
      return all.slice(1, -1)
    },
  }
  return { executor, walked }
}

describe("the saga reads beside their own task's checkpoints, on MySQL", () => {
  it('fails a task, and reads a result, without walking the checkpoints the task has', async () => {
    // A saga's names are a range of the checkpoints key. Found by a test of each name,
    // the failure of any task walks every checkpoint the task has to learn that no step
    // is owed a rollback, and every read of a result walks them again.
    const CHECKPOINTS = 2_000
    const db = await openMysqlTestDb({ idNamespace: 'plan-saga-names', nowMs: 1_000_000 })
    try {
      const { executor, walked } = countingRowsWalked(db, ['fail', 'task-result'])
      const store = new MysqlSchedulerStore(executor, db.ids)
      const started = async (name: string) => {
        const task = await store.spawn(Q, name, '{}', { maxAttempts: 1 })
        const [run] = await store.claim(Q, name, { leaseSeconds: 60, limit: 1 })
        if (run?.taskId !== task.taskId) throw new Error(`${name} was not claimed`)
        await store.activate(Q, run.runId, run.claimToken, run.claimGen)
        return run
      }
      const beside = async (run: { taskId: string; runId: string }) => {
        for (let at = 0; at < CHECKPOINTS; at += 500) {
          const names = Array.from(
            { length: Math.min(500, CHECKPOINTS - at) },
            (_, i) => `step-${String(at + i).padStart(5, '0')}`,
          )
          await db.raw.batch(
            'fixture:checkpoints',
            [
              {
                sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                                               owner_run_id, owner_attempt, updated_at_ms)
                      VALUES ${names.map(() => "(?, ?, ?, '1', 'committed', ?, 1, 1)").join(', ')}`,
                args: names.flatMap((name) => [run.taskId, name, Q, run.runId]),
              },
            ],
            'write',
          )
        }
      }
      const rowsWalked = async (label: string, act: () => Promise<unknown>) => {
        walked.delete(label)
        await act()
        return walked.get(label)
      }
      // A plain task: no step registered a rollback, so its failure owes none.
      const plain = await started('plain')
      await beside(plain)
      const plainFailure = await rowsWalked('fail', async () =>
        expect(await store.fail(Q, plain.runId, plain.claimToken, '{}', null)).toEqual({
          rollingBack: false,
        }),
      )
      const plainResult = await rowsWalked('task-result', () =>
        store.getTaskResult(Q, plain.taskId),
      )
      // A saga whose one rollback ran: the read finds its start marker, then its rollback.
      const forward = await started('saga')
      await store.setCheckpoint(
        Q,
        forward.taskId,
        forward.runId,
        forward.claimToken,
        '$started:charge',
        '0',
        60,
      )
      await beside(forward)
      expect(await store.fail(Q, forward.runId, forward.claimToken, '{}', null)).toEqual({
        rollingBack: true,
      })
      const [pass] = await store.claim(Q, 'pass', { leaseSeconds: 60, limit: 1 })
      if (pass?.taskId !== forward.taskId) throw new Error('the rollback pass was not claimed')
      await store.activate(Q, pass.runId, pass.claimToken, pass.claimGen)
      await store.setCheckpoint(
        Q,
        pass.taskId,
        pass.runId,
        pass.claimToken,
        '$rollback:charge',
        'null',
        60,
      )
      await store.fail(Q, pass.runId, pass.claimToken, '{}', null)
      let rolledBack: unknown
      const sagaResult = await rowsWalked('task-result', async () => {
        rolledBack = (await store.getTaskResult(Q, forward.taskId))?.rollback
      })
      expect(rolledBack).toEqual({ outcome: 'complete' })
      for (const [what, rows] of Object.entries({ plainFailure, plainResult, sagaResult })) {
        expect(
          rows,
          `rows ${what} walked beside ${CHECKPOINTS} checkpoints of its own task`,
        ).toBeLessThan(150)
      }
    } finally {
      await db.close()
    }
  })
})
