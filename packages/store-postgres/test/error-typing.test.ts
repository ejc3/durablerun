import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { PgExecutor, createOwnedPostgresPool } from '../src/executor.js'
import { SCHEMA_VERSION_READ_SQL } from '../src/schema.js'
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
  const answered = (
    executor: PgExecutor,
    sql: string,
    mode: 'read' | 'write',
    label = 'fixture:refused-access',
  ) =>
    executor.batch(label, [{ sql, args: [] }], mode).then(
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

  it('types a write an access refusal for a role that may connect and may only read, by SQLSTATE 42501, and answers its read', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'reader-role' })
    try {
      const reader = await db.openAsAReader()
      try {
        expect({
          read: await answered(reader.raw, 'SELECT COUNT(*) AS tasks FROM tasks', 'read'),
          write: await answered(reader.raw, 'UPDATE tasks SET attempts = attempts + 1', 'write'),
          create: await answered(reader.raw, 'CREATE TABLE made_by_a_reader (id BIGINT)', 'write'),
        }).toEqual({
          read: 'answered',
          write: { name: 'StoreAccessRefusedError', state: '42501' },
          create: { name: 'StoreAccessRefusedError', state: '42501' },
        })
      } finally {
        await reader.close()
      }
    } finally {
      await db.close()
    }
  })

  // The two cases below record a boundary. They hold what the executor answers today for two
  // refusals the server does not answer with class 28 or 42501, so that the list of typed
  // refusals in DESIGN.md says no more than a server was measured to answer. Neither answer
  // is a promise: a change that types one of these a refusal changes its case with it.
  it('records a boundary: a URL with no password, which the client declines to send to a server that asks for one, is typed an outage', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'no-password', migrate: false })
    // node-postgres takes a password from this variable when the URL has none.
    const kept = process.env.PGPASSWORD
    Reflect.deleteProperty(process.env, 'PGPASSWORD')
    const url = new URL(serverUrl())
    url.password = ''
    const executor = PgExecutor.open({ connectionString: url.href })
    try {
      const failure: unknown = await executor
        .batch('fixture:refused-access', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
        .then(
          () => 'answered',
          (error: unknown) => error,
        )
      const cause = (failure as Error).cause as Error & { code?: unknown }
      expect({
        name: (failure as Error).name,
        // The driver made this error itself, before any answer of the server about the login.
        // It is a plain Error with no code, as "Connection terminated unexpectedly" is.
        cause: cause?.constructor?.name,
        code: cause?.code,
        // The control that this is the refusal measured and no other failure to connect. It
        // is read here from the driver's message, which the executor never reads.
        clientDeclined: /client password must be a string/.test(cause?.message ?? ''),
        // What a caller who asks for the store's message is shown.
        messageQuotesTheDriver: (failure as Error).message.includes(cause?.message ?? 'absent'),
      }).toEqual({
        name: 'StoreUnavailableError',
        cause: 'Error',
        code: undefined,
        clientDeclined: true,
        messageQuotesTheDriver: true,
      })
    } finally {
      if (kept !== undefined) process.env.PGPASSWORD = kept
      await executor.close()
      await db.close()
    }
  })

  it('records a boundary: a role with no USAGE on the schema is answered 42P01, so its reads are typed a schema error, and its version read does not stop a migrate', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'no-usage-of-the-schema' })
    try {
      const role = await db.openAsAReaderWithNoUsageOfTheSchema()
      try {
        const admin = new PostgresStoreAdmin(role.raw)
        const versionBefore = await db.admin.schemaVersion()
        const migrate = await admin.migrate().then(
          () => 'answered',
          (error: unknown) => ({
            name: (error as Error).name,
            state: ((error as Error).cause as { code?: unknown } | undefined)?.code,
          }),
        )
        expect({
          versionRead: await answered(role.raw, SCHEMA_VERSION_READ_SQL, 'read', 'migrate:version'),
          anotherRead: await answered(role.raw, 'SELECT count(*) AS n FROM tasks', 'read'),
          // The control: the role is refused, and the server says so with 42501, where the
          // statement names the schema. PostgreSQL skips a schema of the search path that
          // the role may not use, so a statement that names none finds no table.
          readThatNamesTheSchema: await answered(
            role.raw,
            `SELECT count(*) AS n FROM ${db.schemaName}.tasks`,
            'read',
          ),
          versionTheRoleReads: await admin.schemaVersion(),
          ownerHasAVersion: versionBefore > 0,
          migrate,
          versionIsUnchanged: (await db.admin.schemaVersion()) === versionBefore,
        }).toEqual({
          versionRead: { name: 'SchemaNotInitializedError', state: '42P01' },
          anotherRead: { name: 'SchemaMismatchError', state: '42P01' },
          readThatNamesTheSchema: { name: 'StoreAccessRefusedError', state: '42501' },
          versionTheRoleReads: 0,
          ownerHasAVersion: true,
          // The version read answered "never initialized", so the migrate sent its first
          // write. What stopped it is the server: this role's search path names no schema it
          // may create in.
          migrate: { name: 'SchemaMismatchError', state: '3F000' },
          versionIsUnchanged: true,
        })
      } finally {
        await role.close()
      }
    } finally {
      await db.close()
    }
  })

  it('records a boundary: where the search path of such a role also names a schema it may create in, a migrate builds the tables a second time there', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'no-usage-and-a-second-schema' })
    const control = createOwnedPostgresPool({ connectionString: serverUrl() })
    // Generated from the lowercase identifier alphabet, as the fixture's own names are.
    const second = `dr_cred_${db.schemaName.slice(-20)}_second`
    let executor: PgExecutor | undefined
    try {
      const role = await db.openAsAReaderWithNoUsageOfTheSchema()
      await control.query(`CREATE SCHEMA ${second}`)
      await control.query(`GRANT USAGE, CREATE ON SCHEMA ${second} TO ${role.username}`)
      const url = new URL(serverUrl())
      url.username = role.username
      url.password = role.password
      executor = PgExecutor.open({
        connectionString: url.href,
        options: `-c search_path=${db.schemaName},${second}`,
      })
      const admin = new PostgresStoreAdmin(executor)
      const tablesIn = async (schema: string): Promise<number> =>
        (await control.query('SELECT 1 FROM pg_tables WHERE schemaname = $1', [schema])).rows.length
      const version = await db.admin.schemaVersion()
      const tables = await tablesIn(db.schemaName)
      const migrate = await admin.migrate().then(
        () => 'answered',
        (error: unknown) => ({
          name: (error as Error).name,
          state: ((error as Error).cause as { code?: unknown } | undefined)?.code,
        }),
      )
      expect({
        storeHasTables: tables > 0,
        migrate,
        secondSchemaHoldsAsManyTables: (await tablesIn(second)) === tables,
        versionTheRoleReadsIsTheBuilds: (await admin.schemaVersion()) === version,
        storeIsUnchanged:
          (await db.admin.schemaVersion()) === version &&
          (await tablesIn(db.schemaName)) === tables,
      }).toEqual({
        storeHasTables: true,
        migrate: 'answered',
        secondSchemaHoldsAsManyTables: true,
        versionTheRoleReadsIsTheBuilds: true,
        storeIsUnchanged: true,
      })
    } finally {
      await executor?.close().catch(() => undefined)
      // The tables the role made go with the schema, and then the fixture can drop the role.
      await control.query(`DROP SCHEMA IF EXISTS ${second} CASCADE`)
      await control.end()
      await db.close()
    }
  })

  // The servers these cases run on are shared, and a reader is a role that may log in. A
  // case that fails before it closes its reader must not leave the role on the server.
  it('drops, at the close of the fixture, a reader that its case never closed', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'reader-left-open' })
    const control = createOwnedPostgresPool({ connectionString: serverUrl() })
    const rolesNamed = async (role: string): Promise<number> =>
      (await control.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length
    let reader: Awaited<ReturnType<typeof db.openAsAReader>> | undefined
    try {
      reader = await db.openAsAReader()
      const before = await rolesNamed(reader.username)
      await db.close()
      expect({ before, after: await rolesNamed(reader.username) }).toEqual({ before: 1, after: 0 })
    } finally {
      await db.close()
      if (reader !== undefined) {
        // What the fixture's close is held to above. These lines leave nothing behind where
        // it did not, and change nothing where it did.
        await reader.raw.close().catch(() => undefined)
        await control.query(`DROP OWNED BY ${reader.username}`).catch(() => undefined)
        await control.query(`DROP ROLE IF EXISTS ${reader.username}`)
      }
      await control.end()
    }
  })
})
