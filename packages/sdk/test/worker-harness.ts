import type { Clock } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import type { TaskHandler, TaskRegistry } from '../src/index.js'

/** Instant clock: the pump parks on sleeps we never fire — fine for passes
 * that finish fast; the heartbeat test drives it manually. */
export class FakeClock implements Clock {
  now = 1_000_000
  fired: { deadline: number; resolve: () => void }[] = []
  nowEpochMs(): number {
    return this.now
  }
  elapsedMs(): number {
    return this.nowEpochMs()
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
      const entry = { deadline: this.now + ms, resolve }
      this.fired.push(entry)
      interrupt?.addEventListener(
        'abort',
        () => {
          this.fired = this.fired.filter((s) => s !== entry)
          resolve()
        },
        { once: true },
      )
    })
  }
  advance(ms: number): void {
    this.now += ms
    const due = this.fired.filter((s) => s.deadline <= this.now)
    this.fired = this.fired.filter((s) => s.deadline > this.now)
    for (const s of due) s.resolve()
  }
}

export async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.now += ms
    await admin.setFakeNowEpochMs(clock.now)
    clock.advance(0)
  }
  return { raw, admin, ids, store, clock, advance, close: () => raw.close() }
}

export function registry(entries: Record<string, TaskHandler>): TaskRegistry {
  return new Map(Object.entries(entries))
}
