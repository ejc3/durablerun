import type { SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  type MatrixFault,
  type StoreFixtureFactory,
  matrixHistoryViolations,
  missingCompletionEvent,
  runFaultMatrixCase,
} from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

const COMPLETION_EVENT = '$task-done:'

/**
 * An executor that records every completion event under another task's name. The bend
 * sits below the store, where none of core's build rules reads it, so the batch still
 * carries its event insert and only the rows can show that a task's own event is missing.
 */
function recordsAnotherTasksEvent(db: SqlExecutor): SqlExecutor {
  return {
    batch: (label, statements, control) =>
      db.batch(
        label,
        statements.map((statement) =>
          /^insert into ["`]events["`]/i.test(statement.sql)
            ? {
                ...statement,
                args: statement.args.map((arg) =>
                  typeof arg === 'string' && arg.startsWith(COMPLETION_EVENT)
                    ? `${COMPLETION_EVENT}another-task`
                    : arg,
                ),
              }
            : statement,
        ),
        control,
      ),
  }
}

const bentFixture: StoreFixtureFactory = async (seed, options) => {
  const f = await makeLibsqlFixture(seed, options)
  return { ...f, storeOver: (db, buggify) => f.storeOver(recordsAnotherTasksEvent(db), buggify) }
}

/**
 * An executor that leaves the completion event out of one task's `complete`, and out of
 * no other batch. The task is found by its name when the batch arrives.
 */
function losesTheEventOfOneComplete(db: SqlExecutor, taskName: string): SqlExecutor {
  return {
    batch: async (label, statements, control) => {
      if (label !== 'complete') return db.batch(label, statements, control)
      const [named] = await db.batch(
        't',
        [{ sql: 'SELECT task_id FROM tasks WHERE task_name = ?', args: [taskName] }],
        'read',
      )
      const event = `${COMPLETION_EVENT}${String(named?.rows[0]?.task_id)}`
      return db.batch(
        label,
        statements.map((statement) =>
          /^insert into ["`]events["`]/i.test(statement.sql) && statement.args.includes(event)
            ? { ...statement, sql: 'SELECT 1 WHERE 1 = 0', args: [] }
            : statement,
        ),
        control,
      )
    },
  }
}

/** A fixture whose every store, the one the probe loop drives included, loses that event. */
function losingTheEventOf(taskName: string): StoreFixtureFactory {
  return async (seed, options) => {
    const f = await makeLibsqlFixture(seed, options)
    return {
      ...f,
      store: f.storeOver(losesTheEventOfOneComplete(f.raw, taskName)),
      storeOver: (db, buggify) => f.storeOver(losesTheEventOfOneComplete(db, taskName), buggify),
    }
  }
}

/** What a cell left behind, judged when the cell closes its fixture. */
type Judged = { olderBuildsChild: string; nothingExcused: string[]; childExcused: string[] }

/**
 * A fixture that, as the cell closes it, finds the child the workload ended through its
 * older build and asks the matrix's own judge about the rows twice: with nothing excused,
 * and with that child excused.
 */
function judgedAtClose(makeFixture: StoreFixtureFactory): {
  makeFixture: StoreFixtureFactory
  judged: () => Judged
} {
  let judged: Judged | undefined
  return {
    makeFixture: async (seed, options) => {
      const f = await makeFixture(seed, options)
      return {
        ...f,
        close: async () => {
          const [children] = await f.raw.batch(
            't',
            [{ sql: `SELECT task_id FROM tasks WHERE task_name = 'ended-child'`, args: [] }],
            'read',
          )
          const olderBuildsChild = String(children?.rows[0]?.task_id)
          judged = {
            olderBuildsChild,
            nothingExcused: await matrixHistoryViolations(f.raw, new Set()),
            childExcused: await matrixHistoryViolations(f.raw, new Set([olderBuildsChild])),
          }
          await f.close()
        },
      }
    },
    judged: () => {
      if (judged === undefined) throw new Error('the cell never closed its fixture')
      return judged
    },
  }
}

function cellOutcome(
  makeFixture: StoreFixtureFactory,
  label = 'complete',
  fault: MatrixFault = 'crash-after',
): Promise<string> {
  return runFaultMatrixCase(makeFixture, label, fault, 1).then(
    () => 'resolved',
    (error: unknown) => String(error),
  )
}

describe('the fault matrix judges the rows a cell leaves by every checker', () => {
  it('rejects a cell whose terminal tasks have no completion event of their own', async () => {
    expect({
      honest: await cellOutcome(makeLibsqlFixture),
      bent: await cellOutcome(bentFixture),
    }).toEqual({
      honest: 'resolved',
      bent: expect.stringContaining('terminal-task-without-completion-event'),
    })
  })

  // The batch that records an older build's ending dies before it runs, so the child that
  // build ended is still terminal with no completion event when the cell is judged.
  it('excuses the child an older build ended while no await has recorded it, and the judge reports that child when nothing is excused', async () => {
    const cell = judgedAtClose(makeLibsqlFixture)
    const outcome = await cellOutcome(cell.makeFixture, 'record-task-done', 'crash-before')
    const { olderBuildsChild, nothingExcused, childExcused } = cell.judged()
    expect({ outcome, nothingExcused, childExcused }).toEqual({
      outcome: 'resolved',
      nothingExcused: [missingCompletionEvent(olderBuildsChild)],
      childExcused: [],
    })
  })

  it('still rejects that cell when another terminal task has no completion event', async () => {
    const cell = judgedAtClose(bentFixture)
    const outcome = await cellOutcome(cell.makeFixture, 'record-task-done', 'crash-before')
    const { olderBuildsChild, childExcused } = cell.judged()
    expect({
      rejectedForAMissingEvent: outcome.includes('terminal-task-without-completion-event'),
      namesTheExcusedChild: outcome.includes(missingCompletionEvent(olderBuildsChild)),
      othersStillReported: childExcused.some((violation) =>
        violation.startsWith('terminal-task-without-completion-event'),
      ),
    }).toEqual({
      rejectedForAMissingEvent: true,
      namesTheExcusedChild: false,
      othersStillReported: true,
    })
  })

  // The older build's cancel dies before it runs, so the child it would have ended stays
  // live, no await of it answers, and the probe loop later ends it with an ordinary
  // `complete`. That batch owes the child its completion event like any other.
  it('holds the child to the rule in a cell where the older build never ended it', async () => {
    const lost = judgedAtClose(losingTheEventOf('ended-child'))
    const outcome = await cellOutcome(lost.makeFixture, 'cancel-task', 'crash-before')
    const another = await cellOutcome(losingTheEventOf('child'), 'cancel-task', 'crash-before')
    expect(
      {
        theOlderBuildsChild: outcome.includes(
          missingCompletionEvent(lost.judged().olderBuildsChild),
        )
          ? 'rejected, naming the child'
          : outcome,
        anotherTask: another.includes('terminal-task-without-completion-event')
          ? 'rejected'
          : another,
      },
      'mutation-verdict:behavior:fault-matrix-excuses-the-older-builds-child-only-while-cancelled',
    ).toEqual({ theOlderBuildsChild: 'rejected, naming the child', anotherTask: 'rejected' })
  })
})
