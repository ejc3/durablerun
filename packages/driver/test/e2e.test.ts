import { engineInvariantViolations } from '@durablerun/conformance'
import { type Clock, systemClock } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import type { TaskRegistry } from '@durablerun/sdk'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import {
  DriverLoop,
  createWakeServer,
  createWorkerServer,
  httpLauncher,
  signBody,
} from '../src/index.js'

const Q = 'q'
const SECRET = 'test-secret'

/**
 * True end-to-end over localhost: a real driver loop launching over real
 * HTTP into a real worker pass against one in-memory database, on the real
 * clock (integration tests own their nondeterminism; the engine under test
 * still gets its time injected — it just gets the production clock).
 */
async function harness(seed: string, registry: TaskRegistry) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock: Clock = systemClock()

  const loop = new DriverLoop(
    {
      store,
      // The launcher URL is late-bound: the worker port is known only
      // after listen(). The loop starts after wiring completes.
      launcher: {
        launch: (inv, options) => launcherRef.launch(inv, options),
      },
      ids,
      clock,
    },
    {
      queue: Q,
      claimLimit: 5,
      sweepLimit: 5,
      leaseSeconds: 5,
      busyCeilingMs: 25,
      idleCeilingMs: 100,
      launchTimeoutSeconds: 2,
    },
  )
  const wake = createWakeServer(loop)
  const wakePort = await wake.listen()
  const worker = createWorkerServer({
    store,
    clock,
    registry,
    secret: SECRET,
    driverUrl: `http://127.0.0.1:${wakePort}`,
  })
  const workerPort = await worker.listen()
  const launcherRef = httpLauncher({ url: `http://127.0.0.1:${workerPort}`, secret: SECRET })
  const running = loop.run()

  return {
    raw,
    admin,
    store,
    loop,
    worker,
    workerPort,
    async shutdown() {
      await loop.stop()
      await running
      await worker.close()
      await wake.close()
      raw.close()
    },
  }
}

async function until(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

describe('local end-to-end (driver -> HTTP -> worker)', () => {
  it('a spawned task flows to completion through the whole stack', async () => {
    const h = await harness(
      'e2e-basic',
      new Map([
        [
          'greet',
          async (ctx) => {
            const name = await ctx.step('load', () => 'world')
            return `hello ${name}`
          },
        ],
      ]),
    )
    const spawned = await h.store.spawn(Q, 'greet', '{}')
    await until(
      async () => (await h.store.getTaskResult(Q, spawned.taskId))?.state === 'completed',
      'task completion',
    )
    const result = await h.store.getTaskResult(Q, spawned.taskId)
    expect(JSON.parse(result?.completedPayloadJson ?? 'null')).toBe('hello world')
    expect(await engineInvariantViolations(h.raw)).toEqual([])
    await h.shutdown()
  })

  it('a durable sleep suspends and resumes through real time', async () => {
    const passes: number[] = []
    const h = await harness(
      'e2e-sleep',
      new Map([
        [
          'nap',
          async (ctx) => {
            passes.push(1)
            await ctx.sleepFor(0.3)
            return 'rested'
          },
        ],
      ]),
    )
    const spawned = await h.store.spawn(Q, 'nap', '{}')
    await until(
      async () => (await h.store.getTaskResult(Q, spawned.taskId))?.state === 'completed',
      'sleep-resume completion',
    )
    expect(passes.length).toBe(2) // one suspending pass, one resuming pass
    expect(await engineInvariantViolations(h.raw)).toEqual([])
    await h.shutdown()
  })

  it('an unsigned launch is rejected; the run recovers through the lease anyway', async () => {
    const h = await harness('e2e-auth', new Map([['job', async () => 'ok']]))
    const body = JSON.stringify({ queue: Q, runId: 'r', claimToken: 't', claimGen: 1 })
    const bad = await fetch(`http://127.0.0.1:${h.workerPort}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(bad.status).toBe(401)
    const forged = await fetch(`http://127.0.0.1:${h.workerPort}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-durablerun-signature': 'nope' },
      body,
    })
    expect(forged.status).toBe(401)
    // The real path still works end to end.
    const spawned = await h.store.spawn(Q, 'job', '{}')
    await until(
      async () => (await h.store.getTaskResult(Q, spawned.taskId))?.state === 'completed',
      'signed path completion',
    )
    await h.shutdown()
  })

  it('kill-worker chaos: a dead worker at launch time loses nothing', async () => {
    let executions = 0
    const h = await harness(
      'e2e-chaos',
      new Map([
        [
          'survivor',
          async () => {
            executions++
            return 'made it'
          },
        ],
      ]),
    )
    // Kill the worker BEFORE any launch can land.
    await h.worker.close()
    const spawned = await h.store.spawn(Q, 'survivor', '{}')
    // Launches fail; the loop advisorily expires and the sweep reopens the
    // run with backoff (a lost launch consumes no retry budget).
    await until(async () => {
      const [row] = await h.raw.batch('t', [
        { sql: `SELECT relaunch_count FROM runs WHERE task_id = ?`, args: [spawned.taskId] },
      ])
      return Number(row?.rows[0]?.relaunch_count ?? 0) >= 1
    }, 'lost-launch reopen')

    // Resurrect the worker ON THE SAME PORT the launcher still targets.
    const revived = createWorkerServer({
      store: h.store,
      clock: systemClock(),
      registry: new Map([
        [
          'survivor',
          async () => {
            executions++
            return 'made it'
          },
        ],
      ]),
      secret: SECRET,
    })
    await revived.listen(h.workerPort)
    await until(
      async () => (await h.store.getTaskResult(Q, spawned.taskId))?.state === 'completed',
      'recovery to completion',
    )
    expect(executions).toBe(1)
    const [task] = await h.raw.batch('t', [
      { sql: `SELECT attempts FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
    ])
    expect(Number(task?.rows[0]?.attempts)).toBe(0) // no user budget consumed
    expect(await engineInvariantViolations(h.raw)).toEqual([])
    await revived.close()
    await h.shutdown()
  }, 20_000) // real lease + reopen backoff elapse on the wall clock here

  it('the signed body is what the signature covers (tamper = reject)', async () => {
    const h = await harness('e2e-tamper', new Map([['job', async () => 'ok']]))
    const body = JSON.stringify({ queue: Q, runId: 'r', claimToken: 't', claimGen: 1 })
    const tampered = body.replace('"r"', '"other"')
    const res = await fetch(`http://127.0.0.1:${h.workerPort}/launch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-durablerun-signature': signBody(SECRET, body),
      },
      body: tampered,
    })
    expect(res.status).toBe(401)
    await h.shutdown()
  })
})
