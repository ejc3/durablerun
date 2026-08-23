import { type Clock, type LaunchInvocation, LaunchOutcome, type Launcher } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { DriverLoop } from '../src/index.js'

const Q = 'q'

/**
 * Hand-cranked clock: sleeps park until advance() moves time past their
 * deadline (or their interrupt fires). Tests keep it aligned with the
 * store's fake time so duration math behaves like production.
 */
class FakeClock implements Clock {
  now = 1_000_000
  sleeps: { deadline: number; ms: number; resolve: () => void }[] = []
  nowEpochMs(): number {
    return this.now
  }
  yieldTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }
  sleep(ms: number, interrupt?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (interrupt?.aborted || ms <= 0) {
        resolve()
        return
      }
      const entry = { deadline: this.now + ms, ms, resolve }
      this.sleeps.push(entry)
      interrupt?.addEventListener(
        'abort',
        () => {
          this.sleeps = this.sleeps.filter((s) => s !== entry)
          resolve()
        },
        { once: true },
      )
    })
  }
  fire(): void {
    const due = this.sleeps.filter((s) => s.deadline <= this.now)
    this.sleeps = this.sleeps.filter((s) => s.deadline > this.now)
    for (const s of due) s.resolve()
  }
}

class FakeLauncher implements Launcher {
  invocations: LaunchInvocation[] = []
  constructor(
    private readonly script: (
      inv: LaunchInvocation,
    ) => Promise<LaunchOutcome> | LaunchOutcome = () => LaunchOutcome.accepted(),
  ) {}
  async launch(inv: LaunchInvocation): Promise<LaunchOutcome> {
    this.invocations.push(inv)
    return this.script(inv)
  }
}

async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.now += ms
    await admin.setFakeNowEpochMs(clock.now)
    clock.fire()
  }
  return { raw, admin, ids, store, clock, advance, close: () => raw.close() }
}

/** Poll (real timers — tests own their nondeterminism) until cond holds. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

const OPTS = { queue: Q, claimLimit: 3, sweepLimit: 5, leaseSeconds: 60 }

describe('DriverLoop', () => {
  it('drains due work, then parks until the next wake', async () => {
    const f = await fx('loop-basic')
    await f.store.spawn(Q, 'a', '{}')
    await f.store.spawn(Q, 'b', '{}')
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => launcher.invocations.length === 2, 'both launches')
    await until(() => f.clock.sleeps.length === 1, 'loop parked')
    // Two running leases expire at now+60s: the park is bounded by the
    // busy ceiling, never past the wake.
    expect(f.clock.sleeps[0]?.ms).toBeLessThanOrEqual(60_000)
    await loop.stop()
    await done
    f.close()
  })

  it('wake() interrupts the park and the next pass claims fresh work', async () => {
    const f = await fx('loop-wake')
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => f.clock.sleeps.length === 1, 'idle park')
    await f.store.spawn(Q, 'job', '{}')
    loop.wake()
    await until(() => launcher.invocations.length === 1, 'launch after wake')
    await loop.stop()
    await done
    f.close()
  })

  it('a backlog chains ticks without sleeping', async () => {
    const f = await fx('loop-backlog')
    for (let i = 0; i < 7; i++) await f.store.spawn(Q, `job${i}`, '{}')
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    // All 7 launch without the clock ever advancing: the drain is the chain.
    await until(() => launcher.invocations.length === 7, 'full drain')
    expect(f.clock.now).toBe(1_000_000)
    await loop.stop()
    await done
    f.close()
  })

  it('stop() during a park resolves run() immediately and is idempotent', async () => {
    const f = await fx('loop-stop')
    const loop = new DriverLoop(
      { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock },
      OPTS,
    )
    const done = loop.run()
    await until(() => f.clock.sleeps.length === 1, 'parked')
    await loop.stop()
    await loop.stop()
    await done
    expect(f.clock.sleeps).toEqual([])
    f.close()
  })

  it('a hanging launcher is abandoned by the watchdog and the run recovers', async () => {
    const f = await fx('loop-hang')
    await f.store.spawn(Q, 'job', '{}')
    let hangs = 0
    const launcher = new FakeLauncher(() => {
      hangs++
      if (hangs === 1) return new Promise<LaunchOutcome>(() => {}) // never settles
      return LaunchOutcome.accepted()
    })
    const loop = new DriverLoop(
      { store: f.store, launcher, ids: f.ids, clock: f.clock },
      { ...OPTS, launchTimeoutSeconds: 5 },
    )
    const done = loop.run()
    await until(() => hangs === 1, 'first launch hanging')
    // The tick is stuck awaiting the transport until the watchdog deadline.
    await f.advance(5_000)
    await until(() => loop.stats.launchFailed === 1, 'timeout counted')
    // The abandoned run's lease was advisorily expired: the loop reopens and
    // relaunches it through the normal lost-launch path (5s reopen backoff).
    await f.advance(5_000)
    await until(() => hangs === 2, 'relaunch after recovery')
    await loop.stop()
    await done
    expect(
      await (await import('@durablerun/conformance')).engineInvariantViolations(f.raw),
    ).toEqual([])
    f.close()
  })

  it('beats the registry row on its cadence', async () => {
    const f = await fx('loop-registry')
    const loop = new DriverLoop(
      { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock },
      { ...OPTS, registryIntervalSeconds: 10, driverId: 'driver-1' },
    )
    const done = loop.run()
    await until(() => f.clock.sleeps.length === 1, 'first pass done')
    const beat = async () =>
      (
        await f.raw.batch('t', [
          {
            sql: `SELECT last_beat_ms, expires_at_ms FROM drivers WHERE driver_id = 'driver-1'`,
            args: [],
          },
        ])
      )[0]?.rows[0]
    const first = await beat()
    expect(Number(first?.last_beat_ms)).toBe(1_000_000)
    expect(Number(first?.expires_at_ms)).toBe(1_020_000) // ttl = 2x cadence
    await f.advance(11_000)
    await until(() => f.clock.sleeps.length >= 1, 'parked again')
    const second = await beat()
    expect(Number(second?.last_beat_ms)).toBeGreaterThan(1_000_000)
    await loop.stop()
    await done
    f.close()
  })

  it('a store outage is counted and backed off, never a crash or hot loop', async () => {
    const f = await fx('loop-outage')
    let failures = 0
    const flaky = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'sweep' && failures < 2) {
          return () => {
            failures++
            return Promise.reject(new Error('db unreachable'))
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    await f.store.spawn(Q, 'job', '{}')
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: flaky, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => loop.stats.tickErrors === 1, 'first failure counted')
    // Backed off to a park, not hot-looping on the error.
    await until(() => f.clock.sleeps.length === 1, 'backoff park')
    await f.advance(5_000)
    await until(() => loop.stats.tickErrors === 2, 'second failure')
    await f.advance(5_000)
    await until(() => launcher.invocations.length === 1, 'recovered and launched')
    await loop.stop()
    await done
    f.close()
  })
})

/**
 * Review regressions (red/green rule): each test failed against the loop
 * as first committed; the finding it pins is named in the title.
 */
describe('DriverLoop review regressions', () => {
  it('honest launches are COUNTED as launches — the watchdog never beats a settled launch', async () => {
    const f = await fx('loop-honest-counters')
    await f.store.spawn(Q, 'a', '{}')
    await f.store.spawn(Q, 'b', '{}')
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => launcher.invocations.length === 2, 'both launches')
    await until(() => f.clock.sleeps.length === 1, 'parked')
    // The whole point: the loop's own view of the honest path. A watchdog
    // that wins a microtask race against a SETTLED launch shows up here as
    // launched 0 / launchFailed 2 — and then every task in a real fleet
    // dies at the relaunch cap.
    expect(loop.stats.launched).toBe(2)
    expect(loop.stats.launchFailed).toBe(0)
    await loop.stop()
    await done
    f.close()
  })

  it('run() is one-shot: restarting a stopped loop throws instead of resurrecting it', async () => {
    const f = await fx('loop-oneshot')
    const loop = new DriverLoop(
      { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock },
      OPTS,
    )
    const done = loop.run()
    await until(() => f.clock.sleeps.length === 1, 'parked')
    void loop.stop() // deliberately NOT awaited — the revival window
    await expect(loop.run()).rejects.toThrow()
    await done
    f.close()
  })

  it('degenerate knobs are refused at construction', async () => {
    const f = await fx('loop-knobs')
    const deps = { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock }
    // Past the timer-API ceiling: the park would fire immediately — a hot
    // loop exactly where the loop exists to prevent one.
    expect(() => new DriverLoop(deps, { ...OPTS, idleCeilingMs: 1e12 })).toThrow(RangeError)
    // Inverted ceilings poll FASTER when idle.
    expect(
      () => new DriverLoop(deps, { ...OPTS, busyCeilingMs: 5000, idleCeilingMs: 250 }),
    ).toThrow(RangeError)
    // An empty driver id becomes a '' primary-key row.
    expect(() => new DriverLoop(deps, { ...OPTS, driverId: '' })).toThrow(RangeError)
    // A registry interval whose doubled TTL fails downstream validation
    // must fail HERE, not silently on every beat.
    expect(() => new DriverLoop(deps, { ...OPTS, registryIntervalSeconds: 2_000_000_000 })).toThrow(
      RangeError,
    )
    f.close()
  })

  it('a bounded-slot sync launcher can run without a watchdog', async () => {
    const f = await fx('loop-sync-no-watchdog')
    await f.store.spawn(Q, 'job', '{}')
    // Inline execution longer than the default watchdog: with the watchdog
    // disabled (null), the ending must be honored, never abandoned.
    const launcher = new FakeLauncher(async (inv) => {
      const run = await f.store.activate(Q, inv.runId, inv.claimToken, inv.claimGen)
      if (!run) throw new Error('activation lost')
      await f.clock.sleep(30_000)
      await f.store.complete(Q, inv.runId, inv.claimToken, '{"ok":1}')
      return LaunchOutcome.ended({
        runId: inv.runId,
        claimToken: inv.claimToken,
        kind: 'completed',
      })
    })
    const loop = new DriverLoop(
      { store: f.store, launcher, ids: f.ids, clock: f.clock },
      { ...OPTS, launchTimeoutSeconds: null },
    )
    const done = loop.run()
    await until(() => launcher.invocations.length === 1, 'inline run started')
    await f.advance(30_000)
    await until(() => loop.stats.ended === 1, 'inline ending honored')
    expect(loop.stats.launchFailed).toBe(0)
    await loop.stop()
    await done
    f.close()
  })

  it('expired registry rows are cleaned up by later beats', async () => {
    const f = await fx('loop-registry-gc')
    await f.store.driverHeartbeat(Q, 'dead-driver', 10)
    await f.advance(11_000)
    await f.store.driverHeartbeat(Q, 'live-driver', 10)
    const [rows] = await f.raw.batch('t', [
      { sql: `SELECT driver_id FROM drivers ORDER BY driver_id`, args: [] },
    ])
    // The dead driver's row expired before the live beat: gone. Unbounded
    // default growth (a fresh id per process restart) is a bounds bug.
    expect(rows?.rows.map((r) => r.driver_id)).toEqual(['live-driver'])
    f.close()
  })

  it('a database created before the drivers table exists still gets it (migrations are append-only)', async () => {
    const { MIGRATIONS } = await import('@durablerun/store-libsql')
    // The table must arrive in its OWN migration: editing an already-applied
    // migration means existing databases silently never get the change (the
    // runner skips applied versions) and the heartbeat's best-effort catch
    // hides the failure forever.
    const v1 = MIGRATIONS.find((m) => m.version === 1)
    expect(v1?.statements.join('\n')).not.toContain('drivers')
    expect(
      MIGRATIONS.some((m) => m.version > 1 && m.statements.join('\n').includes('drivers')),
    ).toBe(true)
  })
})

describe('DriverLoop coverage: lifecycle edges', () => {
  it('wake() during an in-flight tick still causes an immediate next look', async () => {
    const f = await fx('loop-wake-during-tick')
    await f.store.spawn(Q, 'first', '{}')
    const gate = { open: null as (() => void) | null }
    const launcher = new FakeLauncher(async () => {
      // Hold the tick open mid-launch; wake() arrives NOW, not during a park.
      await new Promise<void>((r) => {
        gate.open = r
      })
      return LaunchOutcome.accepted()
    })
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => gate.open !== null, 'tick held open')
    await f.store.spawn(Q, 'second', '{}')
    loop.wake() // no sleep to interrupt — must still mean "look again"
    gate.open?.()
    await until(() => launcher.invocations.length === 2, 'second claimed without a park')
    gate.open?.() // release the second held launch so stop() can finish
    await loop.stop()
    await done
    f.close()
  })

  it('stop() during an in-flight tick waits for the tick to finish', async () => {
    const f = await fx('loop-stop-during-tick')
    await f.store.spawn(Q, 'job', '{}')
    const gate = { open: null as (() => void) | null }
    const launcher = new FakeLauncher(async () => {
      await new Promise<void>((r) => {
        gate.open = r
      })
      return LaunchOutcome.accepted()
    })
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    await until(() => gate.open !== null, 'tick held open')
    let stopped = false
    const stopping = loop.stop().then(() => {
      stopped = true
    })
    await new Promise((r) => setTimeout(r, 25))
    expect(stopped).toBe(false) // the in-flight tick is honored
    gate.open?.()
    await stopping
    await done
    expect(loop.stats.launched).toBe(1)
    f.close()
  })
})

/**
 * Second review round (codex): new findings, each red before its fix.
 */
describe('DriverLoop codex review regressions', () => {
  it('inherited tick knobs are validated at construction, not per-tick into a swallowed catch', async () => {
    const f = await fx('loop-tick-knobs')
    const deps = { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock }
    // claimLimit 0 used to pass construction; every tick then threw into
    // the outage catch — a live process that heartbeats and drives nothing.
    expect(() => new DriverLoop(deps, { ...OPTS, claimLimit: 0 })).toThrow(RangeError)
    expect(() => new DriverLoop(deps, { ...OPTS, sweepLimit: 0 })).toThrow(RangeError)
    expect(() => new DriverLoop(deps, { ...OPTS, leaseSeconds: 0 })).toThrow(RangeError)
    f.close()
  })

  it('a host clock ahead of database time polls at the ceiling, never a zero-sleep hot loop', async () => {
    const f = await fx('loop-skew')
    // Host clock five minutes AHEAD of database time.
    f.clock.now = 1_300_000
    // Work due one minute into the DATABASE's future: not claimable yet,
    // but 'overdue' by the skewed host clock.
    await f.store.spawn(Q, 'later', '{}', { startDelaySeconds: 60 })
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: f.store, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    try {
      // The loop must PARK (ceiling-bounded poll) — before the fix it spun
      // tick-after-tick with zero sleep until database time caught up.
      await until(() => f.clock.sleeps.length === 1, 'parked despite skew')
      expect(loop.stats.ticks).toBeLessThan(20)
    } finally {
      await loop.stop()
      await done
      f.close()
    }
  })

  it('a hanging registry heartbeat blocks neither driving nor shutdown', async () => {
    const f = await fx('loop-hanging-beat')
    await f.store.spawn(Q, 'job', '{}')
    const gate = { release: () => {} }
    const hanging = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'driverHeartbeat') {
          return () =>
            new Promise<void>((resolve) => {
              gate.release = resolve // hangs until the test releases it
            })
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const launcher = new FakeLauncher()
    const loop = new DriverLoop({ store: hanging, launcher, ids: f.ids, clock: f.clock }, OPTS)
    const done = loop.run()
    try {
      // Driving must proceed past the stuck observability write...
      await until(() => launcher.invocations.length === 1, 'launch despite hanging beat')
      // ...and shutdown must not wait for it either.
      await loop.stop()
      await done
    } finally {
      gate.release() // unwedge a pre-fix loop so the runner can exit
      await loop.stop().catch(() => {})
      f.close()
    }
  })

  it('an idle park never sleeps through the registry heartbeat deadline', async () => {
    const f = await fx('loop-beat-deadline')
    const loop = new DriverLoop(
      { store: f.store, launcher: new FakeLauncher(), ids: f.ids, clock: f.clock },
      { ...OPTS, registryIntervalSeconds: 1, idleAfterTicks: 1, idleCeilingMs: 5000 },
    )
    const done = loop.run()
    await until(() => f.clock.sleeps.length === 1, 'parked')
    // ttl = 2s; a 5s park would let every driver read as dead while idle.
    expect(f.clock.sleeps[0]?.ms).toBeLessThanOrEqual(1_000)
    await loop.stop()
    await done
    f.close()
  })

  it('a long backlog chain yields to the event loop instead of starving it', async () => {
    const clock = new FakeClock()
    let claimSeq = 0
    const CHAIN = 10_000
    // A compliant but INSTANT store: every promise already resolved. The
    // backlog chain then runs as pure microtasks — without a periodic
    // yield, timers (including the one calling stop()) fire only after the
    // WHOLE chain ends.
    const instant = {
      sweep: () => Promise.resolve([]),
      claim: (_q: string, token: string, opts: { limit: number }) =>
        Promise.resolve(
          claimSeq >= CHAIN
            ? []
            : Array.from({ length: opts.limit }, () => ({
                runId: `r${claimSeq++}`,
                taskId: 't',
                attempt: 1,
                claimGen: 1,
                claimToken: token,
                claimExpiresAtEpochMs: clock.now + 60_000,
              })),
        ),
      expireLeaseNow: () => Promise.resolve(false),
      nextWakeAtEpochMs: () => Promise.resolve(null),
      driverHeartbeat: () => Promise.resolve(),
    } as unknown as import('@durablerun/core').SchedulerStore
    const ids = seededIdSource(new Rng('starve'))
    const loop = new DriverLoop({ store: instant, launcher: new FakeLauncher(), ids, clock }, OPTS)
    const done = loop.run()
    // A macrotask arriving early in the chain: with periodic yields it
    // interleaves near where it was scheduled; starved, it runs only after
    // the entire chain (ticksAtStop == the whole chain).
    const ticksAtStop = await new Promise<number>((resolve) => {
      setTimeout(() => {
        const at = loop.stats.ticks
        void loop.stop().then(() => resolve(at))
      }, 5)
    })
    await done
    expect(ticksAtStop).toBeLessThan(1_000) // pre-fix: the whole ~3.3k chain
  })
})
