import { isDeepStrictEqual } from 'node:util'
import {
  type PurgeCursor,
  type Retention,
  type RetentionPolicy,
  type SqlExecutor,
  childSpawnKey,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { retention } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../../conformance/src/fuzz.js'
import { type ProtocolSnapshot, snapshot } from '../../conformance/src/poison-matrix.js'
import { dumpDifferences, purgeOracle } from '../../conformance/src/retention-oracle.js'
import { KEEPING_FAILED, NAMING_FAILED } from '../../conformance/src/retention-policies.js'
import { handWrittenTask } from '../../conformance/src/scenario.js'
import { makeLibsqlFixture } from '../../conformance/test/fixture-libsql.js'
import { exitCode } from '../src/exit.js'
import { storeTarget } from '../src/open-store.js'
import {
  type CliDb,
  type JsonAnswer,
  PURGE_EVERY_STATE,
  PURGE_WINDOWS,
  QUEUE,
  SELECTED,
  childOfAFailedParent,
  childrenOfARunningParent,
  openCliDb,
  openerOver,
  runCli,
  seedSagas,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * Exit test line 43: what `purge` takes is what the model of the barrier lets go, and it
 * changes nothing else. The command runs through `main` against a database. A dump of
 * every table is taken before it and after it, and the units it printed as purged are held
 * to the oracle of the retention surface, which is written from the model and not from the
 * code: applied to the dump taken before, in the order the units were printed, the oracle
 * must let each go with the rows the command printed for it, and what it leaves must be
 * the dump taken after. A command that purged a unit the model keeps, deleted a row of
 * another unit, or printed a unit that did not go, fails there. When a run says no more
 * remain, no unit may stand that the model lets go, and every unit it printed as kept must
 * be one the model keeps as the database stands: a pass takes what it frees.
 *
 * The command runs core's walk, so the walk is not what it is held to. A dry run is held
 * to the port itself: every candidate the port lists, and what the port's read of the
 * barrier says of each.
 *
 * It holds on every selected dialect over seeded tasks, and on libSQL over the states a
 * walk of the engine leaves. A purge refuses under a test clock, so each state is built
 * under one, at instants far in the past, and the clock is then cleared.
 */

/** A command line without the flags every write takes, and the policy and the limit it names. */
interface Command {
  readonly name: string
  readonly flags: readonly string[]
  readonly policy: RetentionPolicy
  /** The most units it purges, or null for a dry run, which purges none. */
  readonly limit: number | null
}

const dryRun = (name: string): Command => ({
  name,
  flags: PURGE_EVERY_STATE,
  policy: NAMING_FAILED,
  limit: null,
})
const purgeOf = (name: string, limit: number | undefined, keepFailed = false): Command => ({
  name,
  flags: [
    ...(keepFailed ? PURGE_WINDOWS : PURGE_EVERY_STATE),
    ...(limit === undefined ? [] : ['--limit', String(limit)]),
    '--execute',
  ],
  policy: keepFailed ? KEEPING_FAILED : NAMING_FAILED,
  limit: limit ?? 100,
})

interface Unit {
  readonly taskId: string
  readonly state: string
  readonly rows?: Readonly<Record<string, number>>
  readonly reasons?: readonly string[]
}

type PurgeAnswer = JsonAnswer & {
  readonly purged?: readonly Unit[]
  readonly wouldPurge?: readonly Unit[]
  readonly kept?: readonly Unit[]
  readonly gone?: readonly unknown[]
  readonly more?: boolean
  readonly finished?: boolean
}

const idsOf = (units: readonly Unit[] | undefined): string[] =>
  (units ?? []).map(({ taskId }) => taskId)

/** The units a command printed as kept, each with its reasons, as one comparable text. */
const keptOf = (answer: PurgeAnswer): string =>
  JSON.stringify((answer.kept ?? []).map(({ taskId, reasons }) => [taskId, reasons]))

/**
 * What the port itself says of every candidate, read here from the port's own words and
 * not through the walk: each candidate it lists, and whether every condition of the
 * barrier holds of it. A dry run prints a unit as one a purge would take where the port
 * says every condition holds, and as kept where it does not.
 */
async function portVerdicts(
  port: Retention,
  policy: RetentionPolicy,
): Promise<{ wouldGo: string[]; keeps: string[] }> {
  const wouldGo: string[] = []
  const keeps: string[] = []
  let after: PurgeCursor | null = null
  for (;;) {
    const page = await port.purgeCandidates(QUEUE, policy, {
      limit: 7,
      ...(after === null ? {} : { after }),
    })
    for (const candidate of page.candidates) {
      const said = await port.purgeAdmission(QUEUE, candidate, policy)
      if (said === null) continue
      const holds = Object.values(said.holds).every((held) => held)
      ;(holds ? wouldGo : keeps).push(candidate.taskId)
    }
    if (page.next === null) return { wouldGo, keeps }
    after = page.next
  }
}

/** What names a task's unit to the model: its id, and the key its row holds in the dump. */
function unitIn(dump: ProtocolSnapshot, taskId: string) {
  const key = dump.tasks.find(
    (row) => row.task_id === taskId && row.queue === QUEUE,
  )?.idempotency_key
  return key === null || key === undefined ? { taskId } : { taskId, idempotencyKey: String(key) }
}

/**
 * One command against the model: the dump before it, the dump after it, and what it
 * printed. Each list is empty when the command did what the model says.
 */
function againstTheModel(
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
  nowMs: number,
  command: Command,
  answer: PurgeAnswer,
) {
  let dump = before
  const notLetGo: string[] = []
  const rows: unknown[] = []
  const modelRows: unknown[] = []
  for (const unit of answer.purged ?? []) {
    const said = purgeOracle(dump, nowMs, QUEUE, unitIn(dump, unit.taskId), command.policy)
    if (said.keptBy.length > 0) notLetGo.push(`${unit.taskId}: ${said.keptBy.join(', ')}`)
    rows.push([unit.taskId, unit.rows])
    modelRows.push([unit.taskId, { ...said.rows }])
    dump = said.after
  }
  const letsGoNow = (taskId: string): boolean =>
    purgeOracle(after, nowMs, QUEUE, unitIn(after, taskId), command.policy).keptBy.length === 0
  // A run that says no more remain reached its end. A dry run deletes nothing, so what the
  // model lets go still stands after one, and a run its limit stopped left work behind.
  const reachedItsEnd = command.limit !== null && answer.more === false
  return {
    /** Units printed as purged that the model keeps. */
    notLetGo,
    /** What differs between what the model leaves and the dump taken after. */
    otherChanges: dumpDifferences(dump, after),
    overTheLimit: Math.max(0, (answer.purged ?? []).length - (command.limit ?? 0)),
    /** Units that stand, though the run said no more remain and the model lets them go. */
    leftBehind: reachedItsEnd
      ? after.tasks
          .filter((row) => row.queue === QUEUE)
          .map((row) => String(row.task_id))
          .filter(letsGoNow)
      : [],
    /** Units printed as kept that the model lets go as the database stands. */
    keptButFree: reachedItsEnd ? idsOf(answer.kept).filter(letsGoNow) : [],
    rows,
    modelRows,
  }
}

/**
 * Seeded tasks in every outcome, two sagas, a child the barrier keeps for good, and a
 * child that only its failed parent keeps, under the test clock, which is then cleared.
 */
async function seeded(db: CliDb): Promise<void> {
  await seedTasks(db)
  await seedSagas(db)
  await childrenOfARunningParent(db, 1)
  await childOfAFailedParent(db)
  await db.admin.setFakeNowEpochMs(null)
}

/** The commands over the seeded tasks, in the order they run against the one database. */
const SEEDED_COMMANDS: readonly (Command & { readonly changes: boolean })[] = [
  { ...dryRun('a dry run'), changes: false },
  { ...purgeOf('a purge of at most two units', 2), changes: true },
  { ...purgeOf('a purge that keeps failed tasks', undefined, true), changes: true },
  { ...purgeOf('a purge of the rest', undefined), changes: true },
  { ...purgeOf('a purge with nothing left to take', undefined), changes: false },
]

describe('purge is the retention port and nothing else', () => {
  for (const dialect of SELECTED) {
    it(`[${dialect}] after each command the units it printed are the units the model lets go, each gone whole with its rows, and nothing else changed`, async () => {
      const db = await openCliDb(dialect, 'purge-model')
      try {
        await seeded(db)
        let purgedInAll = 0
        /** The run before this one, when it ended finished with no more to do. */
        let last: { flags: string; kept: string } | null = null
        for (const [index, command] of SEEDED_COMMANDS.entries()) {
          const where = `${dialect}: ${command.name}`
          const flags = command.flags.join(' ')
          const said =
            command.limit === null
              ? await portVerdicts(
                  db.retentionWith(testIdSource(`verdicts-${index}`)),
                  command.policy,
                )
              : null
          const before = await snapshot(db.raw)
          const nowMs = Date.now()
          const run = await runCli(
            ['purge', ...command.flags, ...writeFlags(db), '--json'],
            db.env,
            undefined,
            testIdSource(`purge-model-${index}`),
          )
          const answer = JSON.parse(run.stdout) as PurgeAnswer
          const after = await snapshot(db.raw)
          const model = againstTheModel(before, after, nowMs, command, answer)
          // A run that says no more remain keeps no unit the model lets go: what a take
          // of the same run freed went with it.
          expect(
            { where, keptButFree: model.keptButFree },
            'mutation-verdict:behavior:cli-purge-keeps-no-unit-its-run-freed',
          ).toEqual({ where, keptButFree: [] })
          expect(
            {
              where,
              notLetGo: model.notLetGo,
              otherChanges: model.otherChanges,
              overTheLimit: model.overTheLimit,
              leftBehind: model.leftBehind,
            },
            'mutation-verdict:behavior:cli-purge-is-the-retention-port-and-nothing-else',
          ).toEqual({ where, notLetGo: [], otherChanges: [], overTheLimit: 0, leftBehind: [] })
          expect(
            { where, rows: model.rows },
            'mutation-verdict:behavior:cli-purge-prints-exactly-the-units-that-went',
          ).toEqual({ where, rows: model.modelRows })
          // A dry run lists as ones a purge would take the units the port says every
          // condition holds of, and as kept the ones it says one does not.
          if (said !== null) {
            expect(
              { where, wouldPurge: idsOf(answer.wouldPurge), kept: idsOf(answer.kept) },
              'mutation-verdict:behavior:cli-purge-would-purge-is-what-the-port-lets-go',
            ).toEqual({ where, wouldPurge: said.wouldGo, kept: said.keeps })
          }
          // A run that ended finished with no more to do, repeated at once: it purges
          // nothing, and keeps the same units for the same reasons. The child of the
          // running parent is kept in both, so the comparison is of a unit and its reason.
          if (last !== null && last.flags === flags) {
            expect({
              where,
              purged: idsOf(answer.purged),
              sameKept: keptOf(answer) === last.kept,
              keptSome: (answer.kept ?? []).length > 0,
            }).toEqual({ where, purged: [], sameKept: true, keptSome: true })
          }
          last =
            command.limit !== null && answer.finished === true && answer.more === false
              ? { flags, kept: keptOf(answer) }
              : null
          expect({
            where,
            exit: run.exit,
            changed: dumpDifferences(before, after).length > 0,
          }).toEqual({ where, exit: exitCode('done'), changed: command.changes })
          purgedInAll += (answer.purged ?? []).length
        }
        // Three seeded outcomes, two sagas, and the failed parent with its child go. The
        // child of the running parent is kept, and with it the tasks that are live.
        expect(purgedInAll).toBe(7)
      } finally {
        await db.close()
      }
    }, 300_000)
  }
})

/** The walks: these seeds, each this many steps. A failing seed replays exactly. */
const WALKS = Array.from({ length: 10 }, (_, seed) => `purge-${seed}`)
const STEPS = 100

/**
 * A unit the barrier keeps for good, written by hand into the state a walk left: a
 * completed child whose key names a parent that is live. No walk of these seeds leaves a
 * candidate the barrier keeps, and a repeat that keeps nothing compares nothing.
 */
async function plantAKeptChild(raw: SqlExecutor, endedAtMs: number): Promise<void> {
  const parent = 'a-live-parent'
  const child = 'a-kept-child'
  await raw.batch('fixture:planted', [
    handWrittenTask({ taskId: parent, state: 'sleeping', atMs: endedAtMs, queue: QUEUE }),
    handWrittenTask({
      taskId: child,
      state: 'completed',
      atMs: endedAtMs,
      queue: QUEUE,
      completedPayload: '{}',
    }),
    {
      sql: 'UPDATE tasks SET idempotency_key = ?, fence_at_ms = ? WHERE task_id = ?',
      args: [childSpawnKey(parent, 'kept'), endedAtMs, child],
    },
  ])
}

/**
 * What the commands over the walks must reach, so a comparison of nothing fails. Each
 * floor sits below what was measured when the case was written, so a change to the walk
 * that moves a seed does not fail the case, and a walk that leaves nothing to purge does.
 * Measured: 73 commands purged 102 units, 29 of them completed, 22 failed and 51 cancelled,
 * with 42 checkpoints. They printed 55 units as kept. 20 chains took 43 runs to say no more
 * remain, and 20 repeats followed them.
 */
const FLOORS = {
  commands: 60,
  purged: 70,
  completed: 18,
  failed: 14,
  cancelled: 34,
  checkpointsPurged: 25,
  kept: 40,
  chains: 14,
  chainRuns: 30,
  repeats: 14,
}

describe('purge over the states a walk of the engine leaves, on libSQL', () => {
  it('takes what the model lets go at every command, leaves nothing the model lets go when repeated until it says no more remain, and then keeps the same units for the same reasons', async () => {
    const url = 'file:/a-walk/subject.sqlite'
    const env = { DURABLERUN_STORE_URL: url }
    const target = await storeTarget(url)
    const reached = {
      commands: 0,
      purged: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      checkpointsPurged: 0,
      kept: 0,
      chains: 0,
      chainRuns: 0,
      repeats: 0,
    }
    const differed: string[] = []
    for (const walk of WALKS) {
      await runFuzzScenario(makeLibsqlFixture, walk, STEPS, async (subject) => {
        // A walk runs under a test clock, at instants long past. The kept unit ends at
        // the walk's last instant, and the clock is then cleared.
        await plantAKeptChild(subject.raw, await subject.admin.nowEpochMs())
        await subject.admin.setFakeNowEpochMs(null)
        let asked = 0
        /** Run one command and hold it to the model and, for a dry run, to the port. */
        const ask = async (command: Command): Promise<PurgeAnswer> => {
          asked += 1
          const where = `walk ${walk}: ${command.name} (${asked})`
          const said =
            command.limit === null
              ? await portVerdicts(
                  retention(subject.raw, testIdSource(`verdicts-${asked}`)),
                  command.policy,
                )
              : null
          const before = await snapshot(subject.raw)
          const nowMs = Date.now()
          const run = await runCli(
            ['purge', ...command.flags, ...writeFlags({ target }), '--json'],
            env,
            openerOver(subject),
            testIdSource(`walk-${asked}`),
          )
          const answer = JSON.parse(run.stdout) as PurgeAnswer
          const model = againstTheModel(before, await snapshot(subject.raw), nowMs, command, answer)
          const found: Record<string, readonly string[]> = {
            'a unit printed as kept is one the model lets go': model.keptButFree,
            'a unit printed as purged is one the model keeps': model.notLetGo,
            'the dump is not what the model leaves': model.otherChanges,
            'a unit the model lets go stands, though no more remain': model.leftBehind,
          }
          for (const [what, list] of Object.entries(found)) {
            if (list.length > 0) differed.push(`${where}: ${what}: ${list.slice(0, 3).join('; ')}`)
          }
          if (model.overTheLimit > 0) differed.push(`${where}: more went than the limit`)
          if (!isDeepStrictEqual(model.rows, model.modelRows)) {
            differed.push(`${where}: the rows printed are not the rows the model says went`)
          }
          if (
            said !== null &&
            !isDeepStrictEqual(
              [idsOf(answer.wouldPurge), idsOf(answer.kept)],
              [said.wouldGo, said.keeps],
            )
          ) {
            differed.push(`${where}: a dry run lists other units than the port lets go and keeps`)
          }
          if (run.exit !== 0) differed.push(`${where}: exit ${run.exit}: ${run.stdout}`)
          if ((answer.gone ?? []).length > 0) differed.push(`${where}: a unit was gone`)
          reached.commands += 1
          reached.kept += (answer.kept ?? []).length
          for (const unit of answer.purged ?? []) {
            reached.purged += 1
            if (unit.state === 'completed') reached.completed += 1
            if (unit.state === 'failed') reached.failed += 1
            if (unit.state === 'cancelled') reached.cancelled += 1
            reached.checkpointsPurged += unit.rows?.checkpoints ?? 0
          }
          return answer
        }
        await ask(dryRun('a dry run'))
        // The same command line, three units at a time, until it says no more remain:
        // first keeping failed tasks, and then naming every state.
        for (const chain of [
          purgeOf('three at a time, keeping failed tasks', 3, true),
          purgeOf('three at a time, of every state', 3),
        ]) {
          let answer = await ask(chain)
          let runs = 1
          while (answer.more === true && runs < 100) {
            answer = await ask(chain)
            runs += 1
          }
          if (answer.more !== false || answer.finished !== true) {
            differed.push(`walk ${walk}: ${chain.name}: the chain did not end in ${runs} runs`)
          }
          reached.chains += 1
          reached.chainRuns += runs
          // And repeated once more, at once: it purges nothing, and keeps the same units
          // for the same reasons.
          const again = await ask(chain)
          reached.repeats += 1
          if ((again.purged ?? []).length > 0 || keptOf(again) !== keptOf(answer)) {
            differed.push(
              `walk ${walk}: ${chain.name}: a repeat of a run with no more to do did more`,
            )
          }
          if ((again.kept ?? []).length === 0) {
            differed.push(
              `walk ${walk}: ${chain.name}: the repeat kept no unit, and compared nothing`,
            )
          }
        }
      })
    }
    expect(
      differed,
      'mutation-verdict:behavior:cli-purge-is-the-retention-port-over-a-walk',
    ).toEqual([])
    const short = Object.entries(FLOORS)
      .filter(([name, floor]) => reached[name as keyof typeof FLOORS] < floor)
      .map(([name]) => name)
    expect({ short, reached }).toEqual({ short: [], reached })
  }, 600_000)
})
