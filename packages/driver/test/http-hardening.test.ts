import type { Server } from 'node:http'
import { connect } from 'node:net'
import { systemClock } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { createWakeServer, createWorkerServer, signBody } from '../src/index.js'

const Q = 'q'
const SECRET = 'test-secret'

async function workerFx(seed: string) {
  const { raw } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const worker = createWorkerServer({
    store,
    clock: systemClock(),
    registry: new Map([['job', async () => 'ok']]),
    secret: SECRET,
  })
  const port = await worker.listen()
  return {
    raw,
    store,
    worker,
    port,
    close: async () => {
      await worker.close()
      raw.close()
    },
  }
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
          () =>
            setTimeout(() => {
              socket.destroy()
              resolve()
            }, 30),
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
      taskName: run.taskName,
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
    // Stream 4x the cap over a raw socket; the server must answer 413 (or
    // reset the connection) once the cap trips MID-stream — never buffer
    // to completion and then 401.
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect(f.port, '127.0.0.1', () => {
        socket.write(
          'POST /launch HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 262144\r\n\r\n',
        )
        const chunk = 'x'.repeat(16 * 1024)
        for (let i = 0; i < 16; i++) socket.write(chunk)
      })
      let data = ''
      socket.on('data', (d) => {
        data += String(d)
        if (data.includes('\r\n')) {
          socket.destroy()
          resolve(data.split('\r\n')[0] ?? '')
        }
      })
      socket.on('error', () => resolve('connection-reset'))
      socket.on('close', () => resolve(data.split('\r\n')[0] ?? 'closed-early'))
      setTimeout(() => {
        socket.destroy()
        resolve('no-answer')
      }, 3000)
    })
    expect(outcome === 'connection-reset' || outcome.includes('413')).toBe(true)
    await f.close()
  })
})

describe('loopback listen helper', () => {
  function expectNoBindListener(server: Server, label: string): void {
    expect(
      server.listenerCount('error'),
      `a bound ${label} must not keep the settled bind rejection as its error handler`,
    ).toBe(0)
  }

  it('leaves no error listener behind once a server is bound', async () => {
    const f = await workerFx('http-listen-listener')
    try {
      expectNoBindListener(f.worker.server, 'worker server')
    } finally {
      await f.close()
    }
    const wake = createWakeServer({ wake: () => {} })
    await wake.listen()
    try {
      expectNoBindListener(wake.server, 'wake server')
    } finally {
      await wake.close()
    }
  })

  it('leaves no error listener behind when listen throws', async () => {
    const wake = createWakeServer({ wake: () => {} })
    await expect(wake.listen(-1)).rejects.toThrow()
    expectNoBindListener(wake.server, 'wake server whose listen threw')
  })
})
