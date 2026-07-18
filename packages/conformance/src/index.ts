/**
 * The dialect-agnostic conformance suite (BUILD.md). Today the scenarios live
 * in test/ against the libsql store; PR4.1 parametrizes them over a
 * StoreFixture factory so every dialect runs the identical battery.
 */
export interface StoreFixtureDeps {
  /** Opens a fresh, migrated store over a fresh database. */
  seed: number | string
}
