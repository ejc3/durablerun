import { type Clock, type LaunchInvocation, LaunchOutcome, type Launcher } from '@durablerun/core'

/**
 * Hand-cranked clock: sleeps park until advance() moves time past their
 * deadline (or their interrupt fires). Tests keep it aligned with the
 * store's fake time so duration math behaves like production.
 */
export class FakeClock implements Clock {
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

export class FakeLauncher implements Launcher {
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

/** Poll (real timers — tests own their nondeterminism) until cond holds. */
export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for: ${what}`)
}
