import { describe, expect, it } from 'vitest'
import { FENCE_SET, FencedBatch, type SqlExecutor } from '../src/index.js'
import {
  attributeExpectedFailure,
  attributeReplacedFailure,
  requireExpectedFailure,
} from '../src/testing.js'

const marker = 'mutation-verdict:behavior:testing-helper'
const verdict = { kind: 'behavior', mutation: 'testing-helper' } as const
const expected = new Error('expected')
const unrelated = new Error('unrelated')

async function bindArityFailure(): Promise<never> {
  const unreachable: SqlExecutor = {
    batch: async () => {
      throw new Error('bind-arity failure reached the executor')
    },
  }
  const batch = new FencedBatch('testing-helper', 'seed', { now: 'CURRENT_TIMESTAMP' }).cas(
    'win',
    'runs',
    `UPDATE runs SET ${FENCE_SET} WHERE run_id = ? AND queue = ?`,
    ['only-one'],
  )
  await batch.run(unreachable)
  throw new Error('bind-arity failure unexpectedly returned')
}

async function requireBindArityPropagation(
  mutation: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (/binds 2 of 1 explicit args/.test(String(error))) return
    if (error instanceof Error && error.message === marker) {
      throw new Error(`mutation-verdict:behavior:${mutation}`)
    }
    throw error
  }
  throw new Error(`mutation-verdict:behavior:${mutation}`)
}

describe('mutation verdict promise helpers', () => {
  it('does not attribute a bind-arity failure as an expected failure', async () => {
    await requireBindArityPropagation('testing-helper-bind-arity-attribute', () =>
      attributeExpectedFailure(verdict, /.*/, bindArityFailure),
    )
  })

  it('does not accept a bind-arity failure as the required failure', async () => {
    await requireBindArityPropagation('testing-helper-bind-arity-require', () =>
      requireExpectedFailure(verdict, /.*/, bindArityFailure),
    )
  })

  it('does not attribute a bind-arity failure as a replacement failure', async () => {
    await requireBindArityPropagation('testing-helper-bind-arity-replacement', () =>
      attributeReplacedFailure(verdict, /expected healthy failure/, /.*/, bindArityFailure),
    )
  })

  it('returns an operation that succeeds as expected', async () => {
    await expect(attributeExpectedFailure(verdict, /expected/, async () => 1)).resolves.toBe(1)
  })

  it('attributes only the named unexpected rejection', async () => {
    await expect(
      attributeExpectedFailure(
        verdict,
        (error) => error === expected,
        async () => {
          throw expected
        },
      ),
    ).rejects.toThrow(marker)
    await expect(
      attributeExpectedFailure(
        verdict,
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
        verdict,
        (error) => error === expected,
        async () => {
          throw expected
        },
      ),
    ).resolves.toBeUndefined()
  })

  it('attributes an unexpected success directly', async () => {
    await expect(
      requireExpectedFailure(verdict, /expected/, async () => undefined),
    ).rejects.toThrow(marker)
  })

  it('propagates an unrelated rejection unchanged', async () => {
    await expect(
      requireExpectedFailure(
        verdict,
        (error) => error === expected,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toBe(unrelated)
  })

  it('keeps reusable regular-expression matchers stateless', async () => {
    const reusable = /expected/g
    for (let run = 0; run < 2; run += 1) {
      await expect(
        requireExpectedFailure(verdict, reusable, async () => {
          throw expected
        }),
      ).resolves.toBeUndefined()
    }
  })

  it('attributes only the named replacement for an expected failure', async () => {
    await expect(
      attributeReplacedFailure(
        verdict,
        (error) => error === expected,
        (error) => error === unrelated,
        async () => {
          throw expected
        },
      ),
    ).resolves.toBeUndefined()
    await expect(
      attributeReplacedFailure(
        verdict,
        (error) => error === expected,
        (error) => error === unrelated,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toThrow(marker)
  })

  it('owns canonical marker construction instead of accepting decorated strings', async () => {
    await expect(
      attributeReplacedFailure(
        verdict,
        (error) => error === expected,
        (error) => error === unrelated,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toThrow(marker)

    await expect(
      attributeReplacedFailure(
        { kind: 'behavior', mutation: 'testing-helper: diagnostic suffix' },
        (error) => error === expected,
        (error) => error === unrelated,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toThrow('invalid mutation verdict name')
  })

  it('does not attribute success or a third rejection as a replacement failure', async () => {
    const third = new Error('third')
    await expect(
      attributeReplacedFailure(
        verdict,
        (error) => error === expected,
        (error) => error === unrelated,
        async () => undefined,
      ),
    ).rejects.not.toThrow(marker)
    await expect(
      attributeReplacedFailure(
        verdict,
        (error) => error === expected,
        (error) => error === unrelated,
        async () => {
          throw third
        },
      ),
    ).rejects.toBe(third)
  })
})
