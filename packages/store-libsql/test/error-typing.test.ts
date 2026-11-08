import { describe, expect, it } from 'vitest'
import { LibsqlExecutor } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'
import { openServerAnswering } from '../src/testing.js'

/**
 * How the executor types what the real libSQL client throws when a server answers a status
 * and nothing more. No libSQL server runs in a test, so a loopback server that answers one
 * status stands for it: what the client makes of the status is the client's own. A hosted
 * server was measured to answer 401 for a token whose signature it does not accept and for
 * no token at all, and 400 for a token that is not a token at all.
 */
describe('what the real libSQL client throws when a server answers a status', () => {
  /** What a read batch throws, with the code and the status the driver's error carries. */
  const answered = async (status: number, over: 'url' | 'webSocketUrl' = 'url') => {
    const server = await openServerAnswering(status)
    const executor = LibsqlExecutor.open(server[over], 'a-token-the-server-refuses')
    try {
      const thrown: unknown = await executor
        .batch('typed', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
        .then(
          () => 'answered',
          (error: unknown) => error,
        )
      const driver = (thrown as Error).cause as { code?: unknown; cause?: unknown } | undefined
      return {
        name: (thrown as Error).name,
        code: driver?.code,
        status: (driver?.cause as { status?: unknown } | undefined)?.status,
        // The answer is this server's, and not a connection that nothing took.
        reached: server.requests() > 0,
      }
    } finally {
      executor.close()
      await server.close()
    }
  }

  it('types a 401 and a 403 an access refusal, from the status the client carries as a number', async () => {
    expect(
      { unauthorized: await answered(401), forbidden: await answered(403) },
      'mutation-verdict:behavior:libsql-401-is-an-access-refusal',
    ).toEqual({
      unauthorized: {
        name: 'StoreAccessRefusedError',
        code: 'SERVER_ERROR',
        status: 401,
        reached: true,
      },
      forbidden: {
        name: 'StoreAccessRefusedError',
        code: 'SERVER_ERROR',
        status: 403,
        reached: true,
      },
    })
  })

  it('leaves every other status an outage, a 400 among them, which a hosted server answers a token that is not a token at all', async () => {
    const statuses = [400, 404, 429, 500, 503]
    const observed: Record<number, unknown> = {}
    for (const status of statuses) observed[status] = await answered(status)
    expect(observed).toEqual(
      Object.fromEntries(
        statuses.map((status) => [
          status,
          { name: 'StoreUnavailableError', code: 'SERVER_ERROR', status, reached: true },
        ]),
      ),
    )
  })

  // The executor reads two wordings of the client's message, a schema fault's and a missing
  // version table's. A server's own text beside a status must reach neither reading: a
  // refused credential read as a database that was never initialized would have `migrate`
  // send its bootstrap.
  it('types a 401 an access refusal whatever text the server sends beside it, the wording of a missing version table included', async () => {
    const server = await openServerAnswering(401, 'no such table: meta')
    const executor = LibsqlExecutor.open(server.url, 'a-token-the-server-refuses')
    try {
      const thrown: unknown = await executor
        .batch('migrate:version', [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }], 'read')
        .then(
          () => 'answered',
          (error: unknown) => error,
        )
      expect(
        {
          name: (thrown as Error).name,
          // The control: the text did reach the client's message.
          quoted: String((thrown as Error).cause).endsWith('no such table: meta'),
        },
        'mutation-verdict:behavior:libsql-refused-status-is-read-before-message-text',
      ).toEqual({ name: 'StoreAccessRefusedError', quoted: true })
    } finally {
      executor.close()
      await server.close()
    }
  })

  // The client reports a WebSocket upgrade the server refused under one code whatever the
  // status, and carries the status only inside its message. The executor reads no message,
  // so such a refusal keeps the type it had.
  it('leaves a WebSocket upgrade that a server answers 401 an outage, because the client carries that status only in its message', async () => {
    expect(await answered(401, 'webSocketUrl')).toEqual({
      name: 'StoreUnavailableError',
      code: 'HRANA_WEBSOCKET_ERROR',
      status: undefined,
      reached: true,
    })
  })
})
