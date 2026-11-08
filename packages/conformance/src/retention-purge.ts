import {
  ChildAwaitRefusedError,
  InvalidDurableStringError,
  MAX_EPOCH_MS,
  PortRefusalError,
  type PurgeCandidatesOptions,
  type PurgeCursor,
  type PurgeUnitTarget,
  RETENTION_METHODS,
  RETENTION_STRINGS,
  type RetentionMethod,
  type RetentionPolicy,
  type SqlExecutor,
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
  AWAIT_STEP,
  type BuiltCell,
  GRID_CELLS,
  GRID_POLICY,
  type GridCell,
  PARENT_QUEUES,
  PARENT_STATES,
  type ParentState,
  REPLAY_KEY,
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
      replayKey: REPLAY_KEY,
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

/** What an await that threw says: the reason of a refusal, or the failure as it is described. */
const refusedOr = (error: unknown): string =>
  error instanceof ChildAwaitRefusedError ? `refused: ${error.reason}` : describeFailure(error)

/**
 * One purge of a unit the engine ended and a case then bent, held to the oracle: what
 * keeps the unit by the model's reading of the rows, whether the purge took it, or what it
 * threw, and how
 * every table afterwards differs from what the oracle says it must hold. `bend` writes
 * the rows the case is about, and may name the unit another way than its builder did.
 */
async function bentPurge(
  makeFixture: StoreFixtureFactory,
  name: string,
  cell: GridCell,
  policy: RetentionPolicy,
  bend: (f: StoreFixture, built: BuiltCell) => Promise<PurgeUnitTarget | undefined>,
): Promise<{
  keptBy: readonly KeptBy[]
  purged: boolean | string
  differences: readonly string[]
  /** Each condition a read of the barrier answers otherwise than the model reads it. */
  saysOtherwise: readonly string[]
}> {
  return withFixture(makeFixture, `bent ${name}`, async (f) => {
    const built = await buildCell(f, cell, 'c')
    await f.admin.setFakeNowEpochMs(built.purgeAtMs)
    const target = (await bend(f, built)) ?? built.target
    const before = await snapshot(f.raw)
    const oracle = purgeOracle(before, built.purgeAtMs, built.queue, target, policy)
    const retention = f.retentionOver(f.raw)
    const said = await retention.purgeAdmission(built.queue, target, policy)
    // A purge that throws has refused its own batch after the fact, by the count of what
    // the unit held. What it threw is the answer the case compares.
    const purged = await retention
      .purgeUnit(built.queue, target, policy)
      .then((answer) => answer !== null, describeFailure)
    return {
      keptBy: oracle.keptBy,
      purged,
      differences: dumpDifferences(oracle.after, await snapshot(f.raw)),
      saysOtherwise:
        said === null || oracle.holds === null
          ? [`the read answered ${said === null ? 'no task' : 'a task'}`]
          : Object.entries(oracle.holds)
              .filter(
                ([condition, holds]) => said.holds[condition as keyof typeof said.holds] !== holds,
              )
              .map(([condition, holds]) => `${condition}: the model says ${holds}`),
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
 * The grid block that each registered mutation of the barrier is caught by, named by the
 * state of the block's unit and of its parent. A marker is a literal because the mutation
 * audit reads it from this source, and a block no mutation is registered to has none.
 */
const GRID_VERDICTS: Readonly<Record<string, string>> = {
  'completed/live': 'mutation-verdict:behavior:purge-keeps-the-child-of-a-live-parent',
  'completed/failed': 'mutation-verdict:behavior:purge-keeps-the-child-of-a-failed-parent',
  'cancelled/live': 'mutation-verdict:behavior:purge-finds-a-parent-in-any-queue',
  'completed/none': 'mutation-verdict:behavior:purge-is-not-kept-by-a-run-that-holds-no-payload',
  'cancelled/none': 'mutation-verdict:behavior:purge-keeps-a-unit-whose-outcome-a-run-holds',
  'failed/none': 'mutation-verdict:behavior:purge-keeps-a-unit-whose-event-a-wait-names',
  'failed with a saga/none': 'mutation-verdict:behavior:purge-takes-a-unit-exactly-a-window-old',
}

/** The size block that each registered mutation of the checkpoint cap is caught by. */
const SIZE_VERDICTS: Readonly<Record<string, string>> = {
  completed: 'mutation-verdict:behavior:purge-keeps-a-unit-past-the-checkpoint-cap',
  cancelled: 'mutation-verdict:behavior:purge-takes-a-unit-at-the-checkpoint-cap',
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
            expect(observed, GRID_VERDICTS[`${unit}/${parent}`]).toEqual(expected)
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
          expect(observed, SIZE_VERDICTS[unit]).toEqual(expected)
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
            AWAIT_STEP,
            built.target.taskId,
            null,
          ).then((answer) => (answer.emitted ? 'answered with the outcome' : 'parked'), refusedOr)
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
            step: AWAIT_STEP,
            payloadJson: String(event?.payload),
          },
          violations: [],
        })
      })
    })
  })

  describe(`what keeps a unit that no engine path leaves [${dialect}]`, () => {
    const kept = (...keptBy: KeptBy[]) => ({
      keptBy,
      purged: false,
      differences: [],
      saysOtherwise: [],
    })

    it('a failed unit is kept under a policy that names no window for failed tasks', async () => {
      expect(
        await bentPurge(
          makeFixture,
          'policy',
          nothingInItsWay('failed'),
          CONTEST_POLICY,
          async () => undefined,
        ),
        'mutation-verdict:behavior:purge-keeps-a-state-the-policy-does-not-name',
      ).toEqual(kept('state'))
    })

    it('a unit whose stamp is NULL, or below every instant, is kept, however old its rows are', async () => {
      // A NULL stamp has no age to read. A stamp below every instant reads as older than
      // any window, so only the store's proof that the stamp is an instant in range keeps it.
      const stamped = (stamp: 'NULL' | '-5') =>
        bentPurge(
          makeFixture,
          'stamp',
          nothingInItsWay('completed'),
          GRID_POLICY,
          async (f, built) => {
            await write(f, `UPDATE tasks SET fence_at_ms = ${stamp} WHERE task_id = ?`, [
              built.target.taskId,
            ])
            return undefined
          },
        )
      expect(
        { asNull: await stamped('NULL'), belowEveryInstant: await stamped('-5') },
        'mutation-verdict:behavior:purge-reads-an-age-only-from-a-stamp-in-range',
      ).toEqual({ asNull: kept('stamp'), belowEveryInstant: kept('stamp') })
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
        'mutation-verdict:behavior:purge-keeps-a-unit-with-a-live-run',
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
        'mutation-verdict:behavior:purge-keeps-a-unit-with-a-run-in-another-queue',
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
        'mutation-verdict:behavior:purge-keeps-a-unit-whose-key-names-no-parent',
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
      expect(
        {
          underAnotherKey: await named(({ target }) => ({
            taskId: target.taskId,
            idempotencyKey: 'another-key',
          })),
          underNoKey: await named(({ target }) => ({ taskId: target.taskId })),
        },
        'mutation-verdict:behavior:purge-holds-the-key-the-unit-was-spawned-under',
      ).toEqual({ underAnotherKey: kept('key'), underNoKey: kept('key') })
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
        'mutation-verdict:behavior:purge-is-not-kept-by-its-own-run',
      ).toEqual({ keptBy: [], purged: true, differences: [], saysOtherwise: [] })
    })
  })

  describe(`what a read of the barrier says of a unit [${dialect}]`, () => {
    it('answers each condition by a flag of its own: a child a window old under a live parent is kept by its parent alone, under a longer window by its age too, and a task that is not there has no answer', async () => {
      await withFixture(makeFixture, 'purge-admission', async (f) => {
        const built = await buildCell(f, keptByItsParent('live', "the child's"), 'c')
        await f.admin.setFakeNowEpochMs(built.purgeAtMs)
        const retention = f.retentionOver(f.raw)
        /** The conditions the read answers as not held, in the barrier's order, or null for no answer. */
        const notHeld = async (unit: PurgeUnitTarget, policy: RetentionPolicy) => {
          const said = await retention.purgeAdmission(built.queue, unit, policy)
          return said === null
            ? null
            : Object.entries(said.holds)
                .filter(([, holds]) => !holds)
                .map(([condition]) => condition)
        }
        const twoHours = { completedSeconds: 7_200, cancelledSeconds: 7_200, failedSeconds: 7_200 }
        expect(
          {
            aWindowOld: await notHeld(built.target, GRID_POLICY),
            underALongerWindow: await notHeld(built.target, twoHours),
            notThere: await notHeld({ taskId: 'no-such-task' }, GRID_POLICY),
            // The read wrote nothing: the unit is as it was, and the purge keeps it.
            purged: await retention.purgeUnit(built.queue, built.target, GRID_POLICY),
          },
          'mutation-verdict:behavior:purge-admission-reads-each-condition-as-its-own-flag',
        ).toEqual({
          aWindowOld: ['parentCannotRunAgain'],
          underALongerWindow: ['endedAWindowAgo', 'parentCannotRunAgain'],
          notThere: null,
          purged: null,
        })
      })
    })
  })

  describe(`a purge beside an await of the same child [${dialect}]`, () => {
    it(`${RACE_ROUNDS} times at once: the purge takes the unit, and the await answers with the outcome or is refused for a task that is gone, and never parks`, async () => {
      await withFixture(makeFixture, 'purge-versus-await', async (f) => {
        const retention = f.retentionOver(f.raw)
        const outcomes: string[] = []
        const stranded: string[] = []
        for (let round = 0; round < RACE_ROUNDS; round++) {
          const built = await buildCell(f, nothingInItsWay('completed'), `race-${round}`)
          await f.admin.setFakeNowEpochMs(built.purgeAtMs)
          // The awaiter is claimed at the instant of the race, so its lease is live.
          const awaiter = await f.store.spawn(built.queue, 'awaiter', '{}')
          const run = await startOf(f, built.queue, awaiter.taskId, `w-awaiter-${round}`)
          await warmConnections(f.raw, 'purge-versus-await', 2)
          const [purge, awaited] = await Promise.all([
            retention
              .purgeUnit(built.queue, built.target, GRID_POLICY)
              .then((purged) => (purged === null ? 'kept' : 'purged'), describeFailure),
            awaitTaskOwned(f.store, built.queue, run, AWAIT_STEP, built.target.taskId, null).then(
              (answer) => (answer.emitted ? 'answered' : 'parked'),
              refusedOr,
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
        const { built, purged } = await purgedCell(f, nothingInItsWay('completed'))
        const { queue, target } = built
        const awaiter = await f.store.spawn(queue, 'awaiter', '{}')
        const run = await startOf(f, queue, awaiter.taskId, 'w-awaiter')
        const awaited = await awaitTaskOwned(
          f.store,
          queue,
          run,
          AWAIT_STEP,
          target.taskId,
          null,
        ).then(() => 'accepted', refusedOr)
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
          purgeAdmission: {
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
        // the task of a cursor, and the task and the key of a unit, for the purge of one and
        // for the read of what the barrier says of one.
        const named = (place: unknown): number =>
          typeof place === 'string'
            ? 1
            : place !== null && typeof place === 'object'
              ? Object.values(place).reduce((count: number, inner) => count + named(inner), 0)
              : 0
        expect({ places, named: named(RETENTION_STRINGS) }).toEqual({ places: 8, named: 8 })
      })
    })

    it('reads each member of an object argument once, so what the check read is what is bound', async () => {
      await withFixture(makeFixture, 'retention-read-once', async (f) => {
        // What a second reading answers at a place the table names: a string no store
        // keeps, which the port refuses when it is passed as it is.
        const second = `a-second-reading-\u0000${'x'.repeat(3_000)}`
        const bound: unknown[] = []
        const recording: SqlExecutor = {
          batch: (label, statements, control) => {
            for (const statement of statements) bound.push(...statement.args)
            return f.raw.batch(label, statements, control)
          },
        }
        const retention = f.retentionOver(recording)
        // One well-formed call of each method, holding every member an argument may hold.
        const everyState = {
          completedSeconds: 3_600,
          cancelledSeconds: 3_600,
          failedSeconds: 3_600,
        }
        const wellFormed: Readonly<Record<RetentionMethod, () => unknown[]>> = {
          purgeCandidates: () => [
            'q',
            { ...everyState },
            { limit: 1, after: { endedAtMs: 0, taskId: 't' } },
          ],
          purgeUnit: () => ['q', { taskId: 't', idempotencyKey: 'k' }, { ...everyState }],
          purgeAdmission: () => ['q', { taskId: 't', idempotencyKey: 'k' }, { ...everyState }],
        }
        /** Every member of an argument, and of an object a member holds, by its path. */
        const membersOf = (value: unknown, path: readonly string[]): string[][] =>
          value !== null && typeof value === 'object'
            ? Object.entries(value).flatMap(([key, inner]) => [
                [...path, key],
                ...membersOf(inner, [...path, key]),
              ])
            : []
        /** Whether the table of the port's strings names the place a path leads to. */
        const namedAt = (method: RetentionMethod, path: readonly string[]): boolean => {
          const passed = (spec: unknown): unknown =>
            spec !== null && typeof spec === 'object' && '?' in spec
              ? (spec as { '?': unknown })['?']
              : spec
          let spec: unknown = RETENTION_STRINGS[method]
          for (const key of path) {
            const inner = passed(spec)
            spec =
              inner !== null && typeof inner === 'object'
                ? (inner as Record<string, unknown>)[key]
                : undefined
          }
          return typeof passed(spec) === 'string'
        }
        const readAgain: string[] = []
        const secondBound: string[] = []
        let named = 0
        for (const method of RETENTION_METHODS) {
          const call = retention[method] as (...made: unknown[]) => Promise<unknown>
          const paths = wellFormed[method]().flatMap((argument, index) =>
            membersOf(argument, [String(index)]),
          )
          for (const path of paths) {
            const args = wellFormed[method]()
            let holder = args as unknown as Record<string, unknown>
            for (const step of path.slice(0, -1)) holder = holder[step] as Record<string, unknown>
            const key = String(path[path.length - 1])
            const first = holder[key]
            const isNamed = namedAt(method, path)
            if (isNamed) named += 1
            // The member answers what was passed to its first reader. To any later reader a
            // named string answers the second value, and every other member the same value.
            let reads = 0
            Object.defineProperty(holder, key, {
              enumerable: true,
              get: () => {
                reads += 1
                return reads === 1 || !isNamed ? first : second
              },
            })
            bound.length = 0
            await call(...args).catch(() => undefined)
            const where = `${method}[${path.join('.')}]`
            if (reads !== 1) readAgain.push(`${where}: ${reads} reads`)
            if (bound.includes(second)) secondBound.push(where)
          }
        }
        // Five members are strings the table names: the task of a cursor, and the task and
        // the key of a unit, for each of the two methods that name one.
        expect(
          { readAgain, secondBound, named },
          'mutation-verdict:behavior:retention-port-reads-each-member-once',
        ).toEqual({
          readAgain: [],
          secondBound: [],
          named: 5,
        })
      })
    })

    it('refuses a limit that is no whole number from 1 to 1000 and options that are no object, and sends nothing', async () => {
      await withFixture(makeFixture, 'retention-limit', async (f) => {
        const recorder = new RecordingExecutor(f.raw)
        const retention = f.retentionOver(recorder)
        const kindOf = (call: Promise<unknown>): Promise<string> =>
          call.then(
            () => 'taken',
            (error: unknown) =>
              error instanceof InvalidDurableStringError
                ? 'an invalid argument'
                : error instanceof PortRefusalError
                  ? 'a port refusal'
                  : error instanceof RangeError
                    ? 'a number out of range'
                    : String(error),
          )
        const limits: Readonly<Record<string, unknown>> = {
          'a limit of nothing': 0,
          'a negative limit': -1,
          'a limit one past the cap': 1_001,
          'a limit of a million': 1_000_000,
          'a limit that is no whole number': 1.5,
          'a limit written as text': '10',
          'no limit': undefined,
        }
        const options: Readonly<Record<string, unknown>> = {
          'options that are null': null,
          'options left out': undefined,
          'options that are a list': [],
          'options that are text': 'limit',
        }
        const answered: Record<string, string> = {}
        for (const [what, limit] of Object.entries(limits)) {
          answered[what] = await kindOf(
            retention.purgeCandidates('q', CONTEST_POLICY, { limit } as PurgeCandidatesOptions),
          )
        }
        for (const [what, passed] of Object.entries(options)) {
          answered[what] = await kindOf(
            retention.purgeCandidates('q', CONTEST_POLICY, passed as PurgeCandidatesOptions),
          )
        }
        const expected = Object.fromEntries([
          ...Object.keys(limits).map((what) => [what, 'a number out of range']),
          ...Object.keys(options).map((what) => [what, 'an invalid argument']),
        ])
        expect(
          { answered, sent: recorder.batches.map((batch) => batch.label) },
          'mutation-verdict:behavior:purge-candidates-holds-its-limit',
        ).toEqual({ answered: expected, sent: [] })
        // The cap itself is taken, in one batch.
        await retention.purgeCandidates('q', CONTEST_POLICY, { limit: 1_000 })
        expect(recorder.batches.map((batch) => batch.label)).toEqual(['purge-candidates'])
      })
    })

    it('refuses a cursor whose instant is no whole epoch-ms in range, and sends nothing', async () => {
      await withFixture(makeFixture, 'retention-cursor', async (f) => {
        const recorder = new RecordingExecutor(f.raw)
        const retention = f.retentionOver(recorder)
        const instants: Readonly<Record<string, unknown>> = {
          'an instant before the epoch': -1,
          'an instant that is no whole number': 1.5,
          'an instant past the last the engine takes': MAX_EPOCH_MS + 1,
          'an instant written as text': '0',
          'an instant that is null': null,
          'no instant': undefined,
        }
        const accepted: string[] = []
        for (const [what, endedAtMs] of Object.entries(instants)) {
          const after = { endedAtMs, taskId: 't' } as PurgeCursor
          const refused = await retention
            .purgeCandidates('q', CONTEST_POLICY, { limit: 1, after })
            .then(
              () => false,
              (error: unknown) => error instanceof PortRefusalError,
            )
          if (!refused) accepted.push(what)
        }
        expect({ accepted, sent: recorder.batches.map((batch) => batch.label) }).toEqual({
          accepted: [],
          sent: [],
        })
        // The first and the last instant the engine takes are taken.
        for (const endedAtMs of [0, MAX_EPOCH_MS]) {
          await retention.purgeCandidates('q', CONTEST_POLICY, {
            limit: 1,
            after: { endedAtMs, taskId: 't' },
          })
        }
        expect(recorder.batches.map((batch) => batch.label)).toEqual([
          'purge-candidates',
          'purge-candidates',
        ])
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
          const calls: Readonly<Record<RetentionMethod, () => Promise<unknown>>> = {
            purgeCandidates: () =>
              retention.purgeCandidates('q', policy as RetentionPolicy, { limit: 1 }),
            purgeUnit: () => retention.purgeUnit('q', { taskId: 't' }, policy as RetentionPolicy),
            purgeAdmission: () =>
              retention.purgeAdmission('q', { taskId: 't' }, policy as RetentionPolicy),
          }
          for (const [method, call] of Object.entries(calls)) {
            const refused = await call().then(
              () => false,
              (error: unknown) => error instanceof PortRefusalError,
            )
            if (!refused) accepted.push(`${method}: ${what}`)
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

  describe(`a spawn under a key whose task a purge takes [${dialect}]`, () => {
    /**
     * A store whose spawn batch finds its key held, and whose read of the holder then
     * finds nothing: what a spawn meets when a purge commits between the batch's insert
     * and its read, which a server lets happen. The batch is sent as it is, so the insert
     * loses to the task that holds the key. `between` then runs, and says whether this
     * send loses its read: the read's rows are then handed back empty, as they are when
     * the task is gone by then.
     */
    const losingTheHolder = (f: StoreFixture, between: (sent: number) => Promise<boolean>) => {
      let sent = 0
      const store = f.storeOver({
        batch: async (label, statements, control) => {
          const results = await f.raw.batch(label, statements, control)
          if (label !== 'spawn') return results
          sent += 1
          if (!(await between(sent))) return results
          return results.map((result, index) =>
            index === results.length - 1 ? { ...result, rows: [] } : result,
          )
        },
      })
      return { store, sent: () => sent }
    }
    const aWindowOld = nothingInItsWay('completed')

    it('creates the task on a second insert when the first lost to a task that is gone by its read', async () => {
      await withFixture(makeFixture, 'spawn-after-a-purge', async (f) => {
        const built = await buildCell(f, aWindowOld, 'c')
        await f.admin.setFakeNowEpochMs(built.purgeAtMs)
        const key = String(built.target.idempotencyKey)
        const retention = f.retentionOver(f.raw)
        const purged: unknown[] = []
        // The purge takes the holder after the first send alone, and the second send's
        // read is left as the store sent it.
        const { store } = losingTheHolder(f, async (sent) => {
          if (sent > 1) return false
          purged.push(await retention.purgeUnit(built.queue, built.target, GRID_POLICY))
          return true
        })
        const spawned = await store.spawn(built.queue, 'child', '{}', { idempotencyKey: key }).then(
          (answer) => ({
            created: answer.created,
            another: answer.taskId !== built.target.taskId,
          }),
          describeFailure,
        )
        const holders = (await snapshot(f.raw)).tasks.filter(
          (task) => task.queue === built.queue && task.idempotency_key === key,
        )
        expect(
          {
            purgedBetween: purged.map((unit) => unit !== null),
            spawned,
            holdersOfTheKey: holders.map((task) => task.task_id === built.target.taskId),
            violations: await engineHistoryViolations(f.raw),
          },
          'mutation-verdict:behavior:spawn-sends-once-more-when-its-holder-is-gone',
        ).toEqual({
          purgedBetween: [true],
          spawned: { created: true, another: true },
          holdersOfTheKey: [false],
          violations: [],
        })
      })
    })

    it('says so when the insert loses twice and no task explains it', async () => {
      await withFixture(makeFixture, 'spawn-loses-twice', async (f) => {
        const built = await buildCell(f, aWindowOld, 'c')
        const key = String(built.target.idempotencyKey)
        // The holder stays, and both reads are handed back empty: a loss no task explains,
        // which one more send does not cure.
        const { store, sent } = losingTheHolder(f, async () => true)
        const spawned = await store.spawn(built.queue, 'child', '{}', { idempotencyKey: key }).then(
          () => 'answered',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        expect({ spawned, sent: sent() }).toEqual({
          spawned: 'spawn: the task insert lost but no existing task explains it',
          sent: 2,
        })
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
