import type { TaskRegistry } from '@durablerun/sdk'
import {
  DOGFOOD_CHECKPOINT_NAME,
  DOGFOOD_TASK_NAME,
  parseDogfoodJournalParameters,
} from './config.js'

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

export function refJournalRegistry(
  observe: ObserveRepositoryRef = observeGitHubRef,
  afterCheckpoint: (ordinal: number) => void = () => {},
): TaskRegistry {
  return new Map([
    [
      DOGFOOD_TASK_NAME,
      async (ctx, raw) => {
        const input = parseDogfoodJournalParameters(raw)
        if (input === null) throw new TypeError('invalid ref-journal params')
        const observations: RefObservation[] = []
        for (let cycle = 0; cycle < input.cycles; cycle++) {
          observations.push(
            await ctx.step(DOGFOOD_CHECKPOINT_NAME, () => observe(input.repository, input.ref)),
          )
          afterCheckpoint(cycle + 1)
          if (cycle + 1 < input.cycles) await ctx.sleepFor(input.intervalSeconds)
        }
        return { cycles: observations.length, observations }
      },
    ],
  ])
}
