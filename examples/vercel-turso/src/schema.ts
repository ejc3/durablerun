import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'

/** The two calls of a store's admin that preparing a schema makes. */
export interface SchemaAdmin {
  schemaVersion(): Promise<number>
  migrate(): Promise<void>
}

/**
 * Prepare the schema, and say in one line what was done. The store package this example
 * installs migrates a database to `CURRENT_SCHEMA_VERSION`, which is 5 for the release
 * v0.1.0-alpha.1. A database recorded below that version is migrated here. A database
 * recorded at it or above it is left as it is: the durablerun CLI (`pnpm cli migrate` in
 * the durablerun repository) takes a database past the version a release was built for,
 * and the `migrate()` of an older release refuses a database a newer tool migrated. So
 * every script of this example prepares its schema through this function, and none calls
 * `migrate()` itself.
 */
export async function prepareSchema(admin: SchemaAdmin): Promise<string> {
  const recorded = await admin.schemaVersion()
  if (recorded >= CURRENT_SCHEMA_VERSION) {
    return `durablerun schema ${recorded} is managed by the durablerun CLI: this script migrates only a database below version ${CURRENT_SCHEMA_VERSION}`
  }
  await admin.migrate()
  return `durablerun schema ${await admin.schemaVersion()} is ready`
}
