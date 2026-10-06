import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/index.js'
import { NAMING_FAILED } from '../src/retention-policies.js'
import {
  ENDED_UNIT_TABLES,
  SOAK_TIMEOUT_MS,
  type SoakControl,
  overTheBound,
  soakControl,
  soakWeek,
  vacuous,
} from '../src/retention-soak.js'
import { bent } from './bent-fixture.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * The simulated week passes on every dialect. A hold nobody has seen fail holds nothing,
 * so each hold of the week is run here over a week that does what the hold forbids: a
 * purge that deletes nothing, a policy that lets nothing go, a purge that reads a shorter
 * age than the policy names, a driver that stops for a day, and a store that leaves a
 * wait behind when it ends a run. The control is the clean week, run once.
 */

/** A fixture whose purge answers that the barrier kept the unit, and sends nothing. */
const deletingNothing: StoreFixtureFactory = async (seed, options) => {
  const f = await makeLibsqlFixture(seed, options)
  return {
    ...f,
    retentionOver: (db) => {
      const retention = f.retentionOver(db)
      return { ...retention, purgeUnit: () => Promise.resolve(null) }
    },
  }
}

/**
 * A fixture whose purge reads every unit's age against an hour, the shortest window the
 * port takes and as near as a caller gets to no age at all, whatever policy it is handed.
 */
const readingAShorterAge: StoreFixtureFactory = async (seed, options) => {
  const f = await makeLibsqlFixture(seed, options)
  return {
    ...f,
    retentionOver: (db) => {
      const retention = f.retentionOver(db)
      return {
        ...retention,
        purgeCandidates: (queue, _policy, page) =>
          retention.purgeCandidates(queue, NAMING_FAILED, page),
        purgeUnit: (queue, unit) => retention.purgeUnit(queue, unit, NAMING_FAILED),
      }
    },
  }
}

/** A fixture whose store, after each completion, leaves a wait on every completed run that has none. */
const leavingAWaitBehind = bent('complete', {
  sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
          timeout_at_ms, created_at_ms)
        SELECT r.run_id, 'left-behind', r.queue, r.task_id, 'left-behind', 'waiting',
          NULL, 0
        FROM runs r
        WHERE r.state = 'completed'
          AND NOT EXISTS (SELECT 1 FROM waits w WHERE w.run_id = r.run_id)`,
  args: [],
})

describe('each hold of the simulated week can fail', () => {
  let made: Promise<SoakControl> | undefined
  const control = () => {
    made = made ?? soakControl(makeLibsqlFixture)
    return made
  }

  it(
    'a purge that deletes nothing is over the bound in every table at every day boundary, and fails the vacuity check',
    async () => {
      const report = await soakWeek(deletingNothing, await control())
      expect({
        overInEveryTableAtEveryBoundary: report.boundaries.every(({ retained, bound }) =>
          ENDED_UNIT_TABLES.every((table) => retained[table] > bound[table]),
        ),
        over: overTheBound(report).length,
        vacuous: vacuous(report),
        purgedUnits: report.purgedUnits,
        aPassIsNotTheModels: report.passMismatches.length > 0,
      }).toEqual({
        overInEveryTableAtEveryBoundary: true,
        over: 20,
        vacuous: ENDED_UNIT_TABLES.map((table) => `controlOverThePurgedWeek is 1 for ${table}`),
        purgedUnits: 0,
        aPassIsNotTheModels: true,
      })
    },
    SOAK_TIMEOUT_MS,
  )

  it(
    'a policy that lets nothing go in the week fails the vacuity check and nothing else',
    async () => {
      const nineDays = 9 * 24 * 3_600
      const report = await soakWeek(makeLibsqlFixture, await control(), {
        policy: { completedSeconds: nineDays, cancelledSeconds: nineDays, failedSeconds: nineDays },
      })
      expect({
        vacuous: vacuous(report),
        over: overTheBound(report),
        passMismatches: report.passMismatches,
        outcomeMismatches: report.outcomeMismatches,
        notAsAssigned: report.notAsAssigned,
        purgedUnits: report.purgedUnits,
      }).toEqual({
        vacuous: ['controlOverTheBound', 'controlOverThePurgedWeek'].flatMap((which) =>
          ENDED_UNIT_TABLES.map((table) => `${which} is 1 for ${table}`),
        ),
        over: [],
        passMismatches: [],
        outcomeMismatches: [],
        notAsAssigned: [],
        purgedUnits: 0,
      })
    },
    SOAK_TIMEOUT_MS,
  )

  it(
    'a purge that reads a shorter age than the policy names takes units the model keeps, in its first pass that takes any',
    async () => {
      const report = await soakWeek(readingAShorterAge, await control())
      expect(report.passMismatches[0]).toBe(
        'hour 3: the pass took [0/child, 0/main], and the model lets go []',
      )
    },
    SOAK_TIMEOUT_MS,
  )

  it(
    'a driver stopped for a simulated day leaves 40 of the 253 tasks ending otherwise than their seed assigns',
    async () => {
      const report = await soakWeek(makeLibsqlFixture, await control(), {
        driverStopped: [96, 120],
      })
      expect({
        endedAsAssigned: report.endedAsAssigned,
        someNotAsAssigned: report.notAsAssigned.length > 0,
      }).toEqual({ endedAsAssigned: 213, someNotAsAssigned: true })
    },
    SOAK_TIMEOUT_MS,
  )

  it(
    'a store that leaves a wait behind when it ends a run is named: the wait is of no live run, a purge takes it, and the history checkers find it',
    async () => {
      const report = await soakWeek(leavingAWaitBehind, await control())
      expect({
        ofEndedRuns: report.strayWaits.retained > 0,
        purgedWaits: report.purgedRows.waits > 0,
        found: report.violations.some((found) => found.includes('wait-referencing-dead-run')),
        // The passes are still the model's: the model counts a unit's waits as the purge does.
        passMismatches: report.passMismatches,
      }).toEqual({ ofEndedRuns: true, purgedWaits: true, found: true, passMismatches: [] })
    },
    SOAK_TIMEOUT_MS,
  )
})
