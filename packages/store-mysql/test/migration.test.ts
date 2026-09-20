import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import { type Connection, createConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlStoreAdmin } from '../src/admin.js'
import { CURRENT_SCHEMA_VERSION, META_BOOTSTRAP_SQL, MIGRATIONS } from '../src/schema.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * What `migrate()` owes a MySQL database that another migrator left, or still works on.
 * These cases need a MySQL server, and the root vitest configuration leaves this file out
 * of a run that was not given one. The cases themselves are never conditional.
 *
 * Nothing here is left to a race. Where two migrators meet, each is stopped and let go by
 * hand, and a migrator of the released build is sent by hand over a session of its own.
 */

type TestDb = Awaited<ReturnType<typeof openMysqlTestDb>>

// What the released build sends, spelled here and NOT imported: these must not follow the
// source. A deploy runs that build beside this one, so this build has to go on meeting the
// lock under this name, the version under this read, and an advance in this form.
const RELEASED_LOCK_NAME = "SHA2(JSON_ARRAY(DATABASE(), 'durablerun:migrate', '', ''), 256)"
const RELEASED_VERSION_READ = "SELECT value FROM meta WHERE `key` = 'schema_version'"
const RELEASED_ADVANCE = "UPDATE meta SET value = ? WHERE `key` = 'schema_version' AND value = ?"

const text = (sql: string): SqlStatement => ({ sql, args: [] })
const isAVersionBatch = (label: string) => /^migrate:v[0-9]+$/.test(label)

/** A session of its own on the fixture's database, outside the executor's pool. */
async function sessionOn(db: TestDb): Promise<Connection> {
  const uri = process.env.DURABLERUN_MYSQL_URL
  if (!uri) throw new Error('these cases need DURABLERUN_MYSQL_URL')
  return createConnection({ uri, database: db.databaseName })
}

async function one(session: Connection, sql: string): Promise<Record<string, unknown>> {
  const [rows] = await session.query(sql)
  return (rows as Record<string, unknown>[])[0] ?? {}
}

/** As either build's executor sends a statement: a text by itself, binds through the prepared protocol. */
async function send(session: Connection, statements: readonly SqlStatement[]): Promise<void> {
  for (const { sql, args } of statements) {
    if (args.length === 0) await session.query(sql)
    else await session.execute(sql, [...args] as (string | number)[])
  }
}

/** Asks until it holds, for ten seconds at most, and says whether it did. */
async function reached(holds: () => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + 10_000
  while (!(await holds())) {
    if (performance.now() > deadline) return false
  }
  return true
}

/** Every table, column, index and check of the fixture's database, and what `meta` holds. */
async function schemaOf(db: TestDb): Promise<string> {
  const results = await db.raw.batch(
    'fixture:schema',
    [
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS position,
              COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLLATION_NAME AS collation,
              COLUMN_DEFAULT AS column_default
         FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, SEQ_IN_INDEX AS position,
              COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, SUB_PART AS prefix
         FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      `SELECT CONSTRAINT_NAME AS constraint_name, CHECK_CLAUSE AS clause
         FROM information_schema.check_constraints
        WHERE CONSTRAINT_SCHEMA = DATABASE()
        ORDER BY CONSTRAINT_NAME`,
      'SELECT `key`, value FROM meta ORDER BY `key`',
    ].map(text),
    'read',
  )
  return JSON.stringify(
    results.map(({ rows }) => rows),
    (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
    1,
  )
}

async function cleanSchema(): Promise<string> {
  const clean = await openMysqlTestDb({ idNamespace: 'migration-clean' })
  return schemaOf(clean).finally(() => clean.close())
}

const against = (clean: string, schema: string) =>
  schema === clean ? 'what a clean migration leaves' : 'differs from a clean migration'

/** A database at a version, built by hand: the versions up to it whole, and that version recorded. */
async function databaseAt(version: number, seed: string): Promise<TestDb> {
  const db = await openMysqlTestDb({ idNamespace: seed, migrate: false })
  try {
    await db.raw.batch('fixture:database-at-a-version', [
      text(META_BOOTSTRAP_SQL),
      ...MIGRATIONS.filter((migration) => migration.version <= version)
        .flatMap(({ statements }) => statements)
        .map(text),
      {
        sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version'",
        args: [String(version)],
      },
    ])
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}

class StoppedBeforeItsBatch extends Error {}

/** The batch the real admin plans for a database, taken where the admin would send it. */
async function plannedBatch(db: TestDb): Promise<SqlStatement[]> {
  const planned: SqlStatement[] = []
  const stopping: SqlExecutor = {
    batch: async (label, statements, control) => {
      if (!isAVersionBatch(label)) return db.raw.batch(label, statements, control)
      planned.push(...statements)
      throw new StoppedBeforeItsBatch()
    },
  }
  await expect(new MysqlStoreAdmin(stopping).migrate()).rejects.toBeInstanceOf(
    StoppedBeforeItsBatch,
  )
  return planned
}

/**
 * The version a migrator leaves recorded when it dies after `ran` statements of its batch.
 *
 * An advance is ordinary DML inside the batch's transaction. A statement that commits by
 * itself, which is every migration statement but the four forms below, commits what is
 * pending and ENDS that transaction. So an advance sent before the first such statement is
 * lost with the session unless that statement was reached, and an advance sent after it
 * finds no transaction open and commits at once, under the session's autocommit.
 */
function versionLeft(from: number, planned: readonly SqlStatement[], ran: number): number {
  const leavesTheTransactionOpen = /^(UPDATE meta |SET @|PREPARE |DEALLOCATE PREPARE )/
  const sent = planned.slice(0, ran)
  if (sent.every(({ sql }) => leavesTheTransactionOpen.test(sql))) return from
  return sent.reduce(
    (version, { sql, args }) => (sql === RELEASED_ADVANCE ? Number(args[0]) : version),
    from,
  )
}

describe('a MySQL migrator that died inside its batch', () => {
  it('is finished by the next migrate(), wherever it died and whatever it had planned from', async () => {
    // MySQL commits each DDL statement on its own, and one batch carries every version that
    // is pending, so a migrator can die after any statement of that batch and no transaction
    // undoes what it ran. The next `migrate()` has to finish over whatever that leaves. For
    // every version a database can be at, the batch the real admin plans from there is sent
    // by hand up to each of its statements in turn, under the lock and inside a transaction
    // as the executor sends it, and the session is then destroyed. The state is the
    // server's own: what its implicit commits made durable, and nothing of what was pending.
    const clean = await cleanSchema()
    const outcomes: Record<string, unknown>[] = []
    const expected: Record<string, unknown>[] = []
    for (let from = 0; from < CURRENT_SCHEMA_VERSION; from += 1) {
      // The plan depends on the version it is made from and on nothing else.
      let plan: SqlStatement[] | undefined
      for (let ran = 1; ran <= (plan?.length ?? 1); ran += 1) {
        const db = await databaseAt(from, `died-from-${from}-after-${ran}`)
        const dying = await sessionOn(db)
        const watcher = await sessionOn(db)
        try {
          plan ??= await plannedBatch(db)
          const planned = plan
          const { id } = await one(dying, 'SELECT CONNECTION_ID() AS id')
          await one(dying, `SELECT GET_LOCK(${RELEASED_LOCK_NAME}, 0) AS acquired`)
          await dying.query('START TRANSACTION')
          await send(dying, planned.slice(0, ran))
          dying.destroy()
          // The server ends the session: it rolls back what was pending and frees the lock.
          const ended = await reached(async () => {
            const { sessions } = await one(
              watcher,
              `SELECT COUNT(*) AS sessions FROM performance_schema.threads
                WHERE PROCESSLIST_ID = ${Number(id)}`,
            )
            return Number(sessions) === 0
          })
          if (!ended) throw new Error('the server did not end the session that died')
          const left = await db.admin.schemaVersion()
          const migrate = await db.admin.migrate().then(
            () => 'finished',
            (error: unknown) => String(error),
          )
          outcomes.push({
            plannedFrom: from,
            diedAfterStatement: ran,
            versionLeft: left,
            migrate,
            versionAfter: await db.admin.schemaVersion(),
            schema: against(clean, await schemaOf(db)),
          })
          expected.push({
            plannedFrom: from,
            diedAfterStatement: ran,
            versionLeft: versionLeft(from, planned, ran),
            migrate: 'finished',
            versionAfter: CURRENT_SCHEMA_VERSION,
            schema: 'what a clean migration leaves',
          })
        } finally {
          dying.destroy()
          await watcher.end().catch(() => undefined)
          await db.close()
        }
      }
    }
    // Every statement of every plan is a place to die, the versions' own and the advances.
    expect(outcomes.length).toBeGreaterThan(
      MIGRATIONS.reduce((count, { statements }) => count + statements.length + 1, 0),
    )
    expect(outcomes, 'mutation-verdict:behavior:mysql-index-form-is-safe-to-repeat').toEqual(
      expected,
    )
  }, 300_000)
})

describe('a MySQL migrator that planned from a version that has since moved', () => {
  // The version is read before the lock is held. By the time the batch runs, another
  // migrator can have applied some or all of what it holds.

  it('runs its whole batch over a database another migrator finished, and changes nothing', async () => {
    const clean = await cleanSchema()
    const db = await openMysqlTestDb({ idNamespace: 'overtaken-by-this-build', migrate: false })
    try {
      let overtaken = false
      const advancesMatched: number[] = []
      const late: SqlExecutor = {
        batch: async (label, statements, control) => {
          if (!isAVersionBatch(label)) return db.raw.batch(label, statements, control)
          if (!overtaken) {
            // The other migrator held the lock for its whole batch, and is done.
            overtaken = true
            await db.admin.migrate()
          }
          const results = await db.raw.batch(label, statements, control)
          for (const [at, { sql }] of statements.entries()) {
            if (sql === RELEASED_ADVANCE) advancesMatched.push(results[at]?.rowsAffected ?? -1)
          }
          return results
        },
      }
      await new MysqlStoreAdmin(late).migrate()
      // An advance whose version is already past matches no row. It is not an error.
      expect(
        {
          overtaken,
          advancesMatched,
          version: await db.admin.schemaVersion(),
          schema: against(clean, await schemaOf(db)),
        },
        'mutation-verdict:behavior:mysql-advance-is-guarded-on-the-version-before',
      ).toEqual({
        overtaken: true,
        advancesMatched: MIGRATIONS.map(() => 0),
        version: CURRENT_SCHEMA_VERSION,
        schema: 'what a clean migration leaves',
      })
    } finally {
      await db.close()
    }
  }, 60_000)

  it('meets a migrator of the released build between two of its versions, in either order', async () => {
    // The released build migrates one version at a time: it reads the version, and then
    // sends that version's batch under the lock. Here it runs by hand, stopped after its
    // read and before its write of each version in turn, which is a state only a deploy of
    // two builds reaches. Either this build's migrator then runs to the end and the released
    // one goes on over a finished database, or this build's migrator has planned, the
    // released one writes one more version first, and the plan is one version behind.
    const clean = await cleanSchema()
    const gate = () => {
      let open = (): void => undefined
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      return { open, opened }
    }
    const meeting = async (stoppedBefore: number, first: 'this build' | 'the released build') => {
      const db = await openMysqlTestDb({
        idNamespace: `meets-released-${stoppedBefore}-${first === 'this build' ? 'this-first' : 'released-first'}`,
        migrate: false,
      })
      const released = await sessionOn(db)
      const write = async (statements: readonly SqlStatement[]) => {
        await one(released, `SELECT GET_LOCK(${RELEASED_LOCK_NAME}, 30) AS acquired`)
        await released.query('START TRANSACTION')
        await send(released, statements)
        await released.query('COMMIT')
        await one(released, `SELECT RELEASE_LOCK(${RELEASED_LOCK_NAME}) AS released`)
      }
      const stopped = gate()
      const goOn = gate()
      const wroteOneMore = gate()
      const thisBuildIsDone = gate()
      const releasedBuild = async () => {
        await write([text(META_BOOTSTRAP_SQL)])
        for (const { version, statements } of MIGRATIONS) {
          const recorded = Number((await one(released, RELEASED_VERSION_READ)).value)
          if (version === stoppedBefore + 1) {
            wroteOneMore.open()
            if (first === 'the released build') await thisBuildIsDone.opened
          }
          if (recorded >= version) continue
          if (version === stoppedBefore) {
            stopped.open()
            await goOn.opened
          }
          await write([
            ...statements.map(text),
            { sql: RELEASED_ADVANCE, args: [String(version), String(version - 1)] },
          ])
        }
        wroteOneMore.open()
      }
      try {
        const releasedOutcome = releasedBuild().then(
          () => 'finished',
          (error: unknown) => String(error),
        )
        await stopped.opened
        const plannedFrom: number[] = []
        const thisBuild: SqlExecutor = {
          batch: async (label, statements, control) => {
            if (isAVersionBatch(label) && plannedFrom.length === 0) {
              plannedFrom.push(await db.admin.schemaVersion())
              if (first === 'the released build') {
                goOn.open()
                await wroteOneMore.opened
              }
            }
            return db.raw.batch(label, statements, control)
          },
        }
        const thisOutcome = await new MysqlStoreAdmin(thisBuild).migrate().then(
          () => 'finished',
          (error: unknown) => String(error),
        )
        thisBuildIsDone.open()
        goOn.open()
        return {
          releasedBuildStoppedBeforeVersion: stoppedBefore,
          first,
          thisBuildPlannedFrom: plannedFrom,
          thisBuild: thisOutcome,
          releasedBuild: await releasedOutcome,
          version: await db.admin.schemaVersion(),
          schema: against(clean, await schemaOf(db)),
        }
      } finally {
        thisBuildIsDone.open()
        goOn.open()
        await released.end().catch(() => undefined)
        await db.close()
      }
    }

    const outcomes: Record<string, unknown>[] = []
    for (const { version } of MIGRATIONS) {
      outcomes.push(await meeting(version, 'this build'))
      outcomes.push(await meeting(version, 'the released build'))
    }
    expect(outcomes).toEqual(
      MIGRATIONS.flatMap(({ version }) =>
        (['this build', 'the released build'] as const).map((first) => ({
          releasedBuildStoppedBeforeVersion: version,
          first,
          thisBuildPlannedFrom: [version - 1],
          thisBuild: 'finished',
          releasedBuild: 'finished',
          version: CURRENT_SCHEMA_VERSION,
          schema: 'what a clean migration leaves',
        })),
      ),
    )
  }, 120_000)
})

describe('a MySQL migrator beside one of the released build', () => {
  it('waits for the migration lock as that build takes it, and migrates once it is free', async () => {
    // Two builds take turns only if both take one lock. A change to the name this build
    // takes fails this case, because the name above does not follow the source.
    const db = await openMysqlTestDb({ idNamespace: 'released-build-lock', migrate: false })
    const released = await sessionOn(db)
    try {
      expect(
        (await one(released, `SELECT GET_LOCK(${RELEASED_LOCK_NAME}, 0) AS acquired`)).acquired,
      ).toBe(1)

      let settled = 'still waiting'
      const migrating = db.admin.migrate().then(
        () => {
          settled = 'migrated'
        },
        (error: unknown) => {
          settled = String(error)
        },
      )
      // The server's own lock table says when a session waits for that very name.
      let waiting = 0
      await reached(async () => {
        const pending = await one(
          released,
          `SELECT COUNT(*) AS waiting FROM performance_schema.metadata_locks
              WHERE OBJECT_TYPE = 'USER LEVEL LOCK' AND LOCK_STATUS = 'PENDING'
                AND OBJECT_NAME = ${RELEASED_LOCK_NAME}`,
        )
        waiting = Number(pending.waiting)
        return waiting > 0 || settled !== 'still waiting'
      })
      const { tables } = await one(
        released,
        'SELECT COUNT(*) AS tables FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()',
      )
      expect(
        { waiting, settled, tablesWrittenMeanwhile: Number(tables) },
        'mutation-verdict:behavior:mysql-migration-lock-keeps-the-released-name',
      ).toEqual({
        waiting: 1,
        settled: 'still waiting',
        tablesWrittenMeanwhile: 0,
      })

      await one(released, `SELECT RELEASE_LOCK(${RELEASED_LOCK_NAME}) AS released`)
      await migrating
      expect(settled).toBe('migrated')
      expect(await db.admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    } finally {
      await released.end().catch(() => undefined)
      await db.close()
    }
  }, 60_000)
})

describe('a MySQL database where an event already holds SQL NULL', () => {
  // The port cannot write this row, so it is a foreign writer's or tampering. Version 10
  // makes the payload NOT NULL.
  const FOREIGN_WRITE = text(
    "INSERT INTO events (queue, event_name, payload, emitted_at_ms) VALUES ('q', 'held-null', NULL, 1)",
  )
  const observed = async (db: TestDb) => {
    const session = await sessionOn(db)
    try {
      return {
        version: (await one(session, RELEASED_VERSION_READ)).value,
        column: (
          await one(
            session,
            `SELECT is_nullable AS nullable FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'events' AND column_name = 'payload'`,
          )
        ).nullable,
        held: (await one(session, "SELECT payload FROM events WHERE event_name = 'held-null'"))
          .payload,
      }
    } finally {
      await session.end()
    }
  }

  it('stops at the version before, and leaves the column nullable and the row as it was', async () => {
    // The server refuses the change with error 1138, and only because the executor sets a
    // strict mode on every connection it takes: the next case is the same change without one.
    const db = await databaseAt(9, 'null-payload-refused')
    try {
      await db.raw.batch('fixture:foreign-writer', [FOREIGN_WRITE])
      const refusal = await new MysqlStoreAdmin(db.raw).migrate().then(
        () => 'resolved',
        (error: unknown) => /MySQL error \d+/.exec(String(error))?.[0] ?? String(error),
      )
      const stopped = await observed(db)
      await db.raw.batch('fixture:repair', [
        text(`UPDATE events SET payload = '{"repaired":1}' WHERE payload IS NULL`),
      ])
      await new MysqlStoreAdmin(db.raw).migrate()

      expect(
        { refusal, stopped, repaired: await observed(db) },
        'mutation-verdict:behavior:mysql-strict-mode-refuses-a-null-payload',
      ).toEqual({
        refusal: 'MySQL error 1138',
        stopped: { version: '9', column: 'YES', held: null },
        repaired: {
          version: String(CURRENT_SCHEMA_VERSION),
          column: 'NO',
          held: '{"repaired":1}',
        },
      })
    } finally {
      await db.close()
    }
  })

  it('is given an empty string by the same change in a session with no strict mode', async () => {
    // A fact about the server that the case above depends on. Outside a strict mode MySQL
    // does not refuse to make a column NOT NULL over a row that holds NULL. It stores the
    // column type's default where the NULL was, with a warning, and a waiter would then read
    // a delivered event whose payload is not JSON. Version 10's statements are sent here as
    // they are, over a session that the executor did not set up.
    const db = await databaseAt(9, 'null-payload-no-strict-mode')
    try {
      await db.raw.batch('fixture:foreign-writer', [FOREIGN_WRITE])
      const session = await sessionOn(db)
      try {
        await session.query("SET SESSION sql_mode = ''")
        const version10 = MIGRATIONS.find(({ version }) => version === 10)
        for (const statement of version10?.statements ?? []) await session.query(statement)
      } finally {
        await session.end()
      }
      expect(await observed(db)).toEqual({ version: '9', column: 'NO', held: '' })
    } finally {
      await db.close()
    }
  })
})
