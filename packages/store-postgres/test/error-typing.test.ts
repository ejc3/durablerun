import { describe, expect, it } from 'vitest'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * How the executor types what a real PostgreSQL server answers. The executor's own cases
 * run on a fake client that is fed the states their author listed, so they can only agree
 * with that list. This case asks the server. It needs one, and is never conditional. A
 * broken constraint, class 23, is held on a real server by the shared executor error
 * surface of the conformance suite.
 */
describe('what a real PostgreSQL server answers a refused statement', () => {
  it('is typed permanent by its SQLSTATE class', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'refused-statements', migrate: false })
    try {
      await db.raw.batch('fixture:a-strict-table', [
        { sql: 'CREATE TABLE strict (id BIGINT PRIMARY KEY, n BIGINT NOT NULL)', args: [] },
      ])
      const answered = (sql: string, args: (string | number)[] = []) =>
        db.raw.batch('fixture:refused', [{ sql, args }]).then(
          () => 'answered',
          (error: unknown) => ({
            name: (error as Error).name,
            state: ((error as Error).cause as { code?: unknown } | undefined)?.code,
          }),
        )
      expect({
        syntaxError: await answered('SELEC 1'),
        valueOutOfRange: await answered(
          'INSERT INTO strict (id, n) VALUES (1, 9223372036854775807 + 1)',
        ),
        divisionByZero: await answered('INSERT INTO strict (id, n) VALUES (1, 1 / 0)'),
        textThatIsNoNumber: await answered('INSERT INTO strict (id, n) VALUES (1, ?)', ['12abc']),
      }).toEqual({
        syntaxError: { name: 'PermanentStoreError', state: '42601' },
        valueOutOfRange: { name: 'PermanentStoreError', state: '22003' },
        divisionByZero: { name: 'PermanentStoreError', state: '22012' },
        textThatIsNoNumber: { name: 'PermanentStoreError', state: '22P02' },
      })
    } finally {
      await db.close()
    }
  })
})
