import { StoreUnavailableError } from '@durablerun/core'
import { type Connection, createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor, classifyError, createOwnedMysqlPool } from '../src/executor.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * How the executor types what a real MySQL server answers. The executor's own cases run on
 * a fake connection that is fed the numbers their author listed, so they can only agree
 * with that list. These cases ask the server. They need one, as the conformance suite's
 * MySQL leg does, and are never conditional.
 */

const serverUrl = (): string => {
  const url = process.env.DURABLERUN_MYSQL_URL
  if (!url) throw new Error('these cases need DURABLERUN_MYSQL_URL')
  return url
}

describe('MysqlExecutor error typing against a real server', () => {
  it('types an account past its connection limit an outage, and the same batch is answered once a connection is free', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'connection-limit' })
    const control = createOwnedMysqlPool({ uri: serverUrl(), connectionLimit: 1 })
    // An account of this case's own, held to one connection. The limit is the account's:
    // no setting of the server moves, so nothing else connected to it can meet the limit.
    const account = `dr_limit_${db.databaseName.slice(-16)}`
    const limited = new URL(serverUrl())
    limited.username = account
    limited.password = 'one-connection'
    limited.pathname = `/${db.databaseName}`
    let executor: MysqlExecutor | undefined
    let holder: Connection | undefined
    try {
      await control.query(
        `CREATE USER '${account}'@'%' IDENTIFIED BY 'one-connection' WITH MAX_USER_CONNECTIONS 1`,
      )
      await control.query(`GRANT ALL ON ${db.databaseName}.* TO '${account}'@'%'`)
      holder = await createConnection(limited.href)
      executor = MysqlExecutor.open(limited.href)
      const batch = () =>
        (executor as MysqlExecutor)
          .batch('fixture:one-more-connection', [{ sql: 'SELECT 1 AS answered', args: [] }], 'read')
          .then(
            () => 'answered',
            (error: unknown) => error,
          )
      const refused = await batch()
      expect(String(refused)).toContain('MySQL error 1226')
      expect(refused).toBeInstanceOf(StoreUnavailableError)

      // The retry an outage invites works: the server frees the account's slot a moment
      // after the holder's connection ends.
      await holder.end()
      holder = undefined
      let retried: unknown = refused
      for (let attempt = 0; attempt < 100 && retried !== 'answered'; attempt++) {
        retried = await batch()
        if (retried !== 'answered') await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(retried).toBe('answered')
    } finally {
      await executor?.close()
      await holder?.end()
      await control.query(`DROP USER IF EXISTS '${account}'@'%'`)
      await control.end()
      await db.close()
    }
  })
})

describe('what a real MySQL server answers a refused statement', () => {
  it('is typed permanent by its class, or by its number where MySQL files it outside the classes', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'refused-statements', migrate: false })
    try {
      await db.raw.batch('fixture:a-strict-table', [
        {
          sql: 'CREATE TABLE strict (id BIGINT PRIMARY KEY, n BIGINT NOT NULL DEFAULT 0, label VARCHAR(8) NOT NULL)',
          args: [],
        },
      ])
      const answered = (sql: string, args: (string | number)[] = []) =>
        db.raw.batch('fixture:refused', [{ sql, args }]).then(
          () => 'answered',
          (error: unknown) => ({
            name: (error as Error).name,
            errno: ((error as Error).cause as { errno?: unknown } | undefined)?.errno,
            state: ((error as Error).cause as { sqlState?: unknown } | undefined)?.sqlState,
          }),
        )
      expect({
        syntaxError: await answered('SELEC 1'),
        valueOutOfRange: await answered(
          "INSERT INTO strict (id, n, label) VALUES (1, 9223372036854775807 + 1, 'a')",
        ),
        divisionByZero: await answered("INSERT INTO strict (id, n, label) VALUES (1, 1 / 0, 'a')"),
        textForANumber: await answered("INSERT INTO strict (id, n, label) VALUES (1, ?, 'a')", [
          '',
        ]),
        textThatIsNoNumber: await answered("INSERT INTO strict (id, n, label) VALUES (1, ?, 'a')", [
          '12abc',
        ]),
        columnLeftOut: await answered('INSERT INTO strict (id) VALUES (1)'),
      }).toEqual({
        syntaxError: { name: 'PermanentStoreError', errno: 1064, state: '42000' },
        valueOutOfRange: { name: 'PermanentStoreError', errno: 1690, state: '22003' },
        divisionByZero: { name: 'PermanentStoreError', errno: 1365, state: '22012' },
        textForANumber: { name: 'PermanentStoreError', errno: 1366, state: 'HY000' },
        textThatIsNoNumber: { name: 'PermanentStoreError', errno: 1265, state: '01000' },
        columnLeftOut: { name: 'PermanentStoreError', errno: 1364, state: 'HY000' },
      })
    } finally {
      await db.close()
    }
  })
})

/**
 * The executor types an answer by its SQLSTATE class, and keeps a few numbers by hand where
 * MySQL files an answer under a class that says the opposite of what a retry does. Every one
 * of those numbers was found late, one at a time, because the executor's cases ran on a fake
 * connection fed the numbers their author listed. The server knows its own list, so this
 * reads it: every error number it can send a client, with the name and the state it files it
 * under. A number whose NAME disagrees with what the executor answers must be in one of the
 * executor's lists, or be explained here. A server version that adds such a number fails the
 * case until someone decides what it is. What a name can say bounds both rules: typed
 * permanent by mistake, a limit whose name uses none of the first rule's words passes it, as
 * 1040 `ER_CON_COUNT_ERROR`, the server's max_connections, and 1037 `ER_OUTOFMEMORY` do.
 */
describe('the numbers MySQL files apart from what their names say', () => {
  type Filed = { readonly n: number; readonly name: string; readonly state: string }
  const PERMANENT_CLASSES = new Set(['22', '23', '42'])

  /** Every error number the server can send a client. From 10000 on they are log messages. */
  const filedByTheServer = async (): Promise<Filed[]> => {
    const db = await openMysqlTestDb({ idNamespace: 'error-list', migrate: false })
    try {
      const [read] = await db.raw.batch(
        'fixture:error-list',
        [
          {
            sql: `SELECT ERROR_NUMBER AS n, ERROR_NAME AS name, SQL_STATE AS state
                  FROM performance_schema.events_errors_summary_global_by_error
                  WHERE ERROR_NUMBER < 10000 ORDER BY ERROR_NUMBER`,
            args: [],
          },
        ],
        'read',
      )
      return (read?.rows ?? []).map((row) => ({
        n: Number(row.n),
        name: String(row.name),
        state: String(row.state),
      }))
    } finally {
      await db.close()
    }
  }
  const typed = ({ n, name, state }: Filed): string =>
    classifyError(Object.assign(new Error(name), { errno: n, sqlState: state }), 'list', false).name
  const line = ({ n, name, state }: Filed): string => `${n} ${name} (${state})`

  /** A name that says the server, or an account, ran out of something another session holds. */
  const SAYS_A_LIMIT =
    /LIMIT|RESOURCE|TOO_MANY|MAX_|_REACHED|CONNECTION|LOCK|TIMEOUT|OVERFLOW|_FULL|BUSY|EXCEED/
  /** Numbers whose name says a limit, and which a retry does not cure all the same. */
  const A_LIMIT_NO_RETRY_LIFTS: Readonly<Record<number, string>> = {
    1069: 'too many keys in a table definition: the same DDL is refused every time',
    1070: 'too many parts in a key definition: the same DDL is refused every time',
    1172: 'a SELECT INTO found more than one row: the data decides it, and no load does',
    1441: 'a value a date function cannot hold',
    3057: "a named lock's name is refused, not the lock",
    3131: "a locking service lock's name is refused, not the lock",
    3670: "a JSON_TABLE definition's nesting",
    4163: "a named lock's name is too long, and the same call repeats it",
  }

  it('types a number permanent, by its class or by hand, only when no retry lifts what its name says', async () => {
    // Whatever class MySQL files it under: a class types most numbers permanent, and the
    // list the executor keeps by hand must not name a limit either.
    const saysALimit = (await filedByTheServer()).filter((filed) => SAYS_A_LIMIT.test(filed.name))
    const underAPermanentClass = saysALimit.filter((filed) =>
      PERMANENT_CLASSES.has(filed.state.slice(0, 2)),
    )
    expect(
      {
        underAPermanentClass: underAPermanentClass.length > 3,
        outsideThem: saysALimit.length - underAPermanentClass.length > 3,
      },
      'the selection found the limits it is about, under the permanent classes and outside them',
    ).toEqual({ underAPermanentClass: true, outsideThem: true })
    expect(
      {
        typedPermanentWithNoReason: saysALimit
          .filter((filed) => typed(filed) === 'PermanentStoreError')
          .filter((filed) => A_LIMIT_NO_RETRY_LIFTS[filed.n] === undefined)
          .map(line),
        reasonsForNumbersNotSelected: Object.keys(A_LIMIT_NO_RETRY_LIFTS).filter(
          (n) => !saysALimit.some((filed) => filed.n === Number(n)),
        ),
      },
      'mutation-verdict:behavior:mysql-error-list-holds-the-limits-under-a-permanent-class',
    ).toEqual({ typedPermanentWithNoReason: [], reasonsForNumbersNotSelected: [] })
  })

  /** A name that says the statement's own value or row was refused. */
  const SAYS_A_REFUSED_VALUE =
    /CONSTRAINT|NO_DEFAULT|TRUNCAT|WRONG_VALUE|BAD_NULL|OUT_OF_RANGE|DUP_ENTRY|DIVISION_BY_ZERO|DATA_TOO_LONG|NOT_NULL/
  /** What a reason below says the store's schema lacks. The last case reads each one. */
  type SchemaFact =
    | 'views'
    | 'autoIncrementColumns'
    | 'temporalColumns'
    | 'functionalKeyParts'
    | 'storedPrograms'
  /** Why a number whose name says so is still not typed permanent, by what its name says. */
  const NOT_A_REFUSED_WRITE_OF_THE_STORE: readonly (readonly [
    names: RegExp,
    reason: string,
    restsOn?: SchemaFact,
  ])[] = [
    [
      /^ER_WRONG_VALUE_COUNT/,
      'a statement whose column count is wrong, SQLSTATE class 21, which stays an outage by a recorded decision (BUILD.md, PR2.5a)',
    ],
    [
      /^ER_(FK_|ALTER_|CANNOT_CREATE_VIRTUAL|NON_BOOLEAN_EXPR_FOR_CHECK|COLUMN_CHECK_CONSTRAINT|CHECK_CONSTRAINT_(?!VIOLATED)|MULTIPLE_CONSTRAINTS|CONSTRAINT_NOT_FOUND|DEPENDENT_BY_CHECK|INNODB_AUTOEXTEND|PARTITION_)/,
      'refuses a DEFINITION. Only a migration sends DDL, and a migration that fails is reported to its caller whatever its type',
    ],
    [
      /REPLICA_|SOURCE_|RPL_|GTID|WRONG_VALUE_FOR_VAR/,
      'a replication or server setting, which no statement of the store sets',
    ],
    [/^ER_(LH_|LOAD_BULK_DATA)/, 'a bulk load, and the store sends no LOAD DATA statement'],
    [
      /^ER_WRONG_VALUE(_FOR_TYPE)?$/,
      'an argument a function or an administrative statement refuses: the store binds values to columns, which answers 1366 or a class 22 number. 1525 also answers a DATE column compared with text that is no date, and the store has no temporal column',
      'temporalColumns',
    ],
    [
      /^ER_NO_DEFAULT_FOR_VIEW_FIELD$/,
      'an insert through a view, and the store has no view',
      'views',
    ],
    [
      /^ER_DUP_ENTRY_AUTOINCREMENT_CASE$/,
      'no table of the store has an auto-increment column',
      'autoIncrementColumns',
    ],
    [
      /^WARN_COND_ITEM_TRUNCATED$/,
      "a SIGNAL statement's condition item: the store sends no SIGNAL, and has no stored program that could",
      'storedPrograms',
    ],
    [/^ER_STD_OUT_OF_RANGE_ERROR$/, 'an exception inside the server, not a refusal of a value'],
    [
      /^ER_WARN_DATA_TRUNCATED_FUNCTIONAL_INDEX$/,
      'the store has no functional index',
      'functionalKeyParts',
    ],
    [
      /^ER_VALUE_OUT_OF_RANGE$/,
      "a setting outside its valid range, which the server clamps (its message file: '%s=%llu is outside the valid range [%llu,%llu]. %llu will be used.'), and no statement of the store sets one",
    ],
  ]

  it('types a refused value or row permanent whatever state MySQL files it under, or says why not', async () => {
    const outsideThePermanentClasses = (await filedByTheServer()).filter(
      (filed) =>
        !PERMANENT_CLASSES.has(filed.state.slice(0, 2)) && SAYS_A_REFUSED_VALUE.test(filed.name),
    )
    const reasonsFor = (filed: Filed) =>
      NOT_A_REFUSED_WRITE_OF_THE_STORE.filter(([names]) => names.test(filed.name))
    const notPermanent = outsideThePermanentClasses.filter(
      (filed) => typed(filed) !== 'PermanentStoreError',
    )
    expect(
      {
        typedPermanent: outsideThePermanentClasses
          .filter((filed) => typed(filed) === 'PermanentStoreError')
          .map(line),
        leftAnOutageWithNoOneReason: notPermanent
          .filter((filed) => reasonsFor(filed).length !== 1)
          .map(line),
        reasonsThatExplainNothing: NOT_A_REFUSED_WRITE_OF_THE_STORE.filter(
          ([names]) => !notPermanent.some((filed) => names.test(filed.name)),
        ).map(([names]) => String(names)),
      },
      'mutation-verdict:behavior:mysql-error-list-holds-the-refused-values-outside-the-classes',
    ).toEqual({
      typedPermanent: [
        '1265 WARN_DATA_TRUNCATED (01000)',
        '1364 ER_NO_DEFAULT_FOR_FIELD (HY000)',
        '1366 ER_TRUNCATED_WRONG_VALUE_FOR_FIELD (HY000)',
        '3819 ER_CHECK_CONSTRAINT_VIOLATED (HY000)',
      ],
      leftAnOutageWithNoOneReason: [],
      reasonsThatExplainNothing: [],
    })
  })

  /**
   * A reason that rests on what the store's schema lacks is only as true as the schema. The
   * facts are read here from a migrated database, so a migration that adds a view, say, fails
   * this case until its reason is looked at again. A reason about which STATEMENTS the store
   * sends, a bulk load or a SIGNAL, is held by no read.
   */
  it('reads from a migrated database what the reasons above say its schema lacks', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'schema-facts' })
    try {
      const [read] = await db.raw.batch(
        'fixture:schema-facts',
        [
          {
            sql: `SELECT
              (SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS baseTables,
              (SELECT COUNT(*) FROM information_schema.VIEWS
                WHERE TABLE_SCHEMA = DATABASE()) AS views,
              (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND EXTRA LIKE '%auto_increment%') AS autoIncrementColumns,
              (SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND DATA_TYPE IN ('date', 'datetime', 'timestamp', 'time', 'year')) AS temporalColumns,
              (SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND EXPRESSION IS NOT NULL) AS functionalKeyParts,
              (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE())
                + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE())
                + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE())
                AS storedPrograms`,
            args: [],
          },
        ],
        'read',
      )
      const counted = (fact: string): number => Number(read?.rows[0]?.[fact])
      expect(counted('baseTables'), 'the read saw the migrated schema').toBeGreaterThan(3)
      const restedOn = NOT_A_REFUSED_WRITE_OF_THE_STORE.flatMap(([, , fact]) =>
        fact === undefined ? [] : [fact],
      )
      expect(new Set(restedOn).size, 'the reasons name the facts this case reads').toBe(5)
      expect(Object.fromEntries(restedOn.map((fact) => [fact, counted(fact)]))).toEqual(
        Object.fromEntries(restedOn.map((fact) => [fact, 0])),
      )
    } finally {
      await db.close()
    }
  })
})
