/**
 * The week on the release alpha.1, run by the alpha.1 compatibility harness after its cycles.
 *
 * The deployed alpha runs alpha.1's SDK and store, and an operator works its database with
 * the current CLI. This runs that arrangement for a simulated week of 168 hourly periods,
 * over a libSQL file that alpha.1's own migrate() took to version 5 and the CLI then
 * migrated to the build's version. alpha.1 is the worker: its store claims, and its SDK
 * runs the example's own `periodic-digest` and `wait-for-ready` handlers, loaded from a
 * copy of the example that resolves the alpha.1 packages. The current CLI is the operator:
 * it enqueues each period under its key, sweeps every hour, finds the planted causes with
 * `stuck --older-than` and names them with `explain`, cancels them, emits an event, and
 * purges.
 *
 * alpha.1 runs under the database's test clock, set ten days in the past, which it honours
 * because its clock reads the same `fake_now_ms` meta row. `purge` refuses a database
 * whose test clock is set, so the week ends three days in the past, the clock is cleared,
 * and the `purge` verb then runs under windows of five days less half an hour: the units
 * of the week's first five days are old enough by the database's own clock, and the rest
 * are not. Every `purge` command is held to the model of the barrier (`againstTheModel`),
 * over a dump of every table taken before it and after it.
 *
 * If alpha.1 and the current build disagree about a row, this fails and says where: a
 * read that is refused, a cause that is not the planted one, or a unit the model and the
 * purge differ on.
 */
import { spawnSync } from 'node:child_process'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { QUEUE_TABLES, type RetentionPolicy, systemIdSource } from '@durablerun/core'
import { CURRENT_SCHEMA_VERSION, LibsqlExecutor } from '@durablerun/store-libsql'
import {
  HOUR_MS,
  WEEK_DIGEST_UNIT_ROWS,
  WEEK_INJECTED_UNIT_ROWS,
  WEEK_PERIODS,
  type WeekRows,
  digestKey,
  digestPeriod,
  readPurge,
  readSelftest,
  sha256,
} from '../../../apps/dogfood/src/week-receipt.js'
import { type ProtocolSnapshot, snapshot } from '../../conformance/src/poison-matrix.js'
import { dumpDifferences, purgeOracle } from '../../conformance/src/retention-oracle.js'
import { type Alpha1Store, installedIn, loadAlpha1 } from './alpha1-release.js'
import { type PurgeAnswer, againstTheModel, idsOf, modelDifferences } from './purge-model.js'
import { runCli } from './support.js'

const QUEUE = 'digest'
const DAY_MS = 24 * HOUR_MS
/** How far in the past the week starts, and so how far in the past it ends: three days. */
const WEEK_STARTS_AGO_MS = 10 * DAY_MS
/**
 * The windows the week purges under: five days less half an hour. A unit of the week ends
 * within six minutes of the start of its hour, so no unit ends within twenty minutes of
 * the instant the window cuts at, however long the harness has run by then.
 */
const WINDOW_MINUTES = 7170
const WINDOW = `${WINDOW_MINUTES}m`
const WINDOW_SECONDS = WINDOW_MINUTES * 60
const WINDOWS: RetentionPolicy = {
  completedSeconds: WINDOW_SECONDS,
  cancelledSeconds: WINDOW_SECONDS,
}
/** The periods those windows let go: the week's first five days and the hour after them. */
const PERIODS_PURGED = 121
/** The longest the harness may have run when it purges, for the windows to cut where they are meant to. */
const PURGE_STARTS_WITHIN_MS = 20 * 60_000
/** The instants of a period, in seconds after its start, at which the worker makes a pass. */
const PASSES_AT_SECONDS = [0, 61, 122, 183, 244, 305] as const
const DIGEST_PARAMS = { repository: 'example/project', ref: 'main' }

/** The periods with something planted in them. */
const PLAN = {
  /** Periods whose read fails on every attempt, so the task fails for good. */
  failing: [7, 55, 100, 150],
  /** A task name no deployed build has a handler for is enqueued. */
  unregistered: 3,
  /** A task that awaits an event nobody emits is enqueued. */
  awaitNobodyEmits: 5,
  /** A task that awaits an event is enqueued, and the operator emits the event two periods on. */
  awaitEmitted: 6,
  /** The operator finds the planted causes by age, explains each, and cancels it. */
  operatorLooks: 30,
  /** The digest's launch is lost: it is claimed and no worker starts it. */
  lostLaunch: 40,
  /** The digest's worker dies after it started the run. */
  workerDies: 41,
  /** A task with a deadline on its duration parks on an await, and the sweep cancels it. */
  deadline: 42,
} as const

type Handler = (ctx: unknown, params: unknown) => Promise<unknown>

const EXAMPLE = fileURLToPath(new URL('../../../examples/vercel-turso', import.meta.url))

/**
 * What the week uses of the release alpha.1 and of the example, loaded from the consumer
 * directory. The example's own sources and scripts are copied beside the installed release
 * first, so that its tasks and its migrate script resolve the alpha.1 packages, as a
 * deployed checkout of the example does. The harness makes the copy and not the script
 * that starts it: the base gate runs main's script over this tree, and main's makes none.
 */
async function load(consumer: string) {
  for (const part of ['src', 'scripts']) {
    cpSync(join(EXAMPLE, part), join(consumer, 'example', part), { recursive: true })
  }
  const example = (path: string) => pathToFileURL(join(consumer, 'example', path)).href
  const { core, store } = await loadAlpha1(consumer)
  const sdk = (await import(installedIn(consumer, '@durablerun/sdk/dist/index.js'))) as {
    runClaimedRun(
      deps: { store: Alpha1Store; clock: object; registry: ReadonlyMap<string, Handler> },
      invocation: { queue: string; runId: string; claimToken: string; claimGen: number },
    ): Promise<{ kind: string }>
  }
  const digest = (await import(example('src/periodic-digest.ts'))) as {
    PERIODIC_DIGEST_TASK: string
    createPeriodicDigest(observe: (input: unknown) => Promise<unknown>): Handler
  }
  const tasks = (await import(example('src/tasks.ts'))) as {
    WAIT_FOR_READY_TASK: string
    taskRegistry: ReadonlyMap<string, Handler>
  }
  return { core, sdk, store, digest, tasks }
}

function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`the week on alpha.1: ${message}`)
}

/** One command of the current CLI against the week's database, with its JSON answer. */
async function cli(
  file: string,
  argv: readonly string[],
  expectedExit = 0,
): Promise<Record<string, unknown>> {
  const run = await runCli(
    [...argv, '--json'],
    { DURABLERUN_STORE_URL: `file:${file}` },
    undefined,
    systemIdSource(),
  )
  must(
    run.exit === expectedExit,
    `${argv.slice(0, 2).join(' ')} exited ${run.exit}, not ${expectedExit}: ${run.stdout}${run.stderr}`,
  )
  return JSON.parse(run.stdout) as Record<string, unknown>
}

/**
 * The example's migrate script, run as a process from the copy in the consumer directory,
 * so it resolves the alpha.1 packages as a deployed checkout of the example does.
 */
function exampleMigrate(consumer: string, file: string): { status: number | null; out: string } {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(consumer, 'example', 'scripts', 'migrate.ts')],
    {
      cwd: new URL('../../..', import.meta.url),
      env: {
        PATH: process.env.PATH ?? '',
        TURSO_DATABASE_URL: `file:${file}`,
        TURSO_AUTH_TOKEN: 'unused-by-a-file',
      },
      encoding: 'utf8',
    },
  )
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

/**
 * The example's migrate script against line 32's fixture: a file alpha.1 migrated to
 * version 5 and the CLI then migrated to the build's version. The script must leave it as
 * it is and say the CLI manages the schema. The control is alpha.1's own migrate() on the
 * same file, which refuses it: a script that still migrated unasked would fail here. On a
 * file that does not exist yet the script still migrates, to alpha.1's version.
 */
export async function migrateGuard(consumer: string, dir: string): Promise<string> {
  const { store } = await load(consumer)
  const fresh = join(dir, 'guard-fresh.sqlite')
  const first = exampleMigrate(consumer, fresh)
  must(
    first.status === 0 && first.out.includes('durablerun schema 5 is ready'),
    `the example's migrate script on a new file exited ${first.status}: ${first.out}`,
  )
  await cli(fresh, ['migrate', '--yes', '--target', fresh])
  const before = await dumpOf(fresh)
  const second = exampleMigrate(consumer, fresh)
  const managed = `durablerun schema ${CURRENT_SCHEMA_VERSION} is managed by the durablerun CLI`
  must(
    second.status === 0 && second.out.includes(managed),
    `the example's migrate script on a database the CLI migrated exited ${second.status}: ${second.out}`,
  )
  must(
    dumpDifferences(before, await dumpOf(fresh)).length === 0,
    "the example's migrate script changed a database the CLI migrated",
  )
  const doctor = await cli(fresh, ['doctor', '--queue', QUEUE])
  must(
    doctor.recordedSchemaVersion === CURRENT_SCHEMA_VERSION,
    `the example's migrate script left version ${String(doctor.recordedSchemaVersion)}`,
  )
  const executor = store.LibsqlExecutor.open(`file:${fresh}`)
  try {
    const refused = await new store.LibsqlStoreAdmin(executor).migrate().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    )
    must(
      refused === 'SchemaMismatchError',
      `alpha.1's own migrate() on a database the CLI migrated must refuse it, and it answered ${String(refused)}`,
    )
  } finally {
    executor.close()
  }
  return `the example's migrate script migrated a new file to version 5 and left the same file alone at version ${CURRENT_SCHEMA_VERSION}, where alpha.1's own migrate() refuses it`
}

async function dumpOf(file: string): Promise<ProtocolSnapshot> {
  const db = LibsqlExecutor.open(`file:${file}`)
  try {
    return await snapshot(db)
  } finally {
    db.close()
  }
}

interface AgedRow {
  readonly taskId: string
  readonly taskName: string
}

/** The week. It answers one sentence of what it showed, or throws naming what differed. */
export async function week(consumer: string, dir: string): Promise<string> {
  const startedAtMs = Date.now()
  const { core, sdk, store: alpha1, digest, tasks } = await load(consumer)
  const file = join(dir, 'week.sqlite')
  const executor = alpha1.LibsqlExecutor.open(`file:${file}`)
  const admin = new alpha1.LibsqlStoreAdmin(executor)
  const ids = core.systemIdSource()
  const store = new alpha1.LibsqlSchedulerStore(executor, ids)
  try {
    // The deployed alpha's history: alpha.1 migrated the database, and the CLI then took
    // it to the build's version.
    await admin.migrate()
    await cli(file, ['migrate', '--yes', '--target', file])

    const weekStartMs = startedAtMs - WEEK_STARTS_AGO_MS
    let now = weekStartMs
    const setNow = async (epochMs: number): Promise<void> => {
      now = epochMs
      await admin.setFakeNowEpochMs(now)
    }
    const periodIndex = (): number => Math.floor((now - weekStartMs) / HOUR_MS)

    const awaiting = tasks.taskRegistry.get(tasks.WAIT_FOR_READY_TASK)
    must(awaiting !== undefined, 'the example registers no wait-for-ready task')
    let reads = 0
    const registry = new Map<string, Handler>([
      [
        digest.PERIODIC_DIGEST_TASK,
        digest.createPeriodicDigest(async () => {
          reads += 1
          const period = periodIndex()
          if ((PLAN.failing as readonly number[]).includes(period)) {
            throw new Error('github-http-503')
          }
          return {
            commitSha: period.toString(16).padStart(40, '0'),
            committedAt: new Date(weekStartMs + period * HOUR_MS).toISOString(),
          }
        }),
      ],
      [tasks.WAIT_FOR_READY_TASK, awaiting],
    ])
    const clock = {
      nowEpochMs: () => now,
      elapsedMs: () => now,
      yieldTurn: async () => {},
      sleep: async (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        }),
    }

    /** Tasks whose next claim is a launch that is lost, and tasks whose worker dies once it started. */
    const lost = new Set<string>()
    const dying = new Set<string>()
    const outcomes = new Map<string, number>()
    /** One pass of alpha.1's worker: claim what is due, and run each claimed run. */
    const pass = async (): Promise<void> => {
      for (;;) {
        const claimed = await store.claim(QUEUE, ids.token(), { leaseSeconds: 30, limit: 10 })
        if (claimed.length === 0) return
        for (const run of claimed) {
          if (lost.delete(run.taskId)) continue
          if (dying.delete(run.taskId)) {
            await store.activate(QUEUE, run.runId, run.claimToken, run.claimGen)
            continue
          }
          const outcome = await sdk.runClaimedRun(
            { store, clock, registry },
            { queue: QUEUE, ...run },
          )
          outcomes.set(outcome.kind, (outcomes.get(outcome.kind) ?? 0) + 1)
        }
      }
    }

    const target = ['--queue', QUEUE, '--target', file]
    const enqueued = (taskName: string, key: string, params: unknown) =>
      cli(file, ['enqueue', taskName, '--key', key, '--params', JSON.stringify(params), ...target])
    const enqueue = async (taskName: string, key: string, params: unknown): Promise<string> => {
      const answer = await enqueued(taskName, key, params)
      must(answer.created === true, `enqueue under ${key} created nothing`)
      return String(answer.taskId)
    }

    const digests: { taskId: string; key: string; period: number }[] = []
    const planted = { unregistered: '', awaitNobodyEmits: '', awaitEmitted: '', deadline: '' }
    const swept = new Map<string, number>()
    const explained: string[] = []

    /**
     * The rows of each injected task's unit, table by table, as the model of retention
     * counts a unit: when the task was enqueued, and the most it held at the end of any
     * period after, up to and past the operator's cancel.
     */
    const injected = new Map<string, { enqueued: WeekRows; most: WeekRows }>()
    const unitRows = async (taskId: string): Promise<WeekRows> =>
      purgeOracle(await dumpOf(file), now, QUEUE, { taskId }, WINDOWS).rows
    const inject = async (taskId: string): Promise<void> => {
      const enqueued = await unitRows(taskId)
      injected.set(taskId, { enqueued, most: enqueued })
    }
    const measureTheInjected = async (): Promise<void> => {
      for (const [taskId, rows] of injected) {
        const held = await unitRows(taskId)
        rows.most = Object.fromEntries(
          QUEUE_TABLES.map((table) => [table, Math.max(rows.most[table], held[table])]),
        ) as WeekRows
      }
    }

    for (let period = 0; period < WEEK_PERIODS; period++) {
      const startMs = weekStartMs + period * HOUR_MS
      await setNow(startMs)
      if (period === PLAN.unregistered) {
        planted.unregistered = await enqueue('not-deployed-yet', 'planted-unregistered', null)
        await inject(planted.unregistered)
      }
      if (period === PLAN.awaitNobodyEmits) {
        planted.awaitNobodyEmits = await enqueue(tasks.WAIT_FOR_READY_TASK, 'planted-await', {
          eventName: 'approval-nobody-gives',
        })
        await inject(planted.awaitNobodyEmits)
      }
      if (period === PLAN.awaitEmitted) {
        planted.awaitEmitted = await enqueue(tasks.WAIT_FOR_READY_TASK, 'awaits-ready', {
          eventName: 'ready',
        })
      }
      if (period === PLAN.awaitEmitted + 2) {
        const emitted = await cli(file, [
          'emit',
          'ready',
          '--payload',
          JSON.stringify({ answer: 42 }),
          '--yes',
          ...target,
        ])
        must(
          emitted.outcome === 'created' && emitted.waitersBefore === 1,
          `emit did not wake the one run alpha.1 parked: ${JSON.stringify(emitted)}`,
        )
      }
      if (period === PLAN.deadline) {
        // alpha.1's own spawn: the CLI's enqueue names no cancellation policy.
        const spawned = await store.spawn(
          QUEUE,
          tasks.WAIT_FOR_READY_TASK,
          JSON.stringify({ eventName: 'approval-under-a-deadline' }),
          { idempotencyKey: 'planted-deadline', cancellation: { maxDurationSeconds: 1800 } },
        )
        planted.deadline = spawned.taskId
      }

      const key = digestKey(digestPeriod(startMs))
      const taskId = await enqueue(digest.PERIODIC_DIGEST_TASK, key, DIGEST_PARAMS)
      digests.push({ taskId, key, period })
      if (period === PLAN.lostLaunch) lost.add(taskId)
      if (period === PLAN.workerDies) dying.add(taskId)
      // The enqueue again, as after a lost answer: the key finds the task, and nothing is made.
      if (period % 24 === 0) {
        const again = await enqueued(digest.PERIODIC_DIGEST_TASK, key, DIGEST_PARAMS)
        must(
          again.created === false && again.taskId === taskId && again.taskNameMatches === true,
          `enqueue repeated under ${key} answered ${JSON.stringify(again)}`,
        )
      }

      for (const seconds of PASSES_AT_SECONDS) {
        await setNow(startMs + seconds * 1000)
        if (seconds === 61) {
          const answer = await cli(file, ['sweep', ...target])
          for (const { kind } of answer.transitions as { kind: string }[]) {
            swept.set(kind, (swept.get(kind) ?? 0) + 1)
          }
        }
        await pass()
      }

      if (period === PLAN.operatorLooks) {
        // The operator holds no task id: the planted causes are found by their age.
        const stuck = await cli(file, ['stuck', '--older-than', '1d', '--queue', QUEUE])
        const aged = (stuck.agedLive as { rows: AgedRow[] }).rows
        must(
          JSON.stringify(aged.map((row) => row.taskId)) ===
            JSON.stringify([planted.unregistered, planted.awaitNobodyEmits]),
          `stuck --older-than listed ${JSON.stringify(aged)}, and the planted tasks are ${JSON.stringify(planted)}`,
        )
        const expected: Readonly<Record<string, string>> = {
          [planted.unregistered]: 'never-started-alpha1-form',
          [planted.awaitNobodyEmits]: 'awaiting-an-untimed-event',
        }
        for (const { taskId } of aged) {
          const answer = await cli(file, ['explain', taskId, '--queue', QUEUE])
          must(
            answer.cause === expected[taskId] && answer.verdict === 'waiting',
            `explain named ${String(answer.cause)} (${String(answer.verdict)}) for a planted ${expected[taskId]}`,
          )
          explained.push(String(answer.cause))
          const cancelled = await cli(file, ['cancel', taskId, '--yes', ...target])
          must(cancelled.outcome === 'cancelled', `cancel answered ${JSON.stringify(cancelled)}`)
        }
      }
      if (period <= PLAN.operatorLooks) await measureTheInjected()
    }
    // The week receipt's bound allows an injected task the rows it comes to hold after the
    // start sample. That allowance is what this measures, of both kinds of injected task:
    // table by table, the most either held beyond what it held when it was enqueued.
    const beyondTheEnqueue = Object.fromEntries(
      QUEUE_TABLES.map((table) => [
        table,
        Math.max(...[...injected.values()].map((rows) => rows.most[table] - rows.enqueued[table])),
      ]),
    )
    must(
      injected.size === 2 && isDeepStrictEqual(beyondTheEnqueue, { ...WEEK_INJECTED_UNIT_ROWS }),
      `the injected tasks came to hold ${JSON.stringify(beyondTheEnqueue)} beyond their rows when enqueued, and the week receipt allows ${JSON.stringify(WEEK_INJECTED_UNIT_ROWS)}`,
    )

    // What alpha.1 made of the week, read through alpha.1's own getTaskResult and through
    // the CLI's result: every digest the CLI enqueued ended as the plan says.
    await setNow(weekStartMs + WEEK_PERIODS * HOUR_MS)
    for (const { taskId, period } of digests) {
      const theirs = await store.getTaskResult(QUEUE, taskId)
      const expected = (PLAN.failing as readonly number[]).includes(period) ? 'failed' : 'completed'
      must(
        theirs?.state === expected,
        `alpha.1 reads the digest of period ${period} as ${theirs?.state}, not ${expected}`,
      )
      const ours = await cli(file, ['result', taskId, '--queue', QUEUE])
      must(ours.state === expected, `result reads the digest of period ${period} as ${ours.state}`)
    }
    const woken = await store.getTaskResult(QUEUE, planted.awaitEmitted)
    must(
      woken?.state === 'completed' &&
        woken.completedPayloadJson ===
          JSON.stringify({ eventName: 'ready', payload: { answer: 42 } }),
      `the task the CLI's emit woke ended as ${JSON.stringify(woken)}`,
    )
    for (const taskId of [planted.unregistered, planted.awaitNobodyEmits, planted.deadline]) {
      const state = (await store.getTaskResult(QUEUE, taskId))?.state
      must(state === 'cancelled', `a cancelled plant reads as ${state} through alpha.1`)
    }
    for (const kind of ['lost-launch', 'claim-timeout', 'cancelled']) {
      must((swept.get(kind) ?? 0) === 1, `the CLI's sweeps made ${swept.get(kind) ?? 0} ${kind}`)
    }
    must(swept.size === 3, `the CLI's sweeps made ${JSON.stringify([...swept])}`)

    // A purge refuses a database whose test clock is set, and changes nothing.
    const windows = ['--completed-after', WINDOW, '--cancelled-after', WINDOW]
    const failedWindow = ['--failed-after', WINDOW]
    const underTheClock = await dumpOf(file)
    const refused = await cli(file, ['purge', ...windows, '--execute', ...target], 2)
    must(
      (refused.error as { kind?: string } | undefined)?.kind === 'fake-clock',
      `purge under the test clock answered ${JSON.stringify(refused)}`,
    )
    must(
      dumpDifferences(underTheClock, await dumpOf(file)).length === 0,
      'a purge that was refused under the test clock changed a row',
    )
    await admin.setFakeNowEpochMs(null)
    must(
      Date.now() - startedAtMs < PURGE_STARTS_WITHIN_MS,
      'the harness ran for longer than its purge windows allow for',
    )

    const keeping = WINDOWS
    const naming: RetentionPolicy = { ...keeping, failedSeconds: WINDOW_SECONDS }
    const endedStates = new Set(
      underTheClock.tasks
        .map((row) => String(row.state))
        .filter((state) => ['completed', 'failed', 'cancelled'].includes(state)),
    )
    const purgedStates = new Map<string, number>()
    const purgedKeys = new Set<string>()
    const digestKeys = new Set(digests.map(({ key }) => sha256(key)))
    let boundedUnits = 0
    let mostRuns = 0
    let commands = 0
    /** One purge command, held to the model over a dump taken before it and after it. */
    const purge = async (
      name: string,
      flags: readonly string[],
      policy: RetentionPolicy,
      limit: number | null,
    ): Promise<PurgeAnswer> => {
      commands += 1
      const before = await dumpOf(file)
      const doctor = await cli(file, ['doctor', '--queue', QUEUE])
      const nowMs = Number(doctor.databaseNowEpochMs)
      const answer = (await cli(file, ['purge', ...flags, ...target])) as PurgeAnswer
      const after = await dumpOf(file)
      const model = againstTheModel(QUEUE, before, after, nowMs, { policy, limit }, answer)
      const differed = [
        ...modelDifferences(model),
        ...(answer.finished === true ? [] : ['the run did not finish']),
        ...((answer.gone ?? []).length === 0 ? [] : ['a unit was gone']),
      ]
      must(
        differed.length === 0,
        `${name}: alpha.1's rows and the purge differ: ${differed.slice(0, 5).join('; ')}`,
      )
      // The week receipt's checker reads the report as alpha.1's rows made the verb print it.
      const read = readPurge(answer, QUEUE)
      must(
        read !== null &&
          read.taken.length === (answer.purged ?? answer.wouldPurge ?? []).length &&
          read.finished,
        `${name}: the week receipt's reader does not read the report`,
      )
      for (const unit of answer.purged ?? []) {
        const key = String((unit as { idempotencyKeySha256?: unknown }).idempotencyKeySha256)
        purgedStates.set(unit.state, (purgedStates.get(unit.state) ?? 0) + 1)
        purgedKeys.add(key)
        // The receipt's bound allows each digest unit these rows, and of runs the ones its
        // purge report shows: no unit alpha.1 wrote holds more of any other table, and the
        // reader reads the runs the verb printed.
        if (!digestKeys.has(key)) continue
        const rows = (unit as { rows?: Record<string, number> }).rows ?? {}
        for (const table of QUEUE_TABLES) {
          must(
            table === 'runs' || Number(rows[table]) <= WEEK_DIGEST_UNIT_ROWS[table],
            `${name}: a ${unit.state} digest unit held ${rows[table]} rows of ${table}, and the week receipt's bound allows ${WEEK_DIGEST_UNIT_ROWS[table]}`,
          )
        }
        const runs = read.taken.find((taken) => taken.keySha256 === key)?.runs
        must(
          runs === rows.runs && Number(runs) >= 1,
          `${name}: the week receipt's reader read ${runs} runs of a unit that held ${rows.runs}`,
        )
        mostRuns = Math.max(mostRuns, Number(runs))
        boundedUnits++
      }
      return answer
    }

    // A dry run under a failed window lists every unit a purge would take, and writes nothing.
    const dryRun = await purge(
      'the dry run',
      [...windows, ...failedWindow, '--limit', '1000'],
      naming,
      null,
    )
    const wouldPurge = idsOf(dryRun.wouldPurge)
    must(wouldPurge.length > 0 && (dryRun.purged ?? []).length === 0, 'the dry run lists nothing')
    // The same command line, fifty units at a time, until it says no more remain: first
    // keeping failed tasks, as the maintainer's policy does, and then naming every state.
    for (const [name, flags, policy] of [
      ['a purge that keeps failed tasks', windows, keeping],
      ['a purge of every state', [...windows, ...failedWindow], naming],
    ] as const) {
      for (let runs = 1; ; runs++) {
        const answer = await purge(name, [...flags, '--limit', '50', '--execute'], policy, 50)
        if (answer.more === false) break
        must(runs < 20, `${name} did not end in ${runs} runs`)
      }
      const again = await purge(`${name}, repeated`, [...flags, '--execute'], policy, 100)
      must((again.purged ?? []).length === 0, `${name}, repeated at once, purged more`)
    }

    const purged = [...purgedStates.values()].reduce((sum, count) => sum + count, 0)
    must(purged > 0, 'the purged set is empty')
    must(
      boundedUnits === PERIODS_PURGED,
      `${boundedUnits} purged digest units were held to the receipt's rows`,
    )
    // A unit tried again holds a run for each attempt, which the receipt's bound allows
    // only where a report shows it: the week has such a unit.
    must(mostRuns > 1, 'no purged digest unit held more than one run')
    must(
      JSON.stringify([...endedStates].sort()) ===
        JSON.stringify(['cancelled', 'completed', 'failed']),
      `the week reached the terminal states ${[...endedStates].join(', ')}`,
    )
    for (const state of endedStates) {
      must((purgedStates.get(state) ?? 0) > 0, `the purged set holds no ${state} unit`)
    }
    // What the dry run listed is what the purges took, and no more.
    must(
      purged === wouldPurge.length,
      `${purged} units went, and the dry run listed ${wouldPurge.length}`,
    )
    // The first five days of periods went, by the sha256 of each period's key, and the
    // younger ones stand and are still found by their keys.
    const gone = digests.filter(({ key }) => purgedKeys.has(sha256(key)))
    const standing = digests.filter(({ key }) => !purgedKeys.has(sha256(key)))
    must(
      gone.length === PERIODS_PURGED && gone.every(({ period }) => period < PERIODS_PURGED),
      `${gone.length} periods went, and the windows cut after period ${PERIODS_PURGED - 1}`,
    )
    for (const { taskId, key } of [gone[0], standing[0]].filter((entry) => entry !== undefined)) {
      const found = purgedKeys.has(sha256(key)) ? 8 : 0
      const read = await cli(file, ['inspect', '--key', key, '--queue', QUEUE], found)
      must(found === 8 || read.taskId === taskId, `inspect --key found another task for ${key}`)
      must(
        ((await store.getTaskResult(QUEUE, taskId)) === null) === (found === 8),
        `alpha.1 and the purge differ on whether the task of ${key} is there`,
      )
    }
    // A purged period's key is free: enqueued again it is a new task, which alpha.1 claims
    // and runs to its sleep.
    const first = digests[0]
    must(first !== undefined, 'the week enqueued no digest')
    const fresh = await enqueue(digest.PERIODIC_DIGEST_TASK, first.key, DIGEST_PARAMS)
    must(fresh !== first.taskId, 'a purged key found its old task')
    await pass()
    must(
      (await store.getTaskResult(QUEUE, fresh))?.state === 'sleeping',
      'alpha.1 did not run a task enqueued after the purge',
    )

    // The self-test passes on a queue of its own in the database alpha.1 wrote in, as an
    // operator runs it on a snapshot before a first purge.
    const selftest = await cli(file, ['selftest', '--queue', 'selftest', '--target', file])
    must(readSelftest(selftest), 'selftest did not pass on the database of the week')

    const states = [...purgedStates].map(([state, count]) => `${count} ${state}`).join(', ')
    return `over ${WEEK_PERIODS} hourly periods alpha.1 ran the example's periodic-digest and wait-for-ready on a database the CLI migrated to version ${CURRENT_SCHEMA_VERSION} (${reads} reads, ${[...outcomes].map(([kind, count]) => `${count} ${kind}`).join(', ')}), the CLI's sweeps made one lost-launch, one claim-timeout and one cancellation, explain named ${explained.join(' and ')} on rows alpha.1 wrote, and ${commands} purge commands took ${purged} units (${states}) that the model lets go, none holding more rows than the week receipt allows a unit but the runs of its attempts (at most ${mostRuns}), and left ${standing.length} periods standing, and selftest passed there on a queue of its own`
  } finally {
    executor.close()
  }
}
