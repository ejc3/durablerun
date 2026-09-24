import { PermanentStoreError, type SchedulerStore } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type TaskContext, runClaimedRun } from '../src/index.js'
import { Q, fx, registry } from './worker-harness.js'

/**
 * A permanent answer of the store is not an error a retry can change, so no pass ends because
 * one reached the task: what the task does with it is what it did before the order of results
 * was recorded. This file uses nothing of the order, so it runs unchanged on a build without it,
 * and the two builds must agree on every store call.
 */
const PROGRAMS: Record<string, (ctx: TaskContext) => Promise<unknown>> = {
  'catches each step and answers a fallback': async (ctx) => {
    const out: string[] = []
    for (const name of ['a', 'b', 'c']) {
      try {
        out.push(await ctx.step(name, () => name.toUpperCase()))
      } catch {
        out.push(`fallback-${name}`)
      }
    }
    return out
  },
  'catches an awaited event and a spawn': async (ctx) => {
    await ctx.emitEvent('e', '"E"')
    const out: string[] = []
    try {
      out.push(await ctx.awaitEvent('e'))
    } catch {
      out.push('fallback-event')
    }
    try {
      out.push((await ctx.spawn('kid', null)).queue)
    } catch {
      out.push('fallback-spawn')
    }
    return out
  },
  'catches beside another flow': async (ctx) => {
    const out = await Promise.all(
      ['a', 'b'].map(async (name) => {
        try {
          return await ctx.step(name, () => name.toUpperCase())
        } catch {
          return `fallback-${name}`
        }
      }),
    )
    return out
  },
}

async function run(program: string, failAt: number) {
  const f = await fx(`permanent-${program}-${failAt}`)
  try {
    let calls = 0
    const store = new Proxy(f.store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function' || prop === 'constructor') return value
        return (...args: unknown[]) => {
          calls++
          if (
            calls === failAt &&
            ['setCheckpoint', 'awaitEvent', 'spawn', 'emitEvent'].includes(String(prop))
          ) {
            return Promise.reject(new PermanentStoreError('injected permanent answer'))
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as SchedulerStore
    const fn = PROGRAMS[program]
    if (fn === undefined) throw new Error('no such program')
    const reg = registry({ job: fn, kid: async () => 1 })
    const spawned = await f.store.spawn(Q, 'job', '{}')
    const outcomes: string[] = []
    for (let round = 0; round < 8; round++) {
      const done = await f.store.getTaskResult(Q, spawned.taskId)
      if (done && !['pending', 'running', 'sleeping'].includes(done.state)) break
      const [claimed] = await f.store.claim(Q, `w${round}`, { leaseSeconds: 60, limit: 1 })
      if (claimed === undefined) {
        await f.advance(70_000)
        await f.store.sweep(Q, 10)
        continue
      }
      const outcome = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        {
          queue: Q,
          runId: claimed.runId,
          claimToken: claimed.claimToken,
          claimGen: claimed.claimGen,
        },
      )
      outcomes.push(outcome.kind)
    }
    const result = await f.store.getTaskResult(Q, spawned.taskId)
    return { calls, outcomes, state: result?.state, value: result?.completedPayloadJson }
  } finally {
    await f.close()
  }
}

describe('a permanent answer of the store, met by a task that catches it', () => {
  for (const program of Object.keys(PROGRAMS)) {
    it(`${program}: at every store call the task ends, in the passes it takes on a build without the order`, async () => {
      const reference = await run(program, 0)
      expect(reference.state).toBe('completed')
      const table: Record<number, unknown> = {}
      for (let call = 1; call <= reference.calls; call++) {
        const faulted = await run(program, call)
        table[call] = {
          state: faulted.state,
          outcomes: faulted.outcomes.join(','),
          value: faulted.value,
        }
      }
      if (process.env.PERMANENT_TABLE) console.log('PERMANENT', program, JSON.stringify(table))
      for (const [call, row] of Object.entries(table)) {
        expect(
          (row as { state: string }).state,
          `${program}: permanent answer at call ${call}`,
        ).toBe('completed')
      }
    }, 120_000)
  }
})
