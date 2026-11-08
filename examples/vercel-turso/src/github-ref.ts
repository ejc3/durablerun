import { FatalTaskError } from '@durablerun/core'
import { GITHUB_API, githubGet, githubRepositoryPath } from './github-request.js'
import { type RefObservation, parseDigestInput } from './periodic-digest.js'

const READ_TIMEOUT_MS = 20_000
/** The statuses no retry cures: a credential GitHub refuses, and a repository or a ref it does not have. */
const PERMANENT_STATUSES = [401, 404, 422]
/** The media type under which GitHub answers a commit as its SHA alone, in plain text. */
const SHA_ALONE = 'application/vnd.github.sha'

/**
 * One bounded read of the commit a ref names, and nothing else. It asks for the SHA
 * alone, so the answer is 40 characters and not the commit with its files. A status no
 * retry cures, and a body that is not a SHA, fail the task for good. Every other failure
 * is thrown as an ordinary error, which the task's retry strategy retries.
 */
export async function observeGitHubRef(
  raw: unknown,
  options: { fetcher?: typeof fetch; token?: string } = {},
): Promise<RefObservation> {
  const input = parseDigestInput(raw)
  const url = new URL(
    `${githubRepositoryPath(input.repository)}/commits/${encodeURIComponent(input.ref)}`,
    GITHUB_API,
  )
  const response = await githubGet(url, {
    ...options,
    userAgent: 'durablerun-periodic-digest',
    accept: SHA_ALONE,
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!response.ok) {
    const reason = `github-http-${response.status}`
    throw PERMANENT_STATUSES.includes(response.status)
      ? new FatalTaskError(reason)
      : new Error(reason)
  }
  const commitSha = (await response.text()).trim()
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new FatalTaskError('malformed-github-response')
  return { commitSha }
}
