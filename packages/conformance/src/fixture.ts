import type {
  Buggify,
  PersistedCounterFieldDescriptor,
  PersistedTemporalFieldDescriptor,
  SchedulerStore,
  SqlExecutor,
  SqlResult,
  SqlStatement,
  StoreAdmin,
} from '@durablerun/core'

type PersistedNumericField = PersistedCounterFieldDescriptor | PersistedTemporalFieldDescriptor
type PersistedNumericColumn<Table extends PersistedNumericField['table']> = Extract<
  PersistedNumericField,
  { readonly table: Table }
>['column']
type InvalidNumericRepresentation = 'fractional-real' | 'non-integer'

/**
 * A deliberately invalid storage representation used by the generated poison
 * surface. A permissive backend may inject it; a strict native type may reject
 * it structurally. Keeping this descriptor above every dialect fixture avoids
 * baking SQLite's dynamic typing into the shared scenarios.
 */
export type StorageCorruption =
  | {
      table: 'tasks'
      taskId: string
      column: PersistedNumericColumn<'tasks'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'runs'
      runId: string
      column: PersistedNumericColumn<'runs'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'checkpoints'
      taskId: string
      checkpointName: string
      column: PersistedNumericColumn<'checkpoints'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'events'
      queue: string
      eventName: string
      column: PersistedNumericColumn<'events'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'waits'
      runId: string
      stepName: string
      column: PersistedNumericColumn<'waits'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'drivers'
      queue: string
      driverId: string
      column: PersistedNumericColumn<'drivers'>
      invalidRepresentation: InvalidNumericRepresentation
    }
  | {
      table: 'tasks'
      taskId: string
      column: 'fence_stamp'
      invalidRepresentation: 'non-text'
    }

export type StorageCorruptionDisposition = 'injected' | 'structurally-rejected'

/**
 * A dialect-specific invalid-storage write prepared for shared execution.
 *
 * The conformance runner, not the fixture, owns execution. That makes a
 * claimed structural rejection observable: at least one actual SQL statement
 * must cross the fixture's raw executor and raise an error that the dialect's
 * narrow classifier recognizes.
 */
export interface StorageCorruptionAttempt {
  readonly statements: readonly SqlStatement[]
  readonly verify: (results: readonly SqlResult[]) => void | Promise<void>
  readonly isStructuralRejection: (error: unknown) => boolean
}

/**
 * The pluggability contract (repo CLAUDE.md law): a dialect is DONE when its
 * factory passes the identical suite — scheduler plane today, run-bookkeeping
 * (RunStateStore) when it lands. store-libsql implements this now;
 * store-postgres and store-mysql implement the same factory in Phase 4, and a
 * future Rust engine proves itself against the same scenarios through its own
 * runner (the scenarios, schema, and batch semantics are the language-neutral
 * spec).
 */
export interface StoreFixture {
  store: SchedulerStore
  admin: StoreAdmin
  /** The real executor — for raw shared-schema assertions and SimWorld. */
  raw: SqlExecutor
  /** Prepare, but do not execute, the dialect's invalid-storage write. */
  storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt
  /**
   * A store over a substitute executor (a SimWorld actor wrapper) sharing
   * this fixture's database and id stream — how sims run N concurrent
   * actors against one database.
   */
  storeOver(db: SqlExecutor, buggify?: Buggify): SchedulerStore
  /** Fully release every fixture-owned resource before resolving. */
  close(): Promise<void>
}

export type StoreFixtureFactory = (seed: number | string) => Promise<StoreFixture>

export function interposeAfterBatch(
  delegate: SqlExecutor,
  targetLabel: string,
  after: () => Promise<void>,
): { executor: SqlExecutor; fired: () => boolean } {
  let didFire = false
  return {
    executor: {
      batch: async (label, statements, mode) => {
        const results = await delegate.batch(label, statements, mode)
        if (!didFire && label === targetLabel) {
          didFire = true
          await after()
        }
        return results
      },
    },
    fired: () => didFire,
  }
}

/**
 * The only conformance path that may credit structural storage rejection.
 *
 * Fixtures choose dialect SQL and classify the resulting native error, but
 * cannot return a success token themselves. The shared runner executes a
 * nonempty attempt through the fixture's real raw executor before it can
 * report `structurally-rejected`.
 */
export async function executeStorageCorruption(
  fixture: StoreFixture,
  corruption: StorageCorruption,
): Promise<StorageCorruptionDisposition> {
  const attempt = fixture.storageCorruptionAttempt(corruption)
  if (attempt.statements.length === 0) {
    throw new Error('storage corruption attempt must contain at least one SQL statement')
  }
  let results: SqlResult[]
  try {
    results = await fixture.raw.batch('fixture:storage-corrupt', attempt.statements, 'write')
  } catch (error) {
    if (!attempt.isStructuralRejection(error)) throw error
    return 'structurally-rejected'
  }
  await attempt.verify(results)
  return 'injected'
}
