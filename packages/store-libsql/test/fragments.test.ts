import { describe, expect, it } from 'vitest'
import { cancelDue, epochAdditionFits, storedInteger } from '../src/fragments.js'

describe('cancellation deadline fragments', () => {
  it('groups the whole due predicate for safe composition', () => {
    expect(cancelDue('t', '$NOW$')).toBe(
      `((typeof(t.cancel_at_ms) = 'integer' AND t.cancel_at_ms BETWEEN 0 AND 253402300799000)
    AND t.cancel_at_ms <= $NOW$)`,
    )
  })
})

describe('epoch-addition fragments', () => {
  it('emits each anonymous duration placeholder exactly once', () => {
    const sql = epochAdditionFits('$NOW$', '?', '?')
    expect(
      sql.match(/\?/g),
      'mutation-verdict:construction:timestamp-addition-single-use-deltas',
    ).toHaveLength(2)
    expect(sql).toContain('253402300799000 - ((?) + (?))')
  })
})

describe('storage-class fragments', () => {
  it('requires SQLite INTEGER storage before copying a durable counter', () => {
    expect(storedInteger('f.attempt')).toBe(`typeof(f.attempt) = 'integer'`)
  })
})
