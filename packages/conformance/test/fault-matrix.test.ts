import { describe, expect, it } from 'vitest'
import {
  MATRIX_PRE_STATES,
  MATRIX_READ_LABELS,
  MATRIX_WRITE_LABELS,
  type MatrixFault,
  type MatrixPreState,
  runFaultMatrixCase,
} from '../src/fault-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const SEEDS = [1, 2]

/**
 * The generated fault matrix: every classified batch label x every legal
 * fault x every starting state x seeds. The label lists are asserted
 * complete against the source harvest by the label-inventory test, so a new
 * transition is enrolled the moment it exists.
 *
 * The starting-state axis exists because faults alone left a hole: a
 * duplicate was already injected at every label, but always against a
 * database whose counters were at zero, so the cap boundaries where
 * replaying a batch actually does damage were never visited.
 */
describe('fault matrix (label x fault x starting state, generated)', () => {
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
        for (const seed of SEEDS) {
          await expect(
            runFaultMatrixCase(makeLibsqlFixture, label, fault, seed, preState as MatrixPreState),
            crossingMarker,
          ).resolves.toBeUndefined()
        }
      })
    }
  }
})
