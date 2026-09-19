import { describe, expect, it } from 'vitest'
import { decodeTaskOutcome, encodeTaskOutcome } from '../src/index.js'

describe("a completion event's payload, read by a build that does not know one of its fields", () => {
  it('reads the state and the fields it knows, and ignores any other', () => {
    const known = { state: 'failed', failureReasonJson: '{"name":"E"}' } as const
    const widened = JSON.stringify({ ...known, rollback: { outcome: 'failed' }, later: 1 })
    expect(decodeTaskOutcome('t', widened)).toEqual(known)
    expect(decodeTaskOutcome('t', widened)).toEqual(
      decodeTaskOutcome('t', encodeTaskOutcome(known)),
    )
  })
})
