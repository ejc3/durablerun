import type { Buggify, SqlExecutor } from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import type { StorageCorruption, StoreFixture } from '../src/index.js'

async function injectStorageCorruption(
  raw: SqlExecutor,
  corruption: StorageCorruption,
): Promise<'injected'> {
  const value =
    corruption.invalidRepresentation === 'non-integer'
      ? 'bad-time'
      : new Uint8Array([112, 111, 105, 115, 111, 110])
  switch (corruption.table) {
    case 'tasks':
      await raw.batch(
        'fixture:storage-corrupt',
        [
          {
            sql: `UPDATE tasks SET ${corruption.column} = ? WHERE task_id = ?`,
            args: [value, corruption.taskId],
          },
        ],
        'write',
      )
      break
    case 'runs':
      await raw.batch(
        'fixture:storage-corrupt',
        [
          {
            sql: `UPDATE runs SET ${corruption.column} = ? WHERE run_id = ?`,
            args: [value, corruption.runId],
          },
        ],
        'write',
      )
      break
    case 'checkpoints':
      await raw.batch(
        'fixture:storage-corrupt',
        [
          {
            sql: `UPDATE checkpoints SET ${corruption.column} = ?
                  WHERE task_id = ? AND checkpoint_name = ?`,
            args: [value, corruption.taskId, corruption.checkpointName],
          },
        ],
        'write',
      )
      break
  }
  return 'injected'
}

export async function makeLibsqlFixture(seed: number | string): Promise<StoreFixture> {
  const { raw, admin } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  return {
    store: new LibsqlSchedulerStore(raw, ids),
    admin,
    raw,
    injectStorageCorruption: (corruption) => injectStorageCorruption(raw, corruption),
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new LibsqlSchedulerStore(db, ids, buggify),
    close: () => raw.close(),
  }
}
