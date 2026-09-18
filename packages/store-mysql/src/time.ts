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
