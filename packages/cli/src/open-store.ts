import { existsSync } from 'node:fs'
import type { IdSource, SchedulerStore, SqlExecutor, StoreAdmin } from '@durablerun/core'

/**
 * The one file of the CLI that imports a store package (biome's noRestrictedImports holds
 * every other file to that). It picks a store by the URL's scheme, imports it lazily, and
 * hands back typed ports narrowed to the calls a command may make, never an executor.
 */

/** The schema versions a store's reads accept, as the store package exports them. */
export interface SchemaWindow {
  readonly oldest: number
  readonly newest: number
}

/** The admin calls a command may make. The fake clock's setter cannot be written. */
export type CliAdmin = Pick<StoreAdmin, 'schemaVersion' | 'nowEpochMs' | 'migrate'>

/** The scheduler calls a command may make. A claim cannot be written. */
export type CliScheduler = Pick<SchedulerStore, 'getTaskResult' | 'getCheckpoints'>

export interface OpenedStore {
  /** The URL scheme the store was picked by, `file:` or `:memory:` for a local libSQL file. */
  readonly scheme: string
  readonly window: SchemaWindow
  readonly admin: CliAdmin
  readonly scheduler: CliScheduler
  close(): Promise<void>
}

export interface OpenOptions {
  /**
   * Whether opening may create the database. Only a command that writes may: a read of a
   * `file:` URL that names no file is refused before a client opens, because a libSQL
   * client creates the file it is pointed at.
   */
  readonly mayCreate?: boolean
  /** For tests: wraps the executor every port sends through, to watch it or to fail it. */
  readonly wrapExecutor?: (executor: SqlExecutor) => SqlExecutor
}

export type StoreOpener = (
  url: string,
  token: string | undefined,
  ids: IdSource,
  options?: OpenOptions,
) => Promise<OpenedStore>

/** A URL or a token no store takes. Nothing was opened. */
export class StoreUrlError extends Error {
  override readonly name = 'StoreUrlError'
}

/** A read named a database file that does not exist. Nothing was opened or created. */
export class MissingDatabaseError extends Error {
  override readonly name = 'MissingDatabaseError'
}

interface Opened {
  readonly executor: SqlExecutor
  readonly window: SchemaWindow
  admin(db: SqlExecutor): StoreAdmin
  scheduler(db: SqlExecutor, ids: IdSource): SchedulerStore
  close(): Promise<void>
}

type Loader = (url: string, token: string | undefined, mayCreate: boolean) => Promise<Opened>

const libsql: Loader = async (url, token, mayCreate) => {
  if (!mayCreate && storeScheme(url) === 'file:' && !existsSync(storeTarget(url))) {
    throw new MissingDatabaseError(
      `no database file is at ${storeTarget(url)}; migrate --yes creates and initializes one`,
    )
  }
  const store = await import('@durablerun/store-libsql')
  const executor = store.LibsqlExecutor.open(url, token)
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    admin: (db) => new store.LibsqlStoreAdmin(db),
    scheduler: (db, ids) => new store.LibsqlSchedulerStore(db, ids),
    close: async () => executor.close(),
  }
}

const postgres: Loader = async (url, token) => {
  refuseToken('PostgreSQL', token)
  const store = await import('@durablerun/store-postgres')
  const executor = store.PgExecutor.open(url)
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    admin: (db) => new store.PostgresStoreAdmin(db),
    scheduler: (db, ids) => new store.PostgresSchedulerStore(db, ids),
    close: () => executor.close(),
  }
}

const mysql: Loader = async (url, token) => {
  refuseToken('MySQL', token)
  const store = await import('@durablerun/store-mysql')
  const executor = store.MysqlExecutor.open(url)
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    admin: (db) => new store.MysqlStoreAdmin(db),
    scheduler: (db, ids) => new store.MysqlSchedulerStore(db, ids),
    close: () => executor.close(),
  }
}

function refuseToken(store: string, token: string | undefined): void {
  if (token !== undefined) {
    throw new StoreUrlError(
      `DURABLERUN_STORE_TOKEN is set, and a ${store} URL carries its credentials itself; only a libSQL URL takes a token`,
    )
  }
}

/** The stores by URL scheme. `:memory:` is a whole URL, and the rest are schemes. */
const LOADERS: Readonly<Record<string, Loader>> = Object.freeze({
  ':memory:': libsql,
  'file:': libsql,
  'libsql:': libsql,
  'https:': libsql,
  'wss:': libsql,
  'postgres:': postgres,
  'postgresql:': postgres,
  'mysql:': mysql,
})

export const STORE_SCHEMES: readonly string[] = Object.freeze(Object.keys(LOADERS))

/** The scheme a URL picks its store by, or undefined when no store takes it. */
export function storeScheme(url: string): string | undefined {
  if (url === ':memory:') return url
  const colon = url.indexOf(':')
  const scheme = colon < 0 ? undefined : url.slice(0, colon + 1).toLowerCase()
  return scheme !== undefined && Object.hasOwn(LOADERS, scheme) ? scheme : undefined
}

/**
 * What a write names with `--target`: the path of a `file:` URL, the whole of `:memory:`,
 * and the host of every other URL, its port included when it names one.
 */
export function storeTarget(url: string): string {
  const scheme = storeScheme(url)
  if (scheme === undefined) throw new StoreUrlError(unknownScheme())
  if (scheme === ':memory:') return url
  if (scheme === 'file:') {
    const rest = url.slice('file:'.length).split('?')[0] ?? ''
    if (!rest.startsWith('//')) return rest
    const path = rest.indexOf('/', 2)
    return path < 0 ? '' : rest.slice(path)
  }
  return new URL(url).host
}

function unknownScheme(): string {
  return `DURABLERUN_STORE_URL names no store; it must start with one of ${STORE_SCHEMES.join(', ')}`
}

export const openStore: StoreOpener = async (url, token, ids, options = {}) => {
  const scheme = storeScheme(url)
  const loader = scheme === undefined ? undefined : LOADERS[scheme]
  if (scheme === undefined || loader === undefined) throw new StoreUrlError(unknownScheme())
  const opened = await loader(url, token, options.mayCreate === true)
  const db = options.wrapExecutor?.(opened.executor) ?? opened.executor
  const admin = opened.admin(db)
  const scheduler = opened.scheduler(db, ids)
  return {
    scheme,
    window: opened.window,
    admin: Object.freeze({
      schemaVersion: () => admin.schemaVersion(),
      nowEpochMs: () => admin.nowEpochMs(),
      migrate: () => admin.migrate(),
    }),
    scheduler: Object.freeze({
      getTaskResult: (queue: string, taskId: string) => scheduler.getTaskResult(queue, taskId),
      getCheckpoints: (queue: string, taskId: string, attempt: number) =>
        scheduler.getCheckpoints(queue, taskId, attempt),
    }),
    close: () => opened.close(),
  }
}
