import {
  ChildAwaitRefusedError,
  InvalidDurableStringError,
  PortRefusalError,
  type PurgeUnitTarget,
  RETENTION_METHODS,
  RETENTION_STRINGS,
  type RetentionMethod,
  type RetentionPolicy,
  taskDoneEventName,
} from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { engineHistoryViolations } from './engine-history.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { snapshot } from './poison-matrix.js'
import { OUTSIDE_THE_DOMAIN, PAST_THE_WIDTH } from './port-strings.js'
import { CONTEST_POLICY, purgeContest } from './retention-contest.js'
import {
  type BuiltCell,
  GRID_CELLS,
  GRID_POLICY,
  type GridCell,
  PARENT_QUEUES,
  PARENT_STATES,
  type ParentState,
  UNIT_STATES,
  type UnitState,
  barrierCells,
  buildCell,
  keptByOf,
  runGridCells,
  sizeCells,
  startOf,
} from './retention-grid.js'
import { type KeptBy, dumpDifferences, purgeOracle } from './retention-oracle.js'
import {
  awaitTaskOwned,
  describeFailure,
  readOne,
  warmConnections,
  withFixture,
} from './scenario.js'

/** How long one block of grid cells may take: the cells of one unit state and one parent state. */
const GRID_TIMEOUT_MS = 180_000

const UNIT_PHRASE: Readonly<Record<UnitState, string>> = {
  completed: 'completed',
  'failed with a saga': 'failed with a saga',
  failed: 'failed with no saga',
  cancelled: 'was cancelled',
}

const PARENT_PHRASE: Readonly<Record<ParentState, string>> = {
  none: 'no task',
  absent: 'a parent whose own unit was purged',
  live: 'a live parent',
  'rolling back': 'a parent that is rolling back',
  completed: 'a completed parent',
  cancelled: 'a cancelled parent',
  failed: 'a failed parent',
  'failed with a saga': 'a parent that failed with a saga',
}

/** How many rounds the contest runs in the shared surface. */
const CONTEST_ROUNDS = 8

/** How many times the purge and an await of the same child are sent at once. */
const RACE_ROUNDS = 12

/** The child of a cell, replayed by a run of its parent: the call a parent's replay makes. */
function replayOf(built: BuiltCell, run: { taskId: string; runId: string; claimToken: string }) {
  return {
    maxAttempts: 1,
    childOf: {
      parentQueue: built.parentQueue,
      parentTaskId: run.taskId,
      runId: run.runId,
      claimToken: run.claimToken,
      replayKey: 'child#1',
    },
  }
}

/** A cell a window past its ending with nothing but its parent in the barrier's way. */
const keptByItsParent = (parent: ParentState, parentQueue: GridCell['parentQueue']): GridCell => ({
  unit: 'completed',
  parent,
  parentQueue,
  holder: 'none',
  age: 1,
})

/** A unit a window past its ending that nothing keeps, in the state the engine left it. */
const nothingInItsWay = (unitState: UnitState): GridCell => ({
  unit: unitState,
  parent: 'none',
  parentQueue: "the child's",
  holder: 'none',
  age: 1,
})

/**
 * One purge of a unit the engine ended and a case then bent, held to the oracle: what
 * keeps the unit by the model's reading of the rows, what the purge answered, and how
 * every table afterwards differs from what the oracle says it must hold. `bend` writes
 * the rows the case is about, and may name the unit another way than its builder did.
 */
async function bentPurge(
  makeFixture: StoreFixtureFactory,
  name: string,
  cell: GridCell,
  policy: RetentionPolicy,
  bend: (f: StoreFixture, built: BuiltCell) => Promise<PurgeUnitTarget | undefined>,
): Promise<{ keptBy: readonly KeptBy[]; purged: boolean; differences: readonly string[] }> {
  return withFixture(makeFixture, `bent ${name}`, async (f) => {
    const built = await buildCell(f, cell, 'c')
    await f.admin.setFakeNowEpochMs(built.purgeAtMs)
    const target = (await bend(f, built)) ?? built.target
    const before = await snapshot(f.raw)
    const oracle = purgeOracle(before, built.purgeAtMs, built.queue, target, policy)
    const answer = await f.retentionOver(f.raw).purgeUnit(built.queue, target, policy)
    return {
      keptBy: oracle.keptBy,
      purged: answer !== null,
      differences: dumpDifferences(oracle.after, await snapshot(f.raw)),
    }
  })
}

const write = (f: StoreFixture, sql: string, args: (string | null)[]) =>
  f.raw.batch('bent-rows', [{ sql, args }], 'write')

/** Build one cell alone, move the clock to its purge, and send the purge. */
async function purgedCell(f: StoreFixture, cell: GridCell) {
  const built = await buildCell(f, cell, 'c')
  await f.admin.setFakeNowEpochMs(built.purgeAtMs)
  const purged = await f.retentionOver(f.raw).purgeUnit(built.queue, built.target, GRID_POLICY)
  return { built, purged }
}

/**
 * The purge (DESIGN.md §3.12, BUILD.md exit test line 42), on every dialect: the barrier
 * grid against the oracle, what a kept unit's parent and holder then find, the purge
 * beside an await of the same child, what the ports answer of a unit that is gone, what
 * the port refuses, and the purge beside the rest of the engine.
 */
export function purgeConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`the barrier grid [${dialect}]`, () => {
    it('has 780 cells, of which the model lets 136 go', () => {
      expect({
        cells: GRID_CELLS.length,
        letGo: GRID_CELLS.filter((cell) => keptByOf(cell).length === 0).length,
      }).toEqual({ cells: 780, letGo: 136 })
    })

    for (const unit of UNIT_STATES) {
      for (const parent of PARENT_STATES) {
        it(
          `a unit that ${UNIT_PHRASE[unit]}, spawned by ${PARENT_PHRASE[parent]}: the purge takes what the model lets go, whole, and nothing else`,
          async () => {
            const { observed, expected } = await runGridCells(
              makeFixture,
              `${unit} ${parent}`,
              barrierCells(unit, parent),
            )
            expect(observed).toEqual(expected)
          },
          GRID_TIMEOUT_MS,
        )
      }
      it(
        `a unit that ${UNIT_PHRASE[unit]}, at the checkpoint cap and one either side of it: the purge takes the unit up to the cap, and keeps it past it`,
        async () => {
          const { observed, expected } = await runGridCells(
            makeFixture,
            `${unit} sizes`,
            sizeCells(unit),
          )
          expect(observed).toEqual(expected)
        },
        GRID_TIMEOUT_MS,
      )
    }
  })

  describe(`what a kept unit's parent and holder find [${dialect}]`, () => {
    for (const parentQueue of PARENT_QUEUES) {
      it(`a live parent in ${parentQueue} queue replays its spawn of a child a window old and finds it, and its await of it is refused by nothing but the queue rule`, async () => {
        await withFixture(makeFixture, `consequence live ${parentQueue}`, async (f) => {
          const { built, purged } = await purgedCell(f, keptByItsParent('live', parentQueue))
          const parent = built.parent
          if (parent === null) throw new Error('the cell has no parent')
          // A parent that has run for an hour has kept its lease.
          await f.store.heartbeat(built.parentQueue, parent.runId, parent.claimToken, 60)
          const replayed = await f.store.spawn(built.queue, 'child', '{}', replayOf(built, parent))
          const awaited = await awaitTaskOwned(
            f.store,
            built.parentQueue,
            parent,
            'await-child',
            built.target.taskId,
            null,
          ).then(
            (answer) => (answer.emitted ? 'answered with the outcome' : 'parked'),
            (error: unknown) =>
              error instanceof ChildAwaitRefusedError
                ? `refused: ${error.reason}`
                : describeFailure(error),
          )
          expect({
            purged,
            replayed: { taskId: replayed.taskId, created: replayed.created },
            awaited,
            violations: await engineHistoryViolations(f.raw),
          }).toEqual({
            purged: null,
            replayed: { taskId: built.target.taskId, created: false },
            awaited:
              parentQueue === 'another' ? 'refused: other-queue' : 'answered with the outcome',
            violations: [],
          })
        })
      })

      it(`a failed parent in ${parentQueue} queue that is revived replays its spawn of a child a window old and finds it`, async () => {
        await withFixture(makeFixture, `consequence failed ${parentQueue}`, async (f) => {
          const { built, purged } = await purgedCell(f, keptByItsParent('failed', parentQueue))
          const parent = built.parent
          if (parent === null) throw new Error('the cell has no parent')
          const revived = await f.store.retryTask(built.parentQueue, parent.taskId)
          const run = await startOf(f, built.parentQueue, parent.taskId, 'w-revived')
          const replayed = await f.store.spawn(built.queue, 'child', '{}', replayOf(built, run))
          expect({
            purged,
            revived: revived === null ? null : revived.attempt,
            replayed: { taskId: replayed.taskId, created: replayed.created },
            violations: await engineHistoryViolations(f.raw),
          }).toEqual({
            purged: null,
            revived: 2,
            replayed: { taskId: built.target.taskId, created: false },
            violations: [],
          })
        })
      })
    }

    it('a run that was woken with the outcome of a child a window old is claimed with that outcome', async () => {
      await withFixture(makeFixture, 'consequence woken holder', async (f) => {
        const { built, purged } = await purgedCell(f, {
          unit: 'completed',
          parent: 'none',
          parentQueue: "the child's",
          holder: 'a run that holds the outcome',
          age: 0,
        })
        const holder = built.holder
        if (holder === null) throw new Error('the cell has no holder')
        const event = await readOne(
          f.raw,
          'SELECT payload FROM events WHERE queue = ? AND event_name = ?',
          [built.queue, taskDoneEventName(built.target.taskId)],
        )
        const woken = await startOf(f, built.queue, holder.taskId, 'w-woken')
        expect({
          purged,
          wake: woken.wake,
          violations: await engineHistoryViolations(f.raw),
        }).toEqual({
          purged: null,
          wake: {
            event: taskDoneEventName(built.target.taskId),
            step: 'await-child',
            payloadJson: String(event?.payload),
          },
          violations: [],
        })
      })
    })
  })

  describe(`what keeps a unit that no engine path leaves [${dialect}]`, () => {
    const kept = (...keptBy: KeptBy[]) => ({ keptBy, purged: false, differences: [] })

    it('a failed unit is kept under a policy that names no window for failed tasks', async () => {
      expect(
        await bentPurge(
          makeFixture,
          'policy',
          nothingInItsWay('failed'),
          CONTEST_POLICY,
          async () => undefined,
        ),
      ).toEqual(kept('state'))
    })

    it('a unit whose stamp is NULL is kept, however old its rows are', async () => {
      expect(
        await bentPurge(
          makeFixture,
          'stamp',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(f, 'UPDATE tasks SET fence_at_ms = NULL WHERE task_id = ?', [
              built.target.taskId,
            ])
            return undefined
          },
        ),
      ).toEqual(kept('stamp'))
    })

    it('a unit one of whose runs is live is kept, though its task has ended', async () => {
      expect(
        await bentPurge(
          makeFixture,
          'live run',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(f, "UPDATE runs SET state = 'pending' WHERE task_id = ?", [
              built.target.taskId,
            ])
            return undefined
          },
        ),
      ).toEqual(kept('live-run'))
    })

    it('a unit one of whose runs is in another queue is kept whole', async () => {
      expect(
        await bentPurge(
          makeFixture,
          'foreign run',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(f, "UPDATE runs SET queue = 'elsewhere' WHERE task_id = ?", [
              built.target.taskId,
            ])
            return undefined
          },
        ),
      ).toEqual(kept('foreign-run'))
    })

    it('a unit whose key is in the reserved namespace and names no parent is kept', async () => {
      const key = '$spawn:names-nobody'
      expect(
        await bentPurge(
          makeFixture,
          'unparsed key',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(f, 'UPDATE tasks SET idempotency_key = ? WHERE task_id = ?', [
              key,
              built.target.taskId,
            ])
            return { taskId: built.target.taskId, idempotencyKey: key }
          },
        ),
      ).toEqual(kept('parent'))
    })

    it('a unit named under a key it was not spawned under is kept, and so is one named under none', async () => {
      const named = (target: (built: BuiltCell) => PurgeUnitTarget) =>
        bentPurge(
          makeFixture,
          'another key',
          nothingInItsWay('cancelled'),
          GRID_POLICY,
          async (_f, built) => target(built),
        )
      expect({
        underAnotherKey: await named(({ target }) => ({
          taskId: target.taskId,
          idempotencyKey: 'another-key',
        })),
        underNoKey: await named(({ target }) => ({ taskId: target.taskId })),
      }).toEqual({ underAnotherKey: kept('key'), underNoKey: kept('key') })
    })

    it("a run of the unit itself that holds the unit's own outcome does not keep it", async () => {
      expect(
        await bentPurge(
          makeFixture,
          'own carry',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(
              f,
              "UPDATE runs SET wake_event = ?, wake_step = 'await-self', event_payload = '{}' WHERE task_id = ?",
              [taskDoneEventName(built.target.taskId), built.target.taskId],
            )
            return undefined
          },
        ),
      ).toEqual({ keptBy: [], purged: true, differences: [] })
    })
  })

  describe(`a purge beside an await of the same child [${dialect}]`, () => {
    it(`${RACE_ROUNDS} times at once: the purge takes the unit, and the await answers with the outcome or is refused for a task that is gone, and never parks`, async () => {
      await withFixture(makeFixture, 'purge-versus-await', async (f) => {
        const retention = f.retentionOver(f.raw)
        const outcomes: string[] = []
        const stranded: string[] = []
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const cell: GridCell = {
            unit: 'completed',
            parent: 'none',
            parentQueue: "the child's",
            holder: 'none',
            age: 1,
          }
          const built = await buildCell(f, cell, `race-${round}`)
          await f.admin.setFakeNowEpochMs(built.purgeAtMs)
          // The awaiter is claimed at the instant of the race, so its lease is live.
          const awaiter = await f.store.spawn(built.queue, 'awaiter', '{}')
          const run = await startOf(f, built.queue, awaiter.taskId, `w-awaiter-${round}`)
          await warmConnections(f.raw, 'purge-versus-await', 2)
          const [purge, awaited] = await Promise.all([
            retention
              .purgeUnit(built.queue, built.target, GRID_POLICY)
              .then((purged) => (purged === null ? 'kept' : 'purged'), describeFailure),
            awaitTaskOwned(
              f.store,
              built.queue,
              run,
              'await-child',
              built.target.taskId,
              null,
            ).then(
              (answer) => (answer.emitted ? 'answered' : 'parked'),
              (error: unknown) =>
                error instanceof ChildAwaitRefusedError
                  ? `refused: ${error.reason}`
                  : describeFailure(error),
            ),
          ])
          outcomes.push(`${purge}, ${awaited}`)
          const rows = await snapshot(f.raw)
          if (rows.tasks.some((task) => task.task_id === built.target.taskId)) {
            stranded.push(`round ${round}: the unit is still there`)
          }
          if (rows.waits.some((wait) => wait.queue === built.queue)) {
            stranded.push(`round ${round}: a wait was registered`)
          }
          await f.store.complete(built.queue, run.runId, run.claimToken, '"done"')
        }
        const allowed = ['purged, answered', 'purged, refused: no-such-task']
        expect({
          unexpected: outcomes.filter((outcome) => !allowed.includes(outcome)),
          stranded,
          violations: await engineHistoryViolations(f.raw),
          deadlocks: f.deadlocks(),
        }).toEqual({ unexpected: [], stranded: [], violations: [], deadlocks: 0 })
      })
    })
  })

  describe(`a unit that is gone [${dialect}]`, () => {
    it('is answered by every port as a task that never existed, its await is refused, and its key is free', async () => {
      await withFixture(makeFixture, 'after-a-purge', async (f) => {
        const { built, purged } = await purgedCell(f, {
          unit: 'completed',
          parent: 'none',
          parentQueue: "the child's",
          holder: 'none',
          age: 1,
        })
        const { queue, target } = built
        const awaiter = await f.store.spawn(queue, 'awaiter', '{}')
        const run = await startOf(f, queue, awaiter.taskId, 'w-awaiter')
        const awaited = await awaitTaskOwned(
          f.store,
          queue,
          run,
          'await-child',
          target.taskId,
          null,
        ).then(
          () => 'accepted',
          (error: unknown) =>
            error instanceof ChildAwaitRefusedError
              ? `refused: ${error.reason}`
              : describeFailure(error),
        )
        const retention = f.retentionOver(f.raw)
        const again = await f.store.spawn(queue, 'child', '{}', {
          idempotencyKey: String(target.idempotencyKey),
        })
        expect({
          purged: purged?.taskId,
          result: await f.store.getTaskResult(queue, target.taskId),
          retried: await f.store.retryTask(queue, target.taskId),
          cancelled: await f.store.cancelTask(queue, target.taskId),
          awaited,
          waits: (await snapshot(f.raw)).waits,
          purgedAgain: await retention.purgeUnit(queue, target, GRID_POLICY),
          listed: (await retention.purgeCandidates(queue, GRID_POLICY, { limit: 10 })).candidates,
          keyReused: { created: again.created, another: again.taskId !== target.taskId },
          violations: await engineHistoryViolations(f.raw),
        }).toEqual({
          purged: target.taskId,
          result: null,
          retried: null,
          cancelled: false,
          awaited: 'refused: no-such-task',
          waits: [],
          purgedAgain: null,
          listed: [],
          keyReused: { created: true, another: true },
          violations: [],
        })
      })
    })
  })

  describe(`what the retention port refuses [${dialect}]`, () => {
    it('refuses a string no store keeps, or one past the width, at every place, and sends nothing', async () => {
      await withFixture(makeFixture, 'retention-strings', async (f) => {
        const recorder = new RecordingExecutor(f.raw)
        const retention = f.retentionOver(recorder)
        const refusedNames = Object.entries({ ...OUTSIDE_THE_DOMAIN, ...PAST_THE_WIDTH })
        // One well-formed call of each method, and where each string it carries stands.
        const calls: Readonly<
          Record<
            RetentionMethod,
            { args: readonly unknown[]; places: (bad: unknown) => unknown[][] }
          >
        > = {
          purgeCandidates: {
            args: ['q', CONTEST_POLICY, { limit: 1, after: { endedAtMs: 0, taskId: 't' } }],
            places: (bad) => [
              [bad, CONTEST_POLICY, { limit: 1 }],
              ['q', CONTEST_POLICY, { limit: 1, after: { endedAtMs: 0, taskId: bad } }],
            ],
          },
          purgeUnit: {
            args: ['q', { taskId: 't', idempotencyKey: 'k' }, CONTEST_POLICY],
            places: (bad) => [
              [bad, { taskId: 't' }, CONTEST_POLICY],
              ['q', { taskId: bad }, CONTEST_POLICY],
              ['q', { taskId: 't', idempotencyKey: bad }, CONTEST_POLICY],
            ],
          },
        }
        const accepted: string[] = []
        let places = 0
        for (const method of RETENTION_METHODS) {
          const call = retention[method] as (...made: unknown[]) => Promise<unknown>
          // The well-formed call goes through, so a refusal below is the string's.
          await call(...calls[method].args)
          const sentByTheCall = recorder.batches.length
          const variants = calls[method].places(null).length
          places += variants
          for (const [what, bad] of refusedNames) {
            for (const [place, args] of calls[method].places(bad).entries()) {
              const refused = await call(...args).then(
                () => false,
                (error: unknown) => error instanceof InvalidDurableStringError,
              )
              if (!refused) accepted.push(`${method} place ${place}: ${what}`)
            }
          }
          expect(recorder.batches.length, `${method} sent a batch for a refused string`).toBe(
            sentByTheCall,
          )
        }
        expect(accepted).toEqual([])
        // Every string the table names is one of the places asked: a queue in each method,
        // the task of a cursor, and the task and the key of a unit.
        const named = (place: unknown): number =>
          typeof place === 'string'
            ? 1
            : place !== null && typeof place === 'object'
              ? Object.values(place).reduce((count: number, inner) => count + named(inner), 0)
              : 0
        expect({ places, named: named(RETENTION_STRINGS) }).toEqual({ places: 5, named: 5 })
      })
    })

    it('refuses a policy whose window is under an hour, is no whole number, or is missing, and sends nothing', async () => {
      await withFixture(makeFixture, 'retention-policy', async (f) => {
        const recorder = new RecordingExecutor(f.raw)
        const retention = f.retentionOver(recorder)
        const hour: RetentionPolicy = { completedSeconds: 3_600, cancelledSeconds: 3_600 }
        const policies: Readonly<Record<string, unknown>> = {
          'a completed window one second under an hour': { ...hour, completedSeconds: 3_599 },
          'a cancelled window one second under an hour': { ...hour, cancelledSeconds: 3_599 },
          'a failed window one second under an hour': { ...hour, failedSeconds: 3_599 },
          'a failed window of nothing': { ...hour, failedSeconds: 0 },
          'a window that is no whole number': { ...hour, completedSeconds: 3_600.5 },
          'a window written as text': { ...hour, cancelledSeconds: '3600' },
          'a failed window that is null': { ...hour, failedSeconds: null },
          'no completed window': { cancelledSeconds: 3_600 },
          'no cancelled window': { completedSeconds: 3_600 },
          'no policy': null,
        }
        const accepted: string[] = []
        for (const [what, policy] of Object.entries(policies)) {
          const calls = [
            () => retention.purgeCandidates('q', policy as RetentionPolicy, { limit: 1 }),
            () => retention.purgeUnit('q', { taskId: 't' }, policy as RetentionPolicy),
          ]
          for (const [index, call] of calls.entries()) {
            const refused = await call().then(
              () => false,
              (error: unknown) => error instanceof PortRefusalError,
            )
            if (!refused) accepted.push(`${index === 0 ? 'purgeCandidates' : 'purgeUnit'}: ${what}`)
          }
        }
        expect({ accepted, sent: recorder.batches.map((batch) => batch.label) }).toEqual({
          accepted: [],
          sent: [],
        })
        // The shortest windows core takes are taken.
        await retention.purgeCandidates('q', { ...hour, failedSeconds: 3_600 }, { limit: 1 })
        expect(recorder.batches.map((batch) => batch.label)).toEqual(['purge-candidates'])
      })
    })
  })

  describe(`the purge beside the rest of the engine [${dialect}]`, () => {
    it(
      `${CONTEST_ROUNDS} rounds of four purgers beside a claimer, a sweeper and a spawner that reuses the keys being purged: every unit is whole or gone, one purge answers for each that went, nothing the policy lets go is left, every reused key answers, and the server chooses no deadlock victim`,
      async () => {
        const contest = await purgeContest(makeFixture, CONTEST_ROUNDS)
        const lists = contest.rounds.map(
          ({ round, purged, purgedAfterwards, created, failedKept, ...found }) => ({
            round,
            ...found,
          }),
        )
        expect({ lists, deadlocks: contest.deadlocks }).toEqual({
          lists: contest.rounds.map(({ round }) => ({
            round,
            failures: [],
            purgedTwice: [],
            purgedAndPresent: [],
            goneUnpurged: [],
            partUnits: [],
            violations: [],
            leftBehind: [],
            spawnMisanswers: [],
          })),
          deadlocks: 0,
        })
        // A contest that purged nothing, or reused no key, held nothing.
        expect({
          rounds: contest.rounds.length,
          everyRoundPurged: contest.rounds.every((round) => round.purged >= 6),
          everyRoundReusedAKey: contest.rounds.every((round) => round.created >= 1),
          failedKept: contest.rounds.map((round) => round.failedKept),
        }).toEqual({
          rounds: CONTEST_ROUNDS,
          everyRoundPurged: true,
          everyRoundReusedAKey: true,
          failedKept: contest.rounds.map((_, round) => 2 * (round + 1)),
        })
      },
      GRID_TIMEOUT_MS,
    )
  })
}
