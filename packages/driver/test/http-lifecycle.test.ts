import { once } from 'node:events'
import { type AddressInfo, type Socket, connect, createServer as createTcpServer } from 'node:net'
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
    await clock.yieldTurn()
  }
  await stopping
  await done
}

type Fixture = Awaited<ReturnType<typeof fx>>

/** The worker server of a case: the fixture's store and clock, the one job, and what the case adds. */
function workerOn(f: Fixture, extra: { driverUrl?: string } = {}) {
  return createWorkerServer({
    store: f.store,
    clock: f.clock,
    registry: JOBS,
    secret: SECRET,
    ...extra,
  })
}

/** A driver loop on the fixture's clock that launches over HTTP at `url`. */
function driverThrough(f: Fixture, url: string): DriverLoop {
  return new DriverLoop(
    { store: f.store, launcher: httpLauncher({ url, secret: SECRET }), ids: f.ids, clock: f.clock },
    LOOP,
  )
}

/** Send a signed launch the way the launcher does, and answer with its status. */
async function postLaunch(port: number, body: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/launch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-durablerun-signature': signBody(SECRET, body),
    },
    body,
  })
  return response.status
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
    statuses: () => statusesIn(seen.data),
    send: (text: string) => new Promise<void>((resolve) => socket.write(text, () => resolve())),
  }
}

/** The status of every HTTP answer in `text`, in the order they came. */
function statusesIn(text: string): number[] {
  return [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => Number(match[1]))
}

/**
 * A test peer on a port the OS picks. It remembers its connections in the order they came,
 * because the one a case asks about is the one that carried the request: the client's
 * connection pool may open another to the same address once that one is gone, and closes
 * it on a timer of its own.
 */
async function peer(onConnection: (socket: Socket) => void) {
  const connections: Socket[] = []
  const closed = new Set<Socket>()
  const server = createTcpServer((socket) => {
    connections.push(socket)
    socket.on('close', () => closed.add(socket))
    socket.on('error', () => {})
    onConnection(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    accepted: () => connections.length,
    /** Whether the nth connection the peer accepted, counted from zero, has closed. */
    closed: (nth: number) => connections[nth] !== undefined && closed.has(connections[nth]),
    close(): Promise<void> {
      for (const socket of connections) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** A peer that accepts every connection, reads what it is sent, and never answers. */
const silentPeer = () => peer((socket) => socket.resume())

/**
 * A peer that hands every byte on to `targetPort` and keeps the answers to itself, so a
 * launch sent through it arrives and its ack never comes back.
 */
async function oneWayRelay(targetPort: number) {
  let answers = ''
  const relay = await peer((from) => {
    const to = connect(targetPort, '127.0.0.1')
    from.pipe(to)
    to.on('data', (chunk) => {
      answers += String(chunk)
    })
    from.on('close', () => to.destroy())
    to.on('error', () => {})
  })
  /** The status of every answer the target gave, which is one for each request that reached it. */
  return { ...relay, statuses: () => statusesIn(answers) }
}

describe('a launch the driver stopped waiting for', () => {
  it('holds no socket to a worker that accepted the connection and never answered', async () => {
    const f = await fx('lifecycle-silent-worker')
    const peer = await silentPeer()
    await f.store.spawn(Q, 'job', '{}')
    const loop = driverThrough(f, peer.url)
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
      // The driver closes the connection of a launch it stopped waiting for.
      expect(
        await reached(() => peer.closed(0), SOCKET_WAIT_MS),
        'mutation-verdict:behavior:http-launch-ends-at-the-callers-deadline',
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
    const loop = driverThrough(f, relay.url)
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

describe('the wake ping a worker sends after a pass', () => {
  it('holds no connection, past its deadline, to a driver that accepted it and never answered', async () => {
    const f = await fx('lifecycle-silent-driver')
    const peer = await silentPeer()
    const worker = workerOn(f, { driverUrl: peer.url })
    const port = await worker.listen()
    try {
      const launch = await claimedLaunch(f.store)
      expect(await postLaunch(port, launch.body)).toBe(202)
      await until(
        () => peer.accepted() === 1,
        'the ping reaching the silent driver',
        SOCKET_WAIT_MS,
      )
      // The pass is over and took its own sleeps with it, so the one sleep left on the
      // worker's clock is the deadline of the ping.
      expect(
        f.clock.sleeps.map((sleep) => sleep.ms),
        'a ping is sent with a deadline of five seconds',
      ).toEqual([5_000])
      f.clock.advance(5_000)
      f.clock.fire()
      // The worker closes the connection of a ping nobody answered.
      expect(
        await reached(() => peer.closed(0), SOCKET_WAIT_MS),
        'mutation-verdict:behavior:wake-ping-ends-at-its-deadline',
      ).toBe(true)
    } finally {
      await worker.close()
      await peer.close()
      f.close()
    }
  })

  it('leaves no sleep on the clock once it is answered', async () => {
    const f = await fx('lifecycle-answered-ping')
    let wakes = 0
    const wake = createWakeServer({
      wake: () => {
        wakes++
      },
    })
    const worker = workerOn(f, { driverUrl: `http://127.0.0.1:${await wake.listen()}` })
    const port = await worker.listen()
    try {
      const launch = await claimedLaunch(f.store)
      expect(await postLaunch(port, launch.body)).toBe(202)
      await until(() => wakes === 1, 'the ping reaching the driver', SOCKET_WAIT_MS)
      // The deadline's sleep ends with the ping, so an answered ping leaves no timer behind.
      expect(
        await reached(() => f.clock.sleeps.length === 0, SOCKET_WAIT_MS),
        'mutation-verdict:behavior:answered-wake-ping-leaves-no-timer',
      ).toBe(true)
    } finally {
      await worker.close()
      await wake.close()
      f.close()
    }
  })
})

describe('closing the worker server', () => {
  it('lets a launch already on the wire finish: it is acked, its pass runs, and close() waits for both', async () => {
    const f = await fx('lifecycle-close-launch-on-the-wire')
    const worker = workerOn(f)
    const client = await rawClient(await worker.listen())
    try {
      const launch = await claimedLaunch(f.store)
      const half = Math.floor(launch.body.length / 2)
      // The headers and half the body arrive, close() begins, and the rest arrives.
      const requested = once(worker.server, 'request')
      await client.send(launchText(launch.body, launch.body.slice(0, half)))
      await requested
      let closed = false
      const closing = worker.close().then(() => {
        closed = true
      })
      await client.send(launch.body.slice(half))
      // A launch that was on the wire when close() began is answered.
      expect(
        await reached(() => client.statuses().length === 1, SOCKET_WAIT_MS),
        'mutation-verdict:behavior:worker-close-answers-a-launch-on-the-wire',
      ).toBe(true)
      expect(client.statuses()).toEqual([202])
      // The answer of a closing server says that its connection ends with it.
      expect(
        client.seen.data,
        'mutation-verdict:behavior:closing-worker-answer-ends-its-connection',
      ).toMatch(/\r\nconnection: close\r\n/i)
      // close() resolves once the launch is acked and its pass is over, with the clock
      // where it was: the wait ends with the last connection, not with its bound.
      expect(
        await reached(() => closed, SOCKET_WAIT_MS),
        'mutation-verdict:behavior:worker-close-ends-with-its-last-connection',
      ).toBe(true)
      expect((await f.store.getTaskResult(Q, launch.taskId))?.state).toBe('completed')
      expect(
        await reached(() => client.seen.closed, SOCKET_WAIT_MS),
        'a closing server ends the connection once it has answered',
      ).toBe(true)
      await closing
    } finally {
      client.socket.destroy()
      // A close() that still waits on its bound ends only when the clock moves, and a case
      // that hangs here would hide the assertion that failed.
      const closedAgain = worker.close()
      f.clock.advance(5_000)
      f.clock.fire()
      await closedAgain
      f.close()
    }
  })

  it('delivers the ack of a launch that arrived whole just before close() began', async () => {
    const f = await fx('lifecycle-close-ack-in-hand')
    const worker = workerOn(f)
    const client = await rawClient(await worker.listen())
    try {
      const launch = await claimedLaunch(f.store)
      // The whole launch has reached the handler, which has not written its ack yet. Its
      // pass runs whatever close() does to the connection, so a dropped ack here is a
      // failed launch counted against a run that ran.
      const requested = once(worker.server, 'request')
      await client.send(launchText(launch.body))
      await requested
      const closing = worker.close()
      expect(
        await reached(() => client.statuses().length === 1, SOCKET_WAIT_MS),
        'the ack of a launch whose pass runs is delivered',
      ).toBe(true)
      expect(client.statuses()).toEqual([202])
      await closing
      expect((await f.store.getTaskResult(Q, launch.taskId))?.state).toBe('completed')
    } finally {
      client.socket.destroy()
      await worker.close()
      f.close()
    }
  })

  it('ends a launch that never finishes arriving once its bound of five seconds passes', async () => {
    const f = await fx('lifecycle-close-bound')
    const worker = workerOn(f)
    const client = await rawClient(await worker.listen())
    try {
      const launch = await claimedLaunch(f.store)
      const requested = once(worker.server, 'request')
      await client.send(launchText(launch.body, launch.body.slice(0, 10)))
      await requested
      let closed = false
      const closing = worker.close().then(() => {
        closed = true
      })
      // close() waits for the launch on the wire, and only the clock can end that wait.
      await until(() => f.clock.sleeps.length === 1, 'close() waiting for the launch on the wire')
      expect(f.clock.sleeps.map((sleep) => sleep.ms)).toEqual([5_000])
      expect(closed).toBe(false)
      f.clock.advance(5_000)
      f.clock.fire()
      // close() ends what is left once its bound passes.
      expect(
        await reached(() => closed, SOCKET_WAIT_MS),
        'mutation-verdict:behavior:worker-close-is-bounded',
      ).toBe(true)
      expect(
        await reached(() => client.seen.closed, SOCKET_WAIT_MS),
        'the client that stalled is dropped',
      ).toBe(true)
      expect(client.statuses()).toEqual([])
      await closing
    } finally {
      client.socket.destroy()
      await worker.close()
      f.close()
    }
  })
})

describe('closing the wake server', () => {
  it('is not held open by a client that connected and sent nothing', async () => {
    const wake = createWakeServer({ wake: () => {} })
    const port = await wake.listen()
    const connected = once(wake.server, 'connection')
    const client = await rawClient(port)
    await connected
    let closed = false
    const closing = wake.close().then(() => {
      closed = true
    })
    try {
      // close() resolves while a silent client holds a connection.
      expect(
        await reached(() => closed),
        'mutation-verdict:behavior:wake-server-close-ends-every-connection',
      ).toBe(true)
      expect(
        await reached(() => client.seen.closed, SOCKET_WAIT_MS),
        'the silent client is dropped',
      ).toBe(true)
    } finally {
      client.socket.destroy()
      await closing
    }
  })
})

describe('the limits of the local servers', () => {
  it('give a connection ten seconds for its headers and thirty for its whole request', async () => {
    const f = await fx('lifecycle-limits')
    try {
      const worker = workerOn(f)
      const wake = createWakeServer({ wake: () => {} })
      const limits = { headersMs: 10_000, requestMs: 30_000 }
      expect(
        {
          worker: {
            headersMs: worker.server.headersTimeout,
            requestMs: worker.server.requestTimeout,
          },
          wake: { headersMs: wake.server.headersTimeout, requestMs: wake.server.requestTimeout },
        },
        'mutation-verdict:behavior:local-servers-carry-their-limits',
      ).toEqual({ worker: limits, wake: limits })
    } finally {
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
    const worker = workerOn(f)
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
