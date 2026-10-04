import { type SqlExecutor, type SqlStatement, TERMINAL_STATES } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MATRIX_WRITE_LABELS } from '../src/fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from '../src/index.js'
import { ENDED_TASK_SHAPE_CELLS, POISON_INVOCATION } from '../src/poison-matrix.js'
import {
  endedChildReplayCase,
  endingStampCase,
  endingStampCases,
  terminalPreStateCase,
} from '../src/retention.js'
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

/**
 * A fixture whose stores answer their first call without sending anything, as a store
 * would that skipped the batch for a task it took to have ended. Every later call goes
 * through.
 */
const skippingTheFirstCall: StoreFixtureFactory = async (seed, options) => {
  const f = await makeLibsqlFixture(seed, options)
  return {
    ...f,
    storeOver: (db, buggify) => {
      const store = f.storeOver(db, buggify)
      let skipped = false
      return new Proxy(store, {
        get(target, member) {
          const value: unknown = Reflect.get(target, member, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (skipped) return value.apply(target, args) as unknown
            skipped = true
            return Promise.resolve(undefined)
          }
        },
      }) as ReturnType<StoreFixture['storeOver']>
    },
  }
}

const ENDED = `state IN (${TERMINAL_STATES.map((state) => `'${state}'`).join(', ')})`
// An instant no case sets.
const MOVED_TO = 7

describe('the stamp case of each path through a terminal batch can fail', () => {
  for (const stampCase of endingStampCases()) {
    const { label, variant, ending } = stampCase
    it(`${label}/${variant}, ${ending.path}: a batch that leaves the stamp NULL, or where it was, is not what the case expects`, async () => {
      const unstamped = await endingStampCase(
        bent(label, { sql: `UPDATE tasks SET fence_at_ms = NULL WHERE ${ENDED}`, args: [] }),
        stampCase,
      )
      expect(unstamped.observed).toMatchObject({ sent: `${label}/${variant}`, stampedAtMs: null })
      expect(unstamped.observed).not.toEqual(unstamped.expected)

      const stale = await endingStampCase(
        bent(label, {
          sql: `UPDATE tasks SET fence_at_ms = ? WHERE ${ENDED}`,
          args: [unstamped.expected.stampedBeforeAtMs],
        }),
        stampCase,
      )
      expect(stale.observed).toMatchObject({
        sent: `${label}/${variant}`,
        stampedAtMs: stale.expected.stampedBeforeAtMs,
      })
      expect(stale.observed).not.toEqual(stale.expected)
    })
  }
})

describe('the cell of each write label over an ended task can fail', () => {
  const TASK = POISON_INVOCATION.taskId
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

      it(`${label} from ${state}: a store that sends nothing for the ended task is not what the cell expects`, async () => {
        const { observed, expected } = await terminalPreStateCase(
          skippingTheFirstCall,
          label,
          state,
        )
        expect(observed.reachedTheEndedTask).toBe(false)
        expect(expected.reachedTheEndedTask).toBe(true)
        expect(observed).not.toEqual(expected)
      })
    }
  }

  // The healthy call of `record-task-done` records the outcome of a task the engine ended,
  // which carries the stamp its terminal batch wrote.
  for (const state of TERMINAL_STATES) {
    it(`record-task-done from ${state}: a batch that clears the stamp of the ended task whose outcome it records is not what the cell expects`, async () => {
      const { observed, expected } = await terminalPreStateCase(
        bent('record-task-done', {
          sql: `UPDATE tasks SET fence_at_ms = NULL WHERE task_name = 'ended-unrecorded'`,
          args: [],
        }),
        'record-task-done',
        state,
      )
      const cleared = Object.values(observed.tasks).filter(
        (task) => task.before.stampedAtMs !== null && task.after.stampedAtMs === null,
      )
      expect(cleared).toHaveLength(1)
      expect(observed).not.toEqual(expected)
    })
  }

  for (const shape of Object.keys(
    ENDED_TASK_SHAPE_CELLS,
  ) as (keyof typeof ENDED_TASK_SHAPE_CELLS)[]) {
    for (const state of TERMINAL_STATES) {
      it(`a replayed spawn of a ${state} child: a batch that moves the child's stamp is not what the cell expects`, async () => {
        const { observed, expected } = await endedChildReplayCase(
          bent('spawn', {
            sql: `UPDATE tasks SET fence_at_ms = ? WHERE task_name = 'trigger' AND ${ENDED}`,
            args: [MOVED_TO],
          }),
          shape,
          state,
        )
        expect(observed.child.after.stampedAtMs).toBe(MOVED_TO)
        expect(observed).not.toEqual(expected)
      })
    }
  }
})
