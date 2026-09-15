import type {
  ClaimedRun,
  SchedulerStore,
  SqlExecutor,
  SqlRow,
  SqlStatement,
} from '@durablerun/core'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

/** Run one raw statement in read mode and return its first row. */
export async function readOne(
  raw: SqlExecutor,
  sql: string,
  args: SqlStatement['args'],
): Promise<SqlRow | undefined> {
  const [result] = await raw.batch('t', [{ sql, args }], 'read')
  return result?.rows[0]
}

/**
 * Run `body` against its own fixture and close the fixture afterwards, including
 * when the body throws. If closing fails after the body threw, the thrown error
 * names the close failure and carries the body's error as its cause, which the
 * test report prints with its assertion diff.
 */
export async function withFixture<T>(
  makeFixture: StoreFixtureFactory,
  name: number | string,
  body: (fixture: StoreFixture) => Promise<T>,
): Promise<T> {
  const fixture = await makeFixture(name)
  let result: T
  try {
    result = await body(fixture)
  } catch (scenarioFailure) {
    try {
      await fixture.close()
    } catch (closeFailure) {
      throw new Error(`closing the fixture failed after the scenario failed: ${closeFailure}`, {
        cause: scenarioFailure,
      })
    }
    throw scenarioFailure
  }
  await fixture.close()
  return result
}

/** Claim exactly one run from `queue`, failing the scenario when nothing is claimable. */
export async function claimOne(
  store: SchedulerStore,
  queue: string,
  token: string,
  leaseSeconds = 60,
): Promise<ClaimedRun> {
  const [run] = await store.claim(queue, token, { leaseSeconds, limit: 1 })
  if (!run) throw new Error(`expected a claimable run for ${token}`)
  return run
}

/** Claim exactly one run and activate it, failing the scenario when either step does nothing. */
export async function claimActivated(
  store: SchedulerStore,
  queue: string,
  token: string,
  leaseSeconds = 60,
): Promise<ClaimedRun> {
  const run = await claimOne(store, queue, token, leaseSeconds)
  const activated = await store.activate(queue, run.runId, run.claimToken, run.claimGen)
  if (!activated) throw new Error(`expected to activate the run claimed by ${token}`)
  return activated
}

/** The task, run, and claim token that every owner-bound call passes together. */
type OwnedRun = Pick<ClaimedRun, 'taskId' | 'runId' | 'claimToken'>

/** awaitEvent for a run's own task, run, and claim token. */
export function awaitOwned(
  store: SchedulerStore,
  queue: string,
  run: OwnedRun,
  stepName: string,
  eventName: string,
  timeoutSeconds: number | null,
) {
  return store.awaitEvent(
    queue,
    run.taskId,
    run.runId,
    run.claimToken,
    stepName,
    eventName,
    timeoutSeconds,
  )
}

/** setCheckpoint for a run's own task, run, and claim token. */
export function checkpointOwned(
  store: SchedulerStore,
  queue: string,
  run: OwnedRun,
  checkpointName: string,
  stateJson: string,
  extendLeaseSeconds: number,
) {
  return store.setCheckpoint(
    queue,
    run.taskId,
    run.runId,
    run.claimToken,
    checkpointName,
    stateJson,
    extendLeaseSeconds,
  )
}
