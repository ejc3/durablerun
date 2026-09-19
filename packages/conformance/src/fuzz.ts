import {
  ChildAwaitRefusedError,
  type ClaimedRun,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  encodeRollbackTry,
  isRefusedWrite,
  taskDoneEventName,
} from '@durablerun/core'
import { Rng } from '@durablerun/harness'
import { childTaskViolations } from './child-tasks.js'
import type { StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { sagaViolations } from './saga-rows.js'
import { awaitOwned, awaitTaskOwned, checkpointOwned, withFixture } from './scenario.js'

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
  childAwaits: number
  /** Awaits that recorded the outcome of a child that had ended with no completion event. */
  recordedEndings: number
  /** Registered steps that started: the start marker committed (Sagas.tla's StartStep). */
  stepsStarted: number
  /** Terminal failures that entered the rolling-back phase. */
  sagasEntered: number
  /** Rollbacks that ran and committed (RunRollback). */
  rollbacks: number
  /** Failed rollback attempts that were recorded (RollbackRetry and RollbackHalts). */
  rollbackFailures: number
  /** Tasks that ended from inside the phase by a pass's own write. */
  sagasEnded: number
  /** Results read at the end of a walk that named the rollback whose failure ended the task. */
  haltsNamed: number
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
    childAwaits: 0,
    recordedEndings: 0,
    stepsStarted: 0,
    sagasEntered: 0,
    rollbacks: 0,
    rollbackFailures: 0,
    sagasEnded: 0,
    haltsNamed: 0,
  }
  /** What the walk knows of each task's saga: its steps in start order, and what ran. */
  const sagas = new Map<
    string,
    { started: string[]; rolledBack: Set<string>; tries: Map<string, number> }
  >()
  /** Tasks the walk saw enter the phase. One may since have ended by a cancel or a sweep. */
  const rolling = new Set<string>()
  /** The failure of the rollback that ended a task, by task: the one its result must name. */
  const haltedBy = new Map<string, string>()
  const sagaOf = (taskId: string) => {
    const known = sagas.get(taskId)
    if (known) return known
    const fresh = { started: [], rolledBack: new Set<string>(), tries: new Map<string, number>() }
    sagas.set(taskId, fresh)
    return fresh
  }

  /** The engine invariants, and what ChildTasks.tla requires of rows only the engine wrote. */
  const violationsNow = async (): Promise<string[]> => [
    ...(await engineInvariantViolations(f.raw)),
    ...(await childTaskViolations(f.raw)),
    ...(await sagaViolations(f.raw)),
  ]

  /** Fractional seconds are legal (rounded to ms) — exercise them freely. */
  const frac = (): number => (rng.next() < 0.3 ? 0.5005 : 0)

  /** Run a transition that may lose its lease, count it only when it held, and say whether it did. */
  const countIfHeld = async (
    stat: keyof FuzzStats,
    op: () => Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await op()
      stats[stat]++
      return true
    } catch (error) {
      // Abandoned, swept, or cancelled runs legitimately refuse writes mid-walk.
      if (!isRefusedWrite(error)) throw error
      return false
    }
  }

  const SAGA_CAUSE = '{"name":"FuzzSagaCause"}'
  /**
   * One move of a rollback pass (Sagas.tla): run the rollback of the pending step that
   * started last, fail it with budget left, fail it for good, or end the task. The walk
   * keeps the order legal, because the order is the SDK's to keep and the row checker's
   * to hold. Whatever else the walk does to a pass, the store must refuse.
   */
  const passMove = async (run: ClaimedRun): Promise<void> => {
    const saga = sagaOf(run.taskId)
    const pending = saga.started.filter((step) => !saga.rolledBack.has(step))
    const step = pending[pending.length - 1]
    const release = () => {
      const at = held.indexOf(run)
      if (at !== -1) held.splice(at, 1)
    }
    const kind = rng.next()
    if (step !== undefined && kind < 0.4) {
      const ran = await countIfHeld('rollbacks', () =>
        checkpointOwned(f.store, Q, run, `${SAGA_ROLLBACK_PREFIX}${step}`, 'null', 60),
      )
      if (ran) saga.rolledBack.add(step)
      return
    }
    release()
    if (step !== undefined && kind < 0.8) {
      const tries = (saga.tries.get(step) ?? 0) + 1
      const halts = kind >= 0.7
      // Each attempt's failure is its own, so a result that names another attempt's is seen.
      const errorJson = JSON.stringify({ name: 'FuzzRollbackBoom', step, tries })
      const failed = await countIfHeld('rollbackFailures', () =>
        f.store.failRollback(
          Q,
          run.runId,
          run.claimToken,
          SAGA_CAUSE,
          halts ? null : { delaySeconds: rng.int(5) + frac() },
          {
            key: `${SAGA_TRIES_PREFIX}${step}`,
            stateJson: encodeRollbackTry({ tries, errorJson }),
          },
        ),
      )
      if (failed) saga.tries.set(step, tries)
      if (failed && halts) {
        stats.sagasEnded++
        rolling.delete(run.taskId)
        haltedBy.set(run.taskId, errorJson)
      }
      return
    }
    // FinishSaga, or a pass that gives up with a rollback still owed, which the outcome says.
    const ended = await countIfHeld('fails', () =>
      f.store.fail(Q, run.runId, run.claimToken, SAGA_CAUSE, null),
    )
    if (ended) {
      stats.sagasEnded++
      rolling.delete(run.taskId)
    }
  }

  /** Up to three moves of a pass the walk holds, so one saga usually shows every kind of move. */
  const passMoves = async (run: ClaimedRun): Promise<void> => {
    for (let move = 0; move < 3 && held.includes(run) && rolling.has(run.taskId); move++) {
      await passMove(run)
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
    } else if (roll >= 0.15 && roll < 0.2 && held.length > 0) {
      // Sagas, five steps in a hundred taken from the spawn's share while a run is held.
      // A held pass moves its saga on. Any other held run starts a registered step, and
      // more often than not then fails for good, which enters the phase. The walk claims
      // at once, so the pass is usually in hand, and moves it.
      const run =
        held.find((candidate) => rolling.has(candidate.taskId)) ??
        held.find((candidate) => sagaOf(candidate.taskId).started.length > 0) ??
        held[rng.int(held.length)]
      if (!run) continue
      const saga = sagaOf(run.taskId)
      if (rolling.has(run.taskId)) {
        await passMoves(run)
      } else {
        if (saga.started.length === 0 || rng.next() < 0.5) {
          const step = `s${saga.started.length + 1}`
          const started = await countIfHeld('stepsStarted', () =>
            checkpointOwned(
              f.store,
              Q,
              run,
              `${SAGA_STARTED_PREFIX}${step}`,
              String(saga.started.length + 1),
              30 + rng.int(60) + frac(),
            ),
          )
          if (started) saga.started.push(step)
        }
        if (saga.started.length > 0 && rng.next() < 0.6) {
          held.splice(held.indexOf(run), 1)
          try {
            const failed = await f.store.fail(Q, run.runId, run.claimToken, SAGA_CAUSE, null)
            stats.fails++
            if (failed.rollingBack) {
              stats.sagasEntered++
              rolling.add(run.taskId)
              const claimed = await f.store.claim(Q, `w${claimCounter++}`, {
                leaseSeconds: 60,
                limit: 3,
              })
              stats.claims += claimed.length
              for (const next of claimed) {
                const activated = await f.store.activate(
                  Q,
                  next.runId,
                  next.claimToken,
                  next.claimGen,
                )
                if (!activated) continue
                held.push(activated)
                stats.activates++
                if (activated.taskId === run.taskId) await passMoves(activated)
              }
            }
          } catch (error) {
            if (!isRefusedWrite(error)) throw error
          }
        }
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
      if (rolling.has(run.taskId) && rng.next() < 0.5) {
        // A pass moves its saga on. The other half of the time the walk treats it as
        // any held run, and the store must refuse whatever would move it forward.
        held.push(run)
        await passMoves(run)
        continue
      }
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
    } else if (roll < 0.91 && held.length > 0) {
      // Three steps in a hundred, taken from the clock's share, so that a shard of
      // twenty short walks cannot miss the op its aggregate floor requires.
      const run = held.splice(rng.int(held.length), 1)[0]
      if (!run) continue
      // A parent awaits a child: a task it spawns now, or any task the walk knows,
      // which may have ended already, may end later by any terminal batch, or may
      // be the parent itself. Every terminal batch in the walk owes it a wake.
      const kind = rng.next()
      if (kind < 0.2) {
        // The queue rule: a child in another queue MUST be refused, and the refusal
        // must leave the run held. A silent acceptance is a walk failure.
        const foreign = await f.store.spawn('other', `foreign${step}`, '{}')
        try {
          await awaitTaskOwned(f.store, Q, run, `cw${step}`, foreign.taskId, null)
          throw new Error(`fuzz seed ${seed} step ${step}: a cross-queue child await was ACCEPTED`)
        } catch (error) {
          if (!(error instanceof ChildAwaitRefusedError)) throw error
        }
        held.push(run)
      } else if (kind < 0.6) {
        // A child that ended with no completion event, as a build older than the event
        // leaves it, and that nobody awaits yet, which is the deploy rule. The await
        // records its outcome and answers as a hit, so the run stays held. A run whose
        // claim is already lost is refused, and then the event is put back: a terminal
        // task with no event is a violation at the next checkpoint.
        const ended = await f.store.spawn(Q, `ended${step}`, '{}')
        await f.store.cancelTask(Q, ended.taskId)
        const eventName = taskDoneEventName(ended.taskId)
        const [saved] = await f.raw.batch(
          'fuzz:the-completion-event',
          [
            {
              sql: 'SELECT * FROM events WHERE queue = ? AND event_name = ?',
              args: [Q, eventName],
            },
          ],
          'read',
        )
        const row = saved?.rows[0]
        if (row === undefined) {
          throw new Error(
            `fuzz seed ${seed} step ${step}: a cancelled task has no completion event`,
          )
        }
        await f.raw.batch('fuzz:an-older-build-wrote-no-event', [
          { sql: 'DELETE FROM events WHERE queue = ? AND event_name = ?', args: [Q, eventName] },
        ])
        let answer: { emitted: boolean } | undefined
        try {
          answer = await awaitTaskOwned(f.store, Q, run, `cw${step}`, ended.taskId, null)
        } catch (error) {
          if (!isRefusedWrite(error)) throw error
        }
        if (answer?.emitted === true) {
          stats.recordedEndings++
          held.push(run)
          knownTasks.push(ended.taskId)
        } else if (answer !== undefined) {
          throw new Error(
            `fuzz seed ${seed} step ${step}: an await PARKED on a child that had ended`,
          )
        } else {
          const columns = Object.keys(row)
          await f.raw.batch('fuzz:the-event-is-put-back', [
            {
              sql: `INSERT INTO events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
              args: columns.map((column) => row[column] ?? null),
            },
          ])
        }
      } else {
        const known = knownTasks[rng.int(knownTasks.length + 1)]
        const childTaskId = known ?? (await f.store.spawn(Q, `child${step}`, '{}')).taskId
        if (known === undefined) knownTasks.push(childTaskId)
        await countIfHeld('childAwaits', () =>
          awaitTaskOwned(
            f.store,
            Q,
            run,
            `cw${step}`,
            childTaskId,
            rng.next() < 0.5 ? 30 + rng.int(60) : null,
          ),
        )
      }
    } else {
      now += (1 + rng.int(120)) * 1000
      await f.admin.setFakeNowEpochMs(now)
    }

    if (step % 10 === 9) {
      const violations = await violationsNow()
      if (violations.length > 0) {
        throw new Error(`fuzz seed ${seed} step ${step}: ${violations.join('; ')}`)
      }
    }
  }
  const violations = await violationsNow()
  if (violations.length > 0) {
    throw new Error(`fuzz seed ${seed} final: ${violations.join('; ')}`)
  }
  // FailedOutcomeHonest, for the error beside the outcome: a result names a rollback error
  // exactly when a rollback's failure ended the task, and the error is that rollback's. An
  // attempt that failed with budget left, in a saga that something else then halted, is
  // not it, and no row invariant can say so, because the error is derived when it is read.
  for (const taskId of sagas.keys()) {
    const named = (await f.store.getTaskResult(Q, taskId))?.rollback?.errorJson
    if (named !== haltedBy.get(taskId)) {
      throw new Error(
        `fuzz seed ${seed} final: task ${taskId} names the rollback error ${named}, and the rollback that ended it failed with ${haltedBy.get(taskId)}`,
      )
    }
    if (named !== undefined) stats.haltsNamed++
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
    stats.cancels +
    stats.rollbacks +
    stats.sagasEnded
  if (steps >= 50 && progress === 0) {
    throw new Error(`fuzz seed ${seed}: zero progress across ${steps} steps`)
  }
  return stats
}
