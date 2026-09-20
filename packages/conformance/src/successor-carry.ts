import {
  INFRA_RETRY_CAP,
  RELAUNCH_CAP,
  SAGA_STARTED_PREFIX,
  SUCCESSOR_CARRIED_RUN_COLUMNS,
  type SchedulerStore,
  type SqlExecutor,
  type SqlRow,
  parseFenceStamp,
} from '@durablerun/core'
import type { StoreFixture } from './fixture.js'
import { triesOf } from './sagas.js'
import { checkpointOwned, claimActivated, claimOne, infraRetrySeed } from './scenario.js'
import {
  CORPUS_VARIANT_NAMERS,
  insertsARun,
  readCorpus,
  readCorpusDescriptor,
  signatureOf,
} from './sql-corpus.js'

/**
 * Generated successor-carry surface.
 *
 * A run that follows another run of its task carries that run's parked wake and its run
 * database (`SUCCESSOR_CARRIED_RUN_COLUMNS`, DESIGN.md §3.8). Every insert of a run is
 * built from one record in core, and a store decides which run an insert reads, so a new
 * batch that inserts a run can carry nothing and compile. A revival once did.
 *
 * So the cases are generated. The SQL corpus holds every statement a label compiles to,
 * and each one that inserts a run is a case nobody lists: some scenario must make that
 * very statement insert a run, and the run must carry what the run before it held. A run
 * with no run before it, a task's first, must carry nothing. A label the corpus gives a
 * run insert and no scenario drives fails, and so does an insert no scenario reaches.
 */

/** One statement of the corpus that inserts a run: a variant of a label, and its place in it. */
export interface RunInsert {
  readonly label: string
  readonly variant: string
  readonly index: number
}

/** Every statement of `dialect`'s corpus that inserts a run. */
export function runInsertsOf(dialect: string): RunInsert[] {
  return Object.entries(readCorpus(dialect)).flatMap(([label, variants]) =>
    Object.entries(variants).flatMap(([variant, signature]) =>
      signature.flatMap(({ sql }, index) => (insertsARun(sql) ? [{ label, variant, index }] : [])),
    ),
  )
}

/** The labels of `dialect`'s corpus that insert a run, each once, in corpus order. */
export const labelsThatInsertARun = (dialect: string): string[] => [
  ...new Set(runInsertsOf(dialect).map(({ label }) => label)),
]

type CarriedColumn = (typeof SUCCESSOR_CARRIED_RUN_COLUMNS)[number]

/** What every parent run is parked with. The type asks a new carried column for its value. */
const CARRIED: Readonly<Record<CarriedColumn, string>> = {
  wake_event: 'e-carry',
  event_payload: '{"x":1}',
  wake_step: 'carry-step',
  run_db: 'carry-db',
}

/**
 * Every other column of a run. A new run sets each of these for itself, `created_at_ms`
 * included, which it sets to the instant of the row its batch stamped. A column that is
 * in neither list fails every case, so a new runs column is classified when it arrives.
 */
const SUCCESSOR_OWNED_RUN_COLUMNS = [
  'run_id',
  'queue',
  'task_id',
  'attempt',
  'state',
  'claimed_by',
  'claim_gen',
  'activated_gen',
  'relaunch_count',
  'lease_ms',
  'claim_expires_at_ms',
  'heartbeat_at_ms',
  'available_at_ms',
  'started_at_ms',
  'completed_at_ms',
  'failed_at_ms',
  'result',
  'failure_reason',
  'created_at_ms',
  'fence_stamp',
  'fence_at_ms',
] as const

/** What a scenario acts through: a store whose batches are witnessed, and the rows beneath it. */
interface CarryWorld {
  readonly store: SchedulerStore
  readonly raw: SqlExecutor
  /** A queue of the scenario's own, so no scenario claims or sweeps another's run. */
  readonly queue: string
  /** Parks the carried values on a run, which makes it a parent whose successor is judged. */
  park(runId: string): Promise<void>
  /** A registered step of the run's task starts, under the run's own claim. */
  startStep(run: { taskId: string; runId: string; claimToken: string }): Promise<unknown>
  /** Moves the fake clock past a sixty second lease. */
  expireLeases(): Promise<void>
}

type Scenario = (world: CarryWorld) => Promise<void>

const BOOM = '{"name":"Boom"}'

/** Spawns a task, claims and activates its run, and parks the carried values on it. */
async function parkedRun(world: CarryWorld, token: string, maxAttempts?: number) {
  await world.store.spawn(world.queue, 'job', '{}', maxAttempts ? { maxAttempts } : undefined)
  const run = await claimActivated(world.store, world.queue, token)
  await world.park(run.runId)
  return run
}

/**
 * The scenarios that make each label insert a run, every way it can. A scenario is
 * written by hand, because reaching a batch takes one. Which inserts they must reach
 * between them is read from the corpus, so a missing scenario is a failing case.
 */
const SCENARIOS: Readonly<Record<string, readonly Scenario[]>> = {
  spawn: [
    async ({ store, queue }) => {
      await store.spawn(queue, 'job', '{}')
    },
    async (world) => {
      const parent = await parkedRun(world, 'w-parent')
      await world.store.spawn(world.queue, 'child', '{}', {
        childOf: {
          parentQueue: world.queue,
          parentTaskId: parent.taskId,
          runId: parent.runId,
          claimToken: parent.claimToken,
          replayKey: 'child#1',
        },
      })
    },
  ],
  fail: [
    // A retry with budget left is a successor run.
    async (world) => {
      const run = await parkedRun(world, 'w-retry', 2)
      await world.store.fail(world.queue, run.runId, run.claimToken, BOOM, { delaySeconds: 30 })
    },
    // A retry the budget refuses, and a failure no retry follows, are each the task's
    // terminal decision, which a started step turns into a rollback pass.
    async (world) => {
      const run = await parkedRun(world, 'w-spent', 1)
      await world.startStep(run)
      await world.store.fail(world.queue, run.runId, run.claimToken, BOOM, { delaySeconds: 0 })
    },
    async (world) => {
      const run = await parkedRun(world, 'w-final')
      await world.startStep(run)
      await world.store.fail(world.queue, run.runId, run.claimToken, BOOM, null)
    },
  ],
  'fail-rollback': [
    // A failed rollback with budget left is followed by another pass.
    async (world) => {
      const forward = await parkedRun(world, 'w-forward')
      await world.startStep(forward)
      await world.store.fail(world.queue, forward.runId, forward.claimToken, BOOM, null)
      const pass = await claimActivated(world.store, world.queue, 'w-pass')
      await world.park(pass.runId)
      await world.store.failRollback(
        world.queue,
        pass.runId,
        pass.claimToken,
        BOOM,
        { delaySeconds: 0 },
        triesOf('a', 1),
      )
    },
  ],
  'retry-task': [
    async (world) => {
      const run = await parkedRun(world, 'w-revived')
      await world.store.fail(world.queue, run.runId, run.claimToken, BOOM, null)
      await world.store.retryTask(world.queue, run.taskId)
    },
  ],
  'sweep:lost-launch': [
    // A launch lost at the relaunch cap is a terminal decision, so a started step gets a pass.
    async (world) => {
      await world.store.spawn(world.queue, 'job', '{}')
      const claimed = await claimOne(world.store, world.queue, 'w-unlaunched')
      await world.startStep(claimed)
      await world.raw.batch(
        'carry:relaunch-cap',
        [
          {
            sql: `UPDATE runs SET relaunch_count = ? WHERE run_id = ?`,
            args: [RELAUNCH_CAP, claimed.runId],
          },
        ],
        'write',
      )
      await world.park(claimed.runId)
      await world.expireLeases()
      await world.store.sweep(world.queue, 10)
    },
  ],
  'sweep:claim-timeout': [
    async (world) => {
      await parkedRun(world, 'w-abandoned')
      await world.expireLeases()
      await world.store.sweep(world.queue, 10)
    },
    // A claim that times out at the infrastructure cap is a terminal decision too.
    async (world) => {
      const run = await parkedRun(world, 'w-capped')
      await world.raw.batch(
        'carry:infra-cap',
        infraRetrySeed(run.taskId, run.runId, INFRA_RETRY_CAP),
        'write',
      )
      await world.startStep(run)
      await world.expireLeases()
      await world.store.sweep(world.queue, 10)
    },
  ],
}

/**
 * A run some witnessed batch inserted, with the statement that inserted it, and the rows as
 * that batch left them: the run, the run before it if its task has one, and its task. A
 * scenario goes on to park and fail the run, so it is judged as it was inserted.
 */
interface WitnessedInsert extends RunInsert {
  readonly run: SqlRow
  readonly parent: SqlRow | undefined
  readonly task: SqlRow | undefined
}

const addressOf = ({ label, variant, index }: RunInsert): string =>
  `${label}/${variant} statement ${index}`

async function runIdsOf(raw: SqlExecutor): Promise<Set<string>> {
  const [rows] = await raw.batch(
    'carry:runs',
    [{ sql: `SELECT run_id FROM runs`, args: [] }],
    'read',
  )
  return new Set((rows?.rows ?? []).map((row) => String(row.run_id)))
}

/**
 * An executor that records which corpus statement inserted which run. The variant of a
 * batch is named as the corpus names it, from what the batch holds, and the statement is
 * the one that reports a row, so a run is attributed to the statement that wrote it and
 * never to where a scenario expected it.
 */
function witnessing(
  raw: SqlExecutor,
  inserts: readonly RunInsert[],
  witnessed: WitnessedInsert[],
): SqlExecutor {
  const descriptor = readCorpusDescriptor()
  return {
    batch: async (label, statements, control) => {
      // Every batch is watched, and not only the labels the corpus gives a run insert: a
      // batch that inserts a run from a statement the corpus does not hold fails below.
      const ofLabel = inserts.filter((insert) => insert.label === label)
      const before = await runIdsOf(raw)
      const results = await raw.batch(label, statements, control)
      const inserted = [...(await runIdsOf(raw))].filter((runId) => !before.has(runId))
      const variants = descriptor[label] ?? []
      const variant =
        variants.length === 1
          ? variants[0]
          : CORPUS_VARIANT_NAMERS[label]?.(signatureOf(statements))
      // The statement at a corpus address must itself insert a run, so a batch whose order
      // moved is never read at another statement's place.
      const fired = ofLabel.filter(
        (insert) =>
          insert.variant === variant &&
          insertsARun(statements[insert.index]?.sql ?? '') &&
          results[insert.index]?.rowsAffected === 1,
      )
      const [statement, ...others] = fired
      const [runId, ...moreRuns] = inserted
      if (
        others.length > 0 ||
        moreRuns.length > 0 ||
        (statement === undefined) !== (runId === undefined)
      ) {
        throw new Error(
          `${label}/${String(variant)} inserted ${inserted.length} runs from ${fired.length} of its corpus run inserts, and the case reads one from one`,
        )
      }
      if (statement !== undefined && runId !== undefined) {
        const [tasks, runs] = await raw.batch(
          'carry:family',
          [
            {
              sql: `SELECT * FROM tasks WHERE task_id = (SELECT task_id FROM runs WHERE run_id = ?)`,
              args: [runId],
            },
            {
              sql: `SELECT * FROM runs
                    WHERE task_id = (SELECT task_id FROM runs WHERE run_id = ?) ORDER BY attempt`,
              args: [runId],
            },
          ],
          'read',
        )
        const family = runs?.rows ?? []
        const at = family.findIndex((row) => row.run_id === runId)
        const run = family[at]
        if (run === undefined)
          throw new Error(`${addressOf(statement)}: the run it inserted is gone`)
        witnessed.push({
          ...statement,
          run,
          parent: at > 0 ? family[at - 1] : undefined,
          task: tasks?.rows[0],
        })
      }
      return results
    },
  }
}

export interface CarryReport {
  /** Run inserts of the label's corpus that no scenario made insert a run. */
  readonly unreached: string[]
  /** Inherited columns a witnessed run dropped, or that a first run was given. */
  readonly dropped: string[]
  /** A run column that is neither carried nor the run's own, or a creation instant out of place. */
  readonly misplaced: string[]
}

const sameValue = (left: unknown, right: unknown): boolean => String(left) === String(right)

const seedOf = (row: SqlRow | undefined): string | undefined => {
  const stamp = row?.fence_stamp
  const parsed = typeof stamp === 'string' ? parseFenceStamp(stamp) : undefined
  return parsed?.ok ? parsed.seed : undefined
}

/**
 * Runs every scenario of `label` on one fixture, and judges every run a corpus statement
 * inserted on the way, whichever label inserted it.
 */
export async function witnessRunInserts(
  f: StoreFixture,
  dialect: string,
  label: string,
  startMs: number,
): Promise<CarryReport> {
  const inserts = runInsertsOf(dialect)
  const scenarios = SCENARIOS[label]
  if (scenarios === undefined) {
    throw new Error(`'${label}' inserts a run, and no successor-carry scenario drives it`)
  }
  const witnessed: WitnessedInsert[] = []
  const store = f.storeOver(witnessing(f.raw, inserts, witnessed))
  let now = startMs
  for (const [ordinal, scenario] of scenarios.entries()) {
    const queue = `carry-${ordinal}`
    // A carried wake must be legal: the event its payload came from exists.
    await f.raw.batch(
      'carry:event',
      [
        {
          sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms) VALUES (?, ?, ?, ?)`,
          args: [queue, CARRIED.wake_event, CARRIED.event_payload, startMs],
        },
      ],
      'write',
    )
    await scenario({
      store,
      raw: f.raw,
      queue,
      park: async (runId) => {
        await f.raw.batch(
          'carry:park',
          [
            {
              sql: `UPDATE runs
                    SET ${SUCCESSOR_CARRIED_RUN_COLUMNS.map((column) => `${column} = ?`).join(', ')}
                    WHERE run_id = ?`,
              args: [...SUCCESSOR_CARRIED_RUN_COLUMNS.map((column) => CARRIED[column]), runId],
            },
          ],
          'write',
        )
      },
      startStep: (run) => checkpointOwned(store, queue, run, `${SAGA_STARTED_PREFIX}a`, '1', 30),
      expireLeases: async () => {
        now += 61_000
        await f.admin.setFakeNowEpochMs(now)
      },
    })
  }

  const dropped: string[] = []
  const misplaced: string[] = []
  for (const insert of witnessed) {
    const { run, parent, task } = insert
    for (const column of SUCCESSOR_CARRIED_RUN_COLUMNS) {
      if (parent === undefined) {
        if (run[column] !== null)
          dropped.push(`${column} was given to the first run by ${addressOf(insert)}`)
        continue
      }
      if (parent[column] !== CARRIED[column]) {
        throw new Error(
          `${addressOf(insert)}: its scenario left the parent run without a parked ${column}`,
        )
      }
      if (run[column] !== CARRIED[column]) dropped.push(`${column} by ${addressOf(insert)}`)
    }
    const columns = Object.keys(run).sort()
    const classified = [...SUCCESSOR_CARRIED_RUN_COLUMNS, ...SUCCESSOR_OWNED_RUN_COLUMNS].sort()
    if (columns.join() !== classified.join()) {
      misplaced.push(
        `${addressOf(insert)}: runs columns [${columns.join()}] are not the carried and owned [${classified.join()}]`,
      )
    }
    // A run is created at the instant of the row its batch stamped, a run it follows or
    // its task, and never at a second reading of the clock.
    const stamped = [parent, task].find(
      (row) => seedOf(row) !== undefined && seedOf(row) === seedOf(run),
    )
    if (stamped === undefined || !sameValue(run.created_at_ms, stamped.fence_at_ms)) {
      misplaced.push(
        `${addressOf(insert)}: created at ${String(run.created_at_ms)}, not at the instant of the row its batch stamped`,
      )
    }
  }
  const reached = new Set(witnessed.map(addressOf))
  return {
    unreached: inserts
      .filter((insert) => insert.label === label && !reached.has(addressOf(insert)))
      .map(addressOf),
    dropped,
    misplaced,
  }
}
