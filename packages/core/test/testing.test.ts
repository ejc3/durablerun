import { describe, expect, it } from 'vitest'
import { isFencedBatchBindError } from '../src/index.js'
import {
  attributeExpectedFailure,
  attributeReplacedFailure,
  requireExpectedFailure,
} from '../src/testing.js'
import { followOn, taskFollowOn } from './tree-fixtures.js'

const marker = 'mutation-verdict:behavior:testing-helper'
const verdict = { kind: 'behavior', mutation: 'testing-helper' } as const
const expected = new Error('expected')
const unrelated = new Error('unrelated')
const namedReplacementExpectation = {
  expectedError: (error: unknown) => error === expected,
  replacementError: (error: unknown) => error === unrelated,
} satisfies Parameters<typeof attributeReplacedFailure>[1]

const PLACEHOLDERS = /compiles to \d+ placeholders for \d+ arguments/

/** An operator that compiles to `?` adds a placeholder that no argument binds. */
async function bindPlaceholderFailure(): Promise<never> {
  followOn(taskFollowOn().where('headers', '?', 'key'))
  throw new Error('placeholder-count failure unexpectedly returned')
}

/** A boolean is a value no driver binds. */
async function bindArgumentTypeFailure(): Promise<never> {
  followOn(taskFollowOn().where('task_name', '=', true as never))
  throw new Error('argument-type failure unexpectedly returned')
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
      await bindPlaceholderFailure()
    } catch (error) {
      arityFailure = error
    }
    const argumentTypeProducer = await observeCompilerBindPropagation(
      /argument \d+ is boolean/,
      () => attributeExpectedFailure(verdict, /.*/, bindArgumentTypeFailure),
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
        await attributeExpectedFailure(verdict, /.*/, bindPlaceholderFailure)
      } catch (error) {
        observed = error
      }
    } finally {
      Object.defineProperty(globalThis, 'TypeError', originalTypeError)
      Object.defineProperty(globalThis, 'Error', originalError)
    }

    const placeholderCount = await observeCompilerBindPropagation(
      PLACEHOLDERS,
      bindPlaceholderFailure,
    )

    expect(
      {
        producers: {
          placeholderBrand: isFencedBatchBindError(arityFailure),
          argumentType: argumentTypeProducer,
          capturedConstructor: observed instanceof (originalTypeError.value as ErrorConstructor),
          poisonedConstructorBrand: isFencedBatchBindError(observed),
        },
        bindCounts: { placeholderCount },
        consumers: {
          attribute: await observeCompilerBindPropagation(PLACEHOLDERS, () =>
            attributeExpectedFailure(verdict, /.*/, bindPlaceholderFailure),
          ),
          require: await observeCompilerBindPropagation(PLACEHOLDERS, () =>
            requireExpectedFailure(verdict, /.*/, bindPlaceholderFailure),
          ),
          replacement: await observeCompilerBindPropagation(PLACEHOLDERS, () =>
            attributeReplacedFailure(
              verdict,
              { expectedError: /expected healthy failure/, replacementError: /.*/ },
              bindPlaceholderFailure,
            ),
          ),
        },
      },
      'mutation-verdict:construction:testing-helper-bind-brand-read',
    ).toEqual({
      producers: {
        placeholderBrand: true,
        argumentType: 'propagated',
        capturedConstructor: true,
        poisonedConstructorBrand: true,
      },
      bindCounts: { placeholderCount: 'propagated' },
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
      attributeReplacedFailure(verdict, namedReplacementExpectation, async () => {
        throw expected
      }),
    ).resolves.toBeUndefined()
    await expect(
      attributeReplacedFailure(verdict, namedReplacementExpectation, async () => {
        throw unrelated
      }),
    ).rejects.toThrow(marker)
  })

  it('owns canonical marker construction instead of accepting decorated strings', async () => {
    await expect(
      attributeReplacedFailure(verdict, namedReplacementExpectation, async () => {
        throw unrelated
      }),
    ).rejects.toThrow(marker)

    await expect(
      attributeReplacedFailure(
        { kind: 'behavior', mutation: 'testing-helper: diagnostic suffix' },
        namedReplacementExpectation,
        async () => {
          throw unrelated
        },
      ),
    ).rejects.toThrow('invalid mutation verdict name')
  })

  it('does not attribute success or a third rejection as a replacement failure', async () => {
    const third = new Error('third')
    await expect(
      attributeReplacedFailure(verdict, namedReplacementExpectation, async () => undefined),
    ).rejects.not.toThrow(marker)
    await expect(
      attributeReplacedFailure(verdict, namedReplacementExpectation, async () => {
        throw third
      }),
    ).rejects.toBe(third)
  })
})
