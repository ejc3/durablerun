import { createHmac, timingSafeEqual } from 'node:crypto'
import { type RequestListener, type Server, type ServerResponse, createServer } from 'node:http'
import type { Clock, Launcher, SchedulerStore } from '@durablerun/core'
import { LaunchOutcome, launchIdentity } from '@durablerun/core'
import { type RunInvocation, type TaskRegistry, runClaimedRun } from '@durablerun/sdk'
import type { DriverLoop } from './loop.js'

/**
 * The localhost transport (DESIGN.md §3.5-shaped, local-first): the driver
 * fires an HMAC-signed launch at the worker server, which ACKS BEFORE
 * executing (fire-and-forget — the ack is the 'accepted' outcome the tick
 * already knows how to reconcile) and runs the pass detached. After every
 * pass that leaves future work, the worker unconditionally pings the
 * driver's /wake — a 10-second sleep creates a wake the driver's current
 * park knows nothing about, and without the ping it would wait out the
 * poll ceiling.
 *
 * The signature covers the exact request body with a shared secret; a bad
 * or missing signature is rejected before anything is parsed further. This
 * is transport authentication only — the engine's real protection is the
 * store's fencing, which no forged launch can bypass (it could at worst
 * cause an advisory-cost activation race that the per-claim gate already
 * absorbs).
 */

const SIGNATURE_HEADER = 'x-durablerun-signature'

export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function verifyBody(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false
  const expected = Buffer.from(signBody(secret, body))
  const got = Buffer.from(signature)
  return expected.length === got.length && timingSafeEqual(expected, got)
}

/** Launch invocations are ~200 bytes; anything near this cap is garbage. */
const MAX_BODY_BYTES = 64 * 1024

class BodyTooLargeError extends Error {}

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer)
    total += buf.length
    // Reject BEFORE buffering more — the cap must bind pre-authentication.
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fire-and-forget launcher over HTTP: a 202 ack is 'accepted'. The request carries the
 * caller's signal, so it lives no longer than the caller waits for it.
 */
export function httpLauncher(opts: { url: string; secret: string }): Launcher {
  return {
    async launch(invocation, options) {
      const body = JSON.stringify(invocation)
      try {
        const response = await fetch(`${opts.url}/launch`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: signBody(opts.secret, body),
          },
          body,
          // A worker that accepts the connection and never answers would otherwise hold
          // this socket long after the driver stopped waiting. The aborted request
          // rejects into the failed launch below, which by then nobody reads.
          signal: options?.signal ?? null,
        })
        if (response.status === 202) return LaunchOutcome.accepted()
        return LaunchOutcome.launchFailed()
      } catch {
        return LaunchOutcome.launchFailed()
      }
    },
  }
}

/** Nobody waits for a wake ping, so nothing but a deadline of its own would ever end one. */
const WAKE_PING_DEADLINE_MS = 5_000

/**
 * The unconditional ping after a pass: best-effort, never awaited by the pass. It ends at
 * its deadline at the latest, so a driver address that accepts the connection and never
 * answers holds no connection of this process for longer than that.
 */
function pingDriver(clock: Clock, driverUrl: string): void {
  const deadline = new AbortController()
  const settled = new AbortController()
  fetch(`${driverUrl}/wake`, { method: 'POST', signal: deadline.signal })
    .catch(() => {})
    .finally(() => settled.abort())
  // The sleep ends early once the ping settles, and aborting a settled request does nothing.
  void clock.sleep(WAKE_PING_DEADLINE_MS, settled.signal).then(() => deadline.abort())
}

/**
 * What a connection to either local server is allowed: ten seconds to deliver its headers
 * and thirty for its whole request, where the platform allows sixty seconds and five
 * minutes. A launch is a few hundred bytes over loopback and a wake has no body, so a
 * request that takes longer is a client that stalled, and the limit is what ends it. The
 * platform checks its connections every thirty seconds, so a stalled one ends within its
 * limit plus that.
 */
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
/** How long the worker server's close() lets a request that is on the wire finish. */
const CLOSE_DRAIN_MS = 5_000

/** Both local servers are built here, so both carry the same limits. */
function localServer(handler: RequestListener): Server {
  return createServer(
    { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    handler,
  )
}

export interface WorkerServer {
  server: Server
  /** Resolves once listening; the bound port (0 requests an ephemeral one). */
  listen(port?: number): Promise<number>
  /**
   * Stop accepting and end every connection, then resolve once in-flight passes have
   * finished. The worker server first lets a request that is on the wire finish, within a
   * bound. The wake server has nothing worth that wait.
   */
  close(): Promise<void>
}

/**
 * The worker process's HTTP face: POST /launch (signed) acks 202 and runs
 * the pass detached; every finished pass pings the driver's /wake so new
 * wakes (sleeps, retries) are looked at immediately.
 */
export function createWorkerServer(deps: {
  store: SchedulerStore
  clock: Clock
  registry: TaskRegistry
  secret: string
  /** The driver's base URL for the unconditional post-pass ping. */
  driverUrl?: string
}): WorkerServer {
  const inFlight = new Set<Promise<unknown>>()
  let closing = false
  // Every answer leaves through here. Once close() has begun, an answer ends its
  // connection: the connection is closed after the answer is written, never before, and
  // never kept alive for a request the server will not take.
  const answer = (res: ServerResponse, status: number): void => {
    res.writeHead(status, closing ? { connection: 'close' } : undefined).end()
  }
  const server = localServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/launch') {
        answer(res, 404)
        return
      }
      let body: string
      try {
        body = await readBody(req)
      } catch (error) {
        // A dying client (stream error) or an oversized body must never
        // become an unhandled rejection — that terminates the PROCESS and
        // every in-flight pass with it.
        try {
          answer(res, error instanceof BodyTooLargeError ? 413 : 400)
        } catch {
          // the socket may already be gone; nothing to answer
        }
        // The client may still be mid-upload: tear the whole SOCKET down
        // (not just the request stream — a half-open socket wedges both
        // the client and the server's own close()).
        req.socket?.destroy() // null when the client is already fully gone
        return
      }
      if (!verifyBody(deps.secret, body, req.headers[SIGNATURE_HEADER] as string | undefined)) {
        answer(res, 401)
        return
      }
      let invocation: RunInvocation
      try {
        const identity = launchIdentity(JSON.parse(body))
        if (identity === undefined) {
          answer(res, 400)
          return
        }
        invocation = identity
      } catch {
        answer(res, 400)
        return
      }
      // Ack FIRST (fire-and-forget contract), execute detached.
      answer(res, 202)
      const pass = runClaimedRun(
        { store: deps.store, clock: deps.clock, registry: deps.registry },
        invocation,
      )
        .catch(() => {
          // A crashed pass is the lease/sweep story; nothing to do here.
        })
        .finally(() => {
          inFlight.delete(pass)
          if (deps.driverUrl) pingDriver(deps.clock, deps.driverUrl)
        })
      inFlight.add(pass)
    })()
  })
  return {
    server,
    listen(port = 0): Promise<number> {
      return listenLocal(server, 'worker server', port)
    },
    async close(): Promise<void> {
      // Stop accepting. The platform ends the idle kept-alive connections with that call.
      closing = true
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      // A launch that is on the wire is read, acked and run, and its answer ends its
      // connection, so the shutdown never drops an ack: a dropped ack is a failed launch
      // counted against a run that ran. The wait ends with the last connection, and at
      // the bound at the latest. A closed server no longer enforces its header and
      // request limits, so nothing else would ever end a client that stalls here.
      const drained = new AbortController()
      void closed.then(() => drained.abort())
      await deps.clock.sleep(CLOSE_DRAIN_MS, drained.signal)
      server.closeAllConnections()
      await closed
      await Promise.allSettled([...inFlight])
    },
  }
}

/**
 * The driver process's HTTP face: POST /wake interrupts the loop's park.
 * Unauthenticated by design, because a wake is advisory and idempotent. Wake
 * requests coalesce into one flag, and the loop looks at most once per
 * `wakeFloorMs` after its last tick, so a sustained flood costs at most one
 * tick per floor interval. Bind it to 127.0.0.1 all the same: anyone who can
 * reach it can keep the loop at its floor rate.
 */
export function createWakeServer(loop: Pick<DriverLoop, 'wake'>): WorkerServer {
  const server = localServer((req, res) => {
    if (req.method === 'POST' && req.url === '/wake') {
      loop.wake()
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end()
  })
  return {
    server,
    listen(port = 0): Promise<number> {
      return listenLocal(server, 'wake server', port)
    },
    close(): Promise<void> {
      // Nothing here is worth a wait: a wake reaches the loop before its answer is
      // written, and the answer tells the pinger nothing. So every connection is ended at
      // once. Left alone, one that holds a request half sent, or that never sent a byte,
      // would hold close() open for as long as its client liked.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      return closed
    },
  }
}

/**
 * Bind to loopback only and resolve the port the kernel assigned. The bind-time
 * error listener is removed once bound, and also when `listen` throws, so the
 * helper never leaves a listener behind. Left in place, it silently absorbed the
 * first server `error` event after bind. Without it, a server error after bind
 * is an uncaught event that ends the host process (DESIGN.md §3.2).
 */
function listenLocal(server: Server, label: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    try {
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error(`${label}: no bound port`))
          return
        }
        resolve(address.port)
      })
    } catch (error) {
      server.removeListener('error', reject)
      reject(error)
    }
  })
}
