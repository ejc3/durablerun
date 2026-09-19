/**
 * JavaScript operations trusted by durable classification and encoding boundaries.
 *
 * Task modules and handlers share a realm with the SDK today, so ambient
 * globals and prototype methods are mutable after these modules load. Capture
 * each safety-critical operation once and call only the captured function: a
 * task may replace the public property, but it cannot replace this lexical binding.
 *
 * This module is internal. Consumers expose behavior, never these capabilities.
 */
const freeze = Object.freeze

const dateGetTime = Date.prototype.getTime.call.bind(Date.prototype.getTime) as (
  value: object,
) => number
const dateToISOString = Date.prototype.toISOString.call.bind(Date.prototype.toISOString) as (
  value: object,
) => string
const regexpExec = RegExp.prototype.exec.call.bind(RegExp.prototype.exec) as (
  expression: RegExp,
  value: string,
) => RegExpExecArray | null
const stringCharCodeAt = String.prototype.charCodeAt.call.bind(String.prototype.charCodeAt) as (
  value: string,
  index: number,
) => number
const stringIncludes = String.prototype.includes.call.bind(String.prototype.includes) as (
  value: string,
  search: string,
) => boolean
const stringStartsWith = String.prototype.startsWith.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean
const objectHasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty) as (
  value: object,
  key: PropertyKey,
) => boolean
const weakMapGet = WeakMap.prototype.get.call.bind(WeakMap.prototype.get) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
) => V | undefined
const weakMapSet = WeakMap.prototype.set.call.bind(WeakMap.prototype.set) as <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
) => WeakMap<K, V>
const weakSetAdd = WeakSet.prototype.add.call.bind(WeakSet.prototype.add) as <T extends object>(
  set: WeakSet<T>,
  value: T,
) => WeakSet<T>
const weakSetDelete = WeakSet.prototype.delete.call.bind(WeakSet.prototype.delete) as <
  T extends object,
>(
  set: WeakSet<T>,
  value: T,
) => boolean
const weakSetHas = WeakSet.prototype.has.call.bind(WeakSet.prototype.has) as <T extends object>(
  set: WeakSet<T>,
  value: T,
) => boolean

export const TASK_INTRINSICS = freeze({
  ArrayBufferIsView: ArrayBuffer.isView,
  ArrayIsArray: Array.isArray,
  BigIntFrom: BigInt,
  DateGetTime: dateGetTime,
  DateToISOString: dateToISOString,
  JSONParse: JSON.parse,
  JSONStringify: JSON.stringify,
  MathMin: Math.min,
  MathRound: Math.round,
  NumberFrom: Number,
  NumberIsFinite: Number.isFinite,
  NumberIsSafeInteger: Number.isSafeInteger,
  ObjectCreate: Object.create,
  ObjectDefineProperty: Object.defineProperty,
  ObjectFreeze: freeze,
  ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  ObjectGetPrototypeOf: Object.getPrototypeOf,
  ObjectHasOwn: objectHasOwn,
  ObjectKeys: Object.keys,
  ObjectPrototype: Object.prototype,
  RangeError,
  ReflectGet: Reflect.get,
  RegExpExec: regexpExec,
  Set,
  StringCharCodeAt: stringCharCodeAt,
  StringFrom: String,
  StringIncludes: stringIncludes,
  StringStartsWith: stringStartsWith,
  TypeError,
  WeakMap,
  WeakMapGet: weakMapGet,
  WeakMapSet: weakMapSet,
  WeakSet,
  WeakSetAdd: weakSetAdd,
  WeakSetDelete: weakSetDelete,
  WeakSetHas: weakSetHas,
})
