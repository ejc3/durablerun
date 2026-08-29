import type { TaskRegistry } from '@durablerun/sdk'

export interface RefObservation {
  repository: string
  ref: string
  commitSha: string
  treeSha: string
  committedAt: string
}

export type ObserveRepositoryRef = (repository: string, ref: string) => Promise<RefObservation>

interface GitHubCommitResponse {
  sha?: unknown
  commit?: { committer?: { date?: unknown }; tree?: { sha?: unknown } }
}

function repositoryPath(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new RangeError('repository must have the form owner/name')
  }
  const parts = repository.split('/')
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new RangeError('repository must have the form owner/name')
  }
  return parts.map((part) => encodeURIComponent(part)).join('/')
}

export async function observeGitHubRef(
  repository: string,
  ref: string,
  fetcher: typeof fetch = fetch,
): Promise<RefObservation> {
  if (!ref) throw new RangeError('repository ref must be non-empty')
  const response = await fetcher(
    `https://api.github.com/repos/${repositoryPath(repository)}/commits/${encodeURIComponent(ref)}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'durablerun-dogfood',
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    },
  )
  if (!response.ok) {
    throw new Error(`GitHub repository snapshot failed with HTTP ${response.status}`)
  }
  const body = (await response.json()) as GitHubCommitResponse
  const commitSha = body.sha
  const treeSha = body.commit?.tree?.sha
  const committedAt = body.commit?.committer?.date
  if (
    typeof commitSha !== 'string' ||
    typeof treeSha !== 'string' ||
    typeof committedAt !== 'string'
  ) {
    throw new Error('GitHub repository snapshot returned an incomplete commit')
  }
  return { repository, ref, commitSha, treeSha, committedAt }
}

interface RefJournalParams {
  repository: string
  ref: string
  cycles: number
  intervalSeconds: number
}

function params(value: unknown): RefJournalParams {
  if (value === null || typeof value !== 'object') throw new TypeError('ref-journal params')
  const candidate = value as Record<string, unknown>
  const repository = candidate.repository
  const ref = candidate.ref
  const cycles = candidate.cycles
  const intervalSeconds = candidate.intervalSeconds
  if (
    typeof repository !== 'string' ||
    typeof ref !== 'string' ||
    typeof cycles !== 'number' ||
    !Number.isSafeInteger(cycles) ||
    cycles < 1 ||
    typeof intervalSeconds !== 'number' ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 0
  ) {
    throw new TypeError('invalid ref-journal params')
  }
  return { repository, ref, cycles, intervalSeconds }
}

export function refJournalRegistry(
  observe: ObserveRepositoryRef = observeGitHubRef,
  afterCheckpoint: (ordinal: number) => void = () => {},
): TaskRegistry {
  return new Map([
    [
      'ref-journal',
      async (ctx, raw) => {
        const input = params(raw)
        const observations: RefObservation[] = []
        for (let cycle = 0; cycle < input.cycles; cycle++) {
          observations.push(
            await ctx.step('observe-ref', () => observe(input.repository, input.ref)),
          )
          afterCheckpoint(cycle + 1)
          if (cycle + 1 < input.cycles) await ctx.sleepFor(input.intervalSeconds)
        }
        return { cycles: observations.length, observations }
      },
    ],
  ])
}
