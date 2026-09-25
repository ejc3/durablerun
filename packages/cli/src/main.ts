import {
  type Clock,
  type IdSource,
  MAX_RUN_ORDINAL,
  PermanentStoreError,
  SchemaMismatchError,
  SchemaNotInitializedError,
  StoreUnavailableError,
  isPortRefusal,
} from '@durablerun/core'
import {
  COMMANDS,
  type CommandSpec,
  type Invocation,
  UsageError,
  VERBS,
  type Verb,
  parseInvocation,
  usage,
} from './commands.js'
import { EXITS, type ExitName, exitCode } from './exit.js'
import {
  MissingDatabaseError,
  type OpenedStore,
  type SchemaWindow,
  type StoreOpener,
  StoreUrlError,
  openStore,
  storeTarget,
} from './open-store.js'
import { canonicalJson, checkpointView, humanText, resultView } from './render.js'

/** Where the CLI writes. The bin hands it the process's streams, and a test its own. */
export interface Io {
  out(text: string): void
  err(text: string): void
}

interface Answer {
  readonly exit: ExitName
  readonly view: Record<string, unknown>
  /** Human lines that replace the generic rendering of the view. */
  readonly text?: readonly string[]
  /** Printed to stderr before the answer, in both output modes. */
  readonly notes?: readonly string[]
}

interface Context {
  readonly invocation: Invocation
  readonly store: OpenedStore
  readonly reveal: boolean
  /** Writes one line to stderr now, ahead of the answer. */
  readonly note: (line: string) => void
}

type Handler = (context: Context) => Promise<Answer>

/**
 * The CLI, with everything it touches handed in: the arguments, the environment it reads
 * DURABLERUN_STORE_URL and DURABLERUN_STORE_TOKEN from, the streams it writes, the ids a
 * store takes, and the clock, which no command reads today. It answers with the exit code.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
  ids: IdSource,
  _clock: Clock,
  opener: StoreOpener = openStore,
): Promise<number> {
  let invocation: Invocation
  try {
    invocation = parseInvocation(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    const verb = argv[0]
    return emit(io, argv.includes('--json'), verb ?? null, undefined, {
      exit: 'usage',
      view: { error: { kind: 'usage', message: error.message } },
    })
  }
  const { spec } = invocation
  const json = invocation.booleans.json === true
  if (spec.verb === 'help') return emit(io, json, spec.verb, undefined, help(json))
  const usageAnswer = (kind: string, message: string): number =>
    emit(io, json, spec.verb, undefined, { exit: 'usage', view: { error: { kind, message } } })
  const url = env.DURABLERUN_STORE_URL
  if (url === undefined || url === '') {
    return usageAnswer('usage', 'set DURABLERUN_STORE_URL to the store to open')
  }
  let target: string
  try {
    target = storeTarget(url)
  } catch (error) {
    if (error instanceof StoreUrlError) return usageAnswer('usage', error.message)
    throw error
  }
  if (spec.writes && invocation.strings.target !== target) {
    return usageAnswer(
      'target-mismatch',
      `--target must name the store DURABLERUN_STORE_URL opens, ${target}; nothing was changed`,
    )
  }
  const token = env.DURABLERUN_STORE_TOKEN === '' ? undefined : env.DURABLERUN_STORE_TOKEN
  const reveal = invocation.booleans.reveal === true
  let store: OpenedStore
  try {
    store = await opener(url, token, ids, {
      mayCreate: spec.writes && invocation.booleans.yes === true,
    })
  } catch (error) {
    if (error instanceof StoreUrlError) return usageAnswer('usage', error.message)
    return emit(io, json, spec.verb, undefined, failure(error, reveal))
  }
  let answer: Answer
  try {
    const note = (line: string): void => io.err(`${line}\n`)
    answer = await HANDLERS[spec.verb]({ invocation, store, reveal, note })
  } catch (error) {
    answer = failure(error, reveal)
  } finally {
    await store.close().catch(() => undefined)
  }
  return emit(io, json, spec.verb, store, answer)
}

function emit(
  io: Io,
  json: boolean,
  verb: string | null,
  store: OpenedStore | undefined,
  answer: Answer,
): number {
  for (const note of answer.notes ?? []) io.err(`${note}\n`)
  const document: Record<string, unknown> = { command: verb, exit: answer.exit, ...answer.view }
  if (store !== undefined) {
    document.dialect = { scheme: store.scheme, schemaWindow: store.window }
  }
  const failed = answer.exit !== 'done'
  if (json) io.out(canonicalJson(document))
  else if (answer.text !== undefined) io.out(`${answer.text.join('\n')}\n`)
  else (failed ? io.err : io.out)(humanText(document))
  return exitCode(answer.exit)
}

/**
 * What a failure the handler did not answer itself exits with. A store's own message can
 * quote a stored value, so it prints only with `--reveal`, and so does the message of an
 * error the CLI does not expect. A port's refusal names only what the caller passed.
 */
function failure(error: unknown, reveal: boolean): Answer {
  const hidden = (kind: string, exit: ExitName): Answer => ({
    exit,
    view: {
      error:
        reveal && error instanceof Error
          ? { kind, name: error.name, message: error.message }
          : { kind, name: error instanceof Error ? error.name : typeof error },
    },
  })
  if (error instanceof StoreUnavailableError) return hidden('store-unavailable', 'unavailable')
  if (error instanceof PermanentStoreError) return hidden('permanent-store-error', 'permanent')
  if (error instanceof SchemaMismatchError || error instanceof SchemaNotInitializedError) {
    return hidden('schema', 'schema')
  }
  if (isPortRefusal(error)) {
    return { exit: 'refused', view: { error: { kind: 'refused', message: error.message } } }
  }
  if (error instanceof MissingDatabaseError) {
    return { exit: 'schema', view: { error: { kind: 'not-initialized', message: error.message } } }
  }
  return hidden('internal', 'internal')
}

function help(json: boolean): Answer {
  if (json) {
    return {
      exit: 'done',
      view: {
        commands: VERBS.map((verb) => {
          const spec: CommandSpec = COMMANDS[verb]
          return {
            name: verb,
            usage: usage(spec),
            summary: spec.summary,
            positionals: spec.positionals,
            flags: spec.flags,
            opensStore: spec.opensStore,
            writes: spec.writes,
            repeat: spec.repeat,
            ports: spec.ports,
            exits: spec.exits,
            faults: spec.faults,
            faultsAt: spec.faultsAt,
          }
        }),
        exits: EXITS,
        environment: {
          DURABLERUN_STORE_URL: 'the store every command but help opens',
          DURABLERUN_STORE_TOKEN: "a libSQL server's token, when its URL needs one",
        },
      },
    }
  }
  return {
    exit: 'done',
    view: {},
    text: [
      'usage: pnpm cli <command> ...',
      '',
      ...VERBS.map((verb) => `  ${usage(COMMANDS[verb])}\n      ${COMMANDS[verb].summary}`),
      '',
      'The store is DURABLERUN_STORE_URL, with DURABLERUN_STORE_TOKEN for a libSQL server.',
      'Values users wrote print as their length and sha256 unless --reveal.',
      '',
      'exit codes:',
      ...EXITS.map((exit) => `  ${exit.code} ${exit.name}: ${exit.meaning}`),
    ],
  }
}

/** Why a database's recorded schema version is one the store's reads do not accept, or null. */
function windowProblem(version: number, window: SchemaWindow): string | null {
  if (version === 0) return 'the database is not initialized; migrate initializes it'
  if (version > window.newest) {
    return `the schema is recorded at version ${version}, and this build reads versions ${window.oldest} to ${window.newest}: a newer build migrated this database, so use that build or a later one`
  }
  if (version < window.oldest) {
    return `the schema is recorded at version ${version}, and this build reads versions ${window.oldest} to ${window.newest}: migrate it first`
  }
  return null
}

/** The recorded schema version when the store's reads accept it, or the answer that refuses. */
async function readableVersion(store: OpenedStore): Promise<number | Answer> {
  const version = await store.admin.schemaVersion()
  const problem = windowProblem(version, store.window)
  if (problem === null) return version
  return {
    exit: 'schema',
    view: { recordedSchemaVersion: version, error: { kind: 'schema', message: problem } },
  }
}

const doctor: Handler = async ({ invocation, store }) => {
  const queue = invocation.strings.queue
  const version = await readableVersion(store)
  if (typeof version !== 'number') return { ...version, view: { queue, ...version.view } }
  return {
    exit: 'done',
    view: {
      queue,
      buildSchemaVersion: store.window.newest,
      recordedSchemaVersion: version,
      databaseNowEpochMs: await store.admin.nowEpochMs(),
    },
  }
}

/**
 * Before crossing a version that holds a store's writer for a long time on a large table,
 * what the operator should know. Keyed by the version it is printed before.
 */
const SLOW_VERSIONS: Readonly<Record<number, string>> = Object.freeze({
  10: 'warning: version 10 reads every stored event inside its write transaction. On a cold 4.5 GB libSQL file it held the writer for 14.9 seconds, and other connections failed calls meanwhile. Run the finding query of DESIGN.md section 3.4 (schema version 10) first, in a quiet window: it reads the same pages under no write lock.',
})

const migrate: Handler = async ({ invocation, store, note }) => {
  const from = await store.admin.schemaVersion()
  if (from > store.window.newest) {
    const problem = windowProblem(from, store.window)
    return {
      exit: 'schema',
      view: { recordedSchemaVersion: from, error: { kind: 'schema', message: problem } },
    }
  }
  const plan: number[] = []
  for (let version = from + 1; version <= store.window.newest; version++) plan.push(version)
  if (plan.length === 0) {
    return {
      exit: 'done',
      view: { from, to: from, applied: [] },
      text: [`the schema is at version ${from}, the newest this build has; nothing to apply`],
    }
  }
  const warnings = plan.flatMap((version) => SLOW_VERSIONS[version] ?? [])
  if (invocation.booleans.yes !== true) {
    return {
      exit: 'usage',
      notes: warnings,
      view: {
        from,
        wouldApply: plan,
        error: {
          kind: 'confirmation-required',
          message: `migrate would apply versions ${plan.join(', ')}; run it again with --yes. Nothing was changed`,
        },
      },
    }
  }
  for (const warning of warnings) note(warning)
  await store.admin.migrate()
  const to = await store.admin.schemaVersion()
  const applied = plan.filter((version) => version <= to)
  return {
    exit: 'done',
    view: { from, to, applied },
    text: applied.map((version) => `applied version ${version}`),
  }
}

const result: Handler = async ({ invocation, store, reveal }) => {
  const queue = invocation.strings.queue ?? ''
  const taskId = invocation.args.taskId ?? ''
  const version = await readableVersion(store)
  if (typeof version !== 'number') return { ...version, view: { queue, taskId, ...version.view } }
  const found = await readTask(store, queue, taskId)
  if (found === null) return notFound(queue, taskId)
  if ('unreadable' in found) return { exit: 'done', view: { queue, taskId, ...found.unreadable } }
  return { exit: 'done', view: { queue, taskId, ...resultView(found.result, reveal) } }
}

const checkpoints: Handler = async ({ invocation, store, reveal }) => {
  const queue = invocation.strings.queue ?? ''
  const taskId = invocation.args.taskId ?? ''
  const shown = invocation.strings.attempt
  if (shown !== undefined && !/^[1-9][0-9]*$/.test(shown)) {
    return {
      exit: 'usage',
      view: { error: { kind: 'usage', message: '--attempt takes a whole number from 1' } },
    }
  }
  const version = await readableVersion(store)
  if (typeof version !== 'number') return { ...version, view: { queue, taskId, ...version.view } }
  if ((await readTask(store, queue, taskId)) === null) return notFound(queue, taskId)
  const attempt = shown === undefined ? MAX_RUN_ORDINAL : Number(shown)
  const view: Record<string, unknown> = {
    queue,
    taskId,
    attempt: shown === undefined ? null : attempt,
  }
  try {
    const rows = await store.scheduler.getCheckpoints(queue, taskId, attempt)
    view.checkpoints = rows.map((row) => checkpointView(row, reveal))
  } catch (error) {
    if (isPortRefusal(error) || !(error instanceof RangeError)) throw error
    view.checkpoints = 'unreadable'
    view.reason = error.message
  }
  return { exit: 'done', view }
}

type ReadTask =
  | { readonly result: NonNullable<Awaited<ReturnType<OpenedStore['scheduler']['getTaskResult']>>> }
  | { readonly unreadable: { readonly state: 'unreadable'; readonly reason: string } }

/**
 * The task's outcome through the store's own decoders, null when no such task exists, and
 * `unreadable` when the row contradicts itself: the decoders refuse it with RangeError, and
 * the row is shown as what it is.
 */
async function readTask(
  store: OpenedStore,
  queue: string,
  taskId: string,
): Promise<ReadTask | null> {
  try {
    const found = await store.scheduler.getTaskResult(queue, taskId)
    return found === null ? null : { result: found }
  } catch (error) {
    if (isPortRefusal(error) || !(error instanceof RangeError)) throw error
    return { unreadable: { state: 'unreadable', reason: error.message } }
  }
}

function notFound(queue: string, taskId: string): Answer {
  return {
    exit: 'not-found',
    view: {
      queue,
      taskId,
      error: { kind: 'not-found', message: `no task ${taskId} in queue ${queue}` },
    },
  }
}

const HANDLERS: Readonly<Record<Exclude<Verb, 'help'>, Handler>> = Object.freeze({
  doctor,
  migrate,
  result,
  checkpoints,
})
