import { PermanentStoreError, type SqlExecutor, type SqlStatement } from '@durablerun/core'
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

/** A read of one task's attempts. */
const attemptsStatement = (taskId: string): SqlStatement => ({
  sql: 'SELECT attempts FROM tasks WHERE task_id = ?',
  args: [taskId],
})

/** The attempts of one task, read through the executor a case makes wait. */
async function attemptsOf(raw: SqlExecutor, taskId: string): Promise<number> {
  const [read] = await raw.batch(
    'executor-errors:read-attempts',
    [attemptsStatement(taskId)],
    'read',
  )
  return Number(read?.rows[0]?.attempts)
}

/** A read of how many tasks there are, and a write to every one: plain SQL all three dialects read alike. */
const countTasks: SqlStatement = { sql: 'SELECT COUNT(*) AS tasks FROM tasks', args: [] }
const bumpEveryTask: SqlStatement = { sql: 'UPDATE tasks SET attempts = attempts + 1', args: [] }

/** One more attempt on a task's row: a write every dialect reads alike, and one a read can see. */
const bump = (taskId: string): SqlStatement => ({
  sql: 'UPDATE tasks SET attempts = attempts + 1 WHERE task_id = ?',
  args: [taskId],
})

/**
 * More write batches fail in a row than a server executor's pool holds connections, which
 * is ten on both, so an executor that lost a connection to every failed batch would stop
 * answering inside the case.
 */
const FAILED_BATCHES_IN_A_ROW = 12

/** The row inserted again under its own key: one statement, no column list. */
const duplicateRow = (taskId: string): SqlStatement => ({
  sql: 'INSERT INTO tasks SELECT * FROM tasks WHERE task_id = ?',
  args: [taskId],
})

/**
 * One refused write for each kind of constraint the `tasks` table declares on every
 * dialect, as plain SQL that all three read alike.
 */
const BROKEN_CONSTRAINTS: Readonly<
  Record<string, (first: string, second: string) => SqlStatement>
> = {
  'primary key': (first) => duplicateRow(first),
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

    /**
     * A failed batch is reported once, and its executor serves the next call (DESIGN.md
     * §3.2). The failure is a real one from the real driver, INSIDE a write batch: the first
     * statement writes and the second breaks a constraint. A fault injected above the driver
     * cannot show what a driver leaves behind on its connection, which is where this class
     * of defect lives, so the fault matrix cannot stand in for this case.
     */
    it('answers a read and a write on the same executor after write batches that failed inside', () =>
      withFixture(makeFixture, 'executor-errors-next-call', async (f) => {
        const [first] = await twoTasks(f)
        const before = await taskRows(f)
        for (let failed = 0; failed < FAILED_BATCHES_IN_A_ROW; failed++) {
          expect(
            await refusalName(
              f.raw.batch('executor-errors:fail-inside', [bump(first), duplicateRow(first)]),
            ),
            `failed batch ${failed + 1}`,
          ).toBe('PermanentStoreError')
        }
        // The read: every failed batch was undone whole, its first statement included.
        expect(await taskRows(f)).toEqual(before)
        // The write, and a read of what it wrote.
        expect(await refusalName(f.raw.batch('executor-errors:write-after', [bump(first)]))).toBe(
          'accepted',
        )
        expect((await taskRows(f)).map((row) => Number(row.attempts))).toEqual(
          before.map((row) => Number(row.attempts) + (row.task_id === first ? 1 : 0)),
        )
      }))

    /**
     * The failure production meets on libSQL, which a broken constraint cannot show because it
     * halts its statement: a write batch that waits for a lock another connection holds until
     * the executor's wait runs out (§3.2). Each dialect shortens that wait with a statement of
     * its own, libSQL before the batch, because it waits for its lock at the batch's BEGIN, and
     * the servers inside the batch's transaction. The read comes while the lock is still held,
     * because a read takes no write lock and must be answered, and the write once it is free.
     */
    it(
      'answers a read while the lock is held and a write once it is free, on the same executor, after a write batch gave up waiting for a lock',
      () =>
        withFixture(makeFixture, 'executor-errors-lock-wait', async (f) => {
          const surface = await f.lockWait()
          try {
            const { taskId } = await surface.store.spawn(Q, 'waits-for-a-lock', '{}')
            if (surface.shortenFirst.length > 0) {
              await surface.raw.batch(
                'executor-errors:shorten-the-lock-wait',
                surface.shortenFirst,
                'read',
              )
            }
            await surface.holdWriteLock(taskId, async () => {
              expect(
                await refusalName(
                  surface.raw.batch('executor-errors:wait-for-the-lock', [
                    ...surface.shortenInside,
                    bump(taskId),
                  ]),
                ),
                'the write waits for the held lock and gives up',
              ).toBe('StoreUnavailableError')
              expect(
                await refusalName(
                  surface.raw.batch(
                    'executor-errors:read-while-the-lock-is-held',
                    [attemptsStatement(taskId)],
                    'read',
                  ),
                ),
              ).toBe('accepted')
            })
            expect(
              await refusalName(
                surface.raw.batch('executor-errors:write-once-the-lock-is-free', [bump(taskId)]),
              ),
            ).toBe('accepted')
            expect(await attemptsOf(surface.raw, taskId)).toBe(1)
          } finally {
            await surface.close()
          }
        }),
      60_000,
    )

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
     * A store that refuses the credential it was opened with, or refuses what that
     * credential may do, says so, apart from an outage and apart from a permanent answer to
     * a statement (DESIGN.md §3.2). A caller that waits out an outage would wait for good
     * here, and the statement is one the store takes under another credential. A wrong
     * credential is refused before the store reads a statement, so a read and a write are
     * refused alike. A credential that may only read is answered its read and refused its
     * write, through the executor and through the port, and the write changes nothing.
     *
     * A dialect whose store takes no credential has nothing to refuse, and its fixture
     * offers no surface. libSQL's is one: its fixture is a database file.
     */
    /**
     * What a batch sent through `raw` meets: the word `accepted`, or the error it throws.
     */
    const answerOf = (raw: SqlExecutor, label: string, mode: 'read' | 'write') =>
      raw.batch(label, [mode === 'read' ? countTasks : bumpEveryTask], mode).then(
        () => 'accepted',
        (error: unknown) => error,
      )

    /** Holds a refusal to the type, to the batch's label and to the driver's error as its cause. */
    const expectAccessRefusal = (refusal: unknown, label: string, what: string) => {
      expect(refusal instanceof Error ? refusal.name : refusal, what).toBe(
        'StoreAccessRefusedError',
      )
      expect(refusal, what).toMatchObject({ message: expect.stringContaining(label) })
      expect((refusal as Error).cause, what).toBeInstanceOf(Error)
    }

    it('types a credential the store refuses apart from an outage and from a permanent answer, for a read, for a write and for a call of the port', () =>
      withFixture(makeFixture, 'executor-errors-refused-credential', async (f) => {
        const surface = await f.refusedCredential()
        try {
          // A fixture that offered no refusal would pass the loop below having checked nothing.
          expect(surface.refusals.length).toBeGreaterThan(0)
          await twoTasks(f)
          const before = await taskRows(f)
          for (const { what, raw } of surface.refusals) {
            for (const mode of ['read', 'write'] as const) {
              const label = `executor-errors:refused-credential-${mode}`
              expectAccessRefusal(
                await answerOf(raw, label, mode),
                label,
                `a ${mode} under ${what}`,
              )
            }
            // A caller of the port meets the same type as a caller of the executor.
            expect(
              await refusalName(f.storeOver(raw).spawn(Q, 'refused', '{}')),
              `a call of the port under ${what}`,
            ).toBe('StoreAccessRefusedError')
          }
          expect(await taskRows(f)).toEqual(before)
        } finally {
          await surface.close()
        }
      }))

    /**
     * A credential the store accepts, which may read and may not write. This is a second
     * case, apart from the one above, because it needs a role, and not every dialect has
     * one: a libSQL fixture is a database file, and a file has no role, so its fixture
     * offers no surface and the case checks nothing for it. PostgreSQL and MySQL offer one.
     * What a hosted libSQL server answers a write under a token that may only read is not
     * known (DESIGN.md §3.2).
     */
    it('types a write under a credential that may only read as an access refusal, answers its read, and changes nothing', () =>
      withFixture(makeFixture, 'executor-errors-may-only-read', async (f) => {
        const reader = await f.credentialThatMayOnlyRead()
        if (reader === null) return
        try {
          await twoTasks(f)
          const before = await taskRows(f)
          // The control: the credential is one the store accepts.
          expect(await answerOf(reader.raw, 'executor-errors:read-as-a-reader', 'read')).toBe(
            'accepted',
          )
          const label = 'executor-errors:write-as-a-reader'
          expectAccessRefusal(
            await answerOf(reader.raw, label, 'write'),
            label,
            'a write under a credential that may only read',
          )
          expect(
            await refusalName(f.storeOver(reader.raw).spawn(Q, 'refused', '{}')),
            'a call of the port under a credential that may only read',
          ).toBe('StoreAccessRefusedError')
          expect(await taskRows(f)).toEqual(before)
        } finally {
          await reader.close()
        }
      }))

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
