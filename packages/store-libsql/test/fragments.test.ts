import { describe, expect, it } from 'vitest'
import { cancelDue, storedInteger } from '../src/fragments.js'

describe('cancellation deadline fragments', () => {
  it('groups the whole due predicate for safe composition', () => {
    expect(cancelDue('t.cancel_at_ms', '$NOW$')).toBe(
      '(t.cancel_at_ms IS NOT NULL AND t.cancel_at_ms <= $NOW$)',
    )
  })
})

describe('storage-class fragments', () => {
  it('requires SQLite INTEGER storage before copying a durable counter', () => {
    expect(storedInteger('f.attempt')).toBe(`typeof(f.attempt) = 'integer'`)
  })
})
