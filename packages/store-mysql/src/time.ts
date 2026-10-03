/**
 * MySQL statement-stable database time as an exact epoch-millisecond BIGINT.
 * `UTC_TIMESTAMP(6)` is the statement's start time, so every occurrence in one
 * statement agrees, and it does not depend on the session time zone. `SYSDATE()`
 * re-reads the wall clock on every call and must never stand here. The
 * test-only fake clock stays in `meta`, matching every dialect's StoreAdmin
 * contract.
 */
export const NOW_MS = `COALESCE(
  (SELECT CAST(value AS SIGNED) FROM meta WHERE \`key\` = 'fake_now_ms'),
  CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6)) DIV 1000 AS SIGNED)
)`

/**
 * `fake-clock`: whether the test clock is set, as the integer 1 or 0. It asks for the row
 * `NOW_MS` reads ahead of the server's own clock. An operator's read reports it, so that
 * database time a test wrote is not taken for the time.
 */
export const FAKE_CLOCK_READ_SQL =
  "SELECT CASE WHEN (SELECT value FROM meta WHERE `key` = 'fake_now_ms') IS NOT NULL THEN 1 ELSE 0 END AS fake_clock"
