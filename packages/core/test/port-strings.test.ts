import { describe, expect, it } from 'vitest'
import {
  HeldPort,
  IDENTIFIER_CHARACTERS,
  InvalidDurableStringError,
  PORT_STRINGS,
  PORT_STRING_RULES,
  type PortStrings,
  type PortStringsOf,
  type SchedulerStore,
  requirePortString,
  requirePortStrings,
} from '../src/index.js'

const NUL = 'a\u0000b'
const LONE_HIGH = 'a\uD800b'
const LONE_LOW = 'a\uDC00b'
const PAST_THE_WIDTH = 'x'.repeat(IDENTIFIER_CHARACTERS + 1)

function refusalOf(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    return error instanceof InvalidDurableStringError ? error.message : `another error: ${error}`
  }
  return 'accepted'
}

describe('the strings a port call carries', () => {
  it('holds an identifier to the domain and the width, a durable string to the domain alone, and leaves a payload', () => {
    // A claim token is an identifier, held as a queue is, at every place that takes one.
    const answers = (name: 'queue' | 'claimToken' | 'taskName' | 'paramsJson') => ({
      nul: refusalOf(() => requirePortString(name, NUL)),
      loneHigh: refusalOf(() => requirePortString(name, LONE_HIGH)),
      loneLow: refusalOf(() => requirePortString(name, LONE_LOW)),
      pastTheWidth: refusalOf(() => requirePortString(name, PAST_THE_WIDTH)),
      atTheWidthOutsideTheBasicPlane: refusalOf(() =>
        requirePortString(name, '\u{1F600}'.repeat(IDENTIFIER_CHARACTERS)),
      ),
    })
    const outsideTheDomain = (name: string) =>
      `${name} must be a string without NUL or lone UTF-16 surrogates`
    expect({
      identifier: answers('queue'),
      durable: answers('taskName'),
      // A claim token is an identifier: one dialect indexes it whole.
      token: answers('claimToken'),
      payload: answers('paramsJson'),
    }).toEqual({
      identifier: {
        nul: outsideTheDomain('queue'),
        loneHigh: outsideTheDomain('queue'),
        loneLow: outsideTheDomain('queue'),
        pastTheWidth: 'queue is longer than the 255 characters a durable identifier holds',
        atTheWidthOutsideTheBasicPlane: 'accepted',
      },
      durable: {
        nul: outsideTheDomain('taskName'),
        loneHigh: outsideTheDomain('taskName'),
        loneLow: outsideTheDomain('taskName'),
        pastTheWidth: 'accepted',
        atTheWidthOutsideTheBasicPlane: 'accepted',
      },
      token: {
        nul: outsideTheDomain('claimToken'),
        loneHigh: outsideTheDomain('claimToken'),
        loneLow: outsideTheDomain('claimToken'),
        pastTheWidth: 'claimToken is longer than the 255 characters a durable identifier holds',
        atTheWidthOutsideTheBasicPlane: 'accepted',
      },
      payload: {
        nul: 'accepted',
        loneHigh: 'accepted',
        loneLow: 'accepted',
        pastTheWidth: 'accepted',
        atTheWidthOutsideTheBasicPlane: 'accepted',
      },
    })
  })

  it('refuses a value that is not a string where the port takes one, with the refusal of the domain', () => {
    expect({
      number: refusalOf(() => requirePortString('queue', 42)),
      undefined: refusalOf(() => requirePortString('runId', undefined)),
      object: refusalOf(() => requirePortString('claimToken', { toString: () => 'token' })),
    }).toEqual({
      number: 'queue must be a string without NUL or lone UTF-16 surrogates',
      undefined: 'runId must be a string without NUL or lone UTF-16 surrogates',
      object: 'claimToken must be a string without NUL or lone UTF-16 surrogates',
    })
  })

  it('names a rule for every name, and every name the table uses has one', () => {
    const used = new Set<string>()
    const collect = (named: unknown): void => {
      if (typeof named === 'string') used.add(named)
      else if (named !== null && typeof named === 'object') Object.values(named).forEach(collect)
    }
    Object.values(PORT_STRINGS).forEach(collect)
    expect([...used].sort()).toEqual(Object.keys(PORT_STRING_RULES).sort())
  })

  it('holds every argument of a call in order, and names what the caller passed', () => {
    const childOf = {
      parentQueue: 'q',
      parentTaskId: 'p',
      runId: 'r',
      claimToken: 'c',
      replayKey: 'k',
    }
    expect({
      first: refusalOf(() =>
        requirePortStrings('awaitEvent', [NUL, NUL, 'r', 'c', 's', 'e', null]),
      ),
      later: refusalOf(() =>
        requirePortStrings('awaitEvent', ['q', 't', 'r', 'c', NUL, 'e', null]),
      ),
      token: refusalOf(() => requirePortStrings('claim', ['q', LONE_HIGH, { leaseSeconds: 1 }])),
      insideAnObject: refusalOf(() =>
        requirePortStrings('suspendRun', [
          'q',
          'r',
          'c',
          { inSeconds: 1 },
          { key: NUL, stateJson: '1' },
        ]),
      ),
      twoObjectsDeep: refusalOf(() =>
        requirePortStrings('spawn', [
          'q',
          't',
          '{}',
          { childOf: { ...childOf, replayKey: LONE_LOW } },
        ]),
      ),
      aPayloadBesideThem: refusalOf(() => requirePortStrings('complete', ['q', 'r', 'c', NUL])),
    }).toEqual({
      first: 'queue must be a string without NUL or lone UTF-16 surrogates',
      later: 'stepName must be a string without NUL or lone UTF-16 surrogates',
      token: 'claimToken must be a string without NUL or lone UTF-16 surrogates',
      insideAnObject: 'checkpoint.key must be a string without NUL or lone UTF-16 surrogates',
      twoObjectsDeep: 'childOf.replayKey must be a string without NUL or lone UTF-16 surrogates',
      aPayloadBesideThem: 'accepted',
    })
  })

  it('refuses null and any other value that is not a string where a string was passed, and nothing that was left out', () => {
    const spawn = (options?: unknown) =>
      refusalOf(() => requirePortStrings('spawn', ['q', 't', '{}', options]))
    const outside = 'idempotencyKey must be a string without NUL or lone UTF-16 surrogates'
    expect({
      'an optional argument left out': spawn(),
      'an optional member left out': spawn({ idempotencyKey: undefined }),
      'an optional member that is null': spawn({ idempotencyKey: null }),
      'an optional member that is a number': spawn({ idempotencyKey: 7 }),
      'a required argument that is null': refusalOf(() => requirePortStrings('sweep', [null, 10])),
      'a required argument left out': refusalOf(() => requirePortStrings('sweep', [])),
    }).toEqual({
      'an optional argument left out': 'accepted',
      'an optional member left out': 'accepted',
      'an optional member that is null': outside,
      'an optional member that is a number': outside,
      'a required argument that is null':
        'queue must be a string without NUL or lone UTF-16 surrogates',
      'a required argument left out':
        'queue must be a string without NUL or lone UTF-16 surrogates',
    })
  })

  it('passes over an options object, and a member of one, that the caller left out', () => {
    expect({
      noOptions: refusalOf(() => requirePortStrings('spawn', ['q', 't', '{}'])),
      emptyOptions: refusalOf(() => requirePortStrings('spawn', ['q', 't', '{}', {}])),
      aKeyAlone: refusalOf(() =>
        requirePortStrings('spawn', ['q', 't', '{}', { idempotencyKey: 'k' }]),
      ),
      // An entry reads a missing checkpoint for itself. The check does not read through it.
      noCheckpoint: refusalOf(() =>
        requirePortStrings('suspendRun', ['q', 'r', 'c', null, undefined]),
      ),
    }).toEqual({
      noOptions: 'accepted',
      emptyOptions: 'accepted',
      aKeyAlone: 'accepted',
      noCheckpoint: 'accepted',
    })
  })
})

describe('a store that extends the held port', () => {
  const reached: unknown[][] = []
  class Recording extends HeldPort {
    readonly answer = Promise.resolve('the entry ran')
    claim(...args: unknown[]): Promise<unknown> {
      reached.push(args)
      return this.answer
    }
  }
  // Every other method of the port, so that the constructor finds each one.
  for (const method of Object.keys(PORT_STRINGS)) {
    if (method !== 'claim')
      Object.defineProperty(Recording.prototype, method, { value: () => Promise.resolve() })
  }
  const store = new Recording() as Recording & SchedulerStore

  it('checks a call before the entry runs, and answers a refusal as a rejected promise', async () => {
    reached.length = 0
    let thrown: unknown = 'nothing was thrown'
    let call: Promise<unknown> = Promise.resolve()
    try {
      call = store.claim(NUL, 'w', { leaseSeconds: 30, limit: 1 })
    } catch (error) {
      thrown = error
    }
    const refusal = await call.then(
      () => 'accepted',
      (error: unknown) => error,
    )
    expect({
      thrown,
      refused: refusal instanceof InvalidDurableStringError,
      reached,
    }).toEqual({ thrown: 'nothing was thrown', refused: true, reached: [] })
  })

  it('hands a call that passes to the entry as it was made, and returns the promise the entry returned', () => {
    reached.length = 0
    const options = { leaseSeconds: 30, limit: 1 }
    const call = store.claim('q', 'w', options)
    expect(call).toBe(store.answer)
    expect(reached).toEqual([['q', 'w', options]])
    expect(reached[0]?.[2]).toBe(options)
  })

  it('checks a method that a subclass defines again', async () => {
    const overridden: string[] = []
    class Overriding extends Recording {
      override claim(): Promise<unknown> {
        overridden.push('reached')
        return Promise.resolve()
      }
    }
    const refused = await (new Overriding() as Overriding & SchedulerStore)
      .claim(LONE_HIGH, 'w', { leaseSeconds: 30, limit: 1 })
      .then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
    expect({ refused, overridden }).toEqual({
      refused: 'InvalidDurableStringError',
      overridden: [],
    })
  })

  it('cannot have its check assigned away, and lets a proxy answer a method with its own', () => {
    expect(() => {
      ;(store as { claim: unknown }).claim = () => Promise.resolve('unchecked')
    }).toThrow(TypeError)
    const proxied = new Proxy(store, {
      get: (target, property) =>
        property === 'claim' ? () => 'the proxy answered' : Reflect.get(target, property),
    })
    expect((proxied.claim as () => unknown)()).toBe('the proxy answered')
    // The check is not among the properties a copy or a comparison reads.
    expect(Object.keys(store)).toEqual(['answer'])
  })

  it('reaches a method patched onto the prototype after the store was constructed, with the check still in front', async () => {
    // A test double is often a patch of a store class's prototype, made after the store
    // under test exists. The store has to reach the patch, and the check has to stay in
    // front of it.
    class Patched extends HeldPort {
      claim(): Promise<unknown> {
        return Promise.resolve('the entry')
      }
    }
    for (const method of Object.keys(PORT_STRINGS)) {
      if (method !== 'claim')
        Object.defineProperty(Patched.prototype, method, { value: () => Promise.resolve() })
    }
    const patched = new Patched() as Patched & SchedulerStore
    const entry = Patched.prototype.claim
    Patched.prototype.claim = () => Promise.resolve('the patch')
    try {
      expect({
        answered: await patched.claim('q', 'w', { leaseSeconds: 30, limit: 1 }),
        refused: await patched.claim(NUL, 'w', { leaseSeconds: 30, limit: 1 }).then(
          () => 'accepted',
          (error: unknown) => (error instanceof Error ? error.name : String(error)),
        ),
      }).toEqual({ answered: 'the patch', refused: 'InvalidDurableStringError' })
    } finally {
      Patched.prototype.claim = entry
    }
  })

  it('refuses to construct a store that lacks a method of the port', () => {
    class Lacking extends HeldPort {}
    expect(() => new Lacking()).toThrow(/must define spawn as a method/)
  })
})

describe('the type of the table', () => {
  it('stops the build for a method, an argument, or a string inside an object that the table does not name', () => {
    // Each control is one short line, because the directive above it covers one line and
    // a formatter that wrapped a control would move its error out from under it. So the
    // cases about an object are asked of a small port, through the same generic type.
    interface Parks {
      park(queue: string, limit: number, checkpoint: { key: string; stateJson: string }): void
    }
    type Parked = PortStringsOf<Parks>
    const inside = { key: 'checkpoint.key', stateJson: 'checkpoint.stateJson' } as const
    const whole: PortStrings = PORT_STRINGS
    const parks: Parked = { park: ['queue', null, inside] }

    const { claim: _claim, ...withoutClaim } = PORT_STRINGS
    // @ts-expect-error a method the table does not name
    const missingMethod: PortStrings = withoutClaim
    // @ts-expect-error a string argument given null
    const unnamed: Parked = { park: [null, null, inside] }
    // @ts-expect-error a string inside an object left out
    const unnamedInside: Parked = { park: ['queue', null, { key: 'checkpoint.key' }] }
    // @ts-expect-error an object of strings given null
    const unnamedObject: Parked = { park: ['queue', null, null] }
    // @ts-expect-error a name the rules do not hold
    const unknownName: Parked = { park: ['queu', null, inside] }
    // @ts-expect-error a name where no string is
    const nameForANumber: Parked = { park: ['queue', 'queue', inside] }
    // @ts-expect-error an argument left out
    const shorter: Parked = { park: ['queue', null] }
    interface TakesAnOption {
      enqueue(queue: string, options?: { key?: string; attempts?: number }): void
    }
    // An optional string is still a string the table names: null does not excuse it.
    const optional: PortStringsOf<TakesAnOption> = { enqueue: ['queue', { key: 'idempotencyKey' }] }
    // @ts-expect-error an optional member of an options object given null
    const optionalGivenNull: PortStringsOf<TakesAnOption> = { enqueue: ['queue', { key: null }] }
    // @ts-expect-error an options object with an optional string given null
    const optionsGivenNull: PortStringsOf<TakesAnOption> = { enqueue: ['queue', null] }
    // @ts-expect-error a member the object does not have
    const extraMember: Parked = { park: ['queue', null, { ...inside, extra: 'queue' }] }

    interface WiderPort extends SchedulerStore {
      renameQueue(queue: string, to: string): Promise<void>
    }
    // @ts-expect-error a method the port gains is not in the table until its strings are named
    const gained: PortStringsOf<WiderPort> = PORT_STRINGS
    const named: PortStringsOf<WiderPort> = { ...PORT_STRINGS, renameQueue: ['queue', 'queue'] }

    interface ChoosesAmongWords {
      order(by: 'oldest' | 'newest', tag: string | null): Promise<void>
    }
    // A union of the engine's own words is not a caller's string, and a nullable string is one.
    const words: PortStringsOf<ChoosesAmongWords> = { order: [null, 'queue'] }

    const controls = [whole, parks, missingMethod, unnamed, unnamedInside, unnamedObject]
    const more = [unknownName, nameForANumber, shorter, extraMember, gained, named, words]
    const options = [optional, optionalGivenNull, optionsGivenNull]
    expect(controls.length + more.length + options.length).toBe(16)
  })
})
