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

/** Poll, yielding a real event-loop turn each time, until cond holds or two seconds pass. */
export async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}
