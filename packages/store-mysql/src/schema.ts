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
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
