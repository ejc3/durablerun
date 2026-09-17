import type { Clock } from '@durablerun/core'

/**
 * A hand-cranked Clock for tests. Wall time and elapsed time move only when a test
 * advances them, and a pending sleep resolves on `fire()` once elapsed time reaches
 * its deadline, the way a real timer measures elapsed time. A host clock step is
 * `clock.now += ms`, which moves wall time and leaves every pending sleep alone.
 */
export class FakeClock implements Clock {
  now = 1_000_000
  elapsed = 0
  sleeps: { deadline: number; ms: number; resolve: () => void }[] = []

  nowEpochMs(): number {
    return this.now
  }

  elapsedMs(): number {
    return this.elapsed
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
      const onAbort = () => {
        this.sleeps = this.sleeps.filter((sleep) => sleep !== entry)
        resolve()
      }
      const entry = {
        deadline: this.elapsed + ms,
        ms,
        resolve: () => {
          interrupt?.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      this.sleeps.push(entry)
      interrupt?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Advance wall and elapsed time together, without resolving any sleep. */
  advance(ms: number): void {
    this.now += ms
    this.elapsed += ms
  }

  /** Resolve every sleep whose deadline elapsed time has reached. */
  fire(): void {
    const due = this.sleeps.filter((sleep) => sleep.deadline <= this.elapsed)
    this.sleeps = this.sleeps.filter((sleep) => sleep.deadline > this.elapsed)
    for (const sleep of due) sleep.resolve()
  }
}
