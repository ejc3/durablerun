import {
  type CorruptInteger,
  MAX_EPOCH_MS,
  OPERATOR_GAUGE_CAP,
  OPERATOR_LIST_CAP,
  OPERATOR_TABLE_ROWS_CAP,
  QUEUE_TABLES,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { STUCK_DEFAULT_LIMIT, durationSeconds } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import { DUE_GRACE_MS, HUNG_RUN_MS } from '../src/explain.js'
import { type StoreOpener, openStore } from '../src/open-store.js'
import { fixture, parkedOnAnEvent } from './explain-seeds.js'
import { DEFERRAL_FORMS, OWED_AT_MS, deferralTick, owedQueue, runOf } from './queue-seeds.js'
import {
  type CliDb,
  NOW_MS,
  QUEUE,
  claimActivated,
  onDb,
  recordingOpener,
  runCli,
  seedTasks,
} from './support.js'

/**
 * `stuck`, `stats` and `sizes` through `main` on libSQL (exit test line 37): what each
 * prints, the stream it prints on, and the exit it ends in, in human text and in `--json`.
 * What the reads behind them answer is held on every dialect by the conformance package's
 * `operator-reads` surface, against the engine and against a dump of every table.
 */

const LEGS = [
  'dueUnclaimed',
  'sleepingPastWake',
  'dueNotAdmitted',
  'leaseLapsed',
  'lapsedNotReclaimed',
  'cancelOverdue',
  'deadlineNotCancelled',
] as const
type Leg = (typeof LEGS)[number]
/** The legs that list tasks. Every other lists runs. */
const TASK_LEGS: readonly Leg[] = ['cancelOverdue', 'deadlineNotCancelled']

interface Row {
  readonly runId: string | null
  readonly taskId: string
  readonly lateByMs: number | null
  readonly activated?: boolean | null
}
type StuckAnswer = Readonly<Record<Leg, { rows: Row[]; atLeast: boolean }>> & {
  readonly exit: string
  readonly graceSeconds: number
  readonly limit: number
  readonly listed: number
  readonly corrupt: unknown[]
  /** Present with --older-than. */
  readonly agedLive?: {
    readonly olderThanSeconds: number
    readonly rows: { taskId: string; taskName: string; state: string; ageMs: number | null }[]
    readonly atLeast: boolean
    readonly corrupt: { field: string; taskId?: string }[]
  }
}

/** Run `stuck --json` with the flags given, and read each leg by the ids it lists. */
async function stuck(db: CliDb, flags: readonly string[] = [], opener?: StoreOpener) {
  const run = await runCli(['stuck', '--queue', QUEUE, '--json', ...flags], db.env, opener)
  const answer = JSON.parse(run.stdout) as StuckAnswer
  const ids = Object.fromEntries(
    LEGS.map((leg) => [
      leg,
      answer[leg].rows.map((row) => (TASK_LEGS.includes(leg) ? row.taskId : row.runId)),
    ]),
  )
  return { exit: run.exit, stderr: run.stderr, answer, ids, listed: answer.listed }
}

const NO_ROW: Readonly<Record<Leg, string[]>> = {
  dueUnclaimed: [],
  sleepingPastWake: [],
  dueNotAdmitted: [],
  leaseLapsed: [],
  lapsedNotReclaimed: [],
  cancelOverdue: [],
  deadlineNotCancelled: [],
}

describe('stuck on libSQL', () => {
  it('lists a row in each leg once its move has been owed for the grace, and exits 0 for it', () =>
    onDb('stuck-legs', async (db) => {
      const seeded = await owedQueue(db)
      const everyLeg = {
        ...NO_ROW,
        dueUnclaimed: [seeded.due],
        sleepingPastWake: [seeded.sleeper],
        // The run of the task past its deadline: a claim refuses it, and the sweep cancels
        // its task.
        dueNotAdmitted: [seeded.doomedRun],
        leaseLapsed: [seeded.abandoned],
        cancelOverdue: [seeded.doomed],
      }
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      // Every move is owed, and none for as long as the grace `explain` uses, so by default
      // nothing is listed.
      const byDefault = await stuck(db)
      expect({
        exit: byDefault.exit,
        graceSeconds: byDefault.answer.graceSeconds,
        limit: byDefault.answer.limit,
        listed: byDefault.listed,
        ids: byDefault.ids,
      }).toEqual({
        exit: 0,
        graceSeconds: DUE_GRACE_MS / 1000,
        limit: STUCK_DEFAULT_LIMIT,
        listed: 0,
        ids: NO_ROW,
      })
      // At grace 0 it lists what a claim and a sweep would take this instant, and the due
      // run a claim refuses. The lease expires at this very millisecond, and its run is
      // listed.
      const now = await stuck(db, ['--grace', '0s'])
      expect({ exit: now.exit, listed: now.listed, ids: now.ids }).toEqual({
        exit: 0,
        listed: 5,
        ids: everyLeg,
      })
      expect(
        LEGS.map((leg) => now.answer[leg].rows.map((row) => row.lateByMs)),
        'how late each move is: the due run a minute, the sleeper half of one, the refused run a minute, the lease not at all, the deadline a quarter',
      ).toEqual([[60_000], [30_000], [60_000], [0], [], [15_000], []])
      expect(now.answer.leaseLapsed.rows[0]?.activated).toBe(true)
      // A grace between the two lists the two runs that have been due that long.
      expect((await stuck(db, ['--grace', '1m'])).ids).toEqual({
        ...NO_ROW,
        dueUnclaimed: [seeded.due],
        dueNotAdmitted: [seeded.doomedRun],
      })
      expect((await stuck(db, ['--grace', '61s'])).ids).toEqual(NO_ROW)
      // Once the grace has run for the last of them, the default lists all five.
      await db.admin.setFakeNowEpochMs(OWED_AT_MS + DUE_GRACE_MS)
      const later = await stuck(db)
      expect({ exit: later.exit, ids: later.ids }).toEqual({ exit: 0, ids: everyLeg })
    }))

  it('prints its report on stdout in text, one line to a field, and nothing on stderr', () =>
    onDb('stuck-text', async (db) => {
      const seeded = await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      const run = await runCli(['stuck', '--queue', QUEUE, '--grace', '0s'], db.env)
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: '' })
      const lines = run.stdout.split('\n')
      for (const line of [
        'command: stuck',
        'exit: done',
        `queue: ${QUEUE}`,
        'graceSeconds: 0',
        'listed: 5',
        'dueNotAdmitted:',
        '      state: pending',
        'leaseLapsed:',
        `      runId: ${seeded.abandoned}`,
        '      activated: true',
        `      taskId: ${seeded.doomed}`,
        '      taskName: doomed',
        'corrupt: (none)',
      ]) {
        expect(lines, line).toContain(line)
      }
    }))

  it('exits 9 with --fail-if-any when a row is listed and 0 when none is, with the report on stdout either way', () =>
    onDb('stuck-fail-if-any', async (db) => {
      const seeded = await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      for (const output of [[], ['--json']]) {
        const line = ['stuck', '--queue', QUEUE, ...output]
        const found = await runCli([...line, '--grace', '0s', '--fail-if-any'], db.env)
        expect(
          {
            output,
            exit: found.exit,
            stderr: found.stderr,
            namesTheRun: found.stdout.includes(seeded.abandoned),
          },
          'mutation-verdict:behavior:cli-stuck-fail-if-any-exits-9',
        ).toEqual({ output, exit: exitCode('found'), stderr: '', namesTheRun: true })
        // The same rows without the flag are a report, not a failure.
        const listed = await runCli([...line, '--grace', '0s'], db.env)
        expect({ output, exit: listed.exit, same: listed.stdout.length > 0 }).toEqual({
          output,
          exit: 0,
          same: true,
        })
        // With the flag and no row listed, it exits 0.
        const none = await runCli([...line, '--fail-if-any'], db.env)
        expect(
          { output, exit: none.exit, stderr: none.stderr },
          'mutation-verdict:behavior:cli-stuck-exits-0-when-it-lists-nothing',
        ).toEqual({ output, exit: 0, stderr: '' })
      }
    }))

  it('lists a due run that no claim admits, names it as one, and exits 9 for it with --fail-if-any', () =>
    onDb('stuck-no-claim-admits', async (db) => {
      // Fixture-built: no engine path writes a retry strategy that is not JSON. A claim
      // refuses the run of such a task, and nothing of it is the sweep's to take.
      const task = await db.store.spawn(QUEUE, 'poisoned', '{}')
      const run = await runOf(db, task.taskId)
      await db.raw.batch('fixture:retry-strategy', [
        {
          sql: "UPDATE tasks SET retry_strategy = 'not json' WHERE task_id = ?",
          args: [task.taskId],
        },
      ])
      const hour = 3_600_000
      await db.admin.setFakeNowEpochMs(NOW_MS + hour)
      expect({
        claimed: (await db.store.claim(QUEUE, 'w', { leaseSeconds: 60, limit: 10 })).length,
        swept: (await db.store.sweep(QUEUE, 10)).length,
      }).toEqual({ claimed: 0, swept: 0 })
      // The gauges count the run as due, and its claim lag is the hour.
      const stats = JSON.parse(
        (await runCli(['stats', '--queue', QUEUE, '--json'], db.env)).stdout,
      ) as { gauges: { pendingRunsDue: { count: number } }; claimLagMs: number }
      expect({ due: stats.gauges.pendingRunsDue.count, claimLagMs: stats.claimLagMs }).toEqual({
        due: 1,
        claimLagMs: hour,
      })
      const found = await runCli(
        ['stuck', '--queue', QUEUE, '--json', '--grace', '0s', '--fail-if-any'],
        db.env,
      )
      const answer = JSON.parse(found.stdout) as {
        listed: number
        dueUnclaimed: { rows: unknown[] }
        dueNotAdmitted?: { rows: unknown[]; atLeast: boolean; unexamined: boolean }
      }
      expect(
        {
          exit: found.exit,
          listed: answer.listed,
          dueUnclaimed: answer.dueUnclaimed.rows,
          dueNotAdmitted: answer.dueNotAdmitted ?? 'the report has no such leg',
        },
        'mutation-verdict:behavior:cli-stuck-counts-a-due-run-no-claim-admits',
      ).toEqual({
        exit: exitCode('found'),
        listed: 1,
        dueUnclaimed: [],
        dueNotAdmitted: {
          rows: [
            {
              runId: run,
              taskId: task.taskId,
              state: 'pending',
              attempt: 1,
              dueAtMs: NOW_MS,
              lateByMs: hour,
            },
          ],
          atLeast: false,
          unexamined: false,
        },
      })
    }))

  it('lists a run under a lapsed lease that no sweep reclaims, names it as one, and exits 9 for it with --fail-if-any', () =>
    onDb('stuck-no-sweep-reclaims', async (db) => {
      const task = await db.store.spawn(QUEUE, 'held', '{}')
      const run = await claimActivated(db, 'w-held', task.taskId)
      // Fixture-built: no engine path writes more activations than claims. The sweep's scan
      // refuses a run whose generations it cannot act on.
      await db.raw.batch('fixture:generations', [
        {
          sql: 'UPDATE runs SET activated_gen = claim_gen + 5 WHERE run_id = ?',
          args: [run.runId],
        },
      ])
      const hour = 3_600_000
      await db.admin.setFakeNowEpochMs(NOW_MS + hour)
      expect((await db.store.sweep(QUEUE, 10)).length).toBe(0)
      const stats = JSON.parse(
        (await runCli(['stats', '--queue', QUEUE, '--json'], db.env)).stdout,
      ) as { gauges: { runningRunsLapsed: { count: number } } }
      expect(stats.gauges.runningRunsLapsed.count).toBe(1)
      // `explain` asks the sweep's own predicate of the run, and names it as one no sweep
      // takes back: a row no engine path writes, so it suggests a look and no sweep.
      const explained = await runCli(['explain', task.taskId, '--queue', QUEUE, '--json'], db.env)
      const diagnosis = JSON.parse(explained.stdout) as {
        cause: string
        verdict: string
        next: { argv: string[] } | null
      }
      expect({
        exit: explained.exit,
        cause: diagnosis.cause,
        verdict: diagnosis.verdict,
        next: diagnosis.next?.argv[0],
      }).toEqual({
        exit: 0,
        cause: 'lapsed-lease-no-sweep-reclaims',
        verdict: 'inconsistent',
        next: 'inspect',
      })
      const found = await runCli(
        ['stuck', '--queue', QUEUE, '--json', '--grace', '0s', '--fail-if-any'],
        db.env,
      )
      const answer = JSON.parse(found.stdout) as {
        listed: number
        leaseLapsed: { rows: unknown[] }
        lapsedNotReclaimed?: { rows: { runId: string; taskId: string; lateByMs: number }[] }
      }
      expect(
        {
          exit: found.exit,
          listed: answer.listed,
          leaseLapsed: answer.leaseLapsed.rows,
          lapsedNotReclaimed:
            answer.lapsedNotReclaimed?.rows.map((row) => [row.runId, row.taskId, row.lateByMs]) ??
            'the report has no such leg',
        },
        'mutation-verdict:behavior:cli-stuck-counts-a-lapsed-lease-no-sweep-reclaims',
      ).toEqual({
        exit: exitCode('found'),
        listed: 1,
        leaseLapsed: [],
        // The lease was for a minute.
        lapsedNotReclaimed: [[run.runId, task.taskId, hour - 60_000]],
      })
    }))

  it('lists a task past its cancellation deadline that no sweep cancels, names it as one, and exits 9 for it with --fail-if-any', () =>
    onDb('stuck-no-sweep-cancels', async (db) => {
      const task = await db.store.spawn(QUEUE, 'doomed', '{}', {
        cancellation: { maxDelaySeconds: 30 },
      })
      // Fixture-built: no engine path leaves a run of a task in another queue than the
      // task's. The sweep cancels no task that does not own every run of its id.
      await db.raw.batch('fixture:ownership', [
        { sql: "UPDATE runs SET queue = 'elsewhere' WHERE task_id = ?", args: [task.taskId] },
      ])
      const hour = 3_600_000
      await db.admin.setFakeNowEpochMs(NOW_MS + hour)
      expect((await db.store.sweep(QUEUE, 10)).length).toBe(0)
      const stats = JSON.parse(
        (await runCli(['stats', '--queue', QUEUE, '--json'], db.env)).stdout,
      ) as { gauges: { tasksPastTheirDeadline: { count: number } } }
      expect(stats.gauges.tasksPastTheirDeadline.count).toBe(1)
      const found = await runCli(
        ['stuck', '--queue', QUEUE, '--json', '--grace', '0s', '--fail-if-any'],
        db.env,
      )
      const answer = JSON.parse(found.stdout) as {
        listed: number
        cancelOverdue: { rows: unknown[] }
        deadlineNotCancelled?: { rows: { taskId: string; state: string; lateByMs: number }[] }
      }
      expect(
        {
          exit: found.exit,
          listed: answer.listed,
          cancelOverdue: answer.cancelOverdue.rows,
          deadlineNotCancelled:
            answer.deadlineNotCancelled?.rows.map((row) => [row.taskId, row.state, row.lateByMs]) ??
            'the report has no such leg',
        },
        'mutation-verdict:behavior:cli-stuck-counts-a-deadline-no-sweep-cancels',
      ).toEqual({
        exit: exitCode('found'),
        listed: 1,
        cancelOverdue: [],
        deadlineNotCancelled: [[task.taskId, 'pending', hour - 30_000]],
      })
    }))

  it('says more than it lists for one run a claim takes beside thirty it refuses, and that more may lie past its window', () =>
    onDb('stuck-window-beside-refused', async (db) => {
      const admitted = await db.store.spawn(QUEUE, 'healthy', '{}')
      // The thirty are due a second after it, so it is the oldest row of the window.
      await db.admin.setFakeNowEpochMs(NOW_MS + 1_000)
      for (let n = 0; n < 30; n++) await db.store.spawn(QUEUE, 'poisoned', '{}')
      // Fixture-built: no engine path writes a retry strategy that is not JSON.
      await db.raw.batch('fixture:retry-strategy', [
        {
          sql: "UPDATE tasks SET retry_strategy = 'not json' WHERE task_id <> ?",
          args: [admitted.taskId],
        },
      ])
      await db.admin.setFakeNowEpochMs(NOW_MS + 3_600_000)
      const found = await stuck(db, ['--grace', '0s'])
      const leg = found.answer.dueNotAdmitted as unknown as {
        rows: unknown[]
        atLeast: boolean
        unexamined: boolean
      }
      // The window is the 22 oldest due runs: the one a claim takes, and 21 it refuses. The
      // leg lists its limit of them, says the window showed more, and says that more may
      // lie past the window. It cannot say how many.
      expect({
        dueUnclaimed: found.answer.dueUnclaimed.rows.length,
        rows: leg.rows.length,
        atLeast: leg.atLeast,
        unexamined: leg.unexamined,
      }).toEqual({ dueUnclaimed: 1, rows: STUCK_DEFAULT_LIMIT, atLeast: true, unexamined: true })
    }))

  it('leaves nothing unexamined for a backlog too young for the grace', () =>
    onDb('stuck-window-young-backlog', async (db) => {
      for (let n = 0; n < STUCK_DEFAULT_LIMIT + 2; n++) await db.store.spawn(QUEUE, 'healthy', '{}')
      await db.admin.setFakeNowEpochMs(NOW_MS + 1_000)
      const unexamined = async (flags: string[]) => {
        const run = await stuck(db, flags)
        const leg = run.answer.dueNotAdmitted as unknown as { unexamined: boolean }
        return { exit: run.exit, listed: run.listed, unexamined: leg.unexamined }
      }
      // Twenty-two runs due for one second, under the default grace of two minutes: no row
      // of them could be listed, so the window left nothing unexamined.
      expect(await unexamined(['--fail-if-any'])).toEqual({ exit: 0, listed: 0, unexamined: false })
      // With no grace the twenty-second run stands behind a full leg of the claim's, and
      // could be one a claim refuses: the window does not settle it.
      expect(await unexamined(['--grace', '0s'])).toEqual({
        exit: 0,
        listed: STUCK_DEFAULT_LIMIT,
        unexamined: true,
      })
      // A claim takes all of them.
      expect((await db.store.claim(QUEUE, 'w', { leaseSeconds: 60, limit: 100 })).length).toBe(
        STUCK_DEFAULT_LIMIT + 2,
      )
    }))

  it('lists no healthy run: one under a live lease past the hung-run bound, and one parked on an event nobody emits', () =>
    onDb('stuck-healthy', async (db) => {
      const long = await db.store.spawn(QUEUE, 'long', '{}')
      const run = await claimActivated(db, 'w-long', long.taskId)
      const parked = await parkedOnAnEvent(db, null)
      await db.admin.setFakeNowEpochMs(NOW_MS + HUNG_RUN_MS - 1_000)
      if (!(await db.store.heartbeat(QUEUE, run.runId, run.claimToken, 60)).held) {
        throw new Error('the seed lost its lease')
      }
      await db.admin.setFakeNowEpochMs(NOW_MS + HUNG_RUN_MS + 1)
      const found = await stuck(db, ['--grace', '0s', '--fail-if-any'])
      expect({ exit: found.exit, listed: found.listed, ids: found.ids }).toEqual({
        exit: 0,
        listed: 0,
        ids: NO_ROW,
      })
      // No move is owed to either, so only their age finds them: asked for the live tasks
      // an hour old, the same command lists both, oldest first, and then it fails on them.
      const aged = await stuck(db, ['--grace', '0s', '--fail-if-any', '--older-than', '1h'])
      expect(
        {
          exit: aged.exit,
          listed: aged.listed,
          ids: aged.ids,
          aged: aged.answer.agedLive?.rows.map((task) => [task.taskId, task.state, task.ageMs]),
        },
        'mutation-verdict:behavior:cli-stuck-older-than-lists-what-no-leg-holds',
      ).toEqual({
        exit: exitCode('found'),
        listed: 2,
        ids: NO_ROW,
        aged: [
          [long.taskId, 'running', HUNG_RUN_MS + 1],
          [parked, 'sleeping', HUNG_RUN_MS + 1],
        ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      })
      // One millisecond more than their age lists neither.
      const older = await stuck(db, ['--fail-if-any', '--older-than', '3601s'])
      expect({ exit: older.exit, aged: older.answer.agedLive?.rows }).toEqual({ exit: 0, aged: [] })
    }))

  it('exits 10 for a report that names a corrupt row, before it exits 9, and still prints the report on stdout', () =>
    onDb('stuck-corrupt', async (db) => {
      await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      // The store's own predicates hold every instant a leg reads to its bounds, so a real
      // row reaches the report's corrupt list only through an integer they do not hold.
      // The port's answer is given one here, over the real rows.
      const planted: CorruptInteger = {
        field: 'runs.attempt',
        runId: 'a-run',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      }
      const withACorruptRow: StoreOpener = async (...args) => {
        const real = await openStore(...args)
        return {
          ...real,
          operator: {
            ...real.operator,
            stuckRuns: async (queue, options) => ({
              ...(await real.operator.stuckRuns(queue, options)),
              corrupt: [planted],
            }),
          },
        }
      }
      for (const output of [[], ['--json']]) {
        const run = await runCli(
          ['stuck', '--queue', QUEUE, '--grace', '0s', '--fail-if-any', ...output],
          db.env,
          withACorruptRow,
        )
        expect(
          {
            output,
            exit: run.exit,
            stderr: run.stderr,
            namesTheField: run.stdout.includes('runs.attempt'),
            listsTheRows: run.stdout.includes('doomed'),
          },
          'mutation-verdict:behavior:cli-stuck-exits-10-for-a-corrupt-row',
        ).toEqual({
          output,
          exit: exitCode('unreadable'),
          stderr: '',
          namesTheField: true,
          listsTheRows: true,
        })
      }
    }))

  it('refuses a grace or a limit it cannot read with exit 2, and sends nothing', () =>
    onDb('stuck-flags', async (db) => {
      for (const flags of [
        ['--grace', 'soon'],
        ['--grace', '2'],
        ['--grace', '1.5m'],
        ['--grace', '2M'],
        ['--grace', '1w'],
        ['--grace', ''],
        ['--grace=-1s'],
        // More than the hundred years a duration may be.
        ['--grace', '36526d'],
        ['--older-than', 'soon'],
        ['--older-than', '36526d'],
        ['--limit', '0'],
        ['--limit', String(OPERATOR_LIST_CAP + 1)],
        ['--limit', '1.5'],
        ['--limit', 'all'],
        ['--limit=-1'],
      ]) {
        const { opener, sent } = recordingOpener()
        const run = await runCli(['stuck', '--queue', QUEUE, '--json', ...flags], db.env, opener)
        expect(
          {
            flags,
            exit: run.exit,
            kind: (JSON.parse(run.stdout) as { error?: { kind?: string } }).error?.kind,
            sent: sent().length,
          },
          'mutation-verdict:behavior:cli-stuck-refuses-a-flag-it-cannot-read',
        ).toEqual({ flags, exit: 2, kind: 'usage', sent: 0 })
        // In text the refusal prints on stderr.
        const text = await runCli(['stuck', '--queue', QUEUE, ...flags], db.env)
        expect({ flags, exit: text.exit, stdout: text.stdout }).toEqual({
          flags,
          exit: 2,
          stdout: '',
        })
      }
      // The widest of each that is taken.
      for (const flags of [
        ['--grace', '36525d'],
        ['--grace', '0d'],
        ['--older-than', '0s'],
        ['--limit', String(OPERATOR_LIST_CAP)],
        ['--limit', '1'],
      ]) {
        expect({ flags, exit: (await stuck(db, flags)).exit }).toEqual({ flags, exit: 0 })
      }
    }))

  it('reads a duration as a whole number and a unit', () => {
    expect(
      ['0s', '90s', '2m', '1h', '1d', '999999999s'].map(durationSeconds),
      'mutation-verdict:behavior:cli-duration-units',
    ).toEqual([0, 90, 120, 3_600, 86_400, 999_999_999])
    for (const text of [
      '',
      '2',
      'm',
      '01m',
      '1.5m',
      '-1s',
      '2 m',
      '2M',
      '1w',
      '1000000000s',
      '2ms',
    ]) {
      expect({ text, seconds: durationSeconds(text) }).toEqual({ text, seconds: null })
    }
  })

  /**
   * Exit test line 37: a task looping through launch deferral, in the current worker's form
   * and in alpha.1's. Each tick claims its run and the worker parks it 15 to 24 seconds on,
   * so it is due and unclaimed for part of every minute, and never for as long as the
   * grace: under the default grace it is in no leg at any instant between ticks. At grace
   * 0 the same instants show it, so the check can say yes.
   */
  it("a task looping through launch deferral, in the current worker's form and in alpha.1's, is in no leg under the default grace at any instant between ticks, and its age finds it", async () => {
    for (const form of DEFERRAL_FORMS) {
      await onDb(`stuck-deferral-${form}`, async (db) => {
        /** The once-a-minute tick that backs a serverless deployment. */
        const CADENCE_MS = 60_000
        const BETWEEN_TICKS_MS = [1, 5_000, 14_999, 15_000, 24_000, 24_001, 40_000, 59_999]
        const task = await db.store.spawn(QUEUE, 'registered-by-no-build', '{}')
        const seenAtGraceZero: string[][] = []
        for (let tick = 0; tick < 4; tick++) {
          const tickAt = NOW_MS + tick * CADENCE_MS
          await db.admin.setFakeNowEpochMs(tickAt)
          const runId = await deferralTick(db, form, task.taskId, tick)
          const shown: string[] = []
          for (const offset of BETWEEN_TICKS_MS) {
            await db.admin.setFakeNowEpochMs(tickAt + offset)
            const byDefault = await stuck(db, ['--fail-if-any'])
            expect(
              { form, tick, offset, exit: byDefault.exit, ids: byDefault.ids },
              'mutation-verdict:behavior:cli-stuck-default-grace-outlasts-a-tick',
            ).toEqual({ form, tick, offset, exit: 0, ids: NO_ROW })
            const now = await stuck(db, ['--grace', '0s'])
            expect({ ...now.ids, sleepingPastWake: [] }).toEqual(NO_ROW)
            if (now.ids.sleepingPastWake?.length === 1) {
              expect(now.ids.sleepingPastWake).toEqual([runId])
              shown.push(`+${offset}`)
            }
          }
          seenAtGraceZero.push(shown)
        }
        // Its age is what finds it: the task has been live since the first tick, four
        // minutes less a millisecond ago.
        const aged = await stuck(db, ['--older-than', '3m'])
        expect(
          {
            form,
            ids: aged.ids,
            aged: aged.answer.agedLive?.rows.map((row) => [row.taskId, row.ageMs]),
          },
          'mutation-verdict:behavior:cli-stuck-older-than-finds-a-deferral-loop',
        ).toEqual({ form, ids: NO_ROW, aged: [[task.taskId, 4 * CADENCE_MS - 1]] })
        expect((await stuck(db, ['--older-than', '4m'])).answer.agedLive?.rows).toEqual([])
        // Parked for 15 to 24 seconds, the run is asleep one millisecond after each tick
        // and past its wake from 24 seconds on at the latest.
        for (const shown of seenAtGraceZero) {
          expect(shown).not.toContain('+1')
          expect(shown.slice(-3)).toEqual(['+24001', '+40000', '+59999'])
        }
      })
    }
  }, 240_000)
})

interface StatsAnswer {
  readonly exit: string
  readonly summary: string
  readonly gaugeCap: number
  readonly gauges: Readonly<Record<string, { count: number; atLeast: boolean }>>
  readonly claimLagMs: number | null
  readonly leaseHeadroomMs: number | null
  readonly nextWakeAtMs: number | null
  readonly oldestLiveTaskAgeMs: number | null
  readonly databaseNowEpochMs: number
  readonly fakeClock: boolean
  readonly corrupt: { field: string; runId?: string }[]
}

async function stats(db: CliDb) {
  const run = await runCli(['stats', '--queue', QUEUE, '--json'], db.env)
  return { exit: run.exit, stderr: run.stderr, answer: JSON.parse(run.stdout) as StatsAnswer }
}

/** The gauges that are not zero, each with its count. */
const counted = (answer: StatsAnswer): Record<string, number> =>
  Object.fromEntries(
    Object.entries(answer.gauges)
      .filter(([, gauge]) => gauge.count !== 0)
      .map(([name, gauge]) => [name, gauge.count]),
  )

describe('stats on libSQL', () => {
  it('prints quiet, never ok, when every gauge is zero, and active when one is not', () =>
    onDb('stats-quiet', async (db) => {
      const says = async () => {
        const json = await stats(db)
        const text = await runCli(['stats', '--queue', QUEUE], db.env)
        expect({ exit: text.exit, stderr: text.stderr }).toEqual({ exit: 0, stderr: '' })
        // No stream of either form says the queue is ok, as a word of its own.
        for (const printed of [text.stdout, JSON.stringify(json.answer)]) {
          expect(
            /\bok\b/i.test(printed),
            'mutation-verdict:behavior:cli-stats-says-quiet-never-ok',
          ).toBe(false)
        }
        return {
          exit: json.exit,
          summary: json.answer.summary,
          line: text.stdout.split('\n').filter((line) => line.startsWith('summary: ')),
          counted: counted(json.answer),
        }
      }
      expect(await says(), 'mutation-verdict:behavior:cli-stats-says-quiet-never-ok').toEqual({
        exit: 0,
        summary: 'quiet',
        line: ['summary: quiet'],
        counted: {},
      })
      // A run parked on an event nobody emits holds no instant, so it is in no gauge of
      // runs. Its task is live, and the gauge of live tasks counts it.
      await parkedOnAnEvent(db, null)
      expect(await says(), 'mutation-verdict:behavior:cli-stats-says-active').toEqual({
        exit: 0,
        summary: 'active',
        line: ['summary: active'],
        counted: { liveTasks: 1 },
      })
      await db.store.spawn(QUEUE, 'job', '{}')
      expect(await says(), 'mutation-verdict:behavior:cli-stats-says-active').toEqual({
        exit: 0,
        summary: 'active',
        line: ['summary: active'],
        counted: { pendingRuns: 1, pendingRunsDue: 1, liveTasks: 2 },
      })
    }))

  it('prints every gauge with its cap, and the instants at the head of the queue', () =>
    onDb('stats-gauges', async (db) => {
      await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      const { exit, answer } = await stats(db)
      expect({
        exit,
        gaugeCap: answer.gaugeCap,
        names: Object.keys(answer.gauges),
        counted: counted(answer),
        capped: Object.values(answer.gauges).some((gauge) => gauge.atLeast),
        claimLagMs: answer.claimLagMs,
        leaseHeadroomMs: answer.leaseHeadroomMs,
        nextWakeAtMs: answer.nextWakeAtMs,
        oldestLiveTaskAgeMs: answer.oldestLiveTaskAgeMs,
        databaseNowEpochMs: answer.databaseNowEpochMs,
        fakeClock: answer.fakeClock,
      }).toEqual({
        exit: 0,
        gaugeCap: OPERATOR_GAUGE_CAP,
        names: [
          'liveTasks',
          'pendingRuns',
          'pendingRunsDue',
          'runningRuns',
          'runningRunsLapsed',
          'sleepingRuns',
          'sleepingRunsDue',
          'tasksPastTheirDeadline',
          'tasksWithADeadline',
        ],
        // Two pending runs, the due one and the doomed task's, one sleeper past its wake,
        // one run whose lease expires this millisecond, and one task past its deadline.
        counted: {
          pendingRuns: 2,
          pendingRunsDue: 2,
          sleepingRuns: 1,
          sleepingRunsDue: 1,
          runningRuns: 1,
          runningRunsLapsed: 1,
          tasksWithADeadline: 1,
          tasksPastTheirDeadline: 1,
          // The four tasks of the seed, all live.
          liveTasks: 4,
        },
        capped: false,
        // The head of the queue has waited since the seed's start, a minute ago.
        claimLagMs: 60_000,
        leaseHeadroomMs: 0,
        nextWakeAtMs: NOW_MS,
        oldestLiveTaskAgeMs: 60_000,
        databaseNowEpochMs: OWED_AT_MS,
        fakeClock: true,
      })
    }))

  it('exits 10 for a counted row whose instant is not readable, and prints its report on stdout', () =>
    onDb('stats-corrupt', async (db) => {
      const task = await db.store.spawn(QUEUE, 'job', '{}')
      // Fixture-built: no engine path writes an instant outside its bounds.
      await fixture(db, 'UPDATE runs SET available_at_ms = ? WHERE task_id = ?', [
        MAX_EPOCH_MS + 1,
        task.taskId,
      ])
      const json = await stats(db)
      expect(
        {
          exit: json.exit,
          counted: counted(json.answer),
          corrupt: json.answer.corrupt.map((entry) => entry.field),
        },
        'mutation-verdict:behavior:cli-stats-exits-10-for-a-corrupt-row',
      ).toEqual({
        exit: exitCode('unreadable'),
        // The row is counted in its state's gauge, and in neither gauge of an instant.
        counted: { pendingRuns: 1, liveTasks: 1 },
        corrupt: ['runs.available_at_ms'],
      })
      const text = await runCli(['stats', '--queue', QUEUE], db.env)
      expect(
        {
          exit: text.exit,
          stderr: text.stderr,
          printsTheReport: text.stdout.includes('field: runs.available_at_ms'),
        },
        'mutation-verdict:behavior:cli-stats-prints-its-report-on-stdout',
      ).toEqual({ exit: exitCode('unreadable'), stderr: '', printsTheReport: true })
    }))
})

describe('sizes on libSQL', () => {
  it("prints the count of one queue's rows of each table, and of no other queue's", () =>
    onDb('sizes', async (db) => {
      await seedTasks(db)
      await parkedOnAnEvent(db, null)
      await db.store.spawn('another-queue', 'job', '{}')
      const countOf = async (queue: string): Promise<Record<string, number>> => {
        const read = await db.raw.batch(
          'fixture:count-a-queue',
          QUEUE_TABLES.map((table) => ({
            sql: `SELECT COUNT(*) AS n FROM ${table} WHERE queue = ?`,
            args: [queue],
          })),
          'read',
        )
        return Object.fromEntries(
          QUEUE_TABLES.map((table, index) => [table, Number(read[index]?.rows[0]?.n)]),
        )
      }
      const printed = async (queue: string) => {
        const run = await runCli(['sizes', '--queue', queue, '--json'], db.env)
        const answer = JSON.parse(run.stdout) as {
          cap: number
          tables: Record<string, { count: number; atLeast: boolean }>
        }
        expect({ exit: run.exit, cap: answer.cap }).toEqual({
          exit: 0,
          cap: OPERATOR_TABLE_ROWS_CAP,
        })
        expect(Object.values(answer.tables).some((table) => table.atLeast)).toBe(false)
        return Object.fromEntries(
          Object.entries(answer.tables).map(([table, { count }]) => [table, count]),
        )
      }
      const own = await countOf(QUEUE)
      // The seed leaves a row of the queue in every table, so no count is held to zero alone.
      expect(Object.entries(own).filter(([, rows]) => rows === 0)).toEqual([])
      expect(await printed(QUEUE), 'mutation-verdict:behavior:cli-sizes-counts-one-queue').toEqual(
        own,
      )
      expect(await printed('another-queue')).toEqual({
        ...Object.fromEntries(QUEUE_TABLES.map((table) => [table, 0])),
        tasks: 1,
        runs: 1,
      })
      const text = await runCli(['sizes', '--queue', QUEUE], db.env)
      expect({ exit: text.exit, stderr: text.stderr }).toEqual({ exit: 0, stderr: '' })
      expect(text.stdout.split('\n')).toContain(`cap: ${OPERATOR_TABLE_ROWS_CAP}`)
    }))
})

describe('stuck --older-than on libSQL', () => {
  it('lists the live tasks enqueued at least that long ago, oldest first, each with its age, beside the legs', () =>
    onDb('stuck-older-than', async (db) => {
      await owedQueue(db)
      await db.admin.setFakeNowEpochMs(OWED_AT_MS)
      const newest = await db.store.spawn(QUEUE, 'newest', '{}')
      await db.admin.setFakeNowEpochMs(OWED_AT_MS + 1_000)
      const ages = async (olderThan: string, ...more: string[]) => {
        const found = await stuck(db, ['--older-than', olderThan, ...more])
        const aged = found.answer.agedLive
        return {
          exit: found.exit,
          // Under the default grace no leg lists a row, so every row listed is one of these.
          listed: found.listed,
          olderThanSeconds: aged?.olderThanSeconds,
          tasks: aged?.rows.map((task) => [task.taskName, task.ageMs]),
          atLeast: aged?.atLeast,
        }
      }
      const seeded = [
        ['doomed', 61_000],
        ['due', 61_000],
        ['left', 61_000],
        ['nap', 61_000],
      ]
      const any = await ages('0s')
      // The four tasks of the seed were enqueued at one instant, so among them the order is
      // their ids', and the task enqueued a minute later is last.
      expect({
        ...any,
        tasks: [...(any.tasks ?? []).slice(0, 4).sort(), ...(any.tasks ?? []).slice(4)],
      }).toEqual({
        exit: 0,
        listed: 5,
        olderThanSeconds: 0,
        tasks: [...seeded, ['newest', 1_000]],
        atLeast: false,
      })
      // A task is listed from the instant it is as old as asked.
      const exactly = async (olderThan: string) => ((await ages(olderThan)).tasks ?? []).length
      expect(
        {
          aSecond: await exactly('1s'),
          sixtyOne: await exactly('61s'),
          more: await exactly('62s'),
        },
        'mutation-verdict:behavior:cli-stuck-older-than-lists-a-task-as-old-as-asked',
      ).toEqual({ aSecond: 5, sixtyOne: 4, more: 0 })
      // The limit of a leg is the limit of this list too.
      const two = await ages('0s', '--limit', '2')
      expect({ tasks: two.tasks?.length, atLeast: two.atLeast, listed: two.listed }).toEqual({
        tasks: 2,
        atLeast: true,
        listed: 2,
      })
      // Without the flag the report holds no such list, and nothing reads the live tasks.
      const { opener, sent } = recordingOpener()
      const plain = await stuck(db, [], opener)
      expect({
        agedLive: plain.answer.agedLive,
        labels: sent().map((batch) => batch.label),
      }).toEqual({ agedLive: undefined, labels: ['migrate:version', 'stuck-runs', 'fake-clock'] })
      // In text the list prints on stdout under its own name.
      const text = await runCli(['stuck', '--queue', QUEUE, '--older-than', '0s'], db.env)
      expect({ exit: text.exit, stderr: text.stderr }).toEqual({ exit: 0, stderr: '' })
      const lines = text.stdout.split('\n')
      for (const line of [
        'agedLive:',
        '  olderThanSeconds: 0',
        `      taskId: ${newest.taskId}`,
        '      ageMs: 1000',
      ]) {
        expect(lines, line).toContain(line)
      }
    }))

  it('reports a live task enqueued past its bound only when its leg reads it, so the exit depends on the limit', () =>
    onDb('stuck-older-than-behind-a-limit', async (db) => {
      const tasks = [
        await db.store.spawn(QUEUE, 'first', '{}'),
        await db.store.spawn(QUEUE, 'second', '{}'),
        await db.store.spawn(QUEUE, 'third', '{}'),
      ]
      const beyond = tasks[0]?.taskId ?? ''
      // Fixture-built: no engine path writes an enqueue instant past its bound. The index
      // of live tasks orders by the stored instant, so this task is the last of its state.
      await db.raw.batch('fixture:out-of-bounds', [
        {
          sql: 'UPDATE tasks SET enqueue_at_ms = ? WHERE task_id = ?',
          args: [MAX_EPOCH_MS + 1, beyond],
        },
      ])
      await db.admin.setFakeNowEpochMs(NOW_MS + 60_000)
      const under = async (limit: number) => {
        const run = await stuck(db, ['--older-than', '1s', '--limit', String(limit)])
        return {
          limit,
          exit: run.exit,
          named: run.answer.agedLive?.corrupt.map((entry) => entry.taskId),
          listsIt: run.answer.agedLive?.rows.some((task) => task.taskId === beyond),
        }
      }
      expect([await under(1), await under(2), await under(5)]).toEqual([
        // The leg stops at two rows, before the task: it is neither listed nor named.
        { limit: 1, exit: 0, named: [], listsIt: false },
        // The leg reads three rows, the task last: it is named, and the list has no room for it.
        { limit: 2, exit: exitCode('unreadable'), named: [beyond], listsIt: false },
        { limit: 5, exit: exitCode('unreadable'), named: [beyond], listsIt: true },
      ])
    }))

  it('exits 10 for a live task whose enqueue instant is not readable, lists it, and puts that before exit 9', () =>
    onDb('stuck-older-than-corrupt', async (db) => {
      const task = await db.store.spawn(QUEUE, 'job', '{}')
      // Fixture-built: no engine path writes an enqueue instant outside its bounds.
      await fixture(db, 'UPDATE tasks SET enqueue_at_ms = -9 WHERE task_id = ?', [task.taskId])
      for (const output of [[], ['--json']]) {
        const run = await runCli(
          ['stuck', '--queue', QUEUE, '--older-than', '1h', '--fail-if-any', ...output],
          db.env,
        )
        expect(
          {
            output,
            exit: run.exit,
            stderr: run.stderr,
            namesTheField: run.stdout.includes('tasks.enqueue_at_ms'),
            listsTheTask: run.stdout.includes(task.taskId),
          },
          'mutation-verdict:behavior:cli-stuck-exits-10-for-a-live-task-it-cannot-date',
        ).toEqual({
          output,
          exit: exitCode('unreadable'),
          stderr: '',
          namesTheField: true,
          listsTheTask: true,
        })
      }
    }))
})
