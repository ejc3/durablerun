import {
  type PurgeCursor,
  type PurgedUnit,
  type RetentionPolicy,
  type SpawnResult,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { engineHistoryViolations } from './engine-history.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { KEEPING_FAILED, SHORTEST_WINDOW_MS } from './retention-policies.js'
import { checkpointOwned, claimActivated, warmConnections, withFixture } from './scenario.js'
import { settle } from './self-concurrency.js'

const Q = 'q'
const START_MS = 1_000_000
const FAILURE = '{"name":"Boom"}'

/** The policy the contest purges under: the shortest windows core takes, and failed tasks kept. */
export const CONTEST_POLICY: RetentionPolicy = KEEPING_FAILED
const WINDOW_MS = SHORTEST_WINDOW_MS

/** How many purgers walk the candidates at once. */
export const CONTEST_PURGERS = 4

/** How many units a round ends under an idempotency key of the caller's, which the spawner then reuses. */
const KEYED_UNITS = 6

/** The most times the spawner goes over the round's keys: a bound, which no round is meant to reach. */
const SPAWNER_PASSES = 200

/** What becomes of a keyed unit, by its place in the round. A failed unit is kept by the policy. */
const ENDINGS = ['completed', 'cancelled', 'failed'] as const
const endingOf = (index: number) => ENDINGS[index % ENDINGS.length] ?? 'completed'

/** What one round of the contest left, each list empty when the round is clean. */
export interface PurgeContestRound {
  readonly round: number
  /** An actor that threw: a purger or the spawner for any reason, the claimer or the sweeper for an outage. */
  readonly failures: readonly string[]
  /** A unit more than one purge answered for. */
  readonly purgedTwice: readonly string[]
  /** A unit a purge answered for whose task row is still there. */
  readonly purgedAndPresent: readonly string[]
  /** A task row that went with no purge answering for it. */
  readonly goneUnpurged: readonly string[]
  /** A run, a checkpoint, a wait, or a completion event whose task row is gone: part of a unit. */
  readonly partUnits: readonly string[]
  readonly violations: readonly string[]
  /** A completed or cancelled task a window old that is still there after a last purger alone. */
  readonly leftBehind: readonly string[]
  /** A spawn under a reused key that answered neither the task holding the key nor a new one. */
  readonly spawnMisanswers: readonly string[]
  /** How many failed keyed units there are, which the policy keeps: every one ever made. */
  readonly failedKept: number
  /** Units purged while every actor ran. */
  readonly purged: number
  /** Units the last purger found still to purge, once the others had stopped. */
  readonly purgedAfterwards: number
  /** Reused keys that made a new task, their old task being purged. */
  readonly created: number
}

export interface PurgeContest {
  readonly rounds: readonly PurgeContestRound[]
  /** How many batches the server chose as deadlock victims over the whole contest. */
  readonly deadlocks: number
}

interface Rows {
  readonly tasks: ReadonlyMap<string, { state: string; stampedAtMs: number; key: string | null }>
  readonly parts: readonly string[]
}

/** Every task of the queue, and every row of another table that names a task. */
async function rowsOf(f: StoreFixture): Promise<Rows> {
  const [tasks, runs, checkpoints, waits, events] = await f.raw.batch(
    'purge-contest:rows',
    [
      { sql: 'SELECT task_id, state, fence_at_ms, idempotency_key FROM tasks', args: [] },
      { sql: 'SELECT run_id, task_id FROM runs', args: [] },
      { sql: 'SELECT task_id, checkpoint_name FROM checkpoints', args: [] },
      { sql: 'SELECT run_id, step_name, task_id FROM waits', args: [] },
      { sql: 'SELECT event_name FROM events', args: [] },
    ],
    'read',
  )
  if (!tasks || !runs || !checkpoints || !waits || !events) {
    throw new Error('purge contest: a read of the rows answered nothing')
  }
  return {
    tasks: new Map(
      tasks.rows.map((row) => [
        String(row.task_id),
        {
          state: String(row.state),
          stampedAtMs: Number(row.fence_at_ms),
          key: row.idempotency_key === null ? null : String(row.idempotency_key),
        },
      ]),
    ),
    parts: [
      ...runs.rows.map((row) => `${row.task_id} run ${row.run_id}`),
      ...checkpoints.rows.map((row) => `${row.task_id} checkpoint ${row.checkpoint_name}`),
      ...waits.rows.map((row) => `${row.task_id} wait ${row.run_id}/${row.step_name}`),
      ...events.rows.flatMap((row) => {
        const taskId = taskIdOfDoneEvent(String(row.event_name))
        return taskId === null ? [] : [`${taskId} event`]
      }),
    ],
  }
}

/** Claim and finish every run that is due, so the next claim of a round takes the task just spawned. */
async function drain(f: StoreFixture, round: number): Promise<void> {
  await f.store.sweep(Q, 100)
  for (let turn = 0; ; turn++) {
    const runs = await f.store.claim(Q, `drain-${round}-${turn}`, { leaseSeconds: 60, limit: 50 })
    if (runs.length === 0) return
    for (const run of runs) {
      if (await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)) {
        await f.store.complete(Q, run.runId, run.claimToken, '"drained"')
      }
    }
  }
}

/** The one due run, which is the run of the task just spawned, claimed and started. */
async function started(f: StoreFixture, taskId: string, worker: string) {
  const run = await claimActivated(f.store, Q, worker)
  if (run.taskId !== taskId) throw new Error(`purge contest: ${worker} claimed ${run.taskId}`)
  return run
}

/**
 * The units of one round, ended now: keyed units that completed, were cancelled, and
 * failed, each completed and failed one with a checkpoint, and a parent with a child, both
 * completed. Beside them, work for the other actors: a run claimed and never started,
 * which the sweeper reopens, a task with a start deadline, which the sweeper cancels, and
 * tasks to claim.
 */
async function arrange(f: StoreFixture, round: number): Promise<Map<string, string>> {
  await drain(f, round)
  const keyed = new Map<string, string>()
  for (let index = 0; index < KEYED_UNITS; index++) {
    const key = `key-${round}-${index}`
    const ending = endingOf(index)
    const task = await f.store.spawn(Q, `unit-${ending}`, '{}', {
      idempotencyKey: key,
      maxAttempts: 1,
    })
    keyed.set(key, task.taskId)
    if (ending === 'cancelled') {
      await f.store.cancelTask(Q, task.taskId)
      continue
    }
    const run = await started(f, task.taskId, `w-${round}-${index}`)
    await checkpointOwned(f.store, Q, run, 'step', '1', 60)
    if (ending === 'completed') await f.store.complete(Q, run.runId, run.claimToken, '"done"')
    else await f.store.fail(Q, run.runId, run.claimToken, FAILURE, null)
  }
  const parent = await f.store.spawn(Q, 'parent', '{}')
  const parentRun = await started(f, parent.taskId, `w-${round}-parent`)
  const child = await f.store.spawn(Q, 'child', '{}', {
    childOf: {
      parentQueue: Q,
      parentTaskId: parent.taskId,
      runId: parentRun.runId,
      claimToken: parentRun.claimToken,
      replayKey: 'child#1',
    },
  })
  const childRun = await started(f, child.taskId, `w-${round}-child`)
  await f.store.complete(Q, childRun.runId, childRun.claimToken, '"child"')
  await f.store.complete(Q, parentRun.runId, parentRun.claimToken, '"parent"')

  await f.store.spawn(Q, 'lost-launch', '{}')
  await f.store.claim(Q, `lost-${round}`, { leaseSeconds: 30, limit: 1 })
  await f.store.spawn(Q, 'deadline', '{}', { cancellation: { maxDelaySeconds: 5 } })
  for (let index = 0; index < 3; index++) await f.store.spawn(Q, `live-${index}`, '{}')
  return keyed
}

/** Walk every page of the candidates and purge each, `passes` times or until a pass purges nothing. */
async function purgeEverything(f: StoreFixture, passes: number): Promise<PurgedUnit[]> {
  const retention = f.retentionOver(f.raw)
  const won: PurgedUnit[] = []
  for (let pass = 0; pass < passes; pass++) {
    const before = won.length
    let after: PurgeCursor | null = null
    do {
      const page = await retention.purgeCandidates(Q, CONTEST_POLICY, {
        limit: 4,
        ...(after === null ? {} : { after }),
      })
      for (const candidate of page.candidates) {
        const purged = await retention.purgeUnit(Q, candidate, CONTEST_POLICY)
        if (purged !== null) won.push(purged)
      }
      after = page.next
    } while (after !== null)
    if (won.length === before && pass > 0) break
  }
  return won
}

const outageOnly = async (actor: string, work: Promise<unknown>): Promise<string[]> => {
  const settled = await settle(work)
  return settled.kind === 'outage' ? [`${actor}: ${settled.why}`] : []
}

async function contestRound(
  f: StoreFixture,
  round: number,
  nowMs: number,
): Promise<PurgeContestRound> {
  const keyed = await arrange(f, round)
  await f.admin.setFakeNowEpochMs(nowMs)
  await warmConnections(f.raw, 'purge-contest', CONTEST_PURGERS + 3)
  const before = await rowsOf(f)

  const failures: string[] = []
  const thrown = (actor: string) => (error: unknown) => {
    failures.push(
      `${actor}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    )
    return undefined
  }
  const answers: { key: string; answer: SpawnResult }[] = []
  const claimer = async () => {
    for (let turn = 0; turn < 4; turn++) {
      const runs = await f.store.claim(Q, `claimer-${round}-${turn}`, {
        leaseSeconds: 60,
        limit: 3,
      })
      for (const run of runs) {
        // The sweeper may cancel a task between its claim and its completion, which the
        // store refuses by name: a refusal is the contract's answer, and an outage is not.
        failures.push(
          ...(await outageOnly(
            'claimer',
            f.store
              .activate(Q, run.runId, run.claimToken, run.claimGen)
              .then((live) =>
                live ? f.store.complete(Q, run.runId, run.claimToken, '"claimed"') : undefined,
              ),
          )),
        )
      }
    }
  }
  const sweeper = async () => {
    for (let turn = 0; turn < 4; turn++) await f.store.sweep(Q, 10)
  }
  // The spawner reuses the round's keys for as long as a purger is still at work, and once
  // more after the last has stopped, so every round spawns under a key while its unit is
  // being purged and again once it is gone.
  let purging = CONTEST_PURGERS
  const spawner = async () => {
    for (let pass = 0; pass < SPAWNER_PASSES; pass++) {
      const last = purging === 0
      for (const key of keyed.keys()) {
        answers.push({
          key,
          answer: await f.store.spawn(Q, 'again', '{}', { idempotencyKey: key }),
        })
      }
      if (last) return
    }
  }
  const [, , , ...wins] = await Promise.all([
    outageOnly('claimer', claimer()).then((outages) => failures.push(...outages)),
    outageOnly('sweeper', sweeper()).then((outages) => failures.push(...outages)),
    spawner().catch(thrown('spawner')),
    ...Array.from({ length: CONTEST_PURGERS }, (_, purger) =>
      purgeEverything(f, 3)
        .catch(thrown(`purger ${purger}`))
        .finally(() => {
          purging -= 1
        }),
    ),
  ])
  const purged = wins.flatMap((won) => won ?? []).map((unit) => unit.taskId)
  const during = await rowsOf(f)
  const afterwards = (await purgeEverything(f, 10)).map((unit) => unit.taskId)
  const after = await rowsOf(f)

  const everyPurge = [...purged, ...afterwards]
  const answeredFor = new Set(everyPurge)
  const gone = [...before.tasks.keys()].filter((taskId) => !after.tasks.has(taskId))
  const madeUnder = new Map<string, string[]>()
  const spawnMisanswers = answers.flatMap(({ key, answer }) => {
    const original = keyed.get(key)
    const made = madeUnder.get(key) ?? []
    madeUnder.set(key, made)
    if (!answer.created) {
      return answer.taskId === original || made.includes(answer.taskId)
        ? []
        : [`${key} answered ${answer.taskId}, which never held it`]
    }
    made.push(answer.taskId)
    const holder = after.tasks.get(answer.taskId)
    return original !== undefined && !after.tasks.has(original) && holder?.key === key
      ? []
      : [`${key} made ${answer.taskId} while ${original} still held it, or the new task is gone`]
  })
  // A part is orphaned in the snapshot it was read in when its task's row is not in that
  // snapshot. Each snapshot is judged against its own tasks, so a row the last purger
  // left behind is seen though its task was still there while the others ran.
  const orphans = (rows: Rows): string[] =>
    rows.parts.filter((part) => !rows.tasks.has(part.slice(0, part.indexOf(' '))))
  return {
    round,
    failures,
    purgedTwice: everyPurge.filter((taskId, index) => everyPurge.indexOf(taskId) !== index),
    purgedAndPresent: purged
      .filter((taskId) => during.tasks.has(taskId))
      .concat(afterwards.filter((taskId) => after.tasks.has(taskId))),
    goneUnpurged: gone.filter((taskId) => !answeredFor.has(taskId)),
    partUnits: [...new Set([...orphans(during), ...orphans(after)])],
    violations: await engineHistoryViolations(f.raw),
    leftBehind: [...after.tasks]
      .filter(
        ([, task]) =>
          (task.state === 'completed' || task.state === 'cancelled') &&
          task.stampedAtMs <= nowMs - WINDOW_MS,
      )
      .map(([taskId, task]) => `${taskId} ${task.state}`),
    spawnMisanswers,
    failedKept: [...after.tasks.values()].filter(
      (task) => task.state === 'failed' && task.key?.startsWith('key-') === true,
    ).length,
    purged: purged.length,
    purgedAfterwards: afterwards.length,
    created: answers.filter(({ answer }) => answer.created).length,
  }
}

/**
 * The purge beside the rest of the engine (DESIGN.md §3.12): `rounds` rounds over one
 * database, each ending a population of units, moving the clock a window on, and then
 * running at once four purgers that walk the same candidates, a claimer, a sweeper, and a
 * spawner that reuses the keys of the units being purged. After each round every unit is
 * whole or gone, one purge answered for each unit that went, every unit the policy lets go
 * is gone once a last purger has run alone, and every reused key answered the task that
 * holds it or made a new one.
 */
export async function purgeContest(
  makeFixture: StoreFixtureFactory,
  rounds: number,
): Promise<PurgeContest> {
  return withFixture(makeFixture, 'purge-contest', async (f) => {
    let nowMs = START_MS
    await f.admin.setFakeNowEpochMs(nowMs)
    const deadlocksBefore = f.deadlocks()
    const results: PurgeContestRound[] = []
    for (let round = 0; round < rounds; round++) {
      nowMs += WINDOW_MS + 1_000
      results.push(await contestRound(f, round, nowMs))
    }
    return { rounds: results, deadlocks: f.deadlocks() - deadlocksBefore }
  })
}
