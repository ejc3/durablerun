import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { FatalTaskError } from '@durablerun/core'
import { observeGitHubRef } from '../src/github-ref.js'

const SHA = 'c'.repeat(40)
const INPUT = { repository: 'example/project', ref: 'release/1.x' }
const COMMIT = { sha: SHA, commit: { committer: { date: '2026-10-01T00:00:00Z' } } }

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

test('one request reads the commit a ref names, and follows no redirect', async () => {
  const { fetcher, sent } = answering(() => Response.json(COMMIT))
  assert.deepEqual(await observeGitHubRef(INPUT, { fetcher, token: 'example-token' }), {
    commitSha: SHA,
    committedAt: '2026-10-01T00:00:00Z',
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, 'https://api.github.com/repos/example/project/commits/release%2F1.x')
  assert.equal(sent[0]?.init?.redirect, 'error')
  assert.ok(sent[0]?.init?.signal instanceof AbortSignal)
  const headers = new Headers(sent[0]?.init?.headers)
  assert.equal(headers.get('authorization'), 'Bearer example-token')
  assert.equal(headers.get('accept'), 'application/vnd.github+json')
})

test('no token is sent when the host has none', async () => {
  const { fetcher, sent } = answering(() => Response.json(COMMIT))
  await observeGitHubRef(INPUT, { fetcher, token: '' })
  assert.equal(new Headers(sent[0]?.init?.headers).has('authorization'), false)
})

test('parameters that name no repository or no ref fail for good before any request', async () => {
  const { fetcher, sent } = answering(() => Response.json(COMMIT))
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

test('a body that is not a commit fails for good', async () => {
  for (const body of [
    'not json',
    JSON.stringify([]),
    JSON.stringify({}),
    JSON.stringify({ sha: 'short', commit: COMMIT.commit }),
    JSON.stringify({ sha: SHA }),
    JSON.stringify({ sha: SHA, commit: { committer: { date: 'yesterday' } } }),
    JSON.stringify({ sha: SHA, commit: { committer: { date: 7 } } }),
  ]) {
    const { fetcher } = answering(() => new Response(body, { status: 200 }))
    await assert.rejects(observeGitHubRef(INPUT, { fetcher }), FatalTaskError, body)
  }
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
