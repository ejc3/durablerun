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
})
