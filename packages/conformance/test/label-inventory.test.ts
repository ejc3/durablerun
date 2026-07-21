import { execFileSync } from 'node:child_process'
import {
  MATRIX_EXEMPT_LABELS,
  MATRIX_READ_LABELS,
  MATRIX_WRITE_LABELS,
} from '../src/fault-matrix.js'
import { expect, it } from 'vitest'

/**
 * Completeness gate for the fault matrix: every batch label in this store's
 * source (harvested by the SAME script the spec ledger uses — one harvester,
 * no drift) must be classified into exactly one matrix bucket. A new label
 * fails here until someone classifies it — and classifying it as WRITE or
 * READ enrolls it in the full fault matrix automatically. Coverage by
 * curation is what let the duplicated-claim bound violation survive four
 * review cycles; coverage by enumeration cannot skip a label.
 */
it('every store batch label is classified for the fault matrix', () => {
  const harvested: string[] = JSON.parse(
    execFileSync('python3', ['scripts/spec-ledger.py', '--labels'], {
      cwd: `${import.meta.dirname}/../../..`,
      encoding: 'utf8',
    }),
  )
  const classified = [...MATRIX_WRITE_LABELS, ...MATRIX_READ_LABELS, ...MATRIX_EXEMPT_LABELS].sort()
  expect(harvested).toEqual(classified)
})
