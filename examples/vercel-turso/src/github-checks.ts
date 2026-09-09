import {
  type PrCheckObservation,
  type PrWatchObservation,
  parsePrWatchInput,
} from './pr-watcher.js'

const API = 'https://api.github.com'
const PAGE_LIMIT = 5
const POLL_TIMEOUT_MS = 20_000

class ObservationError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(reason)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ObservationError('malformed-github-response')
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ObservationError('malformed-github-response')
  }
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ObservationError('malformed-github-response')
  }
  return value
}

function pull(value: unknown): { headSha: string; state: 'open' | 'closed' } {
  const row = record(value)
  const headSha = text(record(row.head).sha)
  if (!/^[a-f0-9]{40}$/.test(headSha) || (row.state !== 'open' && row.state !== 'closed')) {
    throw new ObservationError('malformed-github-response')
  }
  return { headSha, state: row.state }
}

/** A bounded read-only snapshot, never a merge authorization or a cached-green fallback. */
export async function observeGitHubChecks(
  raw: unknown,
  options: { fetcher?: typeof fetch; token?: string; now?: () => number } = {},
): Promise<PrWatchObservation> {
  const input = parsePrWatchInput(raw)
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now
  const token = options.token ?? process.env.GITHUB_TOKEN
  const signal = AbortSignal.timeout(POLL_TIMEOUT_MS)
  const root = `/repos/${input.repository.split('/').map(encodeURIComponent).join('/')}`
  const observedAt = () => new Date(now()).toISOString()

  async function get(url: URL): Promise<{ value: unknown; links: string | null }> {
    const response = await fetcher(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        'user-agent': 'durablerun-pr-watcher',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: 'error',
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      const retryAfter = response.headers.get('retry-after')
      const exhausted = response.headers.get('x-ratelimit-remaining') === '0'
      const limited =
        response.status === 429 || (response.status === 403 && (exhausted || retryAfter !== null))
      if (limited) {
        const retryEpoch = retryAfter === null ? Number.NaN : Date.parse(retryAfter)
        const reset = Number(response.headers.get('x-ratelimit-reset'))
        const delay =
          retryAfter !== null
            ? /^\d+$/.test(retryAfter)
              ? Number(retryAfter)
              : (retryEpoch - now()) / 1000
            : exhausted && reset > 0
              ? reset - now() / 1000
              : 60
        if (!Number.isFinite(delay) || delay > 3600) {
          throw new ObservationError('github-rate-limit-requires-later-watch')
        }
        throw new ObservationError('github-rate-limited', true, Math.max(60, Math.ceil(delay)))
      }
      throw new ObservationError(`github-http-${response.status}`, response.status >= 500)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch (error) {
      if (error instanceof SyntaxError) throw new ObservationError('malformed-github-response')
      throw error
    }
    return { value, links: response.headers.get('link') }
  }

  async function pages(path: string, checks: boolean): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    const seenIds = new Set<number>()
    let expectedTotal: number | undefined
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const url = new URL(path, API)
      url.searchParams.set('per_page', '100')
      if (checks) url.searchParams.set('filter', 'latest')
      url.searchParams.set('page', String(page))
      const { value, links } = await get(url)
      const envelope = checks ? record(value) : undefined
      const entries = checks ? envelope?.check_runs : value
      if (!Array.isArray(entries) || entries.length > 100) {
        throw new ObservationError('malformed-github-response')
      }
      if (envelope !== undefined) {
        const total = integer(envelope.total_count)
        if (expectedTotal !== undefined && total !== expectedTotal) {
          throw new ObservationError('github-pagination-changed', true)
        }
        expectedTotal = total
      }
      for (const entry of entries) {
        const row = record(entry)
        const id = integer(row.id)
        if (id === 0) throw new ObservationError('malformed-github-response')
        if (seenIds.has(id)) throw new ObservationError('github-pagination-changed', true)
        seenIds.add(id)
        rows.push(row)
      }
      let next: URL | undefined
      if (links !== null) {
        for (const link of links.split(',')) {
          const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(link)
          if (!match) throw new ObservationError('malformed-github-pagination')
          if (match[2] === 'next') {
            if (next !== undefined) throw new ObservationError('malformed-github-pagination')
            next = new URL(match[1] ?? '')
          }
        }
      }
      if (next === undefined) {
        if (expectedTotal !== undefined && rows.length !== expectedTotal) {
          throw new ObservationError('incomplete-github-pagination', true)
        }
        return rows
      }
      // Generate each request locally: pagination cannot move a host credential
      // to a different origin, repository, commit, filter, or page sequence.
      const expected = new URL(url)
      expected.searchParams.set('page', String(page + 1))
      next.searchParams.sort()
      expected.searchParams.sort()
      if (next.href !== expected.href) throw new ObservationError('malformed-github-pagination')
    }
    throw new ObservationError('github-pagination-limit')
  }

  try {
    const initial = pull((await get(new URL(`${root}/pulls/${input.pullNumber}`, API))).value)
    if (initial.headSha !== input.headSha || initial.state === 'closed') {
      return { kind: 'observed', observedAt: observedAt(), ...initial, checks: [] }
    }
    const runs = input.checks.some((check) => check.kind === 'check-run')
      ? await pages(`${root}/commits/${input.headSha}/check-runs`, true)
      : []
    const statuses = input.checks.some((check) => check.kind === 'status')
      ? await pages(`${root}/commits/${input.headSha}/statuses`, false)
      : []
    const checks: PrCheckObservation[] = input.checks.map((selector) => {
      if (selector.kind === 'status') {
        // GitHub returns newest first. Do not search for an older success.
        const status = statuses.find((row) => text(row.context).toLowerCase() === selector.name)
        if (status === undefined) return { ...selector, state: 'pending' }
        if (!['pending', 'success', 'failure', 'error'].includes(text(status.state))) {
          throw new ObservationError('unknown-github-status')
        }
        return {
          ...selector,
          state:
            status.state === 'success'
              ? 'passed'
              : status.state === 'pending'
                ? 'pending'
                : 'failed',
        }
      }
      const matches = runs.filter(
        (row) => text(row.name) === selector.name && integer(record(row.app).id) === selector.appId,
      )
      if (matches.length !== 1) return { ...selector, state: 'pending' }
      const run = matches[0] as Record<string, unknown>
      if (run.head_sha !== input.headSha) throw new ObservationError('github-check-head-mismatch')
      if (run.status !== 'completed') {
        if (
          !['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(text(run.status))
        ) {
          throw new ObservationError('unknown-github-check-status')
        }
        return { ...selector, state: 'pending' }
      }
      if (
        ![
          'success',
          'failure',
          'neutral',
          'cancelled',
          'skipped',
          'timed_out',
          'action_required',
          'stale',
          'startup_failure',
        ].includes(text(run.conclusion))
      ) {
        throw new ObservationError('unknown-github-check-conclusion')
      }
      return { ...selector, state: run.conclusion === 'success' ? 'passed' : 'failed' }
    })
    const final = pull((await get(new URL(`${root}/pulls/${input.pullNumber}`, API))).value)
    return {
      kind: 'observed',
      observedAt: observedAt(),
      ...final,
      checks: final.headSha === input.headSha ? checks : [],
    }
  } catch (error) {
    const failure =
      error instanceof ObservationError
        ? error
        : new ObservationError('github-transport-error', true)
    return {
      kind: 'unavailable',
      observedAt: observedAt(),
      reason: failure.reason,
      retryable: failure.retryable,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    }
  }
}
