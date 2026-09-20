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
import type { SelfRaceName } from './self-concurrency.js'

type PersistedNumericField = PersistedCounterFieldDescriptor | PersistedTemporalFieldDescriptor
export type PersistedNumericTable = PersistedNumericField['table']
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
  /** Construct the dialect's real admin over an injected executor. */
  adminOver(db: SqlExecutor): StoreAdmin
  /** The real executor — for raw shared-schema assertions and SimWorld. */
  raw: SqlExecutor
  /**
   * Dialect catalog reads projected into the shared schema-evidence columns:
   * `table_name`, `column_name`, raw `native_type`, and `nullable`.
   * The statements return every column in the requested tables; they must not
   * filter to the contract inventory, or a missing/wrongly typed field could
   * disappear before the shared comparison sees it.
   * The shared runner executes and validates the statements; fixtures cannot
   * award themselves conformance by returning a success token.
   */
  persistedIntegerCatalogStatements(
    tables: readonly PersistedNumericTable[],
  ): readonly SqlStatement[]
  /**
   * The two raw writes the schema-admin surface makes to the version table. They are
   * the dialect's because no one spelling is portable: the table's `key` column is a
   * reserved word MySQL must quote, in a way PostgreSQL and SQLite read as a string, and
   * MySQL cannot make a TEXT column a primary key. The shared runner still executes
   * them and owns every assertion about what the admin then does.
   */
  schemaVersionTable: {
    /** Overwrite the stored version with `value`, canonical or not. Exactly one row. */
    setVersion(value: string): SqlStatement
    /** Create the version table with its real columns and no row. */
    createEmpty(): SqlStatement
  }
  /** Prepare, but do not execute, the dialect's invalid-storage write. */
  storageCorruptionAttempt(corruption: StorageCorruption): StorageCorruptionAttempt
  /**
   * A store over a substitute executor (a SimWorld actor wrapper) sharing
   * this fixture's database and id stream — how sims run N concurrent
   * actors against one database.
   */
  storeOver(db: SqlExecutor, buggify?: Buggify): SchedulerStore
  /**
   * How many times the server has chosen one of this fixture's batches as a deadlock
   * victim, read from the fixture's own executor. The executor runs a victim again, which
   * hides a lock-order inversion from every caller, and the server's own count is shared
   * by every test worker connected to it. A dialect whose executor never meets a deadlock
   * victim answers zero.
   */
  deadlocks(): number
  /**
   * The contests of the self-concurrency surface in which this dialect's server may pick a
   * deadlock victim today, by name, each with what was measured and why. An entry excuses
   * that one count, up to what the copies' attempts allow, and nothing else: the contest
   * still holds its answers, its rows, and the invariants, and every other contest holds
   * the count at zero. An entry records a defect that is deferred, never a convenience,
   * and it goes when the defect does. The type admits only the name of a contest that
   * exists.
   */
  selfRaceDeadlocksExcused: Readonly<Partial<Record<SelfRaceName, string>>>
  /** Fully release every fixture-owned resource before resolving. */
  close(): Promise<void>
}

export interface StoreFixtureOptions {
  /** Defaults to true. False exposes a genuinely fresh database to admin conformance. */
  readonly migrate?: boolean
}

export type StoreFixtureFactory = (
  seed: number | string,
  options?: StoreFixtureOptions,
) => Promise<StoreFixture>

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
