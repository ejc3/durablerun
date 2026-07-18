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
