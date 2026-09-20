import {
  PORT_METHODS,
  PORT_STRINGS,
  PORT_STRING_RULES,
  type PortMethod,
  type PortStringName,
  type PortStringRule,
  type SchedulerStore,
} from '@durablerun/core'

/**
 * Every place a string enters the port, generated from core's one table
 * (`PORT_STRINGS`), and the names the port must refuse there.
 *
 * The table says where each string is. This file adds what the table cannot: a call that
 * is valid but for the one string under test. The identifier surface and the fuzz walk
 * both draw their places and their names from here, so neither keeps a list of entries
 * by hand, and a place the table gains is asked about by both without being listed.
 */

const wake = { inSeconds: 1 }
const checkpoint = { key: 'k', stateJson: '{}' }
const parent = { parentQueue: 'q', parentTaskId: 'p', runId: 'r', claimToken: 'c', replayKey: 'k' }

/**
 * One valid call, or more, for every method of the port. The type makes a method with no
 * call here a compile error. `spawn` has two, because a caller's key and a parent are
 * refused together, and between them the calls must reach every string the table names.
 */
const EXAMPLE_CALLS: {
  readonly [Method in PortMethod]: readonly Parameters<SchedulerStore[Method]>[]
} = {
  spawn: [
    ['q', 't', '{}', { idempotencyKey: 'key', headers: { h: 'v' } }],
    ['q', 't', '{}', { childOf: parent }],
  ],
  claim: [['q', 'w', { leaseSeconds: 30, limit: 1 }]],
  activate: [['q', 'r', 'c', 1]],
  claimedTaskName: [['q', 'r', 'c', 1]],
  deferLaunch: [['q', 'r', 'c', 1, 5]],
  heartbeat: [['q', 'r', 'c', 30]],
  reschedule: [['q', 'r', 'c', wake]],
  complete: [['q', 'r', 'c', '{}']],
  suspendRun: [['q', 'r', 'c', wake, checkpoint]],
  fail: [['q', 'r', 'c', '{}', null]],
  failRollback: [['q', 'r', 'c', '{}', null, checkpoint]],
  sweep: [['q', 10]],
  expireLeaseNow: [['q', 'r', 'c']],
  getCheckpoints: [['q', 't', 1]],
  setCheckpoint: [['q', 't', 'r', 'c', 'k', '{}', 30]],
  emitEvent: [['q', 'e', '{}']],
  awaitEvent: [['q', 't', 'r', 'c', 's', 'e', null]],
  awaitTaskDone: [['q', 't', 'r', 'c', 's', 'child', null]],
  getTaskResult: [['q', 't']],
  nextWakeAtEpochMs: [['q']],
  driverHeartbeat: [['q', 'd', 30]],
  cancelTask: [['q', 't']],
  retryTask: [['q', 't']],
}

/** One place a string enters the port. */
export interface PortStringPlace {
  /** The method, where the string stands in the call, and its name: `claim[0](queue)`. */
  readonly place: string
  readonly rule: PortStringRule
  /** Whether the port's type lets the caller leave this string out, as core's table marks it. */
  readonly mayBeLeftOut: boolean
  /** Make the example call with `value` at this place and every other argument valid. */
  call(store: SchedulerStore, value: unknown): Promise<unknown>
  /** Make the example call with this string left out and every other argument valid. */
  callWithout(store: SchedulerStore): Promise<unknown>
}

/** An options object a call carries strings in, which a caller can leave out whole. */
export interface PortObjectPlace {
  /** The method and where the object stands in the call: `suspendRun[4]`. */
  readonly place: string
  /** Whether the port's type lets the caller leave the object out. */
  readonly mayBeLeftOut: boolean
  /** Whether a string the port requires stands in it, so that leaving it out leaves that out. */
  readonly holdsARequiredString: boolean
  /** Make the example call with the object left out and every other argument valid. */
  callWithout(store: SchedulerStore): Promise<unknown>
}

type Path = readonly (number | string)[]

/** A copy of `value` with `replacement` at `path`. Only what is on the path is copied. */
function withAt(value: unknown, path: Path, replacement: unknown): unknown {
  const [step, ...rest] = path
  if (step === undefined) return replacement
  if (Array.isArray(value)) {
    return value.map((item, index) => (index === step ? withAt(item, rest, replacement) : item))
  }
  return {
    ...(value as object),
    [step]: withAt(Reflect.get(value as object, step), rest, replacement),
  }
}

/**
 * A copy of `value` with what stands at `path` left out: a member is omitted, and an
 * argument, which has a position to keep, is undefined. Only what is on the path is copied.
 */
function without(value: unknown, path: Path): unknown {
  const [step, ...rest] = path
  if (step === undefined) return undefined
  if (Array.isArray(value)) {
    return value.map((item, index) => (index === step ? without(item, rest) : item))
  }
  const { [step]: inner, ...others } = value as Record<number | string, unknown>
  return rest.length === 0 ? others : { ...others, [step]: without(inner, rest) }
}

/**
 * Every string under `value`, a call's arguments, with the path to it from the arguments.
 */
function stringsIn(value: unknown, path: Path): { string: string; path: Path }[] {
  if (typeof value === 'string') return [{ string: value, path }]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([property, inner]) =>
    stringsIn(inner, [...path, Array.isArray(value) ? Number(property) : property]),
  )
}

/**
 * Every name under `named`, a part of core's table, with the path to it and whether the
 * table marks it as one the caller may leave out. The mark is not a step of the path, so a
 * path means in the table what it means in a call.
 */
function namesIn(
  named: unknown,
  path: Path,
  mayBeLeftOut = false,
): { name: PortStringName; path: Path; mayBeLeftOut: boolean }[] {
  if (typeof named === 'string') return [{ name: named as PortStringName, path, mayBeLeftOut }]
  if (named === null || typeof named !== 'object') return []
  if (Object.hasOwn(named, '?')) return namesIn(Reflect.get(named, '?'), path, true)
  return Object.entries(named).flatMap(([property, inner]) =>
    namesIn(inner, [...path, Array.isArray(named) ? Number(property) : property]),
  )
}

/**
 * Every object under `named` that names strings, with its path, whether the table marks
 * it as one the caller may leave out, and whether a string the port requires stands in it.
 */
function objectsIn(
  named: unknown,
  path: Path,
  mayBeLeftOut = false,
): { path: Path; mayBeLeftOut: boolean; holdsARequiredString: boolean }[] {
  if (named === null || typeof named !== 'object') return []
  if (Object.hasOwn(named, '?')) return objectsIn(Reflect.get(named, '?'), path, true)
  const beneath = Object.entries(named).flatMap(([property, inner]) =>
    objectsIn(inner, [...path, Array.isArray(named) ? Number(property) : property]),
  )
  if (Array.isArray(named)) return beneath
  const members = Object.values(named)
  const holdsARequiredString =
    members.some((member) => typeof member === 'string') ||
    beneath.some(
      (object) =>
        object.path.length === path.length + 1 &&
        !object.mayBeLeftOut &&
        object.holdsARequiredString,
    )
  return [{ path, mayBeLeftOut, holdsARequiredString }, ...beneath]
}

/** A path as a place shows it: the argument's position, then the members under it. */
const shown = ([argument, ...members]: Path): string =>
  `[${argument}]${members.map((member) => `.${member}`).join('')}`

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (inner, step) =>
      inner !== null && typeof inner === 'object' ? Reflect.get(inner, step) : undefined,
    value,
  )

/** Make one call of the port. */
const make = (store: SchedulerStore, method: PortMethod, args: unknown): Promise<unknown> =>
  (Reflect.get(store, method) as (...made: unknown[]) => Promise<unknown>).apply(
    store,
    args as unknown[],
  )

/**
 * The places, and what is wrong with the table or with the calls here. What is wrong is
 * data and not a throw, so that a table that is wrong fails a case by its name, with its
 * reason, and does not stop the whole suite from loading.
 */
function generatePlaces(): {
  places: readonly PortStringPlace[]
  objects: readonly PortObjectPlace[]
  problems: readonly string[]
} {
  const places: PortStringPlace[] = []
  const objects: PortObjectPlace[] = []
  const problems: string[] = []
  for (const method of PORT_METHODS) {
    const examples: readonly (readonly unknown[])[] = EXAMPLE_CALLS[method]
    const named = namesIn(PORT_STRINGS[method], [])
    // The table's type holds it to the port's types. This holds it to real calls: a
    // string an example passes that the table does not name was left out of the table.
    const unnamed = examples.flatMap((args) =>
      stringsIn(args, []).filter(
        ({ path }) =>
          !named.some(
            (known) =>
              known.path.length <= path.length && known.path.every((step, at) => step === path[at]),
          ),
      ),
    )
    if (unnamed.length > 0) {
      problems.push(
        `${method}: the table names no string at ${unnamed.map(({ path }) => shown(path))}`,
      )
    }
    // A method names each string once. The place shows where the string stands as well, so
    // two arguments of one name are two places, and this says so in words.
    const names = named.map(({ name }) => name)
    const twice = names.filter((name, at) => names.indexOf(name) !== at)
    if (twice.length > 0) {
      problems.push(`${method}: the table names ${JSON.stringify(twice)} at more than one argument`)
    }
    for (const { name, path, mayBeLeftOut } of named) {
      const args = examples.find((example) => valueAt(example, path) !== undefined)
      if (args === undefined) {
        problems.push(`${method}${shown(path)}(${name}): no example call passes this string`)
        continue
      }
      places.push({
        // Where the string stands, and the name the table gives it there. The position is
        // part of the place, so two names that changed places are two other places.
        place: `${method}${shown(path)}(${name})`,
        rule: PORT_STRING_RULES[name],
        mayBeLeftOut,
        call: (store, value) => make(store, method, withAt(args, path, value)),
        callWithout: (store) => make(store, method, without(args, path)),
      })
    }
    for (const { path, mayBeLeftOut, holdsARequiredString } of objectsIn(
      PORT_STRINGS[method],
      [],
    )) {
      const args = examples.find((example) => valueAt(example, path) !== undefined)
      if (args === undefined) {
        problems.push(`${method}${shown(path)}: no example call passes this object`)
        continue
      }
      objects.push({
        place: `${method}${shown(path)}`,
        mayBeLeftOut,
        holdsARequiredString,
        callWithout: (store) => make(store, method, without(args, path)),
      })
    }
  }
  return { places, objects, problems }
}

const generated = generatePlaces()

/** Every place a string enters the port, in the table's order. */
export const PORT_STRING_PLACES: readonly PortStringPlace[] = generated.places

/** Every options object a call carries strings in, in the table's order. */
export const PORT_OBJECT_PLACES: readonly PortObjectPlace[] = generated.objects

/** What generating the places found wrong. The identifier surface holds it empty. */
export const PORT_STRING_PROBLEMS: readonly string[] = generated.problems

/** The places the port holds to the durable string domain: an identifier's and a task name's. */
export const HELD_PLACES = PORT_STRING_PLACES.filter(
  ({ rule }) => rule === 'identifier' || rule === 'durable',
)

/** The places of an identifier, which are held to the width as well as the domain. */
export const IDENTIFIER_PLACES = PORT_STRING_PLACES.filter(({ rule }) => rule === 'identifier')

/** The places of a payload, which is held to being a string and no further. */
export const PAYLOAD_PLACES = PORT_STRING_PLACES.filter(({ rule }) => rule === 'payload')

/**
 * What is not a string, where a payload belongs. They are written here and not taken from
 * core. Left to the entries, null was reported as an outage or as a RangeError, and a
 * number was stored.
 */
export const NOT_A_STRING: Readonly<Record<string, unknown>> = { null: null, 'a number': 42 }

/**
 * Names outside the durable string domain (DESIGN.md §3.4 rule 10). They are written here
 * and not taken from core's predicate, so the suite holds the contract and not whatever
 * the predicate happens to admit. None is only ASCII, and one is not a string at all.
 */
export const OUTSIDE_THE_DOMAIN: Readonly<Record<string, unknown>> = {
  'a NUL': 'a\u0000b',
  'a lone high surrogate': 'a\uD800b',
  'a lone low surrogate': 'a\uDC00b',
  'an emoji cut in half': '\u{1F600}'.slice(0, 1),
  'a pair the wrong way round': 'a\uDE00\uD83Db',
  'a number': 42,
  null: null,
}

/** The width of a durable identifier, written here and not imported, as the contract. */
export const WIDTH = 255

/** Identifiers past the width. The last is 512 UTF-16 units and 256 characters. */
export const PAST_THE_WIDTH: Readonly<Record<string, string>> = {
  'one character past': 'x'.repeat(WIDTH + 1),
  // Excess that is only trailing spaces is the excess one dialect would cut silently.
  'a trailing space past': `${'x'.repeat(WIDTH)} `,
  'one character past, outside the basic plane': '\u{1F600}'.repeat(WIDTH + 1),
}
