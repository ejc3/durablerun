import {
  type ClaimedRun,
  SAGA_STARTED_PREFIX,
  SAGA_TRIES_PREFIX,
  type SchedulerStore,
  type StoreAdmin,
  StoreUnavailableError,
  encodeRollbackTry,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { childTaskViolations } from './child-tasks.js'
import type { StoreFixture, StoreFixtureFactory, StoreFixtureOptions } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { sagaViolations } from './saga-rows.js'
import {
  awaitOwned,
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  describeFailure,
  withFixture,
} from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000
const FAILURE = '{"name":"Boom"}'

/** How many copies of one call run at once. */
const COPIES = 4
const EVERY_COPY = Array.from({ length: COPIES }, (_, copy) => copy)

/**
 * Brings a fresh fixture to a state in which one call of the port is legal, the same way
 * every time, and answers with that call. `copy` numbers the copies of a contest from
 * zero, for a call that carries its caller's own name. Such a name is spelled
 * `copy-<n>`, or `copy-<n>.<m>` when one caller needs several, which is how the comparison
 * knows to set it aside. `afterwards` runs once when every copy has settled, in both
 * orders, and its answer counts with theirs.
 */
type Arrange = (
  f: StoreFixture,
) => Promise<Call | { call: Call; afterwards: () => Promise<unknown> }>
type Call = (copy: number) => Promise<unknown>

interface Race {
  readonly arrange: Arrange
  /** For a call that needs a database nobody has migrated. */
  readonly fixture?: StoreFixtureOptions
}

/** A task with one run, claimed and started. */
async function startedRun(f: StoreFixture, taskName = 'job'): Promise<ClaimedRun> {
  await f.store.spawn(Q, taskName, '{}')
  return claimActivated(f.store, Q, `w-${taskName}`)
}

/** A task with one run, claimed and not yet started. */
async function claimedRun(f: StoreFixture): Promise<ClaimedRun> {
  await f.store.spawn(Q, 'job', '{}')
  return claimOne(f.store, Q, 'w-job')
}

/** A run whose registered step `a` started and finished, so a failure for good owes a rollback. */
async function runWithAStartedStep(f: StoreFixture): Promise<ClaimedRun> {
  const run = await startedRun(f, 'saga')
  await checkpointOwned(f.store, Q, run, `${SAGA_STARTED_PREFIX}a`, '1', 60)
  await checkpointOwned(f.store, Q, run, 'a', '"a-result"', 60)
  return run
}

/** The first rollback pass of a task that is rolling back, claimed and started. */
async function rollbackPass(f: StoreFixture): Promise<ClaimedRun> {
  const forward = await runWithAStartedStep(f)
  await f.store.fail(Q, forward.runId, forward.claimToken, FAILURE, null)
  return claimActivated(f.store, Q, 'w-pass')
}

const FAILED_ROLLBACK = {
  key: `${SAGA_TRIES_PREFIX}a`,
  stateJson: encodeRollbackTry({ tries: 1, errorJson: FAILURE }),
}

/** A parent that is running, and a child in its queue that has not ended. */
async function parentAndLiveChild(f: StoreFixture) {
  const parent = await startedRun(f, 'parent')
  const child = await f.store.spawn(Q, 'child', '{}')
  return { parent, child }
}

/**
 * For every method of the scheduler port, the states in which it is raced against
 * itself. The type makes a port method with no entry here a compile error, so a new
 * method cannot arrive without its contest.
 */
const STORE_RACES: {
  readonly [Method in keyof SchedulerStore]: Readonly<Record<string, Arrange>>
} = {
  spawn: {
    'under one idempotency key': async (f) => () =>
      f.store.spawn(Q, 'job', '{}', { idempotencyKey: 'once' }),
    'with no key': async (f) => () => f.store.spawn(Q, 'job', '{}'),
    'of one child under a live parent': async (f) => {
      const parent = await startedRun(f, 'parent')
      const childOf = {
        parentQueue: Q,
        parentTaskId: parent.taskId,
        runId: parent.runId,
        claimToken: parent.claimToken,
        replayKey: 'child#1',
      }
      return () => f.store.spawn(Q, 'child', '{}', { childOf })
    },
  },
  claim: {
    'under one token, as one request sent again': async (f) => {
      for (let index = 0; index < 2; index++) await f.store.spawn(Q, `job-${index}`, '{}')
      return () => f.store.claim(Q, 'one-request', { leaseSeconds: 60, limit: 1 })
    },
    'by distinct claimers, and one more for what they left': async (f) => {
      for (const copy of EVERY_COPY) await f.store.spawn(Q, `job-${copy}`, '{}')
      const claim = (token: string) => f.store.claim(Q, token, { leaseSeconds: 60, limit: 1 })
      return {
        call: (copy: number) => claim(`copy-${copy}`),
        // A claimer skips the runs another has locked, so a claim may come back short of
        // what is due, or empty, and how the runs are split is not held. What is held is
        // that no run is claimed twice and that what the claimers left can still be
        // claimed. A claim sent again under its token is answered with what it took the
        // first time, so every claim here has a token of its own.
        afterwards: async () => {
          const claimed = []
          for (let next = 0; next <= COPIES; next++) {
            const more = await claim(`copy-${COPIES}.${next}`)
            if (more.length === 0) return claimed
            claimed.push(...more)
          }
          throw new Error('the last claimer was never answered nothing')
        },
      }
    },
  },
  activate: {
    'of one claimed run': async (f) => {
      const run = await claimedRun(f)
      return () => f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
    },
  },
  claimedTaskName: {
    'of one claimed run': async (f) => {
      const run = await claimedRun(f)
      return () => f.store.claimedTaskName(Q, run.runId, run.claimToken, run.claimGen)
    },
  },
  deferLaunch: {
    'of one claimed run': async (f) => {
      const run = await claimedRun(f)
      return () => f.store.deferLaunch(Q, run.runId, run.claimToken, run.claimGen, 30)
    },
  },
  heartbeat: {
    'of one running run': async (f) => {
      const run = await startedRun(f)
      return () => f.store.heartbeat(Q, run.runId, run.claimToken, 60)
    },
  },
  reschedule: {
    'of one running run': async (f) => {
      const run = await startedRun(f)
      return () => f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 30 })
    },
  },
  complete: {
    'of one running run': async (f) => {
      const run = await startedRun(f)
      return () => f.store.complete(Q, run.runId, run.claimToken, '{"done":true}')
    },
  },
  suspendRun: {
    'of one running run': async (f) => {
      const run = await startedRun(f)
      return () =>
        f.store.suspendRun(
          Q,
          run.runId,
          run.claimToken,
          { inSeconds: 30 },
          { key: 'slept', stateJson: '1' },
        )
    },
  },
  fail: {
    'with a retry': async (f) => {
      const run = await startedRun(f)
      return () => f.store.fail(Q, run.runId, run.claimToken, FAILURE, { delaySeconds: 5 })
    },
    'for good': async (f) => {
      const run = await startedRun(f)
      return () => f.store.fail(Q, run.runId, run.claimToken, FAILURE, null)
    },
    'for good, with a rollback owed': async (f) => {
      const run = await runWithAStartedStep(f)
      return () => f.store.fail(Q, run.runId, run.claimToken, FAILURE, null)
    },
  },
  failRollback: {
    'with another pass to follow': async (f) => {
      const pass = await rollbackPass(f)
      return () =>
        f.store.failRollback(
          Q,
          pass.runId,
          pass.claimToken,
          FAILURE,
          { delaySeconds: 5 },
          FAILED_ROLLBACK,
        )
    },
    'for good': async (f) => {
      const pass = await rollbackPass(f)
      return () =>
        f.store.failRollback(Q, pass.runId, pass.claimToken, FAILURE, null, FAILED_ROLLBACK)
    },
  },
  sweep: {
    'of two expired leases and a passed deadline': async (f) => {
      // One run that started, one that was claimed and never started, and a task that
      // waited past its deadline: the three things one sweep does.
      await startedRun(f, 'started')
      await f.store.spawn(Q, 'never-started', '{}')
      await claimOne(f.store, Q, 'w-never-started')
      await f.store.spawn(Q, 'late', '{}', { cancellation: { maxDelaySeconds: 10 } })
      await f.admin.setFakeNowEpochMs(START_MS + 100_000)
      return () => f.store.sweep(Q, 10)
    },
  },
  expireLeaseNow: {
    'of one running run': async (f) => {
      const run = await startedRun(f)
      return () => f.store.expireLeaseNow(Q, run.runId, run.claimToken)
    },
  },
  getCheckpoints: {
    'of a task with two': async (f) => {
      const run = await startedRun(f)
      await checkpointOwned(f.store, Q, run, 'first', '1', 60)
      await checkpointOwned(f.store, Q, run, 'second', '2', 60)
      return () => f.store.getCheckpoints(Q, run.taskId, run.attempt)
    },
  },
  setCheckpoint: {
    'under one new name': async (f) => {
      const run = await startedRun(f)
      return () => checkpointOwned(f.store, Q, run, 'step', '{"n":1}', 60)
    },
  },
  emitEvent: {
    'of one new event': async (f) => () => f.store.emitEvent(Q, 'go', '{"n":1}'),
    'to a parked waiter': async (f) => {
      const run = await startedRun(f)
      await awaitOwned(f.store, Q, run, 'step', 'go', null)
      return () => f.store.emitEvent(Q, 'go', '{"n":1}')
    },
  },
  awaitEvent: {
    'before the event': async (f) => {
      const run = await startedRun(f)
      return () => awaitOwned(f.store, Q, run, 'step', 'go', null)
    },
    'after the event': async (f) => {
      const run = await startedRun(f)
      await f.store.emitEvent(Q, 'go', '{"n":1}')
      return () => awaitOwned(f.store, Q, run, 'step', 'go', null)
    },
  },
  awaitTaskDone: {
    'of a child that has not ended': async (f) => {
      const { parent, child } = await parentAndLiveChild(f)
      return () => awaitTaskOwned(f.store, Q, parent, 'step', child.taskId, null)
    },
    'of a child that has ended': async (f) => {
      const { parent, child } = await parentAndLiveChild(f)
      const childRun = await claimActivated(f.store, Q, 'w-child')
      await f.store.complete(Q, childRun.runId, childRun.claimToken, '{"done":true}')
      return () => awaitTaskOwned(f.store, Q, parent, 'step', child.taskId, null)
    },
  },
  getTaskResult: {
    'of a completed task': async (f) => {
      const run = await startedRun(f)
      await f.store.complete(Q, run.runId, run.claimToken, '{"done":true}')
      return () => f.store.getTaskResult(Q, run.taskId)
    },
  },
  nextWakeAtEpochMs: {
    'of a queue with one delayed task': async (f) => {
      await f.store.spawn(Q, 'later', '{}', { startDelaySeconds: 500 })
      return () => f.store.nextWakeAtEpochMs(Q)
    },
  },
  driverHeartbeat: {
    'of one driver': async (f) => () => f.store.driverHeartbeat(Q, 'driver', 10),
    'of distinct drivers of one queue': async (f) => (copy) =>
      f.store.driverHeartbeat(Q, `copy-${copy}`, 10),
  },
  cancelTask: {
    'of a task with a running run': async (f) => {
      const run = await startedRun(f)
      return () => f.store.cancelTask(Q, run.taskId)
    },
  },
  retryTask: {
    'of a failed task': async (f) => {
      const run = await startedRun(f)
      await f.store.fail(Q, run.runId, run.claimToken, FAILURE, null)
      return () => f.store.retryTask(Q, run.taskId)
    },
  },
}

/** The same for the admin port, whose `migrate` every process of a deploy calls at once. */
const ADMIN_RACES: {
  readonly [Method in keyof StoreAdmin]: Readonly<Record<string, Race>>
} = {
  migrate: {
    'of a database nobody has migrated': {
      fixture: { migrate: false },
      arrange: async (f) => () => f.admin.migrate(),
    },
  },
  schemaVersion: {
    'of a migrated database': { arrange: async (f) => () => f.admin.schemaVersion() },
  },
  setFakeNowEpochMs: {
    'to one instant': { arrange: async (f) => () => f.admin.setFakeNowEpochMs(START_MS + 5_000) },
  },
  nowEpochMs: {
    'under a fixed clock': { arrange: async (f) => () => f.admin.nowEpochMs() },
  },
}

const RACES: readonly (readonly [string, Race])[] = [
  ...Object.entries(STORE_RACES).flatMap(([method, states]) =>
    Object.entries(states).map(([state, arrange]) => [`${method} ${state}`, { arrange }] as const),
  ),
  ...Object.entries(ADMIN_RACES).flatMap(([method, states]) =>
    Object.entries(states).map(([state, race]) => [`admin ${method} ${state}`, race] as const),
  ),
]

type Settled =
  | { readonly kind: 'answered'; readonly value: unknown }
  | { readonly kind: 'refused'; readonly name: string }
  | { readonly kind: 'outage'; readonly why: string }

/**
 * An outage is kept apart from a refusal. A refusal is the contract's answer to a call
 * that lost. An outage from a contest is a lock-order or serialization error the
 * executor should have absorbed, and its causes say which.
 */
function settle(call: Promise<unknown>): Promise<Settled> {
  return call.then(
    (value): Settled => ({ kind: 'answered', value }),
    (error: unknown): Settled =>
      error instanceof StoreUnavailableError
        ? { kind: 'outage', why: describeFailure(error) }
        : { kind: 'refused', name: error instanceof Error ? error.name : String(error) },
  )
}

/** A call that did nothing says its state was not one in which the call is legal. */
function didNothing(settled: Settled): boolean {
  if (settled.kind !== 'answered') return true
  const { value } = settled
  return (
    value === null ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    // A heartbeat answers a refusal and does not throw it.
    (typeof value === 'object' && value !== null && 'held' in value && value.held === false)
  )
}

/** The tables every dialect has. PostgreSQL's `event_locks` rows are locks and not protocol state. */
const TABLES = ['tasks', 'runs', 'checkpoints', 'events', 'waits', 'drivers'] as const

/** Every row of every table of the shared schema, each as one line of text, in order. */
async function rowsOf(f: StoreFixture): Promise<Record<string, string[]>> {
  const results = await f.raw.batch(
    'self-race:rows',
    TABLES.map((table) => ({ sql: `SELECT * FROM ${table}`, args: [] })),
    'read',
  )
  return Object.fromEntries(
    TABLES.map((table, index) => [
      table,
      (results[index]?.rows ?? [])
        .map((row) =>
          JSON.stringify(row, (_, value: unknown) =>
            typeof value === 'bigint'
              ? String(value)
              : value instanceof Uint8Array
                ? [...value]
                : value,
          ),
        )
        .sort(),
    ]),
  )
}

const DRAWN = /-(id|token)-(\d+)/g
type Drawn = Record<'id' | 'token', number>

/** The highest serial of each kind the test id source has drawn, as far as `text` shows. */
function drawnIn(text: string): Drawn {
  const drawn: Drawn = { id: 0, token: 0 }
  for (const [, kind, serial] of text.matchAll(DRAWN)) {
    const key = kind as keyof Drawn
    drawn[key] = Math.max(drawn[key], Number(serial))
  }
  return drawn
}

/**
 * What one serial order and one race may differ in, set aside. Which copy wins is not
 * decided, and the copies differ only in the ids and tokens each drew from the fixture's
 * id source and in the name a copy calls itself. An id the arranged state already held
 * stays as it is, so the rows still say which task and which run they are.
 */
function settingAside(drawnBefore: Drawn): (text: string) => string {
  return (text) =>
    text
      .replace(DRAWN, (whole, kind: keyof Drawn, serial: string) =>
        Number(serial) > drawnBefore[kind] ? `-${kind}-*` : whole,
      )
      .replace(/copy-\d+(?:\.\d+)?/g, 'copy-*')
}

interface Contest {
  /** Every answer of every copy, a list answer taken item by item, in order. */
  readonly answers: readonly string[]
  readonly schemaVersion: number
  readonly rows: Readonly<Record<string, readonly string[]>>
  readonly violations: readonly string[]
  readonly outages: readonly string[]
  readonly deadlocks: number
  /** The dialect's fixture names this contest as one in which its server may pick a victim. */
  readonly deadlocksExcused: boolean
  /** No copy did anything, so the arranged state was not one in which the call is legal. */
  readonly idle: boolean
}

async function contest(
  makeFixture: StoreFixtureFactory,
  name: string,
  race: Race,
  order: 'one at a time' | 'at once',
): Promise<Contest> {
  return withFixture(
    makeFixture,
    // Both orders take the same seed, so both fixtures draw the same ids.
    `self-race ${name}`,
    async (f) => {
      const migrated = race.fixture?.migrate !== false
      if (migrated) await f.admin.setFakeNowEpochMs(START_MS)
      const prepared = await race.arrange(f)
      const { call, afterwards } =
        typeof prepared === 'function' ? { call: prepared, afterwards: undefined } : prepared
      // Open a connection for every copy first. A handshake inside the contest would
      // put the copies one after another and hide what the contest is for.
      await Promise.all(
        EVERY_COPY.map((copy) =>
          f.raw.batch(`self-race:warm-${copy}`, [{ sql: 'SELECT 1 AS ready', args: [] }], 'read'),
        ),
      )
      const drawnBefore = migrated ? drawnIn(JSON.stringify(await rowsOf(f))) : { id: 0, token: 0 }
      const deadlocksBefore = f.deadlocks()

      const settled: Settled[] = []
      if (order === 'at once') {
        settled.push(...(await Promise.all(EVERY_COPY.map((copy) => settle(call(copy))))))
      } else {
        for (const copy of EVERY_COPY) settled.push(await settle(call(copy)))
      }
      if (afterwards !== undefined) settled.push(await settle(afterwards()))

      const setAside = settingAside(drawnBefore)
      const rows = await rowsOf(f)
      return {
        answers: settled
          .flatMap((one) =>
            one.kind !== 'answered'
              ? [one.kind === 'refused' ? `refused ${one.name}` : 'outage']
              : (Array.isArray(one.value) ? one.value : [one.value]).map(
                  (item) => `answered ${JSON.stringify(item ?? null)}`,
                ),
          )
          .map(setAside)
          .sort(),
        schemaVersion: await f.admin.schemaVersion(),
        rows: Object.fromEntries(
          Object.entries(rows).map(([table, lines]) => [table, lines.map(setAside).sort()]),
        ),
        violations: [
          ...(await engineInvariantViolations(f.raw)),
          ...(await childTaskViolations(f.raw)),
          ...(await sagaViolations(f.raw)),
        ],
        outages: settled.flatMap((one) => (one.kind === 'outage' ? [one.why] : [])),
        deadlocks: f.deadlocks() - deadlocksBefore,
        deadlocksExcused: name in f.selfRaceDeadlocksExcused,
        idle: settled.every(didNothing),
      }
    },
    race.fixture,
  )
}

/**
 * Every call of the store raced against copies of itself, on every dialect. A call that is
 * safe alone can still be unsafe beside itself under a server's locking: the two cases
 * that were found by hand were a migrator that read a concurrent bootstrap half done, and
 * driver heartbeats that deadlocked on each other's rows. The contests here are generated
 * from the ports, so the next call arrives with its own.
 *
 * Each contest runs twice from the same arranged state, the copies one at a time and then
 * all at once, and holds four things. The copies answered what a serial order answers:
 * one winner where the contract has one, the same answer where a call is idempotent. The
 * rows they left are the rows a serial order leaves. No invariant is violated. And no
 * copy met an outage, which from a contest is a lock-order or serialization error the
 * executor should have absorbed. Every copy is the same call but for the name it goes by,
 * so every serial order is the same order, and running one is enough to know them all.
 *
 * The executor absorbs a deadlock by running the victim again, which would hide a wrong
 * lock order from all four. So its count of victims is held at zero as well, except where
 * a dialect's fixture names a contest and says why (`selfRaceDeadlocksExcused`).
 *
 * Contests between different calls are the fuzz's and the fault matrix's.
 */
export function selfConcurrencyConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`self-concurrency conformance [${dialect}]`, () => {
    for (const [name, race] of RACES) {
      it(`${name}: ${COPIES} copies at once answer and leave what one at a time does`, async () => {
        const serial = await contest(makeFixture, name, race, 'one at a time')
        const raced = await contest(makeFixture, name, race, 'at once')
        const clean = { violations: [], outages: [], idle: false }
        expect({ serial, raced }).toEqual({
          serial: { ...serial, ...clean, deadlocks: 0 },
          raced: {
            ...serial,
            ...clean,
            deadlocks: raced.deadlocksExcused ? raced.deadlocks : 0,
          },
        })
      })
    }

    it('excuses deadlock victims only in contests that exist', () =>
      withFixture(
        makeFixture,
        'self-race excused',
        async (f) => {
          const contests = new Set(RACES.map(([name]) => name))
          expect(
            Object.keys(f.selfRaceDeadlocksExcused).filter((name) => !contests.has(name)),
          ).toEqual([])
        },
        { migrate: false },
      ))
  })
}
