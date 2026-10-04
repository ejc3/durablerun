import { SAGA_STARTED_PREFIX, type SqlExecutor, type SqlStatement } from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { Client } from 'pg'
import { expect, it } from 'vitest'
import { operatorReads } from '../src/operator-reads.js'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { PostgresSchedulerStore } from '../src/store.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * The lines of a statement's plan: its generic plan, which needs no bind values, or with
 * `args` the plan it ran under. Sequential and bitmap scans are disabled for the planning
 * transaction. Without that, a plan over tables this small is the planner's guess at the
 * price of a few rows, and says nothing of how the statement reaches them. The executor
 * refuses a statement without its binds, so plans are read through a client of their own.
 */
async function planLines(
  client: Client,
  sql: string,
  args?: readonly unknown[],
): Promise<string[]> {
  return planning(client, () => explained(client, sql, args))
}

/** A transaction that plans with sequential and bitmap scans disabled, and is rolled back. */
async function planning<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL enable_seqscan = off')
    await client.query('SET LOCAL enable_bitmapscan = off')
    return await work()
  } finally {
    await client.query('ROLLBACK')
  }
}

/** One statement's plan lines inside the transaction of `planning`. With `args` it also runs. */
async function explained(
  client: Client,
  sql: string,
  args?: readonly unknown[],
): Promise<string[]> {
  const text = compilePostgresPlaceholders(sql).sql
  const plan =
    args === undefined
      ? await client.query(`EXPLAIN (GENERIC_PLAN, COSTS OFF) ${text}`)
      : await client.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${text}`, [
          ...args,
        ])
  return plan.rows.map((row) => String(Object.values(row as object)[0]))
}

type TestDb = Awaited<ReturnType<typeof openPostgresTestDb>>

/**
 * A store over `db` that hands `record` every statement it sends, and the moves both cases
 * below make with it. Each claim is made under a worker name of its own.
 */
function driving(db: TestDb, record: (label: string, statement: SqlStatement) => void) {
  const recorder: SqlExecutor = {
    batch: (label, statements, control) => {
      for (const statement of statements) record(label, statement)
      return db.raw.batch(label, statements, control)
    },
  }
  const store = new PostgresSchedulerStore(recorder, db.ids)
  let claims = 0
  const claimNext = async (taskId: string, what: string) => {
    claims += 1
    const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
    if (run?.taskId !== taskId) throw new Error(`expected to claim ${what}`)
    return run
  }
  /** Spawn a task, and claim its run. */
  const claimed = async (name: string, maxAttempts = 1) => {
    const spawned = await store.spawn('q', name, '{}', { maxAttempts })
    return claimNext(spawned.taskId, name)
  }
  /** Spawn a task, claim its run, and activate it. */
  const started = async (name: string, maxAttempts = 1) => {
    const run = await claimed(name, maxAttempts)
    await store.activate('q', run.runId, run.claimToken, run.claimGen)
    return run
  }
  /**
   * A saga (DESIGN.md §3.10): a task whose one registered step started, and whose failure
   * ended the forward phase and placed a rollback pass.
   */
  const rollingBack = async (name: string) => {
    const forward = await started(name)
    await store.setCheckpoint(
      'q',
      forward.taskId,
      forward.runId,
      forward.claimToken,
      `${SAGA_STARTED_PREFIX}a`,
      '1',
      60,
    )
    const entered = await store.fail('q', forward.runId, forward.claimToken, '{}', null)
    if (!entered.rollingBack) throw new Error('expected the failure to place a rollback pass')
    return forward
  }
  /** Claim and activate the rollback pass of a task that is rolling back. */
  const passOf = async (taskId: string) => {
    const pass = await claimNext(taskId, 'the rollback pass')
    await store.activate('q', pass.runId, pass.claimToken, pass.claimGen)
    return pass
  }
  /** A failed rollback of step a, as the port takes it. */
  const tried = (errorJson = '{}') => ({ stepKey: 'a', errorJson })
  return { store, claimed, started, rollingBack, passOf, tried }
}

/**
 * Every shipped update of `tasks` reaches its row through the primary key on PostgreSQL.
 * PostgreSQL turns the follow-on's `IN` into a join driven from the source, so it was
 * keyed while the source was still correlated on the queue, and it is keyed with the queue
 * bound. This holds that, where it used to be a measurement. The statements are recovered
 * from the real operations, and a scan of `tasks` that remains under `planLines` is the
 * statement's shape and not a small table's price. This needs a server.
 */
it('reaches tasks by an index condition in every shipped task update', async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-task-updates' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen = new Map<string, string>()
    const reached = new Set<string>()
    const { store, claimed, started, rollingBack, passOf, tried } = driving(
      db,
      (label, statement) => {
        if (!/^\s*update "tasks"/i.test(statement.sql)) return
        // A label is reached when it sends a task update, whichever label sent that text
        // first: every task update `fail-rollback` sends is one `fail` sends too.
        reached.add(label)
        if (!seen.has(statement.sql)) seen.set(statement.sql, label)
      },
    )
    const deferred = await claimed('deferred')
    await store.deferLaunch('q', deferred.runId, deferred.claimToken, deferred.claimGen, 3600)
    const waiting = await started('waiting')
    await store.awaitEvent('q', waiting.taskId, waiting.runId, waiting.claimToken, 's', 'e', null)
    const completed = await started('completes')
    await store.complete('q', completed.runId, completed.claimToken, '{}')
    const retried = await started('retries', 2)
    await store.fail('q', retried.runId, retried.claimToken, '{}', { delaySeconds: 3600 })
    const failed = await started('fails')
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    // The failure that ends a saga's forward phase places a rollback pass, and a rollback's
    // failed attempt places the next. Each ships a task update that follows the pass, under
    // `fail` and under `fail-rollback`.
    const saga = await rollingBack('rolls-back')
    const firstPass = await passOf(saga.taskId)
    const again = await store.failRollback(
      'q',
      firstPass.runId,
      firstPass.claimToken,
      '{}',
      { delaySeconds: 0 },
      tried(),
    )
    if (!again.rollingBack) throw new Error('expected the failed rollback to place another pass')
    const lastPass = await passOf(saga.taskId)
    await store.failRollback('q', lastPass.runId, lastPass.claimToken, '{}', null, tried())
    await store.cancelTask('q', waiting.taskId)
    const labels = reached
    expect(
      [
        'claim',
        'activate',
        'defer-launch',
        'await-event',
        'complete',
        'fail',
        'fail-rollback',
        'cancel-task',
      ].filter((label) => !labels.has(label)),
    ).toEqual([])

    await client.query(`SET search_path TO "${db.schemaName}"`)
    const walksEveryTask = async (sql: string) => {
      const lines = await planLines(client, sql)
      const scan = lines.findIndex((line) => /Scan\b.* on tasks\b/.test(line))
      return scan < 0 || !/^Index Cond:/.test((lines[scan + 1] ?? '').trim())
    }
    // The check can say no: a task update by a column that has no index walks every task.
    expect(await walksEveryTask('UPDATE tasks SET state = state WHERE task_name = ?')).toBe(true)
    const walks: string[] = []
    for (const [sql, label] of seen) if (await walksEveryTask(sql)) walks.push(label)
    expect(walks).toEqual([])
    expect(seen.size).toBeGreaterThanOrEqual(8)
  } finally {
    await client.end()
    await db.close()
  }
})

/** Copy one running run and its task `count` times, each copy with its own ids, token and stamp. */
async function cloneRunning(
  client: Client,
  schema: string,
  run: { runId: string; taskId: string },
  count: number,
) {
  const copies: [string, string, string, Record<string, string>][] = [
    [
      'tasks',
      'task_id',
      run.taskId,
      {
        task_id: "'held-task-' || seq.n",
        idempotency_key: 'NULL',
        last_attempt_run: "'held-run-' || seq.n",
        fence_stamp: "'held-task-stamp-' || seq.n",
      },
    ],
    [
      'runs',
      'run_id',
      run.runId,
      {
        run_id: "'held-run-' || seq.n",
        task_id: "'held-task-' || seq.n",
        claimed_by: "'another-worker-' || seq.n",
        fence_stamp: "'held-stamp-' || seq.n",
      },
    ],
  ]
  for (const [table, key, id, replaced] of copies) {
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    )
    const names = columns.rows.map((row) => String((row as { column_name: string }).column_name))
    const copied = await client.query(
      `INSERT INTO ${table} (${names.join(', ')})
       SELECT ${names.map((name) => replaced[name] ?? `src.${name}`).join(', ')}
       FROM ${table} src, generate_series(1, ${count}) AS seq(n) WHERE src.${key} = $1`,
      [id],
    )
    expect(copied.rowCount).toBe(count)
  }
}

/**
 * What a statement's plan says of its scans of `runs`: how many of them ran, and each one
 * that returned and discarded more rows than a claim's one run bounds. A scan that never
 * ran read nothing, and says nothing of what it would read, so it is not counted as one
 * that was judged.
 */
function scansOfRuns(lines: readonly string[]): { ran: number; backlog: string[] } {
  let ran = 0
  const backlog: string[] = []
  lines.forEach((line, at) => {
    if (!/Scan\b.* on runs\b/.test(line) || line.includes('never executed')) return
    ran += 1
    const actual = /actual rows=([\d.]+) loops=(\d+)/.exec(line)
    const loops = Number(actual?.[2] ?? 0)
    // What the scan discarded is printed under it, ahead of the next node of the plan.
    const under = lines.slice(at + 1)
    const next = under.findIndex((other) => /->|SubPlan|InitPlan/.test(other))
    const removed = (next < 0 ? under : under.slice(0, next))
      .map((other) => /Rows Removed by Filter: (\d+)/.exec(other)?.[1])
      .find((count) => count !== undefined)
    const read = (Number(actual?.[1] ?? 0) + Number(removed ?? 0)) * loops
    if (read > 20) backlog.push(`${line.trim()} read ${read} rows`)
  })
  return { ran, backlog }
}

it('counts no scan of runs that never ran, and reads what a scan returned and what it discarded', () => {
  // The delete of timed-out waits as PostgreSQL planned it beside an empty `waits`: driven
  // from `waits`, so neither scan of `runs` ran. Judged as read, it would pass whatever it
  // would have read, which is how the pin once held three statements and said four.
  expect(
    scansOfRuns([
      'Delete on waits (actual rows=0 loops=1)',
      '  ->  Nested Loop Semi Join (actual rows=0 loops=1)',
      '        ->  Index Scan using waits_pkey on waits (actual rows=0 loops=1)',
      '        ->  Index Scan using runs_held on runs f (never executed)',
      '              SubPlan 1',
      '                ->  Index Scan using runs_pkey on runs f_1 (never executed)',
    ]),
  ).toEqual({ ran: 0, backlog: [] })
  // The same delete with the claim token left out of it, beside 300 running runs.
  expect(
    scansOfRuns([
      '        ->  Index Scan using runs_poll on runs f (actual rows=1 loops=1)',
      "              Index Cond: ((queue = 'q'::text) AND (state = 'running'::text))",
      '              Rows Removed by Filter: 301',
      '        ->  Index Scan using waits_pkey on waits (actual rows=0 loops=1)',
    ]),
  ).toEqual({
    ran: 1,
    backlog: ['->  Index Scan using runs_poll on runs f (actual rows=1 loops=1) read 302 rows'],
  })
})

/**
 * What a claim reads of `runs` on PostgreSQL, beside running runs that other workers hold.
 * A queue's running runs are its work in flight, and a claim that reads them pays for them
 * on every tick: one claim measured 64 ms beside 100,000 running runs against 7 ms beside
 * none, in the held guard of the compare-and-set, twice in the task follow-on, in the
 * delete of timed-out waits once `waits` holds rows, and in the receipt read. This holds
 * the property and not an index's name: every scan of `runs`, in each of the four
 * statements, returns and discards a number of rows that the claim's one run bounds, while
 * three hundred runs are running beside it. The statements are the ones a real claim
 * sent, run again under its binds in one transaction that is rolled back, with a run due
 * and the claim's token holding nothing, so the held guard has every running run to
 * search. PostgreSQL matches a partial index to `state = $n` only when it plans with the
 * value, which it does for the unnamed statements the executor sends, so the plan is read
 * with the values and never as a generic plan. This needs a server.
 */
it('reads of runs no more than a claim takes, beside the running runs other workers hold', async () => {
  const OTHERS = 300
  const db = await openPostgresTestDb({ idNamespace: 'plan-claim-reads' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await client.query(`SET search_path TO "${db.schemaName}"`)
    const claims: SqlStatement[] = []
    const { store, started } = driving(db, (label, statement) => {
      if (label === 'claim') claims.push(statement)
    })
    await cloneRunning(client, db.schemaName, await started('held-by-another-worker'), OTHERS)
    // One parked wait. With `waits` empty the delete of timed-out waits never reaches
    // `runs`, and its scans would be judged without having run.
    const parked = await started('parked-on-an-event')
    await store.awaitEvent('q', parked.taskId, parked.runId, parked.claimToken, 's', 'e', null)
    await client.query('ANALYZE runs, tasks')
    // The claim whose statements run again. Its run completes first, so its token holds
    // nothing when those statements claim the next due run under it.
    const mine = await started('claimed-and-completed')
    await store.complete('q', mine.runId, mine.claimToken, '{}')
    const shipped = claims.slice(-4)
    const head = (sql: string) => sql.trim().split(/\s+/).slice(0, 2).join(' ')
    expect(shipped.map((statement) => head(statement.sql))).toEqual([
      'update "runs"',
      'update "tasks"',
      'delete from',
      'select "r"."run_id",',
    ])
    await store.spawn('q', 'due', '{}')

    const backlogReads: string[] = []
    const scansThatRan: number[] = []
    await planning(client, async () => {
      for (const statement of shipped) {
        const judged = scansOfRuns(await explained(client, statement.sql, statement.args))
        scansThatRan.push(judged.ran)
        for (const scan of judged.backlog) backlogReads.push(`${head(statement.sql)} -> ${scan}`)
      }
    })
    // Each of the four statements ran a scan of `runs`. One whose scans never ran would
    // pass by having read nothing, as the delete did while `waits` was empty.
    expect(scansThatRan).toHaveLength(4)
    expect(scansThatRan.filter((count) => count === 0)).toEqual([])
    expect(
      backlogReads,
      'mutation-verdict:behavior:postgres-claim-followons-name-the-token',
    ).toEqual([])
  } finally {
    await client.end()
    await db.close()
  }
})

/**
 * A saga's checkpoints on PostgreSQL. One name is one row of the key. The names under a
 * prefix are found by a test of each name among the task's rows of the key, so a read
 * walks the checkpoints of one task and no more. The other two stores read those names
 * as a range of the key, and this one must not: `checkpoint_name` compares and orders
 * under the database's collation, and under a linguistic one the names that begin
 * `$started:` are not the range from `$started:` to `$started;` (DESIGN.md §3.4). An
 * index that holds only saga names would make the read one seek, and BUILD.md records it
 * with its measurement and what would call for it. What this holds, of the statements
 * that read checkpoints under one of the four saga aliases: the walk is keyed by the
 * task. No checkpoint name is ordered or compared by order: not in an index condition,
 * where the plan shows it, and not in a spelling of the statement's text that the table
 * of controls below says is read. The text is read because an ORDER BY that the key's own
 * order serves shows in no plan. It is a check of spellings, and the table lists the ones
 * it misses.
 * And the attempt records are not read at all for a task whose saga never began, which
 * is every read of a plain task's result, nor for one that a cancellation ended. They
 * are read for every other failed task whose saga began.
 */
it("walks a saga's names among one task's rows of the key, and reads no attempt record when no saga began", async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-saga-names' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const { store, started, rollingBack, passOf, tried } = driving(db, (label, statement) =>
      seen.push({ label, sql: statement.sql, args: [...statement.args] }),
    )
    const completed = await started('completes')
    await store.complete('q', completed.runId, completed.claimToken, '{}')
    const failed = await started('fails')
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    // A child spawn tests its parent's phase, under the parent's live claim. The child lives
    // in a queue of its own, so no claim below takes it.
    const parent = await started('spawns-a-child')
    await store.spawn('kids', 'child', '{}', {
      childOf: {
        parentQueue: 'q',
        parentTaskId: parent.taskId,
        runId: parent.runId,
        claimToken: parent.claimToken,
        replayKey: '$spawn:child',
      },
    })
    await store.complete('q', parent.runId, parent.claimToken, '{}')
    const saga = await rollingBack('rolls-back')
    const pass = await passOf(saga.taskId)
    await store.failRollback('q', pass.runId, pass.claimToken, '{}', null, tried('{"name":"R"}'))
    const cancelled = await rollingBack('cancelled-in-the-phase')
    expect(await store.cancelTask('q', cancelled.taskId)).toBe(true)
    const resultReadOf = async (taskId: string) => {
      const before = seen.length
      const result = await store.getTaskResult('q', taskId)
      const read = seen.slice(before).find((st) => st.label === 'task-result')
      if (read === undefined) throw new Error('the result read sent no statement')
      return { result, read }
    }
    const reads = {
      completed: await resultReadOf(completed.taskId),
      failed: await resultReadOf(failed.taskId),
      cancelled: await resultReadOf(cancelled.taskId),
      saga: await resultReadOf(saga.taskId),
    }
    expect(reads.saga.result?.rollback).toEqual({ outcome: 'failed', errorJson: '{"name":"R"}' })

    await client.query(`SET search_path TO "${db.schemaName}"`)
    /** The saga reads of a plan that are not keyed as this store's are. */
    const notKeyed = (lines: readonly string[]) =>
      lines.flatMap((line, at) => {
        const scan = / on checkpoints (sp|ss|sr|st)\b/.exec(line)
        if (scan === null) return []
        const condition = (lines[at + 1] ?? '').trim()
        const keyed =
          scan[1] === 'sp' || scan[1] === 'sr'
            ? /^Index Cond: \(\(task_id = .*\) AND \(checkpoint_name = .*\)\)$/.test(condition)
            : /^Index Cond: \(task_id = [^()]*\)$/.test(condition)
        return /Index (Only )?Scan using checkpoints_pkey /.test(line) && keyed
          ? []
          : [`${line.trim()} :: ${condition}`]
      })
    /**
     * What a statement's text says of a checkpoint name's order. An ORDER BY on a name that
     * the key's own order serves plans with no sort, and a comparison outside the index
     * condition is a filter like any other, so no line of a plan shows either. This reads
     * text, so it sees spellings: the table of controls below says which it refuses, which
     * it passes and which it misses. An operator is a whole run of operator characters, so
     * `->>`, `@>` and `<>` beside a name are no comparison by order, and an ORDER BY is read
     * up to the clause that ends it, so a name mentioned after it is not ordered by it.
     */
    const OPERATOR = '[-+*/<>=~!@#%^&|]'
    const BY_ORDER = `(?<!${OPERATOR})(?:<=|>=|<|>)(?!${OPERATOR})`
    const ENDS_AN_ORDER_BY =
      'limit|offset|fetch|for|returning|union|intersect|except|on\\s+conflict'
    const ordersAName = (sql: string) =>
      [
        `\\border\\s+by\\b(?:(?!\\b(?:${ENDS_AN_ORDER_BY})\\b)[^)])*?\\bcheckpoint_name\\b`,
        `\\bcheckpoint_name"?\\s*(?:${BY_ORDER}|(?:not\\s+)?between\\b)`,
        `${BY_ORDER}\\s*(?:"?\\w+"?\\.)?"?checkpoint_name\\b`,
      ]
        .flatMap((spelling) => [...sql.matchAll(new RegExp(spelling, 'gi'))])
        .map((found) => `its text orders a name: ${found[0].replace(/\s+/g, ' ')}`)
    const faultsOf = async (sql: string) => [
      ...notKeyed(await planLines(client, sql)),
      ...ordersAName(sql),
    ]
    // Each check can say no, and this table says what each one sees. The plan cannot see an
    // ORDER BY, because the key's own order serves one with no sort, and that is why the
    // text is read. The text check refuses the first group. It passes the second, where an
    // operator beside a name is no comparison by order and an ORDER BY ends before a later
    // mention of the name. It misses the third, each of which orders a name or compares one
    // by order, so no test catches a change that writes one.
    const TRIES =
      "SELECT st.state FROM checkpoints st WHERE st.task_id = ? AND substr(st.checkpoint_name, 1, 16) = '$rollback-tries:'"
    const UNBOUND =
      "SELECT 1 FROM checkpoints ss WHERE substr(ss.checkpoint_name, 1, 9) = '$started:'"
    const RANGED =
      "SELECT 1 FROM checkpoints ss WHERE ss.task_id = ? AND ss.checkpoint_name >= '$started:' AND ss.checkpoint_name < '$started;'"
    const ORDERED = `${TRIES} ORDER BY st.checkpoint_name LIMIT 1`
    const text: Record<'refuses' | 'passes' | 'misses', Record<string, string>> = {
      refuses: {
        ranged: RANGED,
        ordered: ORDERED,
        reversed: `${TRIES} AND '$rollback-tries:' <= st.checkpoint_name`,
        notBetween: `${TRIES} AND st.checkpoint_name NOT BETWEEN '$rollback-tries:' AND '$rollback-tries;'`,
      },
      passes: {
        equal:
          "SELECT 1 FROM checkpoints sr WHERE sr.task_id = ? AND sr.checkpoint_name = ? AND sr.checkpoint_name <> '$rolling-back'",
        jsonArrows:
          'SELECT st.state::jsonb ->> st.checkpoint_name FROM checkpoints st WHERE st.task_id = ? AND st.state::jsonb @> st.checkpoint_name::jsonb',
        upsertAfterAnOrderBy:
          "INSERT INTO checkpoints (task_id, checkpoint_name) SELECT st.task_id, '$x' FROM checkpoints st WHERE st.task_id = ? ORDER BY st.owner_attempt DESC LIMIT 1 ON CONFLICT (task_id, checkpoint_name) DO NOTHING",
      },
      misses: {
        orderedBehindAParenthesis: `${TRIES} ORDER BY (st.owner_attempt), st.checkpoint_name LIMIT 1`,
        rowComparison: `${TRIES} AND (st.task_id, st.checkpoint_name) >= (st.task_id, '$rollback-tries:')`,
        collated: `${TRIES} AND st.checkpoint_name COLLATE "und-x-icu" < '~'`,
        least: 'SELECT MIN(st.checkpoint_name) FROM checkpoints st WHERE st.task_id = ?',
      },
    }
    const seenByTheText = (group: Record<string, string>) =>
      Object.entries(group).flatMap(([name, sql]) => (ordersAName(sql).length > 0 ? [name] : []))
    expect({
      planRefuses: {
        unbound: notKeyed(await planLines(client, UNBOUND)).length,
        ranged: notKeyed(await planLines(client, RANGED)).length,
      },
      planCannotSee: { ordered: notKeyed(await planLines(client, ORDERED)).length },
      textRefuses: seenByTheText(text.refuses),
      textPasses: seenByTheText(text.passes),
      textMisses: seenByTheText(text.misses),
    }).toEqual({
      planRefuses: { unbound: 1, ranged: 1 },
      planCannotSee: { ordered: 0 },
      textRefuses: ['ranged', 'ordered', 'reversed', 'notBetween'],
      textPasses: [],
      textMisses: [],
    })
    const faults: string[] = []
    const reached = new Set<string>()
    for (const st of new Map(seen.map((sent) => [sent.sql, sent])).values()) {
      if (!/\bcheckpoints (sp|ss|sr|st)\b/.test(st.sql)) continue
      reached.add(st.label)
      for (const fault of await faultsOf(st.sql)) faults.push(`[${st.label}] ${fault}`)
    }
    expect(faults.join('\n')).toBe('')
    expect(
      ['complete', 'fail', 'fail-rollback', 'spawn', 'task-result'].filter((l) => !reached.has(l)),
    ).toEqual([])
    // The attempt records are read for the saga that halted, and for no task whose saga
    // never began.
    const attemptRecordsRead: Record<string, boolean> = {}
    for (const [which, { read }] of Object.entries(reads)) {
      const scan = (await planLines(client, read.sql, read.args)).find((line) =>
        / on checkpoints st\b/.test(line),
      )
      if (scan === undefined)
        throw new Error(`the result read of ${which} plans no attempt record read`)
      attemptRecordsRead[which] = !scan.includes('never executed')
    }
    expect(
      attemptRecordsRead,
      'mutation-verdict:behavior:saga-postgres-attempt-records-read-only-for-a-halt',
    ).toEqual({ completed: false, failed: false, cancelled: false, saga: true })
  } finally {
    await client.end()
    await db.close()
  }
})

/**
 * How each statement a recorder saw reaches its rows, planned with sequential and bitmap
 * scans disabled: every index scan with its condition, and every scan of a table that
 * remains, which is a table no index of the statement reaches. `meta` is left out of both.
 */
async function indexesAndScans(client: Client, recorder: RecordingExecutor) {
  const reached: Record<string, string[]> = {}
  const scans: string[] = []
  const seen = recorder.batches.flatMap(({ label, statements }) =>
    statements.map((sql, index) => ({ name: `${label}#${index}`, sql })),
  )
  for (const { name, sql } of seen) {
    const lines = await planLines(client, sql)
    reached[name] = lines.flatMap((line, at) => {
      const found = /Index (?:Only )?Scan using (\w+) on (\w+(?: \w+)?)/.exec(line)
      if (found === null || /^meta\b/.test(found[2] ?? '')) return []
      const condition = /^Index Cond: (.*)$/.exec((lines[at + 1] ?? '').trim())
      return [`${found[1]} on ${found[2]}: ${condition?.[1] ?? 'no condition'}`]
    })
    scans.push(
      ...lines
        .filter((line) => /Seq Scan|Bitmap/.test(line) && !/ on meta\b/.test(line))
        .map((line) => `[${name}] ${line.trim()}`),
    )
  }
  return { reached, scans }
}

/**
 * An operator's reads reach every row by a key. Each statement is recorded from a real
 * read of a parked task, and planned with sequential and bitmap scans disabled, so a scan
 * that remains is a table no index of the statement reaches. Every index scan is pinned
 * with its condition: the task and its saga's names by their keys, the task's runs by the
 * index on a task's ordinals, a run's waits by the head of their key, an event by its key,
 * and a keyed task by the index on a queue's keys. This needs a server.
 *
 * `meta` is left out of both checks, and with it the one statement that reads nothing
 * else, whether the test clock is set. It holds a handful of rows, and schema version 7
 * changes the collation of its key, which rebuilds that index over rows the migrations
 * updated in place. PostgreSQL does not use an index built that way while a transaction
 * older than the build is open. So on a database a test migrated a moment ago, beside
 * other tests, a read of `meta` plans as an index scan in one run and as a scan of the
 * table in the next, and its plan says when the database was migrated and not how a
 * statement reaches its rows. The same holds on a deployed database only until the
 * transactions that were open at its migration have ended.
 */
it("reaches every row an operator's read takes by a key, and scans no table", async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-operator-reads' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const recorder = new RecordingExecutor(db.raw)
    const store = new PostgresSchedulerStore(db.raw, db.ids)
    const task = await store.spawn('q', 'job', '{}', { idempotencyKey: 'order-7' })
    const [run] = await store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
    if (run?.taskId !== task.taskId) throw new Error('expected to claim the keyed task')
    await store.activate('q', run.runId, run.claimToken, run.claimGen)
    await store.awaitEvent('q', run.taskId, run.runId, run.claimToken, 'approve', 'approval', 60)
    const reads = operatorReads(recorder)
    expect((await reads.taskFacts('q', task.taskId))?.waits).toHaveLength(1)
    expect(await reads.taskIdByKey('q', 'order-7')).toBe(task.taskId)
    expect((await reads.eventState('q', 'approval')).exists).toBe(false)

    await client.query(`SET search_path TO "${db.schemaName}"`)
    const { reached, scans } = await indexesAndScans(client, recorder)
    expect(scans).toEqual([])
    const sagaPhase = "((task_id = tasks.task_id) AND (checkpoint_name = '$rolling-back'::text))"
    expect(reached).toEqual({
      'task-facts#0': [
        'tasks_pkey on tasks: (task_id = $1)',
        // The rollback outcome: the phase marker, then the saga's names among this task's
        // rows of the key, as `task-result` reads them.
        `checkpoints_pkey on checkpoints sp: ${sagaPhase}`,
        'checkpoints_pkey on checkpoints ss: (task_id = tasks.task_id)',
        "checkpoints_pkey on checkpoints sr: ((task_id = tasks.task_id) AND (checkpoint_name = ('$rollback:'::text || substr(ss.checkpoint_name, 10))))",
        `checkpoints_pkey on checkpoints sp_1: ${sagaPhase}`,
        'checkpoints_pkey on checkpoints st: (task_id = tasks.task_id)',
        // Whether the saga began.
        `checkpoints_pkey on checkpoints sp_2: ${sagaPhase}`,
      ],
      'task-facts#1': [
        'runs_task_attempt on runs r: (task_id = $1)',
        'events_pkey on events e: ((queue = r.queue) AND (event_name = r.wake_event))',
      ],
      'task-facts#2': [
        'runs_task_attempt on runs r: (task_id = $1)',
        'waits_pkey on waits w: (run_id = r.run_id)',
        'events_pkey on events e: ((queue = w.queue) AND (event_name = w.event_name))',
      ],
      // It reads `meta` and nothing else.
      'fake-clock#0': [],
      'task-id-by-key#0': ['tasks_idem on tasks: ((queue = $1) AND (idempotency_key = $2))'],
      'event-state#0': ['events_pkey on events: ((queue = $1) AND (event_name = $2))'],
    })
  } finally {
    await client.end()
    await db.close()
  }
})

/**
 * An operator's reads of a queue. Each leg of `stuck-runs` and of `queue-status` reaches
 * its rows through the index that hands them out in the order of their instant, and the
 * waiters of an event through the index on a queue's events. A count of `table-rows`
 * reads the rows it counts: through an index that leads with the queue where the table has
 * one, and by a scan of the table where it has none, which is `tasks` and `checkpoints`.
 * Planned as the case above plans, and with `meta` left out for its reason. This needs a
 * server.
 */
it("reads a queue for an operator through the index of each leg's instant, and scans a table only to count its rows", async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-operator-queue-reads' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const recorder = new RecordingExecutor(db.raw)
    const store = new PostgresSchedulerStore(db.raw, db.ids)
    await store.spawn('q', 'job', '{}', { cancellation: { maxDelaySeconds: 30 } })
    const reads = operatorReads(recorder)
    const owed = await reads.stuckRuns('q', { graceSeconds: 0, limit: 10 })
    expect(owed.dueUnclaimed.rows).toHaveLength(1)
    expect((await reads.queueStatus('q')).gauges.pendingRuns.count).toBe(1)
    expect((await reads.tableRows('q')).tables.tasks.count).toBe(1)
    expect((await reads.eventWaiters('q', 'approval')).waiters.rows).toEqual([])
    const oldest = await reads.agedTasks('q', { olderThanSeconds: 0, limit: 10 })
    expect(oldest.tasks.rows).toHaveLength(1)

    await client.query(`SET search_path TO "${db.schemaName}"`)
    const { reached, scans } = await indexesAndScans(client, recorder)
    const counts = Object.keys(reached).filter((name) => name.startsWith('table-rows#'))
    // The legs and the gauges, by the index each table is reached through. The first index
    // of a statement is the one that hands its rows out. A leg's conditions are left out:
    // they are the engine's own bounds on an instant, and the cases above pin those where
    // the engine sends them.
    const indexOf = (reach: string): string => reach.slice(0, reach.indexOf(':'))
    const liveTasks = (state: string): string =>
      `tasks_live on tasks t: ((queue = $1) AND (state = '${state}'::text) AND (enqueue_at_ms >= '-9223372036854775808'::bigint))`
    const aClaimIsOwed = [
      'runs_poll on runs r',
      'waits_event on waits w_1',
      'tasks_pkey on tasks t',
      'runs_task_attempt on runs sibling',
      'waits_pkey on waits w',
      'runs_task_attempt on runs higher',
    ]
    expect(
      Object.fromEntries(
        Object.entries(reached)
          .filter(([name]) => !counts.includes(name))
          .map(([name, reaches]) => [
            name,
            name.startsWith('stuck-runs#') ? reaches.map(indexOf) : reaches,
          ]),
      ),
    ).toEqual({
      // Pending runs a claim is owed to, then sleeping ones, by their due instant.
      'stuck-runs#0': aClaimIsOwed,
      'stuck-runs#1': aClaimIsOwed,
      // Runs under a lapsed lease, by the index of held runs.
      'stuck-runs#2': [
        'runs_held on runs r',
        'runs_task_attempt on runs sibling',
        'runs_task_attempt on runs higher',
        'tasks_pkey on tasks t',
      ],
      // Tasks past their deadline, by the index of deadlines.
      'stuck-runs#3': ['tasks_cancel on tasks t', 'runs_task_attempt on runs ownership_run'],
      // The clock, which reads `meta` and nothing else.
      'stuck-runs#4': [],
      'queue-status#0': [
        "runs_poll on runs r: ((queue = $1) AND (state = 'pending'::text) AND (available_at_ms IS NOT NULL))",
      ],
      'queue-status#1': [
        "runs_poll on runs r: ((queue = $1) AND (state = 'sleeping'::text) AND (available_at_ms IS NOT NULL))",
      ],
      'queue-status#2': ['runs_lease on runs r: (queue = $1)'],
      'queue-status#3': ['tasks_cancel on tasks t: (queue = $1)'],
      'queue-status#4': [],
      // The live tasks of each state, by the index of live tasks, which the comparison of
      // the enqueue instant lets the planner use: for the gauge of them, and for the read
      // of the oldest.
      'queue-status#5': [liveTasks('pending')],
      'queue-status#6': [liveTasks('running')],
      'queue-status#7': [liveTasks('sleeping')],
      'aged-tasks#0': [liveTasks('pending')],
      'aged-tasks#1': [liveTasks('running')],
      'aged-tasks#2': [liveTasks('sleeping')],
      'aged-tasks#3': [],
      'fake-clock#0': [],
      'event-waiters#0': ['waits_event on waits w: ((queue = $1) AND (event_name = $2))'],
    })
    // The counts. A table with an index that leads with the queue is counted through one,
    // by the queue alone, and which of several such indexes is the planner's choice. `tasks`
    // and `checkpoints` have none, so their count scans the table.
    expect(
      counts.map((name) => [
        name,
        (reached[name] ?? []).map((reach) => reach.replace(/^\w+ on /, '')),
      ]),
    ).toEqual([
      ['table-rows#0', ['runs: (queue = $1)']],
      ['table-rows#1', []],
      ['table-rows#2', ['waits: (queue = $1)']],
      ['table-rows#3', ['events: (queue = $1)']],
      ['table-rows#4', []],
    ])
    expect(scans).toEqual([
      '[table-rows#1] ->  Seq Scan on tasks',
      '[table-rows#4] ->  Seq Scan on checkpoints',
    ])
  } finally {
    await client.end()
    await db.close()
  }
})

/**
 * No statement the engine sends is planned through `tasks_live`, the index of a queue's
 * live tasks by state and enqueue instant, which schema version 11 adds for an operator's
 * reads. Every statement that names a task's queue and its live states could be, because
 * the index leads with both. The index's predicate is what keeps them off it: it requires
 * an enqueue instant, and no statement the engine sends compares one. The statements are
 * recorded from real operations and planned as the cases above plan theirs, with
 * sequential and bitmap scans disabled, which is when a planner with nothing else to go on
 * takes any index it may. This needs a server.
 */
it('plans no statement the engine sends through the index of live tasks, and a read that compares the enqueue instant through it', async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-tasks-live' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen = new Map<string, string>()
    const { store, claimed, started } = driving(db, (label, statement) => {
      const planned = /^\s*(?:select|insert|update|delete|with)\b/i.test(statement.sql)
      if (planned && !seen.has(statement.sql)) seen.set(statement.sql, label)
    })
    const deferred = await claimed('deferred')
    await store.deferLaunch('q', deferred.runId, deferred.claimToken, deferred.claimGen, 3600)
    const waiting = await started('waiting')
    await store.awaitEvent('q', waiting.taskId, waiting.runId, waiting.claimToken, 's', 'e', null)
    const completed = await started('completes')
    await store.heartbeat('q', completed.runId, completed.claimToken, 60)
    await store.getCheckpoints('q', completed.taskId, 1)
    await store.complete('q', completed.runId, completed.claimToken, '{}')
    await store.getTaskResult('q', completed.taskId)
    const retried = await started('retries', 2)
    await store.fail('q', retried.runId, retried.claimToken, '{}', { delaySeconds: 3600 })
    const failed = await started('fails')
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    await store.cancelTask('q', waiting.taskId)
    await store.nextWakeAtEpochMs('q')
    // Last, because it moves the clock: a launch that is lost, and a task that is never
    // started by its deadline, for the sweep to find.
    await claimed('launch-is-lost')
    await store.spawn('q', 'never-starts', '{}', { cancellation: { maxDelaySeconds: 30 } })
    await db.admin.setFakeNowEpochMs(1_000_000 + 120_000)
    expect((await store.sweep('q', 10)).map((swept) => swept.kind).sort()).toEqual([
      'cancelled',
      'lost-launch',
    ])
    await store.emitEvent('q', 'e', '{}')

    await client.query(`SET search_path TO "${db.schemaName}"`)
    const throughIt = async (sql: string) =>
      (await planLines(client, sql)).filter((line) => line.includes('tasks_live'))
    // The check can say yes: the oldest live tasks of one state, which is what the index
    // is for, are read through it.
    expect(
      await throughIt(
        `SELECT t.task_id FROM tasks t
         WHERE t.queue = ? AND t.state IN ('pending','running','sleeping') AND t.state = 'pending'
           AND t.enqueue_at_ms >= -9223372036854775808
         ORDER BY t.enqueue_at_ms LIMIT ?`,
      ),
    ).not.toEqual([])
    const planned: string[] = []
    for (const [sql, label] of seen) {
      planned.push(...(await throughIt(sql)).map((line) => `[${label}] ${line.trim()}`))
    }
    expect(planned).toEqual([])
    expect(seen.size).toBeGreaterThan(40)
  } finally {
    await client.end()
    await db.close()
  }
})
