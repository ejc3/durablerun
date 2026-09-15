import { type ClaimedRun, isRefusedWrite } from '@durablerun/core'
import { Rng } from '@durablerun/harness'
import type { StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { awaitOwned, checkpointOwned, withFixture } from './scenario.js'

const Q = 'q'

/**
 * Per-walk success counters. The shard runner AGGREGATES these across its
 * seeds and asserts every core transition fired somewhere in the shard —
 * per-walk floors would be flaky (one unlucky seed is deterministic
 * forever), aggregate floors are statistically bulletproof and still catch
 * "this op stopped working entirely" (the class the plain progress floor
 * cannot see: complete could throw LeaseLostError on every call and a
 * spawn-only progress count would stay green).
 */
export interface FuzzStats {
  spawnsCreated: number
  claims: number
  activates: number
  completes: number
  fails: number
  reschedules: number
  checkpoints: number
  sweepTransitions: number
  cancels: number
  nextWakes: number
  emits: number
  awaits: number
}

/**
 * Seeded operation fuzz: a deterministic random walk over
 * the full transition surface — spawn, claim, activate, complete, fail,
 * reschedule, checkpoint, heartbeat, cancel, expireLeaseNow, sweep,
 * nextWakeAt, time advance — with the engine invariants asserted throughout
 * and fractional/invalid numeric corpora at the port boundary. Any failing
 * seed replays exactly. (Interleaving fuzz via SimWorld schedules is layered
 * on separately; this walk hammers state-machine coverage, not concurrency.)
 */
export async function runFuzzScenario(
  makeFixture: StoreFixtureFactory,
  seed: number | string,
  steps: number,
): Promise<FuzzStats> {
  return withFixture(makeFixture, `fuzz-${seed}`, (f) => runWalk(f, seed, steps))
}

async function runWalk(
  f: Awaited<ReturnType<StoreFixtureFactory>>,
  seed: number | string,
  steps: number,
): Promise<FuzzStats> {
  const rng = new Rng(`fuzz-${seed}`)
  let now = 1_000_000
  await f.admin.setFakeNowEpochMs(now)
  const held: ClaimedRun[] = []
  const knownTasks: string[] = []
  let claimCounter = 0
  let idemCounter = 0
  const stats: FuzzStats = {
    spawnsCreated: 0,
    claims: 0,
    activates: 0,
    completes: 0,
    fails: 0,
    reschedules: 0,
    checkpoints: 0,
    sweepTransitions: 0,
    cancels: 0,
    nextWakes: 0,
    emits: 0,
    awaits: 0,
  }

  /** Fractional seconds are legal (rounded to ms) — exercise them freely. */
  const frac = (): number => (rng.next() < 0.3 ? 0.5005 : 0)

  /** Run a transition that may lose its lease, and count it only when it held. */
  const countIfHeld = async (stat: keyof FuzzStats, op: () => Promise<unknown>): Promise<void> => {
    try {
      await op()
      stats[stat]++
    } catch (error) {
      // Abandoned, swept, or cancelled runs legitimately refuse writes mid-walk.
      if (!isRefusedWrite(error)) throw error
    }
  }

  for (let step = 0; step < steps; step++) {
    const roll = rng.next()
    if (roll < 0.03) {
      // Invalid-numeric corpus: the port MUST refuse these (§3.4 rule 7) —
      // a silent acceptance is a walk failure, not a skipped op.
      const bad = rng.next()
      try {
        if (bad < 0.34) {
          await f.store.spawn(Q, 'bad', '{}', { startDelaySeconds: Number.POSITIVE_INFINITY })
        } else if (bad < 0.67) {
          await f.store.claim(Q, `w${claimCounter++}`, { leaseSeconds: Number.NaN, limit: 1 })
        } else {
          await f.store.spawn(Q, 'bad', '{}', { maxAttempts: 0 })
        }
        throw new Error(`fuzz seed ${seed} step ${step}: invalid numeric input was ACCEPTED`)
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
      }
    } else if (roll < 0.2) {
      const opts =
        rng.next() < 0.3
          ? {
              maxAttempts: 1 + rng.int(3),
              ...(rng.next() < 0.3 ? { startDelaySeconds: frac() } : {}),
              cancellation:
                rng.next() < 0.5
                  ? { maxDelaySeconds: 30 + rng.int(120) + frac() }
                  : { maxDurationSeconds: 30 + rng.int(120) + frac() },
            }
          : {}
      const spawned = await f.store.spawn(
        Q,
        `t${step}`,
        '{}',
        rng.next() < 0.2 ? { ...opts, idempotencyKey: `k${idemCounter++ % 4}` } : opts,
      )
      knownTasks.push(spawned.taskId)
      if (spawned.created) stats.spawnsCreated++
    } else if (roll < 0.4) {
      const claimed = await f.store.claim(Q, `w${claimCounter++}`, {
        leaseSeconds: 30 + rng.int(60) + frac(),
        limit: 1 + rng.int(3),
      })
      stats.claims += claimed.length
      for (const run of claimed) {
        if (rng.next() < 0.8) {
          const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          if (activated) {
            held.push(activated)
            stats.activates++
          }
        }
      }
    } else if (roll < 0.65 && held.length > 0) {
      const run = held.splice(rng.int(held.length), 1)[0]
      if (!run) continue
      const kind = rng.next()
      if (kind < 0.35) {
        await countIfHeld('completes', () =>
          f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}'),
        )
      } else if (kind < 0.55) {
        await countIfHeld('fails', () =>
          f.store.fail(Q, run.runId, run.claimToken, '{"name":"FuzzFail"}', {
            delaySeconds: rng.int(30) + frac(),
          }),
        )
      } else if (kind < 0.65) {
        await countIfHeld('fails', () =>
          f.store.fail(Q, run.runId, run.claimToken, '{"name":"FuzzFatal"}', null),
        )
      } else if (kind < 0.85) {
        await countIfHeld('reschedules', () =>
          f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: rng.int(60) + frac() }),
        )
      } else if (kind < 0.9) {
        await countIfHeld('awaits', () =>
          awaitOwned(
            f.store,
            Q,
            run,
            `w${step}`,
            `ev${rng.int(3)}`,
            rng.next() < 0.5 ? 30 + rng.int(60) : null,
          ),
        )
        // Parked or answered inline — either way this hold is finished.
      } else if (kind < 0.95) {
        await countIfHeld('checkpoints', () =>
          checkpointOwned(
            f.store,
            Q,
            run,
            `cp-${rng.int(3)}`,
            '{"v":1}',
            30 + rng.int(60) + frac(),
          ),
        )
        held.push(run) // checkpointing does not release the run
      }
      // else: abandon silently — the sweep must recover it.
    } else if (roll < 0.72) {
      stats.sweepTransitions += (await f.store.sweep(Q, 1 + rng.int(5))).length
    } else if (roll < 0.75 && held.length > 0) {
      const run = held[rng.int(held.length)]
      if (run) await f.store.heartbeat(Q, run.runId, run.claimToken, 30 + rng.int(60) + frac())
    } else if (roll < 0.78 && held.length > 0) {
      const run = held[rng.int(held.length)]
      if (run) await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
    } else if (roll < 0.81 && knownTasks.length > 0) {
      const taskId = knownTasks[rng.int(knownTasks.length)]
      if (taskId && (await f.store.cancelTask(Q, taskId))) stats.cancels++
    } else if (roll < 0.84 && held.length > 0) {
      const run = held.splice(rng.int(held.length), 1)[0]
      if (run) {
        await countIfHeld('reschedules', () =>
          f.store.reschedule(Q, run.runId, run.claimToken, {
            atEpochMs: now + rng.int(90) * 1000,
          }),
        )
      }
    } else if (roll < 0.86) {
      await f.store.emitEvent(Q, `ev${rng.int(3)}`, `{"n":${rng.int(9)}}`)
      stats.emits++
    } else if (roll < 0.88) {
      // The read path fuzzes too: nextWakeAt must always be a safe integer
      // (an Inf lease or REAL epoch surfaces HERE even before the invariant
      // sweep sees the row).
      const wake = await f.store.nextWakeAtEpochMs(Q)
      if (wake !== null && !Number.isSafeInteger(wake)) {
        throw new Error(`fuzz seed ${seed} step ${step}: nextWakeAt returned ${wake}`)
      }
      stats.nextWakes++
    } else {
      now += (1 + rng.int(120)) * 1000
      await f.admin.setFakeNowEpochMs(now)
    }

    if (step % 10 === 9) {
      const violations = await engineInvariantViolations(f.raw)
      if (violations.length > 0) {
        throw new Error(`fuzz seed ${seed} step ${step}: ${violations.join('; ')}`)
      }
    }
  }
  const violations = await engineInvariantViolations(f.raw)
  if (violations.length > 0) {
    throw new Error(`fuzz seed ${seed} final: ${violations.join('; ')}`)
  }
  // Progress floor: safety-only fuzz cannot see total loss of progress (a
  // fence regression making every transition a fenced no-op stays
  // invariant-clean). Long walks must accomplish SOMETHING; the shard runner
  // additionally asserts per-op aggregate floors across its seeds.
  const progress =
    stats.spawnsCreated +
    stats.completes +
    stats.fails +
    stats.reschedules +
    stats.sweepTransitions +
    stats.cancels
  if (steps >= 50 && progress === 0) {
    throw new Error(`fuzz seed ${seed}: zero progress across ${steps} steps`)
  }
  return stats
}
