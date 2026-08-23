import type { Clock } from './clock.js'

const TrustedPromise = Promise
const nowEpochMs = Date.now
const nonNegative = Math.max
const scheduleImmediate = setImmediate
const scheduleTimeout = setTimeout
const cancelTimeout = clearTimeout
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
if (abortedGetter === undefined) throw new Error('AbortSignal.aborted is unavailable')
const signalAborted = abortedGetter.call.bind(abortedGetter) as (signal: AbortSignal) => boolean
const addAbortListener = EventTarget.prototype.addEventListener.call.bind(
  EventTarget.prototype.addEventListener,
) as (signal: AbortSignal, type: 'abort', listener: () => void) => void
const removeAbortListener = EventTarget.prototype.removeEventListener.call.bind(
  EventTarget.prototype.removeEventListener,
) as (signal: AbortSignal, type: 'abort', listener: () => void) => void

/** Production Clock: the ONE sanctioned home of ambient time and timers. */
export function systemClock(): Clock {
  return {
    nowEpochMs(): number {
      return nowEpochMs()
    },
    yieldTurn(): Promise<void> {
      return new TrustedPromise((resolve) => scheduleImmediate(resolve))
    },
    sleep(ms: number, interrupt?: AbortSignal): Promise<void> {
      return new TrustedPromise((resolve) => {
        if (interrupt !== undefined && signalAborted(interrupt)) {
          resolve()
          return
        }
        const timer = scheduleTimeout(done, nonNegative(0, ms))
        function done(): void {
          cancelTimeout(timer)
          if (interrupt !== undefined) removeAbortListener(interrupt, 'abort', done)
          resolve()
        }
        if (interrupt !== undefined) addAbortListener(interrupt, 'abort', done)
      })
    },
  }
}
