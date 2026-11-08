import { FatalTaskError } from '@durablerun/core'
import type { TaskContext } from '@durablerun/sdk'
import { isGitHubRepository } from './github-repository.js'

export const PERIODIC_DIGEST_TASK = 'periodic-digest'
export const PERIODIC_DIGEST_OBSERVATION_STEP = 'github-ref'
/** How long a digest sleeps between its read and its result. */
export const PERIODIC_DIGEST_SETTLE_SECONDS = 60

/** What one digest reads: a ref of a GitHub repository, such as `main`. */
export interface DigestInput {
  repository: string
  ref: string
}

/** The commit a ref named when it was read. */
export interface RefObservation {
  commitSha: string
  committedAt: string
}

/**
 * The one external read of a digest. It resolves with what the ref names, or throws. A
 * `FatalTaskError` fails the task at once. Any other error is retried under the task's
 * retry strategy, and fails the task when its attempts are used up.
 */
export type RefObserver = (input: DigestInput) => Promise<RefObservation>

export interface DigestResult extends DigestInput, RefObservation {
  settledSeconds: number
  attempt: number
}

export function parseDigestInput(params: unknown): DigestInput {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new FatalTaskError('periodic-digest parameters must be an object')
  }
  const repository = Reflect.get(params, 'repository')
  const ref = Reflect.get(params, 'ref')
  if (!isGitHubRepository(repository)) throw new FatalTaskError('repository must be owner/name')
  if (typeof ref !== 'string' || !/^[A-Za-z0-9._/-]{1,255}$/.test(ref) || ref.includes('..')) {
    throw new FatalTaskError('ref must be a branch, a tag or a commit SHA')
  }
  return { repository, ref }
}

/**
 * One period of a recurring workflow, as one task. A producer outside the engine, a cron,
 * enqueues one task for each period under the idempotency key `digest-<period>`, so a
 * period enqueued twice is one task. The task reads the ref once, in a checkpointed step,
 * sleeps once, and completes with what it read. It emits no event and awaits none, and it
 * uses only `ctx.step` and `ctx.sleepFor`. A period that fails is that task's failure
 * alone: the next period is another task.
 */
export function createPeriodicDigest(
  observe: RefObserver,
): (ctx: TaskContext, params: unknown) => Promise<DigestResult> {
  return async (ctx, params) => {
    const input = parseDigestInput(params)
    // Only the read is inside the step, so a committed observation is never fetched again.
    const observed = await ctx.step(PERIODIC_DIGEST_OBSERVATION_STEP, () => observe(input))
    await ctx.sleepFor(PERIODIC_DIGEST_SETTLE_SECONDS)
    return {
      ...input,
      commitSha: observed.commitSha,
      committedAt: observed.committedAt,
      settledSeconds: PERIODIC_DIGEST_SETTLE_SECONDS,
      attempt: ctx.attempt,
    }
  }
}
