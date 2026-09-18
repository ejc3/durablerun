import type { SqlBatchControl, SqlStatement } from '@durablerun/core'
import { expect, it } from 'vitest'
import { describeFailure } from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

// PostgreSQL resolves a table's name against the newest catalog and reads its rows under
// a snapshot. A transaction that holds a REPEATABLE READ snapshot taken before a
// concurrent bootstrap commits, and looks the name up after, is answered with the meta
// table and no version row, and the admin calls a rowless meta table malformed. Under
// READ COMMITTED the same read sees the row, because each statement's snapshot is taken
// when it runs. That is why the executor reads the schema version under READ COMMITTED.
//
// One advisory lock orders the two transactions, and the rows are the server's own. What
// this cannot order is the inside of one statement, where REPEATABLE READ still takes its
// snapshot before the lookup. Racing real migrators showed that: a migrator was rejected
// in 18 of 300 rounds, and in none of 1800 with the version read under READ COMMITTED.
const LOCK_BASE = (process.pid % 1_000_000) * 1000 + 312
const lockIs = (key: number, state: 'granted' | 'NOT granted'): string =>
  `SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory' AND classid = 0 AND objid = ${key} AND objsubid = 1
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND ${state}`
const waitUntil = (what: string, predicate: string): SqlStatement => ({
  // A bounded poll of a real predicate: pg_locks is live, not a snapshot. About three
  // seconds, well inside this test's own timeout, so a broken order reports itself.
  sql: `DO $$ DECLARE hops integer := 0; BEGIN
          WHILE NOT EXISTS (${predicate}) LOOP
            hops := hops + 1;
            IF hops > 1500 THEN RAISE EXCEPTION '${what} never happened'; END IF;
            PERFORM pg_sleep(0.002);
          END LOOP;
        END $$`,
  args: [],
})

it.each([
  { isolation: 'REPEATABLE READ', control: 'read', sees: 'the table and no row', rows: [] },
  { isolation: 'READ COMMITTED', control: 'write', sees: 'the row', rows: [{ value: '0' }] },
] satisfies { isolation: string; control: SqlBatchControl; sees: string; rows: unknown[] }[])(
  'under $isolation, a read that waits across a bootstrap commit sees $sees',
  async ({ control, rows }) => {
    const key = LOCK_BASE + (control === 'read' ? 0 : 1)
    const fixture = await makePostgresFixture(`bootstrap-window-${control}`, { migrate: false })
    try {
      const [bootstrap, read] = await Promise.allSettled([
        // A migrator's bootstrap, held open until the reader is waiting on it.
        fixture.raw.batch('fixture:bootstrap-held-until-a-reader-waits', [
          { sql: `SELECT pg_advisory_xact_lock(${key})`, args: [] },
          { sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', args: [] },
          { sql: `INSERT INTO meta (key, value) VALUES ('schema_version', '0')`, args: [] },
          waitUntil('a reader waiting on the bootstrap', lockIs(key, 'NOT granted')),
        ]),
        fixture.raw.batch(
          'fixture:read-across-the-bootstrap-commit',
          [
            { sql: 'SELECT 1', args: [] }, // a REPEATABLE READ snapshot is taken here
            waitUntil('the bootstrap taking its lock', lockIs(key, 'granted')),
            { sql: `SELECT pg_advisory_xact_lock_shared(${key})`, args: [] }, // returns at the commit
            { sql: `SELECT value FROM meta WHERE key = 'schema_version'`, args: [] },
          ],
          control,
        ),
      ])
      expect({
        bootstrap:
          bootstrap.status === 'rejected' ? describeFailure(bootstrap.reason) : 'committed',
        read: read.status === 'rejected' ? describeFailure(read.reason) : read.value.at(-1)?.rows,
      }).toEqual({ bootstrap: 'committed', read: rows })
    } finally {
      await fixture.close()
    }
  },
  30_000,
)
