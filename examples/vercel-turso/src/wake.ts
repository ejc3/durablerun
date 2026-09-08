import type { WakeScheduler } from '@durablerun/driver'
import { send } from '@vercel/queue'

export const WAKE_TOPIC = 'durablerun-wake'
export const WAKE_RETENTION_SECONDS = 86_400
// Leave an hour for delivery retries before expiry. Longer sleeps rearm when
// this early advisory wake asks the database for the next transition again.
export const WAKE_MAX_DELAY_SECONDS = WAKE_RETENTION_SECONDS - 3_600
export const WAKE_HANDLER_OPTIONS = Object.freeze({
  visibilityTimeoutSeconds: 30,
  retry: () => ({ afterSeconds: 5 }),
})

/** Only the adapter reads wall time: it never decides database eligibility. */
export function vercelWakeScheduler(
  publish: typeof send = send,
  now: () => number = Date.now,
): WakeScheduler {
  return async (wake) => {
    if (typeof wake.queue !== 'string' || wake.queue.length === 0) {
      throw new TypeError('wake queue must be a non-empty string')
    }
    let delaySeconds = 0
    if (wake.kind === 'scheduled') {
      const timestamp = wake.atEpochMs
      const current = now()
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(current)) {
        throw new TypeError('wake timestamps must be safe integer epochs')
      }
      delaySeconds = Math.min(
        WAKE_MAX_DELAY_SECONDS,
        Math.max(0, Math.ceil((timestamp - current) / 1_000)),
      )
    } else if (wake.kind !== 'immediate') {
      throw new TypeError('unknown wake kind')
    }
    // No deduplication key: provider dedup survives delivery for the whole TTL
    // and could suppress a legitimate later tick for the same due timestamp.
    await publish(
      WAKE_TOPIC,
      { queue: wake.queue },
      { delaySeconds, retentionSeconds: WAKE_RETENTION_SECONDS },
    )
  }
}

/** Called only behind the provider's private queue-consumer boundary. */
export async function receiveVercelWake(
  message: unknown,
  queue: string,
  runTick: () => Promise<unknown>,
): Promise<void> {
  if (
    typeof message !== 'object' ||
    message === null ||
    Array.isArray(message) ||
    !Object.hasOwn(message, 'queue') ||
    Reflect.get(message, 'queue') !== queue
  ) {
    throw new TypeError('wake message does not belong to this queue')
  }
  // Never swallow failure: successful callback return acknowledges delivery.
  await runTick()
}
