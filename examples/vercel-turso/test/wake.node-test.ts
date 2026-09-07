import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { WakeRequest } from '@durablerun/driver'
import type { send } from '@vercel/queue'
import {
  WAKE_HANDLER_OPTIONS,
  WAKE_MAX_DELAY_SECONDS,
  WAKE_RETENTION_SECONDS,
  WAKE_TOPIC,
  receiveVercelWake,
  vercelWakeScheduler,
} from '../src/wake.js'

test('generated wake boundaries preserve one delivery per hint, delays, and retry headroom', async () => {
  for (const now of [0, 1_000_000, Number.MAX_SAFE_INTEGER - 1_000]) {
    for (const offset of [-1_001, -1, 0, 1, 999, 1_000, 1_001, 100_000_000]) {
      const timestamp = now + offset
      if (timestamp < 0 || !Number.isSafeInteger(timestamp)) continue
      const calls: Parameters<typeof send>[] = []
      const publish: typeof send = async (...args) => {
        calls.push(args)
        return { messageId: 'test-message' }
      }
      const schedule = vercelWakeScheduler(publish, () => now)
      const wake = { queue: 'q', kind: 'scheduled', atEpochMs: timestamp } as const
      await schedule(wake)
      await schedule(wake)
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[0], [
        WAKE_TOPIC,
        { queue: 'q' },
        {
          delaySeconds: Math.min(WAKE_MAX_DELAY_SECONDS, Math.max(0, Math.ceil(offset / 1_000))),
          retentionSeconds: WAKE_RETENTION_SECONDS,
        },
      ])
      assert.deepEqual(calls[1], calls[0])
    }
  }
  assert.ok(WAKE_MAX_DELAY_SECONDS < WAKE_RETENTION_SECONDS)
})

test('immediate wake does not consult wall time or attach a deduplication key', async () => {
  const calls: Parameters<typeof send>[] = []
  const publish: typeof send = async (...args) => {
    calls.push(args)
    return { messageId: 'immediate' }
  }
  await vercelWakeScheduler(publish, () => {
    throw new Error('immediate work must not read time')
  })({ kind: 'immediate', queue: 'q' })
  assert.deepEqual(calls, [
    [WAKE_TOPIC, { queue: 'q' }, { delaySeconds: 0, retentionSeconds: WAKE_RETENTION_SECONDS }],
  ])
})

test('publish and receiver failures propagate so the provider does not acknowledge lost work', async () => {
  const failure = new Error('provider unavailable')
  const schedule = vercelWakeScheduler(async () => {
    throw failure
  })
  await assert.rejects(schedule({ kind: 'immediate', queue: 'q' }), failure)
  await assert.rejects(
    receiveVercelWake({ queue: 'q' }, 'q', async () => {
      throw failure
    }),
    failure,
  )
  assert.deepEqual(WAKE_HANDLER_OPTIONS.retry(), { afterSeconds: 5 })
  assert.equal(WAKE_HANDLER_OPTIONS.visibilityTimeoutSeconds, 30)
})

test('invalid messages cannot tick a different queue', async () => {
  let ticks = 0
  for (const message of [null, false, [], {}, { queue: 'other' }, Object.create({ queue: 'q' })]) {
    await assert.rejects(
      receiveVercelWake(message, 'q', async () => {
        ticks += 1
      }),
      TypeError,
    )
  }
  assert.equal(ticks, 0)
  await receiveVercelWake({ queue: 'q' }, 'q', async () => {
    ticks += 1
  })
  assert.equal(ticks, 1)
})

test('invalid scheduler epochs fail before publishing', async () => {
  let publishes = 0
  const schedule = vercelWakeScheduler(async () => {
    publishes += 1
    return { messageId: 'unexpected' }
  })
  for (const atEpochMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    await assert.rejects(schedule({ queue: 'q', kind: 'scheduled', atEpochMs }), TypeError)
  }
  await assert.rejects(schedule({ queue: '', kind: 'immediate' }), TypeError)
  await assert.rejects(schedule({ queue: 'q', kind: 'wrong' } as unknown as WakeRequest), TypeError)
  assert.equal(publishes, 0)
})
