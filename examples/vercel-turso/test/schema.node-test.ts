import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { CURRENT_SCHEMA_VERSION, LibsqlExecutor, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { type SchemaAdmin, prepareSchema } from '../src/schema.js'

const MANAGED = (version: number): string =>
  `durablerun schema ${version} is managed by the durablerun CLI: this script migrates only a database below version ${CURRENT_SCHEMA_VERSION}`

/** An admin that counts the migrations it was asked for. */
function counting(admin: SchemaAdmin): SchemaAdmin & { migrations: number } {
  return {
    migrations: 0,
    schemaVersion: () => admin.schemaVersion(),
    async migrate() {
      this.migrations += 1
      await admin.migrate()
    },
  }
}

test('a fresh database is migrated once, and a database at the release version is left to the CLI', async () => {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = counting(new LibsqlStoreAdmin(raw))
    assert.equal(await admin.schemaVersion(), 0)
    assert.equal(await prepareSchema(admin), `durablerun schema ${CURRENT_SCHEMA_VERSION} is ready`)
    assert.equal(admin.migrations, 1)
    assert.equal(await prepareSchema(admin), MANAGED(CURRENT_SCHEMA_VERSION))
    assert.equal(admin.migrations, 1)
  } finally {
    raw.close()
  }
})

test('a database a newer tool migrated is left as it is, where migrate() itself refuses it', async () => {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const real = new LibsqlStoreAdmin(raw)
    await real.migrate()
    const newer = CURRENT_SCHEMA_VERSION + 7
    await raw.batch('test:newer-schema', [
      {
        sql: `UPDATE meta SET value = ? WHERE key = 'schema_version'`,
        args: [String(newer)],
      },
    ])
    const admin = counting(real)
    assert.equal(await prepareSchema(admin), MANAGED(newer))
    assert.equal(admin.migrations, 0)
    assert.equal(await real.schemaVersion(), newer)
    // The control: what a script that migrated unasked would meet on this database.
    await assert.rejects(real.migrate())
  } finally {
    raw.close()
  }
})

test('migrate() is called for every recorded version below the release version, and for no other', async () => {
  for (let recorded = 0; recorded <= CURRENT_SCHEMA_VERSION + 2; recorded++) {
    let version = recorded
    let migrations = 0
    const message = await prepareSchema({
      schemaVersion: async () => version,
      migrate: async () => {
        migrations += 1
        version = CURRENT_SCHEMA_VERSION
      },
    })
    const below = recorded < CURRENT_SCHEMA_VERSION
    assert.equal(migrations, below ? 1 : 0, `recorded version ${recorded}`)
    assert.equal(
      message,
      below ? `durablerun schema ${CURRENT_SCHEMA_VERSION} is ready` : MANAGED(recorded),
    )
  }
})

test('no script or source file of the example calls migrate() but the one that prepares the schema', () => {
  const callers: string[] = []
  for (const directory of ['../scripts/', '../src/', '../api/']) {
    for (const file of readdirSync(new URL(directory, import.meta.url))) {
      const text = readFileSync(new URL(`${directory}${file}`, import.meta.url), 'utf8')
      if (/\bmigrate\s*\(/.test(text)) callers.push(`${directory.slice(3)}${file}`)
    }
  }
  assert.deepEqual(callers, ['src/schema.ts'])
})
