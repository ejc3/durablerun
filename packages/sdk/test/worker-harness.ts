import { engineHistoryViolations } from '@durablerun/conformance'
import type { SqlExecutor } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { expect } from 'vitest'
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

/** The rows a test leaves satisfy everything a history that the engine wrote must. */
export async function expectCleanRows(f: { readonly raw: SqlExecutor }): Promise<void> {
  expect(await engineHistoryViolations(f.raw)).toEqual([])
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
