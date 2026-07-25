import { LibsqlStoreAdmin } from './admin.js'
import { LibsqlExecutor } from './executor.js'

/**
 * An in-memory database migrated to the current schema, with the engine
 * clock frozen when `nowMs` is given.
 *
 * Four lines, and every test file that wanted a database wrote its own copy
 * of them — twenty-two of them, across five packages. That is not a tidiness
 * complaint: the copies DRIFTED, and one of the ways they drifted caused a
 * real failure. A fixture that handed consecutive batches the same id seed
 * gave two batches the same provenance stamp, which the scheme cannot
 * survive; the `one-batch-two-instants` invariant caught it, and the
 * surviving comment in replay-after-the-world-moved.test.ts is the scar.
 *
 * It lives in this package rather than in `conformance` because the
 * dependency runs that way: `conformance` devDepends on `store-libsql`, so a
 * helper here can serve both, and one over there could never serve the
 * store's own tests. Exported under `@durablerun/store-libsql/testing` so it
 * stays out of the package's main barrel.
 */
export async function openTestDb(opts: { nowMs?: number } = {}): Promise<{
  raw: LibsqlExecutor
  admin: LibsqlStoreAdmin
  close: () => void
}> {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  if (opts.nowMs !== undefined) await admin.setFakeNowEpochMs(opts.nowMs)
  return { raw, admin, close: () => raw.close() }
}
