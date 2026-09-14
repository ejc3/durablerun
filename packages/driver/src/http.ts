import { createHmac, timingSafeEqual } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { Clock, Launcher, SchedulerStore } from '@durablerun/core'
import { LaunchOutcome } from '@durablerun/core'
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

/** Fire-and-forget launcher over HTTP: a 202 ack is 'accepted'. */
export function httpLauncher(opts: { url: string; secret: string }): Launcher {
  return {
    async launch(invocation) {
      const body = JSON.stringify(invocation)
      try {
        const response = await fetch(`${opts.url}/launch`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: signBody(opts.secret, body),
          },
          body,
        })
        if (response.status === 202) return LaunchOutcome.accepted()
        return LaunchOutcome.launchFailed()
      } catch {
        return LaunchOutcome.launchFailed()
      }
    },
  }
}

export interface WorkerServer {
  server: Server
  /** Resolves once listening; the bound port (0 requests an ephemeral one). */
  listen(port?: number): Promise<number>
  /** Stop accepting; resolves when in-flight passes have finished. */
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
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/launch') {
        res.writeHead(404).end()
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
          res.writeHead(error instanceof BodyTooLargeError ? 413 : 400).end()
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
        res.writeHead(401).end()
        return
      }
      let invocation: RunInvocation
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        if (
          typeof parsed.queue !== 'string' ||
          typeof parsed.runId !== 'string' ||
          typeof parsed.claimToken !== 'string' ||
          typeof parsed.claimGen !== 'number'
        ) {
          res.writeHead(400).end()
          return
        }
        invocation = {
          queue: parsed.queue,
          runId: parsed.runId,
          claimToken: parsed.claimToken,
          claimGen: parsed.claimGen,
        }
      } catch {
        res.writeHead(400).end()
        return
      }
      // Ack FIRST (fire-and-forget contract), execute detached.
      res.writeHead(202).end()
      const pass = runClaimedRun(
        { store: deps.store, clock: deps.clock, registry: deps.registry },
        invocation,
      )
        .catch(() => {
          // A crashed pass is the lease/sweep story; nothing to do here.
        })
        .finally(() => {
          inFlight.delete(pass)
          if (deps.driverUrl) {
            // Unconditional ping: best-effort, never awaited by the pass.
            fetch(`${deps.driverUrl}/wake`, { method: 'POST' }).catch(() => {})
          }
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
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      // Rejected mid-uploads can leave stragglers; close() must not wait
      // on a dead client's half-open socket.
      server.closeIdleConnections()
      server.closeAllConnections()
      await closed
      await Promise.allSettled([...inFlight])
    },
  }
}

/**
 * The driver process's HTTP face: POST /wake interrupts the loop's park.
 * Unauthenticated by design — a wake is advisory and idempotent. The real
 * bound on a flood: wake requests COALESCE into one flag, so the tick rate
 * is bounded by tick latency (a sustained flood degrades to continuous
 * ticking, not amplification). Acceptable bound to 127.0.0.1; add a
 * coalescing floor before this endpoint is ever exposed beyond localhost.
 */
export function createWakeServer(loop: Pick<DriverLoop, 'wake'>): WorkerServer {
  const server = createServer((req, res) => {
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
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Bind to loopback only and resolve the port the kernel assigned. The bind-time
 * error listener is removed once bound: left in place, it absorbed every later
 * server error into an already-settled promise, so a server that stopped
 * accepting kept running silently instead of failing loudly.
 */
function listenLocal(server: Server, label: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error(`${label}: no bound port`))
        return
      }
      resolve(address.port)
    })
  })
}
