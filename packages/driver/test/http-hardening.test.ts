import { connect } from 'node:net'
import { systemClock } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { createWorkerServer, signBody } from '../src/index.js'

const Q = 'q'
const SECRET = 'test-secret'

async function workerFx(seed: string) {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const worker = createWorkerServer({
    store,
    clock: systemClock(),
    registry: new Map([['job', async () => 'ok']]),
    secret: SECRET,
  })
  const port = await worker.listen()
  return { raw, store, worker, port, close: async () => (await worker.close(), raw.close()) }
}

/**
 * Review regressions: each failed against the transport as first committed.
 */
describe('worker server hardening', () => {
  it('a client that dies mid-body cannot kill the worker process', async () => {
    const f = await workerFx('http-abort')
    // Send headers + partial body, then destroy the socket — the flaky
    // client every real network eventually produces. Before the fix this
    // was an unhandled rejection (ECONNRESET) that terminated the whole
    // process and every in-flight pass with it.
    await new Promise<void>((resolve) => {
      const socket = connect(f.port, '127.0.0.1', () => {
        socket.write(
          'POST /launch HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"partial":',
          () => setTimeout(() => (socket.destroy(), resolve()), 30),
        )
      })
    })
    await new Promise((r) => setTimeout(r, 50))
    // The server survived and still serves a correctly signed launch.
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const [run] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('claim')
    const body = JSON.stringify({
      queue: Q,
      runId: run.runId,
      claimToken: run.claimToken,
      claimGen: run.claimGen,
    })
    const res = await fetch(`http://127.0.0.1:${f.port}/launch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-durablerun-signature': signBody(SECRET, body),
      },
      body,
    })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 100))
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('completed')
    await f.close()
  })

  it('an oversized body is rejected without being buffered whole', async () => {
    const f = await workerFx('http-big')
    const huge = 'x'.repeat(256 * 1024) // 4x the cap
    const res = await fetch(`http://127.0.0.1:${f.port}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    }).catch(() => null)
    // Either a 413 or a connection reset once the cap trips mid-stream —
    // never an accepted or buffered-then-401 request.
    if (res !== null) expect(res.status).toBe(413)
    await f.close()
  })
})
