import { type Clock, type LaunchInvocation, LaunchOutcome, type Launcher } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
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
  sleep(ms: number, interrupt?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (interrupt?.aborted) {
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
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
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
