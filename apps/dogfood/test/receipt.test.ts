import type { DogfoodFault } from '../src/config.js'
import { dogfoodReceiptErrors } from '../src/receipt.js'
import type { DogfoodStatus } from '../src/runtime.js'
import { describe, expect, it } from 'vitest'

type FoundReceipt = Extract<DogfoodStatus, { found: true }>

function receipt(overrides: Partial<FoundReceipt> = {}): FoundReceipt {
  return {
    found: true,
    queue: 'dogfood',
    idempotencyKey: 'receipt-test',
    taskId: 'task-1',
    state: 'completed',
    attempts: 0,
    infraRetries: 0,
    failureReason: null,
    completedResult: { cycles: 1, observations: [] },
    expectedCheckpointCount: 1,
    observedCheckpointCount: 1,
    contiguousCheckpointCount: 1,
    refObservations: [
      {
        ordinal: 1,
        key: 'observe-ref',
        observedAtEpochMs: 1_000_000,
        ownerRunId: 'run-1',
        ownerAttempt: 1,
        snapshot: {
          repository: 'ejc3/durablerun',
          ref: 'main',
          commitSha: 'commit-1',
          treeSha: 'tree-1',
          committedAt: '2026-08-29T00:00:00Z',
        },
      },
    ],
    relaunches: 0,
    checkpointSpanMs: 0,
    ...overrides,
  }
}

describe('dogfood receipt verification', () => {
  it.each(['failed', 'cancelled'])(
    'rejects a normal scheduled receipt whose task is terminal %s',
    (state) => {
      expect(dogfoodReceiptErrors(receipt({ state }), 'none')).not.toEqual([])
    },
  )

  it('rejects completed work whose checkpoint evidence is incomplete', () => {
    expect(
      dogfoodReceiptErrors(
        receipt({
          expectedCheckpointCount: 2,
          completedResult: { cycles: 2, observations: [] },
        }),
        'none',
      ),
    ).not.toEqual([])
  })

  it.each([
    {
      fault: 'driver-before-activation' as const,
      overrides: { relaunches: 2, infraRetries: 1 },
    },
    {
      fault: 'worker-after-checkpoint' as const,
      overrides: { relaunches: 1, infraRetries: 2 },
    },
  ])(
    'requires exact $fault counters and first-attempt checkpoint ownership',
    ({ fault, overrides }) => {
      const observations = receipt().refObservations.map((item) => ({ ...item, ownerAttempt: 2 }))
      expect(
        dogfoodReceiptErrors(receipt({ ...overrides, refObservations: observations }), fault),
      ).not.toEqual([])
    },
  )

  it('accepts the exact evidence for each deliberate fault', () => {
    const cases: Array<[DogfoodFault, FoundReceipt]> = [
      ['driver-before-activation', receipt({ relaunches: 1, infraRetries: 0 })],
      ['worker-after-checkpoint', receipt({ relaunches: 0, infraRetries: 1 })],
    ]
    for (const [fault, value] of cases) expect(dogfoodReceiptErrors(value, fault)).toEqual([])
  })
})
