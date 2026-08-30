import { describe, expect, it } from 'vitest'
import { DOGFOOD_TASK_NAME, type DogfoodFault, type DogfoodWorkloadIntent } from '../src/config.js'
import { dogfoodReceiptErrors } from '../src/receipt.js'
import type { DogfoodStatus, RefObservationCheckpoint } from '../src/runtime.js'

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
    taskName: DOGFOOD_TASK_NAME,
    state: 'completed',
    attempts: 0,
    infraRetries: 0,
    failureReason: null,
    completedResult: { cycles: 1, observations: [snapshot] },
    durableParameters: {
      repository: 'ejc3/durablerun',
      ref: 'main',
      cycles: 1,
      intervalSeconds: 0,
    },
    observedCheckpointCount: 1,
    contiguousCheckpointCount: 1,
    refObservations: [firstObservation],
    relaunches: 0,
    checkpointSpanMs: 0,
    ...overrides,
  }
}

function receiptIntent(value: FoundReceipt): DogfoodWorkloadIntent {
  if (value.durableParameters === null) throw new Error('test receipt has no durable parameters')
  return { taskName: DOGFOOD_TASK_NAME, ...value.durableParameters }
}

function errors(value: FoundReceipt, fault: DogfoodFault): readonly string[] {
  return dogfoodReceiptErrors(value, fault, receiptIntent(value))
}

describe('dogfood receipt verification', () => {
  it('binds the complete durable workload to the configured intent', () => {
    const expected: DogfoodWorkloadIntent = {
      taskName: DOGFOOD_TASK_NAME,
      repository: 'ejc3/durablerun',
      ref: 'main',
      cycles: 15,
      intervalSeconds: 43_200,
    }
    const live = receipt({
      state: 'sleeping',
      completedResult: null,
      durableParameters: {
        repository: expected.repository,
        ref: expected.ref,
        cycles: expected.cycles,
        intervalSeconds: expected.intervalSeconds,
      },
    })
    for (const durableParameters of [
      { ...expected, repository: 'wrong-owner/wrong-repo', ref: 'release' },
      { ...expected, cycles: 2, intervalSeconds: 31_536_000 },
    ]) {
      expect(
        dogfoodReceiptErrors(
          { ...live, taskName: 'ref-journal', durableParameters },
          'none',
          expected,
        ),
      ).toContain('durable journal workload does not match configured intent')
    }
  })

  it('rejects a normal journal whose durable parameters cover less than seven days', () => {
    expect(errors(receipt(), 'none')).toContain(
      'durable task parameters cover less than seven days',
    )
    expect(errors(receipt({ state: 'sleeping', completedResult: null }), 'none')).toContain(
      'durable task parameters cover less than seven days',
    )
  })

  it.each(['failed', 'cancelled'])(
    'rejects a normal scheduled receipt whose task is terminal %s',
    (state) => {
      expect(errors(receipt({ state }), 'none')).not.toEqual([])
    },
  )

  it('rejects completed work whose checkpoint evidence is incomplete', () => {
    expect(
      errors(
        receipt({
          durableParameters: {
            repository: 'ejc3/durablerun',
            ref: 'main',
            cycles: 2,
            intervalSeconds: 0,
          },
          completedResult: { cycles: 2, observations: [] },
        }),
        'none',
      ),
    ).not.toEqual([])
  })

  it('rejects completed work whose checkpoint span is shorter than its durable parameters', () => {
    const secondSnapshot = { ...snapshot, commitSha: 'commit-2' }
    expect(
      errors(
        receipt({
          completedResult: { cycles: 2, observations: [snapshot, secondSnapshot] },
          durableParameters: {
            repository: 'ejc3/durablerun',
            ref: 'main',
            cycles: 2,
            intervalSeconds: 1,
          },
          observedCheckpointCount: 2,
          contiguousCheckpointCount: 2,
          refObservations: [
            firstObservation,
            {
              ...firstObservation,
              ordinal: 2,
              key: 'observe-ref#2',
              observedAtEpochMs: 1_000_999,
              snapshot: secondSnapshot,
            },
          ],
          checkpointSpanMs: 999,
        }),
        'none',
      ),
    ).not.toEqual([])
  })

  it('accepts intact partial evidence while the scheduled journal is live', () => {
    expect(
      errors(
        receipt({
          state: 'sleeping',
          completedResult: null,
          durableParameters: {
            repository: 'ejc3/durablerun',
            ref: 'main',
            cycles: 15,
            intervalSeconds: 43_200,
          },
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
      expect(errors(receipt({ ...overrides, refObservations: observations }), fault)).not.toEqual(
        [],
      )
    },
  )

  it('accepts the exact evidence for each deliberate fault', () => {
    const cases: Array<[DogfoodFault, FoundReceipt]> = [
      ['driver-before-activation', receipt({ relaunches: 1, infraRetries: 0 })],
      ['worker-after-checkpoint', receipt({ relaunches: 0, infraRetries: 1 })],
    ]
    for (const [fault, value] of cases) expect(errors(value, fault)).toEqual([])
  })
})
