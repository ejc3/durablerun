import {
  InvalidDurableStringError,
  SchemaMismatchError,
  encodeRollbackTry,
  taskDoneEventName,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MysqlExecutor } from '../src/executor.js'
import { META_BOOTSTRAP_SQL, META_TABLE_SQL, createIndexIfMissing } from '../src/schema.js'
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

  it('holds a queue and an event name of exactly 255 four-byte characters, and refuses 256', async () => {
    // The width is characters, and a character outside the basic plane is four bytes and
    // two UTF-16 units. The two names together are the widest key the schema has.
    const db = await openMysqlTestDb({ idNamespace: 'width-boundary' })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      const widest = '\u{1F600}'.repeat(255)
      await store.emitEvent(widest, widest, '{"x":1}')
      const [stored] = await db.raw.batch(
        'fixture:read',
        [
          {
            sql: `SELECT CHAR_LENGTH(event_name) AS characters, LENGTH(event_name) AS bytes,
                         event_name = ? AND queue = ? AS same FROM events`,
            args: [widest, widest],
          },
        ],
        'read',
      )
      expect(
        (stored?.rows ?? []).map((row) => [
          Number(row.characters),
          Number(row.bytes),
          Number(row.same),
        ]),
      ).toEqual([[255, 1020, 1]])
      const oneMore = await store.emitEvent('q', '\u{1F600}'.repeat(256), '{}').then(
        () => 'accepted',
        (error: unknown) => error,
      )
      expect(oneMore).toBeInstanceOf(InvalidDurableStringError)
    } finally {
      await db.close()
    }
  })

  it('leaves a gated statement unsent when its gate matched no row, and sends it when the gate matched a row it did not change', async () => {
    // `SqlStatement.skipUnlessWrote` names the earlier statement whose stamp gates this
    // one. This executor pays a round trip for each statement, so it skips one whose gate
    // wrote no row. MySQL counts rows changed, and a gate that matched a row and changed
    // nothing counts zero there, so the gate is read as the port means it: rows matched.
    // The gated statements here are plain inserts, so that a skipped one can be seen.
    const db = await openMysqlTestDb({ idNamespace: 'gated' })
    try {
      const gated = (key: string, gate: number) => ({
        sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?)',
        args: [key, 'sent'],
        skipUnlessWrote: gate,
      })
      const results = await db.raw.batch('fixture:gated', [
        { sql: "INSERT INTO meta (`key`, value) VALUES ('k', 'same')", args: [] },
        { sql: "UPDATE meta SET value = 'x' WHERE `key` = 'absent'", args: [] },
        gated('after-no-match', 1),
        { sql: "UPDATE meta SET value = 'same' WHERE `key` = 'k'", args: [] },
        gated('after-a-match-that-changed-nothing', 3),
        { sql: "SELECT `key` FROM meta WHERE value = 'sent' ORDER BY `key`", args: [] },
      ])
      expect(
        results.map(({ rowsAffected }) => rowsAffected),
        'mutation-verdict:behavior:mysql-gated-statement-skipped-when-its-gate-matched-nothing',
      ).toEqual([1, 0, 0, 1, 1, 1])
      expect(results[2]).toEqual({ rows: [], rowsAffected: 0 })
      expect(results[5]?.rows).toEqual([{ key: 'after-a-match-that-changed-nothing' }])
    } finally {
      await db.close()
    }
  })

  it('creates an index in a form that is safe to repeat, which MySQL has no statement for', async () => {
    // A migrator that died after the index and before the version runs the version again.
    const db = await openMysqlTestDb({ idNamespace: 'index-repeat' })
    try {
      const indexes = [
        ['runs_woken', '(queue, wake_event, state)', 'queue,wake_event,state'],
        ['runs_stamp', '(fence_stamp(768))', 'fence_stamp'],
      ] as const
      for (const [name, definition, expected] of indexes) {
        const columns = async () => {
          const [index] = await db.raw.batch(
            'fixture:read',
            [
              {
                sql: `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
                      FROM information_schema.statistics
                      WHERE table_schema = DATABASE() AND table_name = 'runs' AND index_name = ?`,
                args: [name],
              },
            ],
            'read',
          )
          return index?.rows[0]?.columns
        }
        const version = createIndexIfMissing('runs', name, definition).map((sql) => ({
          sql,
          args: [],
        }))
        expect(await columns()).toBe(expected)
        await db.raw.batch('migrate:index', version)
        expect(await columns()).toBe(expected)
        await db.raw.batch('fixture:drop', [{ sql: `DROP INDEX ${name} ON runs`, args: [] }])
        expect(await columns()).toBeNull()
        await db.raw.batch('migrate:index', version)
        await db.raw.batch('migrate:index', version)
        expect(await columns()).toBe(expected)
      }
    } finally {
      await db.close()
    }
  })

  it('makes a batch that ends a task wait for the lock of its completion event, and no other', async () => {
    // An await of a child holds this lock while it reads no event and writes its wait row.
    // A terminal batch that did not take it could insert the event in between and see no
    // wait, and the parent would sleep for ever. The lock is a session named lock, held
    // here by a batch that sleeps, and what is compared is the order things finished in.
    const db = await openMysqlTestDb({ idNamespace: 'terminal-lock', nowMs: 1_000_000 })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      const finished: string[] = []
      const ended = await store.spawn('q', 'ended', '{}')
      const other = await store.spawn('q', 'other', '{}')
      const claimed = await store.claim('q', 'w', { leaseSeconds: 60, limit: 2 })
      for (const run of claimed) await store.activate('q', run.runId, run.claimToken, run.claimGen)
      const runOf = (taskId: string) => {
        const run = claimed.find((candidate) => candidate.taskId === taskId)
        if (run === undefined) throw new Error(`task ${taskId} was not claimed`)
        return run
      }
      const hold = db.raw
        .batch('fixture:hold', [{ sql: 'SELECT SLEEP(1.5) AS slept', args: [] }], {
          mode: 'write',
          transactionLock: {
            kind: 'event',
            queue: 'q',
            eventName: taskDoneEventName(ended.taskId),
          },
        })
        .then(() => finished.push('the lock was released'))
      // The lock is taken before the sleep starts, so by now it is held.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const complete = (taskId: string, what: string) => {
        const run = runOf(taskId)
        return store.complete('q', run.runId, run.claimToken, '{}').then(() => finished.push(what))
      }
      await Promise.all([
        hold,
        complete(ended.taskId, 'the task whose event is locked ended'),
        complete(other.taskId, 'another task ended'),
      ])
      expect(finished).toEqual([
        'another task ended',
        'the lock was released',
        'the task whose event is locked ended',
      ])
    } finally {
      await db.close()
    }
  })

  it('rolls a task back whatever budget it was spawned with, and halts where a rollback fails for good', async () => {
    // The rollback pass runs past the user budget, so its batch writes the task's budget
    // as the pass's own ordinal. Its guard reads the ordinal the batch writes from and
    // never the stored budget, which the batch replaces: a task with the largest budget
    // rolls back like any other. Each task has a queue of its own, because a rollback
    // pass is claimable work.
    const db = await openMysqlTestDb({ idNamespace: 'saga-budget', nowMs: 1_000_000 })
    try {
      const store = new MysqlSchedulerStore(db.raw, db.ids)
      for (const maxAttempts of [1, 1_000_000]) {
        const queue = `budget-${maxAttempts}`
        const task = await store.spawn(queue, 'job', '{}', { maxAttempts })
        const [run] = await store.claim(queue, 'forward', { leaseSeconds: 60, limit: 1 })
        if (run === undefined) throw new Error('the task was not claimed')
        await store.activate(queue, run.runId, run.claimToken, run.claimGen)
        await store.setCheckpoint(
          queue,
          task.taskId,
          run.runId,
          run.claimToken,
          '$started:charge',
          '0',
          60,
        )
        expect(await store.fail(queue, run.runId, run.claimToken, '{"why":"boom"}', null)).toEqual({
          rollingBack: true,
        })
        const [budget] = await db.raw.batch(
          'fixture:read',
          [
            {
              sql: 'SELECT state, attempts, max_attempts FROM tasks WHERE task_id = ?',
              args: [task.taskId],
            },
          ],
          'read',
        )
        expect(budget?.rows).toEqual([{ state: 'pending', attempts: 1, max_attempts: 2 }])
        // The rollback fails with no retry left: the attempt record lands, and the saga halts.
        const [pass] = await store.claim(queue, 'pass', { leaseSeconds: 60, limit: 1 })
        if (pass === undefined) throw new Error('the rollback pass was not claimed')
        await store.activate(queue, pass.runId, pass.claimToken, pass.claimGen)
        const halted = await store.failRollback(
          queue,
          pass.runId,
          pass.claimToken,
          '{"why":"boom"}',
          null,
          {
            key: '$rollback-tries:charge',
            stateJson: encodeRollbackTry({ tries: 1, errorJson: '{"why":"refund failed"}' }),
          },
        )
        expect(halted).toEqual({ rollingBack: false })
        expect(await store.getTaskResult(queue, task.taskId)).toMatchObject({
          state: 'failed',
          rollback: { outcome: 'failed', errorJson: '{"why":"refund failed"}' },
        })
      }
    } finally {
      await db.close()
    }
  })

  it('runs a write at READ COMMITTED with autocommit on, and refuses a write sent as a read', async () => {
    // A read is sent alone only when core's read path built it. A statement sent as a read
    // in text keeps the read-only transaction, where the server refuses a write.
    const db = await openMysqlTestDb({ idNamespace: 'isolation' })
    try {
      const [write] = await db.raw.batch('fixture:isolation', [
        { sql: 'SELECT @@transaction_isolation AS level, @@autocommit AS autocommit', args: [] },
      ])
      expect(write?.rows).toEqual([{ level: 'READ-COMMITTED', autocommit: 1 }])
      await db.raw.batch('fixture:seed', [
        { sql: "INSERT INTO meta (`key`, value) VALUES ('kept', 'v')", args: [] },
      ])
      const outcome = await db.raw
        .batch(
          'fixture:read-only',
          [{ sql: "DELETE FROM meta WHERE `key` = 'kept'", args: [] }],
          'read',
        )
        .then(
          () => 'accepted',
          (error: unknown) => (/READ ONLY/.test(String(error)) ? 'refused by the server' : error),
        )
      const [kept] = await db.raw.batch(
        'fixture:read',
        [{ sql: "SELECT COUNT(*) AS n FROM meta WHERE `key` = 'kept'", args: [] }],
        'read',
      )
      expect(
        { outcome, kept: kept?.rows },
        'mutation-verdict:behavior:mysql-lone-read-is-known-to-be-a-read',
      ).toEqual({ outcome: 'refused by the server', kept: [{ n: 1 }] })
    } finally {
      await db.close()
    }
  })

  it('refuses a single write whose key ends in a tab and would be cut to fit, and writes nothing', async () => {
    // MySQL cuts more than a trailing space with a note: a tab, a line break, a bind sent
    // as bytes, a literal in the text. The executor cannot tell from a statement that none
    // of them is in it, so a single write keeps its transaction, where the cut rolls back.
    const db = await openMysqlTestDb({ idNamespace: 'cut-tab' })
    try {
      const outcome = await db.raw
        .batch('fixture:cut-tab', [
          {
            sql: 'INSERT INTO meta (`key`, value) VALUES (?, ?)',
            args: [`${'k'.repeat(255)}\t`, 'tabbed'],
          },
        ])
        .then(
          () => 'accepted',
          (error: unknown) => error,
        )
      const [rows] = await db.raw.batch(
        'fixture:read',
        [{ sql: "SELECT COUNT(*) AS n FROM meta WHERE value = 'tabbed'", args: [] }],
        'read',
      )
      expect(
        { refused: outcome instanceof InvalidDurableStringError, stored: rows?.rows[0]?.n },
        'mutation-verdict:behavior:mysql-lone-statement-is-a-read',
      ).toEqual({ refused: true, stored: 0 })
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
