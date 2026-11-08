import { LibsqlExecutor, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { prepareSchema } from '../src/schema.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

const raw = LibsqlExecutor.open(requiredEnv('TURSO_DATABASE_URL'), requiredEnv('TURSO_AUTH_TOKEN'))
try {
  process.stdout.write(`${await prepareSchema(new LibsqlStoreAdmin(raw))}\n`)
} finally {
  raw.close()
}
