import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Clock,
  type IdSource,
  type SchedulerStore,
  type SqlExecutor,
  type SqlRow,
  type StoreAdmin,
  StoreUnavailableError,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
} from '@durablerun/store-libsql'
import {
  META_BOOTSTRAP_SQL,
  MIGRATIONS as MYSQL_MIGRATIONS,
  MysqlSchedulerStore,
} from '@durablerun/store-mysql'
import { openMysqlTestDb } from '@durablerun/store-mysql/testing'
import { PostgresSchedulerStore, PostgresStoreAdmin } from '@durablerun/store-postgres'
import { openPostgresTestDb } from '@durablerun/store-postgres/testing'
import {
  type EnrolledDialect,
  parseDialectSelection,
} from '../../conformance/test/dialect-selection.js'
import { COMMANDS, type CommandSpec, VERBS } from '../src/commands.js'
import { type Io, main } from '../src/main.js'
import { type StoreOpener, openStore } from '../src/open-store.js'

/** The dialects this run exercises, read from the one selection parser. */
export const SELECTED: readonly EnrolledDialect[] = parseDialectSelection(
  process.env.DURABLERUN_CONFORMANCE_DIALECTS,
)

/** The engine clock every database in these tests is set to, so its answers match. */
export const NOW_MS = 1_700_000_000_000

/** A clock whose every read fails: no command reads the clock. */
export const REFUSING_CLOCK: Clock = {
  nowEpochMs: () => {
    throw new Error('the CLI read the clock')
  },
  elapsedMs: () => {
    throw new Error('the CLI read the clock')
  },
  sleep: () => Promise.reject(new Error('the CLI slept on the clock')),
  yieldTurn: () => Promise.reject(new Error('the CLI yielded on the clock')),
}

export interface CliRun {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

/** Run `main` with its streams captured. */
export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  opener: StoreOpener = openStore,
  ids: IdSource = testIdSource('cli'),
): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  const io: Io = {
    out: (text) => {
      stdout += text
    },
    err: (text) => {
      stderr += text
    },
  }
  const exit = await main(argv, env, io, ids, REFUSING_CLOCK, opener)
  return { exit, stdout, stderr }
}

/** A JSON answer with the fields held under `dialect` taken out. */
export function withoutDialect(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  const { dialect: _dialect, ...rest } = parsed
  return rest
}

/** Which state a test database starts in. */
export type StartingSchema = 'current' | 'empty' | 'newer' | number

export interface CliDb {
  readonly dialect: EnrolledDialect
  /** DURABLERUN_STORE_URL for this database. */
  readonly url: string
  /** What `--target` must name for it. */
  readonly target: string
  readonly env: Readonly<Record<string, string>>
  readonly raw: SqlExecutor
  readonly admin: StoreAdmin
  /** The current store over `raw`, with ids from the test's own source. */
  readonly store: SchedulerStore
  /** Every table and schema object, as one comparable text. */
  dump(): Promise<string>
  /** Record a schema version as a newer build that migrated would, after seeding. */
  recordNewer(): Promise<void>
  close(): Promise<void>
}

class StoppedBeforeVersion extends Error {}

/** An executor that stops a real migration before the batch of `version`. */
function stoppingBefore(real: SqlExecutor, version: number): SqlExecutor {
  return {
    batch: (label, statements, control) =>
      label === `migrate:v${version}`
        ? Promise.reject(new StoppedBeforeVersion(label))
        : real.batch(label, statements, control),
  }
}

/** Take a database to one version through its real admin, stopped before the next. */
async function migrateThrough(
  raw: SqlExecutor,
  admin: (db: SqlExecutor) => StoreAdmin,
  version: number,
) {
  if (version >= CURRENT_SCHEMA_VERSION) {
    await admin(raw).migrate()
    return
  }
  await admin(stoppingBefore(raw, version + 1))
    .migrate()
    .then(
      () => {
        throw new Error(`migrate did not reach version ${version + 1}`)
      },
      (error: unknown) => {
        if (!(error instanceof StoppedBeforeVersion)) throw error
      },
    )
}

const META_KEY: Readonly<Record<EnrolledDialect, string>> = {
  libsql: 'key',
  postgres: 'key',
  mysql: '`key`',
}

/** Record a schema version past this build's, as a newer build that migrated leaves it. */
async function recordNewer(dialect: EnrolledDialect, raw: SqlExecutor): Promise<void> {
  await raw.batch('fixture:record-newer', [
    {
      sql: `UPDATE meta SET value = ? WHERE ${META_KEY[dialect]} = 'schema_version'`,
      args: [String(CURRENT_SCHEMA_VERSION + 1)],
    },
  ])
}

export async function openCliDb(
  dialect: EnrolledDialect,
  name: string,
  schema: StartingSchema = 'current',
): Promise<CliDb> {
  const ids = testIdSource(name.replace(/[^a-zA-Z0-9_-]/g, '-'))
  if (dialect === 'libsql') {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-'))
    const target = join(dir, 'db.sqlite')
    const url = `file:${target}`
    const raw = LibsqlExecutor.open(url)
    const make = (db: SqlExecutor) => new LibsqlStoreAdmin(db)
    await prepare(dialect, raw, make, schema)
    return {
      dialect,
      url,
      target,
      env: { DURABLERUN_STORE_URL: url },
      raw,
      admin: make(raw),
      store: new LibsqlSchedulerStore(raw, ids),
      dump: () => dumpOf(dialect, raw),
      recordNewer: () => recordNewer(dialect, raw),
      close: async () => {
        raw.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }
  if (dialect === 'postgres') {
    const db = await openPostgresTestDb({ idNamespace: 'cli', migrate: false })
    try {
      const base = new URL(requireEnv('DURABLERUN_POSTGRES_URL'))
      base.searchParams.set('options', `-c search_path=${db.schemaName}`)
      const make = (inner: SqlExecutor) => new PostgresStoreAdmin(inner)
      await prepare(dialect, db.raw, make, schema)
      return {
        dialect,
        url: base.href,
        target: base.host,
        env: { DURABLERUN_STORE_URL: base.href },
        raw: db.raw,
        admin: db.admin,
        store: new PostgresSchedulerStore(db.raw, ids),
        dump: () => dumpOf(dialect, db.raw),
        recordNewer: () => recordNewer(dialect, db.raw),
        close: db.close,
      }
    } catch (error) {
      await db.close()
      throw error
    }
  }
  const db = await openMysqlTestDb({ idNamespace: 'cli', migrate: false })
  try {
    const base = new URL(requireEnv('DURABLERUN_MYSQL_URL'))
    base.pathname = `/${db.databaseName}`
    await prepareMysql(db.raw, db.admin, schema)
    return {
      dialect,
      url: base.href,
      target: base.host,
      env: { DURABLERUN_STORE_URL: base.href },
      raw: db.raw,
      admin: db.admin,
      store: new MysqlSchedulerStore(db.raw, ids),
      dump: () => dumpOf(dialect, db.raw),
      recordNewer: () => recordNewer('mysql', db.raw),
      close: db.close,
    }
  } catch (error) {
    await db.close()
    throw error
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`these tests need ${name}`)
  return value
}

async function prepare(
  dialect: EnrolledDialect,
  raw: SqlExecutor,
  make: (db: SqlExecutor) => StoreAdmin,
  schema: StartingSchema,
): Promise<void> {
  if (schema === 'empty') return
  await migrateThrough(raw, make, typeof schema === 'number' ? schema : CURRENT_SCHEMA_VERSION)
  await make(raw).setFakeNowEpochMs(NOW_MS)
  if (schema === 'newer') await recordNewer(dialect, raw)
}

/** MySQL sends every pending version as one batch, so an earlier version is built by hand. */
async function prepareMysql(raw: SqlExecutor, admin: StoreAdmin, schema: StartingSchema) {
  if (schema === 'empty') return
  if (typeof schema === 'number' && schema < CURRENT_SCHEMA_VERSION) {
    await raw.batch('fixture:database-at-a-version', [
      { sql: META_BOOTSTRAP_SQL, args: [] },
      ...MYSQL_MIGRATIONS.filter((migration) => migration.version <= schema)
        .flatMap(({ statements }) => statements)
        .map((sql) => ({ sql, args: [] })),
      { sql: "UPDATE meta SET value = ? WHERE `key` = 'schema_version'", args: [String(schema)] },
    ])
  } else {
    await admin.migrate()
  }
  await admin.setFakeNowEpochMs(NOW_MS)
  if (schema === 'newer') await recordNewer('mysql', raw)
}

const TABLE_LIST: Readonly<Record<EnrolledDialect, string>> = {
  libsql: `SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  postgres: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`,
  mysql: `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`,
}

const SCHEMA_OBJECTS: Readonly<Record<EnrolledDialect, string>> = {
  libsql: `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
  postgres: `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`,
  mysql: `SELECT table_name, index_name, column_name, seq_in_index FROM information_schema.statistics WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index`,
}

function comparable(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`
  if (value instanceof Date) return `date:${value.toISOString()}`
  return value
}

function rowText(row: SqlRow): string {
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((column) => [column, comparable(row[column])]),
  )
}

/** Every table's rows, sorted, and the schema's objects, as one text. */
async function dumpOf(dialect: EnrolledDialect, raw: SqlExecutor): Promise<string> {
  const [tables, objects] = await raw.batch(
    'fixture:dump-catalog',
    [
      { sql: TABLE_LIST[dialect], args: [] },
      { sql: SCHEMA_OBJECTS[dialect], args: [] },
    ],
    'read',
  )
  const names = (tables?.rows ?? []).map((row) => String(row.name))
  const results =
    names.length === 0
      ? []
      : await raw.batch(
          'fixture:dump-rows',
          names.map((table) => ({ sql: `SELECT * FROM ${table}`, args: [] })),
          'read',
        )
  const lines = [`objects ${JSON.stringify((objects?.rows ?? []).map(rowText))}`]
  names.forEach((table, index) => {
    const rows = (results[index]?.rows ?? []).map(rowText).sort()
    lines.push(`${table} ${JSON.stringify(rows)}`)
  })
  return lines.join('\n')
}

/** A store opener over the real one, with every executor it makes wrapped. */
export function openerWrapping(wrap: (executor: SqlExecutor) => SqlExecutor): StoreOpener {
  return (url, token, ids, options = {}) =>
    openStore(url, token, ids, { ...options, wrapExecutor: wrap })
}

/** Where a fault meets a batch: the label, and which of its sendings, counted from one. */
export interface FaultSite {
  readonly label: string
  readonly occurrence: number
}

/**
 * An executor that meets one sending of one label with a fault: the store unavailable
 * before it, the batch committed and its answer lost, or the batch applied twice.
 */
export function faulting(
  real: SqlExecutor,
  site: FaultSite,
  fault: 'unavailable-before' | 'crash-after' | 'duplicate',
): SqlExecutor {
  let seen = 0
  return {
    batch: async (label, statements, control) => {
      if (label !== site.label || ++seen !== site.occurrence) {
        return real.batch(label, statements, control)
      }
      if (fault === 'unavailable-before') {
        throw new StoreUnavailableError(`fault: the store is unavailable before '${label}'`)
      }
      if (fault === 'duplicate') await real.batch(label, statements, control)
      const results = await real.batch(label, statements, control)
      if (fault === 'crash-after') {
        throw new StoreUnavailableError(`fault: the answer to '${label}' was lost`)
      }
      return results
    },
  }
}

/** A text planted in every value a user writes. No command may print it without --reveal. */
export const SENTINEL = 'sentinel-6d1c9e0a'

export const QUEUE = 'q'

export interface SeededTasks {
  /** Completed, with a checkpoint, params, headers and an idempotency key that hold the sentinel. */
  readonly completed: string
  /** Failed by a reason its code wrote, which holds the sentinel. */
  readonly failed: string
  /** Cancelled, so its reason is the engine's own. */
  readonly cancelled: string
  /** Pending, with a start an hour off, so it has no outcome. */
  readonly pending: string
}

/** Tasks in each outcome, written through the current store, and an event with the sentinel. */
export async function seedTasks(db: CliDb, queue = QUEUE): Promise<SeededTasks> {
  const store = db.store
  const params = JSON.stringify({ secret: SENTINEL })
  const completed = await store.spawn(queue, 'report', params, {
    idempotencyKey: `key-${SENTINEL}`,
    headers: { trace: SENTINEL },
  })
  const failed = await store.spawn(queue, 'report', params, { maxAttempts: 1 })
  const cancelled = await store.spawn(queue, 'report', '{}')
  const pending = await store.spawn(queue, 'report', '{}', { startDelaySeconds: 3600 })
  const claimed = await store.claim(queue, 'seed-worker', { leaseSeconds: 60, limit: 10 })
  for (const run of claimed) {
    const live = await store.activate(queue, run.runId, run.claimToken, run.claimGen)
    if (live === null) throw new Error(`seed could not activate ${run.runId}`)
    if (run.taskId === completed.taskId) {
      await store.setCheckpoint(
        queue,
        run.taskId,
        run.runId,
        run.claimToken,
        'fetch-page',
        JSON.stringify({ state: SENTINEL }),
        60,
      )
      await store.complete(queue, run.runId, run.claimToken, JSON.stringify({ result: SENTINEL }))
    } else if (run.taskId === failed.taskId) {
      await store.fail(
        queue,
        run.runId,
        run.claimToken,
        JSON.stringify({ name: 'Error', message: SENTINEL }),
        null,
      )
    }
  }
  if (!(await store.cancelTask(queue, cancelled.taskId))) throw new Error('seed could not cancel')
  await store.emitEvent(queue, 'page-ready', JSON.stringify({ payload: SENTINEL }))
  return {
    completed: completed.taskId,
    failed: failed.taskId,
    cancelled: cancelled.taskId,
    pending: pending.taskId,
  }
}

/**
 * The command line a command runs with against a test database: every argument and every
 * required flag filled in, `--yes` for a command that writes, and `--json`. A command that
 * takes an argument or a required flag this does not know fails here, so a new command gets
 * a line of its own.
 */
export function commandLine(
  spec: CommandSpec,
  db: Pick<CliDb, 'target'>,
  taskId: string,
  extra: readonly string[] = [],
): string[] {
  const line: string[] = [spec.verb]
  for (const name of spec.positionals) {
    if (name !== 'taskId') throw new Error(`no test value for the argument ${name} of ${spec.verb}`)
    line.push(taskId)
  }
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.required !== true) continue
    if (name === 'queue') line.push('--queue', QUEUE)
    else if (name === 'target') line.push('--target', db.target)
    else throw new Error(`no test value for the flag --${name} of ${spec.verb}`)
  }
  if (spec.writes) line.push('--yes')
  return [...line, '--json', ...extra]
}

/** Every command the table says opens a store. */
export const STORE_COMMANDS: readonly CommandSpec[] = VERBS.map((verb) => COMMANDS[verb]).filter(
  (spec) => spec.opensStore,
)
