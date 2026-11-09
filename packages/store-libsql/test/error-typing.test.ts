import { type Server, createServer } from 'node:http'
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

  /**
   * The bodies a server, or a gateway in front of one, sends beside a 401 or a 403, each
   * with the content type it is sent under. The client reads an answer three ways by its
   * content type, and one of them, a JSON body with a `message` member, keeps no status.
   * So the shapes cover every arm of that reading, and a JSON body it cannot read at all.
   */
  const REFUSAL_BODIES: readonly { shape: string; contentType?: string; body: string }[] = [
    { shape: 'no content type and no body', body: '' },
    { shape: 'plain text', contentType: 'text/plain', body: 'Unauthorized' },
    { shape: 'a page', contentType: 'text/html', body: '<h1>Unauthorized</h1>' },
    {
      shape: 'JSON with an error member',
      contentType: 'application/json',
      body: '{"error":"Unauthorized"}',
    },
    {
      shape: 'JSON with a message member',
      contentType: 'application/json',
      body: '{"message":"Unauthorized"}',
    },
    {
      shape: 'JSON with a message member, under a content type with a charset',
      contentType: 'application/json; charset=utf-8',
      body: '{"message":"Unauthorized"}',
    },
    {
      shape: 'JSON whose message is the wording of a missing version table',
      contentType: 'application/json',
      body: '{"message":"no such table: meta"}',
    },
    {
      shape: 'JSON whose message is the wording of a schema fault',
      contentType: 'application/json',
      body: '{"message":"no such column: x"}',
    },
    {
      shape: 'JSON with a message and the code of a broken constraint',
      contentType: 'application/json',
      body: '{"message":"Forbidden","code":"SQLITE_CONSTRAINT"}',
    },
    { shape: 'JSON that is null', contentType: 'application/json', body: 'null' },
    { shape: 'JSON that does not parse', contentType: 'application/json', body: '{"message":' },
    { shape: 'JSON with no body', contentType: 'application/json', body: '' },
  ]

  it('types a 401 and a 403 an access refusal under every body and content type a server sends beside it, for the version read and for another read', async () => {
    const reads = [
      { label: 'migrate:version', sql: SCHEMA_VERSION_READ_SQL },
      { label: 'typed', sql: 'SELECT 1 AS answered' },
    ]
    const observed: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const status of [401, 403]) {
      for (const { shape, contentType, body } of REFUSAL_BODIES) {
        for (const { label, sql } of reads) {
          const server = await openServerAnswering(status, body, contentType)
          const executor = LibsqlExecutor.open(server.url, 'a-token-the-server-refuses')
          try {
            const thrown: unknown = await executor.batch(label, [{ sql, args: [] }], 'read').then(
              () => 'answered',
              (error: unknown) => error,
            )
            const driver = (thrown as Error).cause as { cause?: { status?: unknown } } | undefined
            const named = `${status}, ${shape}, ${label}`
            observed[named] = { name: (thrown as Error).name, status: driver?.cause?.status }
            expected[named] = { name: 'StoreAccessRefusedError', status }
          } finally {
            executor.close()
            await server.close()
          }
        }
      }
    }
    expect(Object.keys(observed)).toHaveLength(2 * REFUSAL_BODIES.length * reads.length)
    expect(
      observed,
      'mutation-verdict:behavior:libsql-refused-status-is-kept-under-every-body',
    ).toEqual(expected)
  })

  /**
   * A loopback server that stands for a libSQL server over HTTP far enough for one batch:
   * it answers the client's version requests with `versionStatus`, and answers every request
   * of a pipeline with one statement error. Status 200, as a real server answers a statement
   * it could not run.
   */
  const openServerFailingEveryStatement = async (versionStatus: number, message: string) => {
    const server: Server = createServer((request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = versionStatus
        response.end()
        return
      }
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const sent = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { requests: unknown[] }
        response.statusCode = 200
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            baton: null,
            base_url: null,
            results: sent.requests.map(() => ({
              type: 'error',
              error: { message, code: 'SQLITE_UNKNOWN' },
            })),
          }),
        )
      })
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
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)))
          server.closeAllConnections()
        }),
    }
  }

  /** What the version read throws against a server that fails every statement with a text. */
  const versionReadAgainst = async (versionStatus: number, message: string) => {
    const server = await openServerFailingEveryStatement(versionStatus, message)
    const executor = LibsqlExecutor.open(server.url, 'a-token-the-server-takes')
    try {
      const thrown: unknown = await executor
        .batch('migrate:version', [{ sql: SCHEMA_VERSION_READ_SQL, args: [] }], 'read')
        .then(
          () => 'answered',
          (error: unknown) => error,
        )
      return (thrown as Error).name
    } finally {
      executor.close()
      await server.close()
    }
  }

  // The control of the case above: the wording of a missing version table is still read
  // where a server answered the statement, with status 200.
  it('still reads a database that was never initialized from a statement error a server answers with status 200', async () => {
    expect(await versionReadAgainst(404, 'SQLite error: no such table: meta')).toBe(
      'SchemaNotInitializedError',
    )
  })

  // The client asks a server which protocol versions it speaks before its first batch, and
  // takes an answer that is no success to mean "not this version". A server that answers
  // those requests 401 and then takes the batch is therefore answered by the batch.
  it('leaves the client to take a 401 on its version requests as a version the server does not speak, and types the batch by its own answer', async () => {
    expect(
      await versionReadAgainst(401, 'SQLite error: no such table: meta'),
      'mutation-verdict:behavior:libsql-refused-version-request-falls-through',
    ).toBe('SchemaNotInitializedError')
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
