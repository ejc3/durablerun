import { FENCE_RELATIONS } from '@durablerun/core'
import { expect, it } from 'vitest'

it('pins every cross-table relation to its exact queue-ownership policy', () => {
  const compileOnly = (): void => {
    const requireFalse = (_value: false): void => {}
    const requireTrue = (_value: true): void => {}

    // @ts-expect-error runs-to-tasks must remain queue-scoped — mutation-verdict:construction:generated-runs-to-tasks-queue-ownership
    requireFalse(FENCE_RELATIONS['runs-to-tasks'].queueScoped)
    // @ts-expect-error authoritative run cleanup must ignore a corrupt wait queue — mutation-verdict:construction:generated-runs-to-waits-authoritative-cleanup
    requireTrue(FENCE_RELATIONS['runs-to-waits'].queueScoped)
    // @ts-expect-error tasks-to-runs must remain queue-scoped — mutation-verdict:construction:generated-tasks-to-runs-queue-ownership
    requireFalse(FENCE_RELATIONS['tasks-to-runs'].queueScoped)
    // @ts-expect-error waits-to-runs must remain queue-scoped — mutation-verdict:construction:generated-waits-to-runs-queue-ownership
    requireFalse(FENCE_RELATIONS['waits-to-runs'].queueScoped)
  }

  expect(compileOnly).toBeTypeOf('function')
})
