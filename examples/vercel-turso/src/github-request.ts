/** The one origin every GitHub read of this example goes to. */
export const GITHUB_API = 'https://api.github.com'
const GITHUB_API_VERSION = '2026-03-10'

/** The path of a repository written `owner/name` in an API URL, part by part. */
export const githubRepositoryPath = (repository: string): string =>
  `/repos/${repository.split('/').map(encodeURIComponent).join('/')}`

export interface GitHubRequest {
  fetcher?: typeof fetch | undefined
  /** The host-owned token. Without one the host's `GITHUB_TOKEN` is sent, and with neither no credential. */
  token?: string | undefined
  userAgent: string
  /** The media type asked for: GitHub's JSON, unless a reader names another. */
  accept?: string
  /** What bounds the read. */
  signal: AbortSignal
}

/**
 * One GET of the GitHub API, as every reader of this example sends it: under one API
 * version, following no redirect, bounded by the caller's signal, and with the optional
 * host-owned token. A response that is not ok is returned with its body disposed of, for
 * the reader to classify: which statuses a retry cures is each reader's own rule.
 */
export async function githubGet(url: URL, request: GitHubRequest): Promise<Response> {
  const token = request.token ?? process.env.GITHUB_TOKEN
  const response = await (request.fetcher ?? fetch)(url, {
    headers: {
      accept: request.accept ?? 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': request.userAgent,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: request.signal,
  })
  // Optional body disposal cannot delay or replace the received status.
  if (!response.ok) void response.body?.cancel().catch(() => {})
  return response
}
