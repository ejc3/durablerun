import {
  type ClaimedRun,
  type SchedulerStore,
  type StoreAdmin,
  StoreUnavailableError,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { engineHistoryViolations } from './engine-history.js'
import type { StoreFixture, StoreFixtureFactory, StoreFixtureOptions } from './fixture.js'
import { rollingBack, startStep, triesOf } from './sagas.js'
import {
  awaitOwned,
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  describeFailure,
  warmConnections,
  withFixture,
} from './scenario.js'

const Q = 'q'
const START_MS = 1_000_000
const FAILURE = '{"name":"Boom"}'

/** How many copies of one call run at once. */
const COPIES = 4
const EVERY_COPY = Array.from({ length: COPIES }, (_, copy) => copy)

/**
 * How many times an executor runs one batch before it reports a deadlock (DESIGN.md §3.2).
 * It is written here and not imported, so the suite holds the contract and not whatever a
 * constant happens to say.
 */
const ATTEMPTS = 3

/**
 * The most deadlock victims an excused contest may count. A copy that met no outage was a
 * victim on fewer than all of its attempts, and whatever runs afterwards runs alone. A
 * count past this is not the excused defect, and fails the contest.
 */
const EXCUSED_VICTIMS = COPIES * (ATTEMPTS - 1)

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

// The saga states are arranged by the saga surface's own helpers, in the queue both files
// use, so that a copy kept here cannot drift from what that surface arranges.

/** A run whose registered step `a` started and finished, so a failure for good owes a rollback. */
async function runWithAStartedStep(f: StoreFixture): Promise<ClaimedRun> {
  const run = await startedRun(f, 'saga')
  await startStep(f, run, 'a', 1)
  await checkpointOwned(f.store, Q, run, 'a', '"a-result"', 60)
  return run
}

/** The first rollback pass of a task that is rolling back, claimed and started. */
const rollbackPass = async (f: StoreFixture): Promise<ClaimedRun> => (await rollingBack(f)).pass

const FAILED_ROLLBACK = triesOf('a', 1)

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
const STORE_RACES = {
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
} satisfies { readonly [Method in keyof SchedulerStore]: Readonly<Record<string, Arrange>> }

/** The same for the admin port, whose `migrate` every process of a deploy calls at once. */
const ADMIN_RACES = {
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
} satisfies { readonly [Method in keyof StoreAdmin]: Readonly<Record<string, Race>> }

type ContestNames<Prefix extends string, Table> = {
  [Method in keyof Table & string]: `${Prefix}${Method} ${keyof Table[Method] & string}`
}[keyof Table & string]

/** The name of every contest. A fixture's `selfRaceDeadlocksExcused` can name no other. */
export type SelfRaceName =
  | ContestNames<'', typeof STORE_RACES>
  | ContestNames<'admin ', typeof ADMIN_RACES>

/**
 * A method whose entry holds no state compiles and races nothing, so a table that has one
 * is refused here, where the contests are generated.
 */
type EveryMethodHasAState<Table> = {
  [Method in keyof Table]: keyof Table[Method] extends never ? never : Table[Method]
}
const withAStateEach = <Table extends EveryMethodHasAState<Table>>(table: Table): Table => table

const RACES: readonly (readonly [string, Race])[] = [
  ...Object.entries<Readonly<Record<string, Arrange>>>(withAStateEach(STORE_RACES)).flatMap(
    ([method, states]) =>
      Object.entries(states).map(
        ([state, arrange]) => [`${method} ${state}`, { arrange }] as const,
      ),
  ),
  ...Object.entries<Readonly<Record<string, Race>>>(withAStateEach(ADMIN_RACES)).flatMap(
    ([method, states]) =>
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

/**
 * An answer that says nothing was done. Nine calls of the ports answer nothing when they
 * succeed, so an answer alone cannot say a call worked: `contest` reads what the store
 * holds as well.
 */
function didNothing(settled: Settled): boolean {
  if (settled.kind !== 'answered') return true
  const { value } = settled
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    // A heartbeat answers a refusal and does not throw it.
    (typeof value === 'object' && value !== null && 'held' in value && value.held === false)
  )
}

/**
 * The tables every dialect has. PostgreSQL's `event_locks` rows are locks and not protocol
 * state, and the two values of `meta` are read through the admin, in `written`.
 */
const TABLES = ['tasks', 'runs', 'checkpoints', 'events', 'waits', 'drivers'] as const

/** Every row of every table of the shared schema, each as one line of text. */
async function rowsOf(f: StoreFixture): Promise<Record<string, string[]>> {
  const results = await f.raw.batch(
    'self-race:rows',
    TABLES.map((table) => ({ sql: `SELECT * FROM ${table}`, args: [] })),
    'read',
  )
  return Object.fromEntries(
    TABLES.map((table, index) => [
      table,
      (results[index]?.rows ?? []).map((row) =>
        JSON.stringify(row, (_, value: unknown) =>
          typeof value === 'bigint'
            ? String(value)
            : value instanceof Uint8Array
              ? [...value]
              : value,
        ),
      ),
    ]),
  )
}

/** What a call of either port can write: the six tables, the schema version, and the engine's clock. */
interface Written {
  readonly rows: Readonly<Record<string, readonly string[]>>
  readonly schemaVersion: number
  readonly clock: number | null
}

/**
 * A database nobody has migrated has no tables to read and no clock to fix, and the real
 * clock would differ between the two orders, so there the clock is left out.
 */
async function written(
  f: StoreFixture,
  has: { readonly tables: boolean; readonly fixedClock: boolean },
): Promise<Written> {
  return {
    rows: has.tables ? await rowsOf(f) : {},
    schemaVersion: await f.admin.schemaVersion(),
    clock: has.fixedClock ? await f.admin.nowEpochMs() : null,
  }
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
 * stays as it is, so the rows still say which task and which run they are. A link between
 * two rows the contest itself wrote is set aside with their ids, so this comparison cannot
 * see it. The invariant checkers read the rows as they are, and hold those links.
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
  /** The engine's clock, where the contest fixed it: null on a database nobody had migrated. */
  readonly clock: number | null
  readonly rows: Readonly<Record<string, readonly string[]>>
  readonly violations: readonly string[]
  readonly outages: readonly string[]
  readonly deadlocks: number
  /** The dialect's fixture names this contest as one in which its server may pick a victim. */
  readonly deadlocksExcused: boolean
  /**
   * No copy answered with anything and nothing the store holds changed, so the arranged
   * state was not one in which the call is legal.
   */
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
      // Open a connection for every copy before a race. A handshake inside the race would
      // put the copies one after another and hide what the contest is for. The serial order
      // needs one connection, which its first call opens.
      if (order === 'at once') await warmConnections(f.raw, 'self-race', COPIES)
      const before = await written(f, { tables: migrated, fixedClock: migrated })
      const drawnBefore = drawnIn(JSON.stringify(before.rows))
      const deadlocksBefore = f.deadlocks()

      const copies: Settled[] = []
      if (order === 'at once') {
        copies.push(...(await Promise.all(EVERY_COPY.map((copy) => settle(call(copy))))))
      } else {
        for (const copy of EVERY_COPY) copies.push(await settle(call(copy)))
      }
      const settled = afterwards === undefined ? copies : [...copies, await settle(afterwards())]

      const setAside = settingAside(drawnBefore)
      const after = await written(f, { tables: true, fixedClock: migrated })
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
        schemaVersion: after.schemaVersion,
        clock: after.clock,
        rows: Object.fromEntries(
          Object.entries(after.rows).map(([table, lines]) => [table, lines.map(setAside).sort()]),
        ),
        violations: await engineHistoryViolations(f.raw),
        outages: settled.flatMap((one) => (one.kind === 'outage' ? [one.why] : [])),
        deadlocks: f.deadlocks() - deadlocksBefore,
        deadlocksExcused: name in f.selfRaceDeadlocksExcused,
        idle: copies.every(didNothing) && JSON.stringify(before) === JSON.stringify(after),
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
 * all at once, and holds four things. The race answered what this build's own serial order
 * answered: one winner where that order has one, the same answer from every copy where it
 * has that. The rows it left are the rows that order left. No invariant is violated. And no
 * copy met an outage, which from a contest is a lock-order or serialization error the
 * executor should have absorbed. Every copy is the same call but for the name it goes by,
 * so every serial order is the same order, and running one is enough to know them all.
 *
 * That serial order is the only oracle. The contract is not consulted, so an answer that is
 * wrong in both orders passes here, and the scheduler suite's own cases hold the answers.
 *
 * The executor absorbs a deadlock by running the victim again, which would hide a wrong
 * lock order from all four. So its count of victims is held at zero as well, except where
 * a dialect's fixture names a contest and says why (`selfRaceDeadlocksExcused`), and there
 * it is held to `EXCUSED_VICTIMS`.
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
        // What both orders must equal: this build's own serial order, and clean.
        const held = { ...serial, violations: [], outages: [], idle: false, deadlocks: 0 }
        // An excused contest may count victims, up to the bound, and nothing else of it is excused.
        const withinTheExcuse = raced.deadlocksExcused && raced.deadlocks <= EXCUSED_VICTIMS
        expect({ serial, raced: withinTheExcuse ? { ...raced, deadlocks: 0 } : raced }).toEqual({
          serial: held,
          raced: held,
        })
      })
    }
  })
}
