import type { Buggify, SqlExecutor } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import type { StoreFixture } from '../src/index.js'

export async function makeLibsqlFixture(seed: number | string): Promise<StoreFixture> {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  return {
    store: new LibsqlSchedulerStore(raw, ids),
    admin,
    raw,
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new LibsqlSchedulerStore(db, ids, buggify),
    close: () => raw.close(),
  }
}
