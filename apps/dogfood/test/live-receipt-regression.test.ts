import { expect, it } from 'vitest'
import { DOGFOOD_PROGRESS_GRACE_MS, DOGFOOD_TASK_NAME } from '../src/config.js'
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

it('rejects a live seven-day journal that makes no progress across two hourly slots', () => {
  const createdAt = 1_000_000
  const receipt = {
    found: true,
    taskName: DOGFOOD_TASK_NAME,
    state: 'pending',
    attempts: 0,
    infraRetries: 0,
    failureReason: null,
    completedResult: null,
    durableParameters: {
      repository: intent.repository,
      ref: intent.ref,
      cycles: intent.cycles,
      intervalSeconds: intent.intervalSeconds,
    },
    taskCreatedAtEpochMs: createdAt,
    databaseNowEpochMs: createdAt + DOGFOOD_PROGRESS_GRACE_MS,
    observedCheckpointCount: 0,
    contiguousCheckpointCount: 0,
    refObservations: [],
    relaunches: 0,
    checkpointSpanMs: null,
  }
  expect(dogfoodReceiptErrors(receipt, 'none', intent)).toEqual([])
  expect(
    dogfoodReceiptErrors(
      { ...receipt, databaseNowEpochMs: receipt.databaseNowEpochMs + 1 },
      'none',
      intent,
    ),
  ).toContain('live journal is overdue for checkpoint progress')
})

it('resets the live progress deadline from the latest durable checkpoint', () => {
  const createdAt = 1_000_000
  const observedAt = createdAt + 60_000
  const nextDeadline = observedAt + intent.intervalSeconds * 1_000 + DOGFOOD_PROGRESS_GRACE_MS
  const receipt = {
    found: true,
    taskName: DOGFOOD_TASK_NAME,
    state: 'sleeping',
    attempts: 0,
    infraRetries: 0,
    failureReason: null,
    completedResult: null,
    durableParameters: {
      repository: intent.repository,
      ref: intent.ref,
      cycles: intent.cycles,
      intervalSeconds: intent.intervalSeconds,
    },
    taskCreatedAtEpochMs: createdAt,
    databaseNowEpochMs: nextDeadline,
    observedCheckpointCount: 1,
    contiguousCheckpointCount: 1,
    refObservations: [{ ordinal: 1, observedAtEpochMs: observedAt }],
    relaunches: 0,
    checkpointSpanMs: 0,
  }
  expect(dogfoodReceiptErrors(receipt, 'none', intent)).toEqual([])
  expect(
    dogfoodReceiptErrors(
      { ...receipt, databaseNowEpochMs: receipt.databaseNowEpochMs + 1 },
      'none',
      intent,
    ),
  ).toContain('live journal is overdue for checkpoint progress')
})
