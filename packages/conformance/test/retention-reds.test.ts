import { type SqlExecutor, type SqlStatement, TERMINAL_STATES } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MATRIX_WRITE_LABELS } from '../src/fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from '../src/index.js'
import {
  ENDED_PRE_STATES,
  ENDED_TASK_SHAPE_CELLS,
  POISON_INVOCATION,
} from '../src/poison-matrix.js'
import { type GridCell, runGridCells } from '../src/retention-grid.js'
import {
  endedChildReplayCase,
  endingStampCase,
  endingStampCases,
  terminalPreStateCase,
} from '../src/retention.js'
import { bent } from './bent-fixture.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * The retention surface's generated cases pass on every dialect, because every terminal
 * batch stamps the task it ends and no other label touches that stamp. A case nobody has
 * seen fail holds nothing, so each one runs here over a store that does what the case
 * forbids. The bend sits below the store, as a write that follows the batch under the
 * label, because core's build rules refuse a batch that writes a task row and leaves the
 * stamp out: the rows are the only place such a defect could show. `bent`, in
 * bent-fixture.ts, is that fixture.
 */

/**
 * A fixture whose ports answer the first call made over an executor without sending
 * anything, as a store would that skipped the batch for a task it took to have ended.
 * Every later call goes through. The first call is counted by executor, because a purge
 * is sent through retention's port and every other label through the store's.
 */
const skippingTheFirstCall: StoreFixtureFactory = async (seed, options) => {
  const f = await makeLibsqlFixture(seed, options)
  const called = new WeakSet<SqlExecutor>()
  const isTheFirstCallOver = (db: SqlExecutor): boolean => {
    if (called.has(db)) return false
    called.add(db)
    return true
  }
  return {
    ...f,
    storeOver: (db, buggify) => {
      const store = f.storeOver(db, buggify)
      return new Proxy(store, {
        get(target, member) {
          const value: unknown = Reflect.get(target, member, target)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) =>
            isTheFirstCallOver(db)
              ? Promise.resolve(undefined)
              : (value.apply(target, args) as unknown)
        },
      }) as ReturnType<StoreFixture['storeOver']>
    },
    retentionOver: (db) => {
      const retention = f.retentionOver(db)
      // Core's retention is frozen, which a proxy may not answer differently from, so its
      // two methods are wrapped by name.
      return {
        ...retention,
        purgeCandidates: (...args) =>
          isTheFirstCallOver(db)
            ? (Promise.resolve(undefined) as never)
            : retention.purgeCandidates(...args),
        purgeUnit: (...args) =>
          isTheFirstCallOver(db)
            ? (Promise.resolve(undefined) as never)
            : retention.purgeUnit(...args),
      }
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
    for (const state of ENDED_PRE_STATES) {
      it(`${label} from ${state}: a batch that moves the ended task's stamp is not what the cell expects`, async () => {
        const { observed, expected } = await terminalPreStateCase(
          bent(label, {
            sql: 'UPDATE tasks SET fence_at_ms = ? WHERE task_id = ?',
            args: [MOVED_TO, TASK],
          }),
          label,
          state,
        )
        expect(observed.tasks[TASK]?.after?.stampedAtMs).toBe(MOVED_TO)
        expect(expected.tasks[TASK]?.after?.stampedAtMs).not.toBe(MOVED_TO)
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
        (task) => task.before.stampedAtMs !== null && task.after?.stampedAtMs === null,
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
        expect(observed.child.after?.stampedAtMs).toBe(MOVED_TO)
        expect(observed).not.toEqual(expected)
      })
    }
  }
})

/**
 * The purge's batch with one statement rewritten below the store, as `bent` rewrites what
 * follows a batch. Core's build rules refuse a delete that names no key or no stamp, so a
 * purge that lost either can only be shown where the statements reach the database.
 */
function purgingWith(rewrite: (statement: SqlStatement) => SqlStatement): StoreFixtureFactory {
  return async (seed, options) => {
    const f = await makeLibsqlFixture(seed, options)
    return {
      ...f,
      retentionOver: (db) =>
        f.retentionOver({
          batch: (label, statements, control) =>
            db.batch(label, label === 'purge-unit' ? statements.map(rewrite) : statements, control),
        }),
    }
  }
}

const unit = (unitState: GridCell['unit'], age: GridCell['age']): GridCell => ({
  unit: unitState,
  parent: 'none',
  parentQueue: "the child's",
  holder: 'none',
  age,
})

describe('the grid can fail: a purge whose delete lost its key or its stamp', () => {
  it('a delete of checkpoints that lost its key takes the checkpoints of a unit the purge was not sent for, and the count of what the unit held refuses it', async () => {
    // The first cell's unit is younger than its window and is kept, with its checkpoint.
    // The second cell's purge wins, and its delete of checkpoints names no task.
    const lostItsKey = purgingWith((statement) =>
      statement.sql.startsWith('delete from "checkpoints"')
        ? {
            ...statement,
            sql: 'DELETE FROM checkpoints WHERE EXISTS (SELECT 1 FROM tasks f WHERE f.fence_stamp = ?)',
            args: statement.args.slice(-1),
          }
        : statement,
    )
    await expect(
      runGridCells(lostItsKey, 'lost key', [unit('completed', -1), unit('completed', 1)]),
    ).rejects.toThrow(
      /the batch deleted 2 rows of checkpoints, and the unit its compare-and-set read held 1/,
    )
  })

  it('a delete of runs that lost its stamp takes the runs of a unit the barrier keeps, and the dump and the row checks say so', async () => {
    // The unit is younger than its window, so the compare-and-set matches nothing. A delete
    // keyed on the task alone runs all the same, and the purge answers that it took nothing.
    const lostItsStamp = purgingWith((statement) => {
      if (!statement.sql.startsWith('delete from "runs"')) return statement
      const { skipUnlessWrote: _gate, ...ungated } = statement
      return {
        ...ungated,
        sql: 'DELETE FROM runs WHERE task_id = ?',
        args: statement.args.slice(0, 1),
      }
    })
    const { observed, expected } = await runGridCells(lostItsStamp, 'lost stamp', [
      unit('completed', -1),
    ])
    const [cell] = observed
    expect({
      purged: cell?.purged,
      lostARun: cell?.differences.some((difference) => difference.startsWith('runs lost ')),
      namedByTheRowChecks: cell?.violations.after.some((violation) =>
        violation.startsWith('task-without-a-run: '),
      ),
    }).toEqual({ purged: null, lostARun: true, namedByTheRowChecks: true })
    expect(observed).not.toEqual(expected)
  })
})
