import type { SchedulerStore, SqlExecutor, StoreAdmin } from '@durablerun/core'
import { FakeClock, Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { PostgresSchedulerStore } from '@durablerun/store-postgres'
import { openPostgresTestDb } from '@durablerun/store-postgres/testing'
import { type TaskRegistry, type WorkerOutcome, runClaimedRun } from '../src/index.js'
import { Q, invocationOf } from './worker-harness.js'

/** One store under the SDK, on any dialect. The SDK's behaviour must not depend on which. */
export interface SagaFixture {
  readonly raw: SqlExecutor
  readonly admin: StoreAdmin
  readonly store: SchedulerStore
  readonly clock: FakeClock
  advance(ms: number): Promise<void>
  close(): Promise<void>
}

async function fixtureOver(
  raw: SqlExecutor,
  admin: StoreAdmin,
  store: SchedulerStore,
  close: () => Promise<void>,
): Promise<SagaFixture> {
  const clock = new FakeClock()
  await admin.setFakeNowEpochMs(clock.now)
  const advance = async (ms: number) => {
    clock.advance(ms)
    await admin.setFakeNowEpochMs(clock.now)
    clock.fire()
  }
  return { raw, admin, store, clock, advance, close }
}

/** Every dialect the SDK's saga cases run on. A dialect added here runs all of them. */
export const SAGA_DIALECTS: readonly {
  readonly dialect: string
  readonly open: (seed: string) => Promise<SagaFixture>
}[] = [
  {
    dialect: 'libsql',
    open: async (seed) => {
      const { raw, admin } = await openTestDb()
      const store = new LibsqlSchedulerStore(raw, seededIdSource(new Rng(seed)))
      return fixtureOver(raw, admin, store, async () => raw.close())
    },
  },
  {
    dialect: 'postgres',
    open: async (seed) => {
      const { raw, admin, ids, close } = await openPostgresTestDb({ idNamespace: seed })
      return fixtureOver(raw, admin, new PostgresSchedulerStore(raw, ids), close)
    },
  },
]

/** Claim the next due run and run one pass over it, or answer null when nothing is due. */
export async function runNext(
  f: SagaFixture,
  reg: TaskRegistry,
  token: string,
  store: SchedulerStore = f.store,
): Promise<WorkerOutcome['kind'] | null> {
  const [run] = await f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
  if (!run) return null
  return (await runClaimedRun({ store, clock: f.clock, registry: reg }, invocationOf(run))).kind
}

/**
 * Drive a task until it ends: run what is due, and when nothing is, move the clock past
 * a lease and sweep, as a driver would. Answers every pass's outcome, in order.
 */
export async function drive(
  f: SagaFixture,
  reg: TaskRegistry,
  taskId: string,
  store: SchedulerStore = f.store,
): Promise<WorkerOutcome['kind'][]> {
  const outcomes: WorkerOutcome['kind'][] = []
  for (let round = 0; round < 40; round++) {
    const result = await f.store.getTaskResult(Q, taskId)
    if (result && !['pending', 'running', 'sleeping'].includes(result.state)) return outcomes
    const outcome = await runNext(f, reg, `w${round}`, store)
    if (outcome !== null) {
      outcomes.push(outcome)
      continue
    }
    await f.advance(70_000)
    await f.store.sweep(Q, 10)
  }
  throw new Error(`task ${taskId} did not end: ${outcomes.join(', ')}`)
}

export async function checkpointNames(f: SagaFixture, taskId: string): Promise<string[]> {
  const [rows] = await f.raw.batch(
    'saga-checkpoints',
    [
      {
        sql: 'SELECT checkpoint_name FROM checkpoints WHERE task_id = ? ORDER BY checkpoint_name',
        args: [taskId],
      },
    ],
    'read',
  )
  return (rows?.rows ?? []).map((row) => String(row.checkpoint_name))
}
