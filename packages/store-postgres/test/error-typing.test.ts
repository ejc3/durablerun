import { describe, expect, it } from 'vitest'
import { PgExecutor, createOwnedPostgresPool } from '../src/executor.js'
import { PostgresSchedulerStore } from '../src/store.js'
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

describe('what a real PostgreSQL server answers a role it refuses', () => {
  const serverUrl = (): string => {
    const url = process.env.DURABLERUN_POSTGRES_URL
    if (!url) throw new Error('these cases need DURABLERUN_POSTGRES_URL')
    return url
  }
  /** The type a batch's failure has, with the SQLSTATE the server sent. */
  const answered = (executor: PgExecutor, sql: string, mode: 'read' | 'write') =>
    executor.batch('fixture:refused-access', [{ sql, args: [] }], mode).then(
      () => 'answered',
      (error: unknown) => ({
        name: (error as Error).name,
        state: ((error as Error).cause as { code?: unknown } | undefined)?.code,
      }),
    )

  it('types a wrong password and a role that may not log in an access refusal, by SQLSTATE class 28', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'refused-logins', migrate: false })
    const control = createOwnedPostgresPool({ connectionString: serverUrl() })
    // The schema's name is generated from the lowercase identifier alphabet, and so are these.
    const role = `dr_cred_${db.schemaName.slice(-20)}`
    const opened: PgExecutor[] = []
    const login = (username: string, password: string) => {
      const url = new URL(serverUrl())
      url.username = username
      url.password = password
      const executor = PgExecutor.open({ connectionString: url.href })
      opened.push(executor)
      return answered(executor, 'SELECT 1 AS answered', 'read')
    }
    try {
      await control.query(`CREATE ROLE ${role} LOGIN PASSWORD 'may-log-in'`)
      await control.query(`CREATE ROLE ${role}_nologin NOLOGIN PASSWORD 'may-log-in'`)
      expect({
        mayLogIn: await login(role, 'may-log-in'),
        wrongPassword: await login(role, 'not-its-password'),
        mayNotLogIn: await login(`${role}_nologin`, 'may-log-in'),
      }).toEqual({
        mayLogIn: 'answered',
        wrongPassword: { name: 'StoreAccessRefusedError', state: '28P01' },
        mayNotLogIn: { name: 'StoreAccessRefusedError', state: '28000' },
      })
    } finally {
      for (const executor of opened) await executor.close()
      await control.query(`DROP ROLE IF EXISTS ${role}`)
      await control.query(`DROP ROLE IF EXISTS ${role}_nologin`)
      await control.end()
      await db.close()
    }
  })

  it('types a write an access refusal for a role that may connect and may only read, and answers its read', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'reader-role' })
    const control = createOwnedPostgresPool({ connectionString: serverUrl() })
    const role = `dr_cred_${db.schemaName.slice(-20)}`
    const url = new URL(serverUrl())
    url.username = role
    url.password = 'may-only-read'
    let reader: PgExecutor | undefined
    try {
      await control.query(`CREATE ROLE ${role} LOGIN PASSWORD 'may-only-read'`)
      await control.query(`GRANT USAGE ON SCHEMA ${db.schemaName} TO ${role}`)
      await control.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${db.schemaName} TO ${role}`)
      reader = PgExecutor.open({
        connectionString: url.href,
        options: `-c search_path=${db.schemaName}`,
      })
      const spawned: unknown = await new PostgresSchedulerStore(reader, db.ids)
        .spawn('reader-queue', 'a-task', '{}')
        .then(
          () => 'accepted',
          (error: unknown) => (error as Error).name,
        )
      expect({
        read: await answered(reader, 'SELECT COUNT(*) AS tasks FROM tasks', 'read'),
        write: await answered(reader, 'UPDATE tasks SET attempts = attempts + 1', 'write'),
        // A caller of the port meets the same type as a caller of the executor.
        spawned,
      }).toEqual({
        read: 'answered',
        write: { name: 'StoreAccessRefusedError', state: '42501' },
        spawned: 'StoreAccessRefusedError',
      })
    } finally {
      await reader?.close()
      // The role's privileges go first: a role that still holds one cannot be dropped.
      await control.query(`DROP OWNED BY ${role}`).catch(() => undefined)
      await control.query(`DROP ROLE IF EXISTS ${role}`)
      await control.end()
      await db.close()
    }
  })
})
