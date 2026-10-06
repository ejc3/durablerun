import { isDeepStrictEqual } from 'node:util'
import type { PurgeCursor, PurgedUnit, Retention, RetentionPolicy } from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { retention } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../../conformance/src/fuzz.js'
import { makeLibsqlFixture } from '../../conformance/test/fixture-libsql.js'
import { exitCode } from '../src/exit.js'
import { storeTarget } from '../src/open-store.js'
import {
  type CliDb,
  type JsonAnswer,
  QUEUE,
  SELECTED,
  claimActivated,
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

const WINDOWS = ['--completed-after', '1h', '--cancelled-after', '1h']
const EVERY_STATE = [...WINDOWS, '--failed-after', '1h']
const KEEPING_FAILED: RetentionPolicy = { completedSeconds: 3_600, cancelledSeconds: 3_600 }
const NAMING_FAILED: RetentionPolicy = { ...KEEPING_FAILED, failedSeconds: 3_600 }

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
  flags: EVERY_STATE,
  policy: NAMING_FAILED,
  limit: null,
})
const purgeOf = (name: string, limit: number | undefined, keepFailed = false): Command => ({
  name,
  flags: [
    ...(keepFailed ? WINDOWS : EVERY_STATE),
    ...(limit === undefined ? [] : ['--limit', String(limit)]),
    '--execute',
  ],
  policy: keepFailed ? KEEPING_FAILED : NAMING_FAILED,
  limit: limit ?? 100,
})

/**
 * The port calls a purge is: list the candidates, and purge each in the order it is listed,
 * until `limit` units went or none is left. It is written here from the port's own words,
 * with a page of another size than the command's, so the comparison does not turn on a page.
 */
async function portPurge(
  port: Retention,
  policy: RetentionPolicy,
  limit: number,
): Promise<PurgedUnit[]> {
  const went: PurgedUnit[] = []
  let after: PurgeCursor | null = null
  for (;;) {
    const page = await port.purgeCandidates(QUEUE, policy, {
      limit: 7,
      ...(after === null ? {} : { after }),
    })
    for (const { taskId, idempotencyKey } of page.candidates) {
      if (went.length === limit) return went
      const purged = await port.purgeUnit(
        QUEUE,
        idempotencyKey === undefined ? { taskId } : { taskId, idempotencyKey },
        policy,
      )
      if (purged !== null) went.push(purged)
    }
    if (page.next === null) return went
    after = page.next
  }
}

/** The port's reads a dry run is: the listing, and what the barrier says of each candidate. */
async function portDryRun(port: Retention, policy: RetentionPolicy): Promise<void> {
  const page = await port.purgeCandidates(QUEUE, policy, { limit: 100 })
  for (const { taskId, idempotencyKey } of page.candidates) {
    await port.purgeAdmission(
      QUEUE,
      idempotencyKey === undefined ? { taskId } : { taskId, idempotencyKey },
      policy,
    )
  }
}

type PurgeAnswer = JsonAnswer & {
  readonly purged?: readonly { readonly taskId: string; readonly rows: unknown; state: string }[]
  readonly wouldPurge?: readonly unknown[]
  readonly kept?: readonly unknown[]
  readonly gone?: readonly unknown[]
}

/** What the command printed as purged, and what the port answered for: each unit by its task and its rows. */
const printed = (answer: PurgeAnswer) =>
  (answer.purged ?? []).map(({ taskId, rows }) => ({ taskId, rows }))
const answered = (ported: readonly PurgedUnit[]) =>
  ported.map(({ taskId, rows }) => ({ taskId, rows: { ...rows } }))

/** Seeded tasks in every outcome, two sagas, and a child the barrier keeps, under the test clock, which is then cleared. */
async function seeded(db: CliDb): Promise<void> {
  await seedTasks(db)
  await seedSagas(db)
  const parent = await db.store.spawn(QUEUE, 'parent', '{}')
  const running = await claimActivated(db, 'twin-parent', parent.taskId)
  const child = await db.store.spawn(QUEUE, 'child', '{}', {
    childOf: {
      parentQueue: QUEUE,
      parentTaskId: parent.taskId,
      runId: running.runId,
      claimToken: running.claimToken,
      replayKey: 'child#1',
    },
  })
  const worked = await claimActivated(db, 'twin-child', child.taskId)
  await db.store.complete(QUEUE, worked.runId, worked.claimToken, '{}')
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
          const ported =
            command.limit === null
              ? await portDryRun(port, command.policy).then(() => [])
              : await portPurge(port, command.policy, command.limit)
          const after = await subject.dump()
          expect(
            { where, same: after === (await twin.dump()) },
            'mutation-verdict:behavior:cli-purge-is-the-retention-port-and-nothing-else',
          ).toEqual({ where, same: true })
          expect(
            { where, printed: printed(answer) },
            'mutation-verdict:behavior:cli-purge-prints-exactly-the-units-that-went',
          ).toEqual({ where, printed: answered(ported) })
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
            const ported =
              command.limit === null
                ? await portDryRun(port, command.policy).then(() => [])
                : await portPurge(port, command.policy, command.limit)
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
