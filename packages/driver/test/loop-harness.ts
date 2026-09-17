import { type LaunchInvocation, LaunchOutcome, type Launcher } from '@durablerun/core'

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
