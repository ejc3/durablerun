/**
 * Numeric port-boundary validation (DESIGN.md §3.4 numeric contract).
 *
 * SQL drivers bind JS numbers as REAL and INTEGER columns are affinity, not
 * enforcement: an unchecked `Infinity` becomes an unexpirable lease, an
 * unsafe integer poisons later reads (libsql throws RangeError), and a
 * fractional product breaks the integer epoch-ms contract. The rule that
 * falls out: client-supplied durations and epochs cross the port ONLY
 * through these validators, and SQL never multiplies a client number —
 * milliseconds are computed (and rounded) here.
 */

import { INFRA_RETRY_CAP, RELAUNCH_CAP } from './contract.js'
import { FatalTaskError } from './errors.js'
import { TASK_INTRINSICS } from './intrinsics.js'

const {
  ArrayIsArray: isArray,
  BigIntFrom: toBigInt,
  DateGetTime: dateGetTime,
  DateToISOString: dateToISOString,
  JSONParse: parseJson,
  JSONStringify: stringifyJson,
  MathRound: round,
  NumberFrom: toNumber,
  NumberIsFinite: isFiniteNumber,
  NumberIsSafeInteger: isSafeInteger,
  ObjectCreate: createObject,
  ObjectDefineProperty: defineProperty,
  ObjectFreeze: freeze,
  ObjectGetPrototypeOf: getPrototypeOf,
  ObjectKeys: objectKeys,
  ObjectPrototype: objectPrototype,
  RangeError: TrustedRangeError,
  ReflectGet: reflectGet,
  RegExpExec: regexpExec,
  StringFrom: stringFrom,
  StringIncludes: stringIncludes,
  StringStartsWith: stringStartsWith,
  TypeError: TrustedTypeError,
  WeakSet: TrustedWeakSet,
  WeakSetAdd: weakSetAdd,
  WeakSetDelete: weakSetDelete,
  WeakSetHas: weakSetHas,
} = TASK_INTRINSICS

/** 9999-12-31T23:59:59Z — no legitimate engine timestamp lies beyond it. */
export const MAX_EPOCH_MS = 253_402_300_799_000

/** 100 years — no legitimate relative duration is longer. */
export const MAX_DURATION_MS = 3_155_760_000_000

/**
 * A relative duration in seconds → integer milliseconds. Fractional seconds
 * are legal (rounded to the nearest ms); non-finite, negative, or >100y are
 * not. `positive` additionally requires at least 1ms (leases, extensions).
 */
export function durationToMs(
  name: string,
  seconds: number,
  opts: { positive?: boolean } = {},
): number {
  if (typeof seconds !== 'number' || !isFiniteNumber(seconds) || seconds < 0) {
    throw new TrustedRangeError(
      `${name} must be a finite non-negative number of seconds, got ${seconds}`,
    )
  }
  const ms = round(seconds * 1000)
  if (ms > MAX_DURATION_MS) {
    throw new TrustedRangeError(`${name} exceeds the 100-year duration bound: ${seconds}s`)
  }
  if (opts.positive && ms < 1) {
    throw new TrustedRangeError(`${name} must be at least 1ms, got ${seconds}s`)
  }
  return ms
}

/** An absolute epoch-ms instant (ctx.sleepUntil — the one sanctioned user absolute). */
export function requireEpochMs(name: string, epochMs: number): number {
  if (!isSafeInteger(epochMs) || epochMs < 0 || epochMs > MAX_EPOCH_MS) {
    throw new TrustedRangeError(
      `${name} must be an integer epoch-ms in [0, ${MAX_EPOCH_MS}], got ${epochMs}`,
    )
  }
  return epochMs
}

/**
 * A million. Every count that crosses this port ends up bounding a run
 * ordinal, and the ordinal counts EVERY successor — so an accepted
 * MAX_SAFE_INTEGER lets a successor be written at an ordinal SQLite stores
 * happily and JavaScript cannot represent. Every later claim decoding that
 * run then throws, and the task sits pending forever with no worker able to
 * take it. No real workload needs more, and the bound leaves the ordinal
 * ten orders of magnitude clear of the representable range.
 */
export const MAX_COUNT = 1_000_000

/**
 * A run ordinal counts user attempts and infrastructure successors. At the
 * legal edge, MAX_COUNT user attempts can coexist with every infra successor,
 * so the exact representable protocol ceiling is their sum.
 */
export const MAX_RUN_ORDINAL = MAX_COUNT + INFRA_RETRY_CAP

/** Counts: maxAttempts, claim limits. */
export function requirePositiveInt(name: string, value: number, min = 1): number {
  if (!isSafeInteger(value) || value < min || value > MAX_COUNT) {
    throw new TrustedRangeError(
      `${name} must be an integer in [${min}, ${MAX_COUNT}], got ${value}`,
    )
  }
  return value
}

export interface IntegerBounds {
  readonly min: number
  readonly max: number
}

/**
 * A numeric interval owned by one durable field or one explicitly derived
 * domain. Equal endpoints do not make two domains interchangeable. The
 * descriptor is a class with a private identity member so object spread
 * cannot preserve its nominal type and replace the canonical endpoints.
 */
class IntegerBoundsDescriptor<Domain extends string> implements IntegerBounds {
  readonly min: number
  readonly max: number
  private readonly canonicalDomain: Domain

  public constructor(domain: Domain, min: number, max: number) {
    this.canonicalDomain = domain
    this.min = min
    this.max = max
  }

  // The durable field identity is deliberately a prototype getter backed by
  // private state. Object spread therefore copies endpoints but cannot copy
  // either the field or the nominal identity.
  get field(): Domain {
    return this.canonicalDomain
  }
}

export type BrandedIntegerBounds<Domain extends string> = IntegerBoundsDescriptor<Domain>

const integerBounds = <const Domain extends string>(
  domain: Domain,
  min: number,
  max: number,
): BrandedIntegerBounds<Domain> => {
  const bounds = new IntegerBoundsDescriptor(domain, min, max)
  freeze(bounds)
  return bounds
}

/**
 * Narrow one domain without borrowing another field's coincidentally equal
 * interval. Used for post-transition refinements such as positive claim_gen.
 */
function refineIntegerBounds<const Domain extends string>(
  bounds: BrandedIntegerBounds<Domain>,
  refinement: { readonly min?: number; readonly max?: number },
): BrandedIntegerBounds<Domain> {
  const min = refinement.min ?? bounds.min
  const max = refinement.max ?? bounds.max
  if (
    !isSafeInteger(min) ||
    !isSafeInteger(max) ||
    min < bounds.min ||
    max > bounds.max ||
    min > max
  ) {
    throw new TrustedRangeError(
      `integer refinement must stay inside [${bounds.min}, ${bounds.max}], got [${min}, ${max}]`,
    )
  }
  return integerBounds(bounds.field, min, max)
}

/**
 * Semantic bounds for every persisted integer field audited by the engine and
 * invariant library.
 *
 * This is deliberately field-keyed instead of a menu of generic "count" or
 * "duration" bounds. A caller cannot accidentally validate infra_retries
 * against MAX_COUNT, treat a nullable positive lease as a zero-based duration,
 * or decode checkpoint ownership as a user-attempt count.
 */
export const PERSISTED_INTEGER_BOUNDS = freeze({
  tasks: freeze({
    attempts: integerBounds('tasks.attempts', 0, MAX_COUNT),
    max_attempts: integerBounds('tasks.max_attempts', 1, MAX_COUNT),
    infra_retries: integerBounds('tasks.infra_retries', 0, INFRA_RETRY_CAP),
    enqueue_at_ms: integerBounds('tasks.enqueue_at_ms', 0, MAX_EPOCH_MS),
    first_started_at_ms: integerBounds('tasks.first_started_at_ms', 0, MAX_EPOCH_MS),
    cancel_at_ms: integerBounds('tasks.cancel_at_ms', 0, MAX_EPOCH_MS),
    cancelled_at_ms: integerBounds('tasks.cancelled_at_ms', 0, MAX_EPOCH_MS),
    created_at_ms: integerBounds('tasks.created_at_ms', 0, MAX_EPOCH_MS),
    fence_at_ms: integerBounds('tasks.fence_at_ms', 0, MAX_EPOCH_MS),
  }),
  runs: freeze({
    attempt: integerBounds('runs.attempt', 1, MAX_RUN_ORDINAL),
    claim_gen: integerBounds('runs.claim_gen', 0, MAX_COUNT),
    activated_gen: integerBounds('runs.activated_gen', 0, MAX_COUNT),
    relaunch_count: integerBounds('runs.relaunch_count', 0, RELAUNCH_CAP),
    lease_ms: integerBounds('runs.lease_ms', 1, MAX_DURATION_MS),
    available_at_ms: integerBounds('runs.available_at_ms', 0, MAX_EPOCH_MS),
    claim_expires_at_ms: integerBounds('runs.claim_expires_at_ms', 0, MAX_EPOCH_MS),
    heartbeat_at_ms: integerBounds('runs.heartbeat_at_ms', 0, MAX_EPOCH_MS),
    started_at_ms: integerBounds('runs.started_at_ms', 0, MAX_EPOCH_MS),
    completed_at_ms: integerBounds('runs.completed_at_ms', 0, MAX_EPOCH_MS),
    failed_at_ms: integerBounds('runs.failed_at_ms', 0, MAX_EPOCH_MS),
    created_at_ms: integerBounds('runs.created_at_ms', 0, MAX_EPOCH_MS),
    fence_at_ms: integerBounds('runs.fence_at_ms', 0, MAX_EPOCH_MS),
  }),
  checkpoints: freeze({
    owner_attempt: integerBounds('checkpoints.owner_attempt', 1, MAX_RUN_ORDINAL),
    updated_at_ms: integerBounds('checkpoints.updated_at_ms', 0, MAX_EPOCH_MS),
  }),
  events: freeze({
    emitted_at_ms: integerBounds('events.emitted_at_ms', 0, MAX_EPOCH_MS),
    fence_at_ms: integerBounds('events.fence_at_ms', 0, MAX_EPOCH_MS),
  }),
  waits: freeze({
    timeout_at_ms: integerBounds('waits.timeout_at_ms', 0, MAX_EPOCH_MS),
    created_at_ms: integerBounds('waits.created_at_ms', 0, MAX_EPOCH_MS),
    fence_at_ms: integerBounds('waits.fence_at_ms', 0, MAX_EPOCH_MS),
  }),
  drivers: freeze({
    last_beat_ms: integerBounds('drivers.last_beat_ms', 0, MAX_EPOCH_MS),
    expires_at_ms: integerBounds('drivers.expires_at_ms', 0, MAX_EPOCH_MS),
  }),
})

type NestedValues<T> = T extends unknown ? T[keyof T] : never
export type PersistedIntegerBounds = NestedValues<NestedValues<typeof PERSISTED_INTEGER_BOUNDS>>
export type PersistedIntegerBoundsExceptClaimGeneration = Exclude<
  PersistedIntegerBounds,
  typeof PERSISTED_INTEGER_BOUNDS.runs.claim_gen
>
export const POSITIVE_CLAIM_GENERATION_BOUNDS = refineIntegerBounds(
  PERSISTED_INTEGER_BOUNDS.runs.claim_gen,
  { min: 1 },
)

type PersistedCounterFieldContract =
  | Readonly<{
      id: 'task-attempts'
      table: 'tasks'
      column: 'attempts'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.tasks.attempts
    }>
  | Readonly<{
      id: 'task-max-attempts'
      table: 'tasks'
      column: 'max_attempts'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.tasks.max_attempts
    }>
  | Readonly<{
      id: 'task-infra-retries'
      table: 'tasks'
      column: 'infra_retries'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.tasks.infra_retries
    }>
  | Readonly<{
      id: 'run-attempt'
      table: 'runs'
      column: 'attempt'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.runs.attempt
    }>
  | Readonly<{
      id: 'run-claim-gen'
      table: 'runs'
      column: 'claim_gen'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.runs.claim_gen
    }>
  | Readonly<{
      id: 'run-activated-gen'
      table: 'runs'
      column: 'activated_gen'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.runs.activated_gen
    }>
  | Readonly<{
      id: 'run-relaunch-count'
      table: 'runs'
      column: 'relaunch_count'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.runs.relaunch_count
    }>
  | Readonly<{
      id: 'checkpoint-owner-attempt'
      table: 'checkpoints'
      column: 'owner_attempt'
      bounds: typeof PERSISTED_INTEGER_BOUNDS.checkpoints.owner_attempt
    }>

type PersistedCounterFieldFor<Id extends PersistedCounterFieldContract['id']> = Extract<
  PersistedCounterFieldContract,
  { readonly id: Id }
>

/**
 * The keyed persisted-counter construction surface.
 */
export type PersistedCounterFieldRecord = Readonly<{
  'task-attempts': PersistedCounterFieldFor<'task-attempts'>
  'task-max-attempts': PersistedCounterFieldFor<'task-max-attempts'>
  'task-infra-retries': PersistedCounterFieldFor<'task-infra-retries'>
  'run-attempt': PersistedCounterFieldFor<'run-attempt'>
  'run-claim-gen': PersistedCounterFieldFor<'run-claim-gen'>
  'run-activated-gen': PersistedCounterFieldFor<'run-activated-gen'>
  'run-relaunch-count': PersistedCounterFieldFor<'run-relaunch-count'>
  'checkpoint-owner-attempt': PersistedCounterFieldFor<'checkpoint-owner-attempt'>
}>

/**
 * The complete persisted-counter inventory.
 *
 * Each descriptor binds its public condition/witness ID to one exact durable
 * column and that column's nominal bounds. Generated witness, severity, and
 * inventory surfaces iterate the mechanically derived array instead of
 * maintaining table-specific copies.
 */
const PERSISTED_COUNTER_FIELDS_BY_ID = freeze({
  'task-attempts': freeze({
    id: 'task-attempts',
    table: 'tasks',
    column: 'attempts',
    bounds: PERSISTED_INTEGER_BOUNDS.tasks.attempts,
  }),
  'task-max-attempts': freeze({
    id: 'task-max-attempts',
    table: 'tasks',
    column: 'max_attempts',
    bounds: PERSISTED_INTEGER_BOUNDS.tasks.max_attempts,
  }),
  'task-infra-retries': freeze({
    id: 'task-infra-retries',
    table: 'tasks',
    column: 'infra_retries',
    bounds: PERSISTED_INTEGER_BOUNDS.tasks.infra_retries,
  }),
  'run-attempt': freeze({
    id: 'run-attempt',
    table: 'runs',
    column: 'attempt',
    bounds: PERSISTED_INTEGER_BOUNDS.runs.attempt,
  }),
  'run-claim-gen': freeze({
    id: 'run-claim-gen',
    table: 'runs',
    column: 'claim_gen',
    bounds: PERSISTED_INTEGER_BOUNDS.runs.claim_gen,
  }),
  'run-activated-gen': freeze({
    id: 'run-activated-gen',
    table: 'runs',
    column: 'activated_gen',
    bounds: PERSISTED_INTEGER_BOUNDS.runs.activated_gen,
  }),
  'run-relaunch-count': freeze({
    id: 'run-relaunch-count',
    table: 'runs',
    column: 'relaunch_count',
    bounds: PERSISTED_INTEGER_BOUNDS.runs.relaunch_count,
  }),
  'checkpoint-owner-attempt': freeze({
    id: 'checkpoint-owner-attempt',
    table: 'checkpoints',
    column: 'owner_attempt',
    bounds: PERSISTED_INTEGER_BOUNDS.checkpoints.owner_attempt,
  }),
} as const satisfies PersistedCounterFieldRecord)

function frozenCounterFieldValues(
  fields: typeof PERSISTED_COUNTER_FIELDS_BY_ID,
): readonly PersistedCounterFieldContract[] {
  const values: PersistedCounterFieldContract[] = []
  for (const id of objectKeys(fields) as (keyof typeof PERSISTED_COUNTER_FIELDS_BY_ID)[]) {
    values[values.length] = fields[id]
  }
  return freeze(values)
}

export const PERSISTED_COUNTER_FIELDS = frozenCounterFieldValues(PERSISTED_COUNTER_FIELDS_BY_ID)

export type PersistedCounterFieldDescriptor = PersistedCounterFieldContract
export type PersistedCounterFieldId = PersistedCounterFieldDescriptor['id']

type PersistedIntegerTable = keyof typeof PERSISTED_INTEGER_BOUNDS
type PersistedIntegerColumn<Table extends PersistedIntegerTable> =
  keyof (typeof PERSISTED_INTEGER_BOUNDS)[Table] & string

/**
 * Mint one temporal descriptor only when its table, column and nominal
 * descriptor all name the same durable field. Coincidentally equal endpoints
 * cannot satisfy this boundary for a different column.
 */
function persistedTemporalField<
  const Table extends PersistedIntegerTable,
  const Column extends PersistedIntegerColumn<Table>,
  const Kind extends 'epoch-ms' | 'duration-ms',
  const Nullable extends boolean,
>(
  table: Table,
  column: Column,
  bounds: (typeof PERSISTED_INTEGER_BOUNDS)[Table][Column] &
    BrandedIntegerBounds<`${Table}.${Column}`>,
  kind: Kind,
  nullable: Nullable,
) {
  return freeze({ id: bounds.field, table, column, bounds, kind, nullable })
}

/**
 * The complete persisted temporal inventory: 23 fields across all six
 * scheduler tables. It is the single generation source for invariant
 * conditions, portable snapshots, corruption witnesses and schema enrollment.
 *
 * `kind` distinguishes absolute database instants from relative durations;
 * `nullable` records the migrated schema contract rather than whichever
 * lifecycle state happens to populate a field.
 */
export const PERSISTED_TEMPORAL_FIELDS = freeze([
  persistedTemporalField(
    'tasks',
    'enqueue_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.enqueue_at_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'tasks',
    'first_started_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.first_started_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'tasks',
    'cancel_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.cancel_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'tasks',
    'cancelled_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.cancelled_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'tasks',
    'created_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.created_at_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'tasks',
    'fence_at_ms',
    PERSISTED_INTEGER_BOUNDS.tasks.fence_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'lease_ms',
    PERSISTED_INTEGER_BOUNDS.runs.lease_ms,
    'duration-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'claim_expires_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.claim_expires_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'heartbeat_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.heartbeat_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'available_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.available_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'started_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.started_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'completed_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.completed_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'failed_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.failed_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'runs',
    'created_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.created_at_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'runs',
    'fence_at_ms',
    PERSISTED_INTEGER_BOUNDS.runs.fence_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'checkpoints',
    'updated_at_ms',
    PERSISTED_INTEGER_BOUNDS.checkpoints.updated_at_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'events',
    'emitted_at_ms',
    PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'events',
    'fence_at_ms',
    PERSISTED_INTEGER_BOUNDS.events.fence_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'waits',
    'timeout_at_ms',
    PERSISTED_INTEGER_BOUNDS.waits.timeout_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'waits',
    'created_at_ms',
    PERSISTED_INTEGER_BOUNDS.waits.created_at_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'waits',
    'fence_at_ms',
    PERSISTED_INTEGER_BOUNDS.waits.fence_at_ms,
    'epoch-ms',
    true,
  ),
  persistedTemporalField(
    'drivers',
    'last_beat_ms',
    PERSISTED_INTEGER_BOUNDS.drivers.last_beat_ms,
    'epoch-ms',
    false,
  ),
  persistedTemporalField(
    'drivers',
    'expires_at_ms',
    PERSISTED_INTEGER_BOUNDS.drivers.expires_at_ms,
    'epoch-ms',
    false,
  ),
] as const)

export type PersistedTemporalFieldDescriptor = (typeof PERSISTED_TEMPORAL_FIELDS)[number]
export type PersistedTemporalFieldId = PersistedTemporalFieldDescriptor['id']
export type PersistedTemporalTable = PersistedTemporalFieldDescriptor['table']

/** Numeric results computed from several persisted sources, never one column. */
export const DERIVED_INTEGER_BOUNDS = freeze({
  epoch_ms: integerBounds('derived.epoch_ms', 0, MAX_EPOCH_MS),
  duration_ms: integerBounds('derived.duration_ms', 0, MAX_DURATION_MS),
})
export type DerivedIntegerBounds =
  (typeof DERIVED_INTEGER_BOUNDS)[keyof typeof DERIVED_INTEGER_BOUNDS]

export type BoundedIntegerDecode =
  | { readonly ok: true; readonly value: number; readonly exact: bigint }
  | {
      readonly ok: false
      readonly reason: 'not-an-exact-integer' | 'out-of-range'
      readonly exact?: bigint
    }

/** A total, non-coercive description for values returned by a SQL dialect. */
export function storageValueKind(value: unknown): string {
  return value === null ? 'null' : typeof value
}

/**
 * Decode one dialect-returned SQL integer without a lossy intermediate.
 *
 * libSQL/SQLite adapters may return INTEGER as number or bigint; the other
 * dialects are allowed the same two representations. Every engine read uses
 * this one decoder before crossing into JavaScript numbers, and the invariant
 * evaluator uses the same result to distinguish storage-class corruption from
 * a semantically out-of-range integer. A future dialect therefore cannot make
 * `Number(9007199254740993n)` silently become a different protocol value.
 */
export function decodeBoundedInteger(value: unknown, bounds: IntegerBounds): BoundedIntegerDecode {
  if (!isSafeInteger(bounds.min) || !isSafeInteger(bounds.max) || bounds.min > bounds.max) {
    throw new TrustedRangeError(
      `integer decoder bounds must be ordered safe integers, got [${bounds.min}, ${bounds.max}]`,
    )
  }
  let exact: bigint
  if (typeof value === 'bigint') {
    exact = value
  } else if (typeof value === 'number' && isSafeInteger(value)) {
    exact = toBigInt(value)
  } else {
    return { ok: false, reason: 'not-an-exact-integer' }
  }
  if (exact < toBigInt(bounds.min) || exact > toBigInt(bounds.max)) {
    return { ok: false, reason: 'out-of-range', exact }
  }
  return { ok: true, value: toNumber(exact), exact }
}

function requireBrandedInteger(
  name: string,
  value: unknown,
  bounds: BrandedIntegerBounds<string>,
): number {
  const decoded = decodeBoundedInteger(value, bounds)
  if (decoded.ok) return decoded.value
  throw new TrustedRangeError(
    `${name} (${bounds.field}) must be an exact SQL integer in [${bounds.min}, ${bounds.max}], got ${storageValueKind(value)} (${decoded.reason})`,
  )
}

/**
 * Client inputs are JavaScript numbers. Bigints are accepted only while
 * decoding dialect-returned INTEGER values; letting a client bigint reach a
 * driver would make coercion behavior part of the protocol.
 */
function requireClientBrandedInteger(
  name: string,
  value: unknown,
  bounds: BrandedIntegerBounds<string>,
): number {
  if (typeof value !== 'number') {
    throw new TrustedRangeError(
      `${name} (${bounds.field}) must be an exact SQL integer in [${bounds.min}, ${bounds.max}], got ${storageValueKind(value)} (not-an-exact-integer)`,
    )
  }
  return requireBrandedInteger(name, value, bounds)
}

/**
 * Decode a SQL result computed from multiple durable values.
 *
 * Only derived-domain descriptors fit this API. Persisted fields must retain
 * their own identity all the way to their field-specific decoder.
 */
export function requireDerivedInteger(
  name: string,
  value: unknown,
  bounds: DerivedIntegerBounds,
): number {
  return requireBrandedInteger(name, value, bounds)
}

/**
 * Validate the run ordinal accepted by a store port.
 *
 * The call site has no bounds menu: the run-attempt domain is closed over
 * here, so an equal-looking checkpoint-owner interval cannot stand in for it.
 */
export function requireRunOrdinal(name: string, value: unknown): number {
  return requireClientBrandedInteger(name, value, PERSISTED_INTEGER_BOUNDS.runs.attempt)
}

/**
 * Validate the claim generation accepted by the activation port.
 *
 * Claim generations are positive receipts. The call site has no bounds menu
 * and no driver-coercion escape hatch.
 */
export function requirePositiveClaimGeneration(name: string, value: unknown): number {
  return requireClientBrandedInteger(name, value, POSITIVE_CLAIM_GENERATION_BOUNDS)
}

/** What a bad value IS, for an error message that saves a debugging session. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (isArray(value)) return 'an array'
  return typeof value
}

function dataProperty(value: unknown, enumerable: boolean): PropertyDescriptor {
  const descriptor = createObject(null) as PropertyDescriptor
  descriptor.configurable = true
  descriptor.enumerable = enumerable
  descriptor.value = value
  descriptor.writable = true
  return descriptor
}

/**
 * The portable durable-string domain. PostgreSQL's JSON parser rejects NUL
 * escapes and unpaired UTF-16 surrogates, while other backends may accept
 * them and later expose a different value. One predicate owns the domain for
 * both JSON keys/values and durable protocol names.
 */
const storageStringRoundTrips = freeze({
  check(raw: string): boolean {
    if (stringIncludes(raw, '\u0000') || regexpExec(/\p{Surrogate}/u, raw) !== null) {
      return false
    }
    return true
  },
}).check

type TaskValueDomain = 'opaque' | 'headers'

const requireJsonDataObject = freeze({
  check(value: object): void {
    const prototype = getPrototypeOf(value)
    if (prototype !== null && prototype !== objectPrototype) {
      throw new TrustedTypeError('task value must use the JSON data model')
    }
  },
}).check

/**
 * Copy one task value into data owned by the runtime. The copy has no
 * attacker-controlled prototype or toJSON hook, and every source field is
 * read once. This is the representation JSON.stringify receives.
 */
function snapshotTaskValueWithStringDomain(
  value: unknown,
  ancestors: WeakSet<object>,
  domain: TaskValueDomain,
): unknown {
  if (domain === 'headers') {
    if (typeof value !== 'object' || value === null || isArray(value)) {
      throw new TrustedTypeError('task headers must be an object of strings')
    }
    requireJsonDataObject(value)
    const owned = createObject(null) as Record<string, string>
    const keys = objectKeys(value)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (key === undefined) continue
      if (!storageStringRoundTrips(key)) {
        throw new TrustedTypeError('JSON object key does not round-trip through storage')
      }
      const item = reflectGet(value, key)
      if (typeof item !== 'string' || !storageStringRoundTrips(item)) {
        throw new TrustedTypeError('task headers must contain portable strings')
      }
      defineProperty(owned, key, dataProperty(item, true))
    }
    return owned
  }

  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TrustedTypeError(`${typeof value} is not a JSON value`)
  }
  if (typeof value !== 'object' || value === null) return value

  // Brand-check with the captured native operation instead of instanceof.
  // Invalid Dates have JSON's canonical null representation.
  try {
    const epochMs = dateGetTime(value)
    return isFiniteNumber(epochMs) ? dateToISOString(value) : null
  } catch {
    // Not a Date: continue with raw enumerable data.
  }

  if (weakSetHas(ancestors, value)) {
    throw new TrustedTypeError('cyclic task value')
  }
  weakSetAdd(ancestors, value)
  try {
    if (isArray(value)) {
      const owned: unknown[] = []
      // JSON.stringify consults an inherited toJSON before visiting array
      // members. An own undefined value makes the owned array independent of
      // later Array/Object prototype changes.
      defineProperty(owned, 'toJSON', dataProperty(undefined, false))
      const length = reflectGet(value, 'length')
      if (typeof length !== 'number' || !isSafeInteger(length) || length < 0) {
        throw new TrustedTypeError('array length is not a non-negative safe integer')
      }
      for (let index = 0; index < length; index++) {
        const key = stringFrom(index)
        const item = snapshotTaskValueWithStringDomain(reflectGet(value, key), ancestors, domain)
        defineProperty(owned, key, dataProperty(item === undefined ? null : item, true))
      }
      return owned
    }

    requireJsonDataObject(value)
    const owned = createObject(null) as Record<string, unknown>
    const keys = objectKeys(value)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (key === undefined) continue
      const item = snapshotTaskValueWithStringDomain(reflectGet(value, key), ancestors, domain)
      if (item !== undefined) {
        defineProperty(owned, key, dataProperty(item, true))
      }
    }
    return owned
  } finally {
    weakSetDelete(ancestors, value)
  }
}

/**
 * The one durable task-value serializer.
 *
 * Step results, final results, and parsed event payloads all pass through this
 * function. `undefined` has the explicit wire meaning `null`; undefined object
 * fields retain ordinary JSON semantics. Functions, symbols, bigint and
 * cyclic graphs are not JSON values and fail permanently at this boundary
 * instead of becoming ordinary retryable handler errors after side effects
 * have already run.
 */
function serializeTaskValueWithStringDomain(
  what: string,
  value: unknown,
  domain: TaskValueDomain,
): string {
  const root = value === undefined ? null : value
  const snapshotTaskValue = (candidate: unknown, ancestors: WeakSet<object>): unknown =>
    snapshotTaskValueWithStringDomain(candidate, ancestors, domain)
  try {
    const serialized = stringifyJson(snapshotTaskValue(root, new TrustedWeakSet()))
    if (serialized === undefined) {
      throw new TrustedTypeError(`${describe(root)} has no JSON representation`)
    }
    return serialized
  } catch {
    // Never inspect the thrown value here. A user-defined toJSON/getter can
    // throw any object, including a revoked proxy or an object whose own
    // coercion throws; diagnostics must not reopen the permanent-error gate.
    throw new FatalTaskError(`${what} is not a JSON value`)
  }
}

export function serializeTaskValue(what: string, value: unknown): string {
  return serializeTaskValueWithStringDomain(what, value, 'opaque')
}

/**
 * Headers are later inspected by every dialect as JSON object data. Own one
 * string-record snapshot here, including the portable string domain, without
 * narrowing opaque task/result payloads.
 */
export function serializeTaskHeaders(what: 'task headers', value: unknown): string {
  return serializeTaskValueWithStringDomain(what, value, 'headers')
}

/** Parse with the JSON operation captured before task initialization. */
export function parseTaskValueJson(json: string): unknown {
  return parseJson(json)
}

/*
 * User-boundary validators: task-facing inputs (names and knobs a task
 * function passes to its context) cross into the engine ONLY through the
 * forms below. The validator IS the classifier — a deterministic bad input
 * is a permanent task failure (FatalTaskError), never a retryable one, so
 * it can never loop through lease recovery burning attempts. The raw
 * RangeError validators above remain the PORT classification for store
 * callers; packages/sdk/src is lint-banned from importing them.
 */

/**
 * A validated user-supplied name, mintable only through parse — code that
 * builds durable replay keys can demand this type and become structurally
 * unable to accept a raw string (the events round shipped the same
 * reserved-charset bug a second time because the check lived per-method).
 */
export class UserName {
  private declare readonly userNameBrand: undefined

  private constructor(readonly value: string) {}

  /**
   * '#' anywhere collides with DERIVED replay keys (`poll#2`); a '$'
   * prefix collides with the engine's own markers (`$sleep`, `$await:`).
   */
  static parse(what: string, raw: string): UserName {
    // The type says string; the callers include JavaScript, decoded JSON and
    // anything typed `any`. Reaching .includes() on a non-string throws a
    // plain TypeError, which the worker reads as an ordinary user failure and
    // RETRIES — so one deterministic bad call runs maxAttempts times, redoing
    // whatever the handler did before it each time. Deterministic bad input
    // has to be permanent.
    if (typeof raw !== 'string') {
      throw new FatalTaskError(`${what} must be a string, got ${describe(raw)}`)
    }
    if (stringIncludes(raw, '#') || stringStartsWith(raw, '$')) {
      throw new FatalTaskError(
        `${what} '${raw}' uses reserved characters ('#' anywhere, '$' prefix)`,
      )
    }
    // A durable key must survive a round-trip through storage. A NUL
    // truncates a SQLite TEXT value at the first byte, and a lone surrogate
    // (not well-formed UTF-16) is re-encoded to U+FFFD — either way two
    // distinct JS names collide or a name silently changes, and its wake
    // never matches. Reject both at the single mint point.
    if (!storageStringRoundTrips(raw)) {
      throw new FatalTaskError(
        `${what} '${raw}' contains characters that do not round-trip through storage (NUL or a lone surrogate)`,
      )
    }
    return new UserName(raw)
  }
}

/** durationToMs, classified for the task boundary. */
export function userDurationToMs(
  name: string,
  seconds: number,
  opts: { positive?: boolean } = {},
): number {
  try {
    return durationToMs(name, seconds, opts)
  } catch {
    throw new FatalTaskError(`${name} is not a valid task duration`)
  }
}

/**
 * A serialized VALUE crossing the user boundary — the third kind of user
 * input, alongside names and knobs.
 *
 * The boundary only had validators for names and knobs, so a value had
 * nowhere to be checked and went straight to the database driver. That
 * matters because `JSON.stringify` is typed `(value: any) => string` but
 * returns `undefined` for undefined, functions and symbols, so
 * `JSON.stringify(obj.missingProperty)` type-checks and yields undefined.
 * The driver then rejects the bind, the store wraps every driver throw as an
 * outage, and the worker treats an outage as infrastructure — so an ordinary
 * typo consumed the whole infrastructure-retry budget, re-ran the task body
 * on every one of those attempts, and reported exhausted infrastructure with
 * no user-visible reason. Deterministic bad input must never loop through
 * lease recovery.
 *
 * Parse and reserialize, rather than only checking, deliberately gives every
 * value crossing this boundary one wire representation. Otherwise equivalent
 * spellings such as `{ "a": 1 }` and `{"a":1}` become distinct durable data.
 */
export function userJsonValue(what: string, json: string): string {
  if (typeof json !== 'string') {
    throw new FatalTaskError(
      `${what} is ${describe(json)}, not a JSON string — JSON.stringify returns undefined for undefined, functions and symbols`,
    )
  }
  let parsed: unknown
  try {
    parsed = parseTaskValueJson(json)
  } catch {
    throw new FatalTaskError(`${what} is not valid JSON`)
  }
  return serializeTaskValue(what, parsed)
}

/** requireEpochMs, classified for the task boundary. */
export function userEpochMs(name: string, epochMs: number): number {
  try {
    return requireEpochMs(name, epochMs)
  } catch {
    throw new FatalTaskError(`${name} is not a valid task epoch`)
  }
}
