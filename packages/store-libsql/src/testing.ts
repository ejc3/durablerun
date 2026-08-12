import type { IdSource } from '@durablerun/core'
import { LibsqlStoreAdmin } from './admin.js'
import { LibsqlExecutor } from './executor.js'

const nextMonotoneSerial = (previous: number): number => previous + 1

/**
 * A deterministic source for routine database tests.
 *
 * IDs and tokens have independent monotone counters: an operation that mints
 * no UUID still receives a fresh provenance token. Zero padding preserves the
 * ordering contract of UUIDv7 stand-ins once a fixture reaches two digits.
 */
export function testIdSource(
  namespace = 'test',
  options: { readonly nextTokenSerial?: (previous: number) => number } = {},
): IdSource {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new Error(
      `test id namespace must contain only letters, digits, underscores, or hyphens: ${namespace}`,
    )
  }
  let ids = 0
  let tokens = 0
  const proposeTokenSerial = options.nextTokenSerial ?? nextMonotoneSerial
  const serial = (value: number) => String(value).padStart(6, '0')
  return {
    uuidv7: () => `${namespace}-id-${serial(++ids)}`,
    token: () => {
      const proposed = proposeTokenSerial(tokens)
      if (!Number.isSafeInteger(proposed)) {
        throw new RangeError(`test token serial must be a safe integer: ${proposed}`)
      }
      if (proposed <= tokens) {
        throw new RangeError(
          `test token serial must strictly increase: proposed ${proposed} after ${tokens}`,
        )
      }
      tokens = proposed
      return `${namespace}-token-${serial(tokens)}`
    },
  }
}

/**
 * An in-memory database migrated to the current schema, with the engine
 * clock frozen when `nowMs` is given.
 *
 * Four lines, and every test file that wanted a database wrote its own copy
 * of them — twenty-two of them, across five packages. That is not a tidiness
 * complaint: the copies DRIFTED, and one of the ways they drifted caused a
 * real failure. A fixture that handed consecutive batches the same token
 * seed let a no-op batch borrow an older batch's fence. The helper now returns
 * one source alongside each database, and the converted routine fixture
 * stores share it. `one-batch-two-instants` remains a cross-instant
 * consistency alarm; it cannot prove token issuance was unique at one instant
 * or after evidence was overwritten.
 *
 * It lives in this package rather than in `conformance` because the
 * dependency runs that way: `conformance` devDepends on `store-libsql`, so a
 * helper here can serve both, and one over there could never serve the
 * store's own tests. Exported under `@durablerun/store-libsql/testing` so it
 * stays out of the package's main barrel.
 */
export async function openTestDb(opts: { nowMs?: number; idNamespace?: string } = {}): Promise<{
  raw: LibsqlExecutor
  admin: LibsqlStoreAdmin
  ids: IdSource
  close: () => void
}> {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  const ids = testIdSource(opts.idNamespace)
  await admin.migrate()
  if (opts.nowMs !== undefined) await admin.setFakeNowEpochMs(opts.nowMs)
  return { raw, admin, ids, close: () => raw.close() }
}
