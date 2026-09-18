import { InvalidDurableStringError, SchemaMismatchError } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor } from '../src/executor.js'
import { META_BOOTSTRAP_SQL, META_TABLE_SQL } from '../src/schema.js'
import { MysqlSchedulerStore } from '../src/store.js'
import { openMysqlTestDb } from '../src/testing.js'

/**
 * These cases need a MySQL server, as the conformance suite's MySQL leg does. A run that
 * was told which dialects it has, and was not given MySQL, leaves this file out in the
 * root vitest configuration. The cases themselves are never conditional: a registered
 * test that can skip has told nobody anything.
 */

describe('MysqlExecutor against a real server', () => {
  it('reports rows written as the port means it, whatever MySQL counted', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'rows-written' })
    try {
      const results = await db.raw.batch('fixture:rows-written', [
        { sql: "INSERT INTO meta (`key`, value) VALUES ('k', 'v1')", args: [] },
        // Matches a row and changes nothing: MySQL counts zero changed rows.
        { sql: "UPDATE meta SET value = ? WHERE `key` = 'k'", args: ['v1'] },
        // A conflict arm that changes nothing: a compare-and-set that lost.
        {
          sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE `key` = meta.`key`',
          args: ['k', 'v2'],
        },
        // A conflict arm that updates: MySQL counts two.
        {
          sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?) AS excluded ON DUPLICATE KEY UPDATE value = excluded.value',
          args: ['k', 'v3'],
        },
        { sql: "SELECT value FROM meta WHERE `key` = 'k'", args: [] },
      ])
      expect(results.map(({ rowsAffected }) => rowsAffected)).toEqual([1, 1, 0, 1, 1])
      expect(results[4]?.rows).toEqual([{ value: 'v3' }])
    } finally {
      await db.close()
    }
  })

  it('reports an identifier past the indexed width as invalid input, and writes nothing', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'too-long' })
    try {
      const outcome = await db.raw
        .batch('fixture:too-long', [
          { sql: "INSERT INTO meta (`key`, value) VALUES ('before', 'v')", args: [] },
          { sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?)', args: ['k'.repeat(256), 'v'] },
        ])
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
      expect(
        outcome,
        'mutation-verdict:behavior:mysql-too-long-identifier-is-invalid-input',
      ).toBeInstanceOf(InvalidDurableStringError)
      const [rows] = await db.raw.batch(
        'fixture:read',
        [{ sql: "SELECT COUNT(*) AS n FROM meta WHERE `key` = 'before'", args: [] }],
        'read',
      )
      expect(rows?.rows).toEqual([{ n: 0 }])
    } finally {
      await db.close()
    }
  })

  it('refuses a write MySQL would cut to fit its column, and writes nothing', async () => {
    // MySQL cuts trailing spaces past a VARCHAR's width with a note, in every sql_mode,
    // where any other excess is error 1406. Cut, the value is a different identifier.
    const db = await openMysqlTestDb({ idNamespace: 'cut-to-fit' })
    try {
      const outcome = await db.raw
        .batch('fixture:cut-to-fit', [
          { sql: "INSERT INTO meta (`key`, value) VALUES ('before', 'v')", args: [] },
          {
            sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?)',
            args: [`${'k'.repeat(255)} `, 'v'],
          },
        ])
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
      expect(outcome, 'mutation-verdict:behavior:mysql-write-cut-to-fit-is-refused').toBeInstanceOf(
        InvalidDurableStringError,
      )
      const [rows] = await db.raw.batch(
        'fixture:read',
        [{ sql: "SELECT COUNT(*) AS n FROM meta WHERE value = 'v'", args: [] }],
        'read',
      )
      expect(rows?.rows).toEqual([{ n: 0 }])
    } finally {
      await db.close()
    }
  })

  it('keeps a name with trailing spaces past the width apart from the name it would be cut to', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'trailing-space' })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      const refused = (error: unknown) => error
      const event = await store
        .emitEvent('q', `${'e'.repeat(255)} `, '{"x":1}')
        .then(() => 'accepted', refused)
      expect(event).toBeInstanceOf(InvalidDurableStringError)
      const [events] = await db.raw.batch(
        'fixture:read',
        [{ sql: 'SELECT COUNT(*) AS n FROM events', args: [] }],
        'read',
      )
      expect(events?.rows).toEqual([{ n: 0 }])

      const key = 'i'.repeat(255)
      const spaced = await store
        .spawn('q', 't', '{}', { idempotencyKey: `${key} ` })
        .then(() => 'accepted', refused)
      expect(spaced).toBeInstanceOf(InvalidDurableStringError)
      expect(await store.spawn('q', 't', '{}', { idempotencyKey: key })).toMatchObject({
        created: true,
      })
    } finally {
      await db.close()
    }
  })

  it('sends the session settings once over the real mysql2 pool, which wraps a connection anew on every checkout', async () => {
    // The unit test's pool is a stand-in, and a stand-in that handed out one object is
    // what hid this. Here the server counts: a write batch sends no SET of its own, so
    // the session's Com_set_option moves only when the settings are sent again.
    const db = await openMysqlTestDb({ idNamespace: 'session-once' })
    try {
      const read = async () => {
        const [status, id] = await db.raw.batch('fixture:status', [
          { sql: "SHOW SESSION STATUS LIKE 'Com_set_option'", args: [] },
          { sql: 'SELECT CONNECTION_ID() AS id', args: [] },
        ])
        return { sets: Number(status?.rows[0]?.Value), connection: id?.rows[0]?.id }
      }
      const before = await read()
      for (let batch = 0; batch < 3; batch++) {
        await db.raw.batch('fixture:write', [{ sql: 'SELECT 1 AS one', args: [] }])
      }
      const after = await read()
      expect(after.connection).toBe(before.connection)
      expect(after.sets - before.sets).toBe(0)
    } finally {
      await db.close()
    }
  })

  it('keeps its session settings over a pool that was asked to reset connections on release', async () => {
    // With mysql2's resetOnRelease, every release sends COM_RESET_CONNECTION and the same
    // connection comes back with a fresh session: REPEATABLE READ, the server's time zone,
    // and no strict mode. The settings are sent once for each connection, so the store's
    // own pool must never reset one.
    const db = await openMysqlTestDb({ idNamespace: 'reset-on-release' })
    const url = new URL(process.env.DURABLERUN_MYSQL_URL ?? '')
    url.pathname = `/${db.databaseName}`
    const executor = MysqlExecutor.open({
      uri: url.toString(),
      connectionLimit: 1,
      resetOnRelease: true,
    })
    try {
      const seen: { id: unknown; session: string }[] = []
      for (let batch = 0; batch < 3; batch++) {
        const [result] = await executor.batch('fixture:session', [
          {
            sql: `SELECT CONNECTION_ID() AS id, @@transaction_isolation AS isolation,
                         @@time_zone AS zone,
                         FIND_IN_SET('STRICT_ALL_TABLES', @@sql_mode) > 0 AS strict`,
            args: [],
          },
        ])
        const row = result?.rows[0]
        seen.push({
          id: row?.id,
          session: `${String(row?.isolation)} ${String(row?.zone)} strict=${Number(row?.strict)}`,
        })
      }
      expect(new Set(seen.map(({ id }) => id)).size).toBe(1)
      expect(seen.map(({ session }) => session)).toEqual([
        'READ-COMMITTED +00:00 strict=1',
        'READ-COMMITTED +00:00 strict=1',
        'READ-COMMITTED +00:00 strict=1',
      ])
    } finally {
      await executor.close()
      await db.close()
    }
  })

  it('runs write batches at READ COMMITTED and read batches in a read-only snapshot', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'isolation' })
    try {
      const [write] = await db.raw.batch('fixture:isolation', [
        { sql: 'SELECT @@transaction_isolation AS level', args: [] },
      ])
      expect(write?.rows).toEqual([{ level: 'READ-COMMITTED' }])
      await expect(
        db.raw.batch(
          'fixture:read-only',
          [{ sql: "DELETE FROM meta WHERE `key` = 'nothing'", args: [] }],
          'read',
        ),
      ).rejects.toThrow(/READ ONLY/)
    } finally {
      await db.close()
    }
  })
})

describe('the version table on a real server', () => {
  it('is created with its row by one statement, which leaves a recorded version alone', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'bootstrap-once', migrate: false })
    try {
      await db.raw.batch('migrate:bootstrap', [{ sql: META_BOOTSTRAP_SQL, args: [] }])
      expect(await db.admin.schemaVersion()).toBe(0)
      await db.raw.batch('fixture:set-schema-version', [
        { sql: "UPDATE meta SET value = '3' WHERE `key` = 'schema_version'", args: [] },
      ])
      // Over a table that is there, the statement inserts nothing.
      await db.raw.batch('migrate:bootstrap', [{ sql: META_BOOTSTRAP_SQL, args: [] }])
      expect(await db.admin.schemaVersion()).toBe(3)
    } finally {
      await db.close()
    }
  })

  it('refuses a version table that has no row, on the first read', async () => {
    const db = await openMysqlTestDb({ idNamespace: 'rowless-foreign', migrate: false })
    try {
      await db.raw.batch('fixture:create-empty-meta', [{ sql: META_TABLE_SQL, args: [] }])
      await expect(db.admin.schemaVersion()).rejects.toBeInstanceOf(SchemaMismatchError)
      await expect(db.admin.migrate()).rejects.toBeInstanceOf(SchemaMismatchError)
    } finally {
      await db.close()
    }
  })
})
