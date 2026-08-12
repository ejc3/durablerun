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
  POISON_AGGREGATE_WITNESSES,
  POISON_TARGET_CASES,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  POISON_WITNESS_COUNT,
  POISON_WRITE_LABELS,
  duplicatePoisonWitnessIds,
  observePoisonAggregateAmbientCase,
  observePoisonAggregateTargetCase,
  runPoisonMatrixCase,
  runPoisonTargetCase,
  uncoveredConditionIds,
  unknownCoveredConditionIds,
} from './poison-matrix.js'
import { schedulerConformance, wakeWitnessConformance } from './suite.js'
import { timestampBoundaryConformance } from './time-boundaries.js'

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
    const cellSeedVector = cells.flatMap(([label, fault]) =>
      FAULT_SEEDS.map((seed) => ({ label, fault, seed })),
    )

    for (const preState of MATRIX_PRE_STATES) {
      it(`owns ${preState} across every generated label/fault cell and seed`, async () => {
        const observed = []
        for (const { label, fault, seed } of cellSeedVector) {
          observed.push(
            await runFaultMatrixCase(makeFixture, label, fault, seed, preState).then(
              () => ({ label, fault, seed, outcome: 'resolved' as const }),
              () => ({ label, fault, seed, outcome: 'rejected' as const }),
            ),
          )
        }

        const crossingMarker = {
          fresh: 'mutation-verdict:behavior:fault-matrix-edge-crossing:fresh',
          'infra-cap-edge': 'mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge',
          'relaunch-cap-edge':
            'mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge',
          'attempt-cap-edge':
            'mutation-verdict:behavior:fault-matrix-edge-crossing:attempt-cap-edge',
        }[preState]
        expect(observed, crossingMarker).toEqual(
          cellSeedVector.map(({ label, fault, seed }) => ({
            label,
            fault,
            seed,
            outcome: 'resolved',
          })),
        )
      }, 120_000)
    }
  })
}

function poisonMatrixConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`poison matrix [${dialect}] (ambient write label x forbidden pre-state)`, () => {
    it('covers every invariant and keeps the atomic witness inventory pinned', () => {
      expect(uncoveredConditionIds(), 'persisted counter field inventory stays complete').toEqual(
        [],
      )
      expect(unknownCoveredConditionIds()).toEqual([])
      expect(duplicatePoisonWitnessIds()).toEqual([])
      expect(ENGINE_INVARIANT_CONDITIONS).toHaveLength(109)
      expect(POISON_WITNESS_COUNT).toBe(139)
      expect(POISON_WRITE_LABELS).toHaveLength(17)
      expect(POISON_WRITE_LABELS.length * POISON_WITNESS_COUNT).toBe(2_363)
      expect(POISON_TARGET_CASES).toHaveLength(50)
      expect(POISON_UNREACHABLE_TARGETS).toHaveLength(26)
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
        if (label === 'fail' && witness.id === 'attempts/at-max-with-live-run') continue
        it(`${label} does not amplify ${witness.id}`, async () => {
          const hasClaimCardinalityVerdict =
            label === 'claim' && witness.id === 'cardinality/two-live-runs'
          const hasCancelQueueOwnershipVerdict =
            label === 'cancel-task' && witness.id === 'ownership/run-task-queue-mismatch'
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
          if (hasCancelQueueOwnershipVerdict) {
            const result = await attributeExpectedFailure(
              { kind: 'behavior', mutation: 'cancel-task-requires-run-task-queue-ownership' },
              /^Error: cancel-task\/ownership\/run-task-queue-mismatch: new invariant violation: terminal-task-with-live-run: poison-task\/poison-run$/,
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
      const highestOwnedOrdinalTargets = POISON_TARGET_CASES.filter(
        (target) =>
          target.label === 'claim' && target.witness.id === 'accounting/below-top-minus-one',
      )
      const exhaustedBudgetTargets = POISON_TARGET_CASES.filter(
        (target) => target.witness.id === 'attempts/at-max-with-live-run',
      )
      const sweepTargets = POISON_TARGET_CASES.filter(
        (target) => target.label === 'sweep:lost-launch' || target.label === 'sweep:claim-timeout',
      )
      const relaunchClaimWitnessIds = {
        upper: 'counter-bound/run-relaunch-count',
        lower: 'counter-bound-lower/run-relaunch-count',
      } as const
      const relaunchClaimTargets = POISON_TARGET_CASES.filter(
        (target) =>
          target.label === 'claim' &&
          (target.witness.id === relaunchClaimWitnessIds.upper ||
            target.witness.id === relaunchClaimWitnessIds.lower),
      )
      const accountingLiveRunNextWitness =
        POISON_AGGREGATE_WITNESSES['accounting/live-run-not-next']
      const accountingLiveRunNextTargets = POISON_TARGET_CASES.filter(
        (target) => target.witness.id === accountingLiveRunNextWitness,
      )
      const captureRelaunchClaimTargets = async (
        side: keyof typeof relaunchClaimWitnessIds,
      ): Promise<unknown[]> => {
        const witnessId = relaunchClaimWitnessIds[side]
        const observations: unknown[] = []
        for (const target of relaunchClaimTargets.filter(
          (candidate) => candidate.witness.id === witnessId,
        )) {
          observations.push(
            await runPoisonTargetCase(makeFixture, target).then(
              (result) => ({
                id: target.id,
                label: target.label,
                profile: target.profile,
                witness: target.witness.id,
                kind: 'resolved',
                result: {
                  label: result.label,
                  profile: result.profile,
                  witness: result.witness,
                },
              }),
              (error: unknown) => ({
                id: target.id,
                label: target.label,
                profile: target.profile,
                witness: target.witness.id,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }
        return observations
      }

      it('owns accounting/live-run-not-next across every ambient label and lifecycle profile', async () => {
        const observations: unknown[] = []
        for (const label of POISON_WRITE_LABELS) {
          observations.push(
            await observePoisonAggregateAmbientCase(
              makeFixture,
              label,
              'accounting/live-run-not-next',
            ).then(
              (observation) => ({
                id: `ambient/${label}`,
                kind: 'observed',
                observation,
              }),
              (error: unknown) => ({
                id: `ambient/${label}`,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }
        for (const target of accountingLiveRunNextTargets) {
          observations.push(
            await observePoisonAggregateTargetCase(makeFixture, target).then(
              (observation) => ({
                id: target.id,
                kind: 'observed',
                observation,
              }),
              (error: unknown) => ({
                id: target.id,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }

        expect(
          observations,
          'mutation-verdict:behavior:accounting-live-run-next-invariant',
        ).toEqual([
          ...[
            'driver-heartbeat',
            'spawn',
            'claim',
            'activate',
            'heartbeat',
            'reschedule',
            'suspend',
            'emit-event',
            'await-event',
            'complete',
            'fail',
            'cancel-task',
            'expire-lease-now',
            'set-checkpoint',
            'sweep:cancel',
            'sweep:lost-launch',
            'sweep:claim-timeout',
          ].map((label) => ({
            id: `ambient/${label}`,
            kind: 'observed',
            observation: {
              label,
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          })),
          {
            id: 'accounting/live-run-not-next/claim-pending',
            kind: 'observed',
            observation: {
              label: 'claim',
              profile: 'claim-pending',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/claim-sleeping',
            kind: 'observed',
            observation: {
              label: 'claim',
              profile: 'claim-sleeping',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/sweep-lost-launch',
            kind: 'observed',
            observation: {
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/sweep-claim-timeout',
            kind: 'observed',
            observation: {
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
        ])
      })

      it('contains accounting/below-top-minus-one across both claim profiles', async () => {
        const observations: unknown[] = []
        for (const target of highestOwnedOrdinalTargets) {
          observations.push(
            await runPoisonTargetCase(makeFixture, target).then(
              (result) => ({
                profile: target.profile,
                kind: 'resolved',
                result: {
                  label: result.label,
                  witness: result.witness,
                  profile: result.profile,
                },
              }),
              (error: unknown) => ({
                profile: target.profile,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }

        expect(
          observations,
          'mutation-verdict:behavior:claim-requires-highest-owned-ordinal',
        ).toEqual([
          {
            profile: 'claim-pending',
            kind: 'resolved',
            result: {
              label: 'claim',
              witness: 'accounting/below-top-minus-one',
              profile: 'claim-pending',
            },
          },
          {
            profile: 'claim-sleeping',
            kind: 'resolved',
            result: {
              label: 'claim',
              witness: 'accounting/below-top-minus-one',
              profile: 'claim-sleeping',
            },
          },
        ])
      })

      it('contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths', async () => {
        const nonExhaustedSweepTargets = sweepTargets.filter(
          (target) => !exhaustedBudgetTargets.includes(target),
        )
        const observations: unknown[] = []
        for (const target of nonExhaustedSweepTargets) {
          observations.push(
            await runPoisonTargetCase(makeFixture, target).then(
              (result) => ({
                id: target.id,
                label: target.label,
                profile: target.profile,
                witness: target.witness.id,
                kind: 'resolved',
                result: {
                  label: result.label,
                  profile: result.profile,
                  witness: result.witness,
                },
              }),
              (error: unknown) => ({
                id: target.id,
                label: target.label,
                profile: target.profile,
                witness: target.witness.id,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }

        const exhaustedPoisonObservations: unknown[] = []
        const exhaustedBudgetWitness = exhaustedBudgetTargets[0]?.witness
        if (!exhaustedBudgetWitness) throw new Error('missing exhausted-budget poison witness')
        exhaustedPoisonObservations.push(
          await runPoisonMatrixCase(makeFixture, 'fail', exhaustedBudgetWitness).then(
            (result) => ({
              profile: 'fail',
              kind: 'resolved',
              result: { label: result.label, witness: result.witness },
            }),
            (error: unknown) => ({ profile: 'fail', kind: 'rejected', error: String(error) }),
          ),
        )
        for (const target of exhaustedBudgetTargets) {
          exhaustedPoisonObservations.push(
            await runPoisonTargetCase(makeFixture, target).then(
              (result) => ({
                profile: target.profile,
                kind: 'resolved',
                result: {
                  label: result.label,
                  witness: result.witness,
                  profile: result.profile,
                },
              }),
              (error: unknown) => ({
                profile: target.profile,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }

        const receiptFixture = await makeFixture('poison-attempt-budget-receipt')
        let receipt: unknown
        let receiptBefore: unknown
        let receiptAfter: unknown
        try {
          await receiptFixture.admin.setFakeNowEpochMs(1_000_000)
          const spawned = await receiptFixture.store.spawn('q', 'exhausted-budget-receipt', '{}', {
            maxAttempts: 5,
          })
          await receiptFixture.store.claim('q', 'receipt-token', {
            leaseSeconds: 60,
            limit: 1,
          })
          await receiptFixture.raw.batch('poison-attempt-budget-receipt:corrupt', [
            {
              sql: `UPDATE tasks SET attempts = max_attempts WHERE task_id = ?`,
              args: [spawned.taskId],
            },
            {
              sql: `UPDATE runs SET attempt = 6 WHERE run_id = ?`,
              args: [spawned.runId],
            },
          ])
          const snapshot = async () => {
            const [tasks, runs] = await receiptFixture.raw.batch(
              'poison-attempt-budget-receipt:snapshot',
              [
                { sql: `SELECT * FROM tasks WHERE task_id = ?`, args: [spawned.taskId] },
                {
                  sql: `SELECT * FROM runs WHERE task_id = ? ORDER BY attempt`,
                  args: [spawned.taskId],
                },
              ],
              'read',
            )
            return { tasks: tasks?.rows, runs: runs?.rows }
          }
          receiptBefore = await snapshot()
          receipt = await receiptFixture.store.claim('q', 'receipt-token', {
            leaseSeconds: 60,
            limit: 1,
          })
          receiptAfter = await snapshot()
        } finally {
          receiptFixture.close()
        }

        expect(
          {
            targetIdentities: sweepTargets.map((target) => ({
              id: target.id,
              label: target.label,
              profile: target.profile,
              witness: target.witness.id,
            })),
            partitionSizes: {
              all: sweepTargets.length,
              nonExhausted: nonExhaustedSweepTargets.length,
              exhausted: sweepTargets.length - nonExhaustedSweepTargets.length,
            },
            observations,
          },
          'mutation-verdict:behavior:poison-sweep-scan-prelimit',
        ).toEqual({
          targetIdentities: [
            {
              id: 'attempts/at-max-with-live-run/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'attempts/at-max-with-live-run',
            },
            {
              id: 'attempts/at-max-with-live-run/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'attempts/at-max-with-live-run',
            },
            {
              id: 'accounting/below-top-minus-one/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'accounting/below-top-minus-one',
            },
            {
              id: 'accounting/below-top-minus-one/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'accounting/below-top-minus-one',
            },
            {
              id: 'accounting/live-run-not-next/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'accounting/live-run-not-next',
            },
            {
              id: 'accounting/live-run-not-next/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'accounting/live-run-not-next',
            },
            {
              id: 'counter-fractional/task-max-attempts/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-fractional/task-max-attempts',
            },
            {
              id: 'counter-fractional/task-max-attempts/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-fractional/task-max-attempts',
            },
            {
              id: 'counter-fractional/run-relaunch-count/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-fractional/run-relaunch-count',
            },
            {
              id: 'counter-fractional/run-relaunch-count/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-fractional/run-relaunch-count',
            },
            {
              id: 'counter-bound/task-max-attempts/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound/task-max-attempts',
            },
            {
              id: 'counter-bound/task-max-attempts/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound/task-max-attempts',
            },
            {
              id: 'counter-bound/task-infra-retries/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound/task-infra-retries',
            },
            {
              id: 'counter-bound/task-infra-retries/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound/task-infra-retries',
            },
            {
              id: 'counter-bound/run-claim-gen/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound/run-claim-gen',
            },
            {
              id: 'counter-bound/run-relaunch-count/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound/run-relaunch-count',
            },
            {
              id: 'counter-bound/run-relaunch-count/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound/run-relaunch-count',
            },
            {
              id: 'counter-bound-lower/task-attempts/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound-lower/task-attempts',
            },
            {
              id: 'counter-bound-lower/task-attempts/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound-lower/task-attempts',
            },
            {
              id: 'counter-bound-lower/task-infra-retries/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound-lower/task-infra-retries',
            },
            {
              id: 'counter-bound-lower/task-infra-retries/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound-lower/task-infra-retries',
            },
            {
              id: 'counter-bound-lower/run-activated-gen/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound-lower/run-activated-gen',
            },
            {
              id: 'counter-bound-lower/run-relaunch-count/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-bound-lower/run-relaunch-count',
            },
            {
              id: 'counter-bound-lower/run-relaunch-count/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-bound-lower/run-relaunch-count',
            },
          ],
          partitionSizes: { all: 24, nonExhausted: 22, exhausted: 2 },
          observations: nonExhaustedSweepTargets.map((target) => ({
            id: target.id,
            label: target.label,
            profile: target.profile,
            witness: target.witness.id,
            kind: 'resolved',
            result: {
              label: target.label,
              profile: target.profile,
              witness: target.witness.id,
            },
          })),
        })

        expect(
          {
            poison: exhaustedPoisonObservations,
            receipt: { result: receipt, after: receiptAfter },
          },
          'mutation-verdict:behavior:current-run-requires-user-attempt-budget',
        ).toEqual({
          poison: [
            {
              profile: 'fail',
              kind: 'resolved',
              result: { label: 'fail', witness: 'attempts/at-max-with-live-run' },
            },
            {
              profile: 'claim-pending',
              kind: 'resolved',
              result: {
                label: 'claim',
                witness: 'attempts/at-max-with-live-run',
                profile: 'claim-pending',
              },
            },
            {
              profile: 'claim-sleeping',
              kind: 'resolved',
              result: {
                label: 'claim',
                witness: 'attempts/at-max-with-live-run',
                profile: 'claim-sleeping',
              },
            },
            {
              profile: 'sweep-lost-launch',
              kind: 'resolved',
              result: {
                label: 'sweep:lost-launch',
                witness: 'attempts/at-max-with-live-run',
                profile: 'sweep-lost-launch',
              },
            },
            {
              profile: 'sweep-claim-timeout',
              kind: 'resolved',
              result: {
                label: 'sweep:claim-timeout',
                witness: 'attempts/at-max-with-live-run',
                profile: 'sweep-claim-timeout',
              },
            },
          ],
          receipt: { result: [], after: receiptBefore },
        })
      })

      describe('relaunch_count claim boundary containment', () => {
        it('owns the upper bound across both claim profiles', async () => {
          const observations = await captureRelaunchClaimTargets('upper')
          expect(observations, 'mutation-verdict:behavior:poison-claim-relaunch-upper').toEqual([
            {
              id: 'counter-bound/run-relaunch-count/claim-pending',
              label: 'claim',
              profile: 'claim-pending',
              witness: 'counter-bound/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-pending',
                witness: 'counter-bound/run-relaunch-count',
              },
            },
            {
              id: 'counter-bound/run-relaunch-count/claim-sleeping',
              label: 'claim',
              profile: 'claim-sleeping',
              witness: 'counter-bound/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-sleeping',
                witness: 'counter-bound/run-relaunch-count',
              },
            },
          ])
        })

        it('owns the lower bound across both claim profiles', async () => {
          const observations = await captureRelaunchClaimTargets('lower')
          expect(observations, 'mutation-verdict:behavior:poison-claim-relaunch-lower').toEqual([
            {
              id: 'counter-bound-lower/run-relaunch-count/claim-pending',
              label: 'claim',
              profile: 'claim-pending',
              witness: 'counter-bound-lower/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-pending',
                witness: 'counter-bound-lower/run-relaunch-count',
              },
            },
            {
              id: 'counter-bound-lower/run-relaunch-count/claim-sleeping',
              label: 'claim',
              profile: 'claim-sleeping',
              witness: 'counter-bound-lower/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-sleeping',
                witness: 'counter-bound-lower/run-relaunch-count',
              },
            },
          ])
        })
      })

      for (const target of POISON_TARGET_CASES) {
        if (
          highestOwnedOrdinalTargets.includes(target) ||
          exhaustedBudgetTargets.includes(target) ||
          sweepTargets.includes(target) ||
          relaunchClaimTargets.includes(target)
        ) {
          continue
        }
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
  { id: 'timestamp-boundaries', run: timestampBoundaryConformance },
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
