import { FatalTaskError } from '@durablerun/core'
import { type RefObservation, parseDigestInput } from './periodic-digest.js'

const API = 'https://api.github.com'
const READ_TIMEOUT_MS = 20_000
/** The statuses no retry cures: a credential GitHub refuses, and a repository or a ref it does not have. */
const PERMANENT_STATUSES = [401, 404, 422]

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FatalTaskError('malformed-github-response')
  }
  return value as Record<string, unknown>
}

/**
 * One bounded read of the commit a ref names, and nothing else: it follows no redirect,
 * and it sends the optional host-owned token to api.github.com alone. A status no retry
 * cures, and a body that is not a commit, fail the task for good. Every other failure is
 * thrown as an ordinary error, which the task's retry strategy retries.
 */
export async function observeGitHubRef(
  raw: unknown,
  options: { fetcher?: typeof fetch; token?: string } = {},
): Promise<RefObservation> {
  const input = parseDigestInput(raw)
  const fetcher = options.fetcher ?? fetch
  const token = options.token ?? process.env.GITHUB_TOKEN
  const repository = input.repository.split('/').map(encodeURIComponent).join('/')
  const url = new URL(`/repos/${repository}/commits/${encodeURIComponent(input.ref)}`, API)
  const response = await fetcher(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'user-agent': 'durablerun-periodic-digest',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!response.ok) {
    // Optional body disposal cannot delay or replace the received status.
    void response.body?.cancel().catch(() => {})
    const reason = `github-http-${response.status}`
    throw PERMANENT_STATUSES.includes(response.status)
      ? new FatalTaskError(reason)
      : new Error(reason)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) throw new FatalTaskError('malformed-github-response')
    throw error
  }
  const commit = record(body)
  const commitSha = commit.sha
  const committedAt = record(record(commit.commit).committer).date
  if (
    typeof commitSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(commitSha) ||
    typeof committedAt !== 'string' ||
    Number.isNaN(Date.parse(committedAt))
  ) {
    throw new FatalTaskError('malformed-github-response')
  }
  return { commitSha, committedAt }
}
