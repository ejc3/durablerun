import { readFileSync } from 'node:fs'
import {
  INFRA_RETRY_CAP,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  type SqlExecutor,
} from '@durablerun/core'
import { type Client, createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
} from '../src/index.js'
import { testIdSource } from '../src/testing.js'
import { type PlanRow, readNests } from './plan-nests.js'

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
  return (await planTree(sql, args)).map((row) => row.detail).join('\n')
}

/** The same plan as the tree it is: each row's id and its parent's, which the flat text drops. */
async function planTree(sql: string, args: unknown[] = []): Promise<PlanRow[]> {
  const r = await raw.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args as number[] })
  return r.rows.map((row) => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: String(row.detail),
  }))
}

/**
 * The statements one labelled batch of a real operation sends, recorded from the store.
 * A pin on these is a pin on what ships. A statement typed into this file would be a
 * second representation, free to drift from the one it stands for.
 */
async function shippedBatch(
  label: string,
  act: (store: LibsqlSchedulerStore) => Promise<unknown>,
): Promise<{ sql: string; args: unknown[] }[]> {
  const seen: { sql: string; args: unknown[] }[] = []
  const recorder: SqlExecutor = {
    batch: (sent, statements, mode) => {
      if (sent === label) {
        for (const st of statements) seen.push({ sql: st.sql, args: [...st.args] })
      }
      return db.batch(sent, statements, mode)
    },
  }
  await act(new LibsqlSchedulerStore(recorder, testIdSource('read-plans')))
  return seen
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

/** The first two words of a statement, which name it among the statements of its label. */
const head = (sql: string) => sql.trim().split(/\s+/).slice(0, 2).join(' ')

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

  /**
   * How a claim may reach `runs`: by a key, or by the candidate legs' walk of the DUE runs,
   * which the limit bounds. Anything else reads a backlog. A step pinned by queue and state
   * alone reads every running run of the queue, a range of `runs_lease` reads every
   * unexpired lease, and a scan reads the table. An index added later fails here until it
   * is listed.
   */
  const CLAIM_REACHES_RUNS_BY: readonly RegExp[] = [
    / USING PRIMARY KEY \(run_id=\?\)$/,
    / USING (?:COVERING )?INDEX runs_task_attempt \(task_id=\?\)$/,
    / USING (?:COVERING )?INDEX runs_held \(queue=\? AND claimed_by=\?\)$/,
    / USING INDEX runs_poll \(queue=\? AND state=\? AND available_at_ms>\? AND available_at_ms<\?\)$/,
  ]

  it('reaches every run a claim reads by a key or by the due range, in all four statements', async () => {
    // A queue's running runs are its work in flight, and a claim that reads them pays for
    // them on every tick, the idle ones included. One claim measured 200 ms beside 100,000
    // running runs: in the held guard of the compare-and-set, twice in the task follow-on,
    // in the delete of timed-out waits, and in the receipt read. The statements are the
    // ones a real claim sent, planned under ITS binds, because SQLite plans from bound
    // values: `state = ?` reaches a partial index only once it is bound to that index's
    // state.
    const sent = await shippedBatch('claim', async (store) => {
      await store.spawn('q', 'job', '{}')
      expect(await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })).toHaveLength(1)
    })
    expect(sent.map((st) => head(st.sql))).toEqual([
      'update "runs"',
      'update "tasks"',
      'delete from',
      'select "r"."run_id",',
    ])
    const backlogReads: string[] = []
    for (const st of sent) {
      // The names this statement reads `runs` under: the table's own, and every alias.
      const names = new Set(['runs'])
      for (const m of st.sql.matchAll(/\b(?:from|join)\s+"?runs"?\s+(?:as\s+)?"?([a-z_]+)"?/gi)) {
        if (m[1]) names.add(m[1].toLowerCase())
      }
      const steps = (await writePlan(st.sql, st.args as (string | number)[]))
        .split('\n')
        .map((line) => line.trim())
        // `json_each` is read under the alias `r` too, as a virtual table.
        .filter((line) => !line.includes('VIRTUAL TABLE'))
        .filter((line) => names.has(/^(?:SEARCH|SCAN) (\S+)/.exec(line)?.[1]?.toLowerCase() ?? ''))
      // Every statement reads `runs`, so none of them passes by having no step to judge.
      expect(steps, head(st.sql)).not.toHaveLength(0)
      for (const step of steps) {
        if (!CLAIM_REACHES_RUNS_BY.some((way) => way.test(step))) {
          backlogReads.push(`${head(st.sql)} -> ${step}`)
        }
      }
    }
    expect(
      [...new Set(backlogReads)].sort(),
      'mutation-verdict:behavior:claim-followons-name-the-token',
    ).toEqual([])
  })
})

describe('production sweep scans (exact shipped SQL)', () => {
  /** The two discovery reads a real sweep sends: due cancellations, then expired claims. */
  async function shippedScans() {
    const seen = await shippedBatch('sweep:scan', (store) => store.sweep('q', 10))
    expect(seen).toHaveLength(2)
    const [cancels, expired] = seen
    if (!cancels || !expired) throw new Error('unreachable')
    expect(cancels.sql).toContain('from "tasks" as "t"')
    expect(expired.sql).toContain('from "runs" as "r"')
    return { cancels, expired }
  }

  it('the cancel scan seeks tasks_cancel', async () => {
    const { cancels } = await shippedScans()
    const p = await plan(cancels.sql, cancels.args as (string | number)[])
    expect(p).toContain('tasks_cancel')
  })

  it('the expired-lease scan seeks runs_lease with no backlog sort', async () => {
    const { expired } = await shippedScans()
    const p = await plan(expired.sql, expired.args as (string | number)[])
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
    // The pins above are hand-written stand-ins for this query's legs, and a pin on a
    // stand-in cannot catch drift in the query it protects. This is the statement a
    // driver tick sends, recorded from the store. Every tick runs it, so a lost index
    // term is a per-tick full scan.
    const [wake] = await shippedBatch('next-wake', (store) => store.nextWakeAtEpochMs('q'))
    if (!wake) throw new Error('next-wake sent no statement')
    expect(wake.sql.match(/ union all /g)).toHaveLength(3)
    const p = await plan(wake.sql, wake.args as (string | number)[])
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
      (st) => /^\s*update "tasks" set/.test(st.sql) && st.sql.includes(`"state" = 'pending'`),
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
   * await, a sweep cap. Each read must reach its rows by the checkpoints' primary key,
   * the task and the name: one name is one row of it, and the names under a prefix are
   * one range of it. Each statement a saga adds must find its source run and its target
   * task by key. The statements are recovered from the real operations, so a
   * pin cannot drift from the SQL it protects, and the rules below run over every
   * statement of every touched label, so a statement added later is held without being
   * listed.
   */
  const TOUCHED = [
    'spawn',
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
    const tried = { stepKey: 'a', errorJson: '{"name":"R"}' }
    const E = '{"name":"E"}'
    const saga = await store.spawn('q', 'saga', '{}')
    const forward = await claimed('w1')
    await mark(forward, `${SAGA_STARTED_PREFIX}a`, '1')
    await mark(forward, `${SAGA_STARTED_PREFIX}b`, '2')
    // A child spawn tests its parent's phase, under the parent's live claim. The child lives
    // in a queue of its own, so no claim below takes it.
    await store.spawn('kids', 'child', '{}', {
      childOf: {
        parentQueue: 'q',
        parentTaskId: saga.taskId,
        runId: forward.runId,
        claimToken: forward.claimToken,
        replayKey: '$spawn:child',
      },
    })
    expect(await store.fail('q', forward.runId, forward.claimToken, E, null)).toEqual({
      rollingBack: true,
    })
    const pass = await claimed('w2')
    await mark(pass, `${SAGA_ROLLBACK_PREFIX}b`, 'null')
    await store.failRollback('q', pass.runId, pass.claimToken, E, { delaySeconds: 0 }, tried)
    const last = await claimed('w3')
    await store.failRollback('q', last.runId, last.claimToken, E, null, tried)
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

  /**
   * The task update that follows a pass. It is told from a revival, which sets the same
   * budget column, by the batch it rides in, and from a spawn, which inserts that column,
   * by being an update: a column's name is not what a statement is.
   */
  const followsThePass = (label: string, sql: string): boolean =>
    /^\s*update "tasks"/.test(sql) && /"max_attempts"/.test(sql) && label !== 'retry-task'

  /** What is wrong with one statement's plan, by the rules every saga statement is held to. */
  function planFaults(label: string, sql: string, plan: string): string[] {
    const faults: string[] = []
    const lines = plan.split('\n')
    for (const line of lines) {
      if (!SAGA_ALIAS.test(line)) continue
      // The task alone is a walk of every checkpoint the task has, which the failure of
      // any task and every read of a result would pay in proportion to the task's steps.
      const byTaskAndName =
        /^SEARCH (sp|sr) USING PRIMARY KEY \(task_id=\? AND checkpoint_name=\?\)/.test(line) ||
        /^SEARCH (ss|st) USING PRIMARY KEY \(task_id=\? AND checkpoint_name>\? AND checkpoint_name<\?\)/.test(
          line,
        )
      if (!byTaskAndName) {
        faults.push(`a saga read does not reach its checkpoints by task and name: ${line}`)
      }
    }
    // The statements a saga adds: the rollback pass, the phase marker, the attempt record,
    // and the task that follows the pass.
    const added =
      followsThePass(label, sql) ||
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
    // None of the statements a saga reads through or adds sorts. A batch's other
    // statements are not this pin's to hold.
    const sagaStatement = added || lines.some((line) => SAGA_ALIAS.test(line))
    if (sagaStatement && plan.includes('TEMP B-TREE')) faults.push('it sorts')
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
      const followed = followsThePass(st.label, st.sql)
      if (followed) reached.followsThePass++
      if (SAGA_ALIAS.test(plan) || followed) reached.labels.add(st.label)
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

  it('refuses the three shapes it exists to refuse', async () => {
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
    // A saga read that finds its names by a test of each one. The task is bound and the
    // key is used, and every checkpoint the task has is walked.
    const walked = await writePlan(
      `update "runs" set "state" = 'failed'
       WHERE run_id = ? AND EXISTS (SELECT 1 FROM checkpoints ss
                                    WHERE ss.task_id = runs.task_id
                                      AND substr(ss.checkpoint_name, 1, 9) = '$started:')`,
      ['r'],
    )
    const sqlOf = (kind: string) => `update "${kind}" set "max_attempts" = 2`
    expect({
      correlated: planFaults('fail', sqlOf('tasks'), correlated).length > 0,
      bound: planFaults('fail', sqlOf('tasks'), bound.replace('SEARCH f', 'SEARCH f')),
      unbound: planFaults('fail', 'update "runs"', unbound).length > 0,
      walked: planFaults('fail', 'update "runs"', walked).length > 0,
    }).toEqual({
      correlated: true,
      // The bound shape has no fault but the one this literal cannot avoid: it names no fence.
      bound: planFaults('fail', sqlOf('tasks'), bound),
      unbound: true,
      walked: true,
    })
    expect(correlated).toContain('SCAN tasks')
    expect(bound).toContain('SEARCH tasks USING PRIMARY KEY (task_id=?)')
    expect(unbound).toMatch(/SCAN sp|SEARCH sp USING (?!PRIMARY KEY \(task_id)/)
    expect(walked).toMatch(/^SEARCH ss USING PRIMARY KEY \(task_id=\?\)$/m)
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

/** One statement a real operation sent: the label of its batch, its place in it, its binds. */
interface Shipped {
  readonly label: string
  readonly index: number
  readonly sql: string
  readonly args: unknown[]
}

/**
 * Every statement the store sends, once each under the label that carried it, recovered
 * from one scripted history of real operations, so nothing planned below is a hand copy of
 * what ships. The history reaches every batch in every variant it compiles to, and what
 * holds it to that is the corpus: a statement of `corpus/libsql.json` that this history
 * never sent fails the last block of this file. It runs once for the file, because a plan
 * needs a statement and its binds, not the rows it touched. A statement is kept with the
 * binds of one of its sends, and the last block holds that every send of it plans alike.
 */
const keyOf = (label: string, sql: string) => `${label}\n${sql}`
let sends: Promise<Shipped[]> | undefined
function everySend(): Promise<Shipped[]> {
  sends ??= sendEveryStatement()
  return sends
}
let shipped: Promise<Map<string, Shipped>> | undefined
function shippedStatements(): Promise<Map<string, Shipped>> {
  shipped ??= everySend().then((sent) => new Map(sent.map((st) => [keyOf(st.label, st.sql), st])))
  return shipped
}

async function sendEveryStatement(): Promise<Shipped[]> {
  const seen: Shipped[] = []
  const recorder: SqlExecutor = {
    batch: (label, statements, mode) => {
      for (const [index, st] of statements.entries()) {
        seen.push({ label, index, sql: st.sql, args: [...st.args] })
      }
      return db.batch(label, statements, mode)
    },
  }
  const admin = new LibsqlStoreAdmin(db)
  await admin.setFakeNowEpochMs(1_000_000)
  const store = new LibsqlSchedulerStore(recorder, testIdSource('shipped-statements'))
  // A claim token is fresh for every claim, as a tick's is, and the run carries it.
  let claims = 0
  const claimOf = async (taskId: string) => {
    claims += 1
    const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
    if (!run || run.taskId !== taskId) throw new Error(`expected to claim task ${taskId}`)
    return run
  }
  const startedOf = async (taskId: string) => {
    const run = await claimOf(taskId)
    await store.activate('q', run.runId, run.claimToken, run.claimGen)
    return run
  }
  const claimed = async (name: string) => claimOf((await store.spawn('q', name, '{}')).taskId)
  const started = async (name: string, options: { maxAttempts?: number } = {}) =>
    startedOf((await store.spawn('q', name, '{}', options)).taskId)
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
  // A heartbeat and the reads, beside a live run. A read changes nothing, so where it
  // stands is free. The driver's heartbeat is no run's, and rides here.
  const live = await started('live')
  await store.heartbeat('q', live.runId, live.claimToken, 60)
  await store.claimedTaskName('q', live.runId, live.claimToken, live.claimGen)
  await store.getCheckpoints('q', live.taskId, 1)
  await store.getTaskResult('q', live.taskId)
  await store.nextWakeAtEpochMs('q')
  await store.driverHeartbeat('q', 'driver', 60)
  // A run this store never heard of: the terminal batch reads its task, finds none, and
  // reads its state to say why it refuses.
  const refused = await store.complete('q', 'no-such-run', 'no-token', '{}').then(
    () => false,
    () => true,
  )
  if (!refused) throw new Error('expected a run nobody made to be refused')
  await store.complete('q', live.runId, live.claimToken, '{}')
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
  const woken = await startedOf(waiting.taskId)
  await store.complete('q', woken.runId, woken.claimToken, '{}')
  // A parent awaits a live child, and the child ends and wakes it. Then an older build's
  // ending is staged, one that wrote no event, so the parent's next await records it.
  const parent = await started('parent')
  const child = await store.spawn('q', 'child', '{}', {
    childOf: {
      parentQueue: 'q',
      parentTaskId: parent.taskId,
      runId: parent.runId,
      claimToken: parent.claimToken,
      replayKey: 'site',
    },
  })
  const awaitChild = (run: typeof parent) =>
    store.awaitTaskDone('q', run.taskId, run.runId, run.claimToken, 'step', child.taskId, null)
  await awaitChild(parent)
  const childRun = await startedOf(child.taskId)
  await store.complete('q', childRun.runId, childRun.claimToken, '{}')
  const wokenParent = await startedOf(parent.taskId)
  await db.batch('an-older-build-wrote-no-event', [
    {
      sql: 'DELETE FROM events WHERE queue = ? AND event_name LIKE ?',
      args: ['q', '$task-done:%'],
    },
  ])
  await awaitChild(wokenParent)
  await store.complete('q', wokenParent.runId, wokenParent.claimToken, '{}')
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
  const sagaTried = { stepKey: 'a', errorJson: '{}' }
  const firstPass = await startedOf(saga.taskId)
  const again = await store.failRollback(
    'q',
    firstPass.runId,
    firstPass.claimToken,
    '{}',
    { delaySeconds: 0 },
    sagaTried,
  )
  if (!again.rollingBack) throw new Error('expected the failed rollback to place another pass')
  const lastPass = await startedOf(saga.taskId)
  await store.failRollback('q', lastPass.runId, lastPass.claimToken, '{}', null, sagaTried)
  await store.retryTask('q', failed.taskId)
  await store.cancelTask('q', failed.taskId)
  // Last, because it moves the clock: a launch that is lost, a worker that dies and whose
  // lease an advisory signal shortens first, and a task never started by its deadline.
  await claimed('launch-is-lost')
  const dies = await started('worker-dies')
  await store.expireLeaseNow('q', dies.runId, dies.claimToken)
  await store.spawn('q', 'never-starts', '{}', { cancellation: { maxDelaySeconds: 30 } })
  await admin.setFakeNowEpochMs(1_000_000 + 120_000)
  await store.sweep('q', 10)
  return seen
}

describe('every statement a store ships, by the nests of its plan', () => {
  /**
   * The pins above hold the statements someone chose, three reads among them. None is
   * generated, so a statement added later is planned only if someone chooses it, and a pin
   * sees a walk only where it spells the one failure it was written against. Here every
   * statement of every batch is planned, of every kind, and its steps and loop nests are
   * judged by `readNests` in `plan-nests.ts`, whose header says what a walk is, what a nest
   * is and what the rule is. Two pins that planned every UPDATE and DELETE stood before this
   * block: the written table had to be reached by a key from a list kept there, and no step
   * of a write could be pinned by a queue and a state alone. The reader's refusal of a walk
   * holds both for every statement, so they are gone. "Every" is held by the two checked
   * inventories of what a store sends: the generated corpus of statement trees, and the list
   * of the statements that stay text.
   */
  const CORPUS: Record<string, Record<string, { sql: string }[]>> = JSON.parse(
    readFileSync(new URL('../../conformance/corpus/libsql.json', import.meta.url), 'utf8'),
  )
  const TEXT_STATEMENTS: string[] = Object.keys(
    JSON.parse(
      readFileSync(new URL('../../../scripts/text-statements.json', import.meta.url), 'utf8'),
    ).statements,
  )

  /** A text statement no operation of the store sends, with why it has no nest to judge. */
  const NOT_THE_STORES: Readonly<Record<string, string>> = {
    'migrate:bootstrap':
      'the migration runner sends it: DDL, which has no plan, beside writes of meta by its key',
    'migrate:v*':
      'the migration runner sends it: DDL, which has no plan, beside writes of meta by its key',
    'migrate:version': 'the migration runner sends it, and it reads meta alone',
    'admin:set-fake-now': 'the test clock sends it, and it writes meta alone',
    'admin:clear-fake-now': 'the test clock sends it, and it writes meta alone',
    'admin:now': 'the test clock sends it, and it reads meta alone',
  }

  /**
   * Statements this block excuses, by name, each for the one fault it names and with where
   * the open question is recorded. Any other fault in the same statement still fails. None
   * is excused today. Until schema version 9 a claim found the runs it took by queue and
   * state, and its task update and its delete of timed-out waits were excused here for that
   * walk. They reach those runs by the claim token now, and the reader counts that seek as
   * keyed: one token holds at most one claim's limit of runs.
   */
  const EXCUSED_NESTS: Readonly<Record<string, { fault: RegExp; because: string }>> = {}

  /**
   * A due range is what is due only if it points that way, and it is bounded only by a
   * LIMIT, and a plan shows neither. So every statement in which a due range drives another
   * step is named here with the lines that drive, and with what bounds them: the
   * statement's own LIMIT, which its text must then hold, or where the open question is
   * recorded. A range that drives in a statement nobody named fails, and so does another
   * line in a statement that is named, and so does a name nothing needs.
   */
  const RUNS_DUE =
    'SEARCH r USING INDEX runs_poll (queue=? AND state=? AND available_at_ms>? AND available_at_ms<?)'
  const LEASES =
    'SEARCH r USING INDEX runs_lease (queue=? AND claim_expires_at_ms>? AND claim_expires_at_ms<?)'
  const TASKS_PAST_THEIR_DEADLINE =
    'SEARCH t USING INDEX tasks_cancel (queue=? AND cancel_at_ms>? AND cancel_at_ms<?)'
  const DRIVEN_BY_A_DUE_RANGE: Readonly<
    Record<string, { drivers: readonly string[]; boundedBy: string }>
  > = {
    // Each candidate leg takes the runs that are due, and the claim takes the legs' rows.
    'claim/claimed#0': { drivers: [RUNS_DUE, 'SCAN c'], boundedBy: 'LIMIT' },
    'sweep:scan/read#0': { drivers: [TASKS_PAST_THEIR_DEADLINE], boundedBy: 'LIMIT' },
    // The leases that have expired.
    'sweep:scan/read#1': { drivers: [LEASES], boundedBy: 'LIMIT' },
  }

  /** A statement's name: where the corpus holds it, or for text its place in its batch. */
  const placeInCorpus = new Map<string, string>()
  for (const [label, variants] of Object.entries(CORPUS)) {
    for (const [variant, signature] of Object.entries(variants)) {
      for (const [i, st] of signature.entries()) {
        if (!placeInCorpus.has(keyOf(label, st.sql))) {
          placeInCorpus.set(keyOf(label, st.sql), `${label}/${variant}#${i}`)
        }
      }
    }
  }
  const nameOf = (st: Shipped) =>
    placeInCorpus.get(keyOf(st.label, st.sql)) ?? `${st.label}#${st.index}`

  /** One statement's plan, read. Every reading in this block is this one, the generated check's too. */
  const nestsOf = async (st: { sql: string; args: unknown[] }) =>
    readNests(await planTree(st.sql, st.args), st.sql)
  /** The same reading of a statement that nothing runs, so each bind is a placeholder. */
  const read = (sql: string) => nestsOf({ sql, args: (sql.match(/\?/g) ?? []).map(() => 0) })

  it("sends every statement of the corpus, and every text statement that is the store's", async () => {
    const sent = await shippedStatements()
    // Every statement of every variant, by its text: a label reached through one of its
    // variants would leave the statements of the other unplanned.
    expect([...placeInCorpus].filter(([key]) => !sent.has(key)).map(([, place]) => place)).toEqual(
      [],
    )
    const labels = new Set([...sent.values()].map((st) => st.label))
    expect(
      TEXT_STATEMENTS.filter((label) => !labels.has(label) && !(label in NOT_THE_STORES)),
    ).toEqual([])
    // A reason that names nothing, or names a statement the store does send, is removed.
    expect(
      Object.keys(NOT_THE_STORES).filter(
        (label) => labels.has(label) || !TEXT_STATEMENTS.includes(label),
      ),
    ).toEqual([])
  })

  it('reads no table once for each row of a backlog, but for the claim it names', async () => {
    const faults: string[] = []
    const excused = new Set<string>()
    const drivenByADueRange: Record<string, string[]> = {}
    const textOf = new Map<string, string>()
    for (const st of (await shippedStatements()).values()) {
      const name = nameOf(st)
      const reading = await nestsOf(st)
      if (reading.dueDrivers.length > 0) drivenByADueRange[name] = [...reading.dueDrivers].sort()
      textOf.set(name, st.sql)
      const excuse = EXCUSED_NESTS[name]
      const unexcused = reading.faults.filter((fault) => !excuse?.fault.test(fault))
      if (unexcused.length < reading.faults.length) excused.add(name)
      faults.push(...unexcused.map((fault) => `[${name}] ${fault}`))
    }
    // Compared as text, so a failure prints every fault and not a count of them.
    expect(faults.join('\n'), 'mutation-verdict:behavior:plan-nests').toBe('')
    // An excuse that nothing needs any more is removed, not kept.
    expect(Object.keys(EXCUSED_NESTS).filter((name) => !excused.has(name))).toEqual([])
    // Named line for line, in both directions: a due range that drives in a statement nobody
    // named, another line in one that is named, and a name no due range needs any more.
    expect(drivenByADueRange).toEqual(
      Object.fromEntries(
        Object.entries(DRIVEN_BY_A_DUE_RANGE).map(([name, { drivers }]) => [
          name,
          [...drivers].sort(),
        ]),
      ),
    )
    // What bounds each: a LIMIT the statement's own text holds, or a recorded open question.
    expect(
      Object.entries(DRIVEN_BY_A_DUE_RANGE)
        .filter(([name, { boundedBy }]) =>
          boundedBy === 'LIMIT'
            ? !/\blimit\b/i.test(textOf.get(name) ?? '')
            : !/^BUILD\.md PR\d/.test(boundedBy),
        )
        .map(([name]) => name),
    ).toEqual([])
  })

  it('plans every send of a statement alike, so the binds of one send stand for all', async () => {
    const planUnder = async (st: { sql: string; args: unknown[] }) =>
      JSON.stringify((await planTree(st.sql, st.args)).map((row) => [row.parent, row.detail]))
    // A plan does depend on its binds. SQLite reads a bound value when it plans, and the
    // partial index of the running leases serves only a statement sent with that state.
    const underState = (state: string) =>
      planUnder({
        sql: 'select run_id from runs where queue = ? and state = ? and claim_expires_at_ms > ?',
        args: ['q', state, 0],
      })
    expect(await underState('running')).not.toBe(await underState('pending'))
    const kept = await shippedStatements()
    const keptPlans = new Map<string, string>()
    const differing = new Set<string>()
    for (const st of await everySend()) {
      const key = keyOf(st.label, st.sql)
      const keptSend = kept.get(key)
      if (!keptSend || st === keptSend) continue
      if (!keptPlans.has(key)) keptPlans.set(key, await planUnder(keptSend))
      if ((await planUnder(st)) !== keptPlans.get(key)) differing.add(nameOf(st))
    }
    expect([...differing]).toEqual([])
  })

  it('refuses a walk of a table in any statement, alone or not, and names the table', async () => {
    // A lone walk drives nothing and nothing drives it, so no nest holds it. One statement
    // of each kind a store ships stands here as one step that walks: a read under the alias
    // a generated statement gives its source, the SELECT of an INSERT, an UPDATE, a DELETE,
    // and a read whose alias follows its table with no AS, as a text statement writes it.
    const alone = {
      read: `select "f"."run_id" from "runs" as "f" where "f"."queue" = ? and "f"."state" = ?`,
      insertSelect: `insert into events (queue, event_name, payload, emitted_at_ms)
                     select queue, run_id, null, 0 from runs where queue = ? and state = ?`,
      update: 'update runs set wake_event = null where queue = ? and state = ?',
      delete: 'delete from waits where status = ?',
      bareAlias: 'select sibling.run_id from runs sibling where sibling.attempt > ?',
    }
    const faults: Record<string, string[]> = {}
    for (const [kind, sql] of Object.entries(alone)) faults[kind] = (await read(sql)).faults
    const walkOf = (table: string) => `is a walk of ${table}: neither keyed nor a due range`
    const queueByState = 'USING COVERING INDEX runs_poll (queue=? AND state=?)'
    expect(faults).toEqual({
      read: [`SEARCH f ${queueByState} :: ${walkOf('runs')}`],
      insertSelect: [`SEARCH runs ${queueByState} :: ${walkOf('runs')}`],
      update: [`SEARCH runs ${queueByState} :: ${walkOf('runs')}`],
      delete: [`SCAN waits :: ${walkOf('waits')}`],
      bareAlias: [`SCAN sibling USING COVERING INDEX runs_task_attempt :: ${walkOf('runs')}`],
    })
    // Not alone: the walk is refused as the walk it is, beside what the nest rule says of
    // the step that runs once for each of its rows.
    const driving = await read(
      `select t.task_name from tasks t
       where t.task_id in (select f.task_id from runs f where f.queue = ? and f.state = ?)`,
    )
    expect([...driving.faults].sort()).toEqual([
      `SEARCH f USING INDEX runs_poll (queue=? AND state=?) :: ${walkOf('runs')}`,
      expect.stringMatching(/^SEARCH t .* :: runs once for each row of a walk: SEARCH f /),
    ])
    // What is no walk: one run by its key, and the clock's row of `meta` by its key.
    for (const sql of [
      'select state from runs where run_id = ?',
      'select value from meta where key = ?',
    ]) {
      expect(await read(sql), sql).toEqual({ faults: [], dueDrivers: [] })
    }
  })

  it('shows what the refusal of a walk cannot see, and what it refuses though it is sound', async () => {
    const WALK = 'neither keyed nor a due range'
    // A due range that stands alone is no walk, and the list of due ranges names only one
    // that drives another step. Under no LIMIT it reads everything due at once, as an UPDATE
    // always does, and one of the two pins that stood here refused this one, because a due
    // range is not the key a write was handed. Pointed the other way it reads the backlog.
    const everyExpiredLease = await read(
      `update runs set state = 'failed'
       where queue = ? and state = 'running' and claim_expires_at_ms <= ?`,
    )
    const everyRunNotYetDue = await read(
      `select run_id from runs where queue = ? and state = 'pending' and available_at_ms > ?`,
    )
    expect([everyExpiredLease, everyRunNotYetDue]).toEqual([
      { faults: [], dueDrivers: [] },
      { faults: [], dueDrivers: [] },
    ])
    // A statement is planned under the binds its sends carried, and SQLite plans from bound
    // values. Sent with a state the history never sends it with, this one walks.
    const leases =
      'select run_id from runs where queue = ? and state = ? and claim_expires_at_ms > ?'
    expect((await nestsOf({ sql: leases, args: ['q', 'running', 0] })).faults).toEqual([])
    expect((await nestsOf({ sql: leases, args: ['q', 'pending', 0] })).faults).toEqual([
      `SEARCH runs USING INDEX runs_poll (queue=? AND state=?) :: is a walk of runs: ${WALK}`,
    ])
    // What it refuses though it is sound, because a plan does not say how few rows a walk
    // reads: the drivers of one queue are a handful, and a MIN over an index prefix is one row.
    const driversOfAQueue = await read('select driver_id from drivers where queue = ?')
    const earliestPending = await read(
      `select min(available_at_ms) from runs where queue = ? and state = 'pending'`,
    )
    expect([driversOfAQueue, earliestPending].map((reading) => reading.faults)).toEqual([
      [`SEARCH drivers USING PRIMARY KEY (queue=?) :: is a walk of drivers: ${WALK}`],
      [
        `SEARCH runs USING COVERING INDEX runs_poll (queue=? AND state=?) :: is a walk of runs: ${WALK}`,
      ],
    ])
    // Last, because it changes how this database plans. A plan depends on the database's
    // statistics, and the database a statement is planned on here has none. Keyed here, this
    // read walks its queue where the statistics rate the two indexes the other way.
    const runsOfATask = {
      sql: 'select run_id from runs where task_id = ? and queue = ?',
      args: ['t', 'q'],
    }
    expect((await nestsOf(runsOfATask)).faults).toEqual([])
    await raw.execute('ANALYZE sqlite_schema')
    for (const [index, stat] of [
      ['runs_task_attempt', '1000000 1000000 1000000'],
      ['runs_poll', '1000000 2 2 1'],
    ]) {
      await raw.execute({
        sql: `INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('runs', ?, ?)`,
        args: [index ?? '', stat ?? ''],
      })
    }
    await raw.execute('ANALYZE sqlite_schema')
    expect((await nestsOf(runsOfATask)).faults).toEqual([
      `SEARCH runs USING INDEX runs_poll (queue=?) :: is a walk of runs: ${WALK}`,
    ])
  })

  it('refuses the nests it exists to refuse, and shows what a plan cannot', async () => {
    // A task update correlated to its source on the queue: the table is scanned, and the
    // source is probed once for each task.
    const correlated = await read(
      `update "tasks" set "max_attempts" = 2
       WHERE task_id IN (SELECT f.task_id FROM runs f
                         WHERE f.run_id = ? AND f.queue = tasks.queue)`,
    )
    // A read whose IN list walks the runs of a queue by state. No pin of writes sees a read.
    const listed = await read(
      `select t.task_name from tasks t
       where t.task_id in (select f.task_id from runs f where f.queue = ? and f.state = ?)`,
    )
    // An insert whose source scans tasks once for each run it selects.
    const scanned = await read(
      `insert into events (queue, event_name, payload, emitted_at_ms)
       select f.queue, f.run_id, t.task_name, 0
       from runs f join tasks t on t.task_name = f.run_id where f.run_id = ?`,
    )
    // Each walk is refused as the walk it is, and then for what the nest makes of it.
    expect([correlated, listed, scanned].map((reading) => reading.faults)).toEqual([
      [
        expect.stringMatching(/^SCAN tasks :: is a walk of tasks: /),
        expect.stringMatching(/ :: runs once for each row of a walk: SCAN tasks$/),
      ],
      [
        expect.stringMatching(
          /^SEARCH f .*runs_poll \(queue=\? AND state=\?\) :: is a walk of runs: /,
        ),
        expect.stringMatching(
          /^SEARCH t .* :: runs once for each row of a walk: SEARCH f .*runs_poll \(queue=\? AND state=\?\)$/,
        ),
      ],
      [
        expect.stringMatching(/^SCAN t :: is a walk of tasks: /),
        expect.stringMatching(/^SCAN t :: is not keyed, and runs once for each row of SEARCH f /),
      ],
    ])
    // What a plan cannot show, each with the defect present and no fault. Both steps are
    // keyed, and one task's rows are many: every checkpoint of a task, once for each run of it.
    const ownRows = await read(
      `update runs set claim_gen = (select count(*) from checkpoints c
                                    where c.task_id = runs.task_id) where task_id = ?`,
    )
    expect(ownRows).toEqual({ faults: [], dueDrivers: [] })
    // What is due under no limit, and what is not due at all, read alike: a due range that
    // drives. The list of names above is what holds them, by a reason a person wrote.
    const unlimited = await read(
      `select r.run_id, t.task_name from runs r join tasks t on t.task_id = r.task_id
       where r.queue = ? and r.state = 'pending' and r.available_at_ms <= ?`,
    )
    const notDue = await read(
      `select r.run_id, t.task_name from runs r join tasks t on t.task_id = r.task_id
       where r.queue = ? and r.state = 'running' and r.claim_expires_at_ms > ?`,
    )
    expect(
      [unlimited, notDue].map((reading) => [reading.faults, reading.dueDrivers.length]),
    ).toEqual([
      [[], 1],
      [[], 1],
    ])
    // A statement inside a trigger is never planned. The driver's heartbeat inserts into a
    // view whose trigger deletes the expired rows of `drivers`, by a scan, and its plan does
    // not name the table.
    const beat = [...(await shippedStatements()).values()].find(
      (st) => st.label === 'driver-heartbeat',
    )
    if (!beat) throw new Error('the history sent no driver heartbeat')
    const beatPlan = await planTree(beat.sql, beat.args)
    expect(beatPlan.map((row) => row.detail).join('\n')).not.toContain('drivers')
    expect(readNests(beatPlan)).toEqual({ faults: [], dueDrivers: [] })
    // Planned by hand from the trigger's own text, with a bind where it names the new row,
    // that DELETE is a walk, and the reader refuses it.
    const triggers = await raw.execute(`select sql from sqlite_master where type = 'trigger'`)
    const deletes = triggers.rows.flatMap(
      (row) => String(row.sql).match(/DELETE FROM [^;]+/g) ?? [],
    )
    expect(deletes).toHaveLength(1)
    expect((await read(String(deletes[0]).replace(/NEW\.\w+/g, '?'))).faults).toEqual([
      'SCAN drivers :: is a walk of drivers: neither keyed nor a due range',
    ])
  })
  it('judges a read of a body as it judges any step, whatever a step is named', async () => {
    // A materialized body, scanned once for each run of a walk: every task of the queue,
    // once for each running run of it.
    const scannedBody = await read(
      `with s as materialized (select task_id from tasks where queue = ?)
       select r.run_id from runs r, s
       where r.queue = ? and r.state = ? and s.task_id > r.task_id`,
    )
    // A grouped subquery, reached through an automatic index once for each run of the walk.
    const indexedBody = await read(
      `select r.run_id, s.c from runs r
       join (select task_id, count(*) c from checkpoints group by task_id) s
         on s.task_id = r.task_id
       where r.queue = ? and r.state = ?`,
    )
    expect([scannedBody, indexedBody].map((reading) => reading.faults)).toEqual([
      expect.arrayContaining([
        expect.stringMatching(/^SCAN s :: is not keyed, and runs once for each row of SEARCH r /),
      ]),
      expect.arrayContaining([
        expect.stringMatching(
          /^SEARCH s USING AUTOMATIC COVERING INDEX \(task_id=\?\) :: is not keyed, /,
        ),
      ]),
    ])
    // A table whose alias is a body's name reads as the same table does under any other
    // alias. The body `r` stands first in the plan, and the table inside the EXISTS walks
    // the running runs of a queue once for each row outside it.
    const faultsUnder = async (body: string, alias: string) => {
      const reading = await read(
        `with r as materialized (select task_id, queue from runs where ${body})
         select t.task_id from r, tasks t where t.task_id = r.task_id
           and exists (select 1 from runs ${alias}
                       where ${alias}.queue = t.queue and ${alias}.state = 'running')`,
      )
      return reading.faults.map((fault) =>
        fault.replaceAll(`SEARCH ${alias} `, 'SEARCH the table '),
      )
    }
    // First the body walks a queue, then it is one run by its key.
    for (const body of ['queue = ?', 'run_id = ?']) {
      const underAnotherAlias = await faultsUnder(body, 'x')
      expect(underAnotherAlias, body).toContainEqual(
        expect.stringMatching(
          /^SEARCH the table .* :: is not keyed, and runs once for each row of /,
        ),
      )
      expect(await faultsUnder(body, 'r'), body).toEqual(underAnotherAlias)
    }
  })
  it('fails closed on a plan line it cannot place or read', () => {
    const faultsOf = (...details: [number, number, string][]) =>
      readNests(details.map(([id, parent, detail]) => ({ id, parent, detail }))).faults
    const keyed = 'SEARCH tasks USING PRIMARY KEY (task_id=?)'
    expect({
      aLineItHasNeverSeen: faultsOf([1, 0, 'BLOOM FILTER ON r (task_id=?)']),
      aLineUnderNoLineOfThePlan: faultsOf([1, 0, keyed], [2, 99, 'SCAN runs']),
      aLineUnderASort: faultsOf([1, 0, 'USE TEMP B-TREE FOR ORDER BY'], [2, 1, 'SCAN runs']),
      anIndexLegWithNoStep: faultsOf(
        [1, 0, 'MULTI-INDEX OR'],
        [2, 1, 'INDEX 1'],
        [3, 1, 'INDEX 2'],
        [4, 3, keyed],
      ),
    }).toEqual({
      aLineItHasNeverSeen: ['cannot read the plan line: BLOOM FILTER ON r (task_id=?)'],
      aLineUnderNoLineOfThePlan: ['cannot place the plan line: SCAN runs'],
      aLineUnderASort: ['cannot read what is under: USE TEMP B-TREE FOR ORDER BY'],
      anIndexLegWithNoStep: ['cannot read the rows of: INDEX 1'],
    })
    // A body with no step under it made rows nothing bounds, so a read of it is a walk.
    expect(faultsOf([1, 0, 'CO-ROUTINE x'], [2, 0, keyed], [3, 0, 'SCAN x'])).toEqual([
      'cannot read the rows of: CO-ROUTINE x',
      `SCAN x :: is not keyed, and runs once for each row of ${keyed}`,
    ])
  })

  it('reads a constraint list wherever it stands in its line', async () => {
    // A left join by the primary key: the plan ends that line in LEFT-JOIN, after the list.
    const sql = `select r.run_id, t.task_name from runs r
                 left join tasks t on t.task_id = r.task_id where r.run_id = ?`
    const plan = await planTree(sql, [0])
    expect(plan.map((row) => row.detail)).toContain(
      'SEARCH t USING PRIMARY KEY (task_id=?) LEFT-JOIN',
    )
    expect(readNests(plan)).toEqual({ faults: [], dueDrivers: [] })
  })
})
