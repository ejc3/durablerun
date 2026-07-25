import { describe, expect, it } from 'vitest'
import { FatalTaskError, UserName } from '../src/index.js'

/**
 * UserName is the single mint point for durable replay keys, so it must
 * reject every name that would not survive a round-trip through storage —
 * otherwise two distinct JS names collide, or a name is silently truncated
 * and its wake never matches. (Codex PR#11 finding 5.)
 */
describe('UserName.parse rejects non-round-tripping names', () => {
  it('rejects reserved characters (the existing contract)', () => {
    expect(() => UserName.parse('step name', 'a#b')).toThrow(FatalTaskError)
    expect(() => UserName.parse('step name', '$x')).toThrow(FatalTaskError)
  })

  it('rejects an embedded NUL (SQLite truncates a TEXT value at the first NUL)', () => {
    // 'a\u0000b' would be read back as 'a', so its wake could never match.
    expect(() => UserName.parse('event name', 'a\u0000b')).toThrow(FatalTaskError)
  })

  it('rejects a lone surrogate (not well-formed UTF-16 → re-encoded to U+FFFD)', () => {
    // A high and a low lone surrogate both re-encode to the same replacement
    // char, so two distinct JS names would collide and cross-deliver.
    expect(() => UserName.parse('event name', 'go\uD800')).toThrow(FatalTaskError)
    expect(() => UserName.parse('event name', 'go\uDC00')).toThrow(FatalTaskError)
  })

  it('rejects a value that is not a string at all', () => {
    // JavaScript callers, decoded JSON, and `any` all reach here. Calling
    // .includes() on a non-string throws a plain TypeError, which the worker
    // classifies as an ordinary user failure and RETRIES — so one
    // deterministic bad call is re-run up to maxAttempts, repeating whatever
    // the handler did before it each time. Deterministic bad input must be
    // permanent, which is what FatalTaskError means here.
    for (const bad of [undefined, null, 42, {}, ['a'], Symbol('s')]) {
      expect(() => UserName.parse('step name', bad as unknown as string)).toThrow(FatalTaskError)
    }
  })

  it('accepts ordinary names, including non-ASCII that round-trips', () => {
    expect(UserName.parse('event name', 'order.shipped').value).toBe('order.shipped')
    expect(UserName.parse('event name', 'näme').value).toBe('näme')
    expect(UserName.parse('event name', '📦').value).toBe('📦')
  })
})
