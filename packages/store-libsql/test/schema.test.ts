import { createHash } from 'node:crypto'
import {
  MIGRATION_WRITE,
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
  type SqlExecutor,
} from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibsqlExecutor, LibsqlStoreAdmin, MIGRATIONS } from '../src/index.js'
import { CURRENT_SCHEMA_VERSION } from '../src/schema.js'

let db: LibsqlExecutor
let admin: LibsqlStoreAdmin

beforeEach(() => {
  db = LibsqlExecutor.open(':memory:')
  admin = new LibsqlStoreAdmin(db)
})

afterEach(() => {
  db.close()
})

describe('migrations', () => {
  it('creates every scheduler-plane table', async () => {
    await admin.migrate()
    const [result] = await db.batch('test:tables', [
      {
        sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        args: [],
      },
    ])
    const names = (result?.rows ?? []).map((r) => r.name)
    for (const t of ['meta', 'tasks', 'runs', 'checkpoints', 'events', 'waits', 'drivers']) {
      expect(names).toContain(t)
    }
  })

  it('enrolls every migrated integer column with exact nullability', async () => {
    await admin.migrate()
    const persistedIntegers = [
      ...PERSISTED_COUNTER_FIELDS.map((field) => ({ ...field, nullable: false })),
      ...PERSISTED_TEMPORAL_FIELDS,
    ]
    const tables = [...new Set(persistedIntegers.map((field) => field.table))]
    const results = await db.batch(
      'test:temporal-schema',
      tables.map((table) => ({ sql: `PRAGMA table_info(${table})`, args: [] })),
      'read',
    )
    const observed = results
      .flatMap((result, index) => {
        const table = tables[index]
        if (table === undefined) throw new Error(`missing temporal table at index ${index}`)
        return result.rows
          .filter((row) => String(row.type).toUpperCase() === 'INTEGER')
          .map((row) => ({
            field: `${table}.${String(row.name)}`,
            nullable: row.notnull === 0 || row.notnull === 0n,
          }))
      })
      .sort((left, right) => left.field.localeCompare(right.field))
    const expected = persistedIntegers
      .map(({ table, column, nullable }) => ({
        field: `${table}.${column}`,
        nullable,
      }))
      .sort((left, right) => left.field.localeCompare(right.field))

    expect(observed, 'mutation-verdict:construction:migrated-integer-inventory-complete').toEqual(
      expected,
    )
    expect(observed).toHaveLength(31)
  })
})

describe('a migration write', () => {
  it('names the migration lock in its control, the bootstrap and every version', async () => {
    // libSQL has one writer, and its executor takes nothing for a lock of any kind. The
    // control is the same on every dialect all the same, so that a recorder, a wrapper, or
    // a port in another language meets one rule: a migration write names the lock.
    const controls: unknown[][] = []
    const recording: SqlExecutor = {
      batch: (label, statements, control) => {
        if (label !== 'migrate:version') controls.push([label, control])
        return db.batch(label, statements, control)
      },
    }
    await new LibsqlStoreAdmin(recording).migrate()
    expect(
      controls,
      'mutation-verdict:construction:libsql-migration-write-names-the-migration-lock',
    ).toEqual([
      ['migrate:bootstrap', MIGRATION_WRITE],
      ...MIGRATIONS.map(({ version }) => [`migrate:v${version}`, MIGRATION_WRITE]),
    ])
  })
})

describe('a version that failed', () => {
  it('leaves nothing behind, at every version, and the next migrate() applies it', async () => {
    // A version is one batch, and libSQL runs a batch as one transaction: the sentinel, the
    // version's statements and the version itself commit together or not at all. Each
    // version in turn is made to fail after every one of its statements has run. The
    // statement that fails it writes the version's own sentinel a second time, which the
    // primary key refuses only once the first is there, so the batch was not refused before
    // it ran. What the database holds afterwards must be what it held before.
    const holdings = async (raw: LibsqlExecutor): Promise<string> => {
      const results = await raw.batch(
        'fixture:holdings',
        [
          {
            sql: 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
            args: [],
          },
          { sql: 'SELECT key, value FROM meta ORDER BY key', args: [] },
        ],
        'read',
      )
      return JSON.stringify(results.map(({ rows }) => rows))
    }
    const outcomes: Record<string, unknown>[] = []
    for (const { version } of MIGRATIONS) {
      const raw = LibsqlExecutor.open(':memory:')
      try {
        let before = 'the version was never sent'
        const failing: SqlExecutor = {
          batch: async (label, statements, control) => {
            if (label !== `migrate:v${version}`) return raw.batch(label, statements, control)
            before = await holdings(raw)
            return raw.batch(
              label,
              [
                ...statements,
                {
                  sql: `INSERT INTO meta (key, value) VALUES ('applied:v${version}', 'again')`,
                  args: [],
                },
              ],
              control,
            )
          },
        }
        const migrate = await new LibsqlStoreAdmin(failing).migrate().then(
          () => 'resolved',
          () => 'rejected',
        )
        const after = await holdings(raw)
        const recorded = await new LibsqlStoreAdmin(raw).schemaVersion()
        await new LibsqlStoreAdmin(raw).migrate()
        outcomes.push({
          version,
          migrate,
          recorded,
          leftBehind: after === before ? 'nothing' : 'something',
          theNextMigrateReaches: await new LibsqlStoreAdmin(raw).schemaVersion(),
        })
      } finally {
        raw.close()
      }
    }
    expect(outcomes).toEqual(
      MIGRATIONS.map(({ version }) => ({
        version,
        migrate: 'rejected',
        recorded: version - 1,
        leftBehind: 'nothing',
        theNextMigrateReaches: CURRENT_SCHEMA_VERSION,
      })),
    )
  })
})

describe('an event payload is never SQL NULL', () => {
  // SQLite cannot add NOT NULL to a column that exists, so version 10 holds the payload with
  // two triggers. A declared NOT NULL covers every statement that can write the column by
  // construction. Two triggers cover it only if no statement gets past both, so every form
  // SQLite has for writing a column is tried here.
  const DOORS: Record<string, string> = {
    'an insert that names NULL': `INSERT INTO events (queue, event_name, payload) VALUES ('q', 'new', NULL)`,
    'an insert that leaves the column out': `INSERT INTO events (queue, event_name) VALUES ('q', 'new')`,
    'an insert from a select': `INSERT INTO events (queue, event_name, payload) SELECT 'q', 'new', NULL`,
    'INSERT OR REPLACE': `INSERT OR REPLACE INTO events (queue, event_name, payload) VALUES ('q', 'held', NULL)`,
    'INSERT OR IGNORE': `INSERT OR IGNORE INTO events (queue, event_name, payload) VALUES ('q', 'new', NULL)`,
    'REPLACE INTO': `REPLACE INTO events (queue, event_name, payload) VALUES ('q', 'held', NULL)`,
    'an update': `UPDATE events SET payload = NULL WHERE queue = 'q' AND event_name = 'held'`,
    'UPDATE OR IGNORE': `UPDATE OR IGNORE events SET payload = NULL WHERE queue = 'q' AND event_name = 'held'`,
    'UPDATE OR REPLACE': `UPDATE OR REPLACE events SET payload = NULL WHERE queue = 'q' AND event_name = 'held'`,
    "an upsert's update arm": `INSERT INTO events (queue, event_name, payload) VALUES ('q', 'held', '{}')
      ON CONFLICT (queue, event_name) DO UPDATE SET payload = NULL`,
    "an upsert's insert arm": `INSERT INTO events (queue, event_name, payload) VALUES ('q', 'new', NULL)
      ON CONFLICT (queue, event_name) DO UPDATE SET payload = '{}'`,
  }
  const events = async (raw: LibsqlExecutor) =>
    (
      await raw.batch(
        'fixture:read',
        [{ sql: 'SELECT event_name, payload FROM events ORDER BY event_name', args: [] }],
        'read',
      )
    )[0]?.rows

  it('refuses SQL NULL through every statement that can write the column', async () => {
    await admin.migrate()
    await db.batch('fixture:seed', [
      {
        sql: `INSERT INTO events (queue, event_name, payload) VALUES ('q', 'held', '{"kept":1}')`,
        args: [],
      },
    ])
    const answers: Record<string, unknown> = {}
    for (const [door, sql] of Object.entries(DOORS)) {
      const refusal = await db.batch('fixture:door', [{ sql, args: [] }]).then(
        () => 'accepted',
        (error: unknown) => /SQLITE_[A-Z_]+/.exec(String(error))?.[0] ?? String(error),
      )
      answers[door] = { refusal, events: await events(db) }
    }
    expect(answers).toEqual(
      Object.fromEntries(
        Object.keys(DOORS).map((door) => [
          door,
          {
            refusal: 'SQLITE_CONSTRAINT_TRIGGER',
            events: [{ event_name: 'held', payload: '{"kept":1}' }],
          },
        ]),
      ),
    )
  })

  it('stops at the version before over a row that holds NULL, and leaves the row as it was', async () => {
    // The port cannot write this row, so it is a foreign writer's or tampering. The version
    // is the constraint checking its own past: the update trigger it installs refuses the
    // row, the batch fails, and the batch is one transaction, so nothing of it is left.
    class StoppedBeforeTheVersion extends Error {}
    const stopping: SqlExecutor = {
      batch: async (label, statements, control) => {
        if (label === 'migrate:v10') throw new StoppedBeforeTheVersion()
        return db.batch(label, statements, control)
      },
    }
    await expect(new LibsqlStoreAdmin(stopping).migrate()).rejects.toBeInstanceOf(
      StoppedBeforeTheVersion,
    )
    await db.batch('fixture:foreign-writer', [
      {
        sql: `INSERT INTO events (queue, event_name, payload) VALUES ('q', 'held-null', NULL)`,
        args: [],
      },
    ])
    const observed = async () => ({
      version: await admin.schemaVersion(),
      events: await events(db),
      triggers: (
        await db.batch(
          'fixture:read',
          [
            {
              sql: `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events' ORDER BY name`,
              args: [],
            },
          ],
          'read',
        )
      )[0]?.rows.map(({ name }) => name),
    })

    // The type is asserted on purpose: no retry changes this answer until the row is repaired.
    const refusal = await admin.migrate().then(
      () => 'resolved',
      (error: unknown) => ({
        name: error instanceof Error ? error.name : typeof error,
        by: /SQLITE_[A-Z_]+: [^:]+: [a-z.]+/.exec(String(error))?.[0] ?? String(error),
      }),
    )
    const stopped = await observed()
    await db.batch('fixture:repair', [
      {
        sql: `UPDATE events SET payload = '{"repaired":1}' WHERE payload IS NULL`,
        args: [],
      },
    ])
    await admin.migrate()

    expect({ refusal, stopped, repaired: await observed() }).toEqual({
      refusal: {
        name: 'PermanentStoreError',
        by: 'SQLITE_CONSTRAINT_TRIGGER: NOT NULL constraint failed: events.payload',
      },
      stopped: { version: 9, events: [{ event_name: 'held-null', payload: null }], triggers: [] },
      repaired: {
        version: CURRENT_SCHEMA_VERSION,
        events: [{ event_name: 'held-null', payload: '{"repaired":1}' }],
        triggers: ['events_payload_not_null_insert', 'events_payload_not_null_update'],
      },
    })
  })
})

describe('engine time', () => {
  beforeEach(async () => {
    await admin.migrate()
  })

  it('reads real time when no override is set', async () => {
    const before = Date.now()
    const now = await admin.nowEpochMs()
    expect(now).toBeGreaterThanOrEqual(before - 1000)
    expect(now).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('honors and clears the fake_now override', async () => {
    await admin.setFakeNowEpochMs(1_700_000_000_000)
    expect(await admin.nowEpochMs()).toBe(1_700_000_000_000)
    await admin.setFakeNowEpochMs(1_700_000_123_456)
    expect(await admin.nowEpochMs()).toBe(1_700_000_123_456)
    await admin.setFakeNowEpochMs(null)
    const now = await admin.nowEpochMs()
    expect(Math.abs(now - Date.now())).toBeLessThan(5000)
  })
})

describe('migrations are append-only', () => {
  /**
   * The runner skips versions a database has already applied, so EDITING a
   * shipped migration silently strands every existing database without the
   * change (found when the drivers table was first added by editing v1).
   * These hashes freeze each migration's content the moment a later version
   * exists: to change the schema, append a new migration — the build refuses
   * a rewrite of history. When you APPEND version N+1, add its hash here.
   */
  const FROZEN: Record<number, string> = {
    1: 'fa525645bb25c0ae6c0d9c5922e2d3005e00c5a120372cf6a72d030cdc484dcb',
    2: '120485faedab6f3f915c60d2f8dbbba5b810fa9233e4a6423c843d6dac4eecfa',
    3: '2d990218bab811ebf1a8ebecc5d4da1370bfd2e61eba077ba6cca68a9bfe4eee',
    4: 'c6b92dcd92b8745a1d0a43b72ddf73b9e7a398f2be9c88af978b854110426402',
    5: '7f3f2fe9f4e203110ed0001500ad7ca805e1d467aea3b13b2b6aba6d966d8295',
    6: '9a3117ae07e404ed99b2906def9987cf5e4bd71843ab8a15f6c9a5fc6876d10f',
    7: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    8: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    9: '1447b70b6f5f0015e91290fe37f1e7359b3eced0923d380dafe207ec2aec62f4',
    10: '39ac3ed88c6b7dda5d09a0fc714ae38ca9f5395476ef40848a9b70bb739a284c',
  }

  it('every migration hash matches its frozen value', () => {
    for (const migration of MIGRATIONS) {
      const hash = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
      expect(FROZEN[migration.version], `migration v${migration.version} is not frozen`).toBe(hash)
    }
    expect(Object.keys(FROZEN)).toHaveLength(MIGRATIONS.length)
  })
})
