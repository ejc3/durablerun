import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemIdSource } from '@durablerun/core'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { afterAll, describe, expect, it } from 'vitest'

const Q = 'chaos'
const SECRET = 'chaos-secret'
const ROOT = join(import.meta.dirname, '../../..')
const children: ChildProcess[] = []

/**
 * Ports unique to this RUN, not fixed constants.
 *
 * These tests spawn real processes on real ports. When a run fails partway
 * its children can outlive it, and the next run then dies on "address in
 * use" — reported as the host exiting early, which reads exactly like the
 * engine bug the test exists to catch. It cost a real debugging detour
 * chasing a regression that was a leftover process. Deriving the base from
 * the pid means a stranded child never collides with the run that follows.
 */
const PORT_BASE = 42_000 + (process.pid % 1_000) * 3

function host(script: string, args: string[]): Promise<ChildProcess> {
  const child = spawn('node', ['--import', 'tsx', join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.once('message', (m) => m === 'ready' && resolve(child))
    child.once('exit', (code) => reject(new Error(`host exited early: ${code}`)))
    setTimeout(() => reject(new Error('host start timeout')), 20_000)
  })
}

afterAll(() => {
  for (const c of children) c.kill('SIGKILL')
})

async function until(cond: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out: ${what}`)
}

/**
 * REAL processes against one SQLite file: a driver and a worker as
 * children of this test, killed with real signals. This is the phase-gate
 * chaos: everything the sims proved, replayed with actual process death.
 */
describe('multi-process chaos (real kills, one database file)', () => {
  it('a task survives kill -9 of its worker mid-step and completes on a replacement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-chaos-'))
    const db = join(dir, 'chaos.db')
    const raw = LibsqlExecutor.open(`file:${db}`)
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const store = new LibsqlSchedulerStore(raw, systemIdSource())

    const workerPort = PORT_BASE
    const worker1 = await host('packages/driver/bin/worker-host.ts', [
      db,
      String(workerPort),
      SECRET,
    ])
    await host('packages/driver/bin/driver-host.ts', [
      db,
      Q,
      `http://127.0.0.1:${workerPort}`,
      SECRET,
    ])

    // A slow multi-step task: plenty of mid-flight surface to murder.
    const spawned = await store.spawn(Q, 'chaos-steps', JSON.stringify({ steps: 20, stepMs: 150 }))
    await until(async () => {
      const [r] = await raw.batch('t', [{ sql: `SELECT COUNT(*) AS n FROM checkpoints`, args: [] }])
      return Number(r?.rows[0]?.n) >= 3
    }, 'first checkpoints committed')

    worker1.kill('SIGKILL') // real process death, mid-step

    // A replacement worker on the same port; the lease machinery recovers.
    await new Promise((r) => setTimeout(r, 300))
    await host('packages/driver/bin/worker-host.ts', [db, String(workerPort), SECRET])
    await until(
      async () => {
        const done = await store.getTaskResult(Q, spawned.taskId)
        return done?.state === 'completed'
      },
      'completion after worker murder',
      60_000,
    )

    const result = await store.getTaskResult(Q, spawned.taskId)
    expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toEqual({ done: 20 })
    // Completed steps never re-ran: exactly 20 work checkpoints exist.
    const [cps] = await raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE checkpoint_name LIKE 'work%'`, args: [] },
    ])
    expect(Number(cps?.rows[0]?.n)).toBe(20)
    // Death was billed to infrastructure, never the user.
    const [task] = await raw.batch('t', [
      {
        sql: `SELECT attempts, infra_retries FROM tasks WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0)
    expect(Number(task?.rows[0]?.infra_retries)).toBeGreaterThanOrEqual(1)
    raw.close()
  }, 120_000)

  it('a task survives kill -9 of its DRIVER and a sleep across the restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-chaos2-'))
    const db = join(dir, 'chaos2.db')
    const raw = LibsqlExecutor.open(`file:${db}`)
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const store = new LibsqlSchedulerStore(raw, systemIdSource())

    const workerPort = PORT_BASE + 1
    await host('packages/driver/bin/worker-host.ts', [db, String(workerPort), SECRET])
    const driver1 = await host('packages/driver/bin/driver-host.ts', [
      db,
      Q,
      `http://127.0.0.1:${workerPort}`,
      SECRET,
    ])

    // A task that checkpoints, sleeps 4s durably, then finishes.
    const spawned = await store.spawn(Q, 'napper', JSON.stringify({ seconds: 4 }))
    await until(async () => {
      const [r] = await raw.batch('t', [
        { sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE checkpoint_name = '$sleep'`, args: [] },
      ])
      return Number(r?.rows[0]?.n) === 1
    }, 'suspended into the durable sleep')

    driver1.kill('SIGKILL') // the scheduler's driver dies while the task sleeps

    await new Promise((r) => setTimeout(r, 500))
    await host('packages/driver/bin/driver-host.ts', [
      db,
      Q,
      `http://127.0.0.1:${workerPort}`,
      SECRET,
    ])
    // The replacement driver wakes the sleeper and finishes the task; the
    // pre-sleep step replays, never re-executes.
    await until(
      async () => {
        return (await store.getTaskResult(Q, spawned.taskId))?.state === 'completed'
      },
      'completion across driver murder + sleep',
      60_000,
    )
    const result = await store.getTaskResult(Q, spawned.taskId)
    expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toBe('rested')
    const [task] = await raw.batch('t', [
      { sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0)
    raw.close()
  }, 120_000)

  it('the dogfood gate: a recurring job lives on the engine across sleeps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-dogfood-'))
    const db = join(dir, 'dogfood.db')
    const raw = LibsqlExecutor.open(`file:${db}`)
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const store = new LibsqlSchedulerStore(raw, systemIdSource())
    const workerPort = PORT_BASE + 2
    await host('packages/driver/bin/worker-host.ts', [db, String(workerPort), SECRET])
    await host('packages/driver/bin/driver-host.ts', [
      db,
      Q,
      `http://127.0.0.1:${workerPort}`,
      SECRET,
    ])

    // Three cycles of work-sleep-work: the continuous-operation shape.
    const spawned = await store.spawn(
      Q,
      'dogfood-backup',
      JSON.stringify({ cycles: 3, intervalSeconds: 2 }),
    )
    await until(
      async () => {
        return (await store.getTaskResult(Q, spawned.taskId))?.state === 'completed'
      },
      'three recurring cycles',
      60_000,
    )
    const [cps] = await raw.batch('t', [
      {
        sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE checkpoint_name LIKE 'backup%'`,
        args: [],
      },
    ])
    expect(Number(cps?.rows[0]?.n)).toBe(3)
    raw.close()
  }, 120_000)
})
