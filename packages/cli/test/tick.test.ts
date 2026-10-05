import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type Clock, systemClock } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  COMMANDS,
  TICK_DEFAULT_TIMEOUT_SECONDS,
  TICK_MAX_TIMEOUT_SECONDS,
  VERBS,
} from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import { BODY_MAX_BYTES, TICK_PATH, deploymentOrigin, tickRequest } from '../src/http.js'
import { TICK_TOKEN, dropping, neverEnding, onDeployment, serving } from './hosted.js'
import { BIN, type JsonAnswer, QUEUE, ROOT, runCli } from './support.js'

/**
 * `tick --url` (exit test line 38): one bounded pass of a hosted deployment over HTTP. It
 * opens no store. The deployment here is the driver package's own hosted router behind a
 * listener on the loopback address, at a port the operating system picks.
 */

/** The environment `tick` reads: the deployment, and the token its tick route takes. No store is named. */
const envOf = (deployment: { readonly url: string }, token = TICK_TOKEN) => ({
  DURABLERUN_BASE_URL: deployment.url,
  DURABLERUN_TICK_TOKEN: token,
})

/** Run `tick` with a real clock, in text or with --json. */
async function tick(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock = systemClock(),
) {
  const run = await runCli(['tick', ...argv], env, undefined, undefined, clock)
  const answer = argv.includes('--json') ? (JSON.parse(run.stdout) as JsonAnswer) : undefined
  return { ...run, answer }
}

/**
 * Run the bin as a child process and wait for it without blocking this process, whose
 * listener is the deployment the child calls.
 */
async function bin(argv: readonly string[], env: Readonly<Record<string, string>>) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', BIN, ...argv],
      { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
    )
    return { exit: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string }
    return {
      exit: typeof failed.code === 'number' ? failed.code : -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    }
  }
}

/** A deployment that answers every request the same way. */
const answering = (status: number, body: string, headers: Record<string, string> = {}) =>
  serving(async () => new Response(status === 302 ? null : body, { status, headers }))

/** A clock whose sleeps end at once, and that keeps how long each was asked to be. */
function impatientClock(): { readonly clock: Clock; readonly slept: number[] } {
  const slept: number[] = []
  return {
    slept,
    clock: {
      nowEpochMs: () => 0,
      elapsedMs: () => 0,
      yieldTurn: () => Promise.resolve(),
      sleep: (ms) => {
        slept.push(ms)
        return new Promise((resolve) => setImmediate(resolve))
      },
    },
  }
}

describe('tick --url against a hosted router on the loopback address', () => {
  it("returns the router's tick body, for the pass the router ran, and opens no store", () =>
    onDeployment(
      'libsql',
      'tick-pass',
      new Map([['job', async () => 'done']]),
      async (db, deployment) => {
        const task = await db.store.spawn(QUEUE, 'job', '{}')
        const run = await tick(['--url', deployment.url, '--json'], envOf(deployment))
        expect(run.exit, run.stdout).toBe(0)
        // The body the CLI prints is the body the router answered, whole.
        expect(deployment.answers).toHaveLength(1)
        expect(
          run.answer?.tick,
          'mutation-verdict:behavior:cli-tick-returns-the-routers-body',
        ).toEqual(JSON.parse(deployment.answers[0]?.body ?? 'null'))
        expect(run.answer).toMatchObject({
          status: 200,
          url: `${deployment.url}${TICK_PATH}`,
          tick: { claimed: 1, workerOutcome: { kind: 'completed' }, swept: [] },
        })
        // The router ran the pass: the task it claimed is completed.
        expect((await db.store.getTaskResult(QUEUE, task.taskId))?.state).toBe('completed')
        // In text the answer prints on stdout.
        const text = await tick(['--url', deployment.url], envOf(deployment))
        expect({
          exit: text.exit,
          stderr: text.stderr,
          claimed: text.stdout.includes('claimed: 0'),
        }).toEqual({
          exit: 0,
          stderr: '',
          claimed: true,
        })
      },
    ))

  it('sends its token in the Authorization header of one POST to the tick route, and nowhere else, and prints it in no stream', () =>
    onDeployment('libsql', 'tick-token', new Map(), async (_db, deployment) => {
      // A --url with a path and a query names the same origin, and the request goes to the
      // tick route all the same.
      const printed: string[] = []
      for (const extra of [[], ['--json']]) {
        const run = await tick(
          ['--url', `${deployment.url}/some/page?x=1`, ...extra],
          envOf(deployment),
        )
        expect(run.exit).toBe(0)
        printed.push(`${run.stdout}${run.stderr}`)
      }
      expect(
        deployment.requests.map((request) => ({
          method: request.method,
          path: request.path,
          authorization: request.headers.authorization,
          body: request.body,
          // The token is in no other header, and in no part of the path.
          elsewhere:
            request.path.includes(TICK_TOKEN) ||
            Object.entries(request.headers).some(
              ([name, value]) => name !== 'authorization' && value.includes(TICK_TOKEN),
            ),
        })),
        'mutation-verdict:behavior:cli-tick-sends-its-token-in-the-authorization-header-alone',
      ).toEqual(
        [0, 1].map(() => ({
          method: 'POST',
          path: TICK_PATH,
          authorization: `Bearer ${TICK_TOKEN}`,
          body: '',
          elsewhere: false,
        })),
      )
      expect(printed.map((text) => text.includes(TICK_TOKEN))).toEqual([false, false])
    }))

  it('exits 4 when the deployment refuses the token, and prints neither token', () =>
    onDeployment('libsql', 'tick-wrong-token', new Map(), async (_db, deployment) => {
      const wrong = 'a-wrong-token-91c2'
      const run = await tick(['--url', deployment.url, '--json'], envOf(deployment, wrong))
      expect(
        {
          exit: run.exit,
          kind: run.answer?.error?.kind,
          status: run.answer?.status,
          code: run.answer?.code,
        },
        'mutation-verdict:behavior:cli-tick-exits-4-for-a-refused-token',
      ).toEqual({
        exit: exitCode('unauthorized'),
        kind: 'unauthorized',
        status: 401,
        code: 'unauthenticated',
      })
      const text = await tick(['--url', deployment.url], envOf(deployment, wrong))
      // In text a refusal prints on stderr.
      expect({ exit: text.exit, stdout: text.stdout }).toEqual({
        exit: exitCode('unauthorized'),
        stdout: '',
      })
      for (const printed of [run.stdout, run.stderr, text.stderr]) {
        expect([printed.includes(wrong), printed.includes(TICK_TOKEN)]).toEqual([false, false])
      }
      // The router ran no pass for it.
      expect(deployment.answers.map((answer) => answer.status)).toEqual([401, 401])
    }))

  it('sends nothing when --url names another origin: neither listener records a connection', async () => {
    const named = await answering(200, '{}')
    const other = await answering(200, '{}')
    try {
      const run = await tick(['--url', other.url, '--json'], envOf(named))
      expect(
        {
          exit: run.exit,
          kind: run.answer?.error?.kind,
          connections: [named.connections(), other.connections()],
        },
        'mutation-verdict:behavior:cli-tick-sends-only-to-the-origin-the-environment-names',
      ).toEqual({ exit: 2, kind: 'origin-mismatch', connections: [0, 0] })
      // The refusal names the origin the environment names, and never the token.
      expect(run.answer?.error?.message).toContain(named.url)
      expect(run.stdout.includes(TICK_TOKEN)).toBe(false)
      // The same host under another scheme or port is another origin.
      const port = new URL(named.url).port
      for (const url of [
        `https://127.0.0.1:${port}`,
        'http://127.0.0.1',
        `http://localhost:${port}`,
      ]) {
        expect((await tick(['--url', url, '--json'], envOf(named))).exit).toBe(2)
      }
      expect([named.connections(), other.connections()]).toEqual([0, 0])
      // The control: the origin the environment names is sent to, once.
      expect((await tick(['--url', named.url, '--json'], envOf(named))).exit).toBe(0)
      expect([named.connections(), other.connections()]).toEqual([1, 0])
    } finally {
      await named.close()
      await other.close()
    }
  })

  it('follows no redirect: a deployment that answers with one is not a tick route, and the token goes to no second origin', async () => {
    const second = await answering(200, '{}')
    const first = await answering(302, '', { location: `${second.url}${TICK_PATH}` })
    try {
      const run = await tick(['--url', first.url, '--json'], envOf(first))
      expect(
        { exit: run.exit, status: run.answer?.status, reached: second.connections() },
        'mutation-verdict:behavior:cli-tick-follows-no-redirect',
      ).toEqual({ exit: exitCode('permanent'), status: 302, reached: 0 })
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('ends its wait through the clock it was handed, and exits 6 for an answer that does not come', async () => {
    // A deployment that takes a request and never answers it.
    const silent = await serving(() => new Promise<Response>(() => undefined))
    try {
      const { clock, slept } = impatientClock()
      const run = await tick(
        ['--url', silent.url, '--timeout', '30s', '--json'],
        envOf(silent),
        clock,
      )
      expect(
        { exit: run.exit, kind: run.answer?.error?.kind, slept },
        'mutation-verdict:behavior:cli-tick-ends-its-wait-through-the-clock',
      ).toEqual({ exit: exitCode('unavailable'), kind: 'timed-out', slept: [30_000] })
      // With no --timeout the wait is the default.
      const byDefault = impatientClock()
      await tick(['--url', silent.url, '--json'], envOf(silent), byDefault.clock)
      expect(byDefault.slept).toEqual([TICK_DEFAULT_TIMEOUT_SECONDS * 1000])
    } finally {
      await silent.close()
    }
  })

  it('waits by a clock that keeps time up to the longest wait a timer holds, and refuses a longer wait before anything is sent', async () => {
    // A deployment that answers after a moment. A wait that ended at once would not see it.
    const slow = await serving(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      return new Response('{"swept":[]}', { status: 200 })
    })
    try {
      const asked = (timeout: string) =>
        tick(['--url', slow.url, '--timeout', timeout, '--json'], envOf(slow))
      const longest = await asked(`${TICK_MAX_TIMEOUT_SECONDS}s`)
      const days = await asked('24d')
      const sent = slow.connections()
      const past = await asked(`${TICK_MAX_TIMEOUT_SECONDS + 1}s`)
      const moreDays = await asked('25d')
      const refused = (run: Awaited<ReturnType<typeof asked>>) => [
        run.exit,
        run.answer?.error?.kind,
        run.answer?.error?.message?.includes(`${TICK_MAX_TIMEOUT_SECONDS}s`),
      ]
      expect(
        {
          longest: [longest.exit, longest.answer?.timeoutSeconds],
          days: [days.exit, days.answer?.timeoutSeconds],
          past: refused(past),
          moreDays: refused(moreDays),
          sentWhenRefused: slow.connections() - sent,
        },
        'mutation-verdict:behavior:cli-tick-refuses-a-wait-a-timer-cannot-hold',
      ).toEqual({
        // 2^31 - 1 milliseconds, in whole seconds.
        longest: [0, 2_147_483],
        days: [0, 24 * 86_400],
        past: [2, 'usage', true],
        moreDays: [2, 'usage', true],
        sentWhenRefused: 0,
      })
    } finally {
      await slow.close()
    }
  })

  it('reads a long answer as it arrives: a pass that swept 600 rows prints whole, and an answer that never ends is cut at the cap and named', async () => {
    const swept = Array.from({ length: 600 }, (_, row) => ({
      kind: 'claim-timeout',
      taskId: `task-${row}`.padEnd(64, 't'),
      runId: `run-${row}`.padEnd(64, 'r'),
    }))
    const long = await answering(200, JSON.stringify({ swept, claimed: 0 }))
    const endless = await neverEnding(200)
    try {
      const whole = await tick(['--url', long.url, '--json'], envOf(long))
      const cut = await tick(['--url', endless.url, '--timeout', '5s', '--json'], envOf(endless))
      expect(
        {
          whole: [
            whole.exit,
            (whole.answer?.tick as { swept?: unknown[] } | undefined)?.swept?.length,
          ],
          cut: [cut.exit, cut.answer?.error?.kind, cut.answer?.status],
          // It let go at the cap, and did not read for as long as it was allowed to wait.
          letGoAtTheCap: endless.written() < 8 * BODY_MAX_BYTES,
        },
        'mutation-verdict:behavior:cli-tick-reads-no-more-of-an-answer-than-its-cap',
      ).toEqual({
        whole: [0, 600],
        cut: [exitCode('permanent'), 'answer-too-large', 200],
        letGoAtTheCap: true,
      })
    } finally {
      await long.close()
      await endless.close()
    }
  }, 60_000)

  it('answers a deployment that cannot be reached or says try later with exit 6, and one whose answer a repeat would not change with exit 7', async () => {
    // A listener that drops every connection: the request fails by construction.
    const gone = await dropping()
    const answers = {
      unavailable: await answering(503, '{"error":"service_unavailable"}'),
      badGateway: await answering(502, '<html>bad gateway</html>'),
      gatewayTimeout: await answering(504, ''),
      tooMany: await answering(429, '{"error":"rate_limited"}'),
      // A 500 that is not the router's own: the platform under it failed.
      crashed: await answering(500, 'the function crashed'),
      // The router's own answer to a failure no retry cures.
      permanent: await answering(500, '{"error":"internal_error"}'),
      notFound: await answering(404, '{"error":"not_found"}'),
      notJson: await answering(200, '<html>a page</html>'),
    }
    try {
      const asked = async (deployment: { url: string }) => {
        const run = await tick(['--url', deployment.url, '--json'], envOf(deployment))
        return [run.exit, run.answer?.error?.kind, run.answer?.status, run.answer?.code]
      }
      const said: Record<string, unknown> = { gone: await asked(gone) }
      for (const [name, deployment] of Object.entries(answers)) {
        said[name] = await asked(deployment)
      }
      const outage = exitCode('unavailable')
      const permanent = exitCode('permanent')
      expect(
        said,
        'mutation-verdict:behavior:cli-tick-exits-6-for-an-answer-that-says-try-later',
      ).toEqual({
        gone: [outage, 'unreachable', undefined, undefined],
        unavailable: [outage, 'deployment-unavailable', 503, 'service_unavailable'],
        badGateway: [outage, 'deployment-unavailable', 502, undefined],
        gatewayTimeout: [outage, 'deployment-unavailable', 504, undefined],
        tooMany: [outage, 'deployment-unavailable', 429, 'rate_limited'],
        crashed: [outage, 'deployment-unavailable', 500, undefined],
        permanent: [permanent, 'deployment-error', 500, 'internal_error'],
        notFound: [permanent, 'unexpected-answer', 404, 'not_found'],
        notJson: [permanent, 'unexpected-answer', 200, undefined],
      })
      // The request reached the listener, and the listener dropped it.
      expect(gone.dropped()).toBeGreaterThan(0)
      // Every exit `tick` gave here and above is one the table declares for it.
      for (const exit of ['unavailable', 'permanent', 'unauthorized', 'usage', 'done'] as const) {
        expect(COMMANDS.tick.exits).toContain(exit)
      }
    } finally {
      await gone.close()
      for (const deployment of Object.values(answers)) await deployment.close()
    }
  })

  it('refuses a command line it cannot send, and sends nothing: no --url, a timeout it cannot read, no deployment named, no token', async () => {
    const deployment = await answering(200, '{}')
    try {
      const refused = async (argv: string[], env: Record<string, string | undefined>) => {
        const run = await tick([...argv, '--json'], env)
        return [run.exit, run.answer?.error?.kind]
      }
      const env = envOf(deployment)
      expect({
        noUrl: await refused([], env),
        zero: await refused(['--url', deployment.url, '--timeout', '0s'], env),
        unread: await refused(['--url', deployment.url, '--timeout', 'soon'], env),
        noDeployment: await refused(['--url', deployment.url], {
          DURABLERUN_TICK_TOKEN: TICK_TOKEN,
        }),
        noToken: await refused(['--url', deployment.url], { DURABLERUN_BASE_URL: deployment.url }),
      }).toEqual({
        noUrl: [2, 'usage'],
        zero: [2, 'usage'],
        unread: [2, 'usage'],
        noDeployment: [2, 'usage'],
        noToken: [2, 'usage'],
      })
      expect(deployment.connections()).toBe(0)
      // With no --url it says what it is not: a pass over a store, which `sweep` is part of.
      const noUrl = await tick(['--json'], env)
      expect(noUrl.answer?.error?.message).toContain('sweep')
      // It reads nothing of the store: a store URL that no client takes changes nothing.
      const beside = await tick(['--url', deployment.url, '--json'], {
        ...env,
        DURABLERUN_STORE_URL: 'not a store url',
      })
      expect(beside.exit).toBe(0)
    } finally {
      await deployment.close()
    }
  })

  it(
    'bin/durablerun.ts runs a tick of the deployment and exits 0 with its body, and exits 4 for a token the deployment refuses',
    () =>
      onDeployment('libsql', 'tick-bin', new Map(), async (_db, deployment) => {
        const wrongToken = 'a-wrong-token-91c2'
        const argv = ['tick', '--url', deployment.url, '--json']
        const right = await bin(argv, envOf(deployment))
        expect(right.exit, right.stderr).toBe(0)
        expect((JSON.parse(right.stdout) as JsonAnswer).tick).toEqual(
          JSON.parse(deployment.answers[0]?.body ?? 'null'),
        )
        const wrong = await bin(argv, envOf(deployment, wrongToken))
        expect(wrong.exit).toBe(exitCode('unauthorized'))
        // With no deployment named the bin exits 2, and it has sent nothing.
        const unnamed = await bin(argv, { DURABLERUN_TICK_TOKEN: TICK_TOKEN })
        expect([unnamed.exit, deployment.requests.length]).toEqual([2, 2])
        for (const run of [right, wrong, unnamed]) {
          const printed = `${run.stdout}${run.stderr}`
          expect([printed.includes(TICK_TOKEN), printed.includes(wrongToken)]).toEqual([
            false,
            false,
          ])
        }
      }),
    120_000,
  )

  it('is the only command that takes --url: every other command refuses it and opens nothing', async () => {
    for (const verb of VERBS) {
      if (verb === 'tick') continue
      const run = await runCli([verb, '--url', 'https://deployment.example'], {
        DURABLERUN_STORE_URL: 'mysql://root@db.invalid/never',
      })
      expect({ verb, exit: run.exit }).toEqual({ verb, exit: 2 })
    }
    expect(Object.keys(COMMANDS.tick.flags)).toContain('url')
    expect(COMMANDS.tick.opensStore).toBe(false)
  })
})

describe('where tick sends its token', () => {
  const HTTPS = 'https://deployment.example'

  it('names the tick route of the origin the environment names, whatever path either URL holds', () => {
    expect(
      tickRequest({ url: `${HTTPS}/a/page?x=1#y`, baseUrl: `${HTTPS}/app`, token: 't' }),
    ).toEqual({
      endpoint: `${HTTPS}${TICK_PATH}`,
      token: 't',
    })
    // The default port of a scheme is the same origin written out.
    expect(tickRequest({ url: `${HTTPS}:443`, baseUrl: HTTPS, token: 't' })).toEqual({
      endpoint: `${HTTPS}${TICK_PATH}`,
      token: 't',
    })
  })

  it('sends only over https, or over http to a loopback address', () => {
    const sendsTo = (url: string) => {
      const request = tickRequest({ url: url, baseUrl: url, token: 't' })
      return 'endpoint' in request ? request.endpoint : request.kind
    }
    expect(
      {
        https: sendsTo(HTTPS),
        loopback4: sendsTo('http://127.0.0.1'),
        loopback6: sendsTo('http://[::1]'),
        localhost: sendsTo('http://localhost'),
        http: sendsTo('http://deployment.example'),
        // A host that begins like a loopback address is not one.
        lookalike: sendsTo('http://127.0.0.1.example'),
        ftp: sendsTo('ftp://deployment.example'),
        notAUrl: sendsTo('deployment.example'),
      },
      'mutation-verdict:behavior:cli-tick-sends-over-https-or-to-loopback-alone',
    ).toEqual({
      https: `${HTTPS}${TICK_PATH}`,
      loopback4: `http://127.0.0.1${TICK_PATH}`,
      loopback6: `http://[::1]${TICK_PATH}`,
      localhost: `http://localhost${TICK_PATH}`,
      http: 'usage',
      lookalike: 'usage',
      ftp: 'usage',
      notAUrl: 'usage',
    })
  })

  it('refuses a URL that carries a credential and a token a header cannot carry, and quotes neither', () => {
    const secret = 'pw-5e1d'
    const withCredential = `https://admin:${secret}@deployment.example`
    const refusals = [
      tickRequest({ url: HTTPS, baseUrl: withCredential, token: 't' }),
      tickRequest({ url: withCredential, baseUrl: HTTPS, token: 't' }),
      tickRequest({ url: HTTPS, baseUrl: HTTPS, token: `two\nlines-${secret}` }),
      tickRequest({ url: HTTPS, baseUrl: HTTPS, token: `a space ${secret}` }),
      tickRequest({ url: HTTPS, baseUrl: HTTPS, token: '' }),
      tickRequest({ url: HTTPS, baseUrl: HTTPS, token: undefined }),
      tickRequest({ url: HTTPS, baseUrl: undefined, token: 't' }),
    ]
    expect(
      refusals.map((refusal) =>
        'refused' in refusal ? [refusal.kind, refusal.refused.includes(secret)] : 'sent',
      ),
      'mutation-verdict:behavior:cli-tick-refuses-a-credential-in-a-url',
    ).toEqual(refusals.map(() => ['usage', false]))
    // The origin `explain` fills a suggestion from is held to the same rule.
    expect([
      deploymentOrigin(withCredential),
      deploymentOrigin(`${HTTPS}/app`),
      deploymentOrigin(''),
    ]).toEqual([undefined, HTTPS, undefined])
  })
})
