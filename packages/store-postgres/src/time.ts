/**
 * PostgreSQL statement-stable database time as an exact epoch-millisecond
 * BIGINT. The test-only fake clock stays in `meta`, matching every dialect's
 * StoreAdmin contract.
 */
export const NOW_MS = `COALESCE(
  (SELECT CAST(value AS BIGINT) FROM meta WHERE key = 'fake_now_ms'),
  CAST(FLOOR(EXTRACT(EPOCH FROM statement_timestamp()) * 1000) AS BIGINT)
)`
