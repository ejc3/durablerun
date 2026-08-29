import { dogfoodReceiptErrors } from '../src/receipt.js'
import { expect, it } from 'vitest'

it('rejects corrupt partial evidence while the seven-day journal is still live', () => {
  expect(
    dogfoodReceiptErrors(
      {
        found: true,
        state: 'sleeping',
        attempts: 7,
        infraRetries: 9,
        failureReason: null,
        completedResult: null,
        expectedCheckpointCount: 15,
        expectedCheckpointSpanMs: 604_800_000,
        observedCheckpointCount: 2,
        contiguousCheckpointCount: 0,
        refObservations: [
          { ordinal: 1, ownerAttempt: 1 },
          { ordinal: 1, ownerAttempt: 1 },
        ],
        relaunches: 0,
        checkpointSpanMs: 0,
      },
      'none',
    ),
  ).not.toEqual([])
})
