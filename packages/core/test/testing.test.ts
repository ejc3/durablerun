import { describe, expect, it } from 'vitest'
import { attributeExpectedFailure, requireExpectedFailure } from '../src/testing.js'

const marker = 'mutation-verdict:behavior:testing-helper'
const expected = new Error('expected')
const unrelated = new Error('unrelated')

describe('mutation verdict promise helpers', () => {
  it('returns an operation that succeeds as expected', async () => {
    await expect(attributeExpectedFailure(marker, /expected/, async () => 1)).resolves.toBe(1)
  })

  it('attributes only the named unexpected rejection', async () => {
    await expect(
      attributeExpectedFailure(
        marker,
        (error) => error === expected,
        async () => {
          throw expected
        },
      ),
    ).rejects.toThrow(marker)
    await expect(
      attributeExpectedFailure(
        marker,
        (error) => error === expected,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toBe(unrelated)
  })

  it('accepts the named healthy rejection', async () => {
    await expect(
      requireExpectedFailure(
        marker,
        (error) => error === expected,
        async () => {
          throw expected
        },
      ),
    ).resolves.toBeUndefined()
  })

  it('attributes an unexpected success directly', async () => {
    await expect(requireExpectedFailure(marker, /expected/, async () => undefined)).rejects.toThrow(
      marker,
    )
  })

  it('propagates an unrelated rejection unchanged', async () => {
    await expect(
      requireExpectedFailure(
        marker,
        (error) => error === expected,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toBe(unrelated)
  })
})
