import { TASK_INTRINSICS } from './intrinsics.js'
import type { SchedulerStore } from './ports.js'
import { requireDurableString, requireIdentifiersFit } from './validate.js'

const {
  ObjectDefineProperty: defineProperty,
  ObjectFreeze: freeze,
  ObjectGetPrototypeOf: getPrototypeOf,
  ObjectKeys: objectKeys,
  PromiseReject: rejected,
  ReflectApply: apply,
  ReflectGet: reflectGet,
  TypeError: TrustedTypeError,
} = TASK_INTRINSICS

/**
 * Every string a caller passes the port, by the name the caller knows it by, and what the
 * port holds it to before any statement is sent (DESIGN.md §3.4 rule 10).
 *
 * - `identifier`: a string a store indexes. It is held to the durable string domain, the
 *   strings every store keeps exactly as they were passed, and to the width of a durable
 *   identifier.
 * - `durable`: a string a store keeps and does not index, so its length is not bounded.
 *   It is held to the domain alone. A task name is the one such string.
 *
 * A claim token is an identifier. One dialect indexes it whole, and an index row has a
 * size limit, so a token is held to the width the narrowest dialect sets for every
 * indexed string. It is held at every place that takes one, so the table says one thing
 * about a token: `claim` refuses one past the width, so no row holds one, and a longer
 * token at any other entry could match nothing. A token that a store changed would be
 * held by every token that changes to the same string, which is why the domain matters
 * most here.
 * - `payload`: JSON text, or the headers object. Its serializer owns its domain, and this
 *   check leaves it alone. It is named so that the table is whole: a string is left
 *   unheld because someone wrote that down here, never because nobody listed it.
 */
export const PORT_STRING_RULES = freeze({
  queue: 'identifier',
  taskId: 'identifier',
  runId: 'identifier',
  driverId: 'identifier',
  childTaskId: 'identifier',
  idempotencyKey: 'identifier',
  eventName: 'identifier',
  stepName: 'identifier',
  checkpointName: 'identifier',
  'checkpoint.key': 'identifier',
  'rollbackTry.key': 'identifier',
  'childOf.parentQueue': 'identifier',
  'childOf.parentTaskId': 'identifier',
  'childOf.runId': 'identifier',
  'childOf.replayKey': 'identifier',
  claimToken: 'identifier',
  'childOf.claimToken': 'identifier',
  taskName: 'durable',
  paramsJson: 'payload',
  resultJson: 'payload',
  failureJson: 'payload',
  stateJson: 'payload',
  'checkpoint.stateJson': 'payload',
  'rollbackTry.stateJson': 'payload',
  payloadJson: 'payload',
  headers: 'payload',
} as const)

export type PortStringName = keyof typeof PORT_STRING_RULES
export type PortStringRule = (typeof PORT_STRING_RULES)[PortStringName]
export type PortMethod = keyof SchedulerStore

/**
 * Whether a value of this type can carry a string its caller chose. A union of literals
 * is not one: the caller picks among the engine's words, and the entry that reads it
 * refuses any other.
 */
type CarriesStrings<T> = T extends string
  ? string extends T
    ? true
    : false
  : T extends object
    ? string extends keyof T
      ? true
      : { [Key in keyof T]-?: CarriesStrings<NonNullable<T[Key]>> }[keyof T]
    : false

/**
 * What the table has to say about one value of a call: the name of a string, the names
 * of the strings inside an object, or null for a value that carries none.
 */
type Named<T> = true extends CarriesStrings<T>
  ? T extends string
    ? PortStringName
    : T extends object
      ? string extends keyof T
        ? PortStringName
        : {
            readonly [Key in keyof T as true extends CarriesStrings<NonNullable<T[Key]>>
              ? Key
              : never]-?: Named<NonNullable<T[Key]>>
          }
      : never
  : null

type NamedArguments<Arguments extends readonly unknown[]> = {
  readonly [Index in keyof Arguments]-?: Named<NonNullable<Arguments[Index]>>
}

/**
 * The shape the table is held to: every method of the port, and for each one, every
 * argument in order. It is computed from `SchedulerStore`, so a method the port gains, a
 * string argument a method gains, and a string inside an options object each stop the
 * build until the table names them.
 */
export type PortStringsOf<Port> = {
  readonly [Method in keyof Port]: Port[Method] extends (...args: infer Arguments) => unknown
    ? NamedArguments<Arguments>
    : never
}

export type PortStrings = PortStringsOf<SchedulerStore>

/** Where each named string enters the port: for every method, its arguments in order. */
export const PORT_STRINGS = freeze({
  spawn: [
    'queue',
    'taskName',
    'paramsJson',
    {
      idempotencyKey: 'idempotencyKey',
      childOf: {
        parentQueue: 'childOf.parentQueue',
        parentTaskId: 'childOf.parentTaskId',
        runId: 'childOf.runId',
        claimToken: 'childOf.claimToken',
        replayKey: 'childOf.replayKey',
      },
      headers: 'headers',
    },
  ],
  claim: ['queue', 'claimToken', null],
  activate: ['queue', 'runId', 'claimToken', null],
  claimedTaskName: ['queue', 'runId', 'claimToken', null],
  deferLaunch: ['queue', 'runId', 'claimToken', null, null],
  heartbeat: ['queue', 'runId', 'claimToken', null],
  reschedule: ['queue', 'runId', 'claimToken', null],
  complete: ['queue', 'runId', 'claimToken', 'resultJson'],
  suspendRun: [
    'queue',
    'runId',
    'claimToken',
    null,
    { key: 'checkpoint.key', stateJson: 'checkpoint.stateJson' },
  ],
  fail: ['queue', 'runId', 'claimToken', 'failureJson', null],
  failRollback: [
    'queue',
    'runId',
    'claimToken',
    'failureJson',
    null,
    { key: 'rollbackTry.key', stateJson: 'rollbackTry.stateJson' },
  ],
  sweep: ['queue', null],
  expireLeaseNow: ['queue', 'runId', 'claimToken'],
  getCheckpoints: ['queue', 'taskId', null],
  setCheckpoint: ['queue', 'taskId', 'runId', 'claimToken', 'checkpointName', 'stateJson', null],
  emitEvent: ['queue', 'eventName', 'payloadJson'],
  awaitEvent: ['queue', 'taskId', 'runId', 'claimToken', 'stepName', 'eventName', null],
  awaitTaskDone: ['queue', 'taskId', 'runId', 'claimToken', 'stepName', 'childTaskId', null],
  getTaskResult: ['queue', 'taskId'],
  nextWakeAtEpochMs: ['queue'],
  driverHeartbeat: ['queue', 'driverId', null],
  cancelTask: ['queue', 'taskId'],
  retryTask: ['queue', 'taskId'],
} as const satisfies PortStrings)

/** The table as the check walks it, without the port's types. */
type NamedStrings = PortStringName | null | { readonly [property: string]: NamedStrings }

/**
 * Hold one named string to its rule. A value that is not a string is refused with the
 * domain's own refusal, because the domain is of strings.
 */
export function requirePortString(name: PortStringName, raw: unknown): void {
  const rule = PORT_STRING_RULES[name]
  if (rule === 'payload') return
  requireDurableString(name, raw)
  if (rule === 'identifier') requireIdentifiersFit({ [name]: raw })
}

function requireNamed(named: NamedStrings | undefined, value: unknown): void {
  if (named === null || named === undefined) return
  if (typeof named === 'string') {
    requirePortString(named, value)
    return
  }
  // An options object that was left out, or that is not an object, belongs to the entry.
  if (typeof value !== 'object' || value === null) return
  const properties = objectKeys(named)
  for (let index = 0; index < properties.length; index++) {
    const property = properties[index]
    if (property === undefined) continue
    // A member that was left out is not a string the port was passed. The entry that
    // reads the object owns a member it requires.
    const member: unknown = reflectGet(value, property)
    if (member === undefined) continue
    requireNamed(named[property], member)
  }
}

/**
 * The one check of the strings a port call carries: every string the table names is held
 * to its rule, in the order of the arguments, before the entry runs. The refusal is
 * `InvalidDurableStringError`, and it names what the caller passed.
 */
export function requirePortStrings(method: PortMethod, args: readonly unknown[]): void {
  const named: readonly NamedStrings[] = PORT_STRINGS[method]
  for (let index = 0; index < named.length; index++) {
    requireNamed(named[index], args[index])
  }
}

/** Every method the table names, which is every method of the port. */
export const PORT_METHODS: readonly PortMethod[] = freeze(objectKeys(PORT_STRINGS) as PortMethod[])

/**
 * What every dialect's store extends, and the only place the port's strings are checked.
 *
 * The constructor puts `requirePortStrings` in front of every method the table names, as
 * a property of the instance that cannot be assigned. So a dialect's
 * entry holds nothing and cannot forget to: it is reached only through the check. A
 * dialect inherits the check by extending this, and a method the port gains is checked
 * once the table names its strings, which the table's type makes it do.
 *
 * A refusal is a rejected promise, as it was when each entry checked for itself, and a
 * call that passes returns the entry's own promise, so the check adds no turn of the
 * event loop to a call.
 */
export abstract class HeldPort {
  private declare readonly heldPortBrand: undefined

  constructor() {
    for (const method of PORT_METHODS) {
      const entry: unknown = reflectGet(this, method)
      if (typeof entry !== 'function') {
        throw new TrustedTypeError(
          `a store that extends HeldPort must define ${method} as a method`,
        )
      }
      defineProperty(this, method, {
        // It can be defined again, because a proxy over a store may only answer a property
        // with another value when the property can be. It cannot be assigned.
        configurable: true,
        value: (...args: unknown[]): unknown => {
          try {
            requirePortStrings(method, args)
          } catch (error) {
            return rejected(error)
          }
          // The entry is looked up when it is called, on the prototype chain and so past
          // this property, and never captured: a method patched onto the class after this
          // store was constructed, as a test double is, is reached, with the check in front.
          const called: unknown = reflectGet(getPrototypeOf(this) as object, method, this)
          if (typeof called !== 'function') {
            return rejected(new TrustedTypeError(`the store no longer defines ${method}`))
          }
          return apply(called as (...entryArgs: unknown[]) => unknown, this, args)
        },
      })
    }
  }
}

/** A store whose strings are held: what a dialect hands the conformance suite. */
export type HeldSchedulerStore = HeldPort & SchedulerStore
