import { once } from 'node:events'
import {
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
  connect,
  createServer as createTcpServer,
} from 'node:net'
import { engineInvariantViolations } from '@durablerun/conformance'
import type { SchedulerStore } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
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
import { reached, until } from './loop-harness.js'

const Q = 'q'
const SECRET = 'test-secret'
/** A wait on a real socket gets more room than a wait on an in-process counter. */
const SOCKET_WAIT_MS = 5_000
const JOBS: TaskRegistry = new Map([['job', async () => 'ok']])
const LOOP = { queue: Q, claimLimit: 3, sweepLimit: 5, leaseSeconds: 60, launchTimeoutSeconds: 5 }

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

/**
 * Stop a loop that runs on a hand-cranked clock. stop() waits for the tick in flight, and a
 * tick that waits for a launch ends only when the clock reaches the launch deadline, so a
 * test that failed before it moved the clock would hang here and hide its own failure.
 */
async function stopLoop(clock: FakeClock, loop: DriverLoop, done: Promise<void>): Promise<void> {
  let stopped = false
  const stopping = loop.stop().then(() => {
    stopped = true
  })
  while (!stopped) {
    clock.advance(3_600_000)
    clock.fire()
    await new Promise((resolve) => setImmediate(resolve))
  }
  await stopping
  await done
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

/** Bind a test peer on a port the OS picks. */
function listenOnOsPort(server: TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** Destroy what a peer still holds, then stop it. */
function closePeer(server: TcpServer, held: Iterable<Socket>): Promise<void> {
  for (const socket of held) socket.destroy()
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * A peer that accepts every connection, reads what it is sent, and never answers. It
 * remembers its connections in the order they came, because the one a test asks about is
 * the one that carried the request. The client's connection pool may open another to the
 * same address once that one is gone, and closes it on a timer of its own.
 */
async function silentPeer() {
  const connections: Socket[] = []
  const closed = new Set<Socket>()
  const server = createTcpServer((socket) => {
    connections.push(socket)
    socket.on('close', () => closed.add(socket))
    socket.on('error', () => {})
    socket.resume()
  })
  const port = await listenOnOsPort(server)
  return {
    url: `http://127.0.0.1:${port}`,
    accepted: () => connections.length,
    /** Whether the nth connection the peer accepted, counted from zero, has closed. */
    closed: (nth: number) => connections[nth] !== undefined && closed.has(connections[nth]),
    close: () => closePeer(server, connections),
  }
}

/**
 * A peer that hands every byte on to `targetPort` and keeps the answers to itself, so a
 * launch sent through it arrives and its ack never comes back.
 */
async function oneWayRelay(targetPort: number) {
  const connections: Socket[] = []
  const onward: Socket[] = []
  const closed = new Set<Socket>()
  let answers = ''
  const server = createTcpServer((from) => {
    connections.push(from)
    const to = connect(targetPort, '127.0.0.1')
    onward.push(to)
    from.pipe(to)
    to.on('data', (chunk) => {
      answers += String(chunk)
    })
    from.on('close', () => {
      closed.add(from)
      to.destroy()
    })
    from.on('error', () => {})
    to.on('error', () => {})
  })
  const port = await listenOnOsPort(server)
  return {
    url: `http://127.0.0.1:${port}`,
    /** Whether the nth connection the relay accepted, counted from zero, has closed. */
    closed: (nth: number) => connections[nth] !== undefined && closed.has(connections[nth]),
    /** The status of every answer the target gave, which is one per request that reached it. */
    statuses: () => [...answers.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => Number(match[1])),
    close: () => closePeer(server, [...connections, ...onward]),
  }
}

describe('a launch the driver stopped waiting for', () => {
  it('holds no socket to a worker that accepted the connection and never answered', async () => {
    const f = await fx('lifecycle-silent-worker')
    const peer = await silentPeer()
    await f.store.spawn(Q, 'job', '{}')
    const loop = new DriverLoop(
      {
        store: f.store,
        launcher: httpLauncher({ url: peer.url, secret: SECRET }),
        ids: f.ids,
        clock: f.clock,
      },
      LOOP,
    )
    const done = loop.run()
    try {
      await until(
        () => peer.accepted() === 1,
        'the launch reaching the silent worker',
        SOCKET_WAIT_MS,
      )
      await f.advance(5_000)
      await until(
        () => loop.stats.launchFailed === 1,
        'the launch deadline counted as a failed launch',
      )
      expect(
        await reached(() => peer.closed(0), SOCKET_WAIT_MS),
        'the driver closes the connection of a launch it stopped waiting for',
      ).toBe(true)
    } finally {
      await stopLoop(f.clock, loop, done)
      await peer.close()
      f.close()
    }
  })

  it('says nothing about the run: a worker that took the launch completes it once', async () => {
    const f = await fx('lifecycle-ack-never-arrives')
    let bodies = 0
    const worker = createWorkerServer({
      store: f.store,
      // The worker's own clock, so its sleeps stay out of the driver clock the test cranks.
      clock: new FakeClock(),
      registry: new Map([
        [
          'job',
          async () => {
            bodies++
            return 'ok'
          },
        ],
      ]),
      secret: SECRET,
    })
    const relay = await oneWayRelay(await worker.listen())
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const loop = new DriverLoop(
      {
        store: f.store,
        launcher: httpLauncher({ url: relay.url, secret: SECRET }),
        ids: f.ids,
        clock: f.clock,
      },
      LOOP,
    )
    const done = loop.run()
    const state = async () => (await f.store.getTaskResult(Q, spawned.taskId))?.state
    try {
      // The worker took the launch: it acked, to the relay, which keeps the ack, and ran the
      // pass. The store answers in microtasks, so the pass can end before the relay has read
      // the ack off its socket: each is waited for by name.
      await until(() => relay.statuses().length === 1, 'the ack reaching the relay', SOCKET_WAIT_MS)
      await until(
        async () => (await state()) === 'completed',
        'the worker finishing the run',
        SOCKET_WAIT_MS,
      )
      expect(relay.statuses()).toEqual([202])
      expect(loop.stats.ticks, 'the driver is still waiting for the ack').toBe(0)
      await f.advance(5_000)
      await until(
        () => loop.stats.launchFailed === 1,
        'the launch deadline counted as a failed launch',
      )
      expect(
        await reached(() => relay.closed(0), SOCKET_WAIT_MS),
        'the driver closes the connection of a launch it stopped waiting for',
      ).toBe(true)
      // The driver looks again after the reopen backoff and after a whole lease, and
      // launches nothing: the run had ended, so the failed launch changed nothing.
      for (const ms of [5_000, 60_000]) {
        await until(() => f.clock.sleeps.length === 1, 'the loop parked')
        const looked = loop.stats.ticks
        await f.advance(ms)
        await until(() => loop.stats.ticks > looked, 'the loop looking again')
      }
      expect({ bodies, acks: relay.statuses(), state: await state() }).toEqual({
        bodies: 1,
        acks: [202],
        state: 'completed',
      })
      expect(await engineInvariantViolations(f.raw)).toEqual([])
    } finally {
      await stopLoop(f.clock, loop, done)
      await relay.close()
      await worker.close()
      f.close()
    }
  })
})

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
