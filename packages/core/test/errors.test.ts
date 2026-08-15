import { describe, expect, it } from 'vitest'
import {
  FatalTaskError,
  LeaseLostError,
  StoreUnavailableError,
  SuspendSignal,
  UNINSPECTABLE_TASK_FAILURE_JSON,
  snapshotTaskThrowable,
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

  it('contains revoked proxy traps at the total fallback', async () => {
    const revocable = Proxy.revocable(Object.create(null), {})
    revocable.revoke()
    const snapshot = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'task-throwable-total-fallback' },
      /proxy that has been revoked/,
      async () => snapshotTaskThrowable(revocable.proxy),
    )
    expect(snapshot).toEqual(failure('Error', 'task threw an uninspectable value'))
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
    expect(snapshotTaskThrowable(hostileMessage)).toEqual(
      failure('Error', 'task threw an uninspectable value'),
    )
    expect(messageReads, 'mutation-verdict:behavior:task-throwable-message-data-only').toBe(0)
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
    expect(snapshotTaskThrowable(hostileCoercion)).toEqual(
      failure('Error', 'task threw an uninspectable value'),
    )
    expect(coercions, 'mutation-verdict:behavior:task-throwable-no-object-coercion').toBe(0)
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
  })

  it('rejects prototype forgeries as ordinary user failures', () => {
    const forge = (prototype: object, name: string) =>
      Object.assign(Object.create(prototype), { name, message: 'forged control' })
    expect(
      snapshotTaskThrowable(forge(SuspendSignal.prototype, 'ForgedSuspend')),
      'mutation-verdict:construction:task-throwable-forged-suspend',
    ).toEqual(failure('ForgedSuspend', 'forged control'))
    expect(
      snapshotTaskThrowable(forge(LeaseLostError.prototype, 'ForgedLease')),
      'mutation-verdict:construction:task-throwable-forged-lease-lost',
    ).toEqual(failure('ForgedLease', 'forged control'))
    expect(
      snapshotTaskThrowable(forge(StoreUnavailableError.prototype, 'ForgedStore')),
      'mutation-verdict:construction:task-throwable-forged-store-unavailable',
    ).toEqual(failure('ForgedStore', 'forged control'))
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
