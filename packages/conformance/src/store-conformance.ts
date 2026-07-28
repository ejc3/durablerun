import { attributeExpectedFailure } from '@durablerun/core/testing'
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
  POISON_TARGET_CASES,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  POISON_WITNESS_COUNT,
  POISON_WRITE_LABELS,
  duplicatePoisonWitnessIds,
  runPoisonMatrixCase,
  runPoisonTargetCase,
  uncoveredConditionIds,
  unknownCoveredConditionIds,
} from './poison-matrix.js'
import { schedulerConformance, wakeWitnessConformance } from './suite.js'

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

function poisonMatrixConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`poison matrix [${dialect}] (ambient write label x forbidden pre-state)`, () => {
    it('covers every invariant and keeps the atomic witness inventory pinned', () => {
      expect(
        uncoveredConditionIds(),
        'mutation-verdict:behavior:persisted-counter-field-inventory',
      ).toEqual([])
      expect(unknownCoveredConditionIds()).toEqual([])
      expect(duplicatePoisonWitnessIds()).toEqual([])
      expect(ENGINE_INVARIANT_CONDITIONS).toHaveLength(79)
      expect(POISON_WITNESS_COUNT).toBe(87)
      expect(POISON_WRITE_LABELS).toHaveLength(17)
      expect(POISON_WRITE_LABELS.length * POISON_WITNESS_COUNT).toBe(1_479)
      expect(POISON_TARGET_CASES).toHaveLength(49)
      expect(POISON_UNREACHABLE_TARGETS).toHaveLength(27)
      expect(new Set(POISON_TARGET_CASES.map((target) => target.id)).size).toBe(
        POISON_TARGET_CASES.length,
      )
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
          const hasClaimCardinalityVerdict =
            label === 'claim' && witness.id === 'cardinality/two-live-runs'
          const run = () => runPoisonMatrixCase(makeFixture, label, witness)
          if (hasClaimCardinalityVerdict) {
            const result = await attributeExpectedFailure(
              { kind: 'behavior', mutation: 'claim-requires-sole-live-run' },
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

    describe('branch-reachable counter containment', () => {
      for (const target of POISON_TARGET_CASES) {
        it(`${target.profile} contains ${target.witness.id}`, async () => {
          await expect(runPoisonTargetCase(makeFixture, target)).resolves.toMatchObject({
            label: target.label,
            witness: target.witness.id,
            profile: target.profile,
          })
        })
      }
    })
  })
}

const STORE_CONFORMANCE_SURFACES = Object.freeze([
  { id: 'scheduler', run: schedulerConformance },
  { id: 'fault-matrix', run: faultMatrixConformance },
  { id: 'poison-matrix', run: poisonMatrixConformance },
  { id: 'wake-witness', run: wakeWitnessConformance },
] as const)

export const STORE_CONFORMANCE_SURFACE_IDS = Object.freeze(
  STORE_CONFORMANCE_SURFACES.map(({ id }) => id),
)

/**
 * The one enrollment door for a dialect. Adding a store fixture necessarily
 * runs every shared behavioral surface; individual backends cannot silently
 * opt out of the expensive fault, poison, or wake dimensions.
 */
export function storeConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  for (const { run } of STORE_CONFORMANCE_SURFACES) {
    run(dialect, makeFixture)
  }
}
