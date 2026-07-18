import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, LibsqlExecutor, LibsqlStoreAdmin } from '../src/index.js'

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
