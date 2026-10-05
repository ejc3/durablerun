import { type IncomingMessage, createServer } from 'node:http'
import { type Server, createServer as createTcpServer } from 'node:net'
import { systemClock } from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { bearerAuthorization, createHostedRouter } from '@durablerun/driver'
import type { TaskRegistry } from '@durablerun/sdk'
import { type CliDb, QUEUE, openCliDb } from './support.js'

/**
 * A hosted deployment for the tests of `tick`: the driver package's own hosted router over
 * a test database's store, behind an HTTP listener on the loopback address. The listener
 * takes a port the operating system picks, so no test holds a port number. The router is
 * the one a deployment mounts, with its bearer authorization, so what `tick` is answered
 * here is what a deployment answers.
 */
/** One request a listener was sent: its method, its path, its headers and its body. */
export interface SentRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface HostedDeployment {
  /** The deployment's base URL, `http://127.0.0.1:<port>`. */
  readonly url: string
  /** Every request the listener was sent, in order. */
  readonly requests: readonly SentRequest[]
  /** Every answer the listener gave, in order: its status and its body. */
  readonly answers: readonly { readonly status: number; readonly body: string }[]
  /** How many connections the listener accepted, whether or not a request followed. */
  connections(): number
  close(): Promise<void>
}

/** A request's headers, each as one string. */
function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

/** A request's body as text: every body these tests send is JSON or empty. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/** A listener on the loopback address at a port the operating system picks, and that port. */
function listening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('no bound port'))
      else resolve(address.port)
    })
  })
}

/**
 * Serve `answer` on the loopback address. `answer` is handed each request as the platform's
 * Request and answers with a Response, as a hosted router does.
 */
export async function serving(
  answer: (request: Request) => Promise<Response>,
): Promise<HostedDeployment> {
  const requests: SentRequest[] = []
  const answers: { status: number; body: string }[] = []
  let accepted = 0
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const method = incoming.method ?? 'GET'
      const path = incoming.url ?? '/'
      const headers = headersOf(incoming)
      const body = await bodyOf(incoming)
      requests.push({ method, path, headers, body })
      const response = await answer(
        new Request(`http://${headers.host ?? '127.0.0.1'}${path}`, {
          method,
          headers,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
        }),
      )
      const answered = await response.text()
      answers.push({ status: response.status, body: answered })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(answered)
    })().catch(() => {
      outgoing.writeHead(500).end()
    })
  })
  server.on('connection', () => {
    accepted += 1
  })
  const port = await listening(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answers,
    connections: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** A listener that is no hosted router: where it is, and how to close it. */
export interface Listener {
  readonly url: string
  close(): Promise<void>
}

/**
 * A listener that takes every connection and drops it before any answer. A request to it
 * fails by construction, on a busy host too: nothing depends on a port staying free.
 */
export async function dropping(): Promise<Listener & { dropped(): number }> {
  let dropped = 0
  const server = createTcpServer((socket) => {
    dropped += 1
    socket.destroy()
  })
  const port = await listening(server)
  return {
    url: `http://127.0.0.1:${port}`,
    dropped: () => dropped,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/**
 * A deployment whose answer never ends: it sends its status and then its body in pieces,
 * for as long as the caller holds the connection. `written` is how many bytes of body it
 * has handed over.
 */
export async function neverEnding(status: number): Promise<Listener & { written(): number }> {
  let written = 0
  const piece = Buffer.alloc(256 * 1024, ' ')
  const writing = new Set<ReturnType<typeof setInterval>>()
  const server = createServer((incoming, outgoing) => {
    incoming.resume()
    outgoing.writeHead(status, { 'content-type': 'application/json' })
    const timer = setInterval(() => {
      written += piece.byteLength
      outgoing.write(piece)
    }, 5)
    writing.add(timer)
    outgoing.on('close', () => {
      clearInterval(timer)
      writing.delete(timer)
    })
  })
  const port = await listening(server)
  return {
    url: `http://127.0.0.1:${port}`,
    written: () => written,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of writing) clearInterval(timer)
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** The token the test deployment's tick route takes. */
export const TICK_TOKEN = 'tick-token-7f3a'

/**
 * The hosted router over a test database, for its queue, with the handlers given. Its tick
 * route takes `TICK_TOKEN` as a bearer and refuses every other request.
 */
export function hostedDeployment(db: CliDb, registry: TaskRegistry): Promise<HostedDeployment> {
  const router = createHostedRouter({
    store: db.store,
    ids: testIdSource('hosted'),
    clock: systemClock(),
    registry,
    authorization: bearerAuthorization({ token: TICK_TOKEN }),
    queue: QUEUE,
    sweepLimit: 10,
    leaseSeconds: 60,
  })
  return serving((request) => router.handle(request))
}

/** A test database of one dialect and a deployment over it, both closed whatever the body does. */
export async function onDeployment<T>(
  dialect: Parameters<typeof openCliDb>[0],
  name: string,
  registry: TaskRegistry,
  body: (db: CliDb, deployment: HostedDeployment) => Promise<T>,
): Promise<T> {
  const db = await openCliDb(dialect, name)
  try {
    const deployment = await hostedDeployment(db, registry)
    try {
      return await body(db, deployment)
    } finally {
      await deployment.close()
    }
  } finally {
    await db.close()
  }
}
