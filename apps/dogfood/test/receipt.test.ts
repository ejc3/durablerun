import type { DogfoodFault } from '../src/config.js'
import { dogfoodReceiptErrors } from '../src/receipt.js'
import type { DogfoodStatus, RefObservationCheckpoint } from '../src/runtime.js'
import { describe, expect, it } from 'vitest'

type FoundReceipt = Extract<DogfoodStatus, { found: true }>

const snapshot = {
  repository: 'ejc3/durablerun',
  ref: 'main',
  commitSha: 'commit-1',
  treeSha: 'tree-1',
  committedAt: '2026-08-29T00:00:00Z',
}

const firstObservation: RefObservationCheckpoint = {
  ordinal: 1,
  key: 'observe-ref',
  observedAtEpochMs: 1_000_000,
  ownerRunId: 'run-1',
  ownerAttempt: 1,
  snapshot,
}

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
    completedResult: { cycles: 1, observations: [snapshot] },
    expectedCheckpointCount: 1,
    expectedCheckpointSpanMs: 0,
    observedCheckpointCount: 1,
    contiguousCheckpointCount: 1,
    refObservations: [firstObservation],
    relaunches: 0,
    checkpointSpanMs: 0,
    ...overrides,
  }
}

describe('dogfood receipt verification', () => {
  it('rejects a normal journal whose durable parameters cover less than seven days', () => {
    expect(dogfoodReceiptErrors(receipt(), 'none')).toContain(
      'durable task parameters cover less than seven days',
    )
  })

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

  it('rejects completed work whose checkpoint span is shorter than its durable parameters', () => {
    const secondSnapshot = { ...snapshot, commitSha: 'commit-2' }
    expect(
      dogfoodReceiptErrors(
        receipt({
          completedResult: { cycles: 2, observations: [snapshot, secondSnapshot] },
          expectedCheckpointCount: 2,
          expectedCheckpointSpanMs: 100,
          observedCheckpointCount: 2,
          contiguousCheckpointCount: 2,
          refObservations: [
            firstObservation,
            {
              ...firstObservation,
              ordinal: 2,
              key: 'observe-ref#2',
              observedAtEpochMs: 1_000_099,
              snapshot: secondSnapshot,
            },
          ],
          checkpointSpanMs: 99,
        }),
        'none',
      ),
    ).not.toEqual([])
  })

  it('accepts intact partial evidence while the scheduled journal is live', () => {
    expect(
      dogfoodReceiptErrors(
        receipt({
          state: 'sleeping',
          completedResult: null,
          expectedCheckpointCount: 15,
          expectedCheckpointSpanMs: 604_800_000,
        }),
        'none',
      ),
    ).toEqual([])
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
