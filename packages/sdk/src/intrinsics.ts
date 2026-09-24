/** Durable SDK operations captured before task initialization can replace them. */

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const reflectApply = Reflect.apply
const reflectGet = Reflect.get
const hasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty) as (
  value: object,
  key: PropertyKey,
) => boolean

const controllerSignalGetter = getOwnPropertyDescriptor(AbortController.prototype, 'signal')?.get
const signalAbortedGetter = getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
if (controllerSignalGetter === undefined || signalAbortedGetter === undefined) {
  throw new Error('AbortController intrinsics are unavailable')
}

export const TaskAbortController = AbortController
export const abortControllerAbort = AbortController.prototype.abort.call.bind(
  AbortController.prototype.abort,
) as (controller: AbortController, reason?: unknown) => void
export const abortControllerSignal = controllerSignalGetter.call.bind(controllerSignalGetter) as (
  controller: AbortController,
) => AbortSignal
export const abortSignalAborted = signalAbortedGetter.call.bind(signalAbortedGetter) as (
  signal: AbortSignal,
) => boolean

export const TaskMap = Map
const capturedTaskMapGet = Map.prototype.get.call.bind(Map.prototype.get) as <K, V>(
  map: Map<K, V>,
  key: K,
) => V | undefined
export const taskMapGet = capturedTaskMapGet
export const taskMapHas = Map.prototype.has.call.bind(Map.prototype.has) as <K, V>(
  map: Map<K, V>,
  key: K,
) => boolean
export const taskMapSet = Map.prototype.set.call.bind(Map.prototype.set) as <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
) => Map<K, V>
export const taskMapDelete = Map.prototype.delete.call.bind(Map.prototype.delete) as <K, V>(
  map: Map<K, V>,
  key: K,
) => boolean

/**
 * A Map registry is data: its stored entries, not an overridable `get`, grant
 * handler authority. Calling the captured native operation makes that rule
 * identical for Maps and Map subclasses after task-installed prototype
 * replacement. A structural ReadonlyMap remains an explicitly trusted host
 * resolver, so its own implementation is responsible for its dependencies.
 */
export function taskRegistryGet<K, V>(registry: ReadonlyMap<K, V>, key: K): V | undefined {
  try {
    return capturedTaskMapGet(registry as Map<K, V>, key)
  } catch {
    // Structural maps and proxies have no authentic Map internal slot. Their
    // resolver is trusted host code rather than SDK-owned durable machinery.
  }
  const method = reflectGet(registry, 'get')
  return reflectApply(method as CallableFunction, registry, [key]) as V | undefined
}
export const taskHasOwn = hasOwn

export const TaskPromise = Promise
const taskPromiseThen = Promise.prototype.then.call.bind(Promise.prototype.then) as <T>(
  promise: Promise<T>,
  onFulfilled: (value: T) => void,
  onRejected: (reason: unknown) => void,
) => Promise<void>

/** Two-input race with no ambient Promise.resolve or iterator dispatch. */
export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {
  return new TaskPromise<void>((resolve, reject) => {
    taskPromiseThen(left, resolve, reject)
    taskPromiseThen(right, resolve, reject)
  })
}
export const trustedCharCodeAt = String.prototype.charCodeAt.call.bind(
  String.prototype.charCodeAt,
) as (value: string, index: number) => number
export const trustedStartsWith = String.prototype.startsWith.call.bind(
  String.prototype.startsWith,
) as (value: string, prefix: string) => boolean
export const trustedSliceFrom = String.prototype.slice.call.bind(String.prototype.slice) as (
  value: string,
  start: number,
) => string
export const trustedIsSafeInteger = Number.isSafeInteger
const capturedSort = Array.prototype.sort.call.bind(Array.prototype.sort) as (
  values: number[],
  compare: (left: number, right: number) => number,
) => number[]
/** Ascending, in place, by the captured sort. */
export function trustedSortNumbers(values: number[]): void {
  capturedSort(values, (left, right) => left - right)
}
