import type {
  ClaimedRun,
  SchedulerStore,
  SqlExecutor,
  SqlRow,
  SqlStatement,
} from '@durablerun/core'
import type { StoreFixture, StoreFixtureFactory, StoreFixtureOptions } from './fixture.js'

/** Run one raw statement in read mode and return its first row. */
export async function readOne(
  raw: SqlExecutor,
  sql: string,
  args: SqlStatement['args'],
): Promise<SqlRow | undefined> {
  const [result] = await raw.batch('t', [{ sql, args }], 'read')
  return result?.rows[0]
}

/** A scenario failure whose fixture then also failed to close. */
export class FixtureCloseFailure extends Error {
  constructor(
    readonly closeFailure: unknown,
    scenarioFailure: unknown,
  ) {
    super(`closing the fixture failed after the scenario failed: ${closeFailure}`, {
      cause: scenarioFailure,
    })
    this.name = 'FixtureCloseFailure'
  }
}

/**
 * Run `body` against its own fixture and close the fixture afterwards, including
 * when the body throws. If closing fails after the body threw, it throws a
 * FixtureCloseFailure that keeps the close error and carries the body's error as
 * its cause, which the test report prints with its assertion diff.
 */
export async function withFixture<T>(
  makeFixture: StoreFixtureFactory,
  name: number | string,
  body: (fixture: StoreFixture) => Promise<T>,
  options?: StoreFixtureOptions,
): Promise<T> {
  const fixture = await makeFixture(name, options)
  let result: T
  try {
    result = await body(fixture)
  } catch (scenarioFailure) {
    try {
      await fixture.close()
    } catch (closeFailure) {
      throw new FixtureCloseFailure(closeFailure, scenarioFailure)
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

/**
 * Open `count` connections before a measured race. A handshake inside the race puts the
 * racers one after another, and a wrong lock order then passes because nothing overlapped.
 */
export async function warmConnections(
  raw: SqlExecutor,
  label: string,
  count: number,
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      raw.batch(`${label}:warm-${index}`, [{ sql: 'SELECT 1 AS ready', args: [] }], 'read'),
    ),
  )
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

/** awaitTaskDone for a run's own task, run, and claim token. */
export function awaitTaskOwned(
  store: SchedulerStore,
  queue: string,
  run: OwnedRun,
  stepName: string,
  childTaskId: string,
  timeoutSeconds: number | null,
) {
  return store.awaitTaskDone(
    queue,
    run.taskId,
    run.runId,
    run.claimToken,
    stepName,
    childTaskId,
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

/** The name of the error a store write refused with, or 'accepted' when it went through. */
export function refusalName(write: Promise<unknown>): Promise<string> {
  return write.then(
    () => 'accepted',
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  )
}

/** Render a failure and every cause beneath it, one per line. */
export function describeFailure(error: unknown): string {
  const lines: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 8; depth++) {
    const code =
      typeof current === 'object' && current !== null && 'code' in current
        ? ` [${String(current.code)}]`
        : ''
    lines.push(`${depth === 0 ? '' : 'caused by: '}${String(current)}${code}`)
    current = current instanceof Error ? current.cause : undefined
  }
  return lines.join('\n')
}

/** Puts a task at `retries` infrastructure retries and its run at the matching ordinal. */
export function infraRetrySeed(taskId: string, runId: string, retries: number) {
  return [
    { sql: `UPDATE tasks SET infra_retries = ? WHERE task_id = ?`, args: [retries, taskId] },
    { sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`, args: [retries + 1, runId] },
  ]
}
