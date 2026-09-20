import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemIdSource } from '@durablerun/core'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { afterAll, describe, expect, it } from 'vitest'

const Q = 'chaos'
const SECRET = 'chaos-secret'
const ROOT = join(import.meta.dirname, '../../..')
const children: ChildProcess[] = []

/** A started host and the port it reported binding, null when it bound none. */
interface Host {
  child: ChildProcess
  port: number | null
}

/** A host that bound a port: every worker host, and a driver host that serves wakes. */
type BoundHost = Host & { port: number }

/** The one message a host sends its parent: it is serving, on this port. */
function isReady(message: unknown): message is { ready: true; port: number | null } {
  if (typeof message !== 'object' || message === null) return false
  const { ready, port } = message as { ready?: unknown; port?: unknown }
  return ready === true && (port === null || (typeof port === 'number' && port > 0))
}

/**
 * Start a host and wait for its ready message. The test picks no port. A host
 * that binds starts on port 0 and reports the port the OS gave it, which is
 * free at the moment it is bound. A driver host given no wake port binds
 * nothing. A replacement worker is the one host started on a port by number:
 * it takes over the port the OS gave the worker it replaces, because the
 * driver was told that URL.
 *
 * A port the test picks can already be taken. A fixed port is held by a child
 * that outlived a run which failed partway. A port derived from the process id
 * is held by a second run on the same machine whose id agrees modulo the
 * range. Either way the host dies on "address in use", which is reported here
 * as the host exiting early, and that reads exactly like the engine bug these
 * tests exist to catch. So the helpers below take a started worker and refuse
 * a bare number.
 */
function host(script: string, args: string[]): Promise<Host> {
  const child = spawn('node', ['--import', 'tsx', join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.once('message', (message) => {
      if (isReady(message)) resolve({ child, port: message.port })
      else reject(new Error(`host sent an unexpected ready message: ${JSON.stringify(message)}`))
    })
    child.once('exit', (code) => reject(new Error(`host exited early: ${code}`)))
    setTimeout(() => reject(new Error('host start timeout')), 20_000)
  })
}

/** A host that must have bound a port, with a named failure when it reported none. */
function bound(started: Host, what: string): BoundHost {
  if (started.port === null) throw new Error(`the ${what} reported no port`)
  return { child: started.child, port: started.port }
}

/** A worker host on a port the OS picks, or on the port of the worker it replaces. */
async function startWorker(db: string, replaces?: BoundHost): Promise<BoundHost> {
  const port = String(replaces?.port ?? 0)
  return bound(await host('packages/driver/bin/worker-host.ts', [db, port, SECRET]), 'worker host')
}

/**
 * A driver host that launches on `worker`. With `wakes` it also serves wakes,
 * on a port the OS picks and reports.
 */
function startDriver(db: string, worker: BoundHost, { wakes = false } = {}): Promise<Host> {
  const workerUrl = `http://127.0.0.1:${worker.port}`
  const wakePort = wakes ? ['0'] : []
  return host('packages/driver/bin/driver-host.ts', [db, Q, workerUrl, SECRET, ...wakePort])
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

/** A migrated file database this test shares with its host processes. */
async function chaosDb(prefix: string, file: string) {
  const db = join(mkdtempSync(join(tmpdir(), prefix)), file)
  const { raw } = await openTestDb({ url: `file:${db}` })
  return { db, raw, store: new LibsqlSchedulerStore(raw, systemIdSource()) }
}

/**
 * REAL processes against one SQLite file: a driver and a worker as
 * children of this test, killed with real signals. This is the phase-gate
 * chaos: everything the sims proved, replayed with actual process death.
 */
describe('multi-process chaos (real kills, one database file)', () => {
  it('a host started on port 0 reports the port it bound', async () => {
    const { db, raw } = await chaosDb('durablerun-ports-', 'ports.db')

    // The worker answers on the port it reported: it refuses an unsigned launch there.
    const worker = await startWorker(db)
    const launch = await fetch(`http://127.0.0.1:${worker.port}/launch`, {
      method: 'POST',
      body: '{}',
    })
    expect(launch.status).toBe(401)

    // So does a driver host asked to serve wakes.
    const driver = bound(await startDriver(db, worker, { wakes: true }), 'driver host')
    const wake = await fetch(`http://127.0.0.1:${driver.port}/wake`, { method: 'POST' })
    expect(wake.status).toBe(204)

    // No later case uses these two hosts, so they stop here instead of idling until afterAll.
    worker.child.kill('SIGKILL')
    driver.child.kill('SIGKILL')
    raw.close()
  }, 60_000)

  it('a task survives kill -9 of its worker mid-step and completes on a replacement', async () => {
    const { db, raw, store } = await chaosDb('durablerun-chaos-', 'chaos.db')

    const worker1 = await startWorker(db)
    await startDriver(db, worker1)

    // A slow multi-step task: plenty of mid-flight surface to murder.
    const spawned = await store.spawn(Q, 'chaos-steps', JSON.stringify({ steps: 20, stepMs: 150 }))
    await until(async () => {
      const [r] = await raw.batch('t', [{ sql: `SELECT COUNT(*) AS n FROM checkpoints`, args: [] }])
      return Number(r?.rows[0]?.n) >= 3
    }, 'first checkpoints committed')

    worker1.child.kill('SIGKILL') // real process death, mid-step

    // A replacement worker on the same port; the lease machinery recovers.
    await new Promise((r) => setTimeout(r, 300))
    await startWorker(db, worker1)
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
    const { db, raw, store } = await chaosDb('durablerun-chaos2-', 'chaos2.db')

    const worker = await startWorker(db)
    const driver1 = await startDriver(db, worker)

    // A task that checkpoints, sleeps 4s durably, then finishes.
    const spawned = await store.spawn(Q, 'napper', JSON.stringify({ seconds: 4 }))
    await until(async () => {
      const [r] = await raw.batch('t', [
        { sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE checkpoint_name = '$sleep'`, args: [] },
      ])
      return Number(r?.rows[0]?.n) === 1
    }, 'suspended into the durable sleep')

    driver1.child.kill('SIGKILL') // the scheduler's driver dies while the task sleeps

    await new Promise((r) => setTimeout(r, 500))
    await startDriver(db, worker)
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
    const { db, raw, store } = await chaosDb('durablerun-dogfood-', 'dogfood.db')
    const worker = await startWorker(db)
    await startDriver(db, worker)

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
