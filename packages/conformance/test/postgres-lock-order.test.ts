import { afterEach, beforeEach, expect, it } from 'vitest'
import type { StoreFixture } from '../src/index.js'
import { awaitTaskOwned, claimActivated, readOne, refusalName } from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

/**
 * Two transactions that lock the same two rows in opposite orders deadlock, and
 * PostgreSQL aborts one of them. Every worker write, every sweep, and the wake of a
 * parked run lock the run's row and then its task's row. A cancellation updates the
 * task first. A trigger that sleeps after the parent's task row is updated holds that
 * window open, so the interleaving that production reaches by chance happens here
 * every time, and the database's own deadlock counter says whether it did.
 */
let f: StoreFixture

async function deadlocks(): Promise<number> {
  const row = await readOne(
    f.raw,
    'SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()',
    [],
  )
  return Number(row?.n)
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  f = await makePostgresFixture('postgres-lock-order')
  await f.admin.setFakeNowEpochMs(1_000_000)
  await f.raw.batch('slow-parent-trigger', [
    {
      sql: `CREATE FUNCTION hold_the_parent_task() RETURNS trigger LANGUAGE plpgsql AS '
              BEGIN
                IF NEW.task_name = ''parent'' THEN PERFORM pg_sleep(0.4); END IF;
                RETURN NEW;
              END'`,
      args: [],
    },
    {
      sql: `CREATE TRIGGER hold_the_parent_task AFTER UPDATE ON tasks
            FOR EACH ROW EXECUTE FUNCTION hold_the_parent_task()`,
      args: [],
    },
  ])
})

afterEach(async () => {
  await f.close()
})

it('a child ending does not deadlock against a cancel of its parked parent', async () => {
  const parentTask = await f.store.spawn('q', 'parent', '{}')
  const parent = await claimActivated(f.store, 'q', 'w-parent')
  const child = await f.store.spawn('q', 'child', '{}')
  const childRun = await claimActivated(f.store, 'q', 'w-child')
  await awaitTaskOwned(f.store, 'q', parent, 's', child.taskId, null)
  const before = await deadlocks()
  const cancelling = refusalName(f.store.cancelTask('q', parentTask.taskId))
  await pause(150)
  const completing = refusalName(f.store.complete('q', childRun.runId, childRun.claimToken, '{}'))
  const task = async (taskId: string) =>
    (await readOne(f.raw, 'SELECT state FROM tasks WHERE task_id = ?', [taskId]))?.state
  expect(
    {
      cancel: await cancelling,
      complete: await completing,
      parent: await task(parentTask.taskId),
      child: await task(child.taskId),
      deadlocks: (await deadlocks()) - before,
    },
    'mutation-verdict:behavior:cancel-locks-runs-before-the-task',
  ).toEqual({
    cancel: 'accepted',
    complete: 'accepted',
    parent: 'cancelled',
    child: 'completed',
    deadlocks: 0,
  })
}, 60_000)

// A terminal write and a cancel of one task both take that task's event lock, so they
// serialize. A write that ends nothing takes no lock, and it has the same two rows to
// lock: the run, then the task that mirrors it.
it('a worker write that ends nothing does not deadlock against a cancel of its task', async () => {
  const parentTask = await f.store.spawn('q', 'parent', '{}')
  const run = await claimActivated(f.store, 'q', 'w-parent')
  const before = await deadlocks()
  const cancelling = refusalName(f.store.cancelTask('q', parentTask.taskId))
  await pause(150)
  const rescheduling = refusalName(
    f.store.reschedule('q', run.runId, run.claimToken, { inSeconds: 30 }),
  )
  expect({
    cancel: await cancelling,
    reschedule: await rescheduling,
    deadlocks: (await deadlocks()) - before,
  }).toEqual({ cancel: 'accepted', reschedule: 'RunCancelledError', deadlocks: 0 })
}, 60_000)
