import { type ClaimedRun, LeaseLostError } from '@durablerun/core'
import { Rng } from '@durablerun/harness'
import type { StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'

const Q = 'q'

/**
 * Seeded operation fuzz (BUILD.md PR1.6): a deterministic random walk over
 * the full transition surface — spawn, claim, activate, complete, fail,
 * reschedule, checkpoint, expireLeaseNow, sweep, time advance — with the
 * engine invariants asserted throughout. Any failing seed replays exactly.
 * (Interleaving fuzz via SimWorld schedules is layered on separately; this
 * walk hammers state-machine coverage, not concurrency.)
 */
export async function runFuzzScenario(
  makeFixture: StoreFixtureFactory,
  seed: number | string,
  steps: number,
): Promise<void> {
  const f = await makeFixture(`fuzz-${seed}`)
  try {
    await runWalk(f, seed, steps)
  } finally {
    f.close()
  }
}

async function runWalk(
  f: Awaited<ReturnType<StoreFixtureFactory>>,
  seed: number | string,
  steps: number,
): Promise<void> {
  const rng = new Rng(`fuzz-${seed}`)
  let now = 1_000_000
  await f.admin.setFakeNowEpochMs(now)
  const held: ClaimedRun[] = []
  const knownTasks: string[] = []
  let claimCounter = 0
  let idemCounter = 0
  let progress = 0

  const expectLeaseLoss = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op()
    } catch (error) {
      // Abandoned/swept runs legitimately lose their lease mid-walk.
      if (!(error instanceof LeaseLostError)) throw error
    }
  }

  for (let step = 0; step < steps; step++) {
    const roll = rng.next()
    if (roll < 0.2) {
      const opts =
        rng.next() < 0.3
          ? {
              maxAttempts: 1 + rng.int(3),
              cancellation:
                rng.next() < 0.5
                  ? { maxDelaySeconds: 30 + rng.int(120) }
                  : { maxDurationSeconds: 30 + rng.int(120) },
            }
          : {}
      const spawned = await f.store.spawn(
        Q,
        `t${step}`,
        '{}',
        rng.next() < 0.2 ? { ...opts, idempotencyKey: `k${idemCounter++ % 4}` } : opts,
      )
      knownTasks.push(spawned.taskId)
      progress++
    } else if (roll < 0.4) {
      const claimed = await f.store.claim(Q, `w${claimCounter++}`, {
        leaseSeconds: 30 + rng.int(60),
        limit: 1 + rng.int(3),
      })
      for (const run of claimed) {
        if (rng.next() < 0.8) {
          const activated = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          if (activated) held.push(activated)
        }
      }
    } else if (roll < 0.65 && held.length > 0) {
      const run = held.splice(rng.int(held.length), 1)[0]
      if (!run) continue
      const kind = rng.next()
      if (kind < 0.35) {
        await expectLeaseLoss(() =>
          f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}').then(() => progress++),
        )
      } else if (kind < 0.55) {
        await expectLeaseLoss(() =>
          f.store.fail(Q, run.runId, run.claimToken, '{"name":"FuzzFail"}', {
            delaySeconds: rng.int(30),
          }),
        )
      } else if (kind < 0.65) {
        await expectLeaseLoss(() =>
          f.store.fail(Q, run.runId, run.claimToken, '{"name":"FuzzFatal"}', null),
        )
      } else if (kind < 0.85) {
        await expectLeaseLoss(() =>
          f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: rng.int(60) }),
        )
      } else if (kind < 0.95) {
        await expectLeaseLoss(() =>
          f.store.setCheckpoint(
            Q,
            run.taskId,
            run.runId,
            run.claimToken,
            `cp-${rng.int(3)}`,
            '{"v":1}',
            30 + rng.int(60),
          ),
        )
        held.push(run) // checkpointing does not release the run
      }
      // else: abandon silently — the sweep must recover it.
    } else if (roll < 0.72) {
      progress += (await f.store.sweep(Q, 1 + rng.int(5))).length
    } else if (roll < 0.76 && held.length > 0) {
      const run = held[rng.int(held.length)]
      if (run) await f.store.heartbeat(Q, run.runId, run.claimToken, 30 + rng.int(60))
    } else if (roll < 0.79 && held.length > 0) {
      const run = held[rng.int(held.length)]
      if (run) await f.store.expireLeaseNow(Q, run.runId, run.claimToken)
    } else if (roll < 0.82 && knownTasks.length > 0) {
      const taskId = knownTasks[rng.int(knownTasks.length)]
      if (taskId && (await f.store.cancelTask(Q, taskId))) progress++
    } else if (roll < 0.85 && held.length > 0) {
      const run = held.splice(rng.int(held.length), 1)[0]
      if (run) {
        await expectLeaseLoss(() =>
          f.store.reschedule(Q, run.runId, run.claimToken, { atEpochMs: now + rng.int(90) * 1000 }),
        )
      }
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
  // invariant-clean). Long walks must accomplish SOMETHING.
  if (steps >= 50 && progress === 0) {
    throw new Error(`fuzz seed ${seed}: zero progress across ${steps} steps`)
  }
}
