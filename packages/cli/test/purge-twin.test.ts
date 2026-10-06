import { isDeepStrictEqual } from 'node:util'
import {
  type PurgeCursor,
  type PurgedUnit,
  type Retention,
  type RetentionPolicy,
  purgeWalk,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { retention } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../../conformance/src/fuzz.js'
import { KEEPING_FAILED, NAMING_FAILED } from '../../conformance/src/retention-policies.js'
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
  childrenOfARunningParent,
  dumpOf,
  openCliDb,
  openerOver,
  recordingOpener,
  runCli,
  seedSagas,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * Exit test line 43: `purge` is the retention port's calls and nothing else. The command
 * runs through `main` against one database, and the port calls it is run against a twin: a
 * second database built the same way, by the same calls, with the same seeded ids. After
 * each command a dump of every table of the one equals the dump of the other, and the
 * units the command printed as purged are the units the port answered for on the twin, each
 * with the rows that went. A command that deleted a row the port does not delete, purged a
 * unit the port keeps, or printed a unit that did not go, leaves another dump or another
 * list.
 *
 * The twins are compared on every selected dialect over seeded tasks, and on libSQL over
 * the states a walk of the engine leaves. A purge refuses under a test clock, so each pair
 * is built under one, at instants far in the past, and the clock is then cleared on both.
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

/**
 * The purge a command is, on the twin: core's one walk over the port, which is what the
 * command runs. It answers the units that went, each with its rows.
 */
async function portPurge(
  port: Retention,
  policy: RetentionPolicy,
  limit: number,
): Promise<PurgedUnit[]> {
  const walked = await purgeWalk(port, QUEUE, policy, { limit, execute: true })
  if (walked.failed !== null) throw walked.failed.error
  return walked.taken.map(({ candidate, rows }) => {
    if (rows === null) throw new Error(`the purge of ${candidate.taskId} answered no rows`)
    return { taskId: candidate.taskId, rows }
  })
}

/**
 * What the port itself says of every candidate, on the twin, read here from the port's own
 * words and not through the walk: each candidate it lists, and whether every condition of
 * the barrier holds of it. A dry run prints a unit as one a purge would take where the
 * port says every condition holds, and as kept where it does not.
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

type PurgeAnswer = JsonAnswer & {
  readonly purged?: readonly { readonly taskId: string; readonly rows: unknown; state: string }[]
  readonly wouldPurge?: readonly { readonly taskId: string }[]
  readonly kept?: readonly { readonly taskId: string; readonly reasons: readonly string[] }[]
  readonly gone?: readonly unknown[]
  readonly more?: boolean
  readonly finished?: boolean
}

const idsOf = (units: readonly { readonly taskId: string }[] | undefined): string[] =>
  (units ?? []).map(({ taskId }) => taskId)

/** What the command printed as purged, and what the port answered for: each unit by its task and its rows. */
const printed = (answer: PurgeAnswer) =>
  (answer.purged ?? []).map(({ taskId, rows }) => ({ taskId, rows }))
const answered = (ported: readonly PurgedUnit[]) =>
  ported.map(({ taskId, rows }) => ({ taskId, rows: { ...rows } }))

/** Seeded tasks in every outcome, two sagas, and a child the barrier keeps, under the test clock, which is then cleared. */
async function seeded(db: CliDb): Promise<void> {
  await seedTasks(db)
  await seedSagas(db)
  await childrenOfARunningParent(db, 1)
  await db.admin.setFakeNowEpochMs(null)
}

/** The commands over the seeded tasks, in the order they run against the one pair of databases. */
const SEEDED_COMMANDS: readonly (Command & { readonly changes: boolean })[] = [
  { ...dryRun('a dry run'), changes: false },
  { ...purgeOf('a purge of at most two units', 2), changes: true },
  { ...purgeOf('a purge that keeps failed tasks', undefined, true), changes: true },
  { ...purgeOf('a purge of the rest', undefined), changes: true },
  { ...purgeOf('a purge with nothing left to take', undefined), changes: false },
]

describe('purge is the retention port and nothing else', () => {
  for (const dialect of SELECTED) {
    it(`[${dialect}] after each command a dump of every table equals the dump the port's calls leave on a twin, and the units it printed are the units that went`, async () => {
      const subject = await openCliDb(dialect, 'purge-twin')
      const twin = await openCliDb(dialect, 'purge-twin')
      try {
        await seeded(subject)
        await seeded(twin)
        let before = await subject.dump()
        expect(await twin.dump(), 'the two databases start equal').toBe(before)
        let purgedInAll = 0
        for (const [index, command] of SEEDED_COMMANDS.entries()) {
          const where = `${dialect}: ${command.name}`
          const seed = `purge-twin-${index}`
          const recorded = recordingOpener()
          const run = await runCli(
            ['purge', ...command.flags, ...writeFlags(subject), '--json'],
            subject.env,
            recorded.opener,
            testIdSource(seed),
          )
          const answer = JSON.parse(run.stdout) as PurgeAnswer
          const port = twin.retentionWith(testIdSource(seed))
          const said = command.limit === null ? await portVerdicts(port, command.policy) : null
          const ported =
            command.limit === null ? [] : await portPurge(port, command.policy, command.limit)
          const after = await subject.dump()
          expect(
            { where, same: after === (await twin.dump()) },
            'mutation-verdict:behavior:cli-purge-is-the-retention-port-and-nothing-else',
          ).toEqual({ where, same: true })
          expect(
            { where, printed: printed(answer) },
            'mutation-verdict:behavior:cli-purge-prints-exactly-the-units-that-went',
          ).toEqual({ where, printed: answered(ported) })
          // A dry run lists as ones a purge would take the units the port says every
          // condition holds of, and as kept the ones it says one does not.
          if (said !== null) {
            expect(
              {
                where,
                wouldPurge: idsOf(answer.wouldPurge),
                kept: idsOf(answer.kept),
              },
              'mutation-verdict:behavior:cli-purge-would-purge-is-what-the-port-lets-go',
            ).toEqual({ where, wouldPurge: said.wouldGo, kept: said.keeps })
          }
          const purges = recorded.sent().filter((batch) => batch.label === 'purge-unit').length
          expect({
            where,
            exit: run.exit,
            changed: after !== before,
            // A purge batch went for every unit printed, and none for a dry run.
            sentAPurgeForEachUnit:
              purges >= ported.length && (command.limit !== null || purges === 0),
          }).toEqual({
            where,
            exit: exitCode('done'),
            changed: command.changes,
            sentAPurgeForEachUnit: true,
          })
          purgedInAll += ported.length
          before = after
        }
        // Three seeded outcomes and two sagas go, in three purges. The child of the
        // running parent is kept, and with it the two tasks that are live.
        expect(purgedInAll).toBe(5)
      } finally {
        await twin.close()
        await subject.close()
      }
    }, 300_000)
  }
})

/** The walks: these seeds, each this many steps. A failing seed replays exactly. */
const WALKS = Array.from({ length: 10 }, (_, seed) => `purge-${seed}`)
const STEPS = 100

/** The commands over the state a walk left, in order. */
const WALK_COMMANDS: readonly Command[] = [
  dryRun('a dry run'),
  purgeOf('a purge of at most three units', 3),
  purgeOf('a purge that keeps failed tasks', undefined, true),
  purgeOf('a purge of the rest', undefined),
  purgeOf('a purge with nothing left to take', undefined),
]

/**
 * What the commands over the walks must reach, so a comparison of nothing fails. Measured
 * when the case was written: 50 commands purged 102 units, 29 of them completed, 22 failed
 * and 51 cancelled, and 42 checkpoints went with them. A floor sits below what was
 * measured, so a change to the walk that moves a seed does not fail the case, and a walk
 * that leaves nothing to purge does. No walk of these seeds leaves a candidate the barrier
 * keeps, so `kept` has no floor: the seeded pairs above hold a kept unit on every dialect.
 */
const FLOORS = {
  commands: 50,
  purged: 70,
  completed: 18,
  failed: 14,
  cancelled: 34,
  checkpointsPurged: 25,
  // Each walk's last command repeats the one before it, which had no more to do.
  repeats: 10,
}

describe('purge over the states a walk of the engine leaves, on libSQL', () => {
  it('leaves the dump the port leaves on a twin the same walk built, after every command, and prints the units that went', async () => {
    const url = 'file:/a-walk/subject.sqlite'
    const env = { DURABLERUN_STORE_URL: url }
    const target = await storeTarget(url)
    const reached = {
      commands: 0,
      purged: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      kept: 0,
      checkpointsPurged: 0,
      repeats: 0,
    }
    const differed: string[] = []
    for (const walk of WALKS) {
      await runFuzzScenario(makeLibsqlFixture, walk, STEPS, (subject) =>
        runFuzzScenario(makeLibsqlFixture, walk, STEPS, async (twin) => {
          // A walk runs under a test clock, at instants long past. It is cleared on both.
          await subject.admin.setFakeNowEpochMs(null)
          await twin.admin.setFakeNowEpochMs(null)
          expect(await dumpOf('libsql', twin.raw), `walk ${walk}: the twins start equal`).toBe(
            await dumpOf('libsql', subject.raw),
          )
          /** The run before this one, when it ended finished with no more to do. */
          let before: { flags: string; kept: string } | null = null
          for (const [index, command] of WALK_COMMANDS.entries()) {
            const seed = `walk-${index}`
            const where = `walk ${walk}: ${command.name}`
            const run = await runCli(
              ['purge', ...command.flags, ...writeFlags({ target }), '--json'],
              env,
              openerOver(subject),
              testIdSource(seed),
            )
            const answer = JSON.parse(run.stdout) as PurgeAnswer
            const port = retention(twin.raw, testIdSource(seed))
            const said = command.limit === null ? await portVerdicts(port, command.policy) : null
            const ported =
              command.limit === null ? [] : await portPurge(port, command.policy, command.limit)
            if (
              said !== null &&
              !isDeepStrictEqual(
                [idsOf(answer.wouldPurge), idsOf(answer.kept)],
                [said.wouldGo, said.keeps],
              )
            ) {
              differed.push(`${where}: a dry run lists other units than the port lets go and keeps`)
            }
            // A run that ended finished with no more to do is repeated at once by the
            // command after it, on a database nothing else touched: the repeat purges
            // nothing, and lists the same units as kept for the same reasons.
            const keptNow = JSON.stringify(
              (answer.kept ?? []).map(({ taskId, reasons }) => [taskId, reasons]),
            )
            if (before !== null && before.flags === command.flags.join(' ')) {
              reached.repeats += 1
              if ((answer.purged ?? []).length > 0 || keptNow !== before.kept) {
                differed.push(`${where}: a repeat of a run that had no more to do did more`)
              }
            }
            before =
              command.limit !== null && answer.finished === true && answer.more === false
                ? { flags: command.flags.join(' '), kept: keptNow }
                : null
            if ((await dumpOf('libsql', subject.raw)) !== (await dumpOf('libsql', twin.raw))) {
              differed.push(`${where}: the dumps differ`)
            }
            if (!isDeepStrictEqual(printed(answer), answered(ported))) {
              differed.push(`${where}: the units printed are not the units that went`)
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
              reached.checkpointsPurged += (unit.rows as { checkpoints: number }).checkpoints
            }
          }
        }).then(() => undefined),
      )
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
