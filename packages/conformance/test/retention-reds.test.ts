import { type SqlExecutor, type SqlStatement, TERMINAL_STATES } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { TERMINAL_BATCHES } from '../src/child-tasks.js'
import { MATRIX_WRITE_LABELS } from '../src/fault-matrix.js'
import type { StoreFixtureFactory } from '../src/index.js'
import { POISON_INVOCATION } from '../src/poison-matrix.js'
import { endingStampCase, terminalPreStateCase } from '../src/retention.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * The retention surface's generated cases pass on every dialect, because every terminal
 * batch stamps the task it ends and no other label touches that stamp. A case nobody has
 * seen fail holds nothing, so each one runs here over a store that does what the case
 * forbids. The bend sits below the store, as a write that follows the batch under the
 * label, because core's build rules refuse a batch that writes a task row and leaves the
 * stamp out: the rows are the only place such a defect could show.
 */
function following(db: SqlExecutor, label: string, bend: SqlStatement): SqlExecutor {
  return {
    batch: async (name, statements, control) => {
      const results = await db.batch(name, statements, control)
      if (name === label) await db.batch('bend', [bend], 'write')
      return results
    },
  }
}

/** A fixture whose stores, the ones a case opens over an executor, all carry the bend. */
function bent(label: string, bend: SqlStatement): StoreFixtureFactory {
  return async (seed, options) => {
    const f = await makeLibsqlFixture(seed, options)
    return { ...f, storeOver: (db, buggify) => f.storeOver(following(db, label, bend), buggify) }
  }
}

const ENDED = `state IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(', ')})`

describe('the stamp case of each terminal batch can fail', () => {
  for (const batch of TERMINAL_BATCHES) {
    it(`${batch.label}: a batch that leaves the stamp NULL, or where it was, is not what the case expects`, async () => {
      const unstamped = await endingStampCase(
        bent(batch.label, { sql: `UPDATE tasks SET fence_at_ms = NULL WHERE ${ENDED}`, args: [] }),
        batch,
      )
      expect(unstamped.observed).toMatchObject({ ran: true, stampedAtMs: null })
      expect(unstamped.observed).not.toEqual(unstamped.expected)

      const stale = await endingStampCase(
        bent(batch.label, {
          sql: `UPDATE tasks SET fence_at_ms = ? WHERE ${ENDED}`,
          args: [unstamped.expected.stampedBeforeAtMs],
        }),
        batch,
      )
      expect(stale.observed).toMatchObject({
        ran: true,
        stampedAtMs: stale.expected.stampedBeforeAtMs,
      })
      expect(stale.observed).not.toEqual(stale.expected)
    })
  }
})

describe('the cell of each write label over an ended task can fail', () => {
  const TASK = POISON_INVOCATION.taskId
  // An instant no cell sets.
  const MOVED_TO = 7
  for (const label of MATRIX_WRITE_LABELS) {
    for (const state of TERMINAL_STATES) {
      it(`${label} from ${state}: a batch that moves the ended task's stamp is not what the cell expects`, async () => {
        const { observed, expected } = await terminalPreStateCase(
          bent(label, {
            sql: 'UPDATE tasks SET fence_at_ms = ? WHERE task_id = ?',
            args: [MOVED_TO, TASK],
          }),
          label,
          state,
        )
        expect(observed.tasks[TASK]?.after.stampedAtMs).toBe(MOVED_TO)
        expect(expected.tasks[TASK]?.after.stampedAtMs).not.toBe(MOVED_TO)
        expect(observed).not.toEqual(expected)
      })
    }
  }
})
