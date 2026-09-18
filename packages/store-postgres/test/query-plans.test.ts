import type { SqlExecutor } from '@durablerun/core'
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
 * from the real operations. Sequential scans are disabled for the planning transaction,
 * so a scan of `tasks` that remains is the statement's shape and not a small table's
 * price, and GENERIC_PLAN needs no bind values. The executor refuses a statement without
 * its binds, so the plans are read through a client of their own. This needs a server.
 */
it('reaches tasks by an index condition in every shipped task update', async () => {
  const db = await openPostgresTestDb({ idNamespace: 'plan-task-updates' })
  const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
  await client.connect()
  try {
    await db.admin.setFakeNowEpochMs(1_000_000)
    const seen = new Map<string, string>()
    const recorder: SqlExecutor = {
      batch: (label, statements, control) => {
        for (const st of statements) {
          if (/^\s*update "tasks"/i.test(st.sql) && !seen.has(st.sql)) seen.set(st.sql, label)
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
    await store.cancelTask('q', waiting.taskId)
    const labels = new Set(seen.values())
    expect(
      [
        'claim',
        'activate',
        'defer-launch',
        'await-event',
        'complete',
        'fail',
        'cancel-task',
      ].filter((label) => !labels.has(label)),
    ).toEqual([])

    await client.query(`SET search_path TO "${db.schemaName}"`)
    const walksEveryTask = async (sql: string) => {
      await client.query('BEGIN')
      try {
        await client.query('SET LOCAL enable_seqscan = off')
        const plan = await client.query(
          `EXPLAIN (GENERIC_PLAN, COSTS OFF) ${compilePostgresPlaceholders(sql).sql}`,
        )
        const lines = plan.rows.map((row) => String(Object.values(row as object)[0]))
        const scan = lines.findIndex((line) => /Scan\b.* on tasks\b/.test(line))
        return scan < 0 || !/^Index Cond:/.test((lines[scan + 1] ?? '').trim())
      } finally {
        await client.query('ROLLBACK')
      }
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
