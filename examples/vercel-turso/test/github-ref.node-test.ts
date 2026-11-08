import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { FatalTaskError } from '@durablerun/core'
import { observeGitHubRef } from '../src/github-ref.js'

const SHA = 'c'.repeat(40)
const INPUT = { repository: 'example/project', ref: 'release/1.x' }
/** GitHub answers the SHA alone as plain text. */
const answer = (): Response => new Response(SHA, { status: 200 })

interface Sent {
  url: string
  init: RequestInit | undefined
}

/** A fetcher that answers every request with one response, and records what it was sent. */
function answering(response: () => Response | Promise<Response>): {
  fetcher: typeof fetch
  sent: Sent[]
} {
  const sent: Sent[] = []
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), init })
    return response()
  }
  return { fetcher, sent }
}

test('one request reads the SHA of the commit a ref names and nothing else, and follows no redirect', async () => {
  const { fetcher, sent } = answering(answer)
  assert.deepEqual(await observeGitHubRef(INPUT, { fetcher, token: 'example-token' }), {
    commitSha: SHA,
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, 'https://api.github.com/repos/example/project/commits/release%2F1.x')
  assert.equal(sent[0]?.init?.redirect, 'error')
  assert.ok(sent[0]?.init?.signal instanceof AbortSignal)
  const headers = new Headers(sent[0]?.init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer example-token')
  // The SHA alone, and not the commit with its files.
  assert.equal(headers.get('accept'), 'application/vnd.github.sha')
  assert.equal(headers.get('x-github-api-version'), '2026-03-10')
  assert.equal(headers.get('user-agent'), 'durablerun-periodic-digest')
})

test('the request of every ref the parameters allow ends in that ref: the URL drops no part of it', async () => {
  for (const ref of ['main', 'release/1.x', 'v1.0.0', '.hidden', 'a/.b', 'a.', 'c'.repeat(40)]) {
    const { fetcher, sent } = answering(answer)
    await observeGitHubRef({ repository: 'example/project', ref }, { fetcher })
    const path = new URL(sent[0]?.url ?? '').pathname
    assert.equal(path, `/repos/example/project/commits/${encodeURIComponent(ref)}`, ref)
  }
})

test('no token is sent when the host has none', async () => {
  const { fetcher, sent } = answering(answer)
  await observeGitHubRef(INPUT, { fetcher, token: '' })
  assert.equal(new Headers(sent[0]?.init?.headers).has('authorization'), false)
})

test('parameters that name no repository or no ref fail for good before any request', async () => {
  const { fetcher, sent } = answering(answer)
  for (const invalid of [
    null,
    'example/project',
    [],
    {},
    { repository: 'example/project' },
    { ref: 'main' },
    { repository: 'example/..', ref: 'main' },
    { repository: 'example/project/extra', ref: 'main' },
    { repository: 'example/project', ref: '' },
    { repository: 'example/project', ref: 'a..b' },
    // A dot segment, which the URL of the read would drop: the request would list commits.
    { repository: 'example/project', ref: '.' },
    { repository: 'example/project', ref: '..' },
    { repository: 'example/project', ref: './main' },
    { repository: 'example/project', ref: 'release/.' },
    { repository: 'example/project', ref: 'release/./1.x' },
    { repository: 'example/project', ref: 'main?x=1' },
    { repository: 'example/project', ref: 7 },
  ]) {
    await assert.rejects(observeGitHubRef(invalid, { fetcher }), FatalTaskError)
  }
  assert.equal(sent.length, 0)
})

test('a status no retry cures fails for good, and any other failed status is an ordinary error', async () => {
  for (const [status, fatal] of [
    [401, true],
    [404, true],
    [422, true],
    [403, false],
    [429, false],
    [500, false],
    [503, false],
  ] as const) {
    const { fetcher } = answering(() => new Response('no', { status }))
    await assert.rejects(observeGitHubRef(INPUT, { fetcher }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, `github-http-${status}`)
      assert.equal(error instanceof FatalTaskError, fatal, `status ${status}`)
      return true
    })
  }
})

test('a body that is not a SHA fails for good, and a line feed after the SHA is no part of it', async () => {
  for (const body of [
    '',
    'not a sha',
    SHA.slice(1),
    `${SHA}c`,
    SHA.toUpperCase(),
    `${SHA}\n${SHA}`,
    // The commit as JSON, which is what the default media type answers, and a list of commits.
    JSON.stringify({ sha: SHA }),
    JSON.stringify([{ sha: SHA }]),
  ]) {
    const { fetcher } = answering(() => new Response(body, { status: 200 }))
    await assert.rejects(observeGitHubRef(INPUT, { fetcher }), FatalTaskError, body)
  }
  const { fetcher } = answering(() => new Response(`${SHA}\n`, { status: 200 }))
  assert.deepEqual(await observeGitHubRef(INPUT, { fetcher }), { commitSha: SHA })
})

test('a body that breaks off in transit is an ordinary error, which the task retries', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('terminated'))
    },
  })
  const { fetcher } = answering(() => new Response(broken, { status: 200 }))
  await assert.rejects(observeGitHubRef(INPUT, { fetcher }), (error: unknown) => {
    assert.equal(error instanceof FatalTaskError, false)
    return true
  })
})

test('a request that fails in transit is an ordinary error, which the task retries', async () => {
  const fetcher: typeof fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(observeGitHubRef(INPUT, { fetcher }), (error: unknown) => {
    assert.ok(error instanceof TypeError)
    assert.equal(error instanceof FatalTaskError, false)
    return true
  })
})
