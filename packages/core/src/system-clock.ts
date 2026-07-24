import type { Clock } from './clock.js'

/** Production Clock: the ONE sanctioned home of ambient time and timers. */
export function systemClock(): Clock {
  return {
    nowEpochMs(): number {
      return Date.now()
    },
    yieldTurn(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve))
    },
    sleep(ms: number, interrupt?: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        if (interrupt?.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(done, Math.max(0, ms))
        function done(): void {
          clearTimeout(timer)
          interrupt?.removeEventListener('abort', done)
          resolve()
        }
        interrupt?.addEventListener('abort', done, { once: true })
      })
    },
  }
}
