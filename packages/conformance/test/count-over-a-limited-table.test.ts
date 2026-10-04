import {
  FencedBatch,
  READS_SEED,
  type TreeDialect,
  readRows,
  tableRowsRead,
} from '@durablerun/core'
import { NOW_MS as LIBSQL_NOW, TREE_DIALECT as LIBSQL_TREE } from '@durablerun/store-libsql'
import { NOW_MS as MYSQL_NOW, TREE_DIALECT as MYSQL_TREE } from '@durablerun/store-mysql'
import { NOW_MS as POSTGRES_NOW, TREE_DIALECT as POSTGRES_TREE } from '@durablerun/store-postgres'
import { describe, expect, it } from 'vitest'
import { withFixture } from '../src/scenario.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'
import type { EnrolledDialect } from './dialect-selection.js'

/**
 * Whether a count over a derived table that carries a LIMIT is a statement tree on every
 * dialect: the closed grammar accepts it, each dialect's compiler spells it, and each
 * server runs it and answers the count as an integer. `sizes` counts a queue's rows of a
 * table up to a cap this way, so no count reads past the cap.
 */
const COMPILED_BY: Readonly<Record<EnrolledDialect, { now: string; tree: TreeDialect }>> = {
  libsql: { now: LIBSQL_NOW, tree: LIBSQL_TREE },
  postgres: { now: POSTGRES_NOW, tree: POSTGRES_TREE },
  mysql: { now: MYSQL_NOW, tree: MYSQL_TREE },
}

describe('a count over a derived table that carries a LIMIT, as a statement tree', () => {
  for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
    it(`${dialect}: the batch takes the tree, and the server answers a count that stops one row past the cap`, () =>
      withFixture(makeFixture, `count-over-a-limit-${dialect}`, async (f) => {
        for (let spawned = 0; spawned < 5; spawned++) await f.store.spawn('q', 'job', '{}')
        await f.store.spawn('another-queue', 'job', '{}')
        const counted = async (queue: string, cap: number) => {
          const reads = new FencedBatch('fixture:table-rows', READS_SEED, COMPILED_BY[dialect])
          reads.readTree('rows', tableRowsRead({ table: 'tasks', queue, cap }))
          return readRows(reads, await reads.run(f.raw), 'rows')
        }
        // Strict equality: a count a driver hands back as a string or a bigint fails here.
        expect({
          underTheCap: await counted('q', 10),
          atTheCap: await counted('q', 5),
          pastTheCap: await counted('q', 3),
          anotherQueue: await counted('another-queue', 3),
          aQueueWithNoRow: await counted('an-empty-queue', 3),
        }).toEqual({
          underTheCap: [{ row_count: 5 }],
          atTheCap: [{ row_count: 5 }],
          pastTheCap: [{ row_count: 4 }],
          anotherQueue: [{ row_count: 1 }],
          aQueueWithNoRow: [{ row_count: 0 }],
        })
      }))
  }
})
