import { once } from 'node:events'
import { connect } from 'node:net'
import type { SchedulerStore } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
import type { TaskRegistry } from '@durablerun/sdk'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { createWakeServer, createWorkerServer, signBody } from '../src/index.js'
import { until } from './loop-harness.js'

const Q = 'q'
const SECRET = 'test-secret'
/** A wait on a real socket gets more room than a wait on an in-process counter. */
const SOCKET_WAIT_MS = 5_000
const JOBS: TaskRegistry = new Map([['job', async () => 'ok']])

/** One database on a hand-cranked clock, so no deadline in this file is crossed by waiting. */
async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.advance(ms)
    await admin.setFakeNowEpochMs(clock.now)
    clock.fire()
  }
  return { raw, ids, store, clock, advance, close: () => raw.close() }
}

/** A claimed run and the launch body that names it. */
async function claimedLaunch(store: SchedulerStore) {
  const spawned = await store.spawn(Q, 'job', '{}')
  const [run] = await store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
  if (!run) throw new Error('claim')
  const body = JSON.stringify({
    queue: Q,
    runId: run.runId,
    claimToken: run.claimToken,
    claimGen: run.claimGen,
  })
  return { taskId: spawned.taskId, body }
}

/** A signed launch as bytes on the wire. `sent` is how much of the body goes with the headers. */
function launchText(body: string, sent = body): string {
  return `POST /launch HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nx-durablerun-signature: ${signBody(SECRET, body)}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${sent}`
}

/** A client that speaks raw bytes, so a test decides what is on the wire and when. */
async function rawClient(port: number) {
  const socket = connect(port, '127.0.0.1')
  const seen = { data: '', closed: false }
  socket.on('data', (chunk) => {
    seen.data += String(chunk)
  })
  socket.on('close', () => {
    seen.closed = true
  })
  // A reset is an outcome a test reads from `closed`, never a crash of the test.
  socket.on('error', () => {})
  await once(socket, 'connect')
  return {
    socket,
    seen,
    statuses: () => [...seen.data.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => Number(match[1])),
    send: (text: string) => new Promise<void>((resolve) => socket.write(text, () => resolve())),
  }
}

/**
 * Node discards what is left of a request body once its response has finished, so a
 * route that answers before it reads leaves the connection in step with the next
 * request. Nothing in the transport does that itself. These cases hold it on every
 * route that answers early, because the launcher's connections are kept alive and a
 * connection left out of step would fail the launches that follow a rejected one.
 */
describe('a request that is rejected with a body', () => {
  it('leaves its kept-alive connection usable on the worker server', async () => {
    const f = await fx('lifecycle-keepalive-worker')
    const worker = createWorkerServer({
      store: f.store,
      clock: f.clock,
      registry: JOBS,
      secret: SECRET,
    })
    const client = await rawClient(await worker.listen())
    try {
      const launch = await claimedLaunch(f.store)
      const upload = 'x'.repeat(1_000)
      // A route the worker does not have is answered before anything is read, and its
      // body arrives after the answer.
      await client.send(
        `POST /nope HTTP/1.1\r\nHost: x\r\nContent-Length: ${upload.length}\r\n\r\n`,
      )
      await until(
        () => client.statuses().length === 1,
        'the answer to a route the worker does not have',
        SOCKET_WAIT_MS,
      )
      await client.send(upload)
      // A launch nobody signed is read whole and then refused.
      await client.send(
        `POST /launch HTTP/1.1\r\nHost: x\r\nx-durablerun-signature: forged\r\nContent-Length: ${Buffer.byteLength(launch.body)}\r\n\r\n${launch.body}`,
      )
      await client.send(launchText(launch.body))
      await until(
        () => client.statuses().length === 3,
        'three answers on one connection',
        SOCKET_WAIT_MS,
      )
      expect(client.statuses()).toEqual([404, 401, 202])
      expect(client.seen.closed).toBe(false)
      // close() waits for the pass the last request started.
      await worker.close()
      expect((await f.store.getTaskResult(Q, launch.taskId))?.state).toBe('completed')
    } finally {
      client.socket.destroy()
      await worker.close()
      f.close()
    }
  })

  it('leaves its kept-alive connection usable on the wake server', async () => {
    let wakes = 0
    const wake = createWakeServer({
      wake: () => {
        wakes++
      },
    })
    const client = await rawClient(await wake.listen())
    try {
      // A wake with a body nobody reads, a route the server does not have, and a wake.
      await client.send('POST /wake HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello')
      await client.send('PUT /nope HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello')
      await client.send('POST /wake HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n')
      await until(
        () => client.statuses().length === 3,
        'three answers on one connection',
        SOCKET_WAIT_MS,
      )
      expect(client.statuses()).toEqual([204, 404, 204])
      expect(wakes).toBe(2)
      expect(client.seen.closed).toBe(false)
    } finally {
      client.socket.destroy()
      await wake.close()
    }
  })
})
