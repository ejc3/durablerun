import { PermanentStoreError, type SqlStatement, StoreUnavailableError } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

const Q = 'executor-errors'

/** How a rejection is typed, as far as a consumer can tell the kinds apart. */
function kindOf(error: unknown): 'permanent' | 'outage' | string {
  if (error instanceof PermanentStoreError) return 'permanent'
  if (error instanceof StoreUnavailableError) return 'outage'
  return error instanceof Error ? error.name : String(error)
}

async function spawnTask(f: StoreFixture, name: string): Promise<string> {
  return (await f.store.spawn(Q, name, '{}')).taskId
}

async function attemptsByTask(f: StoreFixture): Promise<number[]> {
  const [read] = await f.raw.batch(
    'executor-errors:read-attempts',
    [{ sql: 'SELECT attempts FROM tasks ORDER BY task_id', args: [] }],
    'read',
  )
  return (read?.rows ?? []).map((row) => Number(row.attempts))
}

/**
 * What a store's executor throws, by kind, through the fixture's real executor. A consumer
 * retries an outage and must not retry a permanent answer, so the split is contract, and
 * each dialect reaches it from its own driver's error codes. The statements here are plain
 * SQL that all three dialects read the same way, so no case asks which dialect it runs on.
 *
 * A syntax error is not here. PostgreSQL and MySQL name it by a code of its own and type it
 * permanent. SQLite files it under its generic code, which it also gives a transaction
 * state error that a new connection cures, so on libSQL it stays an outage (DESIGN.md §3.2).
 */
export function executorErrorConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`executor errors [${dialect}]`, () => {
    it('types a constraint violation permanent and not an outage, and writes nothing', async () => {
      const f = await makeFixture('executor-errors-constraint')
      try {
        const taskId = await spawnTask(f, 'only')
        // The row inserted again under its own primary key: one statement, no column list.
        const label = 'executor-errors:duplicate-task'
        const refusal: unknown = await f.raw
          .batch(label, [
            { sql: 'INSERT INTO tasks SELECT * FROM tasks WHERE task_id = ?', args: [taskId] },
          ])
          .then(
            () => 'answered',
            (error: unknown) => error,
          )
        expect(kindOf(refusal)).toBe('permanent')
        // The message says which batch and the cause is the driver's own error, code and all.
        expect(refusal).toMatchObject({ message: expect.stringContaining(label) })
        expect((refusal as Error).cause).toBeInstanceOf(Error)
        expect(await attemptsByTask(f)).toEqual([0])
      } finally {
        await f.close()
      }
    })

    it('types a batch sent after the executor closed an outage', async () => {
      const f = await makeFixture('executor-errors-closed')
      await f.close()
      const refusal: unknown = await f.raw
        .batch('executor-errors:after-close', [{ sql: 'SELECT 1', args: [] }], 'read')
        .then(
          () => 'answered',
          (error: unknown) => error,
        )
      expect(kindOf(refusal)).toBe('outage')
    })

    /**
     * Two write batches that update the same two rows in opposite orders, started together,
     * with reads between the two updates so that each holds its first row before it asks for
     * its second. PostgreSQL and MySQL end that by making one batch a deadlock victim, which
     * committed nothing, and their executors run it again. libSQL has one writer at a time and
     * runs one batch after the other. Either way the caller sees neither an outage nor a
     * permanent error: both batches are answered, and each update is applied exactly once.
     *
     * The case does not ask that a deadlock happened, because libSQL cannot have one and the
     * servers need not: the first round on PostgreSQL usually has none, while one of its two
     * connections is still being opened. Measured over three rounds: PostgreSQL ran a victim
     * again in two, MySQL in all three, and libSQL in none.
     */
    it('answers both of two batches that lock the same rows in opposite orders, each write applied once', async () => {
      const f = await makeFixture('executor-errors-deadlock')
      try {
        const first = await spawnTask(f, 'first')
        const second = await spawnTask(f, 'second')
        const bump = (taskId: string): SqlStatement => ({
          sql: 'UPDATE tasks SET attempts = attempts + 1 WHERE task_id = ?',
          args: [taskId],
        })
        const between: SqlStatement[] = Array.from({ length: 20 }, () => ({
          sql: 'SELECT 1',
          args: [],
        }))
        const settle = (batch: Promise<unknown>) =>
          batch.then(
            () => 'answered',
            (error: unknown) => kindOf(error),
          )
        const rounds = 3
        const answers: string[][] = []
        for (let round = 0; round < rounds; round++) {
          answers.push(
            await Promise.all([
              settle(
                f.raw.batch('executor-errors:forward', [bump(first), ...between, bump(second)]),
              ),
              settle(
                f.raw.batch('executor-errors:backward', [bump(second), ...between, bump(first)]),
              ),
            ]),
          )
        }
        expect(answers).toEqual(Array.from({ length: rounds }, () => ['answered', 'answered']))
        expect(await attemptsByTask(f)).toEqual([2 * rounds, 2 * rounds])
      } finally {
        await f.close()
      }
    }, 60_000)
  })
}
