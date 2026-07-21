import type { LaunchInvocation, LaunchOutcome, Launcher } from '@durablerun/core'
import { engineInvariantViolations } from '@durablerun/conformance'
import { Rng, seededIdSource, SimWorld } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { tick, type TickOptions } from '../src/index.js'

const Q = 'q'
const OPTS: TickOptions = { queue: Q, claimLimit: 3, sweepLimit: 5, leaseSeconds: 60 }

async function fx(seed: string) {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  await admin.setFakeNowEpochMs(1_000_000)
  return { raw, admin, ids, store, close: () => raw.close() }
}

/** Records invocations; outcome per invocation is scripted (default: accepted). */
class FakeLauncher implements Launcher {
  invocations: LaunchInvocation[] = []
  constructor(
    private readonly script: (
      inv: LaunchInvocation,
    ) => Promise<LaunchOutcome> | LaunchOutcome = () => ({
      kind: 'accepted',
    }),
  ) {}
  async launch(inv: LaunchInvocation): Promise<LaunchOutcome> {
    this.invocations.push(inv)
    return this.script(inv)
  }
}

describe('tick()', () => {
  it('claims and launches due work with the exact §3.2 invocation payload', async () => {
    const f = await fx('tick-basic')
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const launcher = new FakeLauncher()
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)

    expect(result.claimed).toBe(1)
    expect(result.launched).toBe(1)
    expect(result.launchFailed).toBe(0)
    expect(result.swept).toEqual([])
    expect(result.backlog).toBe(false)
    const inv = launcher.invocations[0]
    expect(inv).toMatchObject({ queue: Q, attempt: 1, claimGen: 1 })
    expect(inv?.claimToken).toBeTruthy()
    expect(inv?.deadlineHintEpochMs).toBe(1_060_000) // now + lease
    // The launched (running) lease is the queue's next wake source.
    expect(result.nextWakeAtEpochMs).toBe(1_060_000)
    const [runRow] = await f.raw.batch('t', [
      {
        sql: `SELECT state, claimed_by FROM runs WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    expect(runRow?.rows[0]).toMatchObject({ state: 'running', claimed_by: inv?.claimToken })
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('an idle tick is all zeros: no claims, no launches, null next wake', async () => {
    const f = await fx('tick-idle')
    const launcher = new FakeLauncher()
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result).toMatchObject({
      claimed: 0,
      launched: 0,
      launchFailed: 0,
      ended: 0,
      swept: [],
      nextWakeAtEpochMs: null,
      backlog: false,
    })
    expect(launcher.invocations).toEqual([])
    f.close()
  })

  it('backlog signals a successor tick; the chain drains the queue', async () => {
    const f = await fx('tick-backlog')
    for (let i = 0; i < 5; i++) await f.store.spawn(Q, `job${i}`, '{}')
    const launcher = new FakeLauncher()
    const first = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(first.claimed).toBe(3) // K
    expect(first.backlog).toBe(true)
    const second = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(second.claimed).toBe(2)
    expect(second.backlog).toBe(false)
    expect(launcher.invocations).toHaveLength(5)
    // Two ticks, two distinct claim tokens.
    expect(new Set(launcher.invocations.map((i) => i.claimToken)).size).toBe(2)
    f.close()
  })

  it('launch-failed expires the lease advisorily: the NEXT tick reopens it without waiting out the lease', async () => {
    const f = await fx('tick-launch-failed')
    await f.store.spawn(Q, 'job', '{}')
    const failing = new FakeLauncher(() => ({
      kind: 'launch-failed',
      error: new Error('conn refused'),
    }))
    const first = await tick({ store: f.store, launcher: failing, ids: f.ids }, OPTS)
    expect(first).toMatchObject({ claimed: 1, launched: 0, launchFailed: 1 })

    // Same engine time — no lease wait: the sweep already sees it expired.
    const launcher = new FakeLauncher()
    const second = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(second.swept).toMatchObject([{ kind: 'lost-launch', relaunchCount: 1 }])
    // Reopened with linear backoff (1 * 5s): claimable only after it.
    expect(second.claimed).toBe(0)
    expect(second.nextWakeAtEpochMs).toBe(1_005_000)
    await f.admin.setFakeNowEpochMs(1_005_000)
    const third = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(third).toMatchObject({ claimed: 1, launched: 1 })
    // Same run, same attempt — a lost launch consumes NO attempt.
    expect(launcher.invocations[0]?.attempt).toBe(1)
    expect(launcher.invocations[0]?.claimGen).toBe(2)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a THROWING launcher is a lost launch, and does not poison sibling launches', async () => {
    const f = await fx('tick-throw')
    await f.store.spawn(Q, 'ok-job', '{}')
    await f.store.spawn(Q, 'bad-job', '{}')
    let calls = 0
    const launcher = new FakeLauncher(() => {
      calls++
      if (calls === 2) throw new Error('transport exploded')
      return { kind: 'accepted' }
    })
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result.claimed).toBe(2)
    expect(result.launched).toBe(1)
    expect(result.launchFailed).toBe(1)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('sync ended:completed is a no-op signal — the worker already transitioned', async () => {
    const f = await fx('tick-sync-complete')
    const spawned = await f.store.spawn(Q, 'job', '{}')
    // Bounded-slot resident mode: the "launcher" runs the worker inline.
    const launcher = new FakeLauncher(async (inv) => {
      const run = await f.store.activate(Q, inv.runId, inv.claimToken, inv.claimGen)
      if (!run) throw new Error('activation lost')
      await f.store.complete(Q, inv.runId, inv.claimToken, '{"ok":1}')
      return {
        kind: 'ended',
        ending: { runId: inv.runId, claimToken: inv.claimToken, kind: 'completed' },
      }
    })
    const first = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(first).toMatchObject({ claimed: 1, ended: 1, launched: 0 })
    const second = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(second.swept).toEqual([]) // nothing to sweep — clean completion
    expect((await f.store.getTaskResult(Q, spawned.taskId))?.state).toBe('completed')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('sync ended:crashed AFTER activation accelerates a $ClaimTimeout successor', async () => {
    const f = await fx('tick-sync-crash')
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const launcher = new FakeLauncher(async (inv) => {
      const run = await f.store.activate(Q, inv.runId, inv.claimToken, inv.claimGen)
      if (!run) throw new Error('activation lost')
      // Worker dies mid-run; resident launcher observed the process death.
      return {
        kind: 'ended',
        ending: { runId: inv.runId, claimToken: inv.claimToken, kind: 'crashed' },
      }
    })
    const first = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(first).toMatchObject({ claimed: 1, ended: 1 })

    // Same engine time: the advisory expiry lets the next sweep classify.
    const second = await tick({ store: f.store, launcher: new FakeLauncher(), ids: f.ids }, OPTS)
    expect(second.swept).toMatchObject([{ kind: 'claim-timeout' }])
    const [task] = await f.raw.batch('t', [
      {
        sql: `SELECT infra_retries, attempts FROM tasks WHERE task_id = ?`,
        args: [spawned.taskId],
      },
    ])
    // Died-mid-run moves infra_retries, never user attempts.
    expect(task?.rows[0]).toMatchObject({ infra_retries: 1, attempts: 0 })
    // Successor claimable after the 5s infra backoff, as attempt 2.
    await f.admin.setFakeNowEpochMs(1_005_000)
    const relaunch = new FakeLauncher()
    const third = await tick({ store: f.store, launcher: relaunch, ids: f.ids }, OPTS)
    expect(third).toMatchObject({ claimed: 1, launched: 1 })
    expect(relaunch.invocations[0]?.attempt).toBe(2)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a tick that dies between claim and launch is recovered as lost-launch by later ticks', async () => {
    const f = await fx('tick-crash-mid')
    await f.store.spawn(Q, 'job', '{}')
    // The dying tick: claim happened, launch never did (no advisory signal
    // either — pure crash). Simulated by claiming outside any tick.
    const claimed = await f.store.claim(Q, f.ids.token(), { leaseSeconds: 60, limit: 1 })
    expect(claimed).toHaveLength(1)

    // Before lease expiry nothing may be swept or double-claimed.
    const launcher = new FakeLauncher()
    const during = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(during).toMatchObject({ claimed: 0, swept: [] })

    // After expiry: reopened (no attempt burned), then relaunched.
    await f.admin.setFakeNowEpochMs(1_061_000)
    const after = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(after.swept).toMatchObject([{ kind: 'lost-launch', relaunchCount: 1 }])
    await f.admin.setFakeNowEpochMs(1_067_000) // past the 5s reopen backoff
    const relaunched = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(relaunched).toMatchObject({ claimed: 1, launched: 1 })
    expect(launcher.invocations[0]?.attempt).toBe(1) // same run, no attempt burned
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('cancellation deadlines enforce BEFORE claiming: a due-to-cancel task never launches', async () => {
    const f = await fx('tick-cancel-first')
    const spawned = await f.store.spawn(Q, 'job', '{}', {
      cancellation: { maxDelaySeconds: 30 },
    })
    await f.admin.setFakeNowEpochMs(1_031_000) // past the never-started deadline
    const launcher = new FakeLauncher()
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result.swept).toMatchObject([{ kind: 'cancelled', taskId: spawned.taskId }])
    expect(result.claimed).toBe(0)
    expect(launcher.invocations).toEqual([])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('concurrent duplicate ticks are harmless: the second claims nothing', async () => {
    const f = await fx('tick-dup')
    await f.store.spawn(Q, 'job', '{}')
    const launcher = new FakeLauncher()
    const a = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    const b = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(a.claimed).toBe(1)
    expect(b).toMatchObject({ claimed: 0, launched: 0, swept: [] })
    expect(launcher.invocations).toHaveLength(1)
    f.close()
  })

  it('sweep respects its budget and reports backlog', async () => {
    const f = await fx('tick-sweep-budget')
    // 7 expired leases > K_s = 5.
    for (let i = 0; i < 7; i++) await f.store.spawn(Q, `job${i}`, '{}')
    const token = f.ids.token()
    const claimed = await f.store.claim(Q, token, { leaseSeconds: 30, limit: 10 })
    expect(claimed).toHaveLength(7)
    await f.admin.setFakeNowEpochMs(1_031_000)
    const launcher = new FakeLauncher()
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result.swept).toHaveLength(5) // K_s
    expect(result.backlog).toBe(true)
    const drain = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(drain.swept).toHaveLength(2)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })
})

/**
 * Review regressions (red/green rule): each test failed against the tick()
 * as first committed; the finding it pins is named in the title.
 */
describe('tick() review regressions', () => {
  it('a lying ended:completed is reconciled by the lease fence, never trusted', async () => {
    const f = await fx('tick-lying-ending')
    await f.store.spawn(Q, 'job', '{}')
    // A resident pool that maps worker exit-code 0 to 'completed' — but the
    // worker died BEFORE its complete write landed. The report is wrong.
    const lying = new FakeLauncher(async (inv) => {
      const run = await f.store.activate(Q, inv.runId, inv.claimToken, inv.claimGen)
      if (!run) throw new Error('activation lost')
      return {
        kind: 'ended',
        ending: { runId: inv.runId, claimToken: inv.claimToken, kind: 'completed' },
      }
    })
    await tick({ store: f.store, launcher: lying, ids: f.ids }, OPTS)
    // Reconciliation is the fence: expire advisorily, let the sweep decide.
    // At UNCHANGED engine time the next tick must already recover the run —
    // never wait out the full lease on the report's say-so.
    const second = await tick({ store: f.store, launcher: new FakeLauncher(), ids: f.ids }, OPTS)
    expect(second.swept).toMatchObject([{ kind: 'claim-timeout' }])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('degenerate budgets are refused up front, not spun on', async () => {
    const f = await fx('tick-degenerate')
    const launcher = new FakeLauncher()
    // sweepLimit 0 used to return backlog:true on an IDLE queue — a
    // contract-compliant caller then chains successor ticks forever.
    await expect(
      tick({ store: f.store, launcher, ids: f.ids }, { ...OPTS, sweepLimit: 0 }),
    ).rejects.toThrow(RangeError)
    await expect(
      tick({ store: f.store, launcher, ids: f.ids }, { ...OPTS, claimLimit: 0 }),
    ).rejects.toThrow(RangeError)
    expect(launcher.invocations).toEqual([])
    f.close()
  })

  it("a failing advisory expiry does not destroy the tick's result", async () => {
    const f = await fx('tick-advisory-fail')
    await f.store.spawn(Q, 'a', '{}')
    await f.store.spawn(Q, 'b', '{}')
    // The advisory write hits a transient store error. Advisory means
    // best-effort: the lease timer still recovers the run — losing the
    // tick's counts, nextWake, and backlog over it is an escalation.
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'expireLeaseNow') {
          return () => Promise.reject(new Error('transient store error'))
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const launcher = new FakeLauncher(() => ({ kind: 'launch-failed', error: new Error('no') }))
    const result = await tick({ store: flaky, launcher, ids: f.ids }, OPTS)
    expect(result.launchFailed).toBe(2)
    expect(result.nextWakeAtEpochMs).not.toBeNull()
    f.close()
  })
})

/**
 * Codex review regressions (red/green rule): each test failed against the
 * tick()/store as of the green commit for the first review round.
 */
describe('tick() codex review regressions', () => {
  it('a duplicated claim batch (lost response, retried) never claims past the limit', async () => {
    const f = await fx('tick-dup-claim')
    for (let i = 0; i < 6; i++) await f.store.spawn(Q, `job${i}`, '{}')
    const world = new SimWorld(f.raw, 'dup-claim-seed')
    // The transport loses the claim response and retries the SAME batch —
    // the legal retry-after-lost-response fault every transition must absorb.
    world.injectDuplicate({ label: 'claim' })
    const launcher = new FakeLauncher()
    let result: Awaited<ReturnType<typeof tick>> | undefined
    world.actor('driver', async (simDb) => {
      const store = new LibsqlSchedulerStore(simDb, f.ids)
      result = await tick({ store, launcher, ids: f.ids }, OPTS)
    })
    await world.run()
    // The retry must be an idempotent receipt for the ORIGINAL selection,
    // never a second helping: at most K runs claimed and launched.
    expect(result?.claimed).toBeLessThanOrEqual(3)
    expect(launcher.invocations.length).toBeLessThanOrEqual(3)
    const [running] = await f.raw.batch('t', [
      { sql: `SELECT COUNT(*) AS n FROM runs WHERE state = 'running'`, args: [] },
    ])
    expect(Number(running?.rows[0]?.n)).toBe(3)
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a task past its cancellation deadline is never claimed, even beyond the sweep budget', async () => {
    const f = await fx('tick-cancel-overflow')
    // Six tasks past max_delay with sweepLimit 5: the sixth cannot be
    // swept THIS pass — but claiming it would launch a worker for a task
    // the same pass should have cancelled.
    for (let i = 0; i < 6; i++) {
      await f.store.spawn(Q, `job${i}`, '{}', { cancellation: { maxDelaySeconds: 10 } })
    }
    await f.admin.setFakeNowEpochMs(1_011_000)
    const launcher = new FakeLauncher()
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result.swept).toHaveLength(5)
    expect(result.claimed).toBe(0)
    expect(launcher.invocations).toEqual([])
    expect(result.backlog).toBe(true) // the sixth cancel is next pass's work
    const drain = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(drain.swept).toMatchObject([{ kind: 'cancelled' }])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('an ending whose runId does not match the launched run is ignored', async () => {
    const f = await fx('tick-foreign-ending')
    await f.store.spawn(Q, 'job', '{}')
    // A confused resident pool reports an ending for a DIFFERENT run.
    const confused = new FakeLauncher(async (inv) => {
      const run = await f.store.activate(Q, inv.runId, inv.claimToken, inv.claimGen)
      if (!run) throw new Error('activation lost')
      return {
        kind: 'ended',
        ending: { runId: 'some-other-run', kind: 'crashed' },
      }
    })
    await tick({ store: f.store, launcher: confused, ids: f.ids }, OPTS)
    // A signal about a different run says nothing about THIS run's lease:
    // no advisory expiry, so nothing is sweepable at unchanged time.
    const second = await tick({ store: f.store, launcher: new FakeLauncher(), ids: f.ids }, OPTS)
    expect(second.swept).toEqual([])
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })

  it('a malformed launcher outcome is a failed launch, not a tick crash', async () => {
    const f = await fx('tick-malformed')
    await f.store.spawn(Q, 'a', '{}')
    await f.store.spawn(Q, 'b', '{}')
    let calls = 0
    // A JS launcher (no type checking) returns garbage for one run.
    const launcher = new FakeLauncher(() => {
      calls++
      if (calls === 1) return undefined as never
      return { kind: 'accepted' }
    })
    const result = await tick({ store: f.store, launcher, ids: f.ids }, OPTS)
    expect(result.claimed).toBe(2)
    expect(result.launched).toBe(1)
    expect(result.launchFailed).toBe(1)
    expect(result.nextWakeAtEpochMs).not.toBeNull()
    f.close()
  })
})
