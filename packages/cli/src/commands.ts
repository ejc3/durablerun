import { parseArgs } from 'node:util'
import type { ExitName } from './exit.js'

/**
 * The one command table. Parsing, usage, `help --json`, the exit codes each command can
 * give, the port calls and batch labels each command can send, and what each does when a
 * fault meets one of those batches are all read from here, so a command cannot be added in
 * one of those places and missed in another.
 */

export const VERBS = ['help', 'doctor', 'migrate', 'result', 'checkpoints'] as const
export type Verb = (typeof VERBS)[number]

export interface FlagSpec {
  readonly type: 'string' | 'boolean'
  readonly required?: true
  /** The placeholder usage prints for a string flag's value. */
  readonly value?: string
  readonly description: string
}

/** One port call a command makes, and every batch label that call can send. */
export interface PortUse {
  readonly call:
    | 'admin.schemaVersion'
    | 'admin.nowEpochMs'
    | 'admin.migrate'
    | 'scheduler.getTaskResult'
    | 'scheduler.getCheckpoints'
  /** A label ending in `*` stands for every label that starts with what comes before it. */
  readonly labels: readonly string[]
}

/**
 * What running a command again does after its answer was lost. `read` prints the state it
 * finds as of that read, and `resumes` carries on from wherever the first run stopped.
 */
export type RepeatSafety = 'no-store' | 'read' | 'resumes'

/**
 * A fault that meets one batch a command sends: the store is unavailable before the batch
 * reaches it, the batch commits and the answer is lost, or the batch is applied twice. The
 * fault matrix's kinds (packages/conformance/src/fault-matrix.ts), as the CLI meets them.
 */
export type CliFault = 'unavailable-before' | 'crash-after' | 'duplicate'
export const CLI_FAULTS: readonly CliFault[] = ['unavailable-before', 'crash-after', 'duplicate']

export interface CommandSpec {
  readonly verb: Verb
  readonly summary: string
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, FlagSpec>>
  readonly opensStore: boolean
  /** Whether the command changes the database, and so needs `--target`. */
  readonly writes: boolean
  readonly repeat: RepeatSafety
  readonly ports: readonly PortUse[]
  /** The exit codes the command gives, by name. Every command can also exit `internal`. */
  readonly exits: readonly ExitName[]
  /** The exit a fault at any batch the command sends ends in, or null for no store. */
  readonly faults: Readonly<Record<CliFault, ExitName>> | null
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

const SCHEMA_VERSION: PortUse = { call: 'admin.schemaVersion', labels: ['migrate:version'] }
const TASK_RESULT: PortUse = { call: 'scheduler.getTaskResult', labels: ['task-result'] }

/** A read ends where it began whatever meets it: an outage exits 6, and a copy changes nothing. */
const READ_FAULTS = {
  'unavailable-before': 'unavailable',
  'crash-after': 'unavailable',
  duplicate: 'done',
} as const satisfies Record<CliFault, ExitName>

const STORE_EXITS = ['done', 'usage', 'schema', 'unavailable', 'permanent'] as const

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
      target: {
        type: 'string',
        required: true,
        value: 'T',
        description: "the store URL's host, or the path of a file: URL, named again",
      },
    },
    opensStore: true,
    writes: true,
    repeat: 'resumes',
    ports: [
      SCHEMA_VERSION,
      { call: 'admin.migrate', labels: ['migrate:version', 'migrate:bootstrap', 'migrate:v*'] },
    ],
    exits: STORE_EXITS,
    faults: {
      'unavailable-before': 'unavailable',
      'crash-after': 'unavailable',
      duplicate: 'done',
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
    exits: [...STORE_EXITS, 'refused', 'not-found'],
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
    ports: [
      SCHEMA_VERSION,
      TASK_RESULT,
      { call: 'scheduler.getCheckpoints', labels: ['get-checkpoints'] },
    ],
    exits: [...STORE_EXITS, 'refused', 'not-found'],
    faults: READ_FAULTS,
  },
} satisfies Record<Verb, CommandSpec>)

/** Whether a batch label is one the command declares. */
export function declaresLabel(spec: CommandSpec, label: string): boolean {
  return spec.ports.some((port) =>
    port.labels.some((declared) =>
      declared.endsWith('*') ? label.startsWith(declared.slice(0, -1)) : label === declared,
    ),
  )
}

export function usage(spec: CommandSpec): string {
  const parts: string[] = [spec.verb, ...spec.positionals.map((name) => `<${name}>`)]
  for (const [name, flag] of Object.entries(spec.flags)) {
    const shown = flag.type === 'string' ? `--${name} <${flag.value ?? 'value'}>` : `--${name}`
    parts.push(flag.required === true ? shown : `[${shown}]`)
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
  if (parsed.positionals.length !== spec.positionals.length) {
    throw new UsageError(
      `${word} takes ${spec.positionals.length} argument(s), got ${parsed.positionals.length}\nusage: ${usage(spec)}`,
    )
  }
  const args = Object.fromEntries(
    spec.positionals.map((name, index) => [name, parsed.positionals[index] ?? '']),
  )
  const strings: Record<string, string> = {}
  const booleans: Record<string, boolean> = {}
  for (const [name, flag] of Object.entries(spec.flags)) {
    const value = parsed.values[name]
    if (flag.type === 'string') {
      if (typeof value === 'string') strings[name] = value
      else if (flag.required === true) {
        throw new UsageError(`${word} requires --${name}\nusage: ${usage(spec)}`)
      }
    } else {
      booleans[name] = value === true
    }
  }
  return { spec, args, strings, booleans }
}
