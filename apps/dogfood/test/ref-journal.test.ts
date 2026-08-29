import { describe, expect, it, vi } from 'vitest'
import { observeGitHubRef } from '../src/ref-journal.js'

describe('repository ref observation', () => {
  it('records commit and tree identity from GitHub', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sha: 'commit-1',
        commit: { tree: { sha: 'tree-1' }, committer: { date: '2026-08-29T00:00:00Z' } },
      }),
    )
    await expect(observeGitHubRef('ejc3/durablerun', 'main', fetcher)).resolves.toEqual({
      repository: 'ejc3/durablerun',
      ref: 'main',
      commitSha: 'commit-1',
      treeSha: 'tree-1',
      committedAt: '2026-08-29T00:00:00Z',
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/ejc3/durablerun/commits/main',
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': 'durablerun-dogfood' }),
      }),
    )
  })

  it('fails clearly on an invalid target or incomplete response', async () => {
    await expect(observeGitHubRef('../private', 'main')).rejects.toThrow(/owner\/name/)
    await expect(
      observeGitHubRef(
        'ejc3/durablerun',
        'main',
        vi.fn(async () => Response.json({ sha: 'only-one-field' })),
      ),
    ).rejects.toThrow(/incomplete commit/)
  })
})
