import type { DogfoodFault } from './config.js'
import type { DogfoodStatus } from './runtime.js'

/**
 * The receipt policy currently enforced by the workflow's fault-probe jq.
 * Keeping it callable makes omissions in that policy executable in the red
 * tests; the green fix promotes this seam to the one policy for every run.
 */
export function dogfoodReceiptErrors(
  receipt: DogfoodStatus,
  fault: DogfoodFault,
): readonly string[] {
  if (fault === 'none') return []
  if (!receipt.found) return ['dogfood task was not found']

  const errors: string[] = []
  if (receipt.state !== 'completed') errors.push('fault probe did not complete')
  if (receipt.attempts !== 0) errors.push('fault probe spent user attempts')
  if (receipt.expectedCheckpointCount !== 1) errors.push('expected checkpoint count is not one')
  if (receipt.observedCheckpointCount !== 1) errors.push('observed checkpoint count is not one')
  if (receipt.contiguousCheckpointCount !== 1) errors.push('checkpoint sequence is not contiguous')
  if (receipt.refObservations.length !== 1)
    errors.push('fault probe has the wrong observation count')
  if (fault === 'driver-before-activation' && receipt.relaunches < 1) {
    errors.push('driver fault did not relaunch')
  }
  if (fault === 'worker-after-checkpoint' && receipt.infraRetries < 1) {
    errors.push('worker fault did not consume an infrastructure retry')
  }
  return errors
}
