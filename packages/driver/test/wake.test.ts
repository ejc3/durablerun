import { describe, expect, it, vi } from 'vitest'
import { type WakeRequest, WakeSchedulingError, scheduleTickWake } from '../src/wake.js'

describe('host-owned tick wake scheduling', () => {
  for (const backlog of [false, true]) {
    for (const nextWakeAtEpochMs of [null, 0, 1_234_567]) {
      for (const fault of ['none', 'throw', 'reject'] as const) {
        it(`backlog=${backlog}, next=${nextWakeAtEpochMs}, publisher=${fault}`, async () => {
          const failure = new Error('publisher unavailable')
          const seen: WakeRequest[] = []
          const schedule = vi.fn((wake: WakeRequest) => {
            expect(Object.isFrozen(wake)).toBe(true)
            seen.push(wake)
            if (fault === 'throw') throw failure
            return fault === 'reject' ? Promise.reject(failure) : Promise.resolve()
          })
          const expected: WakeRequest | null = backlog
            ? { queue: 'one-queue', kind: 'immediate' }
            : nextWakeAtEpochMs === null
              ? null
              : { queue: 'one-queue', kind: 'scheduled', atEpochMs: nextWakeAtEpochMs }
          const result = scheduleTickWake(schedule, 'one-queue', { backlog, nextWakeAtEpochMs })
          if (expected !== null && fault !== 'none') {
            await expect(result).rejects.toMatchObject({
              message: 'wake scheduling unavailable',
              cause: failure,
            })
          } else {
            await expect(result).resolves.toBeUndefined()
          }
          expect(seen).toEqual(expected === null ? [] : [expected])
        })
      }
    }
  }

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    'refuses invalid database wake %s before publishing',
    async (nextWakeAtEpochMs) => {
      const schedule = vi.fn(async () => {})
      await expect(
        scheduleTickWake(schedule, 'q', { backlog: false, nextWakeAtEpochMs }),
      ).rejects.toThrow('next wake must be an integer epoch-ms')
      expect(schedule).not.toHaveBeenCalled()
    },
  )

  it('keeps each new hint, including an earlier time and a repeated already-fired time', async () => {
    const seen: WakeRequest[] = []
    const schedule = async (wake: WakeRequest) => {
      seen.push(wake)
    }
    for (const at of [200, 100, 100, 200]) {
      await scheduleTickWake(schedule, 'q', { backlog: false, nextWakeAtEpochMs: at })
    }
    expect(seen).toEqual(
      [200, 100, 100, 200].map((atEpochMs) => ({ queue: 'q', kind: 'scheduled', atEpochMs })),
    )
  })

  it('awaits publication so a queue receiver cannot acknowledge a pending rearm', async () => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let complete = false
    const result = scheduleTickWake(() => pending, 'q', {
      backlog: true,
      nextWakeAtEpochMs: null,
    }).then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    finish?.()
    await result
    expect(complete).toBe(true)
  })

  it('classifies synchronous publisher failure for the HTTP boundary', async () => {
    await expect(
      scheduleTickWake(
        () => {
          throw new Error('unavailable')
        },
        'q',
        {
          backlog: true,
          nextWakeAtEpochMs: null,
        },
      ),
    ).rejects.toBeInstanceOf(WakeSchedulingError)
  })
})
