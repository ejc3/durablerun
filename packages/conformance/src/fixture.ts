import type { Buggify, SchedulerStore, SqlExecutor, StoreAdmin } from '@durablerun/core'

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
      column:
        | 'enqueue_at_ms'
        | 'cancel_at_ms'
        | 'fence_at_ms'
        | 'attempts'
        | 'max_attempts'
        | 'infra_retries'
      invalidRepresentation: 'fractional-real' | 'non-integer'
    }
  | {
      table: 'runs'
      runId: string
      column:
        | 'available_at_ms'
        | 'claim_expires_at_ms'
        | 'heartbeat_at_ms'
        | 'created_at_ms'
        | 'lease_ms'
        | 'attempt'
        | 'claim_gen'
        | 'activated_gen'
        | 'relaunch_count'
      invalidRepresentation: 'fractional-real' | 'non-integer'
    }
  | {
      table: 'checkpoints'
      taskId: string
      checkpointName: string
      column: 'owner_attempt' | 'updated_at_ms'
      invalidRepresentation: 'fractional-real' | 'non-integer'
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
