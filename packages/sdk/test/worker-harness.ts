import type { SchedulerStore } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource, withStoreOverrides } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { type TaskHandler, type TaskRegistry, runClaimedRun } from '../src/index.js'

export const Q = 'q'

export async function fx(seed: string) {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.advance(ms)
    await admin.setFakeNowEpochMs(clock.now)
    clock.fire()
  }
  return { raw, admin, ids, store, clock, advance, close: () => raw.close() }
}

export function registry(entries: Record<string, TaskHandler>): TaskRegistry {
  return new Map(Object.entries(entries))
}

export async function claimAndRun(
  f: Awaited<ReturnType<typeof fx>>,
  reg: TaskRegistry,
  token: string,
): Promise<ReturnType<typeof runClaimedRun>> {
  return runClaimedRun(
    { store: f.store, clock: f.clock, registry: reg },
    await claimInvocation(f, token),
  )
}

export async function claimInvocation(
  f: Awaited<ReturnType<typeof fx>>,
  token: string,
  leaseSeconds = 60,
) {
  const [run] = await f.store.claim(Q, token, { leaseSeconds, limit: 1 })
  if (!run) throw new Error('expected a claimable run')
  return invocationOf(run)
}

/** The launch a driver builds from a claimed run. */
export function invocationOf(run: { runId: string; claimToken: string; claimGen: number }) {
  return { queue: Q, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen }
}

/**
 * One pass over a store with some members replaced, from a fresh claim of a spawned `job`.
 * Answers what the pass returned or threw, and how many times it called `fail`, which is
 * how a case tells a failure billed to the task from one that was not.
 */
export async function passOver(
  seed: string,
  overrides: Partial<SchedulerStore>,
  job: TaskHandler = async () => 'done',
) {
  const f = await fx(seed)
  try {
    let failCalls = 0
    // The count wraps a case's own `fail`, so an override of it is still counted.
    const failOf = overrides.fail ?? (() => Promise.resolve({ rollingBack: false }))
    const store = withStoreOverrides<SchedulerStore>(f.store, {
      ...overrides,
      fail: (...args) => {
        failCalls++
        return failOf(...args)
      },
    })
    await f.store.spawn(Q, 'job', '{}')
    const invocation = await claimInvocation(f, 'w1')
    const observed = await runClaimedRun(
      { store, clock: f.clock, registry: registry({ job }) },
      invocation,
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    return { observed, failCalls }
  } finally {
    f.close()
  }
}
