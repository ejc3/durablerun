import { describe, expect, it } from 'vitest'
import {
  MATRIX_PRE_STATES,
  MATRIX_READ_LABELS,
  MATRIX_WRITE_LABELS,
  type MatrixFault,
  runFaultMatrixCase,
} from './fault-matrix.js'
import type { StoreFixtureFactory } from './fixture.js'
import { ENGINE_INVARIANT_CONDITIONS } from './invariants.js'
import {
  POISON_WITNESSES,
  POISON_WITNESS_COUNT,
  POISON_WRITE_LABELS,
  duplicatePoisonWitnessIds,
  runPoisonMatrixCase,
  uncoveredConditionIds,
  unknownCoveredConditionIds,
} from './poison-matrix.js'
import { schedulerConformance, wakeWitnessConformance } from './suite.js'

export const STORE_CONFORMANCE_SURFACE_IDS = Object.freeze([
  'scheduler',
  'fault-matrix',
  'poison-matrix',
  'wake-witness',
] as const)

const FAULT_SEEDS = [1, 2] as const

function faultMatrixConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`fault matrix [${dialect}] (label x fault x starting state, generated)`, () => {
    const cells: [string, MatrixFault][] = []
    for (const label of MATRIX_WRITE_LABELS) {
      cells.push([label, 'crash-before'], [label, 'crash-after'], [label, 'duplicate'])
    }
    for (const label of MATRIX_READ_LABELS) {
      cells.push([label, 'crash-after'], [label, 'duplicate'])
    }

    for (const [label, fault] of cells) {
      for (const preState of MATRIX_PRE_STATES) {
        const from = preState === 'fresh' ? '' : ` from ${preState}`
        it(`${label} survives ${fault}${from}`, async () => {
          const crossingMarker = {
            fresh: 'mutation-verdict:behavior:fault-matrix-edge-crossing:fresh',
            'infra-cap-edge': 'mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge',
            'relaunch-cap-edge':
              'mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge',
            'attempt-cap-edge':
              'mutation-verdict:behavior:fault-matrix-edge-crossing:attempt-cap-edge',
          }[preState]
          for (const seed of FAULT_SEEDS) {
            const observed = await runFaultMatrixCase(
              makeFixture,
              label,
              fault,
              seed,
              preState,
            ).then(
              () => 'resolved' as const,
              () => 'rejected' as const,
            )
            expect(observed, crossingMarker).toBe('resolved')
          }
        })
      }
    }
  })
}

async function attributeExpectedFailure<T>(
  marker: string,
  expectedError: RegExp,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (expectedError.test(String(error))) throw new Error(marker)
    throw error
  }
}

function poisonMatrixConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`poison matrix [${dialect}] (write label x forbidden pre-state, generated)`, () => {
    it('covers every invariant and keeps the atomic witness inventory pinned', () => {
      expect(uncoveredConditionIds()).toEqual([])
      expect(unknownCoveredConditionIds()).toEqual([])
      expect(duplicatePoisonWitnessIds()).toEqual([])
      expect(ENGINE_INVARIANT_CONDITIONS).toHaveLength(57)
      expect(POISON_WITNESS_COUNT).toBe(54)
    })

    it('fails completeness when one atomic condition loses its witness', () => {
      const withoutStoredNull = POISON_WITNESSES.filter(
        (witness) => !witness.covers.includes('payload/stored-payload-null'),
      )
      expect(uncoveredConditionIds(withoutStoredNull)).toContain('payload/stored-payload-null')
    })

    for (const label of POISON_WRITE_LABELS) {
      for (const witness of POISON_WITNESSES) {
        it(`${label} does not amplify ${witness.id}`, async () => {
          const verdict =
            label === 'claim' && witness.id === 'cardinality/two-live-runs'
              ? 'mutation-verdict:behavior:claim-requires-sole-live-run'
              : undefined
          const run = () => runPoisonMatrixCase(makeFixture, label, witness)
          if (verdict) {
            const result = await attributeExpectedFailure(
              verdict,
              /^Error: claim\/cardinality\/two-live-runs: .*poisoned live run .* changed without quiescing/,
              run,
            )
            expect(result).toMatchObject({ label, witness: witness.id })
            return
          }
          await expect(run()).resolves.toMatchObject({
            label,
            witness: witness.id,
          })
        })
      }
    }
  })
}

/**
 * The one enrollment door for a dialect. Adding a store fixture necessarily
 * runs every shared behavioral surface; individual backends cannot silently
 * opt out of the expensive fault, poison, or wake dimensions.
 */
export function storeConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  schedulerConformance(dialect, makeFixture)
  faultMatrixConformance(dialect, makeFixture)
  poisonMatrixConformance(dialect, makeFixture)
  wakeWitnessConformance(dialect, makeFixture)
}
