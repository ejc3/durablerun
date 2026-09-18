import type { SqlBatchControl, SqlStatement } from '@durablerun/core'
import { expect, it } from 'vitest'
import { describeFailure } from '../src/scenario.js'
import { makePostgresFixture } from './fixture-postgres.js'

// PostgreSQL resolves a table's name against the newest catalog and reads its rows under
// a snapshot. REPEATABLE READ takes that snapshot when the transaction's first statement
// starts, before the statement resolves its names. READ COMMITTED takes the execution
// snapshot after it has. So ONE statement that races a bootstrap's commit is answered
// with the meta table and no version row under REPEATABLE READ, which the admin calls a
// malformed database, and with the row under READ COMMITTED. That is why the executor
// reads the schema version under READ COMMITTED.
//
// The race is ordered inside the one statement. The statement names a second table first,
// and a concurrent transaction holds that table locked, so the statement stops in its name
// lookup with its snapshot already decided. The same transaction then bootstraps and
// commits, which releases the lock and publishes the meta table at once. This shows the
// server, not the executor: the executor's canonical read names one table and cannot be
// held this way, so the executor's own unit test holds the isolation level it asks for.
const gateLock = (state: 'granted' | 'NOT granted'): string =>
  `SELECT 1 FROM pg_locks
    WHERE locktype = 'relation' AND relation = 'gate'::regclass
      AND mode = '${state === 'granted' ? 'AccessExclusiveLock' : 'AccessShareLock'}' AND ${state}`
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
const VERSION_BEHIND_THE_GATE = `SELECT m.value FROM gate g, meta m WHERE m.key = 'schema_version'`

it.each([
  {
    isolation: 'REPEATABLE READ',
    sees: 'the table and no row',
    control: 'read',
    begin: [],
    rows: [],
  },
  {
    isolation: 'READ COMMITTED',
    sees: 'the row',
    control: 'write',
    begin: [{ sql: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY', args: [] }],
    rows: [{ value: '0' }],
  },
] satisfies {
  isolation: string
  sees: string
  control: SqlBatchControl
  begin: SqlStatement[]
  rows: unknown[]
}[])(
  'under $isolation, one statement that races a bootstrap commit sees $sees',
  async ({ control, begin, rows }) => {
    const fixture = await makePostgresFixture(`bootstrap-window-${control}`, { migrate: false })
    try {
      await fixture.raw.batch('fixture:gate', [
        { sql: 'CREATE TABLE gate (x INTEGER NOT NULL)', args: [] },
        { sql: 'INSERT INTO gate (x) VALUES (1)', args: [] },
      ])
      // A migrator's bootstrap, behind a lock on the gate, committed once the reader waits.
      const bootstrap = fixture.raw.batch('fixture:bootstrap-behind-the-gate', [
        { sql: 'LOCK TABLE gate IN ACCESS EXCLUSIVE MODE', args: [] },
        waitUntil('a reader stopping at the gate', gateLock('NOT granted')),
        { sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', args: [] },
        { sql: `INSERT INTO meta (key, value) VALUES ('schema_version', '0')`, args: [] },
      ])
      // The reader starts only once the gate is held. A bounded poll, with no sleep.
      let held = false
      for (let polls = 0; polls < 5000 && !held; polls++) {
        const [locks] = await fixture.raw.batch(
          'fixture:gate-held',
          [{ sql: gateLock('granted'), args: [] }],
          'read',
        )
        held = (locks?.rows.length ?? 0) > 0
      }
      const [committed, read] = await Promise.allSettled([
        bootstrap,
        fixture.raw.batch(
          'fixture:one-statement-across-the-commit',
          [...begin, { sql: VERSION_BEHIND_THE_GATE, args: [] }],
          control,
        ),
      ])
      expect({
        gateHeldFirst: held,
        bootstrap:
          committed.status === 'rejected' ? describeFailure(committed.reason) : 'committed',
        read: read.status === 'rejected' ? describeFailure(read.reason) : read.value.at(-1)?.rows,
      }).toEqual({ gateHeldFirst: true, bootstrap: 'committed', read: rows })
    } finally {
      await fixture.close()
    }
  },
  30_000,
)
