import { describe, expect, it } from 'vitest'
import {
  FatalTaskError,
  LeaseLostError,
  PermanentStoreError,
  STORE_FAILURE_TYPES,
  SchemaMismatchError,
  StoreAccessRefusedError,
  type StoreFailureKind,
  StoreUnavailableError,
  SuspendSignal,
  UNINSPECTABLE_TASK_FAILURE_JSON,
  snapshotTaskThrowable,
  storeFailureKind,
} from '../src/errors.js'
import { attributeExpectedFailure } from '../src/testing.js'

const failure = (name: string, message: string, fatal = false) => ({
  kind: 'failure' as const,
  fatal,
  failureJson: `{"name":${JSON.stringify(name)},"message":${JSON.stringify(message)}}`,
})

describe('snapshotTaskThrowable', () => {
  it('owns primitive and Error diagnostics in one canonical representation', () => {
    expect(
      snapshotTaskThrowable('plain failure'),
      'mutation-verdict:behavior:task-throwable-primitive',
    ).toEqual(failure('Error', 'plain failure'))
    expect(snapshotTaskThrowable(new Error('ordinary failure'))).toEqual(
      failure('Error', 'ordinary failure'),
    )
  })

  it('preserves a built-in Error subtype name from prototype data', () => {
    expect(
      snapshotTaskThrowable(new TypeError('typed failure')),
      'mutation-verdict:behavior:task-throwable-prototype-data',
    ).toEqual(failure('TypeError', 'typed failure'))
  })

  it('uses one generic payload for uninspectable objects', () => {
    const generic = failure('Error', 'task threw an uninspectable value')
    expect(
      {
        plainObject: snapshotTaskThrowable({ arbitrary: true }),
        thrownFunction: snapshotTaskThrowable(() => undefined),
      },
      'mutation-verdict:behavior:task-throwable-generic-payload',
    ).toEqual({ plainObject: generic, thrownFunction: generic })
  })

  it('contains hostile descriptor and revoked proxy traps at the total fallback', async () => {
    const descriptorError = new RangeError('hostile descriptor trap')
    const hostileDescriptor = new Proxy(Object.create(null), {
      getOwnPropertyDescriptor(): never {
        throw descriptorError
      },
    })
    const hostileDescriptorSnapshot = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'task-throwable-total-fallback' },
      (error) => error === descriptorError,
      async () => snapshotTaskThrowable(hostileDescriptor),
    )

    const revocable = Proxy.revocable(Object.create(null), {})
    revocable.revoke()
    const revokedProxySnapshot = snapshotTaskThrowable(revocable.proxy)
    const generic = failure('Error', 'task threw an uninspectable value')
    expect({ hostileDescriptorSnapshot, revokedProxySnapshot }).toEqual({
      hostileDescriptorSnapshot: generic,
      revokedProxySnapshot: generic,
    })
  })

  it('reads names from data descriptors without invoking getters', () => {
    let nameReads = 0
    const hostileName = new Error('ordinary message')
    Object.defineProperty(hostileName, 'name', {
      get(): never {
        nameReads++
        throw new Error('name getter ran')
      },
    })
    expect(snapshotTaskThrowable(hostileName)).toEqual(
      failure('Error', 'task threw an uninspectable value'),
    )
    expect(nameReads, 'mutation-verdict:behavior:task-throwable-name-data-only').toBe(0)
  })

  it('reads messages from data descriptors without invoking getters', () => {
    let messageReads = 0
    const hostileMessage = new Error('ordinary message')
    Object.defineProperty(hostileMessage, 'message', {
      get(): never {
        messageReads++
        throw new Error('message getter ran')
      },
    })
    expect(
      {
        snapshot: snapshotTaskThrowable(hostileMessage),
        messageReads,
      },
      'mutation-verdict:behavior:task-throwable-message-data-only',
    ).toEqual({
      snapshot: failure('Error', 'task threw an uninspectable value'),
      messageReads: 0,
    })
  })

  it('never coerces an uninspectable object', () => {
    let coercions = 0
    const hostileCoercion = Object.create(null) as Record<PropertyKey, unknown>
    Object.defineProperties(hostileCoercion, {
      [Symbol.toPrimitive]: {
        value: () => {
          coercions++
          throw new Error('coercion ran')
        },
      },
      toString: {
        value: () => {
          coercions++
          throw new Error('coercion ran')
        },
      },
    })
    expect(
      {
        snapshot: snapshotTaskThrowable(hostileCoercion),
        coercions,
      },
      'mutation-verdict:behavior:task-throwable-no-object-coercion',
    ).toEqual({
      snapshot: failure('Error', 'task threw an uninspectable value'),
      coercions: 0,
    })
  })

  it('treats public engine control constructors as ordinary task failures', () => {
    expect(
      snapshotTaskThrowable(new SuspendSignal('await-event')),
      'mutation-verdict:construction:task-throwable-public-suspend',
    ).toEqual(failure('SuspendSignal', 'run suspended: await-event'))
    expect(
      snapshotTaskThrowable(new LeaseLostError('lost')),
      'mutation-verdict:construction:task-throwable-public-lease-lost',
    ).toEqual(failure('LeaseLostError', 'lost'))
    expect(
      snapshotTaskThrowable(new StoreUnavailableError('offline')),
      'mutation-verdict:construction:task-throwable-public-store-unavailable',
    ).toEqual(failure('StoreUnavailableError', 'offline'))
    expect(snapshotTaskThrowable(new PermanentStoreError('refused for good'))).toEqual(
      failure('PermanentStoreError', 'refused for good'),
    )
  })

  it('rejects prototype forgeries as ordinary user failures', () => {
    const forge = (prototype: object, name: string) =>
      Object.assign(Object.create(prototype), { name, message: 'forged control' })
    const selectedSuspend = Object.assign(forge(SuspendSignal.prototype, 'ForgedSuspend'), {
      cause: new Error('forged suspension sentinel cause'),
    })
    const suspendControl = forge(SuspendSignal.prototype, 'ForgedSuspend')
    expect(
      {
        selected: snapshotTaskThrowable(selectedSuspend),
        control: snapshotTaskThrowable(suspendControl),
      },
      'mutation-verdict:construction:task-throwable-forged-suspend',
    ).toEqual({
      selected: failure('ForgedSuspend', 'forged control'),
      control: failure('ForgedSuspend', 'forged control'),
    })
    const selectedLease = Object.assign(forge(LeaseLostError.prototype, 'ForgedLease'), {
      cause: new Error('forged lease-loss sentinel cause'),
    })
    const leaseControl = forge(LeaseLostError.prototype, 'ForgedLease')
    expect(
      {
        selected: snapshotTaskThrowable(selectedLease),
        control: snapshotTaskThrowable(leaseControl),
      },
      'mutation-verdict:construction:task-throwable-forged-lease-lost',
    ).toEqual({
      selected: failure('ForgedLease', 'forged control'),
      control: failure('ForgedLease', 'forged control'),
    })
    const selectedStore = Object.assign(forge(StoreUnavailableError.prototype, 'ForgedStore'), {
      cause: new Error('forged store-outage sentinel cause'),
    })
    const storeControl = forge(StoreUnavailableError.prototype, 'ForgedStore')
    expect(
      {
        selected: snapshotTaskThrowable(selectedStore),
        control: snapshotTaskThrowable(storeControl),
      },
      'mutation-verdict:construction:task-throwable-forged-store-unavailable',
    ).toEqual({
      selected: failure('ForgedStore', 'forged control'),
      control: failure('ForgedStore', 'forged control'),
    })
    expect(
      snapshotTaskThrowable(forge(FatalTaskError.prototype, 'ForgedFatal')),
      'mutation-verdict:construction:task-throwable-forged-fatal',
    ).toEqual(failure('ForgedFatal', 'forged control'))
  })

  it('exports the one generic wire spelling used by the worker', () => {
    expect(UNINSPECTABLE_TASK_FAILURE_JSON).toBe(
      '{"name":"Error","message":"task threw an uninspectable value"}',
    )
  })
})

describe('PermanentStoreError', () => {
  it('is no outage, and an outage is not one', () => {
    expect(new PermanentStoreError('refused for good')).not.toBeInstanceOf(StoreUnavailableError)
    expect(new StoreUnavailableError('offline')).not.toBeInstanceOf(PermanentStoreError)
  })
})

describe('StoreAccessRefusedError', () => {
  it('is neither an outage nor a permanent answer, and neither of those is one', () => {
    const refused = new StoreAccessRefusedError('refused', { cause: new Error('the driver') })
    expect(refused).not.toBeInstanceOf(StoreUnavailableError)
    expect(refused).not.toBeInstanceOf(PermanentStoreError)
    expect(new StoreUnavailableError('offline')).not.toBeInstanceOf(StoreAccessRefusedError)
    expect(new PermanentStoreError('for good')).not.toBeInstanceOf(StoreAccessRefusedError)
    expect({ name: refused.name, cause: (refused.cause as Error).message }).toEqual({
      name: 'StoreAccessRefusedError',
      cause: 'the driver',
    })
    // Constructed by task code it is an ordinary failure, as every public type is.
    expect(snapshotTaskThrowable(refused)).toEqual(failure('StoreAccessRefusedError', 'refused'))
  })
})

describe('storeFailureKind', () => {
  const kinds = Object.keys(STORE_FAILURE_TYPES) as StoreFailureKind[]

  it('names the kind of every type of the table and of a subclass of one, and each error is of one kind', () => {
    expect(kinds).toEqual([
      'unavailable',
      'access-refused',
      'permanent',
      'schema-mismatch',
      'schema-not-initialized',
    ])
    for (const kind of kinds) {
      const Type = STORE_FAILURE_TYPES[kind]
      class Narrower extends Type {}
      expect(
        { kind, own: storeFailureKind(new Type('x')), narrower: storeFailureKind(new Narrower()) },
        'mutation-verdict:behavior:store-failure-kind-reads-every-type-of-the-table',
      ).toEqual({ kind, own: kind, narrower: kind })
      // No type of the table extends another, so the order of the table decides nothing.
      expect(kinds.filter((other) => new Type('x') instanceof STORE_FAILURE_TYPES[other])).toEqual([
        kind,
      ])
    }
  })

  it('answers no kind for an error of another type and for a value that is no error', () => {
    for (const other of [
      new Error('ordinary'),
      new TypeError('ordinary'),
      new LeaseLostError('lost'),
      { name: 'StoreUnavailableError', message: 'a look-alike' },
      'StoreUnavailableError',
      null,
      undefined,
    ]) {
      expect(storeFailureKind(other)).toBeUndefined()
    }
  })

  it('uses the type check captured when the module loaded, not a hook installed on a public type', () => {
    for (const kind of kinds) {
      const Type = STORE_FAILURE_TYPES[kind]
      Object.defineProperty(Type, Symbol.hasInstance, { configurable: true, value: () => true })
      try {
        expect(storeFailureKind(new Error('ordinary'))).toBeUndefined()
      } finally {
        Reflect.deleteProperty(Type, Symbol.hasInstance)
      }
    }
  })

  it('answers no kind for a value that cannot be asked for its type', async () => {
    const revocable = Proxy.revocable(Object.create(null), {})
    revocable.revoke()
    const kind = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'store-failure-kind-total-fallback' },
      /proxy that has been revoked/,
      async () => storeFailureKind(revocable.proxy),
    )
    expect(kind).toBeUndefined()
    // The control: the same type check does throw for such a value.
    expect(() => revocable.proxy instanceof SchemaMismatchError).toThrow(/revoked/)
  })
})
