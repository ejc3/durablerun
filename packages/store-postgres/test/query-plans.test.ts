import {
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SqlExecutor,
  encodeRollbackTry,
} from '@durablerun/core'
import { Client } from 'pg'
import { expect, it } from 'vitest'
import { compilePostgresPlaceholders } from '../src/placeholders.js'
import { PostgresSchedulerStore } from '../src/store.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * Every shipped update of `tasks` reaches its row through the primary key on PostgreSQL.
 * PostgreSQL turns the follow-on's `IN` into a join driven from the source, so it was
 * keyed while the source was still correlated on the queue, and it is keyed with the queue
 * bound. This holds that, where it used to be a measurement. The statements are recovered
 * from the real operations. Sequential and bitmap scans are disabled for the planning
 * transaction, so a scan of `tasks` that remains is the statement's shape and not a small
 * table's price, and GENERIC_PLAN needs no bind values. The executor refuses a statement without
 * its binds, so the plans are read through a client of their own. This needs a server.
 */
/**
 * The lines of a statement's plan: its generic plan, or with `args` the plan it ran under.
 * Without the two settings a plan over tables this small is the planner's guess at the
 * price of a few rows, and says nothing of how the statement reaches them.
 */
async function planLines(
  client: Client,
  sql: string,
  args?: readonly unknown[],
): Promise<string[]> {
  await client.query('BEGIN')
  try {
    await client.query('SET LOCAL enable_seqscan = off')
    await client.query('SET LOCAL enable_bitmapscan = off')
    const text = compilePostgresPlaceholders(sql).sql
    const plan =
      args === undefined
        ? await client.query(`EXPLAIN (GENERIC_PLAN, COSTS OFF) ${text}`)
        : await client.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${text}`, [
            ...args,
          ])
    return plan.rows.map((row) => String(Object.values(row as object)[0]))
  } finally {
    await client.query('ROLLBACK')
  }
}

it('reaches tasks by an index condition in every shipped task update', async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-task-updates' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen = new Map<string, string>()
    const reached = new Set<string>()
    const recorder: SqlExecutor = {
      batch: (label, statements, control) => {
        for (const st of statements) {
          if (!/^\s*update "tasks"/i.test(st.sql)) continue
          // A label is reached when it sends a task update, whichever label sent that text
          // first: every task update `fail-rollback` sends is one `fail` sends too.
          reached.add(label)
          if (!seen.has(st.sql)) seen.set(st.sql, label)
        }
        return db.raw.batch(label, statements, control)
      },
    }
    const store = new PostgresSchedulerStore(recorder, db.ids)
    let claims = 0
    const claimed = async (name: string, maxAttempts = 1) => {
      const spawned = await store.spawn('q', name, '{}', { maxAttempts })
      claims += 1
      const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
      if (!run || run.taskId !== spawned.taskId) throw new Error(`expected to claim ${name}`)
      return run
    }
    const started = async (name: string, maxAttempts = 1) => {
      const run = await claimed(name, maxAttempts)
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      return run
    }
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
    // A saga (DESIGN.md §3.10): the failure that ends the forward phase places a rollback
    // pass, and a rollback's failed attempt places the next. Each ships a task update that
    // follows the pass, under `fail` and under `fail-rollback`.
    const saga = await started('rolls-back')
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

/**
 * A saga's checkpoints on PostgreSQL. One name is one row of the key. The names under a
 * prefix are found by a test of each name among the task's rows of the key, so a read
 * walks the checkpoints of one task and no more. The other two stores read those names
 * as a range of the key, and this one must not: `checkpoint_name` compares and orders
 * under the database's collation, and under a linguistic one the names that begin
 * `$started:` are not the range from `$started:` to `$started;` (DESIGN.md §3.4). An
 * index that holds only saga names would make the read one seek, and BUILD.md records it
 * with its measurement and what would call for it. What this holds: the walk is keyed by
 * the task, no name is compared by order, and the attempt records are not read at all
 * for a task whose saga never began, which is every read of a plain task's result, nor
 * for one that something other than a rollback's failure ended.
 */
it("walks a saga's names among one task's rows of the key, and reads no attempt record when no saga began", async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-saga-names' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen: { label: string; sql: string; args: unknown[] }[] = []
    const recorder: SqlExecutor = {
      batch: (label, statements, control) => {
        for (const st of statements) seen.push({ label, sql: st.sql, args: [...st.args] })
        return db.raw.batch(label, statements, control)
      },
    }
    const store = new PostgresSchedulerStore(recorder, db.ids)
    let claims = 0
    const started = async (name: string) => {
      const spawned = await store.spawn('q', name, '{}', { maxAttempts: 1 })
      claims += 1
      const [run] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
      if (run?.taskId !== spawned.taskId) throw new Error(`expected to claim ${name}`)
      await store.activate('q', run.runId, run.claimToken, run.claimGen)
      return run
    }
    const completed = await started('completes')
    await store.complete('q', completed.runId, completed.claimToken, '{}')
    const failed = await started('fails')
    await store.fail('q', failed.runId, failed.claimToken, '{}', null)
    /** A task whose one registered step started, and whose failure placed a rollback pass. */
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
      expect(await store.fail('q', forward.runId, forward.claimToken, '{}', null)).toEqual({
        rollingBack: true,
      })
      return forward
    }
    const saga = await rollingBack('rolls-back')
    claims += 1
    const [pass] = await store.claim('q', `worker-${claims}`, { leaseSeconds: 60, limit: 1 })
    if (pass?.taskId !== saga.taskId) throw new Error('expected to claim the rollback pass')
    await store.activate('q', pass.runId, pass.claimToken, pass.claimGen)
    await store.failRollback('q', pass.runId, pass.claimToken, '{}', null, {
      key: `${SAGA_TRIES_PREFIX}a`,
      stateJson: encodeRollbackTry({ tries: 1, errorJson: '{"name":"R"}' }),
    })
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
    // The check can say no: to a read with no task bound, and to a name compared by order.
    expect(
      notKeyed(
        await planLines(
          client,
          "SELECT 1 FROM checkpoints ss WHERE substr(ss.checkpoint_name, 1, 9) = '$started:'",
        ),
      ),
    ).toHaveLength(1)
    expect(
      notKeyed(
        await planLines(
          client,
          "SELECT 1 FROM checkpoints ss WHERE ss.task_id = ? AND ss.checkpoint_name >= '$started:' AND ss.checkpoint_name < '$started;'",
        ),
      ),
    ).toHaveLength(1)
    // Nor to a name ordered by. The key's own order serves such an ORDER BY with no sort, so
    // no line of the plan shows it.
    expect(
      notKeyed(
        await planLines(
          client,
          "SELECT st.state FROM checkpoints st WHERE st.task_id = ? AND substr(st.checkpoint_name, 1, 16) = '$rollback-tries:' ORDER BY st.checkpoint_name LIMIT 1",
        ),
      ),
    ).toHaveLength(1)
    const faults: string[] = []
    const reached = new Set<string>()
    for (const st of new Map(seen.map((sent) => [sent.sql, sent])).values()) {
      if (!/\bcheckpoints (sp|ss|sr|st)\b/.test(st.sql)) continue
      reached.add(st.label)
      for (const fault of notKeyed(await planLines(client, st.sql)))
        faults.push(`[${st.label}] ${fault}`)
    }
    expect(faults.join('\n')).toBe('')
    expect(
      ['complete', 'fail', 'fail-rollback', 'task-result'].filter((l) => !reached.has(l)),
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
