import type { Buggify, SqlExecutor } from '@durablerun/core'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import type { StorageCorruption, StoreFixture } from '../src/index.js'

async function injectStorageCorruption(
  raw: SqlExecutor,
  corruption: StorageCorruption,
): Promise<'injected'> {
  const fractionalValue =
    corruption.column === 'max_attempts' ||
    corruption.column === 'attempt' ||
    corruption.column === 'lease_ms' ||
    corruption.column === 'owner_attempt'
      ? 1.5
      : 0.5
  const value =
    corruption.invalidRepresentation === 'non-integer'
      ? 'bad-time'
      : corruption.invalidRepresentation === 'fractional-real'
        ? fractionalValue
        : new Uint8Array([112, 111, 105, 115, 111, 110])
  let table: 'checkpoints' | 'runs' | 'tasks'
  let where: string
  let identityArgs: string[]
  switch (corruption.table) {
    case 'tasks':
      table = 'tasks'
      where = 'task_id = ?'
      identityArgs = [corruption.taskId]
      break
    case 'runs':
      table = 'runs'
      where = 'run_id = ?'
      identityArgs = [corruption.runId]
      break
    case 'checkpoints':
      table = 'checkpoints'
      where = 'task_id = ? AND checkpoint_name = ?'
      identityArgs = [corruption.taskId, corruption.checkpointName]
      break
  }
  const [, observed] = await raw.batch(
    'fixture:storage-corrupt',
    [
      {
        sql: `UPDATE ${table} SET ${corruption.column} = ? WHERE ${where}`,
        args: [value, ...identityArgs],
      },
      {
        sql: `SELECT typeof(${corruption.column}) AS storage_type,
                     ${corruption.column} AS stored_value
              FROM ${table} WHERE ${where}`,
        args: identityArgs,
      },
    ],
    'write',
  )
  const expectedStorageType =
    corruption.invalidRepresentation === 'non-integer'
      ? 'text'
      : corruption.invalidRepresentation === 'fractional-real'
        ? 'real'
        : 'blob'
  const row = observed?.rows[0]
  if (
    row?.storage_type !== expectedStorageType ||
    (corruption.invalidRepresentation !== 'non-text' && row.stored_value !== value)
  ) {
    throw new Error(
      `storage corruption was not preserved as ${expectedStorageType} ${String(value)}; got ${String(row?.storage_type)} ${String(row?.stored_value)}`,
    )
  }
  return 'injected'
}

export async function makeLibsqlFixture(seed: number | string): Promise<StoreFixture> {
  const encodedSeed = [...String(seed)]
    .map((character) => character.codePointAt(0)?.toString(16))
    .join('_')
  const { raw, admin, ids } = await openTestDb({
    idNamespace: `conformance-${encodedSeed || 'empty'}`,
  })
  return {
    store: new LibsqlSchedulerStore(raw, ids),
    admin,
    raw,
    injectStorageCorruption: (corruption) => injectStorageCorruption(raw, corruption),
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new LibsqlSchedulerStore(db, ids, buggify),
    close: () => raw.close(),
  }
}
