import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { observeGitHubChecks } from '../src/github-checks.js'
import type {
  PrCheckObservation,
  PrCheckSelector,
  PrWatchInput,
  PrWatchObservation,
} from '../src/pr-watcher.js'

const SHA = 'a'.repeat(40)
const NEXT_SHA = 'b'.repeat(40)
const NOW = Date.parse('2026-09-09T12:00:00.000Z')
const OBSERVED_AT = new Date(NOW).toISOString()
const ROOT = 'https://api.github.com/repos/example/project'
const REPOSITORY_ID = 12345
const PULL_URL = `${ROOT}/pulls/7`
const CHECK = { kind: 'check-run', name: 'verify', appId: 15368 } as const
const STATUS = { kind: 'status', name: 'release-proof' } as const
const INPUT: PrWatchInput = {
  repository: 'example/project',
  pullNumber: 7,
  headSha: SHA,
  checks: [CHECK, STATUS],
  maxPolls: 3,
  intervalSeconds: 60,
}

type PageKind = 'check-runs' | 'statuses'
type Step = { url: string; response: Response | Error; optional?: boolean }

function pageUrl(kind: PageKind, page = 1): string {
  const url = new URL(`${ROOT}/commits/${SHA}/${kind}`)
  url.searchParams.set('per_page', '100')
  if (kind === 'check-runs') url.searchParams.set('filter', 'latest')
  url.searchParams.set('page', String(page))
  return url.href
}

function nextLink(kind: PageKind, page: number): string {
  return `<${pageUrl(kind, page)}>; rel="next"`
}

function canonicalPageUrl(kind: PageKind, page: number): string {
  return pageUrl(kind, page).replace('/repos/example/project/', `/repositories/${REPOSITORY_ID}/`)
}

function pull(headSha = SHA, state = 'open'): Step {
  return {
    url: PULL_URL,
    response: Response.json({
      head: { sha: headSha },
      state,
      base: { repo: { id: REPOSITORY_ID } },
    }),
  }
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    name: CHECK.name,
    app: { id: CHECK.appId },
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 20, context: STATUS.name, state: 'success', ...overrides }
}

function page(
  kind: PageKind,
  rows: unknown[],
  options: { page?: number; total?: number; link?: string } = {},
): Step {
  return {
    url: pageUrl(kind, options.page),
    response: Response.json(
      kind === 'check-runs'
        ? { total_count: options.total ?? rows.length, check_runs: rows }
        : rows,
      { headers: options.link === undefined ? {} : { link: options.link } },
    ),
  }
}

function input(checks: PrCheckSelector[]): PrWatchInput {
  return { ...INPUT, checks }
}

function endpointPrefix(index: number): Step[] {
  return [pull(), page('check-runs', [run()]), page('statuses', [status()])].slice(0, index)
}

function normalizedUrl(value: string): string {
  const url = new URL(value)
  url.searchParams.sort()
  return url.href
}

async function observe(
  steps: Step[],
  params: PrWatchInput = INPUT,
  token = 'synthetic-test-token',
): Promise<PrWatchObservation> {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetcher: typeof fetch = async (request, init) => {
    const url = request instanceof Request ? request.url : String(request)
    const response = steps[calls.length]?.response
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response ?? new Response(null, { status: 500 })
  }
  const result = await observeGitHubChecks(params, { fetcher, token, now: () => NOW })
  // Assert outside fetch: the observer catches transport errors, so mock
  // assertions inside fetch could otherwise masquerade as the expected error.
  assert.ok(calls.length <= steps.length, 'no unplanned request may execute')
  assert.ok(
    steps.slice(calls.length).every((step) => step.optional),
    'every mandatory request must execute',
  )
  for (const [index, call] of calls.entries()) {
    assert.equal(normalizedUrl(call.url), normalizedUrl(steps[index]?.url ?? ''))
    assert.equal(call.init?.method ?? 'GET', 'GET')
    assert.equal(call.init?.body, undefined)
    assert.equal(call.init?.redirect, 'error')
    assert.ok(call.init?.signal instanceof AbortSignal)
    assert.equal(call.init.signal.aborted, false)
    const headers = new Headers(call.init.headers)
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    assert.equal(headers.get('x-github-api-version'), '2026-03-10')
    assert.equal(headers.get('user-agent'), 'durablerun-pr-watcher')
    assert.equal(headers.get('authorization'), token ? `Bearer ${token}` : null)
  }
  assert.equal(result.observedAt, OBSERVED_AT)
  return result
}

function observed(checks: PrCheckObservation[]) {
  return { kind: 'observed', observedAt: OBSERVED_AT, headSha: SHA, state: 'open', checks }
}

function unavailable(result: PrWatchObservation, reason: string, retryable = false): void {
  assert.deepEqual(result, { kind: 'unavailable', observedAt: OBSERVED_AT, reason, retryable })
}

test('a repository identity change cannot attach the old checks to a replacement repository', async () => {
  unavailable(
    await observe([
      pull(),
      page('check-runs', [run()]),
      page('statuses', [status()]),
      {
        url: PULL_URL,
        response: Response.json({
          head: { sha: SHA },
          state: 'open',
          base: { repo: { id: 54321 } },
        }),
      },
    ]),
    'github-repository-changed',
  )
})

test('exact-SHA requests keep check and status namespaces separate and exhaust both page links', async () => {
  const result = await observe([
    pull(),
    page('check-runs', [run({ id: 11, name: STATUS.name })], {
      total: 2,
      link: nextLink('check-runs', 2),
    }),
    page('check-runs', [run()], { page: 2, total: 2 }),
    page('statuses', [status({ id: 21, context: CHECK.name })], { link: nextLink('statuses', 2) }),
    page('statuses', [status()], { page: 2 }),
    pull(),
  ])
  assert.deepEqual(
    result,
    observed([
      { ...CHECK, state: 'passed' },
      { ...STATUS, state: 'passed' },
    ]),
  )
})

for (const kind of ['check-runs', 'statuses'] as const) {
  test(`actual GitHub numeric-repository pagination completes the selected ${kind} read`, async () => {
    const selector = kind === 'check-runs' ? CHECK : STATUS
    const result = await observe(
      [
        pull(),
        page(
          kind,
          [
            kind === 'check-runs'
              ? run({ id: 11, name: 'unselected' })
              : status({ id: 21, context: 'unselected' }),
          ],
          {
            total: 2,
            link: `<${canonicalPageUrl(kind, 2)}>; rel="next"`,
          },
        ),
        page(kind, [kind === 'check-runs' ? run() : status()], { page: 2, total: 2 }),
        pull(),
      ],
      input([selector]),
    )
    assert.deepEqual(result, observed([{ ...selector, state: 'passed' }]))
  })
}

test('canonical pagination identity must match the initial PR repository, SHA, endpoint, origin, and query', async () => {
  for (const kind of ['check-runs', 'statuses'] as const) {
    const original = canonicalPageUrl(kind, 2)
    const urls = [
      original.replace(`/repositories/${REPOSITORY_ID}/`, `/repositories/${REPOSITORY_ID + 1}/`),
      original.replace(SHA, NEXT_SHA),
      original.replace(`/${kind}?`, `/${kind === 'check-runs' ? 'statuses' : 'check-runs'}?`),
      original.replace('api.github.com', 'example.invalid'),
      `${original}&status=completed`,
      original.replace('page=2', 'page=1'),
      `${original}#other`,
    ]
    for (const url of urls) {
      unavailable(
        await observe(
          [pull(), page(kind, [], { link: `<${url}>; rel="next"` })],
          input([kind === 'check-runs' ? CHECK : STATUS]),
        ),
        'malformed-github-pagination',
      )
    }
  }
})

test('public reads omit auth when explicitly given an empty token and do not fetch unselected APIs', async () => {
  for (const selector of [CHECK, STATUS]) {
    const result = await observe(
      [
        pull(),
        selector.kind === 'check-run' ? page('check-runs', [run()]) : page('statuses', [status()]),
        pull(),
      ],
      input([selector]),
      '',
    )
    assert.deepEqual(result, observed([{ ...selector, state: 'passed' }]))
  }
})

test('initial and final head movement or closure is visible even when selected checks succeed', async () => {
  for (const boundary of ['initial', 'final']) {
    for (const [headSha, state] of [
      [NEXT_SHA, 'open'],
      [SHA, 'closed'],
    ]) {
      const changed = pull(headSha, state)
      const result = await observe(
        boundary === 'initial'
          ? [changed]
          : [pull(), page('check-runs', [run()]), page('statuses', [status()]), changed],
      )
      assert.deepEqual(result, {
        kind: 'observed',
        observedAt: OBSERVED_AT,
        headSha,
        state,
        checks:
          boundary === 'initial' || headSha !== SHA
            ? []
            : [
                { ...CHECK, state: 'passed' },
                { ...STATUS, state: 'passed' },
              ],
      })
    }
  }
})

test('missing, wrong-app, wrong-case, and duplicate check names cannot satisfy the selected producer', async () => {
  for (const rows of [
    [],
    [run({ app: { id: CHECK.appId + 1 } })],
    [run({ name: 'VERIFY' })],
    [run(), run({ id: 11 })],
  ]) {
    const result = await observe([pull(), page('check-runs', rows), pull()], input([CHECK]))
    assert.deepEqual(result, observed([{ ...CHECK, state: 'pending' }]))
  }
  const result = await observe(
    [
      pull(),
      page('check-runs', [
        run({ id: 11, app: { id: CHECK.appId + 1 }, conclusion: 'failure' }),
        run(),
      ]),
      pull(),
    ],
    input([CHECK]),
  )
  assert.deepEqual(result, observed([{ ...CHECK, state: 'passed' }]))
})

test('generated check states and terminal conclusions implement success-only acceptance', async () => {
  for (const state of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const result = await observe(
      [pull(), page('check-runs', [run({ status: state, conclusion: null })]), pull()],
      input([CHECK]),
    )
    assert.deepEqual(result, observed([{ ...CHECK, state: 'pending' }]), state)
  }
  for (const conclusion of [
    'success',
    'failure',
    'neutral',
    'cancelled',
    'skipped',
    'timed_out',
    'action_required',
    'stale',
    'startup_failure',
  ]) {
    const result = await observe(
      [pull(), page('check-runs', [run({ conclusion })]), pull()],
      input([CHECK]),
    )
    assert.deepEqual(
      result,
      observed([{ ...CHECK, state: conclusion === 'success' ? 'passed' : 'failed' }]),
      conclusion,
    )
  }
})

test('generated status states choose the newest case-folded context without an issuer claim', async () => {
  for (const state of ['pending', 'success', 'failure', 'error']) {
    const rows = [
      status({ context: 'RELEASE-PROOF', state, creator: { id: 999 } }),
      status({ id: 19, creator: { id: 1 } }),
    ]
    const result = await observe(
      [pull(), page('statuses', rows), pull()],
      input([{ ...STATUS, name: 'Release-Proof' }]),
    )
    assert.deepEqual(
      result,
      observed([
        {
          ...STATUS,
          state: state === 'success' ? 'passed' : state === 'pending' ? 'pending' : 'failed',
        },
      ]),
      state,
    )
  }
  assert.deepEqual(
    await observe([pull(), page('statuses', []), pull()], input([STATUS])),
    observed([{ ...STATUS, state: 'pending' }]),
  )
})

test('unknown and malformed selected fields produce unavailable observations, not green or CI failure', async () => {
  const faults = [
    { row: run({ head_sha: NEXT_SHA }), reason: 'github-check-head-mismatch' },
    { row: run({ status: 'future-state' }), reason: 'unknown-github-check-status' },
    { row: run({ conclusion: 'future-result' }), reason: 'unknown-github-check-conclusion' },
    ...[null, '', 1].map((conclusion) => ({
      row: run({ conclusion }),
      reason: 'malformed-github-response',
    })),
    ...[null, {}, [], { id: '15368' }, { id: -1 }, { id: 1.5 }].map((app) => ({
      row: run({ app }),
      reason: 'malformed-github-response',
    })),
    ...[null, '', 1].map((name) => ({ row: run({ name }), reason: 'malformed-github-response' })),
  ]
  for (const { row, reason } of faults) {
    unavailable(await observe([pull(), page('check-runs', [row])], input([CHECK])), reason)
  }
  for (const row of [
    status({ state: 'future-state' }),
    status({ state: null }),
    status({ context: null }),
  ]) {
    unavailable(
      await observe([pull(), page('statuses', [row])], input([STATUS])),
      row.state === 'future-state' ? 'unknown-github-status' : 'malformed-github-response',
    )
  }
})

test('generated endpoint malformed JSON, envelope, and row faults stop at the failing read', async () => {
  const endpoints = [
    {
      prefix: [],
      url: PULL_URL,
      bodies: [
        null,
        [],
        {},
        { head: { sha: 'short' }, state: 'open' },
        { head: { sha: SHA }, state: 'unknown' },
      ],
    },
    {
      prefix: [pull()],
      url: pageUrl('check-runs'),
      bodies: [
        null,
        [],
        {},
        { total_count: -1, check_runs: [] },
        { total_count: 0.5, check_runs: [] },
        { total_count: 1, check_runs: [null] },
      ],
    },
    {
      prefix: [pull(), page('check-runs', [run()])],
      url: pageUrl('statuses'),
      bodies: [null, {}, [null]],
    },
    {
      prefix: [pull(), page('check-runs', [run()]), page('statuses', [status()])],
      url: PULL_URL,
      bodies: [null, [], {}, { head: { sha: SHA }, state: 'unknown' }],
    },
  ]
  for (const endpoint of endpoints) {
    for (const body of endpoint.bodies) {
      // A Response body is single-use: clone successful prefixes for each fault.
      const prefix = endpoint.prefix.map((step) => ({
        ...step,
        response: (step.response as Response).clone(),
      }))
      unavailable(
        await observe([...prefix, { url: endpoint.url, response: Response.json(body) }]),
        'malformed-github-response',
      )
    }
    const prefix = endpoint.prefix.map((step) => ({
      ...step,
      response: (step.response as Response).clone(),
    }))
    unavailable(
      await observe([...prefix, { url: endpoint.url, response: new Response('not-json') }]),
      'malformed-github-response',
    )
  }
})

test('check total changes and truncated pagination stay explicitly incomplete', async () => {
  unavailable(
    await observe([pull(), page('check-runs', [run()], { total: 2 })], input([CHECK])),
    'incomplete-github-pagination',
    true,
  )
  unavailable(
    await observe(
      [
        pull(),
        page('check-runs', [run()], { total: 2, link: nextLink('check-runs', 2) }),
        page('check-runs', [run({ id: 11, name: 'other' })], { page: 2, total: 3 }),
      ],
      input([CHECK]),
    ),
    'github-pagination-changed',
    true,
  )
})

test('generated missing and invalid row identifiers cannot establish pagination completeness', async () => {
  for (const kind of ['check-runs', 'statuses'] as const) {
    for (const id of [undefined, null, 0, -1, 0.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
      const row = kind === 'check-runs' ? run({ id }) : status({ id })
      const result = await observe(
        [pull(), page(kind, [row]), { ...pull(), optional: true }],
        input([kind === 'check-runs' ? CHECK : STATUS]),
      )
      unavailable(result, 'malformed-github-response')
    }
  }
})

test('generated pagination faults cannot redirect credentials or substitute a repository, SHA, filter, or page', async () => {
  for (const kind of ['check-runs', 'statuses'] as const) {
    const selected = input([kind === 'check-runs' ? CHECK : STATUS])
    const original = pageUrl(kind, 2)
    const links = [
      `<${original.replace('api.github.com', 'example.invalid')}>; rel="next"`,
      `<${original.replace('/example/project/', '/example/other/')}>; rel="next"`,
      `<${original.replace(SHA, NEXT_SHA)}>; rel="next"`,
      `<${pageUrl(kind, 1)}>; rel="next"`,
      `<${pageUrl(kind, 3)}>; rel="next"`,
      `<${original}&status=completed>; rel="next"`,
      `<${original}#different-page>; rel="next"`,
      `${nextLink(kind, 2)}, ${nextLink(kind, 2)}`,
      'not-a-link',
    ]
    for (const link of links) {
      unavailable(
        await observe([pull(), page(kind, [], { link })], selected),
        'malformed-github-pagination',
      )
    }
  }
})

test('page safety limit remains non-ready even when an earlier page contained success', async () => {
  for (const kind of ['check-runs', 'statuses'] as const) {
    const steps = [pull()]
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      steps.push(
        page(
          kind,
          [
            kind === 'check-runs'
              ? run({ id: ordinal, name: ordinal === 1 ? CHECK.name : `other-${ordinal}` })
              : status({ id: ordinal, context: ordinal === 1 ? STATUS.name : `other-${ordinal}` }),
          ],
          {
            page: ordinal,
            total: 6,
            link: nextLink(kind, ordinal + 1),
          },
        ),
      )
    }
    unavailable(
      await observe(steps, input([kind === 'check-runs' ? CHECK : STATUS])),
      'github-pagination-limit',
    )
  }
})

for (const kind of ['check-runs', 'statuses'] as const) {
  test(`repeated ${kind} payload pages cannot masquerade as a complete read`, async () => {
    const row = kind === 'check-runs' ? run() : status()
    const result = await observe(
      [
        pull(),
        page(kind, [row], { total: 2, link: nextLink(kind, 2) }),
        page(kind, [row], { page: 2, total: 2 }),
        { ...pull(), optional: true },
      ],
      input([kind === 'check-runs' ? CHECK : STATUS]),
    )
    unavailable(result, 'github-pagination-changed', true)
  })
}

test('generated HTTP and transport faults at each endpoint retain observer-error semantics', async () => {
  const prefixes = [
    [],
    [pull()],
    [pull(), page('check-runs', [run()])],
    [pull(), page('check-runs', [run()]), page('statuses', [status()])],
  ]
  const urls = [PULL_URL, pageUrl('check-runs'), pageUrl('statuses'), PULL_URL]
  for (const [index, originalPrefix] of prefixes.entries()) {
    for (const code of [301, 401, 403, 404, 422, 500, 502, 503]) {
      const prefix = originalPrefix.map((step) => ({
        ...step,
        response: (step.response as Response).clone(),
      }))
      unavailable(
        await observe([
          ...prefix,
          { url: urls[index] as string, response: new Response(null, { status: code }) },
        ]),
        `github-http-${code}`,
        code === 403 || code >= 500,
      )
    }
    for (const error of [
      new Error('network offline'),
      new DOMException('deadline expired', 'TimeoutError'),
    ]) {
      const prefix = originalPrefix.map((step) => ({
        ...step,
        response: (step.response as Response).clone(),
      }))
      unavailable(
        await observe([...prefix, { url: urls[index] as string, response: error }]),
        'github-transport-error',
        true,
      )
    }
  }
})

for (const [index, label] of ['initial PR', 'check runs', 'statuses', 'final PR'].entries()) {
  for (const code of [403, 429, 503]) {
    test(`${label} HTTP ${code} keeps its classification and retry delay when error-body cleanup rejects`, async () => {
      const headers: Record<string, string> = code === 429 ? { 'retry-after': '900' } : {}
      const expected =
        code === 429
          ? {
              kind: 'unavailable',
              observedAt: OBSERVED_AT,
              reason: 'github-rate-limited',
              retryable: true,
              retryAfterSeconds: 900,
            }
          : {
              kind: 'unavailable',
              observedAt: OBSERVED_AT,
              reason: `github-http-${code}`,
              retryable: code === 403 || code >= 500,
            }
      const urls = [PULL_URL, pageUrl('check-runs'), pageUrl('statuses'), PULL_URL]
      for (const cleanupRejects of [false, true]) {
        let cancellations = 0
        const response = new Response(
          new ReadableStream({
            cancel() {
              cancellations++
              if (cleanupRejects) throw new TypeError('error body cleanup failed')
            },
          }),
          { status: code, headers },
        )
        assert.deepEqual(
          await observe([...endpointPrefix(index), { url: urls[index] as string, response }]),
          expected,
        )
        assert.equal(cancellations, 1, 'the error response body must be released once')
      }
    })
  }
  for (const errorKind of ['TypeError', 'AbortError']) {
    test(`${label} response-body ${errorKind} remains a retryable transport failure`, async () => {
      const prefixes = [
        [],
        [pull()],
        [pull(), page('check-runs', [run()])],
        [pull(), page('check-runs', [run()]), page('statuses', [status()])],
      ]
      const urls = [PULL_URL, pageUrl('check-runs'), pageUrl('statuses'), PULL_URL]
      const failure =
        errorKind === 'TypeError'
          ? new TypeError('connection lost while reading body')
          : new DOMException('request aborted while reading body', 'AbortError')
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure)
          },
        }),
      )
      unavailable(
        await observe([...(prefixes[index] ?? []), { url: urls[index] as string, response }]),
        'github-transport-error',
        true,
      )
    })
  }
}

test(
  'known rate-limit outcome does not await stalled error-body cleanup',
  { timeout: 1000 },
  async () => {
    let cancellations = 0
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancellations++
          return new Promise<void>(() => {})
        },
      }),
      { status: 429, headers: { 'retry-after': '900' } },
    )
    assert.deepEqual(await observe([{ url: PULL_URL, response }]), {
      kind: 'unavailable',
      observedAt: OBSERVED_AT,
      reason: 'github-rate-limited',
      retryable: true,
      retryAfterSeconds: 900,
    })
    assert.equal(cancellations, 1)
  },
)

test('headerless secondary-rate-limit 403 remains retryable despite remaining primary quota', async () => {
  const response = Response.json(
    {
      message:
        'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    },
    { status: 403, headers: { 'x-ratelimit-remaining': '42' } },
  )
  unavailable(await observe([{ url: PULL_URL, response }]), 'github-http-403', true)
})

test('rate-limit status and header matrix preserves provider delays and bounded retryability', async () => {
  const cases: { code: number; headers: Record<string, string>; delay?: number }[] = [
    { code: 429, headers: {}, delay: 60 },
    { code: 429, headers: { 'retry-after': '1' }, delay: 60 },
    { code: 429, headers: { 'retry-after': '120' }, delay: 120 },
    { code: 403, headers: { 'retry-after': '120' }, delay: 120 },
    {
      code: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 180) },
      delay: 180,
    },
    {
      code: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 180) },
      delay: 180,
    },
    { code: 429, headers: { 'retry-after': new Date(NOW + 120_000).toUTCString() }, delay: 120 },
    { code: 429, headers: { 'retry-after': '3600' }, delay: 3600 },
    { code: 429, headers: { 'retry-after': '3601' } },
    { code: 429, headers: { 'retry-after': 'not-a-delay' } },
  ]
  for (const { code, headers, delay } of cases) {
    const result = await observe([
      { url: PULL_URL, response: new Response(null, { status: code, headers }) },
    ])
    assert.deepEqual(
      result,
      delay === undefined
        ? {
            kind: 'unavailable',
            observedAt: OBSERVED_AT,
            reason: 'github-rate-limit-requires-later-watch',
            retryable: false,
          }
        : {
            kind: 'unavailable',
            observedAt: OBSERVED_AT,
            reason: 'github-rate-limited',
            retryable: true,
            retryAfterSeconds: delay,
          },
    )
  }
})
