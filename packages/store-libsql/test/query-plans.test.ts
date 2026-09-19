import {
  INFRA_RETRY_CAP,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SqlExecutor,
  encodeRollbackTry,
} from '@durablerun/core'
import { type Client, createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  NEXT_WAKE_SQL,
  SWEEP_SCAN_CANCELS_SQL,
  SWEEP_SCAN_EXPIRED_SQL,
} from '../src/index.js'
import { testIdSource } from '../src/testing.js'

/**
 * Query-plan pinning (prevention suite, per the standing rule): the
 * adversarial review found hot queries silently degrading to full scans and
 * temp b-trees because indexes drifted from query shapes. These tests make
 * that class of regression a test failure: every hot path must hit its
 * intended index and never sort the backlog.
 */

let db: LibsqlExecutor
let raw: Client

async function plan(sql: string, args: (string | number)[] = []): Promise<string> {
  const [r] = await db.batch('plan', [{ sql: `EXPLAIN QUERY PLAN ${sql}`, args }], 'read')
  return (r?.rows ?? []).map((row) => String(row.detail)).join('\n')
}

/**
 * The plan for a WRITE, which needs a raw client: `EXPLAIN QUERY PLAN UPDATE`
 * through the executor's batch takes the writer lock and fails.
 *
 * That gap is why the suite pinned only reads, and it cost a real regression:
 * correlating emit's waiter subquery to `runs` — a correctness fix — silently
 * demoted it from the query's driver to a filter, turning a lookup over the
 * handful of waiters into a full scan of the runs table on every emit.
 * Nothing failed, because no write had a plan pinned.
 */
async function writePlan(sql: string, args: (string | number)[] = []): Promise<string> {
  const r = await raw.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args })
  return r.rows.map((row) => String(row.detail)).join('\n')
}

beforeEach(async () => {
  db = LibsqlExecutor.open(':memory:')
  await new LibsqlStoreAdmin(db).migrate()
  raw = createClient({ url: ':memory:' })
  await new LibsqlStoreAdmin(new LibsqlExecutor(raw)).migrate()
})

afterEach(() => {
  db.close()
  raw.close()
})

it('builds the write-plan schema through the production migration contract', async () => {
  const version = await raw.execute(
    `SELECT value FROM meta WHERE key IN ('schema_version', 'applied:v1') ORDER BY key`,
  )
  expect(version.rows.map((row) => String(row.value))).toEqual([
    '1',
    String(CURRENT_SCHEMA_VERSION),
  ])
})

describe('claim candidate legs', () => {
  async function shippedClaimStatements(): Promise<{ sql: string; args: unknown[] }[]> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('claim-query-plan'))
    await store.claim('q', 'worker', { leaseSeconds: 60, limit: 10 })
    return seen
  }

  async function shippedClaimStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen = await shippedClaimStatements()
    const updates = seen.filter(
      (st) => /^\s*update "runs"/.test(st.sql) && st.sql.includes('"claim_gen" = "claim_gen" + ?'),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  // This deliberately recognizes the exact topology that escaped; it is not a
  // SQL parser. Nested SELECTs and keyword-looking string literals are known
  // false negatives, while the hosted dogfood run owns compatibility for the
  // selected claim path.
  function measuredUngroupedHavingClauses(sql: string): string[] {
    const upper = sql.toUpperCase()
    return [...upper.matchAll(/\bHAVING\b/g)]
      .filter((match) => {
        const before = upper.slice(0, match.index)
        return before.lastIndexOf('GROUP BY') < before.lastIndexOf('SELECT')
      })
      .map((match) => sql.slice(match.index, match.index + 40).replace(/\s+/g, ' '))
  }

  it('rejects the aggregate HAVING shape that remote Turso cannot parse', () => {
    expect(
      measuredUngroupedHavingClauses('SELECT COUNT(*) FROM t HAVING COUNT(*) = 1'),
    ).toHaveLength(1)
    expect(
      measuredUngroupedHavingClauses('SELECT key FROM t GROUP BY key HAVING COUNT(*) > 1'),
    ).toEqual([])
  })

  it('the shipped claim avoids the measured remote-Turso aggregate shape', async () => {
    const unsupported = (await shippedClaimStatements()).flatMap((st) =>
      measuredUngroupedHavingClauses(st.sql),
    )
    expect(unsupported, 'regression:remote-turso-claim-sql').toEqual([])
  })

  it('the shipped claim seeks eligible candidates before its per-leg limits', async () => {
    const st = await shippedClaimStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(p.match(/runs_poll/g)?.length).toBeGreaterThanOrEqual(2)
    expect(p).toContain('runs_task_attempt')
    expect(p).not.toContain('SCAN sibling')

    const siblingSource = 'FROM runs sibling'
    expect(st.sql.split(siblingSource)).toHaveLength(3)
    const degraded = st.sql.split(siblingSource).join(`${siblingSource} INDEXED BY runs_poll`)
    const degradedPlan = await writePlan(degraded, st.args as (string | number)[])
    expect(degradedPlan.match(/SCAN sibling/g)?.length ?? 0, degradedPlan).toBeGreaterThanOrEqual(2)
  })
})

describe('production sweep scans (exact shipped SQL)', () => {
  it('the cancel scan seeks tasks_cancel', async () => {
    const p = await plan(SWEEP_SCAN_CANCELS_SQL, ['q', 10])
    expect(p).toContain('tasks_cancel')
  })

  it('the expired-lease scan seeks runs_lease with no backlog sort', async () => {
    const p = await plan(SWEEP_SCAN_EXPIRED_SQL, ['q', 10])
    expect(p).toContain('runs_lease')
    expect(p).not.toContain('TEMP B-TREE')
  })
})

describe('lease queries', () => {
  it('the expired-lease sweep read seeks runs_lease', async () => {
    const p = await plan(
      `SELECT run_id FROM runs
       WHERE queue = ? AND state = 'running'
         AND claim_expires_at_ms IS NOT NULL AND claim_expires_at_ms <= ?`,
      ['q', 0],
    )
    expect(p).toContain('runs_lease')
  })

  it('per-queue MIN(claim_expires_at_ms) is an index seek, not a scan', async () => {
    const p = await plan(
      `SELECT MIN(claim_expires_at_ms) FROM runs
       WHERE queue = ? AND state = 'running' AND claim_expires_at_ms IS NOT NULL`,
      ['q'],
    )
    expect(p).toContain('runs_lease')
  })

  it('the PRODUCTION next-wake query seeks an index on every leg', async () => {
    // NEXT_WAKE_SQL was exported "so the query-plan suite pins it" and then
    // never imported: the pins above are hand-written stand-ins for its legs,
    // which is exactly the mistake this file's own header warns about — a pin
    // on a stand-in cannot catch drift in the query it protects. Every driver
    // tick runs this one, so a lost index term is a per-tick full scan.
    const p = await plan(NEXT_WAKE_SQL, ['q', 'q', 'q', 'q'])
    expect(p).not.toContain('SCAN runs')
    expect(p).not.toContain('SCAN tasks')
    expect(p).toContain('runs_poll')
    expect(p).toContain('runs_lease')
    expect(p).toContain('tasks_cancel')
  })
})

describe('the emit fan-out, which is a WRITE', () => {
  /**
   * Structurally the same statement emitEvent builds: the waits index picks
   * the waiters, and everything else filters them. The assertion is on the
   * DRIVER — `SEARCH runs USING PRIMARY KEY` means the waiters were looked up
   * and each run fetched by key; `SCAN runs` means every run in the table was
   * examined and the waits index reduced to a filter. Those differ by the size
   * of the runs table, which is unbounded in a durable-execution engine.
   */
  /**
   * The statement emitEvent ACTUALLY sends, recovered by running the real
   * operation through a recording executor.
   *
   * This pin used to EXPLAIN a hand-copied statement described as
   * "structurally the same" — a second representation of the shipped SQL,
   * which is the shape this repo has a standing rule against, and it drifted
   * exactly as that rule predicts: conditions added to the real statement
   * never reached the copy, and deleting the whole index driver from the
   * engine left this file green. A pin that can pass while the shipped
   * statement scans the runs table is not pinning anything.
   */
  async function shippedWakeStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('query-plan'))
    await store.emitEvent('q', 'e', '{}')
    // Sealing consumes the delivery statement's intermediate fence with a
    // second runs UPDATE. Select the one statement that writes the payload,
    // and still require exactly one so the pin cannot silently choose among
    // competing delivery representations.
    const updates = seen.filter(
      (st) => /^\s*update "runs" set/.test(st.sql) && st.sql.includes('"event_payload" ='),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  it('is driven by the waits index, not by a scan of runs', async () => {
    const st = await shippedWakeStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(
      [
        p.includes('waits_event'),
        p.includes('SEARCH runs USING PRIMARY KEY'),
        !p.includes('SCAN runs'),
      ],
      'mutation-verdict:behavior:emit-index-driver',
    ).toEqual([true, true, true])
  })

  it('degrades to a full scan if the waiter subquery is correlated', async () => {
    // The shape that shipped briefly, kept as the counter-example so the
    // assertion above is known to be discriminating rather than vacuous.
    const p = await writePlan(
      `UPDATE runs SET state = 'pending', wake_event = ?
       WHERE state = 'sleeping' AND wake_event = ?
         AND run_id IN (SELECT w.run_id FROM waits w
                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting'
                          AND w.run_id = runs.run_id AND w.step_name = runs.wake_step)`,
      ['e', 'e', 'q', 'e'],
    )
    expect(p).toContain('SCAN runs')
  })
})

describe("a terminal batch's wake, which every task ending pays", () => {
  /**
   * Every batch that ends a task also wakes the runs parked on its completion event,
   * whether or not anyone awaits it. The follow-on that turns the woken runs' tasks
   * pending selects its source by queue and state. Correlated to `tasks` on the queue,
   * that source is evaluated once for every task row, so one `complete` costs the
   * queue's tasks times its pending runs. Measured on libSQL with nobody waiting: 21 ms
   * at 250 pending runs, 1,063 ms at 2,000, and 4 ms when the backlog sits in another
   * queue. The statement is recovered from the real operation, as the emit pin is.
   */
  async function shippedWakeTasksStatement(): Promise<{ sql: string; args: unknown[] }> {
    const seen: { sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        if (label === 'complete') {
          for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
        }
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('terminal-query-plan'))
    await store.spawn('q', 'job', '{}')
    const [run] = await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claimed run')
    await store.activate('q', run.runId, 'worker', run.claimGen)
    await store.complete('q', run.runId, 'worker', '{}')
    // The batch updates tasks twice: once for the task it ends, and once for the tasks
    // of the runs it woke. Require exactly one of the second.
    const updates = seen.filter(
      (st) => /^\s*update "tasks" set/.test(st.sql) && st.sql.includes(`('pending')`),
    )
    expect(updates).toHaveLength(1)
    const only = updates[0]
    if (!only) throw new Error('unreachable')
    return only
  }

  it('looks the woken tasks up by key, and never scans tasks once for each pending run', async () => {
    const st = await shippedWakeTasksStatement()
    const p = await writePlan(st.sql, st.args as (string | number)[])
    expect(
      [
        p.includes('SEARCH tasks USING PRIMARY KEY'),
        !p.includes('SCAN tasks'),
        !p.includes('CORRELATED LIST SUBQUERY'),
      ],
      'mutation-verdict:behavior:wake-tasks-binds-the-queue',
    ).toEqual([true, true, true])
  })
  /**
   * The pin above reads the side of `wake-tasks` that is written. The side that is read
   * is where the cost was left: each of the three follow-ons that come after the wake
   * finds the runs this batch woke by queue and state, and the only index for that is
   * `runs_poll`, so every task ending walks every pending run of its queue. Measured on
   * libSQL with nobody waiting: 6 to 10 ms at 2,000 pending runs against 4 ms with the
   * backlog in another queue, and 215 ms at 100,000 against 55 ms. This reads every write
   * of every batch that ends a task through a call that needs no clock move.
   */
  async function shippedTerminalWrites(): Promise<
    { label: string; sql: string; args: unknown[] }[]
  > {
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        if (label === 'complete' || label === 'fail' || label === 'cancel-task') {
          for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        }
        return db.batch(label, statements, mode)
      },
    }
    const store = new LibsqlSchedulerStore(recorder, testIdSource('terminal-source-plans'))
    const ready = async (name: string) => {
      await store.spawn('q', name, '{}', { maxAttempts: 1 })
      const [run] = await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error('expected a claimed run')
      await store.activate('q', run.runId, 'worker', run.claimGen)
      return run
    }
    await store.complete('q', (await ready('completes')).runId, 'worker', '{}')
    await store.fail('q', (await ready('fails')).runId, 'worker', '{}', null)
    await store.cancelTask('q', (await store.spawn('q', 'is-cancelled', '{}')).taskId)
    expect([...new Set(seen.map((st) => st.label))]).toEqual(['complete', 'fail', 'cancel-task'])
    return seen.filter((st) => /^\s*(update|delete|insert)/i.test(st.sql))
  }

  it('finds the runs it woke without walking the pending runs of the queue', async () => {
    const walks: string[] = []
    for (const st of await shippedTerminalWrites()) {
      const p = await writePlan(st.sql, st.args as (string | number)[])
      for (const step of p.split('\n')) {
        if (/USING INDEX runs_poll \(queue=\? AND state=\?\)$/.test(step.trim())) {
          walks.push(`${st.label}: ${st.sql.trim().split(/\s+/).slice(0, 3).join(' ')}`)
        }
      }
    }
    expect(walks, 'mutation-verdict:behavior:wake-sources-find-the-woken-runs').toEqual([])
  })
})

describe('every batch a saga touches', () => {
  /**
   * A saga's state is checkpoints under reserved names, and the batches that read it are
   * the ones every task pays: a failure, a completion, a checkpoint, a suspension, an
   * await, a sweep cap. Each read must reach its rows by the checkpoints' primary key
   * with the task bound, and each statement a saga adds must find its source run and
   * its target task by key. The statements are recovered from the real operations, so a
   * pin cannot drift from the SQL it protects, and the rules below run over every
   * statement of every touched label, so a statement added later is held without being
   * listed.
   */
  const TOUCHED = [
    'set-checkpoint',
    'fail',
    'fail-rollback',
    'complete',
    'retry-task',
    'suspend',
    'await-event',
    'task-result',
    'sweep:claim-timeout',
  ] as const
  /** The aliases saga SQL gives the checkpoints table. */
  const SAGA_ALIAS = /\b(sp|ss|sr|st)\b/

  async function shippedSagaStatements(): Promise<
    { label: string; sql: string; args: unknown[] }[]
  > {
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const admin = new LibsqlStoreAdmin(db)
    await admin.setFakeNowEpochMs(1_000_000)
    const store = new LibsqlSchedulerStore(recorder, testIdSource('saga-query-plans'))
    const claimed = async (worker: string) => {
      const [run] = await store.claim('q', worker, { leaseSeconds: 60, limit: 1 })
      if (!run) throw new Error(`nothing to claim for ${worker}`)
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      return run
    }
    type Held = { taskId: string; runId: string; claimToken: string }
    const mark = (run: Held, name: string, state: string) =>
      store.setCheckpoint('q', run.taskId, run.runId, run.claimToken, name, state, 60)
    const tried = (tries: number) => ({
      key: `${SAGA_TRIES_PREFIX}a`,
      stateJson: encodeRollbackTry({ tries, errorJson: '{"name":"R"}' }),
    })
    const E = '{"name":"E"}'
    const saga = await store.spawn('q', 'saga', '{}')
    const forward = await claimed('w1')
    await mark(forward, `${SAGA_STARTED_PREFIX}a`, '1')
    await mark(forward, `${SAGA_STARTED_PREFIX}b`, '2')
    expect(await store.fail('q', forward.runId, forward.claimToken, E, null)).toEqual({
      rollingBack: true,
    })
    const pass = await claimed('w2')
    await mark(pass, `${SAGA_ROLLBACK_PREFIX}b`, 'null')
    await store.failRollback('q', pass.runId, pass.claimToken, E, { delaySeconds: 0 }, tried(1))
    const last = await claimed('w3')
    await store.failRollback('q', last.runId, last.claimToken, E, null, tried(2))
    expect((await store.getTaskResult('q', saga.taskId))?.rollback?.outcome).toBe('failed')
    expect(await store.retryTask('q', saga.taskId)).toBeNull()
    await store.spawn('q', 'retrying', '{}', { maxAttempts: 2 })
    const first = await claimed('w4')
    await store.fail('q', first.runId, first.claimToken, E, { delaySeconds: 0 })
    const second = await claimed('w5')
    await store.awaitEvent(
      'q',
      second.taskId,
      second.runId,
      second.claimToken,
      '$await:e',
      'e',
      null,
    )
    await store.spawn('q', 'sleeper', '{}')
    const sleeper = await claimed('w6')
    await store.suspendRun(
      'q',
      sleeper.runId,
      sleeper.claimToken,
      { inSeconds: 5 },
      { key: '$sleep', stateJson: '{}' },
    )
    await store.spawn('q', 'done', '{}')
    const done = await claimed('w7')
    await store.complete('q', done.runId, done.claimToken, '{}')
    // A worker dies at the infrastructure cap with a rollback owed: the sweep enters the phase.
    await store.spawn('q', 'dies', '{}')
    const dies = await claimed('w8')
    await mark(dies, `${SAGA_STARTED_PREFIX}a`, '1')
    await db.batch('seed-infra-cap', [
      {
        sql: 'UPDATE tasks SET infra_retries = ? WHERE task_id = ?',
        args: [INFRA_RETRY_CAP, dies.taskId],
      },
      {
        sql: 'UPDATE runs SET attempt = ? WHERE run_id = ?',
        args: [INFRA_RETRY_CAP + 1, dies.runId],
      },
      {
        sql: 'UPDATE checkpoints SET owner_attempt = ? WHERE owner_run_id = ?',
        args: [INFRA_RETRY_CAP + 1, dies.runId],
      },
    ])
    await admin.setFakeNowEpochMs(2_000_000)
    expect((await store.sweep('q', 10)).map((swept) => swept.kind)).toEqual(['rollback-started'])
    return seen.filter((st) => (TOUCHED as readonly string[]).includes(st.label))
  }

  /** What is wrong with one statement's plan, by the rules every saga statement is held to. */
  function planFaults(label: string, sql: string, plan: string): string[] {
    const faults: string[] = []
    const lines = plan.split('\n')
    for (const line of lines) {
      if (!SAGA_ALIAS.test(line)) continue
      if (!/^SEARCH (sp|ss|sr|st) USING PRIMARY KEY \(task_id=\?/.test(line)) {
        faults.push(`a saga read does not reach checkpoints by key with the task bound: ${line}`)
      }
    }
    // The statements a saga adds: the rollback pass, the phase marker, the attempt record,
    // and the task that follows the pass.
    // The task that follows the pass is told from a revival, which sets the same budget
    // column, by the batch it rides in: a column's name is not what a statement is.
    const followsThePass =
      /^\s*update "tasks"/.test(sql) && /"max_attempts"/.test(sql) && label !== 'retry-task'
    const added =
      followsThePass ||
      (/^\s*insert into "runs"/.test(sql) && SAGA_ALIAS.test(plan)) ||
      (/^\s*insert into "checkpoints"/.test(sql) &&
        label !== 'set-checkpoint' &&
        label !== 'suspend')
    if (added) {
      if (!plan.includes('SEARCH f USING PRIMARY KEY (run_id=?)')) {
        faults.push('its source run is not found by key')
      }
      for (const walk of [
        'SCAN tasks',
        'SCAN runs',
        'SCAN f',
        'runs_poll',
        'CORRELATED LIST SUBQUERY',
      ]) {
        if (plan.includes(walk)) faults.push(`it walks a backlog: ${walk}`)
      }
      if (
        /^\s*update "tasks"/.test(sql) &&
        !plan.includes('SEARCH tasks USING PRIMARY KEY (task_id=?)')
      ) {
        faults.push('its target task is not found by key')
      }
    }
    // Of the statements a saga reads through or adds, one sorts: the task result, and
    // what it sorts is one task's attempt records. A batch's other statements are not
    // this pin's to hold.
    const sagaStatement = added || lines.some((line) => SAGA_ALIAS.test(line))
    if (sagaStatement && plan.includes('TEMP B-TREE') && label !== 'task-result') {
      faults.push('it sorts')
    }
    return faults
  }

  it('reaches every saga row by key with the task bound, and walks no backlog', async () => {
    const statements = await shippedSagaStatements()
    const faults: string[] = []
    const reached = { sp: 0, ss: 0, sr: 0, st: 0, followsThePass: 0, labels: new Set<string>() }
    for (const st of statements) {
      const plan = await writePlan(st.sql, st.args as (string | number)[])
      for (const alias of ['sp', 'ss', 'sr', 'st'] as const) {
        if (new RegExp(`^SEARCH ${alias} `, 'm').test(plan)) reached[alias]++
      }
      const followsThePass = /"max_attempts"/.test(st.sql) && st.label !== 'retry-task'
      if (followsThePass) reached.followsThePass++
      if (SAGA_ALIAS.test(plan) || followsThePass) reached.labels.add(st.label)
      for (const fault of planFaults(st.label, st.sql, plan)) {
        faults.push(`[${st.label}] ${fault} :: ${st.sql.replace(/\s+/g, ' ').slice(0, 60)}`)
      }
    }
    // Compared as text, so a failure prints every fault and not a count of them.
    expect(faults.join('\n'), 'mutation-verdict:behavior:saga-plans').toBe('')
    // A pin over nothing passes. Every kind of saga read ran, in every touched label.
    expect({
      everyAliasWasPlanned: [reached.sp, reached.ss, reached.sr, reached.st].every((n) => n > 0),
      theTaskFollowedAPass: reached.followsThePass > 0,
      labels: [...reached.labels].sort(),
    }).toEqual({
      everyAliasWasPlanned: true,
      theTaskFollowedAPass: true,
      labels: [...TOUCHED].sort(),
    })
  })

  it('refuses the two shapes it exists to refuse', async () => {
    // A task update whose source names the target's queue, which is the shape a generated
    // write has when its queue is correlated and not bound: the table is walked.
    const correlated = await writePlan(
      `update "tasks" set "max_attempts" = 2
       WHERE task_id IN (SELECT f.task_id FROM runs f
                         WHERE f.run_id = ? AND f.queue = tasks.queue)
         AND state IN ('pending','running','sleeping')`,
      ['r'],
    )
    const bound = await writePlan(
      `update "tasks" set "max_attempts" = 2
       WHERE task_id IN (SELECT f.task_id FROM runs f WHERE f.run_id = ? AND f.queue = ?)
         AND queue = ? AND state IN ('pending','running','sleeping')`,
      ['r', 'q', 'q'],
    )
    // A saga read with no task bound.
    const unbound = await writePlan(
      `update "runs" set "state" = 'failed'
       WHERE run_id = ? AND EXISTS (SELECT 1 FROM checkpoints sp
                                    WHERE sp.checkpoint_name = '$rolling-back')`,
      ['r'],
    )
    const sqlOf = (kind: string) => `update "${kind}" set "max_attempts" = 2`
    expect({
      correlated: planFaults('fail', sqlOf('tasks'), correlated).length > 0,
      bound: planFaults('fail', sqlOf('tasks'), bound.replace('SEARCH f', 'SEARCH f')),
      unbound: planFaults('fail', 'update "runs"', unbound).length > 0,
    }).toEqual({
      correlated: true,
      // The bound shape has no fault but the one this literal cannot avoid: it names no fence.
      bound: planFaults('fail', sqlOf('tasks'), bound),
      unbound: true,
    })
    expect(correlated).toContain('SCAN tasks')
    expect(bound).toContain('SEARCH tasks USING PRIMARY KEY (task_id=?)')
    expect(unbound).toMatch(/SCAN sp|SEARCH sp USING (?!PRIMARY KEY \(task_id)/)
  })
})

describe('cancellation deadlines', () => {
  it('the cancellation sweep seeks tasks_cancel, never scanning tasks', async () => {
    const p = await plan(
      `SELECT task_id FROM tasks
       WHERE queue = ? AND cancel_at_ms IS NOT NULL AND cancel_at_ms <= ?
         AND state IN ('pending','running','sleeping')`,
      ['q', 0],
    )
    expect(p).toContain('tasks_cancel')
  })
})

describe('every write a store ships, by the table it writes', () => {
  /**
   * A generated follow-on writes the rows that belong to the rows its batch stamped: the
   * task of a run, the runs of a task. Left to correlate its source to the written table
   * on the queue, the source is a correlated subquery, SQLite cannot drive the write from
   * it, and the statement scans the table it writes and probes the source once for each
   * row. That is every task in the database, in any queue, on claim, activate, and
   * complete: one `complete` measured 61 ms beside 100,000 tasks. The statements are
   * recovered from the real operations, as the other pins of this file are, and every
   * UPDATE and DELETE of every label is planned, so a new follow-on is read too.
   */
  const REACHED = [
    'claim',
    'activate',
    'defer-launch',
    'reschedule',
    'suspend',
    'await-event',
    'emit-event',
    'complete',
    'fail',
    'fail-rollback',
    'retry-task',
    'cancel-task',
    'sweep:lost-launch',
    'sweep:claim-timeout',
  ]

  async function shippedWrites(): Promise<{ label: string; sql: string; args: unknown[] }[]> {
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, mode) => {
        for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        return db.batch(label, statements, mode)
      },
    }
    const admin = new LibsqlStoreAdmin(db)
    await admin.setFakeNowEpochMs(1_000_000)
    const store = new LibsqlSchedulerStore(recorder, testIdSource('shipped-writes'))
    // A claim token is fresh for every claim, as a tick's is, and the run carries it.
    let claims = 0
    const claimed = async (name: string, options: { maxAttempts?: number } = {}) => {
      const spawned = await store.spawn('q', name, '{}', options)
      claims += 1
      const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
      if (!run || run.taskId !== spawned.taskId) throw new Error(`expected to claim ${name}`)
      return run
    }
    const started = async (name: string, options: { maxAttempts?: number } = {}) => {
      const run = await claimed(name, options)
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      return run
    }
    const deferred = await claimed('deferred')
    await store.deferLaunch('q', deferred.runId, deferred.claimToken, deferred.claimGen, 3600)
    const rescheduled = await started('rescheduled')
    await store.reschedule('q', rescheduled.runId, rescheduled.claimToken, { inSeconds: 3600 })
    const suspended = await started('suspended')
    await store.suspendRun(
      'q',
      suspended.runId,
      suspended.claimToken,
      { inSeconds: 3600 },
      { key: 'step', stateJson: '{}' },
    )
    const waiting = await started('waiting')
    await store.awaitEvent(
      'q',
      waiting.taskId,
      waiting.runId,
      waiting.claimToken,
      'step',
      'event',
      null,
    )
    await store.emitEvent('q', 'event', '{}')
    const [woken] = await store.claim('q', 'worker-woken', { leaseSeconds: 60, limit: 1 })
    if (woken?.taskId !== waiting.taskId) throw new Error('expected to claim the woken run')
    await store.activate('q', woken.runId, woken.claimToken, woken.claimGen)
    await store.complete('q', woken.runId, woken.claimToken, '{}')
    const retried = await started('fails-and-retries', { maxAttempts: 2 })
    await store.fail('q', retried.runId, retried.claimToken, '{}', { delaySeconds: 3600 })
    const failed = await started('fails', { maxAttempts: 1 })
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    // A saga (DESIGN.md §3.10). A registered step starts, and the failure that ends the
    // forward phase places the rollback pass, which `fail` ships. A rollback's failed
    // attempt places the next pass, and the one after it halts the saga, which
    // `fail-rollback` ships both ways.
    const saga = await started('rolls-back', { maxAttempts: 1 })
    await store.setCheckpoint(
      'q',
      saga.taskId,
      saga.runId,
      saga.claimToken,
      `${SAGA_STARTED_PREFIX}a`,
      '1',
      60,
    )
    const entered = await store.fail('q', saga.runId, saga.claimToken, '{}', null)
    if (!entered.rollingBack) throw new Error('expected the failure to place a rollback pass')
    const sagaTried = (tries: number) => ({
      key: `${SAGA_TRIES_PREFIX}a`,
      stateJson: encodeRollbackTry({ tries, errorJson: '{}' }),
    })
    const passOf = async () => {
      claims += 1
      const [pass] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
      if (pass?.taskId !== saga.taskId) throw new Error('expected to claim the rollback pass')
      await store.activate('q', pass.runId, pass.claimToken, pass.claimGen)
      return pass
    }
    const firstPass = await passOf()
    const again = await store.failRollback(
      'q',
      firstPass.runId,
      firstPass.claimToken,
      '{}',
      { delaySeconds: 0 },
      sagaTried(1),
    )
    if (!again.rollingBack) throw new Error('expected the failed rollback to place another pass')
    const lastPass = await passOf()
    await store.failRollback('q', lastPass.runId, lastPass.claimToken, '{}', null, sagaTried(2))
    await store.retryTask('q', failed.taskId)
    await store.cancelTask('q', failed.taskId)
    // One run whose launch is lost and one whose worker dies, then the clock passes both leases.
    await claimed('launch-is-lost')
    await started('worker-dies')
    await admin.setFakeNowEpochMs(1_000_000 + 120_000)
    await store.sweep('q', 10)
    const writes = seen.filter((st) => /^\s*(update|delete)\s/i.test(st.sql))
    const labels = new Set(writes.map((st) => st.label))
    expect(REACHED.filter((label) => !labels.has(label))).toEqual([])
    return writes
  }

  /** The access a write is allowed to reach each table by: a seek by the key it was handed. */
  const KEYED: Readonly<Record<string, readonly RegExp[]>> = {
    tasks: [/ USING PRIMARY KEY \(task_id=\?\)$/],
    runs: [
      / USING PRIMARY KEY \(run_id=\?\)$/,
      / USING (?:COVERING )?INDEX runs_task_attempt \(task_id=\?\)$/,
    ],
    waits: [/ USING PRIMARY KEY \(run_id=\?(?: AND step_name=\?)?\)$/],
  }

  /**
   * Statements this file excuses, by name, each with where the open question is recorded.
   * A claim finds the runs it took by queue and state, because the stamp that says which
   * they are has no index and a claim has no column like `wake_event` to seek by.
   */
  const EXCUSED_SOURCE_WALKS: Readonly<Record<string, string>> = {
    'claim: update "runs"': 'BUILD.md PR3.14, the option about the claim',
    'claim: update "tasks"': 'BUILD.md PR3.14, the option about the claim',
    'claim: delete from': 'BUILD.md PR3.14, the option about the claim',
  }

  const named = (st: { label: string; sql: string }) =>
    `${st.label}: ${st.sql.trim().split(/\s+/).slice(0, 2).join(' ')}`

  it('reaches the table it writes by the key it was handed, whatever the plan calls that table', async () => {
    // The property, and not one spelling of its failure: the plan step over the written
    // table, under its name or its alias in that statement, must be a seek by key. A scan,
    // a walk of (queue, state), a covering variant, or an index added later all fail alike,
    // and a table with no key declared above fails until one is.
    const unkeyed: string[] = []
    for (const st of await shippedWrites()) {
      const target = /^\s*(?:update|delete from)\s+"?([a-z_]+)"?(?:\s+as\s+"?([a-z_]+)"?)?/i.exec(
        st.sql,
      )
      if (!target?.[1]) throw new Error(`cannot name the table of: ${st.sql.slice(0, 60)}`)
      const [, table, alias] = target
      const p = await writePlan(st.sql, st.args as (string | number)[])
      const step = p
        .split('\n')
        .map((line) => line.trim())
        .find((line) => new RegExp(`^(?:SCAN|SEARCH) (?:${table}|${alias ?? table})\\b`).test(line))
      const keyed = step !== undefined && (KEYED[table] ?? []).some((key) => key.test(step))
      if (!keyed) unkeyed.push(`${named(st)} -> ${step ?? 'no step over the written table'}`)
    }
    expect([...new Set(unkeyed)].sort()).toEqual([])
  })

  it('walks the runs of a queue by state in no step of any write, but for the claim it names', async () => {
    // Any step, under any alias, through any index, covering or not, that is pinned by a
    // queue and a state and nothing more reads every run of the queue in that state.
    const walks: string[] = []
    for (const st of await shippedWrites()) {
      const p = await writePlan(st.sql, st.args as (string | number)[])
      const walked = p
        .split('\n')
        .some((line) =>
          / USING (?:COVERING )?INDEX \w+ \(queue=\? AND state=\?\)$/.test(line.trim()),
        )
      if (walked) walks.push(named(st))
    }
    const found = [...new Set(walks)].sort()
    expect(found.filter((name) => !(name in EXCUSED_SOURCE_WALKS))).toEqual([])
    // An excuse that nothing needs any more is removed, not kept.
    expect(Object.keys(EXCUSED_SOURCE_WALKS).filter((name) => !found.includes(name))).toEqual([])
  })
})
