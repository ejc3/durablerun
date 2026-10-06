import { parseArgs } from 'node:util'
import { MAX_DURATION_MS, MIN_RETENTION_SECONDS, OPERATOR_LIST_CAP } from '@durablerun/core'
import type { ExitName } from './exit.js'

/**
 * The one command table. Parsing, usage, `help --json`, the exit codes each command can
 * give, the port calls and batch labels each command can send, and what each does when a
 * fault meets one of those batches are all read from here, so a command cannot be added in
 * one of those places and missed in another.
 */

export const VERBS = [
  'help',
  'doctor',
  'migrate',
  'result',
  'checkpoints',
  'inspect',
  'explain',
  'stuck',
  'stats',
  'sizes',
  'enqueue',
  'emit',
  'cancel',
  'retry',
  'sweep',
  'purge',
  'tick',
] as const
export type Verb = (typeof VERBS)[number]

export interface FlagSpec {
  readonly type: 'string' | 'boolean'
  readonly required?: true
  /** The placeholder usage prints for a string flag's value. */
  readonly value?: string
  readonly description: string
  /** What the refusal of a command line that leaves a required flag out says besides the usage. */
  readonly missing?: string
}

/** One port call a command makes, and every batch label that call can send. */
export interface PortUse {
  readonly call:
    | 'admin.schemaVersion'
    | 'admin.nowEpochMs'
    | 'admin.migrate'
    | 'scheduler.getTaskResult'
    | 'scheduler.getCheckpoints'
    | 'scheduler.spawn'
    | 'scheduler.emitEvent'
    | 'scheduler.cancelTask'
    | 'scheduler.retryTask'
    | 'scheduler.sweep'
    | 'scheduler.nextWakeAtEpochMs'
    | 'operator.taskFacts'
    | 'operator.taskIdByKey'
    | 'operator.stuckRuns'
    | 'operator.agedTasks'
    | 'operator.queueStatus'
    | 'operator.tableRows'
    | 'operator.eventWaiters'
    | 'operator.eventState'
    | 'operator.eventPayload'
    | 'operator.taskAdmission'
    | 'retention.purgeCandidates'
    | 'retention.purgeUnit'
    | 'retention.purgeAdmission'
  /** A label ending in `<N>` stands for what comes before it followed by a whole number. */
  readonly labels: readonly string[]
}

/**
 * What running a command again does after its answer was lost. `read` prints the state it
 * finds as of that read, and `resumes` carries on from wherever the first run stopped.
 * `settles` is a write that a repeat does not double: the repeat reaches the state one
 * successful run leaves, and prints the state it finds as of that read. `no-store` opens
 * no store, and what a repeat does is the deployment's to say.
 */
export type RepeatSafety = 'no-store' | 'read' | 'resumes' | 'settles'

/**
 * A fault injected at the executor, as the CLI sees it, at one batch a command sends: the
 * executor rejects with StoreUnavailableError before the batch is sent (`crash-before`),
 * rejects after the batch commits (`crash-after`), or delivers the batch twice
 * (`duplicate`). The fault matrix's kinds (packages/conformance/src/fault-matrix.ts) as a
 * CLI-level injection, not SimWorld's SimCrash.
 */
export const CLI_FAULTS = ['crash-before', 'crash-after', 'duplicate'] as const
export type CliFault = (typeof CLI_FAULTS)[number]

export interface CommandSpec {
  readonly verb: Verb
  readonly summary: string
  readonly positionals: readonly string[]
  /** An argument that a flag may stand in for: the command takes one of the two, never both. */
  readonly alternative?: { readonly positional: string; readonly flag: string }
  readonly flags: Readonly<Record<string, FlagSpec>>
  readonly opensStore: boolean
  /** Whether the command changes the database, and so needs `--target`. */
  readonly writes: boolean
  readonly repeat: RepeatSafety
  readonly ports: readonly PortUse[]
  /** The exit codes the command gives, by name. Every command can also exit `internal`. */
  readonly exits: readonly ExitName[]
  /** The exit a fault at a batch the command sends ends in, or null for no store. */
  readonly faults: Readonly<Record<CliFault, ExitName>> | null
  /** Batches whose faults end differently, by label, written as in `ports`. */
  readonly faultsAt?: Readonly<Record<string, Readonly<Partial<Record<CliFault, ExitName>>>>>
}

const OUTPUT_FLAGS = {
  json: { type: 'boolean', description: 'print one JSON document' },
} as const satisfies Record<string, FlagSpec>

const READ_FLAGS = {
  ...OUTPUT_FLAGS,
  queue: { type: 'string', required: true, value: 'Q', description: 'the queue to read' },
  reveal: {
    type: 'boolean',
    description: 'print the text of values users wrote, which are redacted by default',
  },
} as const satisfies Record<string, FlagSpec>

/**
 * How a read names its task: by its id, or by the idempotency key it was spawned under in
 * place of the id. The flag and the pairing that gives it its meaning are one definition, so
 * a command cannot take the flag and still require the id.
 */
const BY_ID_OR_KEY = {
  positionals: ['taskId'],
  alternative: { positional: 'taskId', flag: 'key' },
  flags: {
    ...READ_FLAGS,
    key: {
      type: 'string',
      value: 'K',
      description: 'the idempotency key the task was spawned under, in place of its id',
    },
  },
} as const satisfies Pick<CommandSpec, 'positionals' | 'alternative' | 'flags'>

/** The flag every command that writes names its store again with. */
const TARGET_FLAG = {
  type: 'string',
  required: true,
  value: 'T',
  description: "the store URL's host, or the path of a file: URL, named again",
} as const satisfies FlagSpec

/** The flags of a command that writes to a queue: the store named again, and the queue from the arguments alone. */
const DRIVE_FLAGS = {
  ...OUTPUT_FLAGS,
  queue: { type: 'string', required: true, value: 'Q', description: 'the queue to write to' },
  target: TARGET_FLAG,
  reveal: READ_FLAGS.reveal,
} as const satisfies Record<string, FlagSpec>

/** The flag that confirms a write an operator should read first. No suggestion ever carries it. */
const YES_FLAG = {
  type: 'boolean',
  description:
    'confirm the change; without it nothing changes, and the command says what it would do',
} as const satisfies FlagSpec

const SCHEMA_VERSION: PortUse = { call: 'admin.schemaVersion', labels: ['migrate:version'] }
const TASK_RESULT: PortUse = { call: 'scheduler.getTaskResult', labels: ['task-result'] }
const CHECKPOINTS: PortUse = { call: 'scheduler.getCheckpoints', labels: ['get-checkpoints'] }
const TASK_ID_BY_KEY: PortUse = { call: 'operator.taskIdByKey', labels: ['task-id-by-key'] }
const TASK_FACTS: PortUse = { call: 'operator.taskFacts', labels: ['task-facts', 'fake-clock'] }
const STUCK_RUNS: PortUse = { call: 'operator.stuckRuns', labels: ['stuck-runs', 'fake-clock'] }
const AGED_TASKS: PortUse = { call: 'operator.agedTasks', labels: ['aged-tasks', 'fake-clock'] }
const QUEUE_STATUS: PortUse = {
  call: 'operator.queueStatus',
  labels: ['queue-status', 'fake-clock'],
}
const TABLE_ROWS: PortUse = { call: 'operator.tableRows', labels: ['table-rows'] }
const EVENT_WAITERS: PortUse = { call: 'operator.eventWaiters', labels: ['event-waiters'] }
const EVENT_STATE: PortUse = { call: 'operator.eventState', labels: ['event-state'] }
const EVENT_PAYLOAD: PortUse = { call: 'operator.eventPayload', labels: ['event-payload'] }
const TASK_ADMISSION: PortUse = { call: 'operator.taskAdmission', labels: ['task-admission'] }
const SPAWN: PortUse = { call: 'scheduler.spawn', labels: ['spawn'] }
const EMIT_EVENT: PortUse = { call: 'scheduler.emitEvent', labels: ['emit-event'] }
const CANCEL_TASK: PortUse = { call: 'scheduler.cancelTask', labels: ['cancel-task'] }
const RETRY_TASK: PortUse = { call: 'scheduler.retryTask', labels: ['retry-task'] }
const SWEEP: PortUse = {
  call: 'scheduler.sweep',
  labels: ['sweep:scan', 'sweep:cancel', 'sweep:lost-launch', 'sweep:claim-timeout'],
}
const NEXT_WAKE: PortUse = { call: 'scheduler.nextWakeAtEpochMs', labels: ['next-wake'] }
const PURGE_CANDIDATES: PortUse = {
  call: 'retention.purgeCandidates',
  labels: ['purge-candidates'],
}
const PURGE_UNIT: PortUse = { call: 'retention.purgeUnit', labels: ['purge-unit'] }
const PURGE_ADMISSION: PortUse = { call: 'retention.purgeAdmission', labels: ['purge-admission'] }

/** Both crashes exit 6, and a batch delivered twice ends as a run without a fault does. */
const READ_FAULTS = {
  'crash-before': 'unavailable',
  'crash-after': 'unavailable',
  duplicate: 'done',
} as const satisfies Record<CliFault, ExitName>

/**
 * The faults of a command that writes through one fenced batch. Both crashes exit 6: the
 * write may have committed, and a repeat reaches the state one run leaves. A batch
 * delivered twice ends as a run without a fault does, because the second delivery of a
 * fenced batch writes nothing, and the command reads what it finds.
 */
const DRIVE_FAULTS = READ_FAULTS

const STORE_EXITS = ['done', 'usage', 'schema', 'unavailable', 'permanent'] as const

/** The exits of a write to a queue. A port refuses a name it cannot take. */
const DRIVE_EXITS = [...STORE_EXITS, 'refused'] as const

/** The exits of a read that names one task. */
const TASK_READ_EXITS = [...STORE_EXITS, 'refused', 'not-found', 'unreadable'] as const

/** The exits of a read of a queue. A port refuses a queue name it cannot take. */
const QUEUE_READ_EXITS = [...STORE_EXITS, 'refused'] as const

/** How many rows each leg of `stuck` lists when `--limit` is not given. */
export const STUCK_DEFAULT_LIMIT = 20

/**
 * How many transitions one `sweep` makes at most when `--limit` is not given: what one leg
 * of `stuck` lists, so a sweep with no flag takes what a `stuck` with no flag showed.
 */
export const SWEEP_DEFAULT_LIMIT = STUCK_DEFAULT_LIMIT

/** How many units one `purge` takes at most, or lists as ones it would take, when `--limit` is not given. */
export const PURGE_DEFAULT_LIMIT = 100

/** How long `tick` waits for the deployment's answer when `--timeout` is not given. */
export const TICK_DEFAULT_TIMEOUT_SECONDS = 60

/**
 * The longest `tick` waits, in seconds: what a timer holds. A timer keeps its delay in 31
 * bits of milliseconds, and the runtime fires a longer one at once, so a wait past this
 * would end as it began. It is 24 days and 20 hours: `24d` is within it and `25d` is not.
 */
export const TICK_MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000)

const DURATION_UNITS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const

/**
 * The seconds of a duration as an operator writes one: a whole number and a unit, `s`, `m`,
 * `h` or `d`, as in `90s` or `2m`, of at most the 100 years a port takes. Null for any
 * other text.
 */
export function durationSeconds(text: string): number | null {
  const match = /^(0|[1-9][0-9]{0,8})([smhd])$/.exec(text)
  if (match === null) return null
  const seconds = Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS]
  return seconds * 1000 > MAX_DURATION_MS ? null : seconds
}

/**
 * The seconds `tick --timeout` waits: a duration as above, above zero, of at most
 * `TICK_MAX_TIMEOUT_SECONDS`. Null for any other text.
 */
export function tickTimeoutSeconds(text: string): number | null {
  const seconds = durationSeconds(text)
  return seconds === null || seconds === 0 || seconds > TICK_MAX_TIMEOUT_SECONDS ? null : seconds
}

/** A whole number from 1 to `most`, as a flag writes one. Null for any other text. */
export function wholeNumber(text: string, most: number): number | null {
  return /^[1-9][0-9]*$/.test(text) && Number(text) <= most ? Number(text) : null
}

export const COMMANDS: Readonly<Record<Verb, CommandSpec>> = Object.freeze({
  help: {
    verb: 'help',
    summary: 'print the commands, and with --json every flag, exit code and batch label',
    positionals: [],
    flags: OUTPUT_FLAGS,
    opensStore: false,
    writes: false,
    repeat: 'no-store',
    ports: [],
    exits: ['done', 'usage'],
    faults: null,
  },
  doctor: {
    verb: 'doctor',
    summary: "the build's schema version, the database's clock and recorded schema version",
    positionals: [],
    flags: READ_FLAGS,
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, { call: 'admin.nowEpochMs', labels: ['admin:now'] }],
    exits: STORE_EXITS,
    faults: READ_FAULTS,
  },
  migrate: {
    verb: 'migrate',
    summary: 'apply every schema version this build has and the database lacks',
    positionals: [],
    flags: {
      ...OUTPUT_FLAGS,
      yes: { type: 'boolean', description: 'confirm the change; without it nothing changes' },
      target: TARGET_FLAG,
    },
    opensStore: true,
    writes: true,
    repeat: 'resumes',
    ports: [
      SCHEMA_VERSION,
      { call: 'admin.migrate', labels: ['migrate:version', 'migrate:bootstrap', 'migrate:v<N>'] },
    ],
    exits: STORE_EXITS,
    faults: READ_FAULTS,
    // After a version write fails, the admin reads the version again and carries on when
    // the write landed, so a lost answer to a write the store committed ends in `done`.
    faultsAt: {
      'migrate:bootstrap': { 'crash-after': 'done' },
      'migrate:v<N>': { 'crash-after': 'done' },
    },
  },
  result: {
    verb: 'result',
    summary: "a task's state and decoded outcome",
    positionals: ['taskId'],
    flags: READ_FLAGS,
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, TASK_RESULT],
    exits: TASK_READ_EXITS,
    faults: READ_FAULTS,
  },
  checkpoints: {
    verb: 'checkpoints',
    summary: "a task's committed checkpoints, the engine's own markers included",
    positionals: ['taskId'],
    flags: {
      ...READ_FLAGS,
      attempt: {
        type: 'string',
        value: 'N',
        description: 'only the checkpoints an attempt up to N could see',
      },
    },
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, TASK_RESULT, CHECKPOINTS],
    exits: TASK_READ_EXITS,
    faults: READ_FAULTS,
  },
  inspect: {
    verb: 'inspect',
    summary:
      'one snapshot of a task: its row, its outcome, its runs, its waits, and the events they name',
    ...BY_ID_OR_KEY,
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, TASK_ID_BY_KEY, TASK_FACTS],
    exits: TASK_READ_EXITS,
    faults: READ_FAULTS,
  },
  explain: {
    verb: 'explain',
    summary:
      'why a task is where it is: one cause from a closed table, a verdict, and the facts behind it',
    ...BY_ID_OR_KEY,
    opensStore: true,
    writes: false,
    repeat: 'read',
    // The checkpoints are read only for a started run parked on a timer and no event, the
    // waiters of an event only for a run parked on an await of it, and what the engine's
    // guards say of the task only when a move is owed to it.
    ports: [SCHEMA_VERSION, TASK_ID_BY_KEY, TASK_FACTS, CHECKPOINTS, EVENT_WAITERS, TASK_ADMISSION],
    exits: TASK_READ_EXITS,
    faults: READ_FAULTS,
  },
  stuck: {
    verb: 'stuck',
    summary:
      'the runs and tasks of a queue that a move of the driver is owed to, and has been for at least the grace',
    positionals: [],
    flags: {
      ...READ_FLAGS,
      grace: {
        type: 'string',
        value: 'D',
        description:
          'how long a move must have been owed before its row is listed: a whole number and s, m, h or d, as in 90s; when not given, the grace after which explain calls a move late',
      },
      limit: {
        type: 'string',
        value: 'N',
        description: `the most rows each leg lists, from 1 to ${OPERATOR_LIST_CAP}; ${STUCK_DEFAULT_LIMIT} when not given`,
      },
      'older-than': {
        type: 'string',
        value: 'D',
        description:
          'also list the live tasks enqueued at least this long ago, oldest first, each with its age: a whole number and s, m, h or d, as in 1h',
      },
      'fail-if-any': { type: 'boolean', description: 'exit 9 when any row is listed' },
    },
    opensStore: true,
    writes: false,
    repeat: 'read',
    // The oldest live tasks are read only with --older-than.
    ports: [SCHEMA_VERSION, STUCK_RUNS, AGED_TASKS],
    exits: [...QUEUE_READ_EXITS, 'found', 'unreadable'],
    faults: READ_FAULTS,
  },
  stats: {
    verb: 'stats',
    summary:
      "a queue's gauges, each a count that stops at a cap, and how long the head of the queue has waited",
    positionals: [],
    flags: READ_FLAGS,
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, QUEUE_STATUS],
    exits: [...QUEUE_READ_EXITS, 'unreadable'],
    faults: READ_FAULTS,
  },
  sizes: {
    verb: 'sizes',
    summary: 'how many rows of each table a queue holds, each count stopped at a cap',
    positionals: [],
    flags: READ_FLAGS,
    opensStore: true,
    writes: false,
    repeat: 'read',
    ports: [SCHEMA_VERSION, TABLE_ROWS],
    exits: QUEUE_READ_EXITS,
    faults: READ_FAULTS,
  },
  enqueue: {
    verb: 'enqueue',
    summary:
      'spawn a task under an idempotency key: a repeat under the same key creates nothing and answers the task it finds',
    positionals: ['taskName'],
    flags: {
      ...DRIVE_FLAGS,
      key: {
        type: 'string',
        required: true,
        value: 'K',
        description:
          'the idempotency key the task is spawned under, so that running the command again after a lost answer spawns no second task',
      },
      params: {
        type: 'string',
        value: 'JSON',
        description: "the task's parameters, one JSON value; null when not given",
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    // The task a key found is read for its stored name, when the call created nothing.
    ports: [SCHEMA_VERSION, SPAWN, TASK_FACTS],
    exits: DRIVE_EXITS,
    faults: DRIVE_FAULTS,
    // That read follows a spawn the store has answered, so a fault at it fails nothing: the
    // command answers the task the key found, and says its stored name was not read.
    faultsAt: {
      'task-facts': { 'crash-before': 'done', 'crash-after': 'done' },
      'fake-clock': { 'crash-before': 'done', 'crash-after': 'done' },
    },
  },
  emit: {
    verb: 'emit',
    summary:
      "emit an event: the first emit's payload stands, and a later one is told that payload's digest",
    positionals: ['eventName'],
    flags: {
      ...DRIVE_FLAGS,
      yes: YES_FLAG,
      payload: {
        type: 'string',
        value: 'JSON',
        description: "the event's payload, one JSON value; null when not given",
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    // The event's state and its waiters are read before the write, and its stored payload after.
    ports: [SCHEMA_VERSION, EVENT_STATE, EVENT_WAITERS, EMIT_EVENT, EVENT_PAYLOAD],
    exits: [...DRIVE_EXITS, 'unreadable'],
    faults: DRIVE_FAULTS,
  },
  cancel: {
    verb: 'cancel',
    summary: 'cancel a live task; one that is rolling back only with --halt-rollback',
    positionals: ['taskId'],
    flags: {
      ...DRIVE_FLAGS,
      yes: YES_FLAG,
      'halt-rollback': {
        type: 'boolean',
        description:
          'cancel a task whose saga began: the rollback halts where it stands, and steps not yet rolled back stay as they are',
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    // The task is read before the call, and again after it, whatever the port answered.
    ports: [SCHEMA_VERSION, TASK_FACTS, CANCEL_TASK],
    exits: [...DRIVE_EXITS, 'not-found'],
    faults: DRIVE_FAULTS,
  },
  retry: {
    verb: 'retry',
    summary:
      'revive a failed task with a new run, or name the conjunct of the retry guard that refuses it',
    positionals: ['taskId'],
    flags: { ...DRIVE_FLAGS, yes: YES_FLAG },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    // What the guard says of the task is read before the write, and again when the port
    // answers null. It is the command's one read: it selects none of the counters the guard
    // holds to a range, so it answers for a counter no number holds.
    ports: [SCHEMA_VERSION, TASK_ADMISSION, RETRY_TASK],
    exits: [...DRIVE_EXITS, 'not-found'],
    faults: DRIVE_FAULTS,
  },
  sweep: {
    verb: 'sweep',
    summary:
      "one sweep of a queue: cancel what is past its deadline and take back the runs whose lease lapsed, then the queue's next wake",
    positionals: [],
    flags: {
      ...DRIVE_FLAGS,
      limit: {
        type: 'string',
        value: 'N',
        description: `the most transitions the sweep makes, from 1 to ${OPERATOR_LIST_CAP}; ${SWEEP_DEFAULT_LIMIT} when not given`,
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    ports: [SCHEMA_VERSION, SWEEP, NEXT_WAKE],
    exits: DRIVE_EXITS,
    faults: DRIVE_FAULTS,
  },
  purge: {
    verb: 'purge',
    summary:
      'delete whole units of ended tasks older than the windows named, each only if the barrier lets it go: a dry run that writes nothing unless --execute',
    positionals: [],
    flags: {
      ...DRIVE_FLAGS,
      'completed-after': {
        type: 'string',
        required: true,
        value: 'D',
        description: `how long a completed task is kept after it ended: a whole number and s, m, h or d, as in 12h, of at least ${MIN_RETENTION_SECONDS} seconds`,
        missing: 'a purge has no default window: name how long a completed task is kept',
      },
      'cancelled-after': {
        type: 'string',
        required: true,
        value: 'D',
        description: 'how long a cancelled task is kept after it ended, written the same way',
        missing: 'a purge has no default window: name how long a cancelled task is kept',
      },
      'failed-after': {
        type: 'string',
        value: 'D',
        description:
          'how long a failed task is kept after it ended, written the same way; when not given, failed tasks are kept, because retry can revive one',
      },
      limit: {
        type: 'string',
        value: 'N',
        description: `the most units the command purges, or lists as ones it would purge, from 1 to ${OPERATOR_LIST_CAP}; ${PURGE_DEFAULT_LIMIT} when not given`,
      },
      execute: {
        type: 'boolean',
        description:
          'purge; without it nothing is deleted, and the command lists each candidate with what the barrier says of it as of that read',
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'settles',
    // The queue's status is read for one fact, whether the test clock is set. A unit's
    // conditions are read for a dry run, and after a purge the port answered kept.
    ports: [SCHEMA_VERSION, QUEUE_STATUS, PURGE_CANDIDATES, PURGE_UNIT, PURGE_ADMISSION],
    exits: DRIVE_EXITS,
    faults: DRIVE_FAULTS,
  },
  tick: {
    verb: 'tick',
    summary:
      'one bounded pass of a hosted deployment, over HTTP: it opens no store, and sends its token only to the origin DURABLERUN_BASE_URL names',
    positionals: [],
    flags: {
      ...OUTPUT_FLAGS,
      url: {
        type: 'string',
        required: true,
        value: 'U',
        description:
          "the deployment's URL, named again: its origin must be the origin of DURABLERUN_BASE_URL",
        missing:
          'tick runs one pass of a hosted deployment and no pass over a store: over a store, sweep takes back what a sweep takes, and no command claims',
      },
      timeout: {
        type: 'string',
        value: 'D',
        description: `how long to wait for the answer: a whole number above zero and s, m, h or d, as in 90s, of at most ${TICK_MAX_TIMEOUT_SECONDS}s; ${TICK_DEFAULT_TIMEOUT_SECONDS}s when not given`,
      },
    },
    opensStore: false,
    writes: false,
    repeat: 'no-store',
    ports: [],
    exits: ['done', 'usage', 'unauthorized', 'unavailable', 'permanent'],
    faults: null,
  },
} satisfies Record<Verb, CommandSpec>)

function labelMatches(declared: string, label: string): boolean {
  if (!declared.endsWith('<N>')) return label === declared
  const prefix = declared.slice(0, -'<N>'.length)
  return label.startsWith(prefix) && /^[0-9]+$/.test(label.slice(prefix.length))
}

/** Whether a batch label is one the command declares. */
export function declaresLabel(spec: CommandSpec, label: string): boolean {
  return spec.ports.some((port) => port.labels.some((declared) => labelMatches(declared, label)))
}

/** The exit the command table declares for a fault at a batch with this label. */
export function faultExit(spec: CommandSpec, label: string, fault: CliFault): ExitName {
  if (spec.faults === null) throw new Error(`${spec.verb} opens no store, so no fault meets it`)
  for (const [declared, exits] of Object.entries(spec.faultsAt ?? {})) {
    const exit = labelMatches(declared, label) ? exits[fault] : undefined
    if (exit !== undefined) return exit
  }
  return spec.faults[fault]
}

const shownFlag = (name: string, flag: FlagSpec): string =>
  flag.type === 'string' ? `--${name} <${flag.value ?? 'value'}>` : `--${name}`

/**
 * The flag that may stand in for one of a command's arguments, as usage shows it, or
 * undefined for a command with no such pair. A pair that names an argument or a string flag
 * the command does not have is refused here, where parsing and usage both ask, so a
 * misspelt pair cannot fall back to requiring the argument in silence.
 */
function alternativeOf(
  spec: CommandSpec,
): { readonly positional: string; readonly flag: string; readonly shown: string } | undefined {
  const pair = spec.alternative
  if (pair === undefined) return undefined
  const flag = spec.flags[pair.flag]
  if (!spec.positionals.includes(pair.positional) || flag?.type !== 'string') {
    throw new Error(
      `${spec.verb}: its alternative must name one of its arguments and one of its string flags`,
    )
  }
  return { ...pair, shown: shownFlag(pair.flag, flag) }
}

export function usage(spec: CommandSpec): string {
  const instead = alternativeOf(spec)
  const parts: string[] = [spec.verb]
  for (const name of spec.positionals) {
    parts.push(instead?.positional === name ? `(<${name}> | ${instead.shown})` : `<${name}>`)
  }
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (name === instead?.flag) continue
    parts.push(flag.required === true ? shownFlag(name, flag) : `[${shownFlag(name, flag)}]`)
  }
  return parts.join(' ')
}

/** A command line the table does not accept. Nothing was opened. */
export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export interface Invocation {
  readonly spec: CommandSpec
  readonly args: Readonly<Record<string, string>>
  readonly strings: Readonly<Record<string, string>>
  readonly booleans: Readonly<Record<string, boolean>>
}

function isVerb(word: string | undefined): word is Verb {
  return word !== undefined && (VERBS as readonly string[]).includes(word)
}

export function parseInvocation(argv: readonly string[]): Invocation {
  const [word, ...rest] = argv
  if (!isVerb(word)) {
    throw new UsageError(
      word === undefined
        ? `name a command: ${VERBS.join(', ')}`
        : `no command is named ${word}; the commands are ${VERBS.join(', ')}`,
    )
  }
  const spec = COMMANDS[word]
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...rest],
      options: Object.fromEntries(
        Object.entries(spec.flags).map(([name, flag]) => [name, { type: flag.type }]),
      ),
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)}\nusage: ${usage(spec)}`,
    )
  }
  // An argument a flag stands in for is not taken when the flag is given.
  const instead = alternativeOf(spec)
  const byFlag = instead !== undefined && typeof parsed.values[instead.flag] === 'string'
  const taken = spec.positionals.filter((name) => !(byFlag && name === instead?.positional))
  if (parsed.positionals.length !== taken.length) {
    throw new UsageError(
      instead === undefined
        ? `${word} takes ${spec.positionals.length} argument(s), got ${parsed.positionals.length}\nusage: ${usage(spec)}`
        : `${word} takes <${instead.positional}> or --${instead.flag}, one of them and not both\nusage: ${usage(spec)}`,
    )
  }
  const args = Object.fromEntries(
    taken.map((name, index) => [name, parsed.positionals[index] ?? '']),
  )
  const strings: Record<string, string> = {}
  const booleans: Record<string, boolean> = {}
  for (const [name, flag] of Object.entries(spec.flags)) {
    const value = parsed.values[name]
    if (flag.type === 'string') {
      if (typeof value === 'string') strings[name] = value
      else if (flag.required === true) {
        const hint = flag.missing === undefined ? '' : `. ${flag.missing}`
        throw new UsageError(`${word} requires --${name}${hint}\nusage: ${usage(spec)}`)
      }
    } else {
      booleans[name] = value === true
    }
  }
  return { spec, args, strings, booleans }
}
