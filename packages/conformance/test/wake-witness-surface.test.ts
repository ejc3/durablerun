import type { SqlBatchControl, SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/fixture.js'
import { WAKE_PAIR_CASES, WAKE_SINGLE_CASES, wakeWitnessDisagreements } from '../src/suite.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

type StatementMutator = (
  label: string,
  statements: readonly SqlStatement[],
) => readonly SqlStatement[]

function mutateWake(find: string, replace: string): StatementMutator {
  return (label, statements) => {
    if (label !== 'emit-event') return statements
    let changed = 0
    const mutated = statements.map((statement) => {
      if (!/^\s*UPDATE runs SET/.test(statement.sql) || !statement.sql.includes(find)) {
        return statement
      }
      changed += 1
      return { ...statement, sql: statement.sql.split(find).join(replace) }
    })
    if (changed !== 1) throw new Error(`wake mutation changed ${changed} statements`)
    return mutated
  }
}

const NULL_ONLY_TIMEOUT = mutateWake(
  'w.timeout_at_ms IS runs.available_at_ms',
  'w.timeout_at_ms IS NULL AND runs.available_at_ms IS NULL',
)
const NO_LIVE_TASK_GUARD = mutateWake(
  "t.state IN ('pending','running','sleeping')",
  't.state IS NOT NULL',
)

function mutatingFixture(mutate: StatementMutator): StoreFixtureFactory {
  return async (seed) => {
    const fixture = await makeLibsqlFixture(seed)
    const db = {
      batch: (label: string, statements: readonly SqlStatement[], control?: SqlBatchControl) =>
        fixture.raw.batch(label, mutate(label, statements), control),
    }
    return { ...fixture, store: fixture.storeOver(db) }
  }
}

describe('libsql wake predicate mutation probes', () => {
  it('enumerates every generated wake witness case exactly once', () => {
    const labels = [...WAKE_SINGLE_CASES, ...WAKE_PAIR_CASES].map(({ label }) => label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('rejects a predicate that accepts only NULL timeout pairs', async () => {
    expect(
      await wakeWitnessDisagreements(mutatingFixture(NULL_ONLY_TIMEOUT), WAKE_SINGLE_CASES),
    ).not.toEqual([])
  })

  it('rejects a predicate with no live-task guard', async () => {
    expect(
      await wakeWitnessDisagreements(mutatingFixture(NO_LIVE_TASK_GUARD), WAKE_SINGLE_CASES),
    ).not.toEqual([])
  })
})
