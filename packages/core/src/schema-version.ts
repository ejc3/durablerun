import { SchemaMismatchError, SchemaNotInitializedError } from './errors.js'
import type { SqlLockedBatch, SqlResult } from './primitives.js'
import { storageValueKind } from './validate.js'

/**
 * The batch control of a migration write. The batch names the migration lock, as an event
 * batch or a claim batch names its own, so the lock travels in the one value every executor
 * wrapper forwards, and no executor chooses it from the batch's label.
 *
 * Every version's batch carries it. The bootstrap carries it wherever the dialect's lock
 * does not live in the version table, the table a bootstrap creates: a named lock can be
 * taken before that table exists, and a lock on the table cannot.
 */
export const MIGRATION_WRITE: SqlLockedBatch = Object.freeze({
  mode: 'write',
  transactionLock: Object.freeze({ kind: 'migration' }),
})

/**
 * The recorded schema version, read through the dialect's own version read. `read` is the
 * store's labeled batch over its own SQL text, so the label and the text stay in the
 * dialect, where its executor types a missing table.
 *
 * Null is the one typed fresh-database state. Once meta exists, every malformed
 * result, including no schema_version row, throws closed.
 */
export async function readSchemaVersion(read: () => Promise<SqlResult[]>): Promise<number | null> {
  let results: SqlResult[]
  try {
    results = await read()
  } catch (error) {
    // Only a genuinely fresh database reads as absent; a transient network or auth
    // error must not masquerade as one (it would re-apply every migration over a
    // live schema).
    if (error instanceof SchemaNotInitializedError) return null
    throw error
  }
  const result = results.length === 1 ? results[0] : undefined
  const row = result?.rows.length === 1 ? result.rows[0] : undefined
  if (!row) {
    throw new SchemaMismatchError(
      `schema-version read must return exactly one result with one row, got ${results.length} results and ${result?.rows.length ?? 0} rows`,
    )
  }
  const stored = row.value
  if (typeof stored !== 'string' || !/^(0|[1-9][0-9]*)$/.test(stored)) {
    throw new SchemaMismatchError(
      `schema_version must be a canonical nonnegative integer, got ${storageValueKind(stored)}`,
    )
  }
  const version = Number(stored)
  if (!Number.isSafeInteger(version)) {
    throw new SchemaMismatchError(`schema_version is outside the safe integer range: ${stored}`)
  }
  return version
}

/**
 * A migration write that failed is forgiven only if the authoritative version says so:
 * the metadata now exists at or beyond `minimumVersion`, which the caller picks. A batch
 * of one version passes that version, and the write is then complete. A batch of several
 * passes the first of them, and then plans again what is still pending.
 * A concurrent migrator may have won, or this migrator's own commit may have landed with
 * only its answer lost. An absent or behind version rethrows the original failure, so a
 * failure that is not a lost race is never swallowed. The version decides, never the
 * error's code or text: a database may report a lost CREATE as a catalog uniqueness error
 * even under IF NOT EXISTS.
 */
export async function applyVersionedWrite(
  write: () => Promise<unknown>,
  minimumVersion: number,
  readVersion: () => Promise<number | null>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    const version = await readVersion()
    if (version !== null && version >= minimumVersion) return
    throw error
  }
}

/**
 * The post-condition of `migrate()`, asserted rather than assumed. Each version bump is an
 * UPDATE guarded on the previous value, in the same batch as the DDL. When the guard
 * matches nothing the DDL can still commit, so the database ends up physically migrated
 * while recording the old version; the next process then re-applies the DDL and fails on
 * every restart, while the process that caused it reported success. Checking the end
 * state covers that and every other cause without having to enumerate them.
 */
export function requireCurrentSchemaVersion(version: number, current: number): void {
  if (version !== current) {
    // A recorded version past this build's newest is a healthy schema that a newer build
    // migrated. It is refused like any other mismatch, with the advice that fits it.
    throw new SchemaMismatchError(
      version > current
        ? `the schema is recorded at version ${version} and this build knows versions up to ${current}: a newer build migrated this database, which needs no repair. Run that build or a later one`
        : `migrate finished with the schema recorded at version ${version}, expected ${current} — the database is in an inconsistent state and must be repaired by hand`,
    )
  }
}
