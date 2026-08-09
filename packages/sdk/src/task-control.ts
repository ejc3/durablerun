import { LeaseLostError, StoreUnavailableError, SuspendSignal } from '@durablerun/core'
import { taskHasOwn } from './intrinsics.js'

type SuspendControlSnapshot = {
  readonly kind: 'suspend'
  readonly reason: 'sleep' | 'await-event'
  readonly wake: { readonly inSeconds: number } | { readonly atEpochMs: number } | undefined
  readonly checkpoint: { readonly key: string; readonly stateJson: string } | undefined
}

export type InfrastructureControlSnapshot =
  | { readonly kind: 'lease-lost' }
  | { readonly kind: 'store-unavailable' }

export type TaskControlSnapshot = SuspendControlSnapshot | InfrastructureControlSnapshot

/**
 * The half of a per-invocation authority that ReplayContext may hold. The
 * worker retains the paired classifier, and the #private context field keeps
 * task code from enrolling its own public error instances.
 */
export interface TaskControlIssuer {
  suspend(
    reason: 'sleep' | 'await-event',
    wake?: { inSeconds: number } | { atEpochMs: number },
    checkpoint?: { key: string; stateJson: string },
  ): never
  leaseLost(message: string): never
  storeCall<T>(operation: () => Promise<T>): Promise<T>
}

export interface TaskControlScope {
  readonly issuer: TaskControlIssuer
  snapshot(value: unknown): TaskControlSnapshot | undefined
}

const freeze = Object.freeze
const TaskControlMap = WeakMap
const weakMapGet = WeakMap.prototype.get.call.bind(WeakMap.prototype.get) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
) => V | undefined
const weakMapSet = WeakMap.prototype.set.call.bind(WeakMap.prototype.set) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
) => WeakMap<K, V>
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance]
const hasInstance = ordinaryHasInstance.call.bind(ordinaryHasInstance) as (
  errorType: object,
  value: unknown,
) => boolean
const LEASE_LOST = freeze({ kind: 'lease-lost' } as const)
const STORE_UNAVAILABLE = freeze({ kind: 'store-unavailable' } as const)

function isRelativeWake(
  wake: { inSeconds: number } | { atEpochMs: number },
): wake is { inSeconds: number } {
  return taskHasOwn(wake, 'inSeconds')
}

export function trustedStoreControl(error: unknown): InfrastructureControlSnapshot | undefined {
  try {
    if (hasInstance(LeaseLostError, error)) return LEASE_LOST
    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE
  } catch {
    // A hostile proxy is not one of the store's typed infrastructure errors.
  }
  return undefined
}

/**
 * A fresh paired authority for one run invocation. Public constructors and
 * signals captured from another invocation cannot enter this WeakMap.
 */
export function createTaskControlScope(): TaskControlScope {
  const controls = new TaskControlMap<object, TaskControlSnapshot>()

  function enroll(error: object, snapshot: TaskControlSnapshot): never {
    weakMapSet(controls, error, freeze(snapshot))
    throw error
  }

  const issuer: TaskControlIssuer = freeze({
    suspend(
      reason: 'sleep' | 'await-event',
      wake?: { inSeconds: number } | { atEpochMs: number },
      checkpoint?: { key: string; stateJson: string },
    ): never {
      const ownedWake =
        wake === undefined
          ? undefined
          : isRelativeWake(wake)
            ? freeze({ inSeconds: wake.inSeconds })
            : freeze({ atEpochMs: wake.atEpochMs })
      const ownedCheckpoint =
        checkpoint === undefined
          ? undefined
          : freeze({ key: checkpoint.key, stateJson: checkpoint.stateJson })
      return enroll(new SuspendSignal(reason, wake, checkpoint), {
        kind: 'suspend',
        reason,
        wake: ownedWake,
        checkpoint: ownedCheckpoint,
      })
    },

    leaseLost(message: string): never {
      return enroll(new LeaseLostError(message), LEASE_LOST)
    },

    async storeCall<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation()
      } catch (error) {
        const control = trustedStoreControl(error)
        if (control !== undefined && typeof error === 'object' && error !== null) {
          return enroll(error, control)
        }
        throw error
      }
    },
  })

  return freeze({
    issuer,
    snapshot(value: unknown): TaskControlSnapshot | undefined {
      if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
        return undefined
      }
      return weakMapGet(controls, value)
    },
  })
}
