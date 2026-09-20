import { type LaunchInvocation, LaunchOutcome, type Launcher } from '@durablerun/core'

/** What a caller hands a launcher beside the invocation. */
type FakeLaunchOptions = { signal?: AbortSignal }

export class FakeLauncher implements Launcher {
  invocations: LaunchInvocation[] = []
  constructor(
    private readonly script: (
      inv: LaunchInvocation,
      options?: FakeLaunchOptions,
    ) => Promise<LaunchOutcome> | LaunchOutcome = () => LaunchOutcome.accepted(),
  ) {}
  async launch(inv: LaunchInvocation, options?: FakeLaunchOptions): Promise<LaunchOutcome> {
    this.invocations.push(inv)
    return this.script(inv, options)
  }
}

/**
 * Whether cond came to hold before the deadline, polling with a real event-loop turn between
 * looks. The deadline is two seconds, or what a caller that waits on a real socket asks for.
 * For an assertion that says what it expected; `until` is the same wait for a step that must
 * be reached before the test can go on.
 */
export async function reached(
  cond: () => boolean | Promise<boolean>,
  deadlineMs = 2_000,
): Promise<boolean> {
  const deadline = performance.now() + deadlineMs
  while (!(await cond())) {
    if (performance.now() > deadline) return false
    await new Promise((r) => setImmediate(r))
  }
  return true
}

export async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 2_000,
): Promise<void> {
  if (!(await reached(cond, deadlineMs))) throw new Error(`timed out waiting for: ${what}`)
}
