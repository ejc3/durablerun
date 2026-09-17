import type { SchedulerStore } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource, withStoreOverrides } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { DriverLoop } from '../src/index.js'
import { FakeLauncher, until } from './loop-harness.js'

const Q = 'q'
const BUSY_CEILING_MS = 250
const IDLE_CEILING_MS = 5_000
const WAKE_FLOOR_MS = 250
const ROUNDS = 25
/** How far ahead, in database time, a due-wake shape's task becomes due. */
const DUE_WAKE_DELAY_MS = 2_000
/** Shapes run in batches, each with its own database and clock. */
const SHAPE_BATCH = 8

/** Registry intervals below the busy ceiling, between the ceilings, and above both. */
const REGISTRY_INTERVALS_MS = [100, 1_000, 15_000]
/** Host clock steps with database time held still: none, and small or large in each direction. */
const CLOCK_STEPS_MS = [0, 400, 3_600_000, -400, -3_600_000]

interface ClockShape {
  registryIntervalMs: number
  stepMs: number
  /** Whether the step lands as the park starts or halfway through it. */
  stepAt: 'start' | 'middle'
  wake: boolean
  /** Whether a task becomes due, in database time, while the loop parks. */
  dueWake: boolean
}

function clockShapes(): ClockShape[] {
  return REGISTRY_INTERVALS_MS.flatMap((registryIntervalMs) =>
    CLOCK_STEPS_MS.flatMap((stepMs) =>
      (stepMs === 0 ? (['start'] as const) : (['start', 'middle'] as const)).flatMap((stepAt) =>
        [false, true].flatMap((wake) =>
          [false, true].map((dueWake) => ({ registryIntervalMs, stepMs, stepAt, wake, dueWake })),
        ),
      ),
    ),
  )
}

/**
 * Drive an idle loop through one clock shape and report every broken promise: a
 * park or floor wait that outlasts the registry interval or the idle ceiling, a
 * floor wait that ends after the look its interrupted park planned, a registry beat
 * that falls behind its cadence, or ticks that spin without parking.
 */
async function clockShapeProblems(shape: ClockShape): Promise<string[]> {
  const label = `interval ${shape.registryIntervalMs}ms, step ${shape.stepMs}ms at ${shape.stepAt}${shape.wake ? ', wake' : ''}${shape.dueWake ? ', due wake' : ''}`
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(label))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  let databaseNowMs = clock.now
  await admin.setFakeNowEpochMs(databaseNowMs)
  let beats = 0
  const counted = withStoreOverrides(store, {
    driverHeartbeat: async (...args: Parameters<SchedulerStore['driverHeartbeat']>) => {
      await store.driverHeartbeat(...args)
      beats++
    },
  })
  const launcher = new FakeLauncher()
  const dueAtDatabaseMs = databaseNowMs + DUE_WAKE_DELAY_MS
  if (shape.dueWake) {
    await store.spawn(Q, 'job', '{}', { startDelaySeconds: DUE_WAKE_DELAY_MS / 1000 })
  }
  // Elapsed time at which database time reached the due wake, and when it launched.
  let dueAtElapsedMs: number | null = null
  let launchLatencyMs: number | null = null
  const loop = new DriverLoop(
    { store: counted, launcher, ids, clock },
    {
      queue: Q,
      claimLimit: 3,
      sweepLimit: 5,
      leaseSeconds: 60,
      busyCeilingMs: BUSY_CEILING_MS,
      idleCeilingMs: IDLE_CEILING_MS,
      wakeFloorMs: WAKE_FLOOR_MS,
      idleAfterTicks: 2,
      registryIntervalSeconds: shape.registryIntervalMs / 1000,
    },
  )
  const problems: string[] = []
  const done = loop.run()
  const nextSleep = async (after: unknown, what: string) => {
    await until(
      () => clock.sleeps.length === 1 && clock.sleeps[0] !== after,
      `${label}: ${what} (pending ${JSON.stringify(clock.sleeps.map((entry) => entry.ms))}, ticks ${loop.stats.ticks})`,
    )
    const sleep = clock.sleeps[0]
    if (sleep === undefined) throw new Error(`${label}: ${what} vanished`)
    if (sleep.ms > shape.registryIntervalMs) {
      problems.push(`${label}: ${what} slept ${sleep.ms}ms, past the registry interval`)
    }
    if (sleep.ms > IDLE_CEILING_MS) {
      problems.push(`${label}: ${what} slept ${sleep.ms}ms, past the idle ceiling`)
    }
    return sleep
  }
  const advance = async (ms: number) => {
    if (shape.dueWake && dueAtElapsedMs === null && databaseNowMs + ms >= dueAtDatabaseMs) {
      // Elapsed and database time move together here, so this is the due instant.
      dueAtElapsedMs = clock.elapsed + (dueAtDatabaseMs - databaseNowMs)
    }
    clock.advance(ms)
    databaseNowMs += ms
    await admin.setFakeNowEpochMs(databaseNowMs)
    clock.fire()
  }
  try {
    let sleep = await nextSleep(undefined, 'the first park')
    const park = sleep
    const parkStartedAtElapsedMs = clock.elapsed
    if (shape.stepAt === 'middle') await advance(Math.floor(park.ms / 2))
    // A host clock step moves wall time only. Timers and the loop's own waits run on
    // elapsed time, which the step does not move.
    clock.now += shape.stepMs
    if (shape.wake) {
      const ticksBeforeWake = loop.stats.ticks
      loop.wake()
      sleep = await nextSleep(park, 'the wait after a wake')
      const overshootMs = clock.elapsed + sleep.ms - (parkStartedAtElapsedMs + park.ms)
      if (loop.stats.ticks === ticksBeforeWake && overshootMs > 0) {
        problems.push(
          `${label}: the wait after a wake ends ${overshootMs}ms past the look the park planned`,
        )
      }
    }
    const beatsAtStep = beats
    let roundsElapsedMs = 0
    // A due-wake shape keeps parking until its task launches or database time is well
    // past the due time; short registry intervals need many more parks to get there.
    let round = 0
    const keepParking = () =>
      round < ROUNDS ||
      (shape.dueWake &&
        launchLatencyMs === null &&
        databaseNowMs < dueAtDatabaseMs + 2 * IDLE_CEILING_MS)
    for (; keepParking(); round++) {
      roundsElapsedMs += sleep.ms
      await advance(sleep.ms)
      sleep = await nextSleep(sleep, `park ${round + 1}`)
      if (launchLatencyMs === null && dueAtElapsedMs !== null && launcher.invocations.length > 0) {
        launchLatencyMs = clock.elapsed - dueAtElapsedMs
      }
    }
    if (shape.dueWake) {
      // A park never outlasts the idle ceiling or the registry interval, so a due task
      // must launch within one such park of becoming due, whatever the host clock did.
      const boundMs = Math.min(IDLE_CEILING_MS, shape.registryIntervalMs)
      if (launchLatencyMs === null) {
        problems.push(`${label}: the due task never launched`)
      } else if (launchLatencyMs > boundMs) {
        problems.push(
          `${label}: the due task launched ${launchLatencyMs}ms after it became due, past ${boundMs}ms`,
        )
      }
    }
    const floorBeats = Math.floor(roundsElapsedMs / shape.registryIntervalMs) - 1
    if (beats - beatsAtStep < floorBeats) {
      problems.push(
        `${label}: ${beats - beatsAtStep} registry beats in ${roundsElapsedMs}ms, fewer than ${floorBeats}`,
      )
    }
    if (loop.stats.ticks > 3 * round) {
      problems.push(`${label}: ${loop.stats.ticks} ticks for ${round} parks`)
    }
  } finally {
    await loop.stop()
    await done
    raw.close()
  }
  return problems
}

describe('driver loop clock shapes', () => {
  it('every generated clock shape keeps parks within the registry interval and beats on cadence', async () => {
    const shapes = clockShapes()
    const problems: string[] = []
    for (let start = 0; start < shapes.length; start += SHAPE_BATCH) {
      const batch = await Promise.all(
        shapes.slice(start, start + SHAPE_BATCH).map(clockShapeProblems),
      )
      problems.push(...batch.flat())
    }
    expect(problems).toEqual([])
  }, 240_000)
})
