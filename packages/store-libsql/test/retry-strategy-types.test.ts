import { type NormalizedRetryStrategy, normalizeRetryStrategy } from '@durablerun/core'
import { expect, it } from 'vitest'

it('TypeScript construction rejects a spread-normalized retry strategy', () => {
  const compileOnly = (): void => {
    const normalized = normalizeRetryStrategy({ kind: 'fixed', baseSeconds: 1 })
    if (normalized.kind !== 'fixed') throw new Error('expected a fixed strategy')
    const forged = { ...normalized, baseSeconds: Number.POSITIVE_INFINITY }

    // @ts-expect-error normalized retry data retains its nominal identity only when it is not spread — mutation-verdict:construction:retry-normalized-type-is-nominal
    const checked: NormalizedRetryStrategy = forged
    void checked
  }

  expect(compileOnly).toBeTypeOf('function')
})
