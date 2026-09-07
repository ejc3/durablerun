import { LibsqlExecutor, LibsqlStoreAdmin } from '@durablerun/store-libsql'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

const raw = LibsqlExecutor.open(requiredEnv('TURSO_DATABASE_URL'), requiredEnv('TURSO_AUTH_TOKEN'))
try {
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  process.stdout.write(`durablerun schema ${await admin.schemaVersion()} is ready\n`)
} finally {
  raw.close()
}
