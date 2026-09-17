import { describe, expect, it } from 'vitest'
import { yieldToTimersAfterEachTest } from './yield-to-timers.js'

yieldToTimersAfterEachTest()

// How late a 50 ms timer fires is how long the event loop went without reaching its
// timers phase. Three tests that each block for 600 ms show as one stall near 1800 ms
// when nothing yields between them, and as three near 600 ms when something does.
let longestStallMs = 0
let last = performance.now()
const monitor = setInterval(() => {
  const now = performance.now()
  longestStallMs = Math.max(longestStallMs, now - last - 50)
  last = now
}, 50)

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

describe('a run of tests that never yield', () => {
  for (const name of ['first', 'second', 'third']) {
    it(`${name} blocks for 600 ms`, () => {
      block(600)
    })
  }

  it('is not one stall', async () => {
    // Let the monitor's pending tick land before reading it.
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    clearInterval(monitor)
    // A monitor that never ticked reads 0, and would pass the bound below for nothing.
    expect(longestStallMs).toBeGreaterThan(400)
    expect(longestStallMs).toBeLessThan(1200)
  })
})
