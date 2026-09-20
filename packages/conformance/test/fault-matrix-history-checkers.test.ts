import type { SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type StoreFixtureFactory, runFaultMatrixCase } from '../src/index.js'
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

function cellOutcome(makeFixture: StoreFixtureFactory): Promise<string> {
  return runFaultMatrixCase(makeFixture, 'complete', 'crash-after', 1).then(
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
})
