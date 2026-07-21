import { describe, expect, it } from 'vitest'
import {
  MATRIX_READ_LABELS,
  MATRIX_WRITE_LABELS,
  type MatrixFault,
  runFaultMatrixCase,
} from '../src/fault-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const SEEDS = [1, 2]

/**
 * The generated fault matrix: every classified batch label x every legal
 * fault x seeds. Nothing here is curated — the label lists are asserted
 * complete against the source harvest by the label-inventory test, so a
 * new transition is enrolled the moment it exists.
 */
describe('fault matrix (label x fault, generated)', () => {
  const cells: [string, MatrixFault][] = []
  for (const label of MATRIX_WRITE_LABELS) {
    cells.push([label, 'crash-before'], [label, 'crash-after'], [label, 'duplicate'])
  }
  for (const label of MATRIX_READ_LABELS) {
    cells.push([label, 'crash-after'], [label, 'duplicate'])
  }

  for (const [label, fault] of cells) {
    it(`${label} survives ${fault}`, async () => {
      for (const seed of SEEDS) {
        await expect(
          runFaultMatrixCase(makeLibsqlFixture, label, fault, seed),
        ).resolves.toBeUndefined()
      }
    })
  }
})
