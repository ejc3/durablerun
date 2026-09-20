import { IDENTIFIER_CHARACTERS } from './contract.js'
import { InvalidDurableStringError } from './errors.js'
import { type FencedBatch, type FencedResult, prepareRead, readRows } from './fenced-batch.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlRow } from './primitives.js'
import type { SqlFragment } from './sql-tree.js'
import { rollbackTriesRead } from './statements/reads.js'
import type { CheckpointWrite, FailedRollback, RollbackOutcome } from './types.js'
import {
  fitsCharacters,
  parseTaskValueJson,
  requireIdentifiersFit,
  serializeTaskValue,
} from './validate.js'

const {
  NumberIsSafeInteger: isSafeInteger,
  RangeError: TrustedRangeError,
  StringFrom: stringFrom,
  TypeError: TrustedTypeError,
  StringStartsWith: startsWith,
} = TASK_INTRINSICS

/*
 * A saga's durable state is checkpoints under reserved names (DESIGN.md §3.10,
 * specs/Sagas.tla). A user step name cannot begin with '$' (`UserName.parse`), so no
 * task can write one through `ctx.step`.
 *
 * - `$started:<step>` is a registered step's START marker, committed before its body
 *   runs. Its state is the step's ordering index.
 * - `$rolling-back` is the phase marker, written in the batch that decides the task's
 *   terminal failure. Its state is that failure, which every rollback handler is handed.
 *   The SDK ends the task with it. A cap or a cancellation that ends the task inside the
 *   phase records its own reason.
 * - `$rollback:<step>` is a rollback that ran, an ordinary memoized step.
 * - `$rollback-tries:<step>` records a rollback's failed attempts, written in the batch
 *   that fails the pass, so a failed attempt is counted or the pass did not fail. The
 *   store names it and counts it (`failedRollbackRecord`), and no caller hands it over.
 */
/**
 * What the saga phase requires of a statement it can freeze: a predicate, or `'open'`
 * when it requires nothing, which adds no SQL. Every such statement takes one and none
 * defaults it, so a store does not compile until it has said, for each, what the phase
 * requires there.
 */
export type SagaPhasePredicate = SqlFragment | 'open'

export const SAGA_PHASE_CHECKPOINT = '$rolling-back'
export const SAGA_STARTED_PREFIX = '$started:'
export const SAGA_ROLLBACK_PREFIX = '$rollback:'
export const SAGA_TRIES_PREFIX = '$rollback-tries:'

/**
 * The first name past every name under a reserved prefix, where names compare by their
 * bytes. A reserved prefix ends in a colon, and the character after a colon is a
 * semicolon, so the names under `$started:` are exactly the names from `$started:` up to,
 * and not including, `$started;`. A store whose checkpoint names compare by their bytes
 * reads the names under a prefix as that range of the checkpoints key. A store whose
 * names order under a collation must not (DESIGN.md §3.4).
 */
export function firstNamePast(prefix: `${string}:`): string {
  const last = prefix.length - 1
  if (prefix[last] !== ':') {
    throw new TrustedRangeError(`'${prefix}' is no reserved prefix: it does not end in a colon`)
  }
  return `${prefix.slice(0, last)};`
}

/**
 * The characters a registered step's key may have: the width of an identifier less the
 * longest name a saga builds from it, `$rollback-tries:` and the key, which leaves 239.
 */
export const SAGA_STEP_KEY_CHARACTERS =
  IDENTIFIER_CHARACTERS -
  Math.max(SAGA_STARTED_PREFIX.length, SAGA_ROLLBACK_PREFIX.length, SAGA_TRIES_PREFIX.length)

/**
 * Refuse to start a step whose key leaves no room for its other saga names. A step's way
 * in is its start marker, `$started:` and the key, which is the shortest of its saga
 * names. Held only to the width, a key of 240 to 246 characters would start, and the
 * batch that fails its rollback could never store the attempt record under
 * `$rollback-tries:` and the same key. So the start marker is held to the key the longest
 * name allows, at each entry that carries a checkpoint name, and the refusal names what
 * the caller passed. A step's other saga names are not held to the key: a step that
 * started under this rule has room for them, and one that started before it, on a
 * dialect that stored a longer key, must still be able to record that its rollback ran.
 * Those names are held to the plain width, like any checkpoint name.
 */
export function requireSagaStepFits(what: string, name: unknown): void {
  if (typeof name !== 'string' || !startsWith(name, SAGA_STARTED_PREFIX)) return
  // The prefix is ASCII, so the key fits when the whole name fits the key and its prefix.
  if (!fitsCharacters(name, SAGA_STARTED_PREFIX.length + SAGA_STEP_KEY_CHARACTERS)) {
    throw new InvalidDurableStringError(
      `${what} starts a saga step whose key is longer than ${SAGA_STEP_KEY_CHARACTERS} characters: a durable identifier holds ${IDENTIFIER_CHARACTERS}, and '${SAGA_TRIES_PREFIX}' and the key must fit`,
    )
  }
}

/** One failed attempt of a rollback, as `$rollback-tries:<step>` holds it. */
export interface RollbackTry {
  /** The rollback's failed attempts so far, this one included. */
  tries: number
  /** The failure of this attempt. */
  errorJson: string
}

export function encodeRollbackTry(record: RollbackTry): string {
  return serializeTaskValue('rollback attempt record', {
    tries: record.tries,
    errorJson: record.errorJson,
  })
}

/** Read an attempt record, or null when the text is not one. */
export function decodeRollbackTry(stateJson: string): RollbackTry | null {
  let value: unknown
  try {
    value = parseTaskValueJson(stateJson)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { tries, errorJson } = value as { tries?: unknown; errorJson?: unknown }
  if (typeof tries !== 'number' || !isSafeInteger(tries) || tries < 1) return null
  if (typeof errorJson !== 'string') return null
  return { tries, errorJson }
}

/** The name a rollback's attempt record is stored under. No store and no worker spells it. */
export const rollbackTriesName = (stepKey: string): string => `${SAGA_TRIES_PREFIX}${stepKey}`

/**
 * What `failRollback` was handed, held to its shape where it crosses the port, and read
 * once. A caller of an older build hands over the attempt record itself, as
 * `{ key, stateJson }`. It is refused here, before anything is read or sent, and told what
 * the port takes. The step is held to the room the attempt record's
 * name leaves, here where the name is derived, as core holds a child's key it derives.
 */
export function requireFailedRollback(value: unknown): FailedRollback {
  const { stepKey, errorJson } = (typeof value === 'object' && value !== null ? value : {}) as {
    stepKey?: unknown
    errorJson?: unknown
  }
  if (typeof stepKey !== 'string' || typeof errorJson !== 'string') {
    throw new TrustedTypeError(
      'failRollback takes the failed rollback as { stepKey, errorJson }: the step whose rollback failed, and the failure of that attempt. The store names the attempt record and counts the attempt itself, so a record handed over as { key, stateJson } is refused',
    )
  }
  // The width is held to the name as it will be stored, and the refusal names what the
  // caller passed, which is the step.
  requireIdentifiersFit({
    "rollback.stepKey, as the attempt record's name, which also holds its reserved prefix,":
      rollbackTriesName(stepKey),
  })
  return { stepKey, errorJson }
}

/**
 * The attempt record a failed rollback commits: its name, and its state one attempt past
 * the last one stored (specs/Sagas.tla's RollbackRetry and TriesOnlyGrow). `lastStateJson`
 * is what is stored under that name, or null when nothing is. A record that cannot be read
 * counts as none, as it does for the SDK, which halts the saga on one and writes over it.
 * The count stops at the largest safe integer. One past it is no count `decodeRollbackTry`
 * reads, so the record would read as none, and the attempt after it would be stored as the
 * first. It is never refused there: a failed rollback that could not record its failure
 * would fail again for ever, and a count at the bound still says the budget is spent.
 */
export function nextRollbackTry(
  failed: FailedRollback,
  lastStateJson: string | null,
): CheckpointWrite {
  const last = lastStateJson === null ? null : decodeRollbackTry(lastStateJson)
  // One past the last count, and never past the largest safe integer.
  let tries = (last?.tries ?? 0) + 1
  if (last !== null && !isSafeInteger(tries)) tries = last.tries
  return {
    key: rollbackTriesName(failed.stepKey),
    stateJson: encodeRollbackTry({ tries, errorJson: failed.errorJson }),
  }
}

/** What a dialect supplies to the read of a rollback's last attempt record. */
export interface RollbackTriesDialect {
  /** `rollback-tries`, a batch of one read. */
  open(): FencedBatch
  /** Run a batch this dialect opened against its executor. */
  run(batch: FencedBatch): Promise<FencedResult>
}

const ROLLBACK_TRIES = prepareRead(
  { taskId: 'string', name: 'string' },
  (binds: { taskId: string; name: string }) => rollbackTriesRead(binds),
)

/**
 * The attempt record `fail-rollback` commits for a failed rollback of `taskId`, named and
 * counted here for every dialect. The last record is read before the batch, and the count
 * cannot go stale in between: only `fail-rollback` writes an attempt record, it wins only
 * while its caller's run is running under its claim, and a live task has one live run. So
 * nothing can write that record between this read and a batch that wins, and a copy or a
 * replay of the same call reads a count that is stale and loses the compare-and-set
 * (DESIGN.md §3.10).
 */
export async function failedRollbackRecord(
  dialect: RollbackTriesDialect,
  taskId: string,
  failed: FailedRollback,
): Promise<CheckpointWrite> {
  const b = dialect.open()
  b.readPrepared('record', ROLLBACK_TRIES, { taskId, name: rollbackTriesName(failed.stepKey) })
  const state = readRows(b, await dialect.run(b), 'record')[0]?.state
  return nextRollbackTry(failed, typeof state === 'string' ? state : null)
}

/**
 * A terminal task's rollback outcome, from a row that selected the store's
 * `rollback_outcome` and `rollback_error` columns, or undefined when no saga began. `rollback_error` is the
 * attempt record of the rollback that halted the saga, when one did. The outcome is derived
 * from the saga's checkpoints when it is read and is stored nowhere, so it cannot
 * disagree with them: `failed` exactly when a step that started is left uncompensated.
 */
export function decodeRollbackOutcome(taskId: string, row: SqlRow): RollbackOutcome | undefined {
  const outcome = row.rollback_outcome
  if (outcome === null || outcome === undefined) return undefined
  if (outcome !== 'complete' && outcome !== 'failed') {
    throw new TrustedRangeError(
      `task ${taskId} has unknown rollback outcome ${stringFrom(outcome)}`,
    )
  }
  const record = row.rollback_error
  if (outcome === 'complete' || record === null || record === undefined) return { outcome }
  const halted = decodeRollbackTry(stringFrom(record))
  return halted === null ? { outcome } : { outcome, errorJson: halted.errorJson }
}
