import type { SchedulerStore } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { DriverLoop } from '../src/index.js'
import { FakeClock, FakeLauncher, until } from './loop-harness.js'

const Q = 'q'
const BUSY_CEILING_MS = 250
const IDLE_CEILING_MS = 5_000
const WAKE_FLOOR_MS = 250
const ROUNDS = 25

/** Registry intervals below the busy ceiling, between the ceilings, and above both. */
const REGISTRY_INTERVALS_MS = [100, 1_000, 15_000]
/** Host clock steps with database time held still: none, and small or large in each direction. */
const CLOCK_STEPS_MS = [0, 400, 3_600_000, -400, -3_600_000]

interface ClockShape {
  registryIntervalMs: number
  stepMs: number
  wake: boolean
}

function clockShapes(): ClockShape[] {
  return REGISTRY_INTERVALS_MS.flatMap((registryIntervalMs) =>
    CLOCK_STEPS_MS.flatMap((stepMs) =>
      [false, true].map((wake) => ({ registryIntervalMs, stepMs, wake })),
    ),
  )
}

/**
 * Drive an idle loop through one clock shape and report every broken promise: a
 * park or floor wait that outlasts the registry interval or the idle ceiling, a
 * registry beat that falls behind its cadence, or ticks that spin without parking.
 */
async function clockShapeProblems(shape: ClockShape): Promise<string[]> {
  const label = `interval ${shape.registryIntervalMs}ms, step ${shape.stepMs}ms${shape.wake ? ', wake' : ''}`
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(label))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  let databaseNowMs = clock.now
  await admin.setFakeNowEpochMs(databaseNowMs)
  let beats = 0
  const counted = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'driverHeartbeat') {
        return async (...args: Parameters<SchedulerStore['driverHeartbeat']>) => {
          await target.driverHeartbeat(...args)
          beats++
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const loop = new DriverLoop(
    { store: counted, launcher: new FakeLauncher(), ids, clock },
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
  try {
    let sleep = await nextSleep(undefined, 'the first park')
    // A host clock step moves wall time, not a pending timer: real timers measure
    // elapsed time, so each pending sleep keeps its remaining duration.
    clock.now += shape.stepMs
    for (const pending of clock.sleeps) pending.deadline += shape.stepMs
    if (shape.wake) {
      loop.wake()
      sleep = await nextSleep(sleep, 'the wait after a wake')
    }
    const beatsAtStep = beats
    let elapsedMs = 0
    for (let round = 0; round < ROUNDS; round++) {
      elapsedMs += sleep.ms
      clock.now += sleep.ms
      databaseNowMs += sleep.ms
      await admin.setFakeNowEpochMs(databaseNowMs)
      clock.fire()
      sleep = await nextSleep(sleep, `park ${round + 1}`)
    }
    const floorBeats = Math.floor(elapsedMs / shape.registryIntervalMs) - 1
    if (beats - beatsAtStep < floorBeats) {
      problems.push(
        `${label}: ${beats - beatsAtStep} registry beats in ${elapsedMs}ms, fewer than ${floorBeats}`,
      )
    }
    if (loop.stats.ticks > 3 * ROUNDS) {
      problems.push(`${label}: ${loop.stats.ticks} ticks for ${ROUNDS} parks`)
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
    const problems: string[] = []
    for (const shape of clockShapes()) problems.push(...(await clockShapeProblems(shape)))
    expect(problems).toEqual([])
  }, 120_000)
})
