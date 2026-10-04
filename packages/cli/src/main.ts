import {
  type Clock,
  type IdSource,
  MAX_DURATION_MS,
  MAX_RUN_ORDINAL,
  OPERATOR_LIST_CAP,
  PermanentStoreError,
  SchemaMismatchError,
  SchemaNotInitializedError,
  StoreUnavailableError,
  type TaskFacts,
  isPortRefusal,
  isTerminalState,
} from '@durablerun/core'
import {
  COMMANDS,
  type CommandSpec,
  type Invocation,
  STUCK_DEFAULT_LIMIT,
  UsageError,
  VERBS,
  type Verb,
  durationSeconds,
  parseInvocation,
  usage,
} from './commands.js'
import { EXITS, type ExitName, exitCode } from './exit.js'
import {
  CHILD_HOPS,
  DUE_GRACE_MS,
  type Diagnosis,
  type Evidence,
  type TaskOnTheWay,
  answerView,
  diagnose,
  endsByAClock,
  readUnreadableRow,
  ringClosedBy,
} from './explain.js'
import { factsView, whatIsNotReadable } from './inspect.js'
import {
  MissingDatabaseError,
  type OpenedStore,
  type SchemaWindow,
  type StoreOpener,
  StoreUrlError,
  openStore,
  storeTarget,
} from './open-store.js'
import { agedLiveView, rowsListed, sizesView, statsView, stuckView } from './queue.js'
import { canonicalJson, checkpointView, humanText, resultView } from './render.js'

/** Where the CLI writes. The bin hands it the process's streams, and a test its own. */
export interface Io {
  out(text: string): void
  err(text: string): void
}

/**
 * What the bin prints for an error nothing answered, and the exit it ends in. A foreign
 * error's message and fields can quote the store URL, its password included, so only the
 * error's name prints, beside a fixed sentence.
 */
export function reportCrash(io: Io, error: unknown): number {
  const name = error instanceof Error ? error.name : typeof error
  const shown = /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : 'error'
  io.err(
    `durablerun: an unexpected ${shown} ended the command. Its message is not printed, because it can quote the store URL and its password. This is a defect of the CLI.\n`,
  )
  return exitCode('internal')
}

/** The bin's last catch: the exit of `body`, or of the error it threw, as reportCrash prints it. */
export async function lastCatch(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body()
  } catch (error) {
    return reportCrash(io, error)
  }
}

interface Answer {
  readonly exit: ExitName
  readonly view: Record<string, unknown>
  /** Human lines that replace the generic rendering of the view. */
  readonly text?: readonly string[]
  /**
   * The view is the snapshot this command exists to print. A handler sets it by hand, and
   * such an answer prints on stdout whatever the command exits with, so the exit code alone
   * tells a script how it ended. Every other answer that did not exit `done` is a refusal
   * and prints on stderr, one that names a fact about the store among them: the recorded
   * schema version of a database outside the window, or the versions `migrate` would apply.
   */
  readonly holdsFacts?: true
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
    target = await storeTarget(url)
  } catch (error) {
    if (error instanceof StoreUrlError) return usageAnswer('usage', error.message)
    throw error
  }
  if (spec.writes && target === '') {
    return usageAnswer(
      'target-mismatch',
      'DURABLERUN_STORE_URL names no host or file, so --target cannot name the store it opens; nothing was changed',
    )
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
    // migrate without --yes, of a file that is not there yet: every version is planned, and
    // nothing was opened or created.
    if (error instanceof MissingDatabaseError && spec.verb === 'migrate') {
      return emit(io, json, spec.verb, undefined, confirmationRequired(0, pending(0, error.window)))
    }
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
  const document: Record<string, unknown> = { command: verb, exit: answer.exit, ...answer.view }
  if (store !== undefined) {
    document.dialect = { scheme: store.scheme, schemaWindow: store.window }
  }
  const failed = answer.exit !== 'done'
  if (json) io.out(canonicalJson(document))
  else if (answer.text !== undefined) io.out(`${answer.text.join('\n')}\n`)
  else (failed && answer.holdsFacts !== true ? io.err : io.out)(humanText(document))
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
          const { verb: name, ...entry }: CommandSpec = COMMANDS[verb]
          return { name, usage: usage(COMMANDS[verb]), ...entry }
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

/** The versions this build has after `from`, in order. */
function pending(from: number, window: SchemaWindow): number[] {
  const plan: number[] = []
  for (let version = from + 1; version <= window.newest; version++) plan.push(version)
  return plan
}

/** The versions of `plan` a database recorded at version `to` holds. */
function appliedBy(plan: readonly number[], to: number): number[] {
  return plan.filter((version) => version <= to)
}

/** migrate's answer without --yes: the versions it would apply, and nothing changed. */
function confirmationRequired(from: number, plan: readonly number[]): Answer {
  return {
    exit: 'usage',
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

const migrate: Handler = async ({ invocation, store, reveal, note }) => {
  const from = await store.admin.schemaVersion()
  if (from > store.window.newest) {
    const problem = windowProblem(from, store.window)
    return {
      exit: 'schema',
      view: { recordedSchemaVersion: from, error: { kind: 'schema', message: problem } },
    }
  }
  const plan = pending(from, store.window)
  if (plan.length === 0) {
    return {
      exit: 'done',
      view: { from, to: from, applied: [] },
      text: [`the schema is at version ${from}, the newest this build has; nothing to apply`],
    }
  }
  // A database that was never initialized holds no rows for a version to hold up.
  for (const version of from === 0 ? [] : plan) {
    const warning = store.notes[version]
    if (warning !== undefined) note(`warning: ${warning}`)
  }
  if (invocation.booleans.yes !== true) return confirmationRequired(from, plan)
  try {
    await store.admin.migrate()
  } catch (error) {
    // A migration that fails partway on a store that writes one version at a time leaves the
    // versions before it applied, and says which, with the version now recorded.
    const failed = failure(error, reveal)
    const to = await store.admin.schemaVersion().catch(() => null)
    const applied = to === null ? null : appliedBy(plan, to)
    return { exit: failed.exit, view: { from, to, applied, ...failed.view } }
  }
  const to = await store.admin.schemaVersion()
  const applied = appliedBy(plan, to)
  return {
    exit: 'done',
    view: { from, to, applied },
    text: applied.map((version) => `applied version ${version}`),
  }
}

const result: Handler = async (context) => {
  const found = await readTask(context)
  if ('exit' in found) return found
  const { queue, taskId } = found
  if ('unreadable' in found) {
    return unreadable({ queue, taskId, state: 'unreadable' }, found.unreadable, context.reveal)
  }
  return { exit: 'done', view: { queue, taskId, ...resultView(found.result, context.reveal) } }
}

const checkpoints: Handler = async (context) => {
  const { invocation, store, reveal } = context
  const shown = invocation.strings.attempt
  if (shown !== undefined && !(/^[1-9][0-9]*$/.test(shown) && Number(shown) <= MAX_RUN_ORDINAL)) {
    return {
      exit: 'usage',
      view: {
        error: {
          kind: 'usage',
          message: `--attempt takes a whole number from 1 to ${MAX_RUN_ORDINAL}`,
        },
      },
    }
  }
  const found = await readTask(context)
  if ('exit' in found) return found
  const { queue, taskId } = found
  const attempt = shown === undefined ? MAX_RUN_ORDINAL : Number(shown)
  const view = { queue, taskId, attempt: shown === undefined ? null : attempt }
  const rows = await decoded(() => store.scheduler.getCheckpoints(queue, taskId, attempt))
  if ('refused' in rows) {
    return unreadable({ ...view, checkpoints: 'unreadable' }, rows.refused, reveal)
  }
  return {
    exit: 'done',
    view: { ...view, checkpoints: rows.value.map((row) => checkpointView(row, reveal)) },
  }
}

/**
 * A stored row the store's decoders refused, which exits `unreadable`. Its reason names what
 * was refused and can quote a value the row holds, so it prints only with --reveal.
 */
function unreadable(view: Record<string, unknown>, reason: string, reveal: boolean): Answer {
  return { exit: 'unreadable', view: reveal ? { ...view, reason } : view }
}

/**
 * A stored row the store's own decoders refused. They refuse with RangeError, and a port's
 * refusal of what the caller passed is a RangeError too, so that is told apart first.
 */
function isUnreadableRow(error: unknown): error is RangeError {
  return error instanceof RangeError && !isPortRefusal(error)
}

/**
 * What a read through the store's decoders answered, or the words they refused a stored row
 * with. Every other error is thrown.
 */
async function decoded<T>(
  read: () => Promise<T>,
): Promise<{ readonly value: T } | { readonly refused: string }> {
  try {
    return { value: await read() }
  } catch (error) {
    if (!isUnreadableRow(error)) throw error
    return { refused: error.message }
  }
}

type TaskResult = NonNullable<Awaited<ReturnType<OpenedStore['scheduler']['getTaskResult']>>>
type ReadTask = { readonly queue: string; readonly taskId: string } & (
  | { readonly result: TaskResult }
  | { readonly unreadable: string }
)

/**
 * The task a command names, read after the schema window is checked, through the store's
 * own decoders. A task that does not exist, or a schema outside the window, answers with the
 * exit that says so, and a row the decoders refuse is shown as unreadable.
 */
async function readTask({ invocation, store }: Context): Promise<ReadTask | Answer> {
  const queue = invocation.strings.queue ?? ''
  const taskId = invocation.args.taskId ?? ''
  const version = await readableVersion(store)
  if (typeof version !== 'number') return { ...version, view: { queue, taskId, ...version.view } }
  const found = await decoded(() => store.scheduler.getTaskResult(queue, taskId))
  if ('refused' in found) return { queue, taskId, unreadable: found.refused }
  return found.value === null ? noSuchTask(queue, taskId) : { queue, taskId, result: found.value }
}

/** The answer for a task the queue does not hold. `message` quotes no value a user wrote. */
function notFound(view: Record<string, unknown>, message: string): Answer {
  return { exit: 'not-found', view: { ...view, error: { kind: 'not-found', message } } }
}

/** The answer for a task id the queue holds no task under. A task id prints. */
function noSuchTask(queue: string, taskId: string): Answer {
  return notFound({ queue, taskId }, `no task ${taskId} in queue ${queue}`)
}

/**
 * The task a command names by its id or by the idempotency key it was spawned under, read
 * after the schema window is checked, or the answer that refuses.
 */
async function namedTask({
  invocation,
  store,
}: Context): Promise<{ readonly queue: string; readonly taskId: string } | Answer> {
  const queue = invocation.strings.queue ?? ''
  const key = invocation.strings.key
  const version = await readableVersion(store)
  if (typeof version !== 'number') return { ...version, view: { queue, ...version.view } }
  const taskId =
    key === undefined
      ? (invocation.args.taskId ?? '')
      : await store.operator.taskIdByKey(queue, key)
  if (taskId === null) {
    // The key is a value a user wrote, so the answer does not quote it.
    return notFound({ queue }, `no task in queue ${queue} was spawned under that idempotency key`)
  }
  return { queue, taskId }
}

/**
 * One snapshot of a task, named by its id or by the idempotency key it was spawned under.
 * The facts print whole whatever they hold, on stdout. A row the decoders refuse, an
 * integer outside its bounds, or a state or status that is not the engine's own is printed
 * where it stands and the command exits `unreadable`, so a script does not read a corrupt
 * row as a clean answer.
 */
const inspect: Handler = async (context) => {
  const named = await namedTask(context)
  if ('exit' in named) return named
  const { queue, taskId } = named
  const { store, reveal } = context
  const facts = await store.operator.taskFacts(queue, taskId)
  if (facts === null) return noSuchTask(queue, taskId)
  // The outcome is rendered as `result` renders it, a refused row included.
  const outcome =
    'result' in facts.outcome
      ? resultView(facts.outcome.result, reveal)
      : unreadable({ state: 'unreadable' }, facts.outcome.refused, reveal).view
  return {
    exit: whatIsNotReadable(facts).length === 0 ? 'done' : 'unreadable',
    holdsFacts: true,
    view: { queue, taskId, ...factsView(facts, outcome, reveal) },
  }
}

/** How many checkpoints a task has committed, or that a row of them is one the decoders refuse. */
async function checkpointCount(
  store: Pick<OpenedStore, 'scheduler'>,
  queue: string,
  taskId: string,
): Promise<number | 'unreadable'> {
  const rows = await decoded(() => store.scheduler.getCheckpoints(queue, taskId, MAX_RUN_ORDINAL))
  return 'refused' in rows ? 'unreadable' : rows.value.length
}

/**
 * One task's facts and what `diagnose` says of them, or null for a task the queue does not
 * hold. `diagnose` names the evidence a cause turns on, and it is read here and handed
 * back: the task's checkpoints, the waits on the event it awaits, or the child the task
 * awaits, which is diagnosed the same way. A child that is already on the way, the task itself among them, closes a ring and is
 * not read again, and the evidence says whether a clock of any task of the ring ends its
 * wait. A task that is CHILD_HOPS awaits from the one named has its own child
 * left unread, so a chain of awaits costs a bounded number of reads.
 */
export async function explained(
  store: Pick<OpenedStore, 'operator' | 'scheduler'>,
  queue: string,
  taskId: string,
  onTheWay: readonly TaskOnTheWay[] = [],
): Promise<{ readonly facts: TaskFacts; readonly diagnosis: Diagnosis } | null> {
  const facts = await store.operator.taskFacts(queue, taskId)
  if (facts === null) return null
  const hop = onTheWay.length
  const path = [...onTheWay, { taskId, endsByAClock: endsByAClock(facts) }]
  let evidence: Evidence = {}
  for (;;) {
    const asked = diagnose(facts, evidence)
    if (!('needs' in asked)) return { facts, diagnosis: asked }
    if (asked.needs in evidence) throw new Error(`diagnose asked for ${asked.needs} twice`)
    const ring = asked.needs === 'child' ? ringClosedBy(path, asked.taskId) : null
    if (asked.needs === 'checkpoints') {
      evidence = { ...evidence, checkpoints: await checkpointCount(store, queue, taskId) }
    } else if (asked.needs === 'waiters') {
      const waiters = await store.operator.eventWaiters(queue, asked.eventName)
      evidence = { ...evidence, waiters }
    } else if (ring !== null) {
      evidence = { ...evidence, child: ring }
    } else if (hop === CHILD_HOPS) {
      evidence = { ...evidence, child: 'not-followed' }
    } else {
      const child = await explained(store, queue, asked.taskId, path)
      evidence = { ...evidence, child: child?.diagnosis ?? 'absent' }
    }
  }
}

/**
 * Why a task is where it is: one cause from the closed table, a verdict, and the facts
 * behind it, on stdout whatever the command exits with. A verdict is not an exit code. The
 * command exits `done` for every task it could read, and `unreadable` when a row it read,
 * the task's or that of a child it followed, is one `inspect` exits `unreadable` for.
 */
const explain: Handler = async (context) => {
  const named = await namedTask(context)
  if ('exit' in named) return named
  const { queue, taskId } = named
  const found = await explained(context.store, queue, taskId)
  if (found === null) return noSuchTask(queue, taskId)
  const { facts, diagnosis } = found
  return {
    exit: readUnreadableRow(diagnosis) ? 'unreadable' : 'done',
    holdsFacts: true,
    view: {
      queue,
      ...answerView(diagnosis, queue),
      databaseNowEpochMs: facts.nowMs,
      fakeClock: facts.fakeClock,
      // An ended task's outcome, rendered as `result` renders it.
      ...(isTerminalState(facts.task.state) && 'result' in facts.outcome
        ? { outcome: resultView(facts.outcome.result, context.reveal) }
        : {}),
    },
  }
}

/** The refusal of a flag's value, which the parser took as text. Nothing was read. */
const flagRefused = (message: string): Answer => ({
  exit: 'usage',
  view: { error: { kind: 'usage', message } },
})

/** The queue a read of a queue names, once the schema window admits the database, or the answer that refuses. */
async function readableQueue({ invocation, store }: Context): Promise<string | Answer> {
  const queue = invocation.strings.queue ?? ''
  const version = await readableVersion(store)
  return typeof version === 'number' ? queue : { ...version, view: { queue, ...version.view } }
}

/** The seconds a duration flag names, or null for a value it cannot take. */
function secondsOf(shown: string): number | null {
  const seconds = durationSeconds(shown)
  return seconds === null || seconds * 1000 > MAX_DURATION_MS ? null : seconds
}

const durationRefused = (flag: string): Answer =>
  flagRefused(
    `--${flag} takes a whole number and a unit, s, m, h or d, as in 90s or 2m, of at most 100 years`,
  )

/**
 * What a move of the driver is owed to in one queue, and has been for at least the grace,
 * on stdout whatever the command exits with. With `--older-than` it also lists the live
 * tasks enqueued at least that long ago, which is an age and no lateness. Listing a row is
 * not a failure: the command exits `done` unless it was asked to fail on one, and then a
 * row of any list it printed counts. It exits `unreadable` when a row it read holds an
 * instant that is not readable, which it lists all the same, and that exit comes before
 * `found`, so a script never takes a report with a corrupt row for a count.
 */
const stuck: Handler = async (context) => {
  const { strings, booleans } = context.invocation
  const graceSeconds = strings.grace === undefined ? DUE_GRACE_MS / 1000 : secondsOf(strings.grace)
  if (graceSeconds === null) return durationRefused('grace')
  const asked = strings['older-than']
  const olderThanSeconds = asked === undefined ? undefined : secondsOf(asked)
  if (olderThanSeconds === null) return durationRefused('older-than')
  const limit =
    strings.limit === undefined
      ? STUCK_DEFAULT_LIMIT
      : /^[1-9][0-9]*$/.test(strings.limit)
        ? Number(strings.limit)
        : 0
  if (limit < 1 || limit > OPERATOR_LIST_CAP) {
    return flagRefused(`--limit takes a whole number from 1 to ${OPERATOR_LIST_CAP}`)
  }
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  const { operator } = context.store
  const owed = await operator.stuckRuns(queue, { graceSeconds, limit })
  const aged =
    olderThanSeconds === undefined
      ? undefined
      : await operator.agedTasks(queue, { olderThanSeconds, limit })
  const listed = rowsListed(owed) + (aged?.tasks.rows.length ?? 0)
  const notReadable = owed.corrupt.length + (aged?.corrupt.length ?? 0)
  const found = booleans['fail-if-any'] === true && listed > 0
  return {
    exit: notReadable > 0 ? 'unreadable' : found ? 'found' : 'done',
    holdsFacts: true,
    view: {
      queue,
      graceSeconds,
      limit,
      listed,
      ...stuckView(owed),
      ...(aged === undefined || olderThanSeconds === undefined
        ? {}
        : { agedLive: agedLiveView(aged, olderThanSeconds) }),
    },
  }
}

/**
 * A queue's gauges and the instants at its head, on stdout whatever the command exits
 * with. It exits `unreadable` when a row it counted holds an instant that is not readable.
 */
const stats: Handler = async (context) => {
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  const status = await context.store.operator.queueStatus(queue)
  return {
    exit: status.corrupt.length > 0 ? 'unreadable' : 'done',
    holdsFacts: true,
    view: { queue, ...statsView(status) },
  }
}

/** How many rows of each table a queue holds. */
const sizes: Handler = async (context) => {
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  return {
    exit: 'done',
    view: { queue, ...sizesView(await context.store.operator.tableRows(queue)) },
  }
}

const HANDLERS: Readonly<Record<Exclude<Verb, 'help'>, Handler>> = Object.freeze({
  doctor,
  migrate,
  result,
  checkpoints,
  inspect,
  explain,
  stuck,
  stats,
  sizes,
})
