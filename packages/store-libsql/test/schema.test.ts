import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlStoreAdmin,
  MIGRATIONS,
} from '../src/index.js'

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
  it('migrates a fresh database to the current schema version', async () => {
    expect(await admin.schemaVersion()).toBe(0)
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('is idempotent — migrating twice is a no-op', async () => {
    await admin.migrate()
    await admin.migrate()
    expect(await admin.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('creates every scheduler-plane table', async () => {
    await admin.migrate()
    const [result] = await db.batch('test:tables', [
      {
        sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        args: [],
      },
    ])
    const names = (result?.rows ?? []).map((r) => r.name)
    for (const t of ['meta', 'tasks', 'runs', 'checkpoints', 'events', 'waits']) {
      expect(names).toContain(t)
    }
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
  }

  it('every migration hash matches its frozen value', () => {
    for (const migration of MIGRATIONS) {
      const hash = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
      expect(FROZEN[migration.version], `migration v${migration.version} is not frozen`).toBe(hash)
    }
    expect(Object.keys(FROZEN)).toHaveLength(MIGRATIONS.length)
  })
})
