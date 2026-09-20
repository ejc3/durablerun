import {
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
  /** The method and the name the caller knows the string by: `claim(queue)`. */
  readonly place: string
  readonly method: PortMethod
  readonly name: PortStringName
  readonly rule: PortStringRule
  /** Make the example call with `value` at this place and every other argument valid. */
  call(store: SchedulerStore, value: unknown): Promise<unknown>
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

/** Every string the table names in `named`, with the path to it from the arguments. */
function namedPaths(named: unknown, path: Path): { name: PortStringName; path: Path }[] {
  if (typeof named === 'string') return [{ name: named as PortStringName, path }]
  if (named === null || typeof named !== 'object') return []
  return Object.entries(named).flatMap(([property, inner]) =>
    namedPaths(inner, [...path, Array.isArray(named) ? Number(property) : property]),
  )
}

/** Every string in a value, with its path, whatever the table says about it. */
function stringPaths(value: unknown, path: Path): Path[] {
  if (typeof value === 'string') return [path]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([property, inner]) =>
    stringPaths(inner, [...path, Array.isArray(value) ? Number(property) : property]),
  )
}

const valueAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (inner, step) =>
      inner !== null && typeof inner === 'object' ? Reflect.get(inner, step) : undefined,
    value,
  )

function generatePlaces(): readonly PortStringPlace[] {
  const places: PortStringPlace[] = []
  for (const method of Object.keys(PORT_STRINGS) as PortMethod[]) {
    const examples: readonly (readonly unknown[])[] = EXAMPLE_CALLS[method]
    const named = namedPaths(PORT_STRINGS[method], [])
    // The table's type holds it to the port's types. This holds it to real calls: a
    // string an example passes that the table does not name was left out of the table.
    const unnamed = examples.flatMap((args) =>
      stringPaths(args, []).filter(
        (path) =>
          !named.some(
            (known) =>
              known.path.length <= path.length && known.path.every((step, at) => step === path[at]),
          ),
      ),
    )
    if (unnamed.length > 0) {
      throw new Error(`${method}: the table names no string at ${JSON.stringify(unnamed)}`)
    }
    for (const { name, path } of named) {
      const args = examples.find((example) => valueAt(example, path) !== undefined)
      if (args === undefined) {
        throw new Error(`${method}(${name}): no example call passes this string`)
      }
      places.push({
        place: `${method}(${name})`,
        method,
        name,
        rule: PORT_STRING_RULES[name],
        call: (store, value) =>
          (Reflect.get(store, method) as (...made: unknown[]) => Promise<unknown>).apply(
            store,
            withAt(args, path, value) as unknown[],
          ),
      })
    }
  }
  return places
}

/** Every place a string enters the port, in the table's order. */
export const PORT_STRING_PLACES: readonly PortStringPlace[] = generatePlaces()

/** The places the port holds to a rule: every place but a payload's. */
export const HELD_PLACES = PORT_STRING_PLACES.filter(({ rule }) => rule !== 'payload')

/** The places of an identifier, which are held to the width as well as the domain. */
export const IDENTIFIER_PLACES = PORT_STRING_PLACES.filter(({ rule }) => rule === 'identifier')

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
const WIDTH = 255

/** Identifiers past the width. The last is 512 UTF-16 units and 256 characters. */
export const PAST_THE_WIDTH: Readonly<Record<string, string>> = {
  'one character past': 'x'.repeat(WIDTH + 1),
  // Excess that is only trailing spaces is the excess one dialect would cut silently.
  'a trailing space past': `${'x'.repeat(WIDTH)} `,
  'one character past, outside the basic plane': '\u{1F600}'.repeat(WIDTH + 1),
}
