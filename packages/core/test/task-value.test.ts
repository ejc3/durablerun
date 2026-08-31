import { describe, expect, it } from 'vitest'
import {
  FatalTaskError,
  serializeTaskHeaders,
  serializeTaskValue,
  userJsonValue,
} from '../src/index.js'

const ILLEGAL_VALUES: readonly (readonly [string, () => unknown])[] = [
  ['bigint', () => 1n],
  [
    'cycle',
    () => {
      const value: { self?: unknown } = {}
      value.self = value
      return value
    },
  ],
]

describe('serializeTaskValue', () => {
  it('pins top-level undefined to null and preserves canonical JSON lossiness', () => {
    expect(serializeTaskValue('result', undefined)).toBe('null')
    expect(serializeTaskValue('result', { z: -0, u: undefined, n: Number.NaN })).toBe(
      '{"z":0,"n":null}',
    )
  })

  for (const nesting of ['top-level', 'object member', 'array member'] as const) {
    for (const [name, makeValue] of ILLEGAL_VALUES) {
      it(`rejects ${name} at the ${nesting} task-value surface`, () => {
        const illegal = makeValue()
        const value =
          nesting === 'top-level' ? illegal : nesting === 'object member' ? { illegal } : [illegal]
        expect(() => serializeTaskValue('result', value)).toThrow(FatalTaskError)
      })
    }
  }

  it('rejects symbol at the top-level task-value surface', () => {
    expect(() => serializeTaskValue('result', Symbol('not-json'))).toThrow(FatalTaskError)
  })

  it('rejects every JSON string position that cannot round-trip through storage', () => {
    const invalid = [
      ['NUL', '\u0000'],
      ['high lone surrogate', '\uD800'],
      ['low lone surrogate', '\uDC00'],
    ] as const

    for (const [kind, text] of invalid) {
      expect(() => serializeTaskHeaders('task headers', { value: text }), `${kind} value`).toThrow(
        FatalTaskError,
      )
      expect(
        () => serializeTaskHeaders('task headers', { [text]: 'value' }),
        `${kind} key`,
      ).toThrow(FatalTaskError)
    }
    expect(serializeTaskHeaders('task headers', { '📦': 'välue' })).toBe('{"📦":"välue"}')
  })

  it('snapshots each header value exactly once', () => {
    let reads = 0
    const headers = {
      get trace(): string {
        reads += 1
        if (reads > 1) throw new Error('header getter read twice')
        return 'value'
      },
    }

    expect(serializeTaskHeaders('task headers', headers)).toBe('{"trace":"value"}')
    expect(reads).toBe(1)
  })

  it('preserves escaped NUL and lone surrogates in opaque JSON values', () => {
    expect(serializeTaskValue('result', '\u0000')).toBe('"\\u0000"')
    expect(serializeTaskValue('result', '\uD800')).toBe('"\\ud800"')
    expect(serializeTaskValue('result', '\uDC00')).toBe('"\\udc00"')
    expect(userJsonValue('event payload', '"\\u0000"')).toBe('"\\u0000"')
  })

  it('classifies a serialization hook whose thrown value cannot be coerced', () => {
    const hostile = {
      [Symbol.toPrimitive](): never {
        throw new Error('coercion must not run')
      },
      toString(): never {
        throw new Error('coercion must not run')
      },
    }
    const value = {
      toJSON(): never {
        throw hostile
      },
    }

    expect(() => serializeTaskValue('result', value)).toThrow(FatalTaskError)
  })

  it('is also the canonical serializer behind JSON-text event payloads', () => {
    expect(userJsonValue('event payload', `{ "a": 1, "b": null }`)).toBe('{"a":1,"b":null}')
  })

  it('rejects objects outside the explicit JSON data model instead of changing their meaning', () => {
    expect(
      () => serializeTaskValue('result', new Number(7)),
      'mutation-verdict:behavior:task-value-rejects-exotic-objects',
    ).toThrow(FatalTaskError)
    for (const value of [new Boolean(true), new String('ab'), Object(1n)]) {
      expect(() => serializeTaskValue('result', value)).toThrow(FatalTaskError)
    }
    expect(serializeTaskValue('result', new Date(0))).toBe('"1970-01-01T00:00:00.000Z"')
  })
})
