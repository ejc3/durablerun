import { type Server, createServer } from 'node:http'
import type { IdSource } from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { createClient } from '@libsql/client'
import { LibsqlStoreAdmin } from './admin.js'
import { LibsqlExecutor } from './executor.js'

/** Core's deterministic test id source, under the name this package released. */
export { testIdSource }

/**
 * A database migrated to the current schema by default, with the engine clock
 * frozen when `nowMs` is given. It is in memory unless `url` names another
 * database, which the chaos tests use to share a file with real host
 * processes. Those hosts open the file themselves, but everything written here
 * lands in that file: `nowMs` stores a frozen clock that every process using the
 * file then reads, so do not combine it with a shared `url`. Admin conformance can request the
 * same fixture before migration with `migrate: false`.
 *
 * Four lines, and every test file that wanted a database wrote its own copy
 * of them — twenty-two of them, across five packages. That is not a tidiness
 * complaint: the copies DRIFTED, and one of the ways they drifted caused a
 * real failure. A fixture that handed consecutive batches the same token
 * seed let a no-op batch borrow an older batch's fence. The helper now returns
 * one source alongside each database, and the converted routine fixture
 * stores share it. `one-batch-two-instants` remains a cross-instant
 * consistency alarm; it cannot prove token issuance was unique at one instant
 * or after evidence was overwritten.
 *
 * It lives in this package rather than in `conformance` because the
 * dependency runs that way: `conformance` devDepends on `store-libsql`, so a
 * helper here can serve both, and one over there could never serve the
 * store's own tests. Exported under `@durablerun/store-libsql/testing` so it
 * stays out of the package's main barrel.
 */
export async function openTestDb(
  opts: { url?: string; nowMs?: number; idNamespace?: string; migrate?: boolean } = {},
): Promise<{
  raw: LibsqlExecutor
  admin: LibsqlStoreAdmin
  ids: IdSource
  close: () => void
}> {
  const raw = LibsqlExecutor.open(opts.url ?? ':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  const ids = testIdSource(opts.idNamespace)
  if (opts.migrate !== false) await admin.migrate()
  if (opts.nowMs !== undefined) await admin.setFakeNowEpochMs(opts.nowMs)
  return { raw, admin, ids, close: () => raw.close() }
}

/**
 * Holds a database file's write lock from a connection of its own until `during` settles, for
 * a case that makes an executor wait for the lock and give up. The lock is taken and given
 * back by statements on one connection, which close() then closes.
 */
export async function holdLibsqlWriteLock(url: string, during: () => Promise<void>): Promise<void> {
  const holder = createClient({ url })
  try {
    await holder.execute('BEGIN IMMEDIATE')
    try {
      await during()
    } finally {
      await holder.execute('ROLLBACK')
    }
  } finally {
    holder.close()
  }
}

/**
 * A loopback HTTP server that answers every request, and every WebSocket upgrade, with one
 * status, for a case that needs what the real client throws when a server refuses it. No
 * libSQL server runs in a test here, and what the client makes of a status is the client's
 * own, so a server that only answers a status is enough to learn it. `url` is one the
 * client opens over HTTP with no TLS, and `webSocketUrl` one it opens as a WebSocket.
 * `requests` counts what reached the server, so a case can tell an answer of this server
 * from a connection nothing took. `body` is the text sent with the status to an HTTP
 * request, which the client quotes in its message.
 */
export async function openServerAnswering(
  status: number,
  body = '',
): Promise<{
  url: string
  webSocketUrl: string
  requests: () => number
  close: () => Promise<void>
}> {
  let requests = 0
  const server: Server = createServer((_request, response) => {
    requests += 1
    response.statusCode = status
    response.end(body)
  })
  server.on('upgrade', (_request, socket) => {
    requests += 1
    socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('the loopback server has no port')
  }
  return {
    url: `libsql://127.0.0.1:${address.port}?tls=0`,
    webSocketUrl: `ws://127.0.0.1:${address.port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
        server.closeAllConnections()
      }),
  }
}
