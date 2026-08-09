import { describe, expect, it } from 'vitest'
import {
  FatalTaskError,
  UserName,
  decideRetry,
  normalizeRetryStrategy,
  retryDelaySeconds,
  serializeTaskValue,
  userDurationToMs,
  userJsonValue,
} from '../src/index.js'

function replaceProperty<T>(
  target: object,
  key: PropertyKey,
  replacement: T,
  action: () => unknown,
): { value?: unknown; error?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    configurable: true,
    value: replacement,
    writable: true,
  })
  try {
    return { value: action() }
  } catch (error) {
    return { error }
  } finally {
    if (descriptor === undefined) delete (target as Record<PropertyKey, unknown>)[key]
    else Object.defineProperty(target, key, descriptor)
  }
}

describe('trusted task-boundary intrinsics', () => {
  it('normalizes retry fields with the module-captured Reflect.get', () => {
    const observed = replaceProperty(
      Reflect,
      'get',
      () => 'none',
      () => decideRetry({ kind: 'fixed', baseSeconds: 30 }, 1, 2),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-reflect-get').toEqual({
      value: { retry: true, delaySeconds: 30 },
    })
  })

  it('freezes retry data with the module-captured Object.freeze', () => {
    const observed = replaceProperty(
      Object,
      'freeze',
      () => ({ kind: 'none' }),
      () => decideRetry({ kind: 'fixed', baseSeconds: 30 }, 1, 2),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-freeze').toEqual({
      value: { retry: true, delaySeconds: 30 },
    })
  })

  it('checks retry finiteness with the module-captured Number.isFinite', () => {
    const observed = replaceProperty(
      Number,
      'isFinite',
      () => false,
      () => decideRetry({ kind: 'fixed', baseSeconds: 30 }, 1, 2),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-is-finite').toEqual({
      value: { retry: true, delaySeconds: 30 },
    })
  })

  it('checks retry ordinals with the module-captured Number.isSafeInteger', () => {
    const observed = replaceProperty(
      Number,
      'isSafeInteger',
      () => false,
      () => decideRetry({ kind: 'fixed', baseSeconds: 30 }, 1, 2),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-is-safe-integer').toEqual({
      value: { retry: true, delaySeconds: 30 },
    })
  })

  it('rounds retry durations with the module-captured Math.round', () => {
    const observed = replaceProperty(
      Math,
      'round',
      () => 0,
      () => retryDelaySeconds({ kind: 'fixed', baseSeconds: 30 }, 1),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-round').toEqual({ value: 30 })
  })

  it('caps retry delays with the module-captured Math.min', () => {
    const observed = replaceProperty(
      Math,
      'min',
      () => 0,
      () =>
        retryDelaySeconds({ kind: 'exponential', baseSeconds: 10, factor: 2, maxSeconds: 100 }, 2),
    )
    expect(observed, 'mutation-verdict:construction:retry-captured-min').toEqual({ value: 20 })
  })

  it('rejects invalid retry data with the module-captured RangeError', () => {
    class PoisonedRangeError extends Error {}
    const observed = replaceProperty(globalThis, 'RangeError', PoisonedRangeError, () =>
      normalizeRetryStrategy({ kind: 'future' }),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:retry-captured-range-error',
    ).toBeInstanceOf(RangeError)
  })

  it('serializes task values with the module-captured JSON.stringify', () => {
    const observed = replaceProperty(
      JSON,
      'stringify',
      () => '{"forged":true}',
      () => serializeTaskValue('result', { real: true }),
    )
    expect(observed, 'mutation-verdict:construction:task-value-captured-stringify').toEqual({
      value: '{"real":true}',
    })
  })

  it('parses task JSON with the module-captured JSON.parse', () => {
    const observed = replaceProperty(
      JSON,
      'parse',
      () => ({ forged: true }),
      () => userJsonValue('payload', '{"real":true}'),
    )
    expect(observed, 'mutation-verdict:construction:task-value-captured-parse').toEqual({
      value: '{"real":true}',
    })
  })

  it('classifies invalid task JSON with the module-captured Array.isArray', () => {
    const observed = replaceProperty(
      Array,
      'isArray',
      () => {
        throw new Error('poisoned Array.isArray ran')
      },
      () => userJsonValue('payload', [] as never),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:task-value-captured-is-array',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('classifies invalid task durations with the module-captured String', () => {
    const observed = replaceProperty(
      globalThis,
      'String',
      () => {
        throw new Error('poisoned String ran')
      },
      () => userDurationToMs('duration', Number.NaN),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:task-value-captured-string',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('does not use mutable FatalTaskError instanceof classification', () => {
    const observed = replaceProperty(
      FatalTaskError,
      Symbol.hasInstance,
      () => true,
      () => userJsonValue('payload', '{'),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:task-value-no-fatal-instanceof',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('checks reserved name characters with the module-captured String.includes', () => {
    const observed = replaceProperty(
      String.prototype,
      'includes',
      () => false,
      () => UserName.parse('step name', 'unsafe#name'),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:user-name-captured-includes',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('checks reserved name prefixes with the module-captured String.startsWith', () => {
    const observed = replaceProperty(
      String.prototype,
      'startsWith',
      () => false,
      () => UserName.parse('step name', '$unsafe'),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:user-name-captured-starts-with',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('checks storage-unsafe names with the module-captured RegExp.test', () => {
    const observed = replaceProperty(
      RegExp.prototype,
      'test',
      () => false,
      () => UserName.parse('step name', '\ud800'),
    )
    expect(
      observed.error,
      'mutation-verdict:construction:user-name-captured-regexp-test',
    ).toBeInstanceOf(FatalTaskError)
  })

  for (const [name, target, value] of [
    ['function', Function.prototype, () => undefined],
    ['bigint', BigInt.prototype, 1n],
  ] as const) {
    it(`rejects a ${name} before a prototype toJSON can disguise it`, () => {
      const observed = replaceProperty(
        target,
        'toJSON',
        () => 7,
        () => serializeTaskValue('result', value),
      )
      expect(
        observed.error,
        `mutation-verdict:behavior:task-value-raw-${name}-before-to-json`,
      ).toBeInstanceOf(FatalTaskError)
    })
  }

  it('rejects a cycle before Object.prototype.toJSON can disguise it', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const observed = replaceProperty(
      Object.prototype,
      'toJSON',
      () => 7,
      () => serializeTaskValue('result', cyclic),
    )
    expect(
      observed.error,
      'mutation-verdict:behavior:task-value-raw-cycle-before-to-json',
    ).toBeInstanceOf(FatalTaskError)
  })

  it('snapshots plain objects before Object.prototype.toJSON can forge them', () => {
    const observed = replaceProperty(
      Object.prototype,
      'toJSON',
      () => ({ forged: true }),
      () => serializeTaskValue('result', { real: true }),
    )
    expect(observed, 'mutation-verdict:behavior:task-value-owned-object-snapshot').toEqual({
      value: '{"real":true}',
    })
  })

  it('serializes dates with the captured Date operation instead of a replaced toJSON', () => {
    const observed = replaceProperty(
      Date.prototype,
      'toJSON',
      () => 'forged',
      () => serializeTaskValue('result', { at: new Date(0) }),
    )
    expect(observed, 'mutation-verdict:behavior:task-value-owned-date-snapshot').toEqual({
      value: '{"at":"1970-01-01T00:00:00.000Z"}',
    })
  })

  it('does not dispatch storage-safe name checks through mutable RegExp.exec', () => {
    const observed = replaceProperty(
      RegExp.prototype,
      'exec',
      () => null,
      () => UserName.parse('step name', '\ud800'),
    )
    expect(
      observed.error,
      'mutation-verdict:behavior:user-name-captured-regexp-exec',
    ).toBeInstanceOf(FatalTaskError)
  })
})
