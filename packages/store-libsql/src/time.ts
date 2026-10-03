/**
 * Engine time is database time (DESIGN.md §3.4 rule 3). Every timestamp in
 * every engine statement comes from this SQL expression — an epoch-ms integer
 * honoring the shard-meta `fake_now_ms` override so simulations own the
 * clock. Absurd does the same with its `absurd.fake_now` session GUC.
 */
export const NOW_MS = `COALESCE(
  (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'fake_now_ms'),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
)`

/**
 * `fake-clock`: whether the test clock is set, as the integer 1 or 0. It asks for the row
 * `NOW_MS` reads ahead of the server's own clock. An operator's read reports it, so that
 * database time a test wrote is not taken for the time.
 */
export const FAKE_CLOCK_READ_SQL = `SELECT CASE WHEN (SELECT value FROM meta WHERE key = 'fake_now_ms') IS NOT NULL THEN 1 ELSE 0 END AS fake_clock`
