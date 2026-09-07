import {
  type Clock,
  type Ending,
  type IdSource,
  type LaunchInvocation,
  LaunchOutcome,
  type Launcher,
  type SchedulerStore,
} from '@durablerun/core'
import { type TaskRegistry, type WorkerOutcome, runClaimedRun } from '@durablerun/sdk'
import { type TickOptions, type TickResult, tick } from './tick.js'

const INLINE_ENDING_KINDS = {
  completed: 'completed',
  suspended: 'unknown',
  'retry-scheduled': 'unknown',
  failed: 'failed',
  superseded: 'unknown',
  'lease-lost': 'crashed',
  aborted: 'crashed',
  deferred: 'unknown',
} as const satisfies Record<WorkerOutcome['kind'], Ending['kind']>

export interface InlineLauncherOptions {
  /**
   * Observe the worker's semantic outcome before the launch resolves. The
   * callback is awaited, but its failure is observational only and cannot
   * reclassify the worker's durable ending.
   */
  onOutcome?(outcome: WorkerOutcome, invocation: LaunchInvocation): void
}

/**
 * Run one claimed worker pass inside the caller's bounded compute slot.
 *
 * There is no resident process, HTTP acknowledgement, or detached work: the
 * launch promise resolves only after `runClaimedRun` reaches a durable
 * suspension or terminal transition. The returned `LaunchOutcome` remains
 * opaque and is consumed by tick's one reconciler like every other launcher.
 */
export function inlineLauncher(
  deps: { store: SchedulerStore; clock: Clock; registry: TaskRegistry },
  options: InlineLauncherOptions = {},
): Launcher {
  return {
    async launch(invocation) {
      const outcome = await runClaimedRun(deps, invocation)
      const launchOutcome = LaunchOutcome.ended({
        runId: invocation.runId,
        claimToken: invocation.claimToken,
        kind: INLINE_ENDING_KINDS[outcome.kind],
      })
      try {
        await options.onOutcome?.(outcome, invocation)
      } catch {
        // Observers must not turn a completed durable worker pass into a
        // launch failure. Awaiting still keeps async observation in-slot.
      }
      return launchOutcome
    },
  }
}

export type InlineTickOptions = Omit<TickOptions, 'claimLimit'>

export interface InlineTickResult extends TickResult {
  /** Null when this invocation claimed no run or the inline launcher threw. */
  workerOutcome: WorkerOutcome | null
}

/**
 * One serverless-friendly scheduling pass with exactly one inline worker slot.
 * Later work is represented by `backlog`/`nextWakeAtEpochMs`; this invocation
 * never starts a resident loop or leaves worker execution detached.
 */
export async function inlineTick(
  deps: {
    store: SchedulerStore
    ids: IdSource
    clock: Clock
    registry: TaskRegistry
  },
  options: InlineTickOptions,
): Promise<InlineTickResult> {
  let workerOutcome: WorkerOutcome | null = null
  const launcher = inlineLauncher(deps, {
    onOutcome(outcome) {
      workerOutcome = outcome
    },
  })
  const result = await tick(
    { store: deps.store, ids: deps.ids, launcher },
    { ...options, claimLimit: 1 },
  )
  return { ...result, workerOutcome }
}
