import type { ClaimedRun, LeaseState, SchedulerStore } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type WorkerOutcome, runClaimedRun } from '../src/index.js'
import { fx, registry } from './worker-harness.js'

const Q = 'q'

/**
 * A worker can run against a store built from another commit, so every field of
 * the answers it reads is classified here, and `satisfies` makes a new field a type
 * error until it is. A required field is one the worker reads to run the task. An
 * optional field may be absent. An unread field is one this worker never reads.
 */
const CLAIMED_RUN_FIELD_ROLES = {
  runId: 'required',
  claimToken: 'required',
  taskId: 'required',
  taskName: 'required',
  attempt: 'required',
  infraRetries: 'required',
  claimGen: 'required',
  claimExpiresAtEpochMs: 'unread',
  leaseSeconds: 'required',
  paramsJson: 'required',
  retryStrategy: 'required',
  maxAttempts: 'required',
  headers: 'unread',
  wake: 'optional',
} as const satisfies Record<keyof ClaimedRun, 'required' | 'optional' | 'unread'>

type LeaseStateField =
  | keyof Extract<LeaseState, { held: true }>
  | keyof Extract<LeaseState, { held: false }>

const LEASE_STATE_FIELD_ROLES = {
  held: 'required',
  remainingMs: 'unread',
  reason: 'optional',
} as const satisfies Record<LeaseStateField, 'required' | 'optional' | 'unread'>

type Answer = Record<string, unknown>

interface Observation {
  variant: string
  outcome: WorkerOutcome['kind'] | `threw ${string}`
  handlerRan: boolean
}

/** Run one task with the store's activate and heartbeat answers rewritten. */
async function observe(
  variant: string,
  changeRun: (answer: Answer) => Answer,
  changeLease: ((answer: Answer) => Answer) | null,
): Promise<Observation> {
  const f = await fx(`store-answer-${variant}`)
  try {
    await f.store.spawn(Q, 'job', '{}')
    const other = new Proxy(f.store, {
      get(target, prop, receiver) {
        if (prop === 'activate') {
          return async (...args: Parameters<SchedulerStore['activate']>) => {
            const run = await target.activate(...args)
            return run === null ? null : (changeRun({ ...run }) as unknown as ClaimedRun)
          }
        }
        if (prop === 'heartbeat' && changeLease !== null) {
          return async (...args: Parameters<SchedulerStore['heartbeat']>) =>
            changeLease({ ...(await target.heartbeat(...args)) }) as unknown as LeaseState
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    let handlerRan = false
    const reg = registry({
      job: async (ctx) => {
        handlerRan = true
        if (changeLease !== null) {
          // Let the heartbeat pump beat once before the next context call.
          await f.advance(30_000)
          await f.clock.yieldTurn()
          await f.clock.yieldTurn()
        }
        await ctx.step('after', () => 1)
        return 'done'
      },
    })
    const [claimed] = await f.store.claim(Q, 'w1', { leaseSeconds: 60, limit: 1 })
    if (claimed === undefined) throw new Error('expected a claimable run')
    try {
      const outcome = await runClaimedRun(
        { store: other as SchedulerStore, clock: f.clock, registry: reg },
        {
          queue: Q,
          runId: claimed.runId,
          claimToken: claimed.claimToken,
          claimGen: claimed.claimGen,
        },
      )
      return { variant, outcome: outcome.kind, handlerRan }
    } catch (error) {
      // A worker that throws on an answer is a finding, recorded per variant.
      return { variant, outcome: `threw ${(error as Error).name}`, handlerRan }
    }
  } finally {
    f.close()
  }
}

describe('store answers across store and worker versions', () => {
  it('a worker runs every activate answer that carries its required fields, and refuses one that does not', async () => {
    const observed: Observation[] = []
    const expected: Observation[] = []
    const cases: { variant: string; change: (answer: Answer) => Answer; runs: boolean }[] = [
      { variant: 'the current store', change: (answer) => answer, runs: true },
      {
        variant: 'a newer store that adds a field',
        change: (answer) => ({ ...answer, laterField: { nested: true } }),
        runs: true,
      },
      ...Object.entries(CLAIMED_RUN_FIELD_ROLES).map(([field, role]) => ({
        variant: `an older store without ${field}`,
        change: ({ [field]: _omitted, ...rest }: Answer) => rest,
        runs: role !== 'required',
      })),
    ]
    for (const { variant, change, runs } of cases) {
      observed.push(await observe(variant, change, null))
      expected.push(
        runs
          ? { variant, outcome: 'completed', handlerRan: true }
          : { variant, outcome: 'aborted', handlerRan: false },
      )
    }
    expect(observed).toEqual(expected)
  })

  it('a worker keeps running on every held heartbeat answer and stops on every refusal', async () => {
    const observed: Observation[] = []
    const expected: Observation[] = []
    const cases: { variant: string; change: (answer: Answer) => Answer; continues: boolean }[] = [
      { variant: 'a held lease', change: (answer) => answer, continues: true },
      {
        variant: 'a held lease from a newer store that adds a field',
        change: (answer) => ({ ...answer, laterField: 1 }),
        continues: true,
      },
      ...Object.entries(LEASE_STATE_FIELD_ROLES)
        .filter(([, role]) => role !== 'required')
        .map(([field]) => ({
          variant: `a held lease from an older store without ${field}`,
          change: ({ [field]: _omitted, ...rest }: Answer) => rest,
          continues: true,
        })),
      {
        variant: 'a refusal without a reason',
        change: () => ({ held: false, remainingMs: 0 }),
        continues: false,
      },
      {
        variant: 'a refusal with a reason this build does not know',
        change: () => ({ held: false, remainingMs: 0, reason: 'expired' }),
        continues: false,
      },
      {
        variant: 'an answer without held',
        change: ({ held: _omitted, ...rest }: Answer) => rest,
        continues: false,
      },
    ]
    for (const { variant, change, continues } of cases) {
      observed.push(await observe(variant, (answer) => answer, change))
      expected.push({ variant, outcome: continues ? 'completed' : 'lease-lost', handlerRan: true })
    }
    expect(observed).toEqual(expected)
  })
})
