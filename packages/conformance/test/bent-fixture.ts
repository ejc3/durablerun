import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import type { StoreFixtureFactory } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * A store that does what a case forbids, for the cases that show a hold failing. The bend
 * sits below the store, as a write that follows every batch sent under one label, because
 * core's build rules refuse a batch that is itself built wrong: the rows are the only
 * place such a defect could show.
 */
function following(db: SqlExecutor, label: string, bend: SqlStatement): SqlExecutor {
  return {
    batch: async (name, statements, control) => {
      const results = await db.batch(name, statements, control)
      if (name === label) await db.batch('bend', [bend], 'write')
      return results
    },
  }
}

/**
 * A libSQL fixture whose stores and retention ports, the ones a case opens over an
 * executor, all carry the bend.
 */
export function bent(label: string, bend: SqlStatement): StoreFixtureFactory {
  return async (seed, options) => {
    const f = await makeLibsqlFixture(seed, options)
    return {
      ...f,
      storeOver: (db, buggify) => f.storeOver(following(db, label, bend), buggify),
      retentionOver: (db) => f.retentionOver(following(db, label, bend)),
    }
  }
}
