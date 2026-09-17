import {
  CLAIMED_RUN_ANSWER_FIELDS,
  type ClaimedRun,
  type LeaseState,
  type SchedulerStore,
  StoreUnavailableError,
} from '@durablerun/core'
import { withStoreOverrides } from '@durablerun/harness'
import { describe, expect, it } from 'vitest'
import { runClaimedRun } from '../src/index.js'
import { claimAndRun, claimInvocation, fx, registry } from './worker-harness.js'

const Q = 'q'

/**
 * Heartbeat answer fields, classified like `CLAIMED_RUN_ANSWER_FIELDS`, which the
 * worker checks activation answers against. `satisfies` makes a new field a type
 * error until it is classified.
 */
type LeaseStateField =
  | keyof Extract<LeaseState, { held: true }>
  | keyof Extract<LeaseState, { held: false }>

const LEASE_STATE_FIELD_ROLES = {
  held: 'required',
  remainingMs: 'unread',
  reason: 'optional',
} as const satisfies Record<LeaseStateField, 'required' | 'optional' | 'unread'>

/** Present but malformed values for every activation answer field the worker checks. */
const MALFORMED_ANSWER_VALUES = {
  runId: [7, ''],
  claimToken: [null, ''],
  taskId: [7, ''],
  taskName: [7, ''],
  attempt: ['1', 0, 1.5, 1n],
  infraRetries: [-1, 1.5, 0n],
  claimGen: [0, -1, 1.5, 1n],
  leaseSeconds: [0, -5, 0.000001, '60'],
  paramsJson: [7],
  retryStrategy: [null, {}],
  maxAttempts: [0, '3', 3n],
  wake: [{ event: 'e' }, 'wake'],
} satisfies Partial<Record<keyof ClaimedRun, readonly unknown[]>>

type Answer = Record<string, unknown>

function describeValue(value: unknown): string {
  return typeof value === 'bigint' ? `${value}n` : JSON.stringify(value)
}

interface Observation {
  variant: string
  outcome: string
  field?: string
  handlerRan: boolean
  recovered?: boolean
}

const COMPLETED = { outcome: 'completed', handlerRan: true } as const

function refused(field: string) {
  return { outcome: 'incompatible-store', field, handlerRan: false, recovered: true } as const
}

/**
 * Run one task against a store whose answers are rewritten. A pass that ran no user
 * code is followed by recovery: the lease expires, the sweep runs, and a compatible
 * worker must complete the task.
 */
async function observe(
  variant: string,
  overrides: {
    run?: (answer: Answer) => Answer
    lease?: (answer: Answer) => Answer
    activate?: SchedulerStore['activate']
    leaseSeconds?: number
  },
): Promise<Observation> {
  const f = await fx(`store-answer-${variant}`)
  try {
    const { taskId } = await f.store.spawn(Q, 'job', '{}')
    const changeRun = overrides.run
    const changeLease = overrides.lease
    const store = withStoreOverrides<SchedulerStore>(f.store, {
      activate:
        overrides.activate ??
        (async (...args) => {
          const run = await f.store.activate(...args)
          return run === null || changeRun === undefined
            ? run
            : (changeRun({ ...run }) as unknown as ClaimedRun)
        }),
      ...(changeLease === undefined
        ? {}
        : {
            heartbeat: async (...args: Parameters<SchedulerStore['heartbeat']>) =>
              changeLease({ ...(await f.store.heartbeat(...args)) }) as unknown as LeaseState,
          }),
    })
    let handlerRan = false
    const reg = registry({
      job: async (ctx) => {
        handlerRan = true
        if (changeLease !== undefined) {
          // Let the heartbeat pump beat once before the next context call.
          await f.advance(30_000)
          await f.clock.yieldTurn()
          await f.clock.yieldTurn()
        }
        await ctx.step('after', () => 1)
        return 'done'
      },
    })
    let outcome: string
    let field: string | undefined
    try {
      const result = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w1', overrides.leaseSeconds),
      )
      outcome = result.kind
      field = 'field' in result ? String(result.field) : undefined
    } catch (error) {
      outcome = `threw ${(error as Error).name}`
    }
    const observation: Observation = {
      variant,
      outcome,
      ...(field === undefined ? {} : { field }),
      handlerRan,
    }
    if (outcome === 'completed' || handlerRan) return observation
    let recovered = false
    try {
      // Past the lease, then past the successor's or relaunch's backoff.
      await f.advance(61_000)
      await f.store.sweep(Q, 10)
      await f.advance(300_000)
      const recovery = await claimAndRun(f, registry({ job: async () => 'done' }), 'w2')
      recovered =
        recovery.kind === 'completed' &&
        (await f.store.getTaskResult(Q, taskId))?.state === 'completed'
    } catch {
      recovered = false
    }
    return { ...observation, recovered }
  } finally {
    f.close()
  }
}

describe('store answers across store and worker versions', () => {
  it('every checked activation field has malformed values generated', () => {
    expect(Object.keys(MALFORMED_ANSWER_VALUES).sort()).toEqual(
      Object.entries(CLAIMED_RUN_ANSWER_FIELDS)
        .filter(([, shape]) => shape !== 'unread')
        .map(([field]) => field)
        .sort(),
    )
  })

  it('a worker runs every well-formed activation answer and refuses, recoverably, every other', async () => {
    const cases: { variant: string; run: (answer: Answer) => Answer; expected: object }[] = [
      { variant: 'the current store', run: (answer) => answer, expected: COMPLETED },
      {
        variant: 'a newer store that adds a field',
        run: (answer) => ({ ...answer, laterField: { nested: true } }),
        expected: COMPLETED,
      },
      ...Object.entries(CLAIMED_RUN_ANSWER_FIELDS).map(([field, shape]) => ({
        variant: `an older store without ${field}`,
        run: ({ [field]: _omitted, ...rest }: Answer) => rest,
        expected: shape === 'optional' || shape === 'unread' ? COMPLETED : refused(field),
      })),
      ...Object.entries(MALFORMED_ANSWER_VALUES).flatMap(([field, values]) =>
        values.map((value) => ({
          variant: `a store answering ${field} as ${describeValue(value)}`,
          run: (answer: Answer) => ({ ...answer, [field]: value }),
          expected: refused(field),
        })),
      ),
      {
        variant: 'a store answering infraRetries at or past attempt',
        run: (answer) => ({ ...answer, infraRetries: answer.attempt }),
        expected: refused('infraRetries'),
      },
      {
        variant: 'a store whose attempt getter throws',
        run: (answer) =>
          Object.defineProperty({ ...answer }, 'attempt', {
            enumerable: true,
            get() {
              throw new Error('unreadable attempt')
            },
          }),
        expected: refused('attempt'),
      },
    ]
    const expected = cases.map(({ variant, expected }) => ({ variant, ...expected }))
    const observed: Observation[] = []
    for (const { variant, run } of cases) observed.push(await observe(variant, { run }))
    expect(observed).toEqual(expected)
  }, 180_000)

  it('a worker runs the current store answer for every lease the driver can claim with', async () => {
    const leases = [0.001, 1.001, 2.002, 60]
    const observed: Observation[] = []
    for (const leaseSeconds of leases) {
      observed.push(await observe(`a ${leaseSeconds}s lease`, { leaseSeconds }))
    }
    expect(observed).toEqual(
      leases.map((leaseSeconds) => ({ variant: `a ${leaseSeconds}s lease`, ...COMPLETED })),
    )
  })

  it('a worker runs a delivered wake that also says it did not time out', async () => {
    const f = await fx('store-answer-wake-not-timed-out')
    try {
      const { taskId } = await f.store.spawn(Q, 'job', '{}')
      const reg = registry({
        job: async (ctx) => {
          await ctx.awaitEvent('go', { timeoutSeconds: 30 })
          return 'done'
        },
      })
      expect((await claimAndRun(f, reg, 'w1')).kind).toBe('suspended')
      await f.store.emitEvent(Q, 'go', '{"n":1}')
      const store = withStoreOverrides<SchedulerStore>(f.store, {
        activate: async (...args) => {
          const run = await f.store.activate(...args)
          return run?.wake === undefined
            ? run
            : ({ ...run, wake: { ...run.wake, timedOut: false } } as unknown as ClaimedRun)
        },
      })
      const result = await runClaimedRun(
        { store, clock: f.clock, registry: reg },
        await claimInvocation(f, 'w2'),
      )
      expect(result.kind).toBe('completed')
      expect((await f.store.getTaskResult(Q, taskId))?.state).toBe('completed')
    } finally {
      f.close()
    }
  })

  it('a store outage at activation ends the pass as aborted, and the run recovers', async () => {
    const observation = await observe('an outage at activation', {
      activate: async () => {
        throw new StoreUnavailableError('store unreachable at activation')
      },
    })
    expect(observation).toEqual({
      variant: 'an outage at activation',
      outcome: 'aborted',
      handlerRan: false,
      recovered: true,
    })
  })

  it('a worker keeps running on every held heartbeat answer and stops on every refusal', async () => {
    const cases: { variant: string; lease: (answer: Answer) => Answer; continues: boolean }[] = [
      { variant: 'a held lease', lease: (answer) => answer, continues: true },
      {
        variant: 'a held lease from a newer store that adds a field',
        lease: (answer) => ({ ...answer, laterField: 1 }),
        continues: true,
      },
      ...Object.entries(LEASE_STATE_FIELD_ROLES).map(([field, role]) => ({
        variant: `a heartbeat answer from an older store without ${field}`,
        lease: ({ [field]: _omitted, ...rest }: Answer) => rest,
        continues: role !== 'required',
      })),
    ]
    const expected = cases.map(({ variant, continues }) => ({
      variant,
      outcome: continues ? 'completed' : 'lease-lost',
      handlerRan: true,
    }))
    const observed: Observation[] = []
    for (const { variant, lease } of cases) observed.push(await observe(variant, { lease }))
    expect(observed).toEqual(expected)
  }, 60_000)
})
