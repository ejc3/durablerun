/**
 * MySQL scheduler-plane schema.
 *
 * The logical shape and the version numbers track store-libsql and
 * store-postgres. The physical representation follows MySQL:
 *
 * - An indexed string is `VARCHAR(255)` under `utf8mb4_0900_bin`, which compares
 *   byte for byte, is case and accent sensitive, and does not pad trailing
 *   spaces. MySQL cannot index a TEXT column without a prefix, and an InnoDB
 *   key holds 3072 bytes, so an identifier here is at most 255 characters.
 * - JSON and other payloads are `LONGTEXT`: TEXT ends at 64 KiB. So are the two
 *   engine strings no index holds, the claim token and the statement stamp, which
 *   are compared and never looked up, so nothing bounds their length.
 * - Every counter, duration, and epoch-millisecond instant is `BIGINT`.
 * - MySQL has no partial index. Its unique indexes already hold NULL keys
 *   apart, which is what `tasks_idem` needs, and the hot indexes lead with the
 *   state a partial index would have filtered on.
 *
 * MySQL commits every DDL statement on its own, so a version's statements
 * cannot roll back together. Version 1 therefore creates the whole current
 * schema with statements that are each safe to repeat, and versions 2 to 5,
 * which only altered tables in the other dialects, hold nothing. A migrator
 * that dies inside version 1 leaves tables a rerun finds and skips.
 */

import { IDENTIFIER_CHARACTERS } from '@durablerun/core'

// The width is core's, because every dialect refuses what this one cannot index. MySQL
// counts a VARCHAR in characters, which are code points, as the contract does.
const ID = `VARCHAR(${IDENTIFIER_CHARACTERS}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`
const NAME = ID
const BODY = 'LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'
const STATE = 'VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin'
const LIVE_OR_TERMINAL = `('pending','running','sleeping','completed','failed','cancelled')`

export interface MysqlMigration {
  readonly version: number
  readonly statements: readonly string[]
}

/** The one read whose missing-table error means the database is fresh. */
export const SCHEMA_VERSION_READ_SQL =
  "SELECT value FROM meta WHERE `key` = 'schema_version'" as const

/** `key` is a reserved word in MySQL, so every statement quotes it. */
export const META_TABLE_SQL = `CREATE TABLE IF NOT EXISTS meta (
  \`key\` ${ID} NOT NULL PRIMARY KEY,
  value ${BODY} NOT NULL
)`

/**
 * The bootstrap: the version table and its version-zero row, in ONE statement.
 *
 * MySQL commits each DDL statement on its own. Written as a CREATE TABLE and then an
 * INSERT, the bootstrap leaves the table committed and its row not yet, and a concurrent
 * version read would report a rowless version table, which is a foreign database.
 * `CREATE TABLE … AS SELECT` is one atomic statement: no reader sees the table without
 * the row. Measured over 250 cold starts with six racing readers: 765 rowless reads with
 * two statements, none with one. Over a table that is already there it inserts nothing,
 * so it cannot reset a recorded version.
 */
export const META_BOOTSTRAP_SQL = `${META_TABLE_SQL} AS SELECT 'schema_version' AS \`key\`, '0' AS value`

/**
 * How much of a statement stamp `runs_stamp` holds, which is all an InnoDB index can: 768
 * characters of `utf8mb4`. A search of the index for one call's stamp touches every entry
 * that shares the prefix, so the prefix has to hold what tells two calls apart. A call's
 * stamp opens with its token. The production token is 32 characters, and a test's id source
 * draws longer ones that differ only at their end: at 64 the claimers of one conformance
 * fixture shared every entry and deadlocked on each other's rows. An entry is as long as
 * its stamp, so the width costs a short stamp nothing.
 */
const STAMP_INDEX_PREFIX = 768

/**
 * The indexes this package's statements name. The schema declares them, and the compiler
 * and the plan tests read their names from here, so a rename moves a frozen schema hash
 * before it can reach a server.
 */
export const RUNS_TASK_ATTEMPT_INDEX = 'runs_task_attempt'
export const RUNS_STAMP_INDEX = 'runs_stamp'

/**
 * How much of a claim token `runs_held` holds. A key of `(queue, claimed_by, state)` is 255
 * and 16 characters of four bytes beside this prefix, 2,104 bytes of the 3,072 InnoDB allows.
 */
const HELD_INDEX_PREFIX = 255

/**
 * `CREATE INDEX` in a form that is safe to repeat. MySQL commits each DDL statement on
 * its own and has no `CREATE INDEX IF NOT EXISTS`, so a migrator that died after the
 * index and before the version would fail its rerun on a duplicate key name. The
 * statement is chosen by what the catalog holds and then prepared, all in the one
 * session a migration batch runs in, under the migration lock.
 */
export function createIndexIfMissing(table: string, index: string, columns: string): string[] {
  return [
    `SET @durablerun_ddl = IF(
       (SELECT COUNT(*) FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = '${table}' AND index_name = '${index}') = 0,
       'CREATE INDEX ${index} ON ${table} ${columns}',
       'DO 0')`,
    'PREPARE durablerun_ddl FROM @durablerun_ddl',
    'EXECUTE durablerun_ddl',
    'DEALLOCATE PREPARE durablerun_ddl',
  ]
}

/**
 * `ALTER TABLE … MODIFY … NOT NULL` in a form that does nothing once the catalog calls the
 * column NOT NULL. MySQL commits each DDL statement on its own, so a migrator that died
 * after the change and before the version runs the version again, and a migrator that planned
 * from a stale read replays it. MODIFY restates the whole column, so a replay of the bare
 * statement would put this declaration back over whatever a later version made of the
 * column. Guarded by the catalog, a replay finds the column not nullable and does nothing.
 * The statement is chosen by what the catalog holds and then prepared, as an index is. It
 * does nothing ONLY on the catalog's word that the column is NOT NULL: a column the catalog
 * does not hold is a caller's mistake, and the form then attempts the change, which fails
 * loudly, where doing nothing would let the caller's version be recorded over a column that
 * never changed. So "while nullable" says what it does for every column the catalog holds,
 * and for one it does not hold the server refuses the attempt with error 1054.
 *
 * The change is asked for in place and with no lock, and that clause carries the refusal of
 * a NULL. Under a strict `sql_mode` it is how InnoDB makes the change anyway, and a row that
 * holds NULL refuses it with error 1138. Outside a strict mode MySQL makes the bare change
 * by storing an empty string where a NULL was. It cannot do that in place, so with the clause
 * it refuses with error 1846 whatever the rows hold. The executor sets a strict mode on every
 * connection it takes, but that is session state kept in another file, and a port in another
 * language replays this text and not that setup. The clause also stops the server from
 * falling back in silence to a copying change that blocks writes.
 */
export function setNotNullWhileNullable(
  table: string,
  column: string,
  declaration: string,
): string[] {
  return [
    `SET @durablerun_ddl = IF(
       (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = '${table}' AND column_name = '${column}') = 'NO',
       'DO 0',
       'ALTER TABLE ${table} MODIFY ${column} ${declaration} NOT NULL, ALGORITHM=INPLACE, LOCK=NONE')`,
    'PREPARE durablerun_ddl FROM @durablerun_ddl',
    'EXECUTE durablerun_ddl',
    'DEALLOCATE PREPARE durablerun_ddl',
  ]
}

export const MIGRATIONS: readonly MysqlMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tasks (
        task_id ${ID} NOT NULL PRIMARY KEY,
        queue ${NAME} NOT NULL,
        task_name ${BODY} NOT NULL,
        params ${BODY} NOT NULL,
        headers ${BODY},
        retry_strategy ${BODY} NOT NULL,
        max_attempts BIGINT NOT NULL,
        cancellation ${BODY},
        idempotency_key ${NAME},
        state ${STATE} NOT NULL DEFAULT 'pending',
        attempts BIGINT NOT NULL DEFAULT 0,
        infra_retries BIGINT NOT NULL DEFAULT 0,
        last_attempt_run ${ID},
        completed_payload ${BODY},
        failure_reason ${BODY},
        enqueue_at_ms BIGINT NOT NULL,
        first_started_at_ms BIGINT,
        cancel_at_ms BIGINT,
        cancelled_at_ms BIGINT,
        created_at_ms BIGINT NOT NULL,
        fence_stamp ${BODY},
        fence_at_ms BIGINT,
        CONSTRAINT tasks_state CHECK (state IN ${LIVE_OR_TERMINAL}),
        UNIQUE KEY tasks_idem (queue, idempotency_key),
        KEY tasks_cancel (queue, state, cancel_at_ms)
      )`,

      `CREATE TABLE IF NOT EXISTS runs (
        run_id ${ID} NOT NULL PRIMARY KEY,
        queue ${NAME} NOT NULL,
        task_id ${ID} NOT NULL,
        attempt BIGINT NOT NULL,
        state ${STATE} NOT NULL,
        claimed_by ${BODY},
        claim_gen BIGINT NOT NULL DEFAULT 0,
        activated_gen BIGINT NOT NULL DEFAULT 0,
        relaunch_count BIGINT NOT NULL DEFAULT 0,
        lease_ms BIGINT,
        claim_expires_at_ms BIGINT,
        heartbeat_at_ms BIGINT,
        available_at_ms BIGINT,
        wake_event ${NAME},
        event_payload ${BODY},
        run_db ${BODY},
        started_at_ms BIGINT,
        completed_at_ms BIGINT,
        failed_at_ms BIGINT,
        result ${BODY},
        failure_reason ${BODY},
        created_at_ms BIGINT NOT NULL,
        wake_step ${NAME},
        fence_stamp ${BODY},
        fence_at_ms BIGINT,
        CONSTRAINT runs_state CHECK (state IN ${LIVE_OR_TERMINAL}),
        KEY runs_poll (queue, state, available_at_ms),
        KEY runs_lease (queue, state, claim_expires_at_ms),
        UNIQUE KEY ${RUNS_TASK_ATTEMPT_INDEX} (task_id, attempt)
      )`,

      `CREATE TABLE IF NOT EXISTS checkpoints (
        task_id ${ID} NOT NULL,
        checkpoint_name ${NAME} NOT NULL,
        queue ${NAME} NOT NULL,
        state ${BODY} NOT NULL,
        status ${STATE} NOT NULL DEFAULT 'committed',
        owner_run_id ${ID} NOT NULL,
        owner_attempt BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (task_id, checkpoint_name)
      )`,

      `CREATE TABLE IF NOT EXISTS events (
        queue ${NAME} NOT NULL,
        event_name ${NAME} NOT NULL,
        payload ${BODY},
        emitted_at_ms BIGINT,
        fence_stamp ${BODY},
        fence_at_ms BIGINT,
        PRIMARY KEY (queue, event_name)
      )`,

      `CREATE TABLE IF NOT EXISTS waits (
        run_id ${ID} NOT NULL,
        step_name ${NAME} NOT NULL,
        queue ${NAME} NOT NULL,
        task_id ${ID} NOT NULL,
        event_name ${NAME} NOT NULL,
        status ${STATE} NOT NULL DEFAULT 'waiting',
        timeout_at_ms BIGINT,
        created_at_ms BIGINT NOT NULL,
        fence_stamp ${BODY},
        fence_at_ms BIGINT,
        PRIMARY KEY (run_id, step_name),
        CONSTRAINT waits_status CHECK (status IN ('waiting','delivered')),
        KEY waits_event (queue, event_name)
      )`,

      `CREATE TABLE IF NOT EXISTS drivers (
        queue ${NAME} NOT NULL,
        driver_id ${ID} NOT NULL,
        last_beat_ms BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        PRIMARY KEY (queue, driver_id)
      )`,
    ],
  },
  // Versions 2 to 5 added the drivers table, runs.wake_step, the provenance columns, and
  // SQLite's driver-heartbeat trigger. Version 1 above already holds all of it.
  { version: 2, statements: [] },
  { version: 3, statements: [] },
  { version: 4, statements: [] },
  { version: 5, statements: [] },
  {
    // A batch that ends a task or emits an event finds the runs it just woke by their
    // `wake_event`, among the pending runs of the queue. The other dialects hold those
    // runs in a partial index, which MySQL does not have, so the state is the index's
    // last column: the lookup is one seek to the pending runs of one event, whatever
    // else the queue holds and however many runs that event woke before. It is an index
    // and nothing else: a build that predates it runs against this schema unchanged.
    version: 6,
    statements: createIndexIfMissing('runs', 'runs_woken', '(queue, wake_event, state)'),
  },
  // PostgreSQL's version 7 declares a byte collation on every text column. Version 1
  // above already declares one on every string column.
  { version: 7, statements: [] },
  {
    // A DELETE reads its subquery's table with shared locks, even under READ COMMITTED,
    // where a single-table UPDATE reads it with none. A batch that deletes the waits of
    // the runs it stamped finds those runs by their stamp, and through an index of the
    // queue and the state that search covers other transactions' runs, waits for each one
    // still held, and two such batches deadlock. Every stamping write changes the stamp, so
    // a stamped run's entry in this index is its own transaction's, and a search of it for
    // one batch's stamp touches no other entry. The stamp is a LONGTEXT, so the index is a
    // prefix, as wide as InnoDB allows. It is an index and nothing else: a build that
    // predates it runs against this schema unchanged.
    version: 8,
    statements: createIndexIfMissing(
      'runs',
      RUNS_STAMP_INDEX,
      `(fence_stamp(${STAMP_INDEX_PREFIX}))`,
    ),
  },
  {
    // A claim finds what ONE token holds: its held guard asks whether the token holds a run
    // already, and its receipt read returns the runs it holds. By queue and state alone the
    // only index was `runs_poll`, so both walked every running run of the queue, on every
    // tick, the idle ones included: one claim measured 33 ms beside 10,000 running runs and
    // 638 ms beside 40,000 under the server's default buffer pool, against 4 ms. MySQL has
    // no partial index, so the state is the last column, as in `runs_woken`. The token is a
    // LONGTEXT, so the index holds a prefix of it: the engine's own tokens are 32
    // characters, and a caller's longer one still seeks by its first 255 and is then
    // compared whole on the row. It is an index and nothing else: a build that predates it
    // runs against this schema unchanged.
    version: 9,
    statements: createIndexIfMissing(
      'runs',
      'runs_held',
      `(queue, claimed_by(${HELD_INDEX_PREFIX}), state)`,
    ),
  },
  {
    // An await that timed out answers with no payload, and an emitted event answers with
    // its payload, so an event row that held SQL NULL would read as a timeout. The port
    // refuses to write one. From this version the column refuses it too, for every writer
    // there is, a port in another language included. This is the first version that alters
    // a table, and it goes through the guarded form above. A row that holds NULL makes the
    // change fail with error 1138, which leaves the column nullable, the version at 9 and
    // the row as it was. A session with no strict mode is refused with error 1846 whatever
    // the rows hold. The rows are found with
    // `SELECT queue, event_name FROM events WHERE payload IS NULL`.
    version: 10,
    statements: setNotNullWhileNullable('events', 'payload', BODY),
  },
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

/**
 * The schema versions this build's reads accept. A read-only tool, such as the operator
 * CLI, answers against any version in the window and refuses one outside it, and it never
 * migrates. This store was never released, so no deployed database is known to be at an
 * older version, and the window is the current version alone. A database recorded past
 * `newest` was migrated by a newer build and is refused.
 */
export const READABLE_SCHEMA_WINDOW = Object.freeze({
  oldest: CURRENT_SCHEMA_VERSION,
  newest: CURRENT_SCHEMA_VERSION,
})
