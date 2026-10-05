import { systemClock } from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import type { TaskHandler, TaskRegistry } from '@durablerun/sdk'
import { describe, expect, it } from 'vitest'
import { asleep, fixture } from './explain-seeds.js'
import { TICK_TOKEN, onDeployment } from './hosted.js'
import { deferralTick } from './queue-seeds.js'
import {
  type CliDb,
  type CliRun,
  NOW_MS,
  QUEUE,
  SELECTED,
  claimActivated,
  runCli,
} from './support.js'

/**
 * Exit test line 39: the operator drill. Causes are planted in one queue, each written
 * down before the CLI runs. Then a script that holds only a way to run the CLI and the
 * URL of the store finds each one without being handed a task id, and clears what the CLI
 * says is stuck by running the command the CLI suggests. The deployment is the driver
 * package's hosted router behind a listener on the loopback address.
 */

/** One answer of `explain`, as the script keeps it. */
interface Finding {
  readonly cause: string
  readonly verdict: string
  readonly next: readonly string[] | null
}

interface Drilled {
  /** Every task the script found, by its id, as `explain` first named it. */
  readonly found: ReadonlyMap<string, Finding>
  /** Every command the script ran to clear or to cancel, with its exit and what it printed. */
  readonly ran: readonly { readonly argv: readonly string[]; readonly run: CliRun }[]
  /** Every task again, after the script was done. */
  readonly after: ReadonlyMap<string, Finding>
  /** The tasks `stuck` lists after the script was done. */
  readonly stillListed: ReadonlySet<string>
}

/** The causes the script cancels as the human would: a run that waits on what will not come. */
const A_HUMAN_CANCELS = ['never-started', 'awaiting-an-untimed-event']

/**
 * The script. It holds `cli`, which runs one command line, and the URL of the store, from
 * which it names the store again for a write of its own. It is handed no task id: it asks
 * `stuck` what the queue holds that is owed a move or is old, asks `explain` about each
 * task listed, and runs what `explain` suggests for a verdict of `stuck`, with `--yes`
 * where the CLI's own `help --json` says the command takes it. `olderThan` is the age it asks
 * `stuck` to list live tasks from, or null to ask for the owed moves alone.
 */
async function drill(
  cli: (argv: readonly string[]) => Promise<CliRun>,
  storeUrl: string,
  olderThan: string | null = '2m',
): Promise<Drilled> {
  const target = storeUrl.startsWith('file:')
    ? storeUrl.slice('file:'.length)
    : new URL(storeUrl).host
  const listed = async (): Promise<Set<string>> => {
    const run = await cli([
      'stuck',
      '--queue',
      QUEUE,
      ...(olderThan === null ? [] : ['--older-than', olderThan]),
      '--json',
    ])
    // Every list of the report, whatever it is named: a list holds rows, and a row names its task.
    const ids = new Set<string>()
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const { rows } = value as { rows?: unknown }
      if (Array.isArray(rows)) {
        for (const row of rows as { taskId?: unknown }[]) {
          if (typeof row.taskId === 'string') ids.add(row.taskId)
        }
      }
      for (const inner of Object.values(value)) walk(inner)
    }
    walk(JSON.parse(run.stdout))
    return ids
  }
  const explained = async (taskId: string): Promise<Finding> => {
    const run = await cli(['explain', taskId, '--queue', QUEUE, '--json'])
    const answer = JSON.parse(run.stdout) as {
      cause: string
      verdict: string
      next: { argv: string[] } | null
    }
    return { cause: answer.cause, verdict: answer.verdict, next: answer.next?.argv ?? null }
  }
  // Which commands take --yes, as the CLI itself prints its table.
  const help = JSON.parse((await cli(['help', '--json'])).stdout) as {
    commands: { name: string; flags: Record<string, unknown> }[]
  }
  const confirmed = new Set(
    help.commands.filter((command) => Object.hasOwn(command.flags, 'yes')).map(({ name }) => name),
  )
  const found = new Map<string, Finding>()
  for (const taskId of await listed()) found.set(taskId, await explained(taskId))
  const ran: { argv: readonly string[]; run: CliRun }[] = []
  for (const [taskId, first] of found) {
    if (first.verdict !== 'stuck') continue
    // A command run for an earlier task may have cleared this one too.
    const now = await explained(taskId)
    if (now.verdict !== 'stuck' || now.next === null) continue
    const [verb] = now.next
    const argv = [...now.next, ...(confirmed.has(verb ?? '') ? ['--yes'] : []), '--json']
    ran.push({ argv, run: await cli(argv) })
  }
  for (const [taskId, first] of found) {
    if (!A_HUMAN_CANCELS.includes(first.cause)) continue
    const argv = ['cancel', taskId, '--queue', QUEUE, '--target', target, '--yes', '--json']
    ran.push({ argv, run: await cli(argv) })
  }
  const after = new Map<string, Finding>()
  for (const taskId of found.keys()) after.set(taskId, await explained(taskId))
  return { found, ran, after, stillListed: await listed() }
}

/** What the builder wrote down of one planted task before the CLI ran. */
interface Planted {
  readonly cause: string
  readonly verdict: string
  /** The cause `explain` names once the script is done. */
  readonly after: string
}

/**
 * The planted causes and the healthy controls, written down before the CLI runs: what
 * `explain` names each, and what it names each once the script is done.
 */
const WRITTEN_DOWN = {
  // Stuck, and cleared by the `sweep` the CLI suggests.
  // The sweep takes the run back, and the engine holds it for the backoff after a lease that
  // ran out before it is due again.
  leaseLapsed: { cause: 'lease-lapsed-unswept', verdict: 'stuck', after: 'pending-delayed' },
  cancellationOverdue: {
    cause: 'cancellation-deadline-passed',
    verdict: 'stuck',
    after: 'cancelled',
  },
  // Stuck, and cleared by the `tick --url` the CLI suggests, which the router runs.
  dueUnclaimed: { cause: 'pending-due-unclaimed', verdict: 'stuck', after: 'completed' },
  // Waiting on what will not come. The script cancels each, as the human would.
  neverStarted: { cause: 'never-started', verdict: 'waiting', after: 'cancelled' },
  untimedAwait: { cause: 'awaiting-an-untimed-event', verdict: 'waiting', after: 'cancelled' },
  // A row the engine does not take: no sweep and no tick moves it, and it stays as it is.
  notTaken: {
    cause: 'due-run-no-claim-admits',
    verdict: 'inconsistent',
    after: 'due-run-no-claim-admits',
  },
  // The healthy controls the script finds, by their age, and leaves alone.
  asleep: { cause: 'sleeping-on-a-timer', verdict: 'waiting', after: 'sleeping-on-a-timer' },
  running: {
    cause: 'running-under-a-live-lease',
    verdict: 'ok',
    after: 'running-under-a-live-lease',
  },
} as const satisfies Record<string, Planted>
type PlantedName = keyof typeof WRITTEN_DOWN

/**
 * Two more healthy controls, which no list of `stuck` holds: a task that completed is not
 * live, and a task whose start is an hour off is owed nothing and has no age yet.
 */
type NotListed = 'completed' | 'delayed'

/** The handlers the deployment has. It has none for the task name `unhandled`. */
const REGISTRY: TaskRegistry = new Map<string, TaskHandler>([
  ['job', async () => 'done'],
  ['waiter', async (ctx) => ctx.awaitEvent('approval')],
])

/** The instant the script runs at: every planted move is owed by more than the grace. */
const DRILL_AT_MS = NOW_MS + 300_000

/**
 * Plant every cause and every control, each task by the name it is written down under. The
 * engine's ports and a real worker write every state but one: the row no claim admits is
 * fixture-built, because no engine path leaves one. `tick` runs one pass of
 * the deployment, whose worker is the SDK's own.
 */
async function plant(
  db: CliDb,
  tick: () => Promise<CliRun>,
): Promise<Record<PlantedName | NotListed, string>> {
  const { store } = db
  // The deployment's worker runs a handler that awaits an event nobody emits, with no timeout.
  const untimedAwait = await store.spawn(QUEUE, 'waiter', '{}')
  expect((await tick()).exit).toBe(0)
  const completed = await store.spawn(QUEUE, 'job', '{}')
  expect((await tick()).exit).toBe(0)
  const sleeper = await asleep(db, 3600)
  const running = await store.spawn(QUEUE, 'job', '{}')
  await claimActivated(db, 'w-running', running.taskId, QUEUE, 3600)
  // A worker started this run under a lease of a minute and was never heard from again.
  const leaseLapsed = await store.spawn(QUEUE, 'job', '{}')
  await claimActivated(db, 'w-gone', leaseLapsed.taskId)
  const delayed = await store.spawn(QUEUE, 'job', '{}', { startDelaySeconds: 3600 })
  const cancellationOverdue = await store.spawn(QUEUE, 'job', '{}', {
    cancellation: { maxDelaySeconds: 45 },
  })
  // Fixture-built: a due run whose task's retry strategy is not JSON, which no claim admits.
  const notTaken = await store.spawn(QUEUE, 'job', '{}')
  await fixture(db, "UPDATE tasks SET retry_strategy = 'not json' WHERE task_id = ?", [
    notTaken.taskId,
  ])
  // 130 seconds before the script runs, a real worker that has no handler for the task
  // claims it and parks it again, 15 to 24 seconds on. So when the script runs, its wake
  // is past by less than the grace of 120 seconds, and no owed move lists it.
  await db.admin.setFakeNowEpochMs(DRILL_AT_MS - 130_000)
  const neverStarted = await store.spawn(QUEUE, 'unhandled', '{}')
  await deferralTick(db, 'current', neverStarted.taskId, 1)
  // Enqueued five seconds more than the grace before the script runs, and never claimed.
  await db.admin.setFakeNowEpochMs(DRILL_AT_MS - 125_000)
  const dueUnclaimed = await store.spawn(QUEUE, 'job', '{}')
  await db.admin.setFakeNowEpochMs(DRILL_AT_MS)
  return {
    untimedAwait: untimedAwait.taskId,
    completed: completed.taskId,
    asleep: sleeper,
    running: running.taskId,
    leaseLapsed: leaseLapsed.taskId,
    delayed: delayed.taskId,
    cancellationOverdue: cancellationOverdue.taskId,
    notTaken: notTaken.taskId,
    neverStarted: neverStarted.taskId,
    dueUnclaimed: dueUnclaimed.taskId,
  }
}

/** A planted queue, the deployment over it, and the one thing the script holds: a way to run the CLI. */
async function onAPlantedQueue<T>(
  dialect: (typeof SELECTED)[number],
  name: string,
  body: (
    planted: Record<PlantedName | NotListed, string>,
    cli: (argv: readonly string[]) => Promise<CliRun>,
    db: CliDb,
  ) => Promise<T>,
): Promise<T> {
  return onDeployment(dialect, name, REGISTRY, async (db, deployment) => {
    const env = {
      ...db.env,
      DURABLERUN_BASE_URL: deployment.url,
      DURABLERUN_TICK_TOKEN: TICK_TOKEN,
    }
    // Every command is a process of its own, and no two mint the same id.
    const ids = testIdSource(`${name}-cli`)
    const clock = systemClock()
    const cli = (argv: readonly string[]) => runCli(argv, env, undefined, ids, clock)
    const planted = await plant(db, () => cli(['tick', '--url', deployment.url, '--json']))
    return body(planted, cli, db)
  })
}

const PLANTED_NAMES = Object.keys(WRITTEN_DOWN) as PlantedName[]

describe('the operator drill', () => {
  for (const dialect of SELECTED) {
    describe(`[${dialect}]`, () => {
      it(
        'finds each planted cause without a task id, clears what is stuck by the command explain suggests, and cancels what waits on nothing',
        () =>
          onAPlantedQueue(dialect, 'drill', async (planted, cli, db) => {
            const drilled = await drill(cli, db.url)
            // Found, and named the cause written down before the CLI ran.
            const named = (taskId: string, from: ReadonlyMap<string, Finding>) => {
              const finding = from.get(taskId)
              return finding === undefined
                ? 'not found'
                : { cause: finding.cause, verdict: finding.verdict }
            }
            for (const name of PLANTED_NAMES) {
              const { cause, verdict } = WRITTEN_DOWN[name]
              expect(
                { planted: name, found: named(planted[name], drilled.found) },
                'mutation-verdict:behavior:cli-drill-finds-each-planted-cause-without-an-id',
              ).toEqual({ planted: name, found: { cause, verdict } })
            }
            // The two controls no list holds were not found, so nothing was run for them.
            expect([
              named(planted.completed, drilled.found),
              named(planted.delayed, drilled.found),
            ]).toEqual(['not found', 'not found'])
            // Each command the script ran is one the command table parses, and it ran.
            expect(
              drilled.ran.map(({ argv, run }) => ({
                ran: argv.join(' '),
                exit: run.exit,
              })),
              'mutation-verdict:behavior:cli-drill-runs-each-suggestion-as-it-is-printed',
            ).toEqual(drilled.ran.map(({ argv }) => ({ ran: argv.join(' '), exit: 0 })))
            // Each moved to what was written down: a terminal state or a healthy verdict.
            for (const name of PLANTED_NAMES) {
              const finding = drilled.after.get(planted[name])
              expect(
                { planted: name, after: finding?.cause, stuck: finding?.verdict === 'stuck' },
                'mutation-verdict:behavior:cli-drill-clears-what-is-stuck',
              ).toEqual({ planted: name, after: WRITTEN_DOWN[name].after, stuck: false })
            }
            // One sweep cleared both of its causes, one tick the third, and the two cancels
            // are the script's own. Nothing else was run.
            expect(drilled.ran.map(({ argv }) => argv[0]).sort()).toEqual([
              'cancel',
              'cancel',
              'sweep',
              'tick',
            ])
            // No suggestion confirmed a write: the script added --yes itself, where the CLI's own help has it.
            for (const { argv } of drilled.ran) {
              expect([argv[0], argv.includes('--yes')]).toEqual([argv[0], argv[0] === 'cancel'])
            }
            // The row the engine does not take: a sweep and a tick ran, and it is listed still.
            expect(
              {
                cause: drilled.after.get(planted.notTaken)?.cause,
                listed: drilled.stillListed.has(planted.notTaken),
              },
              'the row no claim admits, after a sweep and a tick',
            ).toEqual({ cause: 'due-run-no-claim-admits', listed: true })
            // What was cancelled or completed is in no list any more.
            for (const name of [
              'cancellationOverdue',
              'dueUnclaimed',
              'neverStarted',
              'untimedAwait',
            ] as const) {
              expect([name, drilled.stillListed.has(planted[name])]).toEqual([name, false])
            }
          }),
        120_000,
      )

      it(
        'finds neither the run that never started nor the untimed await without the leg of aged live tasks',
        () =>
          onAPlantedQueue(dialect, 'drill-no-age', async (planted, cli, db) => {
            // The control of the case above: the same queue, asked for the owed moves alone.
            const drilled = await drill(cli, db.url, null)
            const found = (name: PlantedName) => drilled.found.has(planted[name])
            expect({
              neverStarted: found('neverStarted'),
              untimedAwait: found('untimedAwait'),
              leaseLapsed: found('leaseLapsed'),
              cancellationOverdue: found('cancellationOverdue'),
              dueUnclaimed: found('dueUnclaimed'),
            }).toEqual({
              neverStarted: false,
              untimedAwait: false,
              leaseLapsed: true,
              cancellationOverdue: true,
              dueUnclaimed: true,
            })
          }),
        120_000,
      )
    })
  }
})
