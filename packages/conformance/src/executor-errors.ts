import { PermanentStoreError, type SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { refusalName, warmConnections, withFixture } from './scenario.js'

const Q = 'executor-errors'

/** Two tasks of one queue, each under an idempotency key of its own. */
async function twoTasks(f: StoreFixture): Promise<[first: string, second: string]> {
  const first = await f.store.spawn(Q, 'first', '{}', { idempotencyKey: 'key-of-the-first' })
  const second = await f.store.spawn(Q, 'second', '{}', { idempotencyKey: 'key-of-the-second' })
  return [first.taskId, second.taskId]
}

/** Every column of `tasks` that a case here writes, or tries to. */
async function taskRows(f: StoreFixture) {
  const [read] = await f.raw.batch(
    'executor-errors:read-tasks',
    [
      {
        sql: 'SELECT task_id, task_name, state, idempotency_key, attempts FROM tasks ORDER BY task_id',
        args: [],
      },
    ],
    'read',
  )
  return read?.rows ?? []
}

/**
 * One refused write for each kind of constraint the `tasks` table declares on every
 * dialect, as plain SQL that all three read alike.
 */
const BROKEN_CONSTRAINTS: Readonly<
  Record<string, (first: string, second: string) => SqlStatement>
> = {
  'primary key': (first) => ({
    // The row inserted again under its own key: one statement, no column list.
    sql: 'INSERT INTO tasks SELECT * FROM tasks WHERE task_id = ?',
    args: [first],
  }),
  unique: (_first, second) => ({
    // The second task under the first one's idempotency key, in the same queue.
    sql: 'UPDATE tasks SET idempotency_key = ? WHERE task_id = ?',
    args: ['key-of-the-first', second],
  }),
  'not null (a NULL written)': (first) => ({
    sql: 'UPDATE tasks SET task_name = NULL WHERE task_id = ?',
    args: [first],
  }),
  'not null (a column left out)': () => ({
    // A row that names two of its columns and leaves out others that take no NULL and
    // have no default. A dialect can file this apart from a NULL that was written.
    sql: 'INSERT INTO tasks (task_id, queue) VALUES (?, ?)',
    args: ['a-task-with-columns-left-out', Q],
  }),
  check: (first) => ({
    // Every dialect holds `state` to the six states a task can be in.
    sql: 'UPDATE tasks SET state = ? WHERE task_id = ?',
    args: ['no-such-state', first],
  }),
}

/**
 * What a store's executor throws, by kind, through the fixture's real executor. A consumer
 * retries an outage and must not retry a permanent answer, so the split is contract, and
 * each dialect reaches it from its own driver's error codes. No case asks which dialect it
 * runs on.
 *
 * A syntax error is not here. PostgreSQL and MySQL name it by a code of its own and type it
 * permanent. SQLite files it under its generic code, which it also gives a transaction
 * state error that a new connection cures, so on libSQL it is an outage (DESIGN.md §3.2).
 */
export function executorErrorConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`executor errors [${dialect}]`, () => {
    for (const [kind, violate] of Object.entries(BROKEN_CONSTRAINTS)) {
      it(`types a broken ${kind} constraint permanent and not an outage, and writes nothing`, () =>
        withFixture(makeFixture, `executor-errors-${kind}`, async (f) => {
          const [first, second] = await twoTasks(f)
          const before = await taskRows(f)
          const label = 'executor-errors:break-a-constraint'
          const refusal: unknown = await f.raw.batch(label, [violate(first, second)]).then(
            () => 'accepted',
            (error: unknown) => error,
          )
          expect(refusal).toBeInstanceOf(PermanentStoreError)
          // The message says which batch, and the cause is the driver's own error, code and all.
          expect(refusal).toMatchObject({ message: expect.stringContaining(label) })
          expect((refusal as Error).cause).toBeInstanceOf(Error)
          expect(await taskRows(f)).toEqual(before)
        }))
    }

    it('types a batch sent after the executor closed an outage', async () => {
      const f = await makeFixture('executor-errors-closed', { migrate: false })
      await f.close()
      expect(
        await refusalName(
          f.raw.batch('executor-errors:after-close', [{ sql: 'SELECT 1', args: [] }], 'read'),
        ),
      ).toBe('StoreUnavailableError')
    })

    /**
     * Two write batches that update the same two rows in opposite orders, started together
     * on connections that are already open, with reads between the two updates so that each
     * holds its first row before it asks for its second. PostgreSQL and MySQL end that by
     * making one batch a deadlock victim, which committed nothing, and their executors run it
     * again. libSQL has one writer at a time and runs one batch after the other. Either way
     * the caller meets neither an outage nor a permanent error: both batches are answered, and
     * each update is applied exactly once.
     *
     * The case does not ask that a deadlock happened, because libSQL cannot have one and a
     * server need not (DESIGN.md §3.4 holds the measurement).
     */
    it(
      'answers both of two batches that lock the same rows in opposite orders, each write applied once',
      () =>
        withFixture(makeFixture, 'executor-errors-deadlock', async (f) => {
          const [first, second] = await twoTasks(f)
          const bump = (taskId: string): SqlStatement => ({
            sql: 'UPDATE tasks SET attempts = attempts + 1 WHERE task_id = ?',
            args: [taskId],
          })
          const between: SqlStatement[] = Array.from({ length: 20 }, () => ({
            sql: 'SELECT 1',
            args: [],
          }))
          await warmConnections(f.raw, 'executor-errors', 2)
          expect(
            await Promise.all([
              refusalName(
                f.raw.batch('executor-errors:forward', [bump(first), ...between, bump(second)]),
              ),
              refusalName(
                f.raw.batch('executor-errors:backward', [bump(second), ...between, bump(first)]),
              ),
            ]),
          ).toEqual(['accepted', 'accepted'])
          expect((await taskRows(f)).map((row) => Number(row.attempts))).toEqual([2, 2])
        }),
      60_000,
    )
  })
}
