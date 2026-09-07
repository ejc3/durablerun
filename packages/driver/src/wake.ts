import { requireEpochMs } from '@durablerun/core'
import type { TickResult } from './tick.js'

/** A hint to look again, never authority to execute a particular run. */
export type WakeRequest = Readonly<
  { queue: string } & ({ kind: 'immediate' } | { kind: 'scheduled'; atEpochMs: number })
>

/**
 * Add an independently deliverable tick; never replace an earlier request or
 * suppress a fresh request because an older delivery already fired. Delivery
 * may duplicate/reorder. The host also owns an independent recovery trigger
 * for lost publication, expired messages, and process death before this call.
 */
export type WakeScheduler = (wake: WakeRequest) => Promise<void>

export class WakeSchedulingError extends Error {
  constructor(cause: unknown) {
    super('wake scheduling unavailable', { cause })
  }
}

/** One bounded pass produces at most one hint; an idle queue produces none. */
export async function scheduleTickWake(
  schedule: WakeScheduler,
  queue: string,
  result: Pick<TickResult, 'backlog' | 'nextWakeAtEpochMs'>,
): Promise<void> {
  const wake: WakeRequest | null = result.backlog
    ? { queue, kind: 'immediate' }
    : result.nextWakeAtEpochMs === null
      ? null
      : {
          queue,
          kind: 'scheduled',
          atEpochMs: requireEpochMs('next wake', result.nextWakeAtEpochMs),
        }
  if (wake === null) return
  try {
    await schedule(Object.freeze(wake))
  } catch (cause) {
    // Propagate to the tick caller so an at-least-once host retries delivery.
    // The enqueue/emit hook remains best-effort after its durable mutation.
    throw new WakeSchedulingError(cause)
  }
}
