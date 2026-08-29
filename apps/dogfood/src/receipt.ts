import type { DogfoodFault } from './config.js'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactInteger(value: unknown, expected: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expected
}

function journalEvidenceErrors(
  receipt: Record<string, unknown>,
  requireComplete: boolean,
): string[] {
  const errors: string[] = []
  const expectedCount = receipt.expectedCheckpointCount
  const expectedSpanMs = receipt.expectedCheckpointSpanMs
  if (
    typeof expectedCount !== 'number' ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1
  ) {
    errors.push('expected checkpoint count is invalid')
    return errors
  }
  if (
    typeof expectedSpanMs !== 'number' ||
    !Number.isSafeInteger(expectedSpanMs) ||
    expectedSpanMs < 0
  ) {
    errors.push('expected checkpoint span is invalid')
  }
  const observedCount = receipt.observedCheckpointCount
  const observedCountIsValid =
    typeof observedCount === 'number' &&
    Number.isSafeInteger(observedCount) &&
    observedCount >= 0 &&
    observedCount <= expectedCount
  if (!observedCountIsValid) {
    errors.push('observed checkpoint count is invalid')
  }
  if (!observedCountIsValid || !exactInteger(receipt.contiguousCheckpointCount, observedCount)) {
    errors.push('checkpoint sequence is not complete and contiguous')
  }
  const observations = Array.isArray(receipt.refObservations) ? receipt.refObservations : []
  if (!observedCountIsValid || observations.length !== observedCount) {
    errors.push('receipt has the wrong observation count')
  }
  for (const [index, value] of observations.entries()) {
    const observation = record(value)
    if (!observation || !exactInteger(observation.ordinal, index + 1)) {
      errors.push('receipt checkpoint ordinals are not contiguous')
      break
    }
  }

  if (observedCountIsValid && observedCount === 0) {
    if (receipt.checkpointSpanMs !== null) errors.push('empty checkpoint receipt has a span')
  } else if (observedCountIsValid) {
    const checkpointSpanMs = receipt.checkpointSpanMs
    if (
      typeof checkpointSpanMs !== 'number' ||
      !Number.isSafeInteger(checkpointSpanMs) ||
      checkpointSpanMs < 0
    ) {
      errors.push('checkpoint span is invalid')
    } else if (
      typeof expectedSpanMs === 'number' &&
      Number.isSafeInteger(expectedSpanMs) &&
      expectedCount > 1 &&
      checkpointSpanMs < ((observedCount - 1) * expectedSpanMs) / (expectedCount - 1)
    ) {
      errors.push('checkpoint span is shorter than the durable task parameters require')
    }
  }

  if (requireComplete) {
    if (!exactInteger(observedCount, expectedCount)) {
      errors.push('observed checkpoint count does not match the durable task parameters')
    }
    const completedResult = record(receipt.completedResult)
    if (!completedResult || !exactInteger(completedResult.cycles, expectedCount)) {
      errors.push('completed result has the wrong cycle count')
    }
    const completedObservations = completedResult?.observations
    if (!Array.isArray(completedObservations) || completedObservations.length !== expectedCount) {
      errors.push('completed result has the wrong observation count')
    }
  } else if (receipt.completedResult !== null) {
    errors.push('live task already has a completed result')
  }
  if (receipt.failureReason !== null) errors.push('task has a failure reason')
  return errors
}

export function dogfoodReceiptErrors(candidate: unknown, fault: DogfoodFault): readonly string[] {
  const receipt = record(candidate)
  if (!receipt || receipt.found !== true) return ['dogfood task was not found']

  const errors: string[] = []
  if (fault === 'none') {
    if (!exactInteger(receipt.attempts, 0)) errors.push('scheduled task spent user attempts')
    if (receipt.state === 'failed' || receipt.state === 'cancelled') {
      errors.push(`scheduled task ended in terminal state ${receipt.state}`)
    } else if (receipt.state === 'completed') {
      errors.push(...journalEvidenceErrors(receipt, true))
    } else if (['pending', 'running', 'sleeping'].includes(String(receipt.state))) {
      errors.push(...journalEvidenceErrors(receipt, false))
    } else {
      errors.push('scheduled task has an unknown state')
    }
    return errors
  }

  if (receipt.state !== 'completed') errors.push('fault probe did not complete')
  else errors.push(...journalEvidenceErrors(receipt, true))
  if (!exactInteger(receipt.attempts, 0)) errors.push('fault probe spent user attempts')
  if (!exactInteger(receipt.expectedCheckpointCount, 1)) {
    errors.push('expected checkpoint count is not one')
  }
  if (!exactInteger(receipt.expectedCheckpointSpanMs, 0)) {
    errors.push('expected checkpoint span is not zero')
  }
  if (!exactInteger(receipt.observedCheckpointCount, 1)) {
    errors.push('observed checkpoint count is not one')
  }
  if (!exactInteger(receipt.contiguousCheckpointCount, 1)) {
    errors.push('checkpoint sequence is not contiguous')
  }
  const observations = Array.isArray(receipt.refObservations) ? receipt.refObservations : []
  if (observations.length !== 1) errors.push('fault probe has the wrong observation count')
  const observation = record(observations[0])
  if (!observation || !exactInteger(observation.ordinal, 1)) {
    errors.push('fault probe checkpoint ordinal is not one')
  }
  if (!observation || !exactInteger(observation.ownerAttempt, 1)) {
    errors.push('fault probe checkpoint owner attempt is not one')
  }
  if (fault === 'driver-before-activation') {
    if (!exactInteger(receipt.relaunches, 1))
      errors.push('driver fault did not relaunch exactly once')
    if (!exactInteger(receipt.infraRetries, 0)) {
      errors.push('driver fault consumed an infrastructure retry')
    }
  } else {
    if (!exactInteger(receipt.relaunches, 0)) errors.push('worker fault unexpectedly relaunched')
    if (!exactInteger(receipt.infraRetries, 1)) {
      errors.push('worker fault did not consume exactly one infrastructure retry')
    }
  }
  return errors
}

export function requireDogfoodReceipt(candidate: unknown, fault: DogfoodFault): void {
  const errors = dogfoodReceiptErrors(candidate, fault)
  if (errors.length > 0) throw new Error(`invalid dogfood receipt:\n- ${errors.join('\n- ')}`)
}
