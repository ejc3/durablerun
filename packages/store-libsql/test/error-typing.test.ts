import { type Server, createServer } from 'node:http'
import { type Socket, createServer as createTcpServer } from 'node:net'
import { createClient } from '@libsql/client'
import { describe, expect, it } from 'vitest'
import { LibsqlExecutor, fetchKeepingARefusedStatus } from '../src/executor.js'
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
  /** The statuses the executor types an access refusal, and the others a case answers. */
  const REFUSED_STATUSES = [401, 403]
  const OTHER_STATUSES = [400, 404, 429, 500, 503]

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
    const observed: Record<number, unknown> = {}
    for (const status of OTHER_STATUSES) observed[status] = await answered(status)
    expect(observed).toEqual(
      Object.fromEntries(
        OTHER_STATUSES.map((status) => [
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
    for (const status of REFUSED_STATUSES) {
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
    expect(Object.keys(observed)).toHaveLength(
      REFUSED_STATUSES.length * REFUSAL_BODIES.length * reads.length,
    )
    expect(
      observed,
      'mutation-verdict:behavior:libsql-refused-status-is-kept-under-every-body',
    ).toEqual(expected)
  })

  /**
   * A loopback server that stands for a libSQL server over HTTP far enough for one batch:
   * it answers every request of a pipeline with one statement error. Status 200, as a real
   * server answers a statement it could not run.
   */
  const openServerFailingEveryStatement = async (message: string) => {
    const server: Server = createServer((request, response) => {
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
  const versionReadAgainst = async (message: string) => {
    const server = await openServerFailingEveryStatement(message)
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
    expect(await versionReadAgainst('SQLite error: no such table: meta')).toBe(
      'SchemaNotInitializedError',
    )
  })

  // The executor's `fetch` hands a refused answer on and makes no error of its own: the
  // client makes the error from the answer. The client's library can also ask a server which
  // protocol versions it speaks through the same `fetch`, taking an answer that is no
  // success to mean "not this version", and a `fetch` that threw would end such a client.
  // The client pinned here sends no such request, so the `fetch` is called by itself.
  it('hands a 401 and a 403 on as an answer with the same status and body, as plain text, and throws nothing', async () => {
    const body = '{"message":"Unauthorized"}'
    const observed: Record<number, unknown> = {}
    for (const status of [401, 403]) {
      const server = await openServerAnswering(status, body, 'application/json')
      try {
        const answer: unknown = await fetchKeepingARefusedStatus(
          `http://127.0.0.1:${new URL(server.webSocketUrl).port}/v3`,
        ).catch((error: unknown) => error)
        observed[status] =
          answer instanceof Response
            ? {
                status: answer.status,
                ok: answer.ok,
                contentType: answer.headers.get('content-type'),
                body: await answer.text(),
              }
            : `threw ${String(answer)}`
      } finally {
        await server.close()
      }
    }
    expect(
      observed,
      'mutation-verdict:behavior:libsql-refused-answer-is-handed-on-and-not-thrown',
    ).toEqual({
      401: { status: 401, ok: false, contentType: 'text/plain', body },
      403: { status: 403, ok: false, contentType: 'text/plain', body },
    })
  })

  // The executor's `fetch` hands on as plain text only the two statuses it types. Under any
  // other status the client still reads a JSON body itself, and so still carries the code a
  // server sends there, which says for one what became of a stream.
  it('hands an answer of any other status to the client as it came, so the client still reads the code a server sends in a JSON body', async () => {
    const observed: Record<number, unknown> = {}
    for (const status of [400, 500]) {
      const server = await openServerAnswering(
        status,
        '{"message":"the stream has expired","code":"STREAM_EXPIRED"}',
        'application/json',
      )
      const executor = LibsqlExecutor.open(server.url, 'a-token-the-server-takes')
      try {
        const thrown: unknown = await executor
          .batch('typed', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
          .then(
            () => 'answered',
            (error: unknown) => error,
          )
        const driver = (thrown as Error).cause as { code?: unknown } | undefined
        observed[status] = { name: (thrown as Error).name, code: driver?.code }
      } finally {
        executor.close()
        await server.close()
      }
    }
    expect(
      observed,
      'mutation-verdict:behavior:libsql-other-status-is-handed-on-as-it-came',
    ).toEqual({
      400: { name: 'StoreUnavailableError', code: 'STREAM_EXPIRED' },
      500: { name: 'StoreUnavailableError', code: 'STREAM_EXPIRED' },
    })
  })

  /**
   * A loopback TCP server that answers the first bytes of every connection with what `send`
   * writes, for an answer no HTTP server library sends: a reason phrase of the sender's
   * own, a body cut short, a body that never ends. `close` ends every connection it holds.
   */
  const openRawServer = async (send: (socket: Socket) => void) => {
    const sockets = new Set<Socket>()
    const server = createTcpServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('data', () => send(socket))
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
      url: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        }),
    }
  }

  /** The first bytes of an HTTP answer: the status line with its reason phrase, and headers. */
  const head = (status: number, reason: string, contentType: string | undefined, length: string) =>
    Buffer.from(
      [
        `HTTP/1.1 ${status} ${reason}`,
        ...(contentType === undefined ? [] : [`content-type: ${contentType}`]),
        length,
        '',
        '',
      ].join('\r\n'),
      'latin1',
    )

  /** A whole body, in the shape whose status the client loses under `application/json`. */
  const WHOLE_BODY = '{"message":"Unauthorized"}'

  /**
   * Reason phrases a server may send that a `Response` cannot be built with: a control
   * character, a delete, a NUL, and a byte past ASCII, as a gateway with a localized phrase
   * sends.
   */
  const ODD_REASON_PHRASES = [
    'Un\x01authorized',
    'Un\x7fauthorized',
    'Unauthorized \x00',
    'Caf\xe9',
  ]

  /**
   * Answers that differ from a plain one in something other than the status, the content
   * type and the body: the reason phrase, and how the body ends. `whole` says the body
   * arrives whole. A body that does not is cut short, or never ends.
   */
  type TransportShape = {
    shape: string
    whole: boolean
    send: (socket: Socket, status: number, contentType?: string) => void
  }
  const BODY_CUT_SHORT: TransportShape = {
    shape: 'a body cut short, ten bytes of a hundred and the connection closed',
    whole: false,
    send: (socket, status, contentType) => {
      socket.end(
        Buffer.concat([
          head(status, 'Refused', contentType, 'content-length: 100'),
          Buffer.from(WHOLE_BODY.slice(0, 10)),
        ]),
      )
    },
  }
  const BODY_NEVER_ENDS: TransportShape = {
    shape: 'a chunked body of one chunk on a connection the server holds open',
    whole: false,
    send: (socket, status, contentType) => {
      socket.write(
        Buffer.concat([
          head(status, 'Refused', contentType, 'transfer-encoding: chunked'),
          Buffer.from('5\r\nhello\r\n'),
        ]),
      )
    },
  }
  const sendWhole = (
    socket: Socket,
    status: number,
    reason: string,
    contentType: string | undefined,
    body: string,
  ) => {
    socket.write(
      Buffer.concat([
        head(status, reason, contentType, `content-length: ${Buffer.byteLength(body)}`),
        Buffer.from(body),
      ]),
    )
  }
  const TRANSPORT_SHAPES: readonly TransportShape[] = [
    ...ODD_REASON_PHRASES.map(
      (reason): TransportShape => ({
        shape: `the reason phrase ${JSON.stringify(reason)}`,
        whole: true,
        send: (socket, status, contentType) =>
          sendWhole(socket, status, reason, contentType, WHOLE_BODY),
      }),
    ),
    BODY_CUT_SHORT,
    BODY_NEVER_ENDS,
  ]

  /** How long a case waits for an answer before it says that none came. */
  const NO_ANSWER_MS = 4_000

  /** What `settled` gives, or a sentence that it gave nothing within the limit. */
  const within = async <T>(settled: Promise<T>): Promise<T | string> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`no answer within ${NO_ANSWER_MS} ms`), NO_ANSWER_MS)
    })
    try {
      return await Promise.race([settled, limit])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One read batch over HTTP, through a client the executor opened or through a bare client:
   * one made with no `fetch` option, whose reading of an answer is all the client's own. What
   * it gives is the typed error's name, the status its driver error carries, and its message.
   */
  type Opener = 'the executor' | 'a bare client'
  const readOver = (opener: Opener, url: string) => {
    const executor =
      opener === 'the executor'
        ? LibsqlExecutor.open(url, 'a-token-the-server-refuses')
        : new LibsqlExecutor(createClient({ url, authToken: 'a-token-the-server-refuses' }))
    const settled = executor
      .batch('typed', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
      .then(
        (): { name: string; status?: unknown; message?: string } => ({ name: 'answered' }),
        (error: unknown) => ({
          name: (error as Error).name,
          status: ((error as Error).cause as { cause?: { status?: unknown } } | undefined)?.cause
            ?.status,
          message: (error as Error).message,
        }),
      )
    return { settled, close: () => executor.close() }
  }

  /**
   * What each opener's read gives against a raw server that answers with `send`. A read
   * that has no answer within the limit is ended by closing the server under it.
   */
  const readsOverRawServer = async (send: (socket: Socket) => void, openers: readonly Opener[]) => {
    const server = await openRawServer(send)
    const reads = openers.map((opener) => readOver(opener, server.url))
    try {
      return await Promise.all(reads.map(({ settled }) => within(settled)))
    } finally {
      await server.close()
      await Promise.all(reads.map(({ settled }) => settled))
      for (const { close } of reads) close()
    }
  }

  /** The type and the status of what a read gave, without its message. */
  const typed = (seen: string | { name: string; status?: unknown }) =>
    typeof seen === 'string' ? seen : { name: seen.name, status: seen.status }

  it('types a 401 an access refusal whatever reason phrase the server sends with the status, a control character and a byte past ASCII among them', async () => {
    const observed: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const reason of ODD_REASON_PHRASES) {
      for (const contentType of ['text/html', 'application/json']) {
        const [seen] = await readsOverRawServer(
          (socket) => sendWhole(socket, 401, reason, contentType, WHOLE_BODY),
          ['the executor'],
        )
        const named = `${JSON.stringify(reason)}, ${contentType}`
        observed[named] = typed(seen ?? 'no read')
        expected[named] = { name: 'StoreAccessRefusedError', status: 401 }
      }
    }
    expect(
      observed,
      'mutation-verdict:behavior:libsql-refused-answer-copies-no-reason-phrase',
    ).toEqual(expected)
  })

  it('types a 401 an access refusal when its body is cut short, under a content type whose body the client does not read', async () => {
    const observed: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const contentType of ['text/html', 'application/json; charset=utf-8']) {
      const [seen] = await readsOverRawServer(
        (socket) => BODY_CUT_SHORT.send(socket, 401, contentType),
        ['the executor'],
      )
      const named = `a 401 with ${BODY_CUT_SHORT.shape}, under ${contentType}`
      observed[named] = typed(seen ?? 'no read')
      expected[named] = { name: 'StoreAccessRefusedError', status: 401 }
    }
    expect(
      observed,
      'mutation-verdict:behavior:libsql-only-a-refused-json-answer-is-rewritten',
    ).toEqual(expected)
  })

  it('types a 403 an access refusal without waiting for a body the server never ends, under a content type whose body the client does not read', async () => {
    const [seen] = await readsOverRawServer(
      (socket) => BODY_NEVER_ENDS.send(socket, 403, 'text/html'),
      ['the executor'],
    )
    const named = `a 403 with ${BODY_NEVER_ENDS.shape}, under text/html`
    expect({ [named]: typed(seen ?? 'no read') }).toEqual({
      [named]: { name: 'StoreAccessRefusedError', status: 403 },
    })
  })

  it('keeps the message of a refused 403 under 1,000 characters when the server sends a page of 300 kB with it', async () => {
    const page = `<html>${'x'.repeat(300_000)}</html>`
    const [seen] = await readsOverRawServer(
      (socket) => sendWhole(socket, 403, 'Forbidden', 'text/html; charset=UTF-8', page),
      ['the executor'],
    )
    const read = typeof seen === 'object' ? seen : { name: seen ?? 'no read' }
    expect({ name: read.name, messageUnder1000: (read.message ?? '').length < 1_000 }).toEqual({
      name: 'StoreAccessRefusedError',
      messageUnder1000: true,
    })
  })

  // The executor's `fetch` builds its answer before the body has arrived, so a body that is
  // cut short or never ends fails or waits where it did with no `fetch` of the executor's,
  // in the client's own read. Called by itself, as the case of a whole body below.
  it('hands a 401 under application/json on with its body unread, so a body that is cut short or never ends does not make the fetch throw or wait', async () => {
    const observed: Record<string, unknown> = {}
    const expected: Record<string, unknown> = {}
    for (const { shape, send } of [BODY_CUT_SHORT, BODY_NEVER_ENDS]) {
      const server = await openRawServer((socket) => send(socket, 401, 'application/json'))
      try {
        const answer = await within(
          fetchKeepingARefusedStatus(`${server.url}/v2/pipeline`).catch(
            (error: unknown) => `threw ${String(error)}`,
          ),
        )
        observed[shape] =
          answer instanceof Response
            ? { status: answer.status, contentType: answer.headers.get('content-type') }
            : answer
        expected[shape] = { status: 401, contentType: 'text/plain' }
      } finally {
        await server.close()
      }
    }
    expect(observed, 'mutation-verdict:behavior:libsql-refused-answer-is-handed-on-unread').toEqual(
      expected,
    )
  })

  // The client's library sends with the `fetch` the runtime had when the library loaded. The
  // executor's `fetch` does the same, so a process that replaces the global one later sends
  // its libSQL requests as it did.
  it('sends with the fetch the runtime had when the module loaded, and not with one a process put in its place later', async () => {
    const server = await openServerAnswering(401)
    const runtimeFetch = globalThis.fetch
    let replacementCalls = 0
    globalThis.fetch = () => {
      replacementCalls += 1
      return Promise.reject(new Error('the fetch put in place later was called'))
    }
    let name: string
    try {
      const executor = LibsqlExecutor.open(server.url, 'a-token-the-server-refuses')
      try {
        name = await executor
          .batch('typed', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
          .then(
            () => 'answered',
            (error: unknown) => (error as Error).name,
          )
      } finally {
        executor.close()
      }
    } finally {
      globalThis.fetch = runtimeFetch
      await server.close()
    }
    expect(
      { name, replacementCalls, reached: server.requests() > 0 },
      'mutation-verdict:behavior:libsql-fetch-is-taken-when-the-module-loads',
    ).toEqual({ name: 'StoreAccessRefusedError', replacementCalls: 0, reached: true })
  })

  /**
   * The class the cases above are instances of. The executor's `fetch` is there for one
   * answer, and for every other answer a client the executor opened must give what a bare
   * client gives: the same type, the same status and the same message. The answers are
   * generated: every status of the table above, with every body and content type of the
   * table of bodies, and with every transport shape under every content type of that table.
   */
  it('types every answer as a client with no fetch of the executor does, except a 401 and a 403 under the content type application/json, which are an access refusal where the body is whole', async () => {
    // The one condition, written once: the answers whose status the client loses, which are
    // the answers the executor's `fetch` is for.
    const statusIsLost = (status: number, contentType: string | undefined) =>
      REFUSED_STATUSES.includes(status) && contentType === 'application/json'
    const statuses = [...REFUSED_STATUSES, ...OTHER_STATUSES]
    const contentTypes = [...new Set(REFUSAL_BODIES.map(({ contentType }) => contentType))]

    const compared: { answer: string; executor: unknown; expected: unknown }[] = []
    let excepted = 0
    const compare = (
      answer: { named: string; status: number; contentType: string | undefined; whole: boolean },
      [executor, bare]: readonly (string | { name: string; status?: unknown })[],
    ) => {
      if (executor === undefined || bare === undefined) throw new Error('a read is missing')
      const isExcepted = statusIsLost(answer.status, answer.contentType) && answer.whole
      if (isExcepted) excepted += 1
      compared.push(
        isExcepted
          ? {
              answer: answer.named,
              executor: typed(executor),
              expected: { name: 'StoreAccessRefusedError', status: answer.status },
            }
          : { answer: answer.named, executor, expected: bare },
      )
    }
    const openers = ['the executor', 'a bare client'] as const

    for (const status of statuses) {
      for (const { shape, contentType, body } of REFUSAL_BODIES) {
        const server = await openServerAnswering(status, body, contentType)
        const reads = openers.map((opener) => readOver(opener, server.url))
        try {
          compare(
            { named: `${status}, ${shape}`, status, contentType, whole: true },
            await Promise.all(reads.map(({ settled }) => settled)),
          )
        } finally {
          for (const { close } of reads) close()
          await server.close()
        }
      }
    }
    // The answers of one transport shape are read at once, so the reads that never get an
    // answer wait out one limit together.
    for (const { shape, whole, send } of TRANSPORT_SHAPES) {
      const answers = statuses.flatMap((status) =>
        contentTypes.map((contentType) => ({
          named: `${status}, ${shape}, under ${contentType ?? 'no content type'}`,
          status,
          contentType,
          whole,
        })),
      )
      const reads = await Promise.all(
        answers.map(({ status, contentType }) =>
          readsOverRawServer((socket) => send(socket, status, contentType), openers),
        ),
      )
      answers.forEach((answer, at) => compare(answer, reads[at] ?? []))
    }

    // A generator that draws nothing fails here: 7 statuses, with 12 bodies and with 6
    // transport shapes under 5 content types. The excepted answers are the 2 refused statuses
    // under the 8 bodies and the 4 whole transport shapes of the one content type.
    expect({ compared: compared.length, excepted }).toEqual({
      compared: 7 * (12 + 6 * 5),
      excepted: 2 * (8 + 4),
    })
    expect(
      Object.fromEntries(compared.map(({ answer, executor }) => [answer, executor])),
      'mutation-verdict:behavior:libsql-executor-client-types-as-a-bare-client',
    ).toEqual(Object.fromEntries(compared.map(({ answer, expected }) => [answer, expected])))
  }, 120_000)

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
