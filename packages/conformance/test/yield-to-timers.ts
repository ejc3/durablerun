import { afterEach } from 'vitest'

/**
 * Lets the event loop reach its timers phase after every test of the calling file.
 *
 * The libSQL client runs each statement as a blocking native call and resolves
 * with microtasks only, and vitest does not pass through the timers phase between
 * two tests that never yield. A run of libSQL tests is then one stretch in which
 * the worker's event loop does not turn. When that stretch reaches a minute,
 * vitest reports the worker's progress message as timed out and fails a run whose
 * tests all passed.
 */
export function yieldToTimersAfterEachTest(): void {
  afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}
