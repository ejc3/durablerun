import { describe, expect, it } from 'vitest'
import { FENCE_SET, FencedBatch, type SqlExecutor, isFencedBatchBindError } from '../src/index.js'
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

async function bindUnusedArgumentFailure(): Promise<never> {
  const unreachable: SqlExecutor = {
    batch: async () => {
      throw new Error('unused-argument failure reached the executor')
    },
  }
  const batch = new FencedBatch('testing-helper', 'seed', { now: 'CURRENT_TIMESTAMP' }).cas(
    'win',
    'runs',
    `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`,
    ['run', 'unused'],
  )
  await batch.run(unreachable)
  throw new Error('unused-argument failure unexpectedly returned')
}

async function bindUndefinedFailure(): Promise<never> {
  const unreachable: SqlExecutor = {
    batch: async () => {
      throw new Error('undefined-bind failure reached the executor')
    },
  }
  const batch = new FencedBatch('testing-helper', 'seed', { now: 'CURRENT_TIMESTAMP' }).cas(
    'win',
    'runs',
    `UPDATE runs SET ${FENCE_SET} WHERE run_id = ? AND queue = ?`,
    ['run', undefined as unknown as string],
  )
  await batch.run(unreachable)
  throw new Error('undefined-bind failure unexpectedly returned')
}

async function observeCompilerBindPropagation(
  expectedFailure: RegExp,
  action: () => Promise<unknown>,
): Promise<'propagated' | 'attributed' | 'returned' | `unexpected:${string}`> {
  try {
    await action()
    return 'returned'
  } catch (error) {
    if (expectedFailure.test(String(error))) return 'propagated'
    if (error instanceof Error && error.message === marker) {
      return 'attributed'
    }
    return `unexpected:${String(error)}`
  }
}

describe('mutation verdict promise helpers', () => {
  it('authenticates both compiler bind producers before every caller matcher', async () => {
    let arityFailure: unknown
    try {
      await bindArityFailure()
    } catch (error) {
      arityFailure = error
    }
    const undefinedProducer = await observeCompilerBindPropagation(/argument 1 is undefined/, () =>
      attributeExpectedFailure(verdict, /.*/, bindUndefinedFailure),
    )

    const originalError = Object.getOwnPropertyDescriptor(globalThis, 'Error')
    const originalTypeError = Object.getOwnPropertyDescriptor(globalThis, 'TypeError')
    if (originalError === undefined || originalTypeError === undefined) {
      throw new Error('expected Error constructors on globalThis')
    }
    function PoisonedError(): object {
      return function taskInstalledError() {}
    }

    let observed: unknown
    try {
      Object.defineProperty(globalThis, 'Error', { ...originalError, value: PoisonedError })
      Object.defineProperty(globalThis, 'TypeError', { ...originalTypeError, value: PoisonedError })
      try {
        await attributeExpectedFailure(verdict, /.*/, bindArityFailure)
      } catch (error) {
        observed = error
      }
    } finally {
      Object.defineProperty(globalThis, 'TypeError', originalTypeError)
      Object.defineProperty(globalThis, 'Error', originalError)
    }

    const missingArgument = await observeCompilerBindPropagation(
      /binds 2 of 1 explicit args/,
      bindArityFailure,
    )
    const unusedArgument = await observeCompilerBindPropagation(
      /binds 1 of 2 explicit args/,
      bindUnusedArgumentFailure,
    )

    expect(
      {
        producers: {
          arityBrand: isFencedBatchBindError(arityFailure),
          undefined: undefinedProducer,
          capturedConstructor: observed instanceof (originalTypeError.value as ErrorConstructor),
          poisonedConstructorBrand: isFencedBatchBindError(observed),
        },
        bindCounts: {
          missingArgument,
          unusedArgument,
        },
        consumers: {
          attribute: await observeCompilerBindPropagation(/binds 2 of 1 explicit args/, () =>
            attributeExpectedFailure(verdict, /.*/, bindArityFailure),
          ),
          require: await observeCompilerBindPropagation(/binds 2 of 1 explicit args/, () =>
            requireExpectedFailure(verdict, /.*/, bindArityFailure),
          ),
          replacement: await observeCompilerBindPropagation(/binds 2 of 1 explicit args/, () =>
            attributeReplacedFailure(verdict, /expected healthy failure/, /.*/, bindArityFailure),
          ),
        },
      },
      'mutation-verdict:construction:testing-helper-bind-brand-read',
    ).toEqual({
      producers: {
        arityBrand: true,
        undefined: 'propagated',
        capturedConstructor: true,
        poisonedConstructorBrand: true,
      },
      bindCounts: {
        missingArgument: 'propagated',
        unusedArgument: 'propagated',
      },
      consumers: {
        attribute: 'propagated',
        require: 'propagated',
        replacement: 'propagated',
      },
    })
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
