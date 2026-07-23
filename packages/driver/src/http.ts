import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Clock, Launcher, SchedulerStore } from '@durablerun/core'
import { LaunchOutcome } from '@durablerun/core'
import { runClaimedRun, type RunInvocation, type TaskRegistry } from '@durablerun/sdk'
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

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
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
        return LaunchOutcome.launchFailed(
          new Error(`worker refused launch: HTTP ${response.status}`),
        )
      } catch (error) {
        return LaunchOutcome.launchFailed(error)
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
      const body = await readBody(req)
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
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('worker server: no bound port'))
            return
          }
          resolve(address.port)
        })
      })
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await Promise.allSettled([...inFlight])
    },
  }
}

/**
 * The driver process's HTTP face: POST /wake interrupts the loop's park
 * (unauthenticated by design — a wake is advisory and idempotent; the
 * worst a flood can do is bounded polling, which the loop's ceilings and
 * tick budgets already bound).
 */
export function createWakeServer(loop: DriverLoop): WorkerServer {
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
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('wake server: no bound port'))
            return
          }
          resolve(address.port)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
