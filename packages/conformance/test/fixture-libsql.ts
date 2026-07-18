import type { Buggify, SqlExecutor } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import type { StoreFixture } from '../src/index.js'

export async function makeLibsqlFixture(seed: number | string): Promise<StoreFixture> {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  const ids = seededIdSource(new Rng(seed))
  return {
    store: new LibsqlSchedulerStore(raw, ids),
    admin,
    raw,
    storeOver: (db: SqlExecutor, buggify?: Buggify) =>
      new LibsqlSchedulerStore(db, ids, buggify ? { buggify } : {}),
    close: () => raw.close(),
  }
}
