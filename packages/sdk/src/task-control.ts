import {
  type CheckpointWrite,
  type ClaimedRun,
  type LeaseEnd,
  LeaseLostError,
  PermanentStoreError,
  RunCancelledError,
  StoreUnavailableError,
  SuspendSignal,
  type WakeSpec,
} from '@durablerun/core'
import { taskHasOwn } from './intrinsics.js'

type SuspendControlSnapshot =
  | {
      readonly kind: 'sleep'
      readonly wake: Readonly<WakeSpec>
      readonly checkpoint: Readonly<CheckpointWrite>
    }
  | { readonly kind: 'await-event' }

/**
 * The forward phase is frozen once a task is rolling back (DESIGN.md §3.10), so a pass's
 * replay of the task function ends at the first durable call it has no memo for.
 */
type SagaControlSnapshot = { readonly kind: 'rollback-phase' }

export type InfrastructureControlSnapshot =
  | { readonly kind: 'lease-lost' }
  | { readonly kind: 'run-cancelled' }
  | { readonly kind: 'store-unavailable' }
  | { readonly kind: 'store-permanent' }

export type TaskControlSnapshot =
  | SuspendControlSnapshot
  | SagaControlSnapshot
  | InfrastructureControlSnapshot

/**
 * The half of a per-invocation authority that ReplayContext may hold. The
 * worker retains the paired classifier, and the #private context field keeps
 * task code from enrolling its own public error instances.
 */
export interface TaskControlIssuer {
  sleep(wake: WakeSpec, checkpoint: CheckpointWrite): never
  awaitEvent(): never
  rollbackPhase(): never
  leaseEnded(reason: LeaseEnd, run: Pick<ClaimedRun, 'runId'>): never
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
const AWAIT_EVENT = freeze({ kind: 'await-event' } as const)
const ROLLBACK_PHASE = freeze({ kind: 'rollback-phase' } as const)
const LEASE_LOST = freeze({ kind: 'lease-lost' } as const)
const RUN_CANCELLED = freeze({ kind: 'run-cancelled' } as const)
const STORE_UNAVAILABLE = freeze({ kind: 'store-unavailable' } as const)
const STORE_PERMANENT = freeze({ kind: 'store-permanent' } as const)

function isRelativeWake(wake: WakeSpec): wake is { inSeconds: number } {
  return taskHasOwn(wake, 'inSeconds')
}

export function trustedStoreControl(error: unknown): InfrastructureControlSnapshot | undefined {
  try {
    if (hasInstance(RunCancelledError, error)) return RUN_CANCELLED
    if (hasInstance(LeaseLostError, error)) return LEASE_LOST
    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE
    // A permanent answer of the store is infrastructure too. Left to fall through, it would
    // reach task code as an ordinary error and be billed to the task's own attempts.
    if (hasInstance(PermanentStoreError, error)) return STORE_PERMANENT
  } catch {
    // A hostile proxy is not one of the store's typed infrastructure errors.
  }
  return undefined
}

/** What a frozen forward phase throws. Task code that catches it meets it again at its next durable call. */
class RollbackPhaseSignal extends Error {
  override readonly name = 'RollbackPhaseSignal'
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
    sleep(wake: WakeSpec, checkpoint: CheckpointWrite): never {
      const ownedWake = isRelativeWake(wake)
        ? freeze({ inSeconds: wake.inSeconds })
        : freeze({ atEpochMs: wake.atEpochMs })
      const ownedCheckpoint = freeze({ key: checkpoint.key, stateJson: checkpoint.stateJson })
      return enroll(new SuspendSignal('sleep', wake, checkpoint), {
        kind: 'sleep',
        wake: ownedWake,
        checkpoint: ownedCheckpoint,
      })
    },

    awaitEvent(): never {
      return enroll(new SuspendSignal('await-event'), AWAIT_EVENT)
    },

    rollbackPhase(): never {
      return enroll(
        new RollbackPhaseSignal('the task is rolling back, so its forward phase is frozen'),
        ROLLBACK_PHASE,
      )
    },

    leaseEnded(reason: LeaseEnd, run: Pick<ClaimedRun, 'runId'>): never {
      switch (reason) {
        case 'cancelled': {
          const message = `task cancelled during pass (run ${run.runId})`
          return enroll(new RunCancelledError(message), RUN_CANCELLED)
        }
        case 'lease-lost': {
          const message = `lease lost during pass (run ${run.runId})`
          return enroll(new LeaseLostError(message), LEASE_LOST)
        }
        default:
          throw new TypeError(`unknown lease end: ${String(reason satisfies never)}`)
      }
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
