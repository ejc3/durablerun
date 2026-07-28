import type {
  Buggify,
  PersistedCounterFieldDescriptor,
  PersistedTemporalFieldDescriptor,
  SchedulerStore,
  SqlExecutor,
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
  /**
   * Ask the dialect fixture to construct an invalid native storage value.
   * Strict schemas report structural rejection; permissive schemas inject it
   * so the portable invariant evaluator must detect it.
   */
  injectStorageCorruption(corruption: StorageCorruption): Promise<StorageCorruptionDisposition>
  /**
   * A store over a substitute executor (a SimWorld actor wrapper) sharing
   * this fixture's database and id stream — how sims run N concurrent
   * actors against one database.
   */
  storeOver(db: SqlExecutor, buggify?: Buggify): SchedulerStore
  close(): void
}

export type StoreFixtureFactory = (seed: number | string) => Promise<StoreFixture>
