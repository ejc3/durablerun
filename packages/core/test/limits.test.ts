import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/limits.js'

describe('mapLimit', () => {
  it('preserves input order while running at most width calls at once', async () => {
    let running = 0
    let peak = 0
    const results = await mapLimit([30, 10, 20, 0], 2, async (delayMs) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      running--
      return delayMs * 2
    })
    expect(results).toEqual([60, 20, 40, 0])
    expect(peak).toBe(2)
  })

  it('refuses a width that is not a positive safe integer and runs nothing', async () => {
    for (const width of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls: number[] = []
      const outcome = await mapLimit([1, 2, 3], width, async (item) => {
        calls.push(item)
        return item
      }).catch((error: unknown) => error)
      expect(outcome, `width ${width} must be refused`).toBeInstanceOf(RangeError)
      expect(calls, `width ${width} must run nothing`).toEqual([])
    }
  })

  it('stops taking items once one call rejects', async () => {
    const started: number[] = []
    let releaseSlow = () => {}
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const outcome = mapLimit([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item)
      if (item === 0) throw new Error('boom')
      if (item === 1) await slow
      return item
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSlow()
    await expect(outcome).rejects.toThrow('boom')
    expect(started).toEqual([0, 1])
  })

  it('settles every started call before it rejects', async () => {
    const finished: number[] = []
    const outcome = mapLimit([0, 1, 2, 3], 4, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 0 : 20))
      if (item === 0) throw new Error('boom')
      finished.push(item)
      return item
    })
    await expect(outcome).rejects.toThrow('boom')
    expect(finished).toEqual([1, 2, 3])
  })
})
