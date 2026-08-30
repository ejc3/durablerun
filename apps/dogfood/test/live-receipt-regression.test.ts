import { expect, it } from 'vitest'
import { DOGFOOD_TASK_NAME } from '../src/config.js'
import { dogfoodReceiptErrors } from '../src/receipt.js'

const intent = {
  taskName: DOGFOOD_TASK_NAME,
  repository: 'ejc3/durablerun',
  ref: 'main',
  cycles: 15,
  intervalSeconds: 43_200,
} as const

it('rejects corrupt partial evidence while the seven-day journal is still live', () => {
  expect(
    dogfoodReceiptErrors(
      {
        found: true,
        taskName: DOGFOOD_TASK_NAME,
        state: 'sleeping',
        attempts: 7,
        infraRetries: 9,
        failureReason: null,
        completedResult: null,
        durableParameters: {
          repository: intent.repository,
          ref: intent.ref,
          cycles: intent.cycles,
          intervalSeconds: intent.intervalSeconds,
        },
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
      intent,
    ),
  ).not.toEqual([])
})
