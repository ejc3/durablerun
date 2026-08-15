import { LeaseLostError, StoreUnavailableError } from '@durablerun/core'
import { attributeExpectedFailure } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { createTaskControlScope, trustedStoreControl } from '../src/task-control.js'

function captureThrown(action: () => never): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to throw')
}

async function captureRejected(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to reject')
}

describe('task control scope', () => {
  it('captures the control-map constructor before task initialization', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WeakMap')
    if (descriptor === undefined) throw new Error('expected the WeakMap global')
    Object.defineProperty(globalThis, 'WeakMap', {
      ...descriptor,
      value: class PoisonedWeakMap {
        constructor() {
          throw new Error('task-installed WeakMap constructor ran')
        }
      },
    })
    let thrown: unknown
    try {
      createTaskControlScope()
    } catch (error) {
      thrown = error
    } finally {
      Object.defineProperty(globalThis, 'WeakMap', descriptor)
    }
    expect(
      thrown,
      'mutation-verdict:construction:task-control-captured-map-constructor',
    ).toBeUndefined()
  })

  it('captures the control-map read before task initialization', () => {
    const original = WeakMap.prototype.get
    Object.defineProperty(WeakMap.prototype, 'get', {
      configurable: true,
      value: () => ({
        kind: 'suspend',
        reason: 'await-event',
        wake: undefined,
        checkpoint: undefined,
      }),
      writable: true,
    })
    let snapshot: ReturnType<ReturnType<typeof createTaskControlScope>['snapshot']> = undefined
    try {
      const scope = createTaskControlScope()
      snapshot = scope.snapshot(new Error('ordinary'))
    } finally {
      Object.defineProperty(WeakMap.prototype, 'get', {
        configurable: true,
        value: original,
        writable: true,
      })
    }
    expect(snapshot, 'mutation-verdict:construction:task-control-captured-map-get').toBeUndefined()
  })

  it('captures the control-map write before task initialization', () => {
    const original = WeakMap.prototype.set
    Object.defineProperty(WeakMap.prototype, 'set', {
      configurable: true,
      value() {
        return this
      },
      writable: true,
    })
    let snapshot: ReturnType<ReturnType<typeof createTaskControlScope>['snapshot']> = undefined
    try {
      const scope = createTaskControlScope()
      const signal = captureThrown(() => scope.issuer.suspend('await-event'))
      snapshot = scope.snapshot(signal)
    } finally {
      Object.defineProperty(WeakMap.prototype, 'set', {
        configurable: true,
        value: original,
        writable: true,
      })
    }
    expect(snapshot, 'mutation-verdict:construction:task-control-captured-map-set').toEqual({
      kind: 'suspend',
      reason: 'await-event',
      wake: undefined,
      checkpoint: undefined,
    })
  })

  it('owns suspension data and grants authority only to its paired classifier', () => {
    const first = createTaskControlScope()
    const second = createTaskControlScope()
    const wake = { inSeconds: 5 }
    const checkpoint = { key: 'sleep', stateJson: '{"wake":5}' }
    const signal = captureThrown(() => first.issuer.suspend('sleep', wake, checkpoint))
    wake.inSeconds = 99
    checkpoint.key = 'mutated'
    checkpoint.stateJson = 'mutated'
    Object.defineProperty(signal, 'reason', { value: 'await-event' })

    const deadline = { atEpochMs: 1_000_000 }
    const deadlineSignal = captureThrown(() => first.issuer.suspend('sleep', deadline))
    deadline.atEpochMs = 9_999_999
    const deadlineSnapshot = first.snapshot(deadlineSignal)

    const snapshot = first.snapshot(signal)
    expect(
      {
        checkpointed: snapshot?.kind,
        checkpointless: deadlineSnapshot?.kind,
      },
      'mutation-verdict:construction:task-control-suspend-auth',
    ).toEqual({ checkpointed: 'suspend', checkpointless: 'suspend' })
    if (snapshot?.kind !== 'suspend') throw new Error('expected a suspension snapshot')
    expect(snapshot.reason, 'mutation-verdict:construction:task-control-suspend-reason-owned').toBe(
      'sleep',
    )
    expect(
      snapshot.wake,
      'mutation-verdict:construction:task-control-suspend-relative-wake-owned',
    ).toEqual({ inSeconds: 5 })
    expect(
      snapshot.checkpoint?.key,
      'mutation-verdict:construction:task-control-suspend-checkpoint-key-owned',
    ).toBe('sleep')
    expect(
      snapshot.checkpoint?.stateJson,
      'mutation-verdict:construction:task-control-suspend-checkpoint-state-owned',
    ).toBe('{"wake":5}')

    expect(
      deadlineSnapshot?.kind === 'suspend' ? deadlineSnapshot.wake : undefined,
      'mutation-verdict:construction:task-control-suspend-absolute-wake-owned',
    ).toEqual({ atEpochMs: 1_000_000 })
    expect(
      second.snapshot(signal),
      'mutation-verdict:construction:task-control-scope-isolation',
    ).toBeUndefined()
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('ignores an inherited relative-wake discriminant when snapshotting an absolute wake', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'inSeconds')
    Object.defineProperty(Object.prototype, 'inSeconds', {
      configurable: true,
      value: 99,
      writable: true,
    })
    let snapshot: ReturnType<ReturnType<typeof createTaskControlScope>['snapshot']> = undefined
    try {
      const scope = createTaskControlScope()
      const signal = captureThrown(() => scope.issuer.suspend('sleep', { atEpochMs: 1_000_000 }))
      snapshot = scope.snapshot(signal)
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, 'inSeconds')
      else Object.defineProperty(Object.prototype, 'inSeconds', descriptor)
    }
    expect(
      snapshot?.kind === 'suspend' ? snapshot.wake : undefined,
      'mutation-verdict:construction:task-control-absolute-wake-own-discriminant',
    ).toEqual({ atEpochMs: 1_000_000 })
  })

  it('enrolls lease loss minted by the invocation runtime', () => {
    const scope = createTaskControlScope()
    const signal = captureThrown(() => scope.issuer.leaseLost('heartbeat lost the lease'))
    expect(
      scope.snapshot(signal),
      'mutation-verdict:construction:task-control-runtime-lease-auth',
    ).toEqual({ kind: 'lease-lost' })
  })

  it('enrolls typed failures only at the immediate trusted store boundary', async () => {
    const scope = createTaskControlScope()
    const selected = new LeaseLostError('lost', {
      cause: new Error('lease-loss sentinel cause'),
    })
    const control = new LeaseLostError('cause-less control')
    const selectedOutage = new StoreUnavailableError('offline', {
      cause: new Error('store-outage sentinel cause'),
    })
    const outageControl = new StoreUnavailableError('cause-less outage control')

    const selectedRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(selected)),
    )
    const controlRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(control)),
    )
    expect(
      {
        selected: {
          sameError: selectedRejection === selected,
          snapshot: scope.snapshot(selectedRejection),
        },
        control: {
          sameError: controlRejection === control,
          snapshot: scope.snapshot(controlRejection),
        },
      },
      'mutation-verdict:construction:task-control-store-lease-auth',
    ).toEqual({
      selected: { sameError: true, snapshot: { kind: 'lease-lost' } },
      control: { sameError: true, snapshot: { kind: 'lease-lost' } },
    })

    const selectedOutageRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(selectedOutage)),
    )
    const outageControlRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(outageControl)),
    )
    expect(
      {
        selected: {
          sameError: selectedOutageRejection === selectedOutage,
          snapshot: scope.snapshot(selectedOutageRejection),
        },
        control: {
          sameError: outageControlRejection === outageControl,
          snapshot: scope.snapshot(outageControlRejection),
        },
      },
      'mutation-verdict:construction:task-control-store-outage-auth',
    ).toEqual({
      selected: { sameError: true, snapshot: { kind: 'store-unavailable' } },
      control: { sameError: true, snapshot: { kind: 'store-unavailable' } },
    })

    const selectedOrdinary = new Error('ordinary', {
      cause: new Error('ordinary sentinel cause'),
    })
    const ordinaryControl = new Error('cause-less ordinary control')
    const selectedOrdinaryRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(selectedOrdinary)),
    )
    const ordinaryControlRejection = await captureRejected(() =>
      scope.issuer.storeCall(() => Promise.reject(ordinaryControl)),
    )
    expect(
      {
        selected: {
          sameError: selectedOrdinaryRejection === selectedOrdinary,
          snapshot: scope.snapshot(selectedOrdinaryRejection),
        },
        control: {
          sameError: ordinaryControlRejection === ordinaryControl,
          snapshot: scope.snapshot(ordinaryControlRejection),
        },
      },
      'mutation-verdict:construction:task-control-store-typed-only',
    ).toEqual({
      selected: { sameError: true, snapshot: undefined },
      control: { sameError: true, snapshot: undefined },
    })
  })

  it('uses the captured ordinary type check, not a handler-installed hook', () => {
    Object.defineProperty(LeaseLostError, Symbol.hasInstance, {
      configurable: true,
      value: () => true,
    })
    try {
      expect(
        trustedStoreControl(new Error('ordinary')),
        'mutation-verdict:construction:task-control-ordinary-has-instance',
      ).toBeUndefined()
    } finally {
      Reflect.deleteProperty(LeaseLostError, Symbol.hasInstance)
    }

    Object.defineProperty(StoreUnavailableError, Symbol.hasInstance, {
      configurable: true,
      value: () => true,
    })
    try {
      expect(
        trustedStoreControl(new Error('ordinary')),
        'mutation-verdict:construction:task-control-ordinary-store-has-instance',
      ).toBeUndefined()
    } finally {
      Reflect.deleteProperty(StoreUnavailableError, Symbol.hasInstance)
    }
  })

  it('contains hostile values at the trusted store classifier', async () => {
    const revocable = Proxy.revocable(Object.create(null), {})
    revocable.revoke()
    const snapshot = await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'task-control-store-total-fallback' },
      /proxy that has been revoked/,
      async () => trustedStoreControl(revocable.proxy),
    )
    expect(snapshot).toBeUndefined()
  })
})
