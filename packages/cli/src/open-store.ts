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

/** What an operator should know before a migration crosses a version, as a store says it. */
export type SchemaVersionNotes = Readonly<Record<number, string>>

export interface OpenedStore {
  /** The URL scheme the store was picked by, `file:` or `:memory:` for a local libSQL file. */
  readonly scheme: string
  readonly window: SchemaWindow
  readonly notes: SchemaVersionNotes
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

/**
 * A command that may not create a database named a file that does not exist. Nothing was
 * opened or created. It carries the store's window, so migrate can say what it would apply.
 */
export class MissingDatabaseError extends Error {
  override readonly name = 'MissingDatabaseError'
  constructor(
    message: string,
    readonly window: SchemaWindow,
  ) {
    super(message)
  }
}

interface Opened {
  readonly executor: SqlExecutor
  readonly window: SchemaWindow
  readonly notes: SchemaVersionNotes
  admin(db: SqlExecutor): StoreAdmin
  scheduler(db: SqlExecutor, ids: IdSource): SchedulerStore
  close(): Promise<void>
}

type Loader = (url: string, token: string | undefined, mayCreate: boolean) => Promise<Opened>

const libsql: Loader = async (url, token, mayCreate) => {
  const store = await import('@durablerun/store-libsql')
  const file = storeScheme(url) === 'file:' ? await storeTarget(url) : undefined
  if (!mayCreate && file !== undefined && !existsSync(file)) {
    throw new MissingDatabaseError(
      `no database file is at ${file}; migrate --yes creates and initializes one`,
      store.READABLE_SCHEMA_WINDOW,
    )
  }
  const executor = openedBy(() => store.LibsqlExecutor.open(url, token))
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    notes: store.SCHEMA_VERSION_NOTES,
    admin: (db) => new store.LibsqlStoreAdmin(db),
    scheduler: (db, ids) => new store.LibsqlSchedulerStore(db, ids),
    close: async () => executor.close(),
  }
}

const postgres: Loader = async (url, token) => {
  refuseToken('PostgreSQL', token)
  const store = await import('@durablerun/store-postgres')
  const executor = openedBy(() => store.PgExecutor.open(url))
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    notes: store.SCHEMA_VERSION_NOTES,
    admin: (db) => new store.PostgresStoreAdmin(db),
    scheduler: (db, ids) => new store.PostgresSchedulerStore(db, ids),
    close: () => executor.close(),
  }
}

const mysql: Loader = async (url, token) => {
  refuseToken('MySQL', token)
  const store = await import('@durablerun/store-mysql')
  const executor = openedBy(() => store.MysqlExecutor.open(url))
  return {
    executor,
    window: store.READABLE_SCHEMA_WINDOW,
    notes: store.SCHEMA_VERSION_NOTES,
    admin: (db) => new store.MysqlStoreAdmin(db),
    scheduler: (db, ids) => new store.MysqlSchedulerStore(db, ids),
    close: () => executor.close(),
  }
}

/**
 * A store's client, made from the URL. A client that refuses the URL as it is made says so
 * in a message that can quote the URL, so its error is replaced by one that does not.
 */
function openedBy<T>(open: () => T): T {
  try {
    return open()
  } catch {
    throw new StoreUrlError(
      "the store's client refused DURABLERUN_STORE_URL as it opened; the URL is not printed, because it can hold a password",
    )
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
 * What a write names with `--target`: the whole of `:memory:`, the path of a `file:` URL as
 * the libSQL client decodes it (store-libsql's own fileUrlPath, so the check that a read
 * creates no file looks at the file the client opens), and the host of every other URL, its
 * port included when it names one. A URL that does not parse is refused, and so is one with
 * an @ outside its user name and password, and a libSQL server's URL that carries a user
 * name or a password, which the client would quote in its errors. No refusal quotes the URL,
 * because a store URL can hold a password, and a database credential is full admin.
 */
export async function storeTarget(url: string): Promise<string> {
  const scheme = storeScheme(url)
  if (scheme === undefined) throw new StoreUrlError(unknownScheme())
  if (scheme === ':memory:') return url
  if (scheme === 'file:') {
    const { fileUrlPath } = await import('@durablerun/store-libsql')
    const file = fileUrlPath(url)
    if (file === undefined || file.rest.startsWith('#')) {
      throw new StoreUrlError(
        'a file: URL must name a database file by a path that percent-decodes, holds no :memory:, and has no fragment: encode a # in a file name as %23, a ? as %3F and a % as %25. The whole URL :memory: names a database held in memory',
      )
    }
    return file.path
  }
  const parsed = serverUrl(url, scheme)
  if (LOADERS[scheme] === libsql && (parsed.username !== '' || parsed.password !== '')) {
    throw new StoreUrlError(
      'a libSQL URL carries no user name or password, and its client would quote one in its errors; the URL is not printed. Put the token in DURABLERUN_STORE_TOKEN',
    )
  }
  return parsed.host
}

const UNPARSED_URL =
  'DURABLERUN_STORE_URL does not parse as a URL. It is not printed, because it can hold a password; a password must percent-encode every character a URL reserves, such as # / ? @ % and a space'

const AT_OUTSIDE_THE_AUTHORITY =
  'DURABLERUN_STORE_URL has an @ outside its user name and password, and an @ there must be written %40. The URL is not printed, because an unencoded # / or ? in a password ends the host early, so what parses as the host or the query can hold the rest of the password; percent-encode every # / ? @ % and space in a password'

/** The schemes a store takes that the URL parser treats as special, where a backslash ends a host too. */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:'])

/**
 * Where a URL's authority ends, as the WHATWG parser that every store's client reads it with
 * finds it: after the `//` that starts it, at the first / ? or #, and at a backslash too in a
 * special scheme. A URL with no `//` straight after its scheme is taken to have none, so any
 * @ in it is outside, which refuses more than the parser would and never less.
 */
function authorityEnd(url: string, scheme: string): number {
  const start = scheme.length
  if (!url.startsWith('//', start)) return start
  const end = SPECIAL_SCHEMES.has(scheme) ? /[/?#\\]/g : /[/?#]/g
  end.lastIndex = start + 2
  return end.exec(url)?.index ?? url.length
}

/** A server's URL as it parses, or a refusal that does not quote it. */
function serverUrl(url: string, scheme: string): URL {
  // Every @ of a user name and password is inside the authority, whose last @ ends them. An @
  // after the authority is one that an unencoded # / or ? in a password cut off from it, and
  // then the host, the port and the query parsed before it hold the rest of the password.
  if (url.includes('@', authorityEnd(url, scheme))) {
    throw new StoreUrlError(AT_OUTSIDE_THE_AUTHORITY)
  }
  try {
    const parsed = new URL(url)
    // A driver percent-decodes the user name and the password, so one that does not decode
    // fails there, with no message this CLI chose.
    decodeURIComponent(parsed.username)
    decodeURIComponent(parsed.password)
    return parsed
  } catch {
    throw new StoreUrlError(UNPARSED_URL)
  }
}

function unknownScheme(): string {
  return `DURABLERUN_STORE_URL names no store; it must start with one of ${STORE_SCHEMES.join(', ')}`
}

export const openStore: StoreOpener = async (url, token, ids, options = {}) => {
  await storeTarget(url)
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
    notes: opened.notes,
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
