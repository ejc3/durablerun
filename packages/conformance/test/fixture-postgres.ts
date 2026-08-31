import type { Buggify, SqlExecutor } from '@durablerun/core'
import { PostgresSchedulerStore, PostgresStoreAdmin } from '@durablerun/store-postgres'
import {
  openPostgresTestDb,
  postgresPersistedIntegerCatalogStatements,
} from '@durablerun/store-postgres/testing'
import type {
  StorageCorruption,
  StorageCorruptionAttempt,
  StoreFixture,
  StoreFixtureOptions,
} from '../src/index.js'

const STRUCTURAL_NUMERIC_SQLSTATES = new Set([
  '22003', // numeric_value_out_of_range
  '22021', // character_not_in_repertoire
  '22P02', // invalid_text_representation
  '42804', // datatype_mismatch
  '42846', // cannot_coerce
])

function sqlState(error: unknown): string | undefined {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown }
    if (typeof candidate.code === 'string') return candidate.code
    current = candidate.cause
  }
  return undefined
}

function storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt {
  const fractionalValue =
    corruption.column === 'max_attempts' ||
    corruption.column === 'attempt' ||
    corruption.column === 'lease_ms' ||
    corruption.column === 'owner_attempt'
      ? 1.5
      : 0.5
  const value =
    corruption.invalidRepresentation === 'non-integer'
      ? 'bad-integer'
      : corruption.invalidRepresentation === 'fractional-real'
        ? fractionalValue
        : new Uint8Array([0xff])
  const assignment =
    corruption.invalidRepresentation === 'non-text' ? "convert_from(CAST(? AS BYTEA), 'UTF8')" : '?'

  let table: 'checkpoints' | 'drivers' | 'events' | 'runs' | 'tasks' | 'waits'
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
    case 'events':
      table = 'events'
      where = 'queue = ? AND event_name = ?'
      identityArgs = [corruption.queue, corruption.eventName]
      break
    case 'waits':
      table = 'waits'
      where = 'run_id = ? AND step_name = ?'
      identityArgs = [corruption.runId, corruption.stepName]
      break
    case 'drivers':
      table = 'drivers'
      where = 'queue = ? AND driver_id = ?'
      identityArgs = [corruption.queue, corruption.driverId]
      break
  }

  return {
    statements: [
      {
        sql: `UPDATE ${table} SET ${corruption.column} = ${assignment} WHERE ${where}`,
        args: [value, ...identityArgs],
      },
    ],
    isStructuralRejection: (error) => {
      const state = sqlState(error)
      return state !== undefined && STRUCTURAL_NUMERIC_SQLSTATES.has(state)
    },
    verify: () => {
      throw new Error(
        `PostgreSQL accepted invalid ${corruption.invalidRepresentation} storage for ${table}.${corruption.column}`,
      )
    },
  }
}

export async function makePostgresFixture(
  seed: number | string,
  options: StoreFixtureOptions = {},
): Promise<StoreFixture> {
  const encodedSeed = [...String(seed)]
    .map((character) => character.codePointAt(0)?.toString(16))
    .join('_')
  const opened = await openPostgresTestDb({
    idNamespace: `conformance-${encodedSeed || 'empty'}`,
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  })
  const { raw, admin, ids } = opened
  return {
    store: new PostgresSchedulerStore(raw, ids),
    admin,
    adminOver: (db: SqlExecutor) => new PostgresStoreAdmin(db),
    raw,
    persistedIntegerCatalogStatements: postgresPersistedIntegerCatalogStatements,
    storageCorruptionAttempt,
    storeOver: (db: SqlExecutor, buggify?: Buggify) => new PostgresSchedulerStore(db, ids, buggify),
    close: opened.close,
  }
}
