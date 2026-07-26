import { describe, expect, it } from 'vitest'
import { ENGINE_INVARIANT_CONDITIONS } from '../src/invariants.js'
import {
  POISON_WITNESSES,
  POISON_WITNESS_COUNT,
  POISON_WRITE_LABELS,
  duplicatePoisonWitnessIds,
  runPoisonMatrixCase,
  uncoveredConditionIds,
  unknownCoveredConditionIds,
} from '../src/poison-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'
import { attributeExpectedFailure } from './mutation-verdict.js'

describe('poison matrix (write label x invariant-forbidden pre-state, generated)', () => {
  it('covers every invariant and keeps the atomic witness inventory pinned', () => {
    expect(uncoveredConditionIds()).toEqual([])
    expect(unknownCoveredConditionIds()).toEqual([])
    expect(duplicatePoisonWitnessIds()).toEqual([])
    expect(ENGINE_INVARIANT_CONDITIONS).toHaveLength(50)
    expect(POISON_WITNESS_COUNT).toBe(47)
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
        const run = () => runPoisonMatrixCase(makeLibsqlFixture, label, witness)
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
