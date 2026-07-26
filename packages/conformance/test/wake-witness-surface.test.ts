import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'

/**
 * A GENERATED fault surface for the one predicate the primitive cannot build.
 *
 * `emitEvent`'s wake statement is the single follow-on whose rows come from a
 * table the batch never wrote, so its correctness rests on a hand-written
 * predicate over `waits`. Three separate review rounds each found a wait row
 * that enlisted a run it should not have, and each was fixed by adding one
 * more condition. The third one was different in kind: no single row was
 * wrong: the predicate asks the table TWO questions, and two rows that are
 * each individually disqualifying answered one apiece.
 *
 * That is the class. A condition list cannot be audited by reading it, because
 * the defect is not in any condition — it is in which ROW satisfies which
 * condition. So the surface is generated: build every combination of a
 * corrupt wait row, in ones and in pairs, across both timeout arms and both
 * task-liveness arms, and compare the engine against an independently written
 * statement of what a legitimate registration IS.
 *
 * The oracle is deliberately shaped the way the SQL is not — one row at a
 * time, all properties at once — because that shape is exactly what the SQL
 * failed to require. It is written by the same hand, so it is not an
 * independent specification; what it is, is a second representation that
 * cannot express the bug, which is enough to catch it.
 */

const Q = 'q'
const EVENT = 'go'
const STEP = '$await:go'
const NOW = 1_000_000

/** Every field of a wait row that the wake predicate consults. */
const FIELDS = ['queue', 'event_name', 'status', 'step_name', 'timeout_at_ms'] as const
type Field = (typeof FIELDS)[number]

interface Row {
  queue: string
  event_name: string
  status: string
  step_name: string
  timeout_at_ms: number | null
}

interface Deadline {
  label: string
  healthy: number | null
  corrupt: number | null
}

/**
 * Both positive timeout arms. Keeping the corrupt value opposite the healthy
 * one makes timeout mismatches part of every generated corruption subset.
 */
const DEADLINES: readonly Deadline[] = [
  { label: 'untimed', healthy: null, corrupt: NOW + 5_000 },
  { label: 'timed', healthy: NOW + 30_000, corrupt: null },
]

function healthy(deadline: Deadline): Row {
  return {
    queue: Q,
    event_name: EVENT,
    status: 'waiting',
    step_name: STEP,
    timeout_at_ms: deadline.healthy,
  }
}

/** One plausible wrong value per field: a different queue, a stale step, … */
function corrupt(deadline: Deadline, fields: readonly Field[]): Row {
  const row = healthy(deadline)
  const wrong: Row = {
    queue: 'elsewhere',
    event_name: 'other-event',
    status: 'delivered',
    step_name: `${STEP}#stale`,
    timeout_at_ms: deadline.corrupt,
  }
  for (const f of fields) Object.assign(row, { [f]: wrong[f] })
  return row
}

/** Every subset of FIELDS, as a bitmask over its five members. */
const SUBSETS: Field[][] = Array.from({ length: 1 << FIELDS.length }, (_, mask) =>
  FIELDS.filter((_f, i) => mask & (1 << i)),
)

/**
 * The predicate correlates two sides, so both are generated. A surface that
 * varied only the wait rows left `wake_event` untested — every run in it was
 * parked on the event being emitted — and deleting that condition from the
 * engine kept the surface green. Probing the surface is how that was found.
 */
interface Park {
  state: string
  wake_event: string
  wake_step: string | null
  available_at_ms: number | null
}

function parksFor(deadline: Deadline): Record<string, Park> {
  const at: Omit<Park, 'state'> = {
    wake_event: EVENT,
    wake_step: STEP,
    available_at_ms: deadline.healthy,
  }
  return {
    /** What awaitEvent writes. */
    parked: { state: 'sleeping', ...at },
    /** Parked on some other event: this emit is not the one it is waiting for. */
    'other-event': { state: 'sleeping', ...at, wake_event: 'other-event' },
    /** Parked before wake_step existed; its migration backfills nothing. */
    'legacy-null-step': { state: 'sleeping', ...at, wake_step: null },
    /** Asleep on a durable timer, with the wake fields left over from before. */
    timer: { state: 'sleeping', ...at, available_at_ms: deadline.corrupt },
    /** Running right now, under a wait row that should not exist. Waking it
     *  would hand a live worker's run to a second launch. */
    running: { state: 'running', ...at },
    /** Already queued to run: waking is a no-op it must still not perform,
     *  because it would move available_at_ms and re-deliver the payload. */
    pending: { state: 'pending', ...at },
  }
}

interface Owner {
  label: string
  state: string
  live: boolean
}

/** Both positive arms of the task-liveness guard. */
const OWNERS: readonly Owner[] = [
  { label: 'live-owner', state: 'running', live: true },
  { label: 'terminal-owner', state: 'completed', live: false },
]

/**
 * What the engine is supposed to decide, stated over ONE row at a time: a run
 * wakes iff its owning task is live, it is parked on this event, AND some
 * single registration says every one of these things at once.
 *
 * A NULL wake_step may recover exactly one matching legacy registration.
 * Several matches are ambiguous: without the active-wait identity deferred
 * to PR3.8, choosing any of them would fabricate a step.
 */
function shouldWake(owner: Owner, park: Park, rows: readonly Row[]): boolean {
  if (!owner.live) return false
  if (park.state !== 'sleeping') return false
  if (park.wake_event !== EVENT) return false
  const matching = rows.filter(
    (r) =>
      r.queue === Q &&
      r.event_name === EVENT &&
      r.status === 'waiting' &&
      r.timeout_at_ms === park.available_at_ms,
  )
  if (park.wake_step === null) return matching.length === 1
  return matching.some((r) => r.step_name === park.wake_step)
}

type StatementMutator = (
  label: string,
  statements: readonly SqlStatement[],
) => readonly SqlStatement[]

function mutateWake(find: string, replace: string): StatementMutator {
  return (label, statements) => {
    if (label !== 'emit-event') return statements
    let changed = 0
    const mutated = statements.map((statement) => {
      if (!/^\s*UPDATE runs SET/.test(statement.sql)) return statement
      if (!statement.sql.includes(find)) return statement
      changed += 1
      // A canonical witness can be spliced into more than one decision arm.
      // Mutate every compiled occurrence so the probe still deletes the one
      // shared condition rather than leaving a duplicate to answer for it.
      const sql = statement.sql.split(find).join(replace)
      return { ...statement, sql }
    })
    if (changed !== 1) throw new Error(`wake mutation changed ${changed} statements`)
    return mutated
  }
}

const NULL_ONLY_TIMEOUT = mutateWake(
  'w.timeout_at_ms IS runs.available_at_ms',
  'w.timeout_at_ms IS NULL AND runs.available_at_ms IS NULL',
)
const NO_LIVE_TASK_GUARD = mutateWake(
  "t.state IN ('pending','running','sleeping')",
  't.state IS NOT NULL',
)

async function open(mutate?: StatementMutator) {
  const { raw, ids } = await openTestDb({
    nowMs: NOW,
    idNamespace: 'wake-witness',
  })
  const db: SqlExecutor = mutate
    ? {
        batch: (label, statements, mode) => raw.batch(label, mutate(label, statements), mode),
      }
    : raw
  const store = new LibsqlSchedulerStore(db, ids)
  return { raw, store, close: () => raw.close() }
}

/**
 * The columns the wake statement writes, plus the provenance stamp it leaves
 * behind. "Was this run woken" is asked as "did that statement write this
 * row", which is what the stamp is FOR — and it has to be, because a run
 * parked in the `pending` state is already pending afterwards whether the
 * emit touched it or not. Reading the state alone reported every such case as
 * woken, which is a defect in the probe that the surface itself surfaced.
 */
const WRITTEN = `state, available_at_ms, event_payload, wake_event, fence_stamp`

/**
 * Builds one task, one run in the given park, and exactly `rows` — directly,
 * because this surface is about the emit and nothing else, and driving the
 * park through spawn/claim/activate/awaitEvent only to overwrite its fields
 * costs four round trips per case for realism that the next statement
 * discards. Then emits, and reports whether the wake statement wrote the run.
 */
async function wakes(
  f: Awaited<ReturnType<typeof open>>,
  queue: string,
  owner: Owner,
  park: Park,
  rows: readonly Row[],
): Promise<boolean> {
  const id = `${queue}`
  await f.raw.batch('setup', [
    {
      sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
              max_attempts, cancellation, state, enqueue_at_ms, created_at_ms)
            VALUES (?, ?, 'job', '{}', '{"kind":"none"}', 3,
              '{"maxDurationSeconds":1}', ?, ?, ?)`,
      args: [id, queue, owner.state, NOW, NOW],
    },
    {
      sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claim_gen, activated_gen,
              wake_event, wake_step, available_at_ms, created_at_ms)
            VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?, ?, ?)`,
      args: [id, queue, id, park.state, park.wake_event, park.wake_step, park.available_at_ms, NOW],
    },
    ...rows.map((r) => ({
      sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
              timeout_at_ms, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // A corrupt row's queue is a different one; a healthy row's is the run's.
      args: [
        id,
        r.step_name,
        r.queue === Q ? queue : r.queue,
        id,
        r.event_name,
        r.status,
        r.timeout_at_ms,
        NOW,
      ],
    })),
  ])

  const snapshot = async () => {
    const [res] = await f.raw.batch(
      'probe',
      [{ sql: `SELECT ${WRITTEN} FROM runs WHERE run_id = ?`, args: [id] }],
      'read',
    )
    const [row] = (res?.rows ?? []) as unknown as Record<string, unknown>[]
    if (!row) throw new Error('run vanished')
    return JSON.stringify(row)
  }

  const before = await snapshot()
  await f.store.emitEvent(queue, EVENT, '{"x":1}')
  return (await snapshot()) !== before
}

/** A label a failure can be read from without counting bitmask bits. */
function name(fields: readonly Field[]): string {
  return fields.length === 0 ? 'healthy' : fields.join('+')
}

interface Case {
  label: string
  owner: Owner
  park: Park
  rows: Row[]
}

/** Runs every case and returns the ones the engine and the oracle disagree on. */
async function disagreements(cases: readonly Case[], mutate?: StatementMutator): Promise<string[]> {
  const f = await open(mutate)
  try {
    const wrong: string[] = []
    for (const [i, c] of cases.entries()) {
      const got = await wakes(f, `${Q}-${i}`, c.owner, c.park, c.rows)
      if (got !== shouldWake(c.owner, c.park, c.rows)) wrong.push(`${c.label}: woke=${got}`)
    }
    return wrong
  } finally {
    f.close()
  }
}

const axes = DEADLINES.flatMap((deadline) =>
  OWNERS.flatMap((owner) =>
    Object.entries(parksFor(deadline)).map(([parkLabel, park]) => ({
      deadline,
      owner,
      parkLabel,
      park,
    })),
  ),
)
const singleCases = axes.flatMap(({ deadline, owner, parkLabel, park }) =>
  SUBSETS.map((fields) => ({
    label: `${deadline.label} / ${owner.label} / ${parkLabel} / ${name(fields)}`,
    owner,
    park,
    rows: [corrupt(deadline, fields)],
  })),
)
const atStep = SUBSETS.filter((fields) => !fields.includes('step_name'))
const atOther = SUBSETS.filter((fields) => fields.includes('step_name'))
const pairCases = axes.flatMap(({ deadline, owner, parkLabel, park }) =>
  atStep.flatMap((a) =>
    atOther.map((b) => ({
      label: `${deadline.label} / ${owner.label} / ${parkLabel} / ${name(a)} | ${name(b)}`,
      owner,
      park,
      rows: [corrupt(deadline, a), corrupt(deadline, b)],
    })),
  ),
)

describe('a wake needs ONE row that justifies it', () => {
  it('decides every park against every single-row corruption', async () => {
    expect(await disagreements(singleCases)).toEqual([])
  })

  it('decides every park against every PAIR of corruptions', async () => {
    // Two rows for one run must differ in step_name — it is half the primary
    // key — so a pair is always "one row at the right step" against "one row
    // at a stale step". That is not a limitation of the surface, it is the
    // only shape a two-row registration can take, and it is precisely the
    // shape that produced the defect: the row with the right step was wrong
    // about the queue, and the row with the right queue was wrong about the
    // step.
    expect(
      await disagreements(pairCases),
      'mutation-verdict:behavior:emit-wake-one-witness',
    ).toEqual([])
  }, 15_000)

  it('rejects a wake predicate that accepts only NULL timeout pairs', async () => {
    expect(await disagreements(singleCases, NULL_ONLY_TIMEOUT)).not.toEqual([])
  })

  it('rejects a wake predicate with no live-task guard', async () => {
    expect(await disagreements(singleCases, NO_LIVE_TASK_GUARD)).not.toEqual([])
  })
})
