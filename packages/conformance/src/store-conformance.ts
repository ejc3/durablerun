import { SAGA_PHASE_CHECKPOINT } from '@durablerun/core'
import { attributeExpectedFailure } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { childTaskConformance } from './child-tasks.js'
import {
  MATRIX_PRE_STATES,
  MATRIX_READ_LABELS,
  MATRIX_WRITE_LABELS,
  type MatrixFault,
  runFaultMatrixCase,
} from './fault-matrix.js'
import type { StoreFixtureFactory } from './fixture.js'
import { identifierBoundConformance } from './identifier-bound.js'
import { ENGINE_INVARIANT_CONDITIONS } from './invariants.js'
import {
  POISON_ADDRESSED_PROFILES,
  POISON_AGGREGATE_WITNESSES,
  POISON_TARGET_CASES,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  POISON_WITNESS_COUNT,
  POISON_WRITE_LABELS,
  PROBE_STEP_STARTED,
  type PoisonAddressedProfile,
  type PoisonRelationalTargetRecord,
  type PoisonTargetCase,
  type PoisonTargetProfile,
  ROLLBACK_TRIED,
  duplicatePoisonWitnessIds,
  observeCleanAddressedProfile,
  observePoisonAggregateAmbientCase,
  observePoisonAggregateTargetCase,
  runPoisonMatrixCase,
  runPoisonTargetCase,
  uncoveredConditionIds,
  unknownCoveredConditionIds,
} from './poison-matrix.js'
import { sagaConformance } from './sagas.js'
import { schemaAdminConformance } from './schema-admin.js'
import { selfConcurrencyConformance } from './self-concurrency.js'
import { staleTokenConformance } from './stale-token-column.js'
import { schedulerConformance, wakeWitnessConformance } from './suite.js'
import { timestampBoundaryConformance } from './time-boundaries.js'

const FAULT_SEEDS = [1, 2] as const

/**
 * How long one ownership test of the fault matrix may take. It runs every generated cell
 * and seed from one starting state, one after another, and how long that takes is the
 * runner's to decide: one tree ran the slowest of the five on PostgreSQL in 68 seconds on
 * one CI runner and in more than 120 on another. So the limit is set against the slowest
 * CI runner observed, not against a local figure. There the four older starting states
 * took 106 to 116 seconds, and the saga block runs 10 to 15 percent above them, so about
 * 130. This is a bit over twice that, so a cell that hangs still ends its test in five
 * minutes. BUILD.md's PR3.4 entry has the measurements.
 */
const OWNERSHIP_TEST_TIMEOUT_MS = 300_000

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
      it(
        `owns ${preState} across every generated label/fault cell and seed`,
        async () => {
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
            'saga-cap-edges': 'mutation-verdict:behavior:fault-matrix-edge-crossing:saga-cap-edges',
          }[preState]
          expect(observed, crossingMarker).toEqual(
            cellSeedVector.map(({ label, fault, seed }) => ({
              label,
              fault,
              seed,
              outcome: 'resolved',
            })),
          )
        },
        OWNERSHIP_TEST_TIMEOUT_MS,
      )
    }
  })
}

function poisonMatrixConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`poison matrix [${dialect}] (ambient write label x forbidden pre-state)`, () => {
    type FractionalWitnessId = Extract<
      keyof PoisonRelationalTargetRecord,
      `counter-fractional/${string}`
    >
    type FractionalTargetId = `${FractionalWitnessId}/${PoisonTargetProfile}`
    type AmbientPoisonCase = Readonly<{
      label: (typeof POISON_WRITE_LABELS)[number]
      witness: PoisonTargetCase['witness']
    }>
    type AmbientObservation = Readonly<
      {
        id: `ambient/${(typeof POISON_WRITE_LABELS)[number]}`
        label: (typeof POISON_WRITE_LABELS)[number]
        witness: PoisonTargetCase['witness']['id']
      } & (
        | {
            kind: 'resolved'
            result: { label: string; witness: PoisonTargetCase['witness']['id'] }
          }
        | { kind: 'rejected'; error: string }
      )
    >
    type TargetObservation = Readonly<
      {
        id: PoisonTargetCase['id']
        label: PoisonTargetCase['label']
        profile: PoisonTargetCase['profile']
        witness: PoisonTargetCase['witness']['id']
      } & (
        | {
            kind: 'resolved'
            result: {
              label: string
              profile: PoisonTargetCase['profile'] | undefined
              witness: PoisonTargetCase['witness']['id']
            }
          }
        | { kind: 'rejected'; error: string }
      )
    >
    const fractionalWitnessIds = {
      taskMaxAttempts: 'counter-fractional/task-max-attempts',
      runRelaunchCount: 'counter-fractional/run-relaunch-count',
    } as const satisfies Readonly<Record<string, FractionalWitnessId>>
    const fractionalWitness = (id: FractionalWitnessId): PoisonTargetCase['witness'] => {
      const witness = POISON_WITNESSES.find((candidate) => candidate.id === id)
      if (!witness) throw new Error(`missing fractional poison witness ${id}`)
      return witness
    }
    const fractionalWitnesses = {
      taskMaxAttempts: fractionalWitness(fractionalWitnessIds.taskMaxAttempts),
      runRelaunchCount: fractionalWitness(fractionalWitnessIds.runRelaunchCount),
    } as const
    const fractionalTarget = (id: FractionalTargetId): PoisonTargetCase => {
      const target = POISON_TARGET_CASES.find((candidate) => candidate.id === id)
      if (!target) throw new Error(`missing fractional poison target ${id}`)
      return target
    }
    const fractionalTargets = {
      taskMaxAttempts: {
        claim: [
          fractionalTarget(`${fractionalWitnessIds.taskMaxAttempts}/claim-pending`),
          fractionalTarget(`${fractionalWitnessIds.taskMaxAttempts}/claim-sleeping`),
        ],
        sweep: [
          fractionalTarget(`${fractionalWitnessIds.taskMaxAttempts}/sweep-lost-launch`),
          fractionalTarget(`${fractionalWitnessIds.taskMaxAttempts}/sweep-claim-timeout`),
        ],
      },
      runRelaunchCount: {
        claim: [
          fractionalTarget(`${fractionalWitnessIds.runRelaunchCount}/claim-pending`),
          fractionalTarget(`${fractionalWitnessIds.runRelaunchCount}/claim-sleeping`),
        ],
        sweep: [
          fractionalTarget(`${fractionalWitnessIds.runRelaunchCount}/sweep-lost-launch`),
          fractionalTarget(`${fractionalWitnessIds.runRelaunchCount}/sweep-claim-timeout`),
        ],
      },
    } as const
    const fractionalAmbientLabels = {
      claim: POISON_WRITE_LABELS.filter((label) => label === 'claim'),
      sweep: POISON_WRITE_LABELS.filter(
        (label) => label === 'sweep:lost-launch' || label === 'sweep:claim-timeout',
      ),
    }
    const ambientCasesFor = (
      witness: PoisonTargetCase['witness'],
      labels: readonly (typeof POISON_WRITE_LABELS)[number][],
    ): readonly AmbientPoisonCase[] => labels.map((label) => ({ label, witness }))
    const fractionalOwnedAmbientCases = {
      taskMaxAttempts: {
        claim: ambientCasesFor(fractionalWitnesses.taskMaxAttempts, fractionalAmbientLabels.claim),
        sweep: ambientCasesFor(fractionalWitnesses.taskMaxAttempts, fractionalAmbientLabels.sweep),
      },
      runRelaunchCount: {
        claim: ambientCasesFor(fractionalWitnesses.runRelaunchCount, fractionalAmbientLabels.claim),
        sweep: ambientCasesFor(fractionalWitnesses.runRelaunchCount, fractionalAmbientLabels.sweep),
      },
    } as const
    const ambientCaseKey = (
      label: (typeof POISON_WRITE_LABELS)[number],
      witness: PoisonTargetCase['witness'],
    ): string => `${label}\u0000${witness.id}`
    const fractionalOwnedAmbientCaseKeys = new Set(
      [
        ...fractionalOwnedAmbientCases.taskMaxAttempts.claim,
        ...fractionalOwnedAmbientCases.taskMaxAttempts.sweep,
        ...fractionalOwnedAmbientCases.runRelaunchCount.claim,
        ...fractionalOwnedAmbientCases.runRelaunchCount.sweep,
      ].map(({ label, witness }) => ambientCaseKey(label, witness)),
    )

    it('covers every invariant and keeps the atomic witness inventory pinned', () => {
      expect(uncoveredConditionIds(), 'persisted counter field inventory stays complete').toEqual(
        [],
      )
      expect(unknownCoveredConditionIds()).toEqual([])
      expect(duplicatePoisonWitnessIds()).toEqual([])
      expect(ENGINE_INVARIANT_CONDITIONS).toHaveLength(115)
      expect(POISON_WITNESS_COUNT).toBe(146)
      expect(POISON_WRITE_LABELS).toHaveLength(21)
      expect(POISON_WRITE_LABELS.length * POISON_WITNESS_COUNT).toBe(3_066)
      expect(POISON_TARGET_CASES).toHaveLength(98)
      expect(POISON_UNREACHABLE_TARGETS).toHaveLength(83)
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
        if (fractionalOwnedAmbientCaseKeys.has(ambientCaseKey(label, witness))) continue
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
              /^Error: cancel-task\/ownership\/run-task-queue-mismatch: new invariant violation: running-run-under-non-running-task: poison-run; new invariant violation: terminal-task-with-live-run: poison-task\/poison-run$/,
              run,
            )
            if (result.corruptionDisposition !== 'injected') {
              throw new Error('cancel queue ownership poison was structurally rejected')
            }
            expect(result).toMatchObject({
              label,
              witness: witness.id,
              invocation: {
                target: 'poison',
                status: 'fulfilled',
                result: false,
              },
              poisonSubjectUnchanged: true,
            })
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
      const nonExhaustedSweepTargets = sweepTargets.filter(
        (target) => !exhaustedBudgetTargets.includes(target),
      )
      const relaunchClaimWitnessIds = {
        upper: 'counter-bound/run-relaunch-count',
        lower: 'counter-bound-lower/run-relaunch-count',
      } as const
      const fractionalClaimTargets: readonly PoisonTargetCase[] = [
        ...fractionalTargets.taskMaxAttempts.claim,
        ...fractionalTargets.runRelaunchCount.claim,
      ]
      const fractionalSweepTargets: readonly PoisonTargetCase[] = [
        ...fractionalTargets.taskMaxAttempts.sweep,
        ...fractionalTargets.runRelaunchCount.sweep,
      ]
      const coreSweepTargets = nonExhaustedSweepTargets.filter(
        (target) => !fractionalSweepTargets.includes(target),
      )
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
      const captureTargetObservations = async (
        targets: readonly PoisonTargetCase[],
      ): Promise<TargetObservation[]> => {
        const observations: TargetObservation[] = []
        for (const target of targets) {
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
      const captureAmbientObservations = async (
        cases: readonly AmbientPoisonCase[],
      ): Promise<AmbientObservation[]> => {
        const observations: AmbientObservation[] = []
        for (const { label, witness } of cases) {
          observations.push(
            await runPoisonMatrixCase(makeFixture, label, witness).then(
              (result) => ({
                id: `ambient/${label}` as const,
                label,
                witness: witness.id,
                kind: 'resolved',
                result: { label: result.label, witness: result.witness },
              }),
              (error: unknown) => ({
                id: `ambient/${label}` as const,
                label,
                witness: witness.id,
                kind: 'rejected',
                error: String(error),
              }),
            ),
          )
        }
        return observations
      }
      const captureRelaunchClaimTargets = (side: keyof typeof relaunchClaimWitnessIds) =>
        captureTargetObservations(
          relaunchClaimTargets.filter(
            (candidate) => candidate.witness.id === relaunchClaimWitnessIds[side],
          ),
        )

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
            'defer-launch',
            'suspend',
            'emit-event',
            'await-event',
            'record-task-done',
            'complete',
            'fail',
            'fail-rollback',
            'cancel-task',
            'retry-task',
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
          {
            id: 'accounting/live-run-not-next/activate-unactivated',
            kind: 'observed',
            observation: {
              label: 'activate',
              profile: 'activate-unactivated',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/defer-launch-unactivated',
            kind: 'observed',
            observation: {
              label: 'defer-launch',
              profile: 'defer-launch-unactivated',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/fail-started-step',
            kind: 'observed',
            observation: {
              label: 'fail',
              profile: 'fail-started-step',
              witness: 'accounting/live-run-not-next',
              conditionIds: ['accounting/live-run-not-next'],
              corruptionDisposition: 'injected',
            },
          },
          {
            id: 'accounting/live-run-not-next/fail-rollback-rolling-back',
            kind: 'observed',
            observation: {
              label: 'fail-rollback',
              profile: 'fail-rollback-rolling-back',
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

      it('contains fractional task max-attempts across both claim profiles', async () => {
        const ambientObservations = await captureAmbientObservations(
          fractionalOwnedAmbientCases.taskMaxAttempts.claim,
        )
        const targetObservations = await captureTargetObservations(
          fractionalTargets.taskMaxAttempts.claim,
        )

        expect(
          { ambient: ambientObservations, targets: targetObservations },
          'mutation-verdict:behavior:poison-claim-fractional-task-max-attempts',
        ).toEqual({
          ambient: [
            {
              id: 'ambient/claim',
              label: 'claim',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'claim',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
          ],
          targets: [
            {
              id: 'counter-fractional/task-max-attempts/claim-pending',
              label: 'claim',
              profile: 'claim-pending',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-pending',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
            {
              id: 'counter-fractional/task-max-attempts/claim-sleeping',
              label: 'claim',
              profile: 'claim-sleeping',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-sleeping',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
          ],
        })
      })

      it('contains fractional run relaunch-count across both claim profiles', async () => {
        const ambientObservations = await captureAmbientObservations(
          fractionalOwnedAmbientCases.runRelaunchCount.claim,
        )
        const targetObservations = await captureTargetObservations(
          fractionalTargets.runRelaunchCount.claim,
        )

        expect(
          { ambient: ambientObservations, targets: targetObservations },
          'mutation-verdict:behavior:poison-claim-fractional-run-relaunch-count',
        ).toEqual({
          ambient: [
            {
              id: 'ambient/claim',
              label: 'claim',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
          ],
          targets: [
            {
              id: 'counter-fractional/run-relaunch-count/claim-pending',
              label: 'claim',
              profile: 'claim-pending',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-pending',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
            {
              id: 'counter-fractional/run-relaunch-count/claim-sleeping',
              label: 'claim',
              profile: 'claim-sleeping',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'claim',
                profile: 'claim-sleeping',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
          ],
        })
      })

      it('contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths', async () => {
        const nonExhaustedObservations = await captureTargetObservations(nonExhaustedSweepTargets)
        const observationsFor = (targets: readonly PoisonTargetCase[]): TargetObservation[] => {
          const targetIds = new Set(targets.map((target) => target.id))
          return nonExhaustedObservations.filter((observation) => targetIds.has(observation.id))
        }
        const coreObservations = observationsFor(coreSweepTargets)
        const fractionalTaskMaxObservations = observationsFor(
          fractionalTargets.taskMaxAttempts.sweep,
        )
        const fractionalRelaunchObservations = observationsFor(
          fractionalTargets.runRelaunchCount.sweep,
        )
        const fractionalTaskMaxAmbientObservations = await captureAmbientObservations(
          fractionalOwnedAmbientCases.taskMaxAttempts.sweep,
        )
        const fractionalRelaunchAmbientObservations = await captureAmbientObservations(
          fractionalOwnedAmbientCases.runRelaunchCount.sweep,
        )

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
          await receiptFixture.close()
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
              core: coreSweepTargets.length,
              fractionalTaskMax: fractionalTargets.taskMaxAttempts.sweep.length,
              fractionalRelaunch: fractionalTargets.runRelaunchCount.sweep.length,
              exhausted: sweepTargets.length - nonExhaustedSweepTargets.length,
            },
            observations: coreObservations,
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
          partitionSizes: {
            all: 24,
            nonExhausted: 22,
            core: 18,
            fractionalTaskMax: 2,
            fractionalRelaunch: 2,
            exhausted: 2,
          },
          observations: coreSweepTargets.map((target) => ({
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
            ambient: fractionalTaskMaxAmbientObservations,
            targets: fractionalTaskMaxObservations,
          },
          'mutation-verdict:behavior:poison-sweep-fractional-task-max-attempts',
        ).toEqual({
          ambient: [
            {
              id: 'ambient/sweep:lost-launch',
              label: 'sweep:lost-launch',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'sweep:lost-launch',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
            {
              id: 'ambient/sweep:claim-timeout',
              label: 'sweep:claim-timeout',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'sweep:claim-timeout',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
          ],
          targets: [
            {
              id: 'counter-fractional/task-max-attempts/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'sweep:lost-launch',
                profile: 'sweep-lost-launch',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
            {
              id: 'counter-fractional/task-max-attempts/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-fractional/task-max-attempts',
              kind: 'resolved',
              result: {
                label: 'sweep:claim-timeout',
                profile: 'sweep-claim-timeout',
                witness: 'counter-fractional/task-max-attempts',
              },
            },
          ],
        })

        expect(
          {
            ambient: fractionalRelaunchAmbientObservations,
            targets: fractionalRelaunchObservations,
          },
          'mutation-verdict:behavior:poison-sweep-fractional-run-relaunch-count',
        ).toEqual({
          ambient: [
            {
              id: 'ambient/sweep:lost-launch',
              label: 'sweep:lost-launch',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'sweep:lost-launch',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
            {
              id: 'ambient/sweep:claim-timeout',
              label: 'sweep:claim-timeout',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'sweep:claim-timeout',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
          ],
          targets: [
            {
              id: 'counter-fractional/run-relaunch-count/sweep-lost-launch',
              label: 'sweep:lost-launch',
              profile: 'sweep-lost-launch',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'sweep:lost-launch',
                profile: 'sweep-lost-launch',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
            {
              id: 'counter-fractional/run-relaunch-count/sweep-claim-timeout',
              label: 'sweep:claim-timeout',
              profile: 'sweep-claim-timeout',
              witness: 'counter-fractional/run-relaunch-count',
              kind: 'resolved',
              result: {
                label: 'sweep:claim-timeout',
                profile: 'sweep-claim-timeout',
                witness: 'counter-fractional/run-relaunch-count',
              },
            },
          ],
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
            {
              profile: 'activate-unactivated',
              kind: 'resolved',
              result: {
                label: 'activate',
                witness: 'attempts/at-max-with-live-run',
                profile: 'activate-unactivated',
              },
            },
            {
              profile: 'defer-launch-unactivated',
              kind: 'resolved',
              result: {
                label: 'defer-launch',
                witness: 'attempts/at-max-with-live-run',
                profile: 'defer-launch-unactivated',
              },
            },
            {
              profile: 'fail-started-step',
              kind: 'resolved',
              result: {
                label: 'fail',
                witness: 'attempts/at-max-with-live-run',
                profile: 'fail-started-step',
              },
            },
            {
              profile: 'fail-rollback-rolling-back',
              kind: 'resolved',
              result: {
                label: 'fail-rollback',
                witness: 'attempts/at-max-with-live-run',
                profile: 'fail-rollback-rolling-back',
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

      // A targeted refusal is the corruption's only if the same call acts on the same
      // profile with nothing corrupt. An arm that names its target shows that here. An arm
      // that scans has no such control: its cell shows the one call acting on the healthy
      // trigger, and not on the profile.
      // Where each clean call leaves the poisoned task: its state, its runs in order, and its
      // checkpoints. The type asks a new profile for its answer.
      const cleanEffects = {
        'activate-unactivated': { task: 'running', runs: ['1 running'], checkpoints: [] },
        'defer-launch-unactivated': { task: 'sleeping', runs: ['1 sleeping'], checkpoints: [] },
        'retry-task-failed': { task: 'pending', runs: ['1 failed', '2 pending'], checkpoints: [] },
        // The failure entered the rolling-back phase where it would have ended the task: the
        // rollback pass is the task's second run, and the phase marker stands beside the step.
        'fail-started-step': {
          task: 'pending',
          runs: ['1 failed', '2 pending'],
          checkpoints: [SAGA_PHASE_CHECKPOINT, PROBE_STEP_STARTED],
        },
        // The failed rollback ended the task, with its attempt recorded.
        'fail-rollback-rolling-back': {
          task: 'failed',
          runs: ['1 failed'],
          checkpoints: [ROLLBACK_TRIED, SAGA_PHASE_CHECKPOINT, PROBE_STEP_STARTED],
        },
      } as const satisfies Record<
        PoisonAddressedProfile,
        { task: string; runs: readonly string[]; checkpoints: readonly string[] }
      >
      for (const addressed of POISON_ADDRESSED_PROFILES) {
        it(`${addressed.profile} admits ${addressed.arm} when nothing is corrupt`, async () => {
          expect(await observeCleanAddressedProfile(makeFixture, addressed)).toMatchObject({
            invocation: { status: 'fulfilled' },
            poisonSubjectUnchanged: false,
            effect: cleanEffects[addressed.profile],
          })
        })
      }

      // One registered mutation for each profile of an arm that names its target removes a
      // guard its cells reach, and the cell named here owns it, so the audit keeps showing
      // that the profile's cells can fail. A marker is a literal because the audit reads it
      // from this source.
      const targetVerdicts: Readonly<Record<string, string>> = {
        'counter-bound/run-relaunch-count/activate-unactivated':
          'mutation-verdict:behavior:poison-target-activate-holds-relaunch-bound',
        'counter-bound/run-relaunch-count/defer-launch-unactivated':
          'mutation-verdict:behavior:poison-target-defer-launch-holds-receipt-admission',
        'counter-bound/task-infra-retries/retry-task-failed':
          'mutation-verdict:behavior:poison-target-retry-task-holds-infra-retries-bound',
        'accounting/below-top-minus-one/fail-started-step':
          'mutation-verdict:behavior:poison-target-fail-holds-highest-owned-ordinal',
        'accounting/below-top-minus-one/fail-rollback-rolling-back':
          'mutation-verdict:behavior:poison-target-fail-rollback-holds-highest-owned-ordinal',
      }
      const generatedTargets = POISON_TARGET_CASES.filter(
        (target) =>
          !highestOwnedOrdinalTargets.includes(target) &&
          !exhaustedBudgetTargets.includes(target) &&
          !sweepTargets.includes(target) &&
          !fractionalClaimTargets.includes(target) &&
          !relaunchClaimTargets.includes(target),
      )
      const strandedVerdicts = Object.keys(targetVerdicts).filter(
        (id) => !generatedTargets.some((target) => target.id === id),
      )
      if (strandedVerdicts.length > 0) {
        throw new Error(`no generated poison target case owns ${strandedVerdicts.join(', ')}`)
      }
      for (const target of generatedTargets) {
        it(`${target.profile} contains ${target.witness.id}`, async () => {
          const { id, label, profile, witness } = target
          expect(await captureTargetObservations([target]), targetVerdicts[id]).toEqual([
            {
              id,
              label,
              profile,
              witness: witness.id,
              kind: 'resolved',
              result: { label, profile, witness: witness.id },
            },
          ])
        })
      }
    })
  })
}

type StoreConformanceRunner = (dialect: string, makeFixture: StoreFixtureFactory) => void
type RegisteredSurface<Id extends string> = Readonly<{
  id: Id
  run: StoreConformanceRunner
}>
type BoundStoreConformance<Id extends string> = StoreConformanceRunner &
  Readonly<{ surfaces: readonly RegisteredSurface<Id>[] }>

/**
 * Binds the observable surface inventory and executable dispatch into one
 * value. The copies prevent a caller from changing an enrolled record after
 * binding; the callable and its registry are immutable once returned.
 */
export function bindStoreConformanceSurfaces<const Id extends string>(
  surfaces: readonly RegisteredSurface<Id>[],
): BoundStoreConformance<Id> {
  const registeredSurfaces = Object.freeze(
    surfaces.map(({ id, run }) => Object.freeze({ id, run })),
  )
  const dispatch = Object.assign(
    (dialect: string, makeFixture: StoreFixtureFactory): void => {
      for (const { run } of registeredSurfaces) {
        run(dialect, makeFixture)
      }
    },
    { surfaces: registeredSurfaces },
  )
  return Object.freeze(dispatch)
}

/**
 * The one enrollment door for a dialect. Adding a store fixture necessarily
 * runs every shared behavioral surface; individual backends cannot silently
 * opt out of the fault, poison, wake, timestamp, or schema/admin dimensions.
 */
export const storeConformance = bindStoreConformanceSurfaces([
  { id: 'scheduler', run: schedulerConformance },
  { id: 'fault-matrix', run: faultMatrixConformance },
  { id: 'poison-matrix', run: poisonMatrixConformance },
  { id: 'timestamp-boundaries', run: timestampBoundaryConformance },
  { id: 'wake-witness', run: wakeWitnessConformance },
  { id: 'child-tasks', run: childTaskConformance },
  { id: 'sagas', run: sagaConformance },
  { id: 'identifier-bound', run: identifierBoundConformance },
  { id: 'schema-admin', run: schemaAdminConformance },
  { id: 'self-concurrency', run: selfConcurrencyConformance },
  { id: 'stale-token', run: staleTokenConformance },
] as const)
