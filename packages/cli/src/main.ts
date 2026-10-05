import {
  type CancelOptions,
  type Clock,
  type IdSource,
  MAX_RUN_ORDINAL,
  OPERATOR_LIST_CAP,
  PermanentStoreError,
  SchemaMismatchError,
  SchemaNotInitializedError,
  type SpawnResult,
  StoreUnavailableError,
  type TaskFacts,
  isLiveState,
  isPortRefusal,
  isTerminalState,
} from '@durablerun/core'
import {
  COMMANDS,
  type CommandSpec,
  type Invocation,
  STUCK_DEFAULT_LIMIT,
  SWEEP_DEFAULT_LIMIT,
  TICK_DEFAULT_TIMEOUT_SECONDS,
  TICK_MAX_TIMEOUT_SECONDS,
  UsageError,
  VERBS,
  type Verb,
  durationSeconds,
  parseInvocation,
  tickTimeoutSeconds,
  usage,
  wholeNumber,
} from './commands.js'
import {
  isReservedEventName,
  jsonArgument,
  refusesAnArgumentThatPrints,
  retryRefusal,
  rollbackFacts,
  runsInAnotherQueue,
} from './drive.js'
import { EXITS, type ExitName, exitCode } from './exit.js'
import {
  CHILD_HOPS,
  DUE_GRACE_MS,
  type Diagnosis,
  type Evidence,
  type TaskOnTheWay,
  admissionOf,
  answerView,
  diagnose,
  endsByAClock,
  readUnreadableRow,
  ringClosedBy,
} from './explain.js'
import {
  BODY_MAX_BYTES,
  deploymentOrigin,
  isRoutesOwn500,
  postTick,
  routerErrorCode,
  saysTryLater,
  tickRequest,
} from './http.js'
import { corruptView, factsView, stateView, whatIsNotReadable } from './inspect.js'
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
import { userValue } from './render.js'

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
  /** What `--target` names for the store that was opened. */
  readonly target: string
  /** The origin of the hosted deployment DURABLERUN_BASE_URL names, when it names one a token may be sent to. */
  readonly deployment: string | undefined
}

type Handler = (context: Context) => Promise<Answer>

/**
 * The CLI, with everything it touches handed in: the arguments, the environment it reads
 * DURABLERUN_STORE_URL and DURABLERUN_STORE_TOKEN from, and for `tick` DURABLERUN_BASE_URL
 * and DURABLERUN_TICK_TOKEN, the streams it writes, the ids a store takes, and the clock,
 * which `tick` alone uses, to end its wait for an answer. It answers with the exit code.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
  ids: IdSource,
  clock: Clock,
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
  // `tick` opens no store: it reads nothing of DURABLERUN_STORE_URL, and sends nothing there.
  if (spec.verb === 'tick') {
    return emit(io, json, spec.verb, undefined, await tick(invocation, env, clock))
  }
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
    // Only `migrate` creates a database. A drive verb that named a file that is not there
    // would otherwise leave an empty database behind its refusal.
    store = await opener(url, token, ids, {
      mayCreate: spec.verb === 'migrate' && invocation.booleans.yes === true,
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
    const deployment = deploymentOrigin(env.DURABLERUN_BASE_URL)
    answer = await HANDLERS[spec.verb]({ invocation, store, reveal, note, target, deployment })
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
          DURABLERUN_STORE_URL: 'the store every command but help and tick opens',
          DURABLERUN_STORE_TOKEN: "a libSQL server's token, when its URL needs one",
          DURABLERUN_BASE_URL:
            'the hosted deployment tick --url names: tick sends its token to that origin alone',
          DURABLERUN_TICK_TOKEN: "the bearer token that deployment's tick route takes",
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
      'tick opens no store: it posts to the origin of DURABLERUN_BASE_URL, with DURABLERUN_TICK_TOKEN.',
      'A write names its store again with --target, and emit, cancel and retry change nothing without --yes.',
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

/** The refusal of a flag's value, which the parser took as text. Nothing was read. */
const flagRefused = (message: string): Answer => ({
  exit: 'usage',
  view: { error: { kind: 'usage', message } },
})

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
  const asked = shown === undefined ? undefined : wholeNumber(shown, MAX_RUN_ORDINAL)
  if (asked === null) {
    return flagRefused(`--attempt takes a whole number from 1 to ${MAX_RUN_ORDINAL}`)
  }
  const found = await readTask(context)
  if ('exit' in found) return found
  const { queue, taskId } = found
  const attempt = asked ?? MAX_RUN_ORDINAL
  const view = { queue, taskId, attempt: asked ?? null }
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

/**
 * A read that follows a write the store has answered: what it read, or why it read nothing.
 * The write stands whatever the read meets. So an outage, a permanent error of the store, a
 * row the decoders refuse and a row that is gone are each an answer here, and none fails
 * the command: its caller is told what the write did, and that the read did not happen.
 * Nothing of the error is kept, because a store's message can quote a stored value. Every
 * other error is thrown.
 */
async function readBack<T>(read: () => Promise<T | null>): Promise<
  | { readonly value: T }
  | {
      readonly notRead: 'not-found' | 'store-unavailable' | 'permanent-store-error' | 'unreadable'
    }
> {
  try {
    const value = await read()
    return value === null ? { notRead: 'not-found' } : { value }
  } catch (error) {
    if (error instanceof StoreUnavailableError) return { notRead: 'store-unavailable' }
    if (error instanceof PermanentStoreError) return { notRead: 'permanent-store-error' }
    if (isUnreadableRow(error)) return { notRead: 'unreadable' }
    throw error
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
 * left unread, so a chain of awaits costs a bounded number of reads. When a deadline, a wake
 * or the end of a lease passes between the read of the facts and the read of the guards,
 * the facts are read again, once, and the answer is of them.
 */
export async function explained(
  store: Pick<OpenedStore, 'operator' | 'scheduler'>,
  queue: string,
  taskId: string,
  onTheWay: readonly TaskOnTheWay[] = [],
  factsReadAgain = false,
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
    } else if (asked.needs === 'admission') {
      const read = await store.operator.taskAdmission(queue, taskId)
      const admission = admissionOf(facts, read)
      // No row moved, and the facts are of an instant before the one that passed. Read
      // again, they answer for themselves. A second instant that passes is taken as a row
      // that moved, so the command reads a task's facts at most twice for this.
      if (admission === 'clock-passed' && !factsReadAgain) {
        return explained(store, queue, taskId, onTheWay, true)
      }
      evidence = { ...evidence, admission: admission === 'clock-passed' ? 'moved' : admission }
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
      ...answerView(diagnosis, { queue, target: context.target, url: context.deployment }),
      databaseNowEpochMs: facts.nowMs,
      fakeClock: facts.fakeClock,
      // An ended task's outcome, rendered as `result` renders it.
      ...(isTerminalState(facts.task.state) && 'result' in facts.outcome
        ? { outcome: resultView(facts.outcome.result, context.reveal) }
        : {}),
    },
  }
}

/**
 * The queue a command names, once the schema window admits the database, or the answer that
 * refuses. A drive verb is held to the same window as a read: on a database at each version
 * of it, the verb leaves what its port call leaves there, which a test holds.
 */
async function readableQueue({ invocation, store }: Context): Promise<string | Answer> {
  const queue = invocation.strings.queue ?? ''
  const version = await readableVersion(store)
  return typeof version === 'number' ? queue : { ...version, view: { queue, ...version.view } }
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
  const graceSeconds =
    strings.grace === undefined ? DUE_GRACE_MS / 1000 : durationSeconds(strings.grace)
  if (graceSeconds === null) return durationRefused('grace')
  const asked = strings['older-than']
  const olderThanSeconds = asked === undefined ? undefined : durationSeconds(asked)
  if (olderThanSeconds === null) return durationRefused('older-than')
  const limit =
    strings.limit === undefined
      ? STUCK_DEFAULT_LIMIT
      : wholeNumber(strings.limit, OPERATOR_LIST_CAP)
  if (limit === null) {
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

/** The refusal of a write that was not confirmed: what it would do, and that nothing was changed. */
const notConfirmed = (view: Record<string, unknown>, message: string): Answer => ({
  exit: 'usage',
  view: { ...view, error: { kind: 'confirmation-required', message } },
})

/**
 * Spawn a task under an idempotency key. It is the store's `spawn` and nothing else. The
 * key is required, so the command run again after a lost answer finds the task the first
 * run made and makes no second one, and says so with `created: false`. The task it found
 * is then read for the name it is stored under, which prints beside whether it is the name
 * this call passed. Its stored parameters are not compared, and the answer says so: no
 * read selects a task's parameters. The spawn has answered by then, so that read fails
 * nothing. When the task cannot be read back, the answer is still `created: false` with
 * the task's id, `taskNameMatches` is `unknown`, which is no mismatch, and
 * `storedTaskNotRead` says why: the store was unavailable, the row is one a read refuses,
 * or the task is gone.
 */
const enqueue: Handler = async (context) => {
  const { invocation, store, reveal } = context
  const params = jsonArgument(invocation.strings.params)
  if ('refused' in params) return flagRefused(`--params ${params.refused}`)
  const taskName = invocation.args.taskName ?? ''
  if (taskName === '') {
    return flagRefused(
      'enqueue takes a task name that is not empty: no handler is registered under an empty name',
    )
  }
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  const key = invocation.strings.key ?? ''
  const named = {
    queue,
    taskName,
    idempotencyKey: userValue(key, reveal),
    params: userValue(params.json, reveal),
  }
  let found: SpawnResult
  try {
    const spawned = await store.scheduler.spawn(queue, taskName, params.json, {
      idempotencyKey: key,
    })
    found = spawned
  } catch (error) {
    // A port's refusal names what the caller passed. The words print when the refusal is of
    // the queue or the task name, whose names print everywhere. Any other refusal may quote
    // the key, so its words print only with --reveal.
    if (!isPortRefusal(error) || reveal || refusesAnArgumentThatPrints(queue, taskName)) {
      throw error
    }
    return {
      exit: 'refused',
      view: {
        ...named,
        error: {
          kind: 'refused',
          name: error.name,
          message:
            'the store refused the call, and its words may quote the idempotency key: run it again with --reveal to print them. Nothing was changed',
        },
      },
    }
  }
  const view = { ...named, taskId: found.taskId, runId: found.runId, created: found.created }
  if (found.created) return { exit: 'done', view }
  // The key found a task another call made, under the name and the parameters that call
  // passed. The name and the parameters above are this call's.
  const stored = await readBack(() => store.operator.taskFacts(queue, found.taskId))
  if ('notRead' in stored) {
    return {
      exit: 'done',
      view: {
        ...view,
        storedTaskName: null,
        taskNameMatches: 'unknown',
        storedTaskNotRead: stored.notRead,
        storedParams: 'not-compared',
      },
    }
  }
  const storedTaskName = stored.value.task.taskName
  return {
    exit: 'done',
    view: {
      ...view,
      storedTaskName,
      taskNameMatches: storedTaskName === taskName,
      storedParams: 'not-compared',
    },
  }
}

/**
 * Emit an event. It is the store's `emitEvent` and nothing else: the first emit's payload
 * stands, and a later one changes no payload. The answer says which this call was, from the
 * event's state read before the write and its stored payload read after: `created`, or
 * `already-emitted` with the digest of the payload the event holds. That payload's text is
 * never printed, `--reveal` or not.
 */
const emitEvent: Handler = async (context) => {
  const { invocation, store, reveal } = context
  const eventName = invocation.args.eventName ?? ''
  const payload = jsonArgument(invocation.strings.payload)
  if ('refused' in payload) return flagRefused(`--payload ${payload.refused}`)
  if (isReservedEventName(eventName)) {
    return {
      exit: 'refused',
      view: {
        event: eventName,
        error: {
          kind: 'reserved-name',
          message: `the event name ${eventName} is reserved: names that start with $ belong to the engine. Nothing was sent`,
        },
      },
    }
  }
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  const before = await store.operator.eventState(queue, eventName)
  const waiting = await store.operator.eventWaiters(queue, eventName)
  const named = {
    queue,
    event: eventName,
    payload: userValue(payload.json, reveal),
    // The waits registered on the event as of the read before the write: what a first emit wakes.
    waitersBefore: waiting.waiters.rows.length,
    moreWaiters: waiting.waiters.atLeast,
  }
  if (invocation.booleans.yes !== true) {
    return notConfirmed(
      { ...named, exists: before.exists, emittedAtMs: before.emittedAtMs },
      before.exists
        ? `the event ${eventName} exists as of this read, and its first emit's payload stands: emit would change no payload. Run it again with --yes to be told that payload's digest. Nothing was changed`
        : `emit would create the event ${eventName} and wake the waits registered on it, ${named.waitersBefore} as of this read; run it again with --yes. Nothing was changed`,
    )
  }
  const sent = await decoded(() => store.scheduler.emitEvent(queue, eventName, payload.json))
  if ('refused' in sent) {
    return unreadable({ ...named, storedPayload: 'unreadable' }, sent.refused, reveal)
  }
  const stored = await store.operator.eventPayload(queue, eventName)
  if (!stored.exists) throw new Error('the event an emit answered for is not there')
  if (stored.payloadJson === null) {
    return unreadable(
      { ...named, storedPayload: 'unreadable' },
      `the stored payload is ${stored.stored}, not text`,
      reveal,
    )
  }
  const payloadMatches = stored.payloadJson === payload.json
  return {
    exit: 'done',
    view: {
      ...named,
      // The event was not there before the write and holds what this call sent: this call,
      // or one that sent the same payload a moment before it, made it.
      outcome: !before.exists && payloadMatches ? 'created' : 'already-emitted',
      storedPayload: userValue(stored.payloadJson, false),
      payloadMatches,
    },
  }
}

/**
 * Cancel a task. It is the store's `cancelTask` and nothing else. With --yes the port is
 * always called: no read stops the call. Without --halt-rollback the call asks the store
 * to spare a saga (`unlessSagaBegan`), so whether the task is rolling back is decided by
 * the statement that cancels it, and a saga that begins beside this command is not halted.
 * Cancelling a task whose saga began halts the rollback where it stands (DESIGN.md
 * section 3.10), which is why that takes the flag. When the port answers false it wrote
 * nothing, and why is read from the task as it stands after: gone, cancelled already,
 * ended another way, rolling back with no --halt-rollback, or live with a run in another
 * queue. The read before the call is for what a run without --yes says it would do, and
 * for `stateBefore`. The task is read again after the call, whatever the port answered.
 * Beside the outcome `cancelled`, `sagaBegan` is of that later read, so it is true of the
 * task this call cancelled, and `haltedRollback` says the same thing in the operator's
 * words: the cancellation halted a rollback. A saga that began between the first read and
 * the call shows there, where the first read would have said no saga began. That read
 * follows a write the store answered, and a failure of it exits as any read's does: the
 * task is cancelled, and the command run again reports `already-cancelled`.
 */
const cancel: Handler = async (context) => {
  const { invocation, store, reveal } = context
  const taskId = invocation.args.taskId ?? ''
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return { ...queue, view: { taskId, ...queue.view } }
  const before = await store.operator.taskFacts(queue, taskId)
  const haltRollback = invocation.booleans['halt-rollback'] === true
  const rollingBack = (facts: TaskFacts): boolean =>
    isLiveState(facts.task.state) && facts.task.sagaBegan
  /** The task as one read found it, with the rollback facts when it is rolling back. */
  const namedAt = (facts: TaskFacts | null) => ({
    queue,
    taskId,
    taskName: before?.task.taskName ?? facts?.task.taskName ?? null,
    stateBefore: before === null ? null : stateView(before.task.state, reveal),
    ...(facts === null
      ? {}
      : {
          sagaBegan: facts.task.sagaBegan,
          ...(rollingBack(facts) ? { rollback: rollbackFacts(facts, reveal) } : {}),
        }),
  })
  const halting =
    'its saga began, and cancelling it halts the rollback where it stands: a step not yet rolled back stays as it is'
  if (invocation.booleans.yes !== true) {
    if (before === null) return noSuchTask(queue, taskId)
    return notConfirmed(
      namedAt(before),
      !isLiveState(before.task.state)
        ? `task ${taskId} is not live as of this read, so cancel would change nothing. Nothing was changed`
        : rollingBack(before)
          ? `cancel would cancel task ${taskId} and its live run. As of this read ${halting}. Run it again with --yes and --halt-rollback. Nothing was changed`
          : `cancel would cancel task ${taskId} and its live run; run it again with --yes. Nothing was changed`,
    )
  }
  const asked: CancelOptions = haltRollback ? {} : { unlessSagaBegan: true }
  const cancelled = await store.scheduler.cancelTask(queue, taskId, asked)
  const after = await store.operator.taskFacts(queue, taskId)
  if (cancelled) {
    const said = namedAt(after)
    return {
      exit: 'done',
      view: {
        ...said,
        ...('sagaBegan' in said ? { haltedRollback: said.sagaBegan } : {}),
        outcome: 'cancelled',
      },
    }
  }
  if (after === null) return noSuchTask(queue, taskId)
  const named = namedAt(after)
  const state = after.task.state
  if (state === 'cancelled') {
    return { exit: 'done', view: { ...named, outcome: 'already-cancelled', state } }
  }
  if (!haltRollback && rollingBack(after)) {
    return notConfirmed(
      { ...named, state: stateView(state, reveal) },
      `task ${taskId} is rolling back as of this read: ${halting}. The store was asked to spare a saga, and it cancelled nothing. Run it again with --halt-rollback to cancel it all the same. Nothing was changed`,
    )
  }
  const elsewhere = runsInAnotherQueue(queue, after)
  const [cause, why] = isTerminalState(state)
    ? ['already-terminal', `the task is ${state}, and a task that has ended is not cancelled`]
    : elsewhere.length > 0
      ? [
          'run-in-another-queue',
          'the task is live, and a run that names it is in another queue, which no engine path writes',
        ]
      : ['not-cancelled', 'the task is live, and nothing its rows show refuses it: run it again']
  return {
    exit: 'refused',
    view: {
      ...named,
      state: stateView(state, reveal),
      ...(elsewhere.length > 0 ? { runsInAnotherQueue: elsewhere } : {}),
      error: {
        kind: 'refused',
        cause,
        message: `cancel of task ${taskId} was refused. As of this read: ${why}. Nothing was changed`,
      },
    },
  }
}

/**
 * Revive a failed task. It is the store's `retryTask` and nothing else. The one read the
 * command makes is of the retry guard's own conjuncts (`taskAdmission`), before the call
 * and after it. With --yes the port is always called: no read stops the call. When the
 * port answers null it wrote nothing, and why is read from the conjuncts as the task
 * stands after. A task that is live at that read is reported with its live run, and the
 * command exits `done`. It says `revived` when the task was failed before the call: the
 * revival is then this call's, delivered twice, or another caller's. It says
 * `already-live` when the task was live before the call, which is a repeat that finds its
 * revival made, or a task that never failed. The read cannot tell those two apart, and
 * neither is revived.
 */
const retry: Handler = async (context) => {
  const { invocation, store, reveal } = context
  const taskId = invocation.args.taskId ?? ''
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return { ...queue, view: { taskId, ...queue.view } }
  const before = await store.operator.taskAdmission(queue, taskId)
  const wasFailed = before?.state === 'failed'
  const named = {
    queue,
    taskId,
    stateBefore: before === null ? null : stateView(before.state, reveal),
  }
  if (invocation.booleans.yes !== true) {
    if (before === null) return noSuchTask(queue, taskId)
    return notConfirmed(
      named,
      wasFailed
        ? `retry would revive task ${taskId}: a new pending run, due now, one ordinal past its top run, and one more attempt in its budget. Run it again with --yes. Nothing was changed`
        : `task ${taskId} is not failed as of this read, and only a failed task is revived: retry would change nothing. Nothing was changed`,
    )
  }
  const revived = await store.scheduler.retryTask(queue, taskId)
  if (revived !== null) {
    return {
      exit: 'done',
      view: { ...named, outcome: 'revived', runId: revived.runId, attempt: revived.attempt },
    }
  }
  const admission = await store.operator.taskAdmission(queue, taskId)
  if (admission === null) return noSuchTask(queue, taskId)
  const liveRun = admission.runs.find((run) => isLiveState(run.state))
  if (isLiveState(admission.state) && liveRun !== undefined) {
    return {
      exit: 'done',
      view: {
        ...named,
        outcome: wasFailed ? 'revived' : 'already-live',
        state: admission.state,
        runId: liveRun.runId,
      },
    }
  }
  const refusal = retryRefusal(taskId, admission)
  return {
    exit: 'refused',
    view: {
      ...named,
      state: stateView(admission.state, reveal),
      causes: refusal.causes,
      conjunctsNotHeld: refusal.conjunctsNotHeld,
      conjunctsNotAsked: refusal.conjunctsNotAsked,
      corrupt: admission.corrupt.map(corruptView),
      error: { kind: 'refused', cause: refusal.cause, message: refusal.message },
    },
  }
}

/**
 * One sweep of a queue, and then the queue's next wake. It is the store's `sweep` and
 * nothing else: it cancels the tasks past their deadline and takes back the runs whose
 * lease lapsed, as a tick's first step does, up to the limit, and claims nothing.
 */
const sweep: Handler = async (context) => {
  const shown = context.invocation.strings.limit
  const most = shown === undefined ? SWEEP_DEFAULT_LIMIT : wholeNumber(shown, OPERATOR_LIST_CAP)
  if (most === null) {
    return flagRefused(`--limit takes a whole number from 1 to ${OPERATOR_LIST_CAP}`)
  }
  const queue = await readableQueue(context)
  if (typeof queue !== 'string') return queue
  const { scheduler } = context.store
  const swept = await scheduler.sweep(queue, most)
  return {
    exit: 'done',
    view: {
      queue,
      limit: most,
      swept: swept.length,
      // The sweep made as many transitions as its limit, so it may have left more: run it
      // again. False says only that it made fewer. The port answers the transitions this
      // call won, and a row another sweeper took from under it is not among them, so what
      // is still owed is what `stuck` lists.
      atLimit: swept.length >= most,
      // Each transition is a kind and the ids it names. None is a value a user wrote.
      transitions: swept,
      nextWakeAtEpochMs: await scheduler.nextWakeAtEpochMs(queue),
    },
  }
}

/**
 * One bounded pass of a hosted deployment: a POST to its tick route, and the route's
 * answer. It opens no store. Nothing is sent unless `--url` names the origin of
 * DURABLERUN_BASE_URL, and the token goes in the Authorization header to that origin
 * alone. An answer that does not come within the timeout exits `unavailable`: the pass may
 * still have run, and a tick is safe to send again. An answer that says the deployment
 * cannot now exits `unavailable` too. An answer the command takes for no outage exits
 * `permanent`: a hosted route's own 500, a status no tick route gives, and a 200 it cannot
 * read as a tick's.
 */
async function tick(
  invocation: Invocation,
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock,
): Promise<Answer> {
  const shown = invocation.strings.timeout
  const seconds = shown === undefined ? TICK_DEFAULT_TIMEOUT_SECONDS : tickTimeoutSeconds(shown)
  if (seconds === null) {
    return flagRefused(
      `--timeout takes a whole number above zero and a unit, s, m, h or d, as in 90s or 2m, of at most ${TICK_MAX_TIMEOUT_SECONDS}s, the longest wait a timer holds: 24d is within it and 25d is not`,
    )
  }
  const request = tickRequest({
    url: invocation.strings.url ?? '',
    baseUrl: env.DURABLERUN_BASE_URL,
    token: env.DURABLERUN_TICK_TOKEN,
  })
  if ('refused' in request) {
    return { exit: 'usage', view: { error: { kind: request.kind, message: request.refused } } }
  }
  const sentTo = { url: request.endpoint, timeoutSeconds: seconds }
  const outcome = await postTick(request, seconds * 1000, clock)
  if (outcome.kind === 'timed-out' || outcome.kind === 'unreachable') {
    return {
      exit: 'unavailable',
      view: {
        ...sentTo,
        error: {
          kind: outcome.kind,
          message:
            outcome.kind === 'timed-out'
              ? `the deployment did not answer within ${seconds} seconds. The pass may still have run, and a tick is safe to send again`
              : 'the deployment could not be reached, or the connection broke before it answered',
        },
      },
    }
  }
  const { status } = outcome
  // A body longer than is read is no body. Only a 200 is told from another by it.
  const body = outcome.kind === 'answered' ? outcome.body : undefined
  if (status === 200 && body !== undefined)
    return { exit: 'done', view: { ...sentTo, status, tick: body } }
  const code = routerErrorCode(body)
  const refused = (exit: ExitName, kind: string, message: string): Answer => ({
    exit,
    view: { ...sentTo, status, ...(code === undefined ? {} : { code }), error: { kind, message } },
  })
  if (status === 401 || status === 403) {
    return refused(
      'unauthorized',
      'unauthorized',
      `the deployment refused the token tick sent, with HTTP ${status}`,
    )
  }
  if (saysTryLater(status, code)) {
    return refused(
      'unavailable',
      'deployment-unavailable',
      status === 503
        ? 'the deployment answered HTTP 503: its store or its authorization is unavailable'
        : `the deployment answered HTTP ${status}, which says it cannot now. A tick is safe to send again`,
    )
  }
  if (isRoutesOwn500(status, code)) {
    return refused(
      'permanent',
      'deployment-error',
      `the deployment answered HTTP 500 with the code ${code}, which is a hosted route's own answer: the route failed in a way it does not class as an outage, for which it answers 503. Its own log says what failed`,
    )
  }
  if (status === 200 && outcome.kind === 'answer-too-large') {
    return refused(
      'permanent',
      'answer-too-large',
      `the deployment answered HTTP 200 with a body longer than ${BODY_MAX_BYTES} bytes, and no more of it was read. If it is a tick route, the pass ran: stats and stuck say what the queue holds now`,
    )
  }
  return refused(
    'permanent',
    'unexpected-answer',
    status === 200
      ? 'the deployment answered HTTP 200 with a body that is no JSON object, so it is not a tick route'
      : `the deployment answered HTTP ${status}, which a tick route does not answer a tick with`,
  )
}

const HANDLERS: Readonly<Record<Exclude<Verb, 'help' | 'tick'>, Handler>> = Object.freeze({
  doctor,
  migrate,
  result,
  checkpoints,
  inspect,
  explain,
  stuck,
  stats,
  sizes,
  enqueue,
  emit: emitEvent,
  cancel,
  retry,
  sweep,
})
