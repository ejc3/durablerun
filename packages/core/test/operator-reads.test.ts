import { describe, expect, it } from 'vitest'
import {
  NOW as CLOCK_TOKEN,
  InvalidDurableStringError,
  OPERATOR_GAUGE_CAP,
  OPERATOR_LIST_CAP,
  OPERATOR_READ_METHODS,
  OPERATOR_READ_STRINGS,
  type OperatorReadsDialect,
  OPERATOR_TABLE_ROWS_CAP,
  PORT_STRING_RULES,
  QUEUE_TABLES,
  type SqlExecutor,
  type SqlRow,
  createOperatorReads,
  requireOperatorReadStrings,
  sqlFragment,
} from '../src/index.js'
import { batch } from './tree-fixtures.js'

/**
 * Core's one implementation of the operator's reads, over SQLite's compiler and an executor
 * that answers each statement of a batch with the rows a test gives it. What a real store
 * answers is the conformance surface's to say (`conformance/src/operator-reads.ts`). These
 * cases hold what no store decides: the check in front of every method, how a row is
 * decoded, and the order of every list.
 */
/** A dialect's predicate over one alias, with the queue bound, as a store hands one out. */
const byQueue = (alias: string) => (queue: string) => sqlFragment(`${alias}.queue = ?`, [queue])
/** One that also compares with the clock, as every predicate of what the engine would take now does. */
const dueByQueue = (alias: string) => (queue: string) =>
  sqlFragment(`${alias}.queue = ? AND ${alias}.created_at_ms <= ${CLOCK_TOKEN}`, [queue])

function readsAnswering(answers: Readonly<Record<string, SqlRow[][]>>, fakeClock: unknown = 0) {
  const sent: string[] = []
  /** The arguments each statement of a batch was sent with, by the batch's label. */
  const args: Record<string, unknown[][]> = {}
  const executor: SqlExecutor = {
    batch: async (label, statements) => {
      sent.push(label)
      args[label] = statements.map((statement) => [...statement.args])
      return statements.map((_statement, index) => ({
        rows: answers[label]?.[index] ?? [],
        rowsAffected: 0,
      }))
    },
  }
  const dialect: OperatorReadsDialect = {
    run: (opened) => opened.run(executor),
    open: {
      taskFacts: () => batch('task-facts'),
      taskIdByKey: () => batch('task-id-by-key'),
      eventState: () => batch('event-state'),
      stuckRuns: () => batch('stuck-runs'),
      queueStatus: () => batch('queue-status'),
      tableRows: () => batch('table-rows'),
      eventWaiters: () => batch('event-waiters'),
      agedTasks: () => batch('aged-tasks'),
    },
    fakeClock: async () => {
      sent.push('fake-clock')
      return fakeClock
    },
    sagaBegan: sqlFragment('1 = 0'),
    rollbackOutcome: sqlFragment('NULL'),
    rollbackError: sqlFragment('NULL'),
    taskOwnsRun: sqlFragment('t.task_id = r.task_id'),
    liveRunOfTask: sqlFragment('r.task_id = t.task_id'),
    owed: {
      pendingRuns: dueByQueue('r'),
      sleepingRuns: dueByQueue('r'),
      refusedPendingRuns: dueByQueue('r'),
      refusedSleepingRuns: dueByQueue('r'),
      expiredClaims: dueByQueue('r'),
      dueCancels: dueByQueue('t'),
    },
    counted: {
      pendingRuns: byQueue('r'),
      sleepingRuns: byQueue('r'),
      runningRuns: byQueue('r'),
      tasksWithADeadline: (queue: string) => [byQueue('t')(queue)],
      // Two legs, as a store hands out one to a live state.
      liveTasks: (queue: string) => [byQueue('t')(queue), byQueue('t')(queue)],
    },
  }
  return { reads: createOperatorReads(dialect), sent, args }
}

const TASK: SqlRow = {
  state: 'pending',
  completed_payload: null,
  failure_reason: null,
  task_name: 'job',
  attempts: 0,
  max_attempts: 5,
  infra_retries: 0,
  enqueue_at_ms: 1000,
  first_started_at_ms: null,
  cancel_at_ms: null,
  idempotency_key: null,
  rollback_outcome: null,
  rollback_error: null,
  now_ms: 2000,
  saga_began: 0,
}

const run = (row: Partial<SqlRow> & { run_id: string }): SqlRow => ({
  queue: 'q',
  state: 'pending',
  attempt: 1,
  claim_gen: 0,
  activated_gen: 0,
  relaunch_count: 0,
  claim_expires_at_ms: null,
  heartbeat_at_ms: null,
  available_at_ms: 1000,
  wake_event: null,
  wake_step: null,
  started_at_ms: null,
  completed_at_ms: null,
  failed_at_ms: null,
  emitted_event: null,
  emitted_at_ms: null,
  ...row,
})

const wait = (row: Partial<SqlRow> & { run_id: string; step_name: string }): SqlRow => ({
  event_name: 'e',
  status: 'waiting',
  timeout_at_ms: null,
  created_at_ms: 1000,
  emitted_event: null,
  emitted_at_ms: null,
  ...row,
})

/** `task-facts` answers its three statements in order: the task, its runs, its waits. */
const facts = (task: SqlRow, runs: SqlRow[] = [], waits: SqlRow[] = []) => ({
  'task-facts': [[task], runs, waits],
})

const NUL = 'a\u0000b'
/** One valid call of each method. */
const CALLS = {
  taskFacts: ['q', 't'],
  taskIdByKey: ['q', 'k'],
  eventState: ['q', 'e'],
  stuckRuns: ['q', { graceSeconds: 0, limit: 20 }],
  agedTasks: ['q', { olderThanSeconds: 0, limit: 20 }],
  queueStatus: ['q'],
  tableRows: ['q'],
  eventWaiters: ['q', 'e'],
} as const

describe("the strings an operator's read carries", () => {
  it('names every string of every method of the port, each under a rule of the port table', () => {
    expect(Object.keys(OPERATOR_READ_STRINGS)).toEqual(Object.keys(CALLS))
    expect(OPERATOR_READ_METHODS).toEqual(Object.keys(CALLS))
    for (const method of OPERATOR_READ_METHODS) {
      expect(OPERATOR_READ_STRINGS[method].length).toBe(CALLS[method].length)
      for (const name of OPERATOR_READ_STRINGS[method]) {
        // An argument that carries no string, as the options of `stuckRuns` are, is named null.
        if (name !== null) expect(PORT_STRING_RULES[name], `${method}: ${name}`).toBe('identifier')
      }
      expect(Object.isFrozen(OPERATOR_READ_STRINGS[method])).toBe(true)
    }
    expect(Object.isFrozen(OPERATOR_READ_STRINGS)).toBe(true)
    expect(() => requireOperatorReadStrings('taskFacts', ['q', 't'])).not.toThrow()
  })

  it('refuses a string outside the domain, past the width, or left out, at every place, before anything is sent', async () => {
    const refused: unknown[] = []
    for (const method of OPERATOR_READ_METHODS) {
      for (const [index, name] of OPERATOR_READ_STRINGS[method].entries()) {
        if (name === null) continue
        for (const bad of [NUL, 'x'.repeat(256), undefined, 7]) {
          const { reads, sent } = readsAnswering(facts(TASK))
          const args: unknown[] = [...CALLS[method]]
          args[index] = bad
          const call = reads[method] as (...made: unknown[]) => Promise<unknown>
          const answer = await call(...args).then(
            () => 'accepted',
            (error: unknown) =>
              error instanceof InvalidDurableStringError && error.message.startsWith(`${name} `)
                ? 'refused'
                : `another error: ${error}`,
          )
          refused.push({ method, name, bad: typeof bad, answer, sent: sent.length })
        }
      }
    }
    expect(refused, 'mutation-verdict:behavior:operator-read-check-runs-before-the-entry').toEqual(
      OPERATOR_READ_METHODS.flatMap((method) =>
        OPERATOR_READ_STRINGS[method].flatMap((name) =>
          (name === null ? [] : ['string', 'string', 'undefined', 'number']).map((bad) => ({
            method,
            name,
            bad,
            answer: 'refused',
            sent: 0,
          })),
        ),
      ),
    )
  })

  it('answers a well-formed call through the check, and a refusal as a rejected promise', async () => {
    const { reads, sent } = readsAnswering({ 'task-id-by-key': [[{ task_id: 't9' }]] })
    await expect(reads.taskIdByKey('q', 'order-7')).resolves.toBe('t9')
    expect(sent).toEqual(['task-id-by-key'])
    // A refusal never throws from the call itself.
    const refusal = reads.taskFacts(NUL, 't')
    await expect(refusal).rejects.toBeInstanceOf(InvalidDurableStringError)
    // A reserved key and a reserved event name are read like any other: a read changes nothing.
    await expect(reads.taskIdByKey('q', '$spawn:1:p:site')).resolves.toBe('t9')
    await expect(reads.eventState('q', '$task-done:t1')).resolves.toEqual({
      exists: false,
      emittedAtMs: null,
      corrupt: [],
    })
  })
})

describe("how an operator's read decodes a row", () => {
  it('answers null for a task the queue does not hold, and does not ask for the test clock', async () => {
    const { reads, sent } = readsAnswering({})
    await expect(reads.taskFacts('q', 't')).resolves.toBeNull()
    expect(sent).toEqual(['task-facts'])
  })

  it('reads every count and instant as a number, one a store returned as a bigint included', async () => {
    const { reads } = readsAnswering(
      facts({ ...TASK, attempts: 2n, enqueue_at_ms: 1000n }, [
        run({ run_id: 'r1', claim_gen: 3n }),
      ]),
      1n,
    )
    const answer = await reads.taskFacts('q', 't')
    expect(answer?.task.attempts).toBe(2)
    expect(answer?.task.enqueueAtMs).toBe(1000)
    expect(answer?.runs[0]?.claimGen).toBe(3)
    expect(answer?.fakeClock).toBe(true)
    expect(answer?.corrupt).toEqual([])
  })

  it('lists an integer outside its bounds or of another kind, reads it as null, and throws nothing', async () => {
    const { reads } = readsAnswering(
      facts(
        { ...TASK, attempts: -1, max_attempts: '5', now_ms: 1.5 },
        // Two rows hold each corrupt field of a run, of a wait and of an event, answered
        // here in the reverse of their order, so the order by row is held as well.
        [
          run({
            run_id: 'r1',
            attempt: 0,
            claim_expires_at_ms: 253_402_300_799_001,
            wake_event: 'zeta',
            emitted_event: 'zeta',
            emitted_at_ms: -1,
          }),
          run({
            run_id: 'r0',
            attempt: 0,
            wake_event: 'alpha',
            emitted_event: 'alpha',
            emitted_at_ms: -1,
          }),
        ],
        [
          wait({ run_id: 'r1', step_name: 's', timeout_at_ms: -1 }),
          wait({ run_id: 'r1', step_name: 'a', timeout_at_ms: -1 }),
        ],
      ),
    )
    const answer = await reads.taskFacts('q', 't')
    expect(
      {
        nowMs: answer?.nowMs,
        listed: answer?.corrupt.some((entry) => entry.field === 'derived.epoch_ms'),
      },
      'mutation-verdict:behavior:operator-reads-guard-database-time',
    ).toEqual({ nowMs: null, listed: true })
    // The list has one order, by field and then by row, whatever order the rows were read in.
    expect(
      answer?.corrupt,
      'mutation-verdict:behavior:operator-reads-order-the-corrupt-list',
    ).toEqual([
      { field: 'derived.epoch_ms', reason: 'not-an-exact-integer', stored: 'number', value: '1.5' },
      {
        field: 'events.emitted_at_ms',
        eventName: 'alpha',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      },
      {
        field: 'events.emitted_at_ms',
        eventName: 'zeta',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      },
      { field: 'runs.attempt', runId: 'r0', reason: 'out-of-range', stored: 'number', value: '0' },
      { field: 'runs.attempt', runId: 'r1', reason: 'out-of-range', stored: 'number', value: '0' },
      {
        field: 'runs.claim_expires_at_ms',
        runId: 'r1',
        reason: 'out-of-range',
        stored: 'number',
        value: '253402300799001',
      },
      { field: 'tasks.attempts', reason: 'out-of-range', stored: 'number', value: '-1' },
      // A value that is no number is named by its kind and not copied.
      { field: 'tasks.max_attempts', reason: 'not-an-exact-integer', stored: 'string' },
      {
        field: 'waits.timeout_at_ms',
        runId: 'r1',
        stepName: 'a',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      },
      {
        field: 'waits.timeout_at_ms',
        runId: 'r1',
        stepName: 's',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      },
    ])
    expect({
      nowMs: answer?.nowMs,
      attempts: answer?.task.attempts,
      maxAttempts: answer?.task.maxAttempts,
      attempt: answer?.runs[1]?.attempt,
      claimExpiresAtMs: answer?.runs[1]?.claimExpiresAtMs,
      timeoutAtMs: answer?.waits[0]?.timeoutAtMs,
    }).toEqual({
      nowMs: null,
      attempts: null,
      maxAttempts: null,
      attempt: null,
      claimExpiresAtMs: null,
      timeoutAtMs: null,
    })
  })

  it("lists an event that exists with no instant, in a task's facts and in an event's state", async () => {
    const { reads } = readsAnswering({
      ...facts(TASK, [
        run({ run_id: 'r1', wake_event: 'woken', emitted_event: 'woken', emitted_at_ms: null }),
      ]),
      'event-state': [[{ emitted_at_ms: null }]],
    })
    const listed = {
      field: 'events.emitted_at_ms',
      eventName: 'woken',
      reason: 'not-an-exact-integer',
      stored: 'null',
    }
    const answer = await reads.taskFacts('q', 't')
    expect(
      { events: answer?.events, corrupt: answer?.corrupt },
      'mutation-verdict:behavior:operator-reads-null-instant-is-corrupt',
    ).toEqual({
      events: [{ eventName: 'woken', exists: true, emittedAtMs: null }],
      corrupt: [listed],
    })
    expect(await reads.eventState('q', 'woken')).toEqual({
      exists: true,
      emittedAtMs: null,
      corrupt: [listed],
    })
    // A NULL the engine writes is a value: the run above holds no lease and has not started.
    expect(answer?.runs[0]).toMatchObject({ claimExpiresAtMs: null, startedAtMs: null })
  })

  it('answers a row the decoders refuse as the outcome, and throws every other error as itself', async () => {
    const contradiction = { ...TASK, state: 'completed' }
    const refusedRow = await readsAnswering(facts(contradiction)).reads.taskFacts('q', 't1')
    expect(refusedRow?.outcome).toEqual({
      refused: 'task t1 is completed but has no completed payload',
    })
    expect(refusedRow?.task.state).toBe('completed')
    const unknownRollback = {
      ...TASK,
      state: 'failed',
      failure_reason: '{}',
      rollback_outcome: 'half',
    }
    expect(
      (await readsAnswering(facts(unknownRollback)).reads.taskFacts('q', 't1'))?.outcome,
    ).toEqual({ refused: 'task t1 has unknown rollback outcome half' })
    // A flag a dialect answered as a string is that dialect's defect. It is a RangeError
    // too, and it is thrown: only what the two decoders refuse becomes the outcome.
    await expect(
      readsAnswering(facts({ ...TASK, saga_began: '1' })).reads.taskFacts('q', 't1'),
    ).rejects.toThrow(/task-facts saga_began must be the integer 0 or 1, got string/)
    await expect(readsAnswering(facts(TASK), '1').reads.taskFacts('q', 't1')).rejects.toThrow(
      /fake-clock must be the integer 0 or 1, got string/,
    )
    // A statement that selected no such column is a defect, never a stored NULL.
    const { attempts: _attempts, ...lacksAColumn } = TASK
    await expect(readsAnswering(facts(lacksAColumn)).reads.taskFacts('q', 't1')).rejects.toThrow(
      /an operator read selected no attempts/,
    )
  })

  it("reads a child's parent from its key, and none from any other key", async () => {
    const keyed = async (idempotency_key: string | null) =>
      (await readsAnswering(facts({ ...TASK, idempotency_key })).reads.taskFacts('q', 't'))?.task
    expect(await keyed('$spawn:6:parent:site:1')).toMatchObject({
      idempotencyKey: '$spawn:6:parent:site:1',
      parentTaskId: 'parent',
    })
    expect(await keyed('order-7')).toMatchObject({ idempotencyKey: 'order-7', parentTaskId: null })
    expect(await keyed(null)).toMatchObject({ idempotencyKey: null, parentTaskId: null })
  })
})

describe("the order of an operator's lists", () => {
  // Two names whose order by code point, which is the order a comparison of their UTF-8
  // bytes gives, is the reverse of their order by UTF-16 code units.
  const ASTRAL = '\u{1F600}'
  const HIGH_BASIC_PLANE = '\uFF5E'

  it('orders runs by their ordinal, then by run id, with an ordinal it could not read last', async () => {
    const { reads } = readsAnswering(
      facts(TASK, [
        run({ run_id: 'r-c', attempt: 2 }),
        run({ run_id: 'r-z', attempt: -4 }),
        run({ run_id: 'r-b', attempt: 1 }),
        run({ run_id: 'r-a', attempt: 'x' }),
      ]),
    )
    const answer = await reads.taskFacts('q', 't')
    expect(
      answer?.runs.map((one) => one.runId),
      'mutation-verdict:behavior:operator-reads-order-runs',
    ).toEqual(['r-b', 'r-c', 'r-a', 'r-z'])
  })

  it('orders waits and events by code point, whatever order a store returned them in', async () => {
    // `a` and `ab` hold that a string sorts before a longer one it begins.
    const steps = ['b', HIGH_BASIC_PLANE, 'B', 'ab', ASTRAL, '_', 'a']
    const { reads } = readsAnswering(
      facts(
        TASK,
        [run({ run_id: 'r1', wake_event: 'woken', emitted_event: 'woken', emitted_at_ms: 5 })],
        [
          ...steps.map((step) => wait({ run_id: 'r2', step_name: step, event_name: `e-${step}` })),
          wait({
            run_id: 'r1',
            step_name: 'z',
            event_name: 'e-b',
            emitted_event: 'e-b',
            emitted_at_ms: 7,
          }),
        ],
      ),
    )
    const answer = await reads.taskFacts('q', 't')
    const sorted = ['B', '_', 'a', 'ab', 'b', HIGH_BASIC_PLANE, ASTRAL]
    expect(
      answer?.waits.map((one) => `${one.runId}/${one.stepName}`),
      'mutation-verdict:behavior:operator-reads-order-their-own-lists',
    ).toEqual(['r1/z', ...sorted.map((step) => `r2/${step}`)])
    expect(answer?.events, 'mutation-verdict:behavior:operator-reads-order-events').toEqual([
      ...sorted.map((step) => ({
        eventName: `e-${step}`,
        // An event is read once, from the first row that names it.
        exists: false,
        emittedAtMs: null,
      })),
      { eventName: 'woken', exists: true, emittedAtMs: 5 },
    ])
  })
})

type Stored = SqlRow[string]

/** Database time in every case below, unless the case says otherwise. */
const NOW = 10_000

/**
 * `stuck-runs` answers its seven statements in order: pending, sleeping, lapsed, cancels,
 * the pending and the sleeping runs a claim refuses, database time.
 */
const stuck = (
  legs: {
    pending?: SqlRow[]
    sleeping?: SqlRow[]
    lapsed?: SqlRow[]
    cancels?: SqlRow[]
    refusedPending?: SqlRow[]
    refusedSleeping?: SqlRow[]
  },
  now: SqlRow[] = [{ now_ms: NOW }],
) => ({
  'stuck-runs': [
    legs.pending ?? [],
    legs.sleeping ?? [],
    legs.lapsed ?? [],
    legs.cancels ?? [],
    legs.refusedPending ?? [],
    legs.refusedSleeping ?? [],
    now,
  ],
})

/** A run a claim would take, as its leg selects it. */
const dueRun = (run_id: string, available_at_ms: Stored, more: SqlRow = {}): SqlRow => ({
  run_id,
  task_id: `task-of-${run_id}`,
  task_name: 'job',
  attempt: 1,
  available_at_ms,
  ...more,
})

/** A run whose lease lapsed, as its leg selects it: started under its newest claim unless told otherwise. */
const lapsedRun = (run_id: string, claim_expires_at_ms: Stored, more: SqlRow = {}): SqlRow => ({
  run_id,
  task_id: `task-of-${run_id}`,
  task_name: 'job',
  attempt: 1,
  claim_expires_at_ms,
  claim_gen: 1,
  activated_gen: 1,
  ...more,
})

/** A task past its cancellation deadline, as its leg selects it. */
const overdueTask = (task_id: string, cancel_at_ms: Stored, more: SqlRow = {}): SqlRow => ({
  task_id,
  task_name: 'job',
  state: 'pending',
  run_id: `run-of-${task_id}`,
  cancel_at_ms,
  ...more,
})

/** What a leg lists, as each row's id and how late it is. */
const listed = (leg: {
  rows: readonly { runId?: string; taskId: string; lateByMs: number | null }[]
}) => leg.rows.map((row) => [row.runId ?? row.taskId, row.lateByMs])

describe("how an operator's read of what a move is owed to decodes its legs", () => {
  it('lists a row from the instant its move has been owed for the grace, in every leg, and not a millisecond before', async () => {
    // Database time is 10,000 and the grace is two seconds, so a move owed since 8,000 is
    // listed and one owed since 8,001 is not.
    const { reads } = readsAnswering(
      stuck({
        pending: [dueRun('p-at', 8_000), dueRun('p-inside', 8_001)],
        sleeping: [dueRun('s-at', 8_000), dueRun('s-inside', 8_001)],
        lapsed: [lapsedRun('l-at', 8_000), lapsedRun('l-inside', 8_001)],
        cancels: [overdueTask('c-at', 8_000), overdueTask('c-inside', 8_001)],
      }),
    )
    const answer = await reads.stuckRuns('q', { graceSeconds: 2, limit: 10 })
    expect(
      {
        dueUnclaimed: listed(answer.dueUnclaimed),
        sleepingPastWake: listed(answer.sleepingPastWake),
        leaseLapsed: answer.leaseLapsed.rows.map((row) => [row.runId, row.lateByMs]),
        cancelOverdue: answer.cancelOverdue.rows.map((row) => [row.taskId, row.lateByMs]),
      },
      'mutation-verdict:behavior:operator-reads-list-a-row-once-its-grace-has-run',
    ).toEqual({
      dueUnclaimed: [['p-at', 2_000]],
      sleepingPastWake: [['s-at', 2_000]],
      leaseLapsed: [['l-at', 2_000]],
      cancelOverdue: [['c-at', 2_000]],
    })
    expect(answer.nowMs).toBe(NOW)
    // With no grace, a move that came due at database time itself is listed: the engine
    // takes that row now.
    const atNow = readsAnswering(
      stuck({
        pending: [dueRun('p-now', NOW)],
        sleeping: [dueRun('s-now', NOW)],
        lapsed: [lapsedRun('l-now', NOW)],
        cancels: [overdueTask('c-now', NOW)],
      }),
    )
    const now = await atNow.reads.stuckRuns('q', { graceSeconds: 0, limit: 10 })
    expect(
      [
        listed(now.dueUnclaimed),
        listed(now.sleepingPastWake),
        now.leaseLapsed.rows.map((row) => [row.runId, row.lateByMs]),
        now.cancelOverdue.rows.map((row) => [row.taskId, row.lateByMs]),
      ],
      'mutation-verdict:behavior:operator-reads-list-a-row-once-its-grace-has-run',
    ).toEqual([[['p-now', 0]], [['s-now', 0]], [['l-now', 0]], [['c-now', 0]]])
  })

  it('reads each leg one row past the limit, lists the limit, and says when a leg holds more', async () => {
    const three = [dueRun('a', 1_000), dueRun('b', 2_000), dueRun('c', 3_000)]
    const { reads, args, sent } = readsAnswering(
      stuck({ pending: three, sleeping: three.slice(0, 2), cancels: [overdueTask('t', 1_000)] }),
    )
    const answer = await reads.stuckRuns('q', { graceSeconds: 0, limit: 2 })
    // The limit is each leg's last bind, and it is one more than was asked for.
    expect(
      (args['stuck-runs'] ?? []).map((bound) => bound.at(-1)),
      'mutation-verdict:behavior:operator-reads-read-a-leg-one-row-past-its-limit',
    ).toEqual([3, 3, 3, 3, 3, 3, undefined])
    expect(
      {
        dueUnclaimed: [listed(answer.dueUnclaimed), answer.dueUnclaimed.atLeast],
        sleepingPastWake: [listed(answer.sleepingPastWake), answer.sleepingPastWake.atLeast],
        leaseLapsed: answer.leaseLapsed,
        cancelOverdue: [answer.cancelOverdue.rows.length, answer.cancelOverdue.atLeast],
      },
      'mutation-verdict:behavior:operator-reads-say-when-a-leg-holds-more',
    ).toEqual({
      dueUnclaimed: [
        [
          ['a', 9_000],
          ['b', 8_000],
        ],
        true,
      ],
      sleepingPastWake: [
        [
          ['a', 9_000],
          ['b', 8_000],
        ],
        false,
      ],
      leaseLapsed: { rows: [], atLeast: false },
      cancelOverdue: [1, false],
    })
    // One batch is the snapshot, and the flag of the test clock follows it.
    expect(sent).toEqual(['stuck-runs', 'fake-clock'])
    expect(answer.fakeClock).toBe(false)
  })

  it('lists the due runs a claim refuses in one leg of both states, oldest first, each with its state, and says when it holds more', async () => {
    // Database time is 10,000 and the grace one second. Each state is answered oldest
    // first, as a store answers it, and the leg is the oldest of both.
    const refused = stuck({
      refusedPending: [dueRun('p-old', 1_000), dueRun('p-young', 7_000), dueRun('p-inside', 9_500)],
      refusedSleeping: [dueRun('s-mid', 4_000), dueRun('s-last', 8_000)],
    })
    const leg = async (limit: number) => {
      const answer = await readsAnswering(refused).reads.stuckRuns('q', { graceSeconds: 1, limit })
      return {
        rows: answer.dueNotAdmitted.rows.map((row) => [row.runId, row.state, row.lateByMs]),
        atLeast: answer.dueNotAdmitted.atLeast,
        others: [
          answer.dueUnclaimed,
          answer.sleepingPastWake,
          answer.leaseLapsed,
          answer.cancelOverdue,
        ].map((other) => other.rows.length),
      }
    }
    const oldestThree = [
      ['p-old', 'pending', 9_000],
      ['s-mid', 'sleeping', 6_000],
      ['p-young', 'pending', 3_000],
    ]
    expect(
      await leg(3),
      'mutation-verdict:behavior:operator-reads-merge-the-runs-a-claim-refuses',
    ).toEqual({ rows: oldestThree, atLeast: true, others: [0, 0, 0, 0] })
    // Four have been due for the grace, and the fifth has not.
    expect(await leg(4)).toEqual({
      rows: [...oldestThree, ['s-last', 'sleeping', 2_000]],
      atLeast: false,
      others: [0, 0, 0, 0],
    })
  })

  it('orders a leg oldest first, and rows of one instant by id in code point order', async () => {
    // Answered in the reverse of their order. U+E000 sorts below a character past the
    // basic plane by code point, and above it by UTF-16 unit.
    const { reads } = readsAnswering(
      stuck({
        pending: [
          dueRun('young', 5_000),
          dueRun('\u{10000}', 3_000),
          dueRun('\uE000', 3_000),
          dueRun('old', 1_000),
        ],
      }),
    )
    const answer = await reads.stuckRuns('q', { graceSeconds: 0, limit: 10 })
    expect(
      answer.dueUnclaimed.rows.map((row) => row.runId),
      'mutation-verdict:behavior:operator-reads-order-a-leg-oldest-first',
    ).toEqual(['old', '\uE000', '\u{10000}', 'young'])
  })

  it('says whether a run whose lease lapsed was started under its newest claim', async () => {
    const { reads } = readsAnswering(
      stuck({
        lapsed: [
          lapsedRun('started', 1_000, { claim_gen: 2, activated_gen: 2 }),
          lapsedRun('launch-lost', 2_000, { claim_gen: 2, activated_gen: 1 }),
          lapsedRun('unreadable', 3_000, { claim_gen: -1, activated_gen: 0 }),
        ],
      }),
    )
    const answer = await reads.stuckRuns('q', { graceSeconds: 0, limit: 10 })
    expect(
      answer.leaseLapsed.rows.map((row) => [row.runId, row.activated]),
      'mutation-verdict:behavior:operator-reads-say-whether-a-lapsed-run-was-started',
    ).toEqual([
      ['started', true],
      ['launch-lost', false],
      ['unreadable', null],
    ])
    expect(answer.corrupt).toEqual([
      {
        field: 'runs.claim_gen',
        runId: 'unreadable',
        reason: 'out-of-range',
        stored: 'number',
        value: '-1',
      },
    ])
  })

  it('lists a row whose instant is not readable whatever the grace, with the task or the run that holds it', async () => {
    const { reads } = readsAnswering(
      stuck({
        pending: [dueRun('inside-the-grace', 9_999), dueRun('no-instant', 1.5, { attempt: 0 })],
        cancels: [overdueTask('no-deadline', 'soon'), overdueTask('inside-the-grace', 9_999)],
      }),
    )
    const answer = await reads.stuckRuns('q', { graceSeconds: 5, limit: 10 })
    expect(
      {
        dueUnclaimed: answer.dueUnclaimed.rows,
        cancelOverdue: answer.cancelOverdue.rows,
        corrupt: answer.corrupt,
      },
      'mutation-verdict:behavior:operator-reads-list-a-row-whose-instant-is-not-readable',
    ).toEqual({
      dueUnclaimed: [
        {
          runId: 'no-instant',
          taskId: 'task-of-no-instant',
          taskName: 'job',
          attempt: null,
          dueAtMs: null,
          lateByMs: null,
        },
      ],
      cancelOverdue: [
        {
          taskId: 'no-deadline',
          taskName: 'job',
          state: 'pending',
          runId: 'run-of-no-deadline',
          dueAtMs: null,
          lateByMs: null,
        },
      ],
      corrupt: [
        {
          field: 'runs.attempt',
          runId: 'no-instant',
          reason: 'out-of-range',
          stored: 'number',
          value: '0',
        },
        {
          field: 'runs.available_at_ms',
          runId: 'no-instant',
          reason: 'not-an-exact-integer',
          stored: 'number',
          value: '1.5',
        },
        {
          field: 'tasks.cancel_at_ms',
          taskId: 'no-deadline',
          reason: 'not-an-exact-integer',
          stored: 'string',
        },
      ],
    })
  })

  it('lists every row when database time is not readable, and says so', async () => {
    const { reads } = readsAnswering(stuck({ pending: [dueRun('a', 9_999)] }, [{ now_ms: 1.5 }]), 1)
    const answer = await reads.stuckRuns('q', { graceSeconds: 5, limit: 10 })
    expect({
      nowMs: answer.nowMs,
      fakeClock: answer.fakeClock,
      dueUnclaimed: listed(answer.dueUnclaimed),
      corrupt: answer.corrupt.map((entry) => entry.field),
    }).toEqual({
      nowMs: null,
      fakeClock: true,
      dueUnclaimed: [['a', null]],
      corrupt: ['derived.epoch_ms'],
    })
    // A batch that answers no row for database time is a defect of the dialect, and is thrown.
    await expect(
      readsAnswering(stuck({}, [])).reads.stuckRuns('q', { graceSeconds: 0, limit: 1 }),
    ).rejects.toThrow(/answered no row for database time/)
  })

  it('refuses a grace or a limit it cannot take, before anything is sent', async () => {
    const refused: [unknown, string, string[]][] = []
    for (const options of [
      { graceSeconds: -1, limit: 10 },
      { graceSeconds: Number.NaN, limit: 10 },
      { graceSeconds: Number.POSITIVE_INFINITY, limit: 10 },
      { graceSeconds: 0, limit: 0 },
      { graceSeconds: 0, limit: 1.5 },
      { graceSeconds: 0, limit: OPERATOR_LIST_CAP + 1 },
    ]) {
      const { reads, sent } = readsAnswering(stuck({}))
      const answer = await reads.stuckRuns('q', options).then(
        () => 'accepted',
        (error: unknown) => (error instanceof RangeError ? 'refused' : `another error: ${error}`),
      )
      refused.push([options, answer, sent])
    }
    expect(
      refused.map(([, answer, sent]) => [answer, sent]),
      'mutation-verdict:behavior:operator-reads-refuse-a-limit-past-the-cap',
    ).toEqual(refused.map(() => ['refused', []]))
    // The cap itself is a limit a caller may ask for.
    const atTheCap = readsAnswering(stuck({}))
    await expect(
      atTheCap.reads.stuckRuns('q', { graceSeconds: 0, limit: OPERATOR_LIST_CAP }),
    ).resolves.toMatchObject({ corrupt: [] })
  })
})

/** A live task of a leg, as a store answers it, enqueued at `at`. */
const liveTask = (at: Stored, row: number) => ({
  task_id: `l${row}`,
  task_name: 'job',
  state: 'pending',
  enqueue_at_ms: at,
})

/** `queue-status` answers its seven statements in order: pending, sleeping, running, deadlines, database time, and the two legs of live tasks. */
const status = (legs: {
  pending?: Stored[]
  sleeping?: Stored[]
  running?: Stored[]
  deadlines?: Stored[]
  live?: Stored[]
  moreLive?: Stored[]
}) => ({
  'queue-status': [
    (legs.pending ?? []).map((at, row) => ({ run_id: `p${row}`, available_at_ms: at })),
    (legs.sleeping ?? []).map((at, row) => ({ run_id: `s${row}`, available_at_ms: at })),
    (legs.running ?? []).map((at, row) => ({ run_id: `r${row}`, claim_expires_at_ms: at })),
    (legs.deadlines ?? []).map((at, row) => ({ task_id: `t${row}`, cancel_at_ms: at })),
    [{ now_ms: NOW }],
    (legs.live ?? []).map(liveTask),
    (legs.moreLive ?? []).map((at, row) => ({ ...liveTask(at, row), task_id: `m${row}` })),
  ],
})

const exactly = (count: number) => ({ count, atLeast: false })

describe("how an operator's read of a queue's gauges counts", () => {
  it('counts each leg, and of each the rows whose instant is at or before database time', async () => {
    const { reads, sent } = readsAnswering(
      status({
        pending: [4_000, NOW, NOW + 1],
        sleeping: [7_000, 20_000],
        running: [9_000, NOW, 30_000, 40_000],
        deadlines: [NOW + 1],
      }),
    )
    const answer = await reads.queueStatus('q')
    expect(
      answer.gauges,
      'mutation-verdict:behavior:operator-reads-count-a-row-due-at-its-instant',
    ).toEqual({
      pendingRuns: exactly(3),
      pendingRunsDue: exactly(2),
      sleepingRuns: exactly(2),
      sleepingRunsDue: exactly(1),
      runningRuns: exactly(4),
      runningRunsLapsed: exactly(2),
      tasksWithADeadline: exactly(1),
      tasksPastTheirDeadline: exactly(0),
      liveTasks: exactly(0),
    })
    expect(
      {
        claimLagMs: answer.claimLagMs,
        leaseHeadroomMs: answer.leaseHeadroomMs,
        nextWakeAtMs: answer.nextWakeAtMs,
      },
      'mutation-verdict:behavior:operator-reads-name-the-head-of-the-queue',
    ).toEqual({ claimLagMs: 6_000, leaseHeadroomMs: -1_000, nextWakeAtMs: 4_000 })
    expect({ nowMs: answer.nowMs, fakeClock: answer.fakeClock, corrupt: answer.corrupt }).toEqual({
      nowMs: NOW,
      fakeClock: false,
      corrupt: [],
    })
    expect(sent).toEqual(['queue-status', 'fake-clock'])
  })

  it('answers no lag and no headroom for a queue that holds nothing due and nothing running', async () => {
    const empty = await readsAnswering(status({})).reads.queueStatus('q')
    expect({
      gauges: Object.values(empty.gauges),
      claimLagMs: empty.claimLagMs,
      leaseHeadroomMs: empty.leaseHeadroomMs,
      nextWakeAtMs: empty.nextWakeAtMs,
    }).toEqual({
      gauges: Array.from({ length: 9 }, () => exactly(0)),
      claimLagMs: null,
      leaseHeadroomMs: null,
      nextWakeAtMs: null,
    })
    // A queue whose every run is still to come has a next wake and no lag.
    const ahead = await readsAnswering(
      status({ pending: [NOW + 5], sleeping: [NOW + 9], running: [NOW + 7] }),
    ).reads.queueStatus('q')
    expect({
      claimLagMs: ahead.claimLagMs,
      leaseHeadroomMs: ahead.leaseHeadroomMs,
      nextWakeAtMs: ahead.nextWakeAtMs,
    }).toEqual({ claimLagMs: null, leaseHeadroomMs: 7, nextWakeAtMs: NOW + 5 })
  })

  it('reads each leg one row past the cap, stops each gauge at the cap, and says when more rows exist', async () => {
    const past = OPERATOR_GAUGE_CAP + 1
    // A leg of one row past the cap, all due, and a leg of the same size with the cap due.
    const { reads, args } = readsAnswering(
      status({
        pending: Array.from({ length: past }, () => 1_000),
        sleeping: Array.from({ length: past }, (_, row) =>
          row < OPERATOR_GAUGE_CAP ? 1_000 : NOW + 1,
        ),
        running: Array.from({ length: OPERATOR_GAUGE_CAP }, () => 1_000),
      }),
    )
    const answer = await reads.queueStatus('q')
    expect(
      (args['queue-status'] ?? []).map((bound) => bound.at(-1)),
      'mutation-verdict:behavior:operator-reads-read-a-gauge-one-row-past-its-cap',
    ).toEqual([past, past, past, past, undefined, past, past])
    const capped = { count: OPERATOR_GAUGE_CAP, atLeast: true }
    expect(
      {
        pendingRuns: answer.gauges.pendingRuns,
        pendingRunsDue: answer.gauges.pendingRunsDue,
        sleepingRuns: answer.gauges.sleepingRuns,
        sleepingRunsDue: answer.gauges.sleepingRunsDue,
        runningRuns: answer.gauges.runningRuns,
        runningRunsLapsed: answer.gauges.runningRunsLapsed,
      },
      'mutation-verdict:behavior:operator-reads-stop-a-gauge-at-its-cap',
    ).toEqual({
      pendingRuns: capped,
      pendingRunsDue: capped,
      sleepingRuns: capped,
      sleepingRunsDue: exactly(OPERATOR_GAUGE_CAP),
      runningRuns: exactly(OPERATOR_GAUGE_CAP),
      runningRunsLapsed: exactly(OPERATOR_GAUGE_CAP),
    })
  })

  it('counts a row whose instant is not readable in its leg, in no gauge of an instant, and lists it', async () => {
    const { reads } = readsAnswering(
      status({ pending: [-1, 2_000], running: ['never'], deadlines: [1.5, 3_000] }),
    )
    const answer = await reads.queueStatus('q')
    expect(
      {
        gauges: answer.gauges,
        claimLagMs: answer.claimLagMs,
        leaseHeadroomMs: answer.leaseHeadroomMs,
        nextWakeAtMs: answer.nextWakeAtMs,
        corrupt: answer.corrupt,
      },
      'mutation-verdict:behavior:operator-reads-count-a-row-whose-instant-is-not-readable',
    ).toEqual({
      gauges: {
        pendingRuns: exactly(2),
        pendingRunsDue: exactly(1),
        sleepingRuns: exactly(0),
        sleepingRunsDue: exactly(0),
        runningRuns: exactly(1),
        runningRunsLapsed: exactly(0),
        tasksWithADeadline: exactly(2),
        tasksPastTheirDeadline: exactly(1),
        liveTasks: exactly(0),
      },
      claimLagMs: 8_000,
      leaseHeadroomMs: null,
      nextWakeAtMs: 2_000,
      corrupt: [
        {
          field: 'runs.available_at_ms',
          runId: 'p0',
          reason: 'out-of-range',
          stored: 'number',
          value: '-1',
        },
        {
          field: 'runs.claim_expires_at_ms',
          runId: 'r0',
          reason: 'not-an-exact-integer',
          stored: 'string',
        },
        {
          field: 'tasks.cancel_at_ms',
          taskId: 't0',
          reason: 'not-an-exact-integer',
          stored: 'number',
          value: '1.5',
        },
      ],
    })
  })
})

describe("how an operator's count of a queue's rows is read", () => {
  /** `table-rows` answers one count for each table, in the order core names the tables. */
  const counts = (counted: Stored[]) => ({
    'table-rows': counted.map((row_count) => [{ row_count }]),
  })

  it('answers each count as a number, a bigint among them, and stops it at the cap', async () => {
    const cap = OPERATOR_TABLE_ROWS_CAP
    const { reads, sent, args } = readsAnswering(counts([0, 7n, cap, cap + 1, 3]))
    const answer = await reads.tableRows('q')
    expect(QUEUE_TABLES).toEqual(['runs', 'tasks', 'waits', 'events', 'checkpoints'])
    expect(answer, 'mutation-verdict:behavior:operator-reads-stop-a-count-at-its-cap').toEqual({
      cap,
      tables: {
        runs: exactly(0),
        tasks: exactly(7),
        waits: exactly(cap),
        events: { count: cap, atLeast: true },
        checkpoints: exactly(3),
      },
    })
    // Each statement binds the queue and one row past the cap, and no clock is asked for.
    expect(args['table-rows']).toEqual(QUEUE_TABLES.map(() => ['q', cap + 1]))
    expect(sent).toEqual(['table-rows'])
  })

  it('refuses a count that is no integer in the range of its statement', async () => {
    const refused: string[] = []
    for (const bad of ['5', 1.5, -1, OPERATOR_TABLE_ROWS_CAP + 2, null]) {
      const answer = await readsAnswering(counts([0, bad, 0, 0, 0]))
        .reads.tableRows('q')
        .then(
          () => 'accepted',
          (error: unknown) => (error instanceof RangeError ? error.message : `another: ${error}`),
        )
      refused.push(answer)
    }
    expect(
      refused,
      'mutation-verdict:behavior:operator-reads-refuse-a-count-that-is-no-integer',
    ).toEqual(
      refused.map(
        () => `table-rows tasks must count an integer from 0 to ${OPERATOR_TABLE_ROWS_CAP + 1}`,
      ),
    )
    // A statement that answers no row at all is refused the same way.
    await expect(readsAnswering({}).reads.tableRows('q')).rejects.toThrow(/table-rows runs/)
  })
})

describe("how an operator's read of an event's waiters is read", () => {
  const waiter = (
    task_id: string,
    run_id: string,
    step_name: string,
    timeout_at_ms: Stored = null,
  ) => ({
    task_id,
    run_id,
    step_name,
    timeout_at_ms,
  })

  it('lists the waiters in the order the statement answered them, and a timeout outside its bounds as corrupt', async () => {
    // By run and then step, as the statement orders them. The tasks are in no order.
    const { reads, sent, args } = readsAnswering({
      'event-waiters': [
        [
          waiter('t2', 'r1', 'a', 5_000),
          waiter('t1', 'r2', 'a'),
          waiter('t1', 'r2', 'b', -1),
          waiter('t0', 'r9', 'z', 7n),
        ],
      ],
    })
    const answer = await reads.eventWaiters('q', 'approval')
    expect(answer, 'mutation-verdict:behavior:operator-reads-order-the-waiters').toEqual({
      waiters: {
        rows: [
          { taskId: 't2', runId: 'r1', stepName: 'a', timeoutAtMs: 5_000 },
          { taskId: 't1', runId: 'r2', stepName: 'a', timeoutAtMs: null },
          { taskId: 't1', runId: 'r2', stepName: 'b', timeoutAtMs: null },
          { taskId: 't0', runId: 'r9', stepName: 'z', timeoutAtMs: 7 },
        ],
        atLeast: false,
      },
      corrupt: [
        {
          field: 'waits.timeout_at_ms',
          runId: 'r2',
          stepName: 'b',
          reason: 'out-of-range',
          stored: 'number',
          value: '-1',
        },
      ],
    })
    expect(args['event-waiters']).toEqual([['q', 'approval', OPERATOR_GAUGE_CAP + 1]])
    expect(sent).toEqual(['event-waiters'])
  })

  it('stops the list at the cap, keeps the first of what was answered, and says when more waits exist', async () => {
    // Answered with the tasks in descending order, so a list sorted by task before it is
    // cut keeps another thousand than the first.
    const many = (count: number) =>
      Array.from({ length: count }, (_, row) =>
        waiter(`t${String(count - row).padStart(4, '0')}`, `r${String(row).padStart(4, '0')}`, 's'),
      )
    const past = await readsAnswering({
      'event-waiters': [many(OPERATOR_GAUGE_CAP + 1)],
    }).reads.eventWaiters('q', 'e')
    const at = await readsAnswering({
      'event-waiters': [many(OPERATOR_GAUGE_CAP)],
    }).reads.eventWaiters('q', 'e')
    expect(
      [past.waiters.rows.length, past.waiters.atLeast, at.waiters.rows.length, at.waiters.atLeast],
      'mutation-verdict:behavior:operator-reads-stop-the-waiters-at-the-cap',
    ).toEqual([OPERATOR_GAUGE_CAP, true, OPERATOR_GAUGE_CAP, false])
    // The thousand it keeps are the first of what was answered, in the order answered.
    expect(past.waiters.rows.map((row) => row.taskId)).toEqual(
      many(OPERATOR_GAUGE_CAP + 1)
        .slice(0, OPERATOR_GAUGE_CAP)
        .map((row) => row.task_id),
    )
  })
})

describe("how an operator's read of a queue's gauges counts its live tasks", () => {
  it('counts the live tasks of every leg, and dates the oldest', async () => {
    const { reads } = readsAnswering(
      status({ live: [NOW - 9_000, NOW - 2_000], moreLive: [NOW - 4_000, NOW, NOW + 50] }),
    )
    const answer = await reads.queueStatus('q')
    expect(
      { liveTasks: answer.gauges.liveTasks, oldestLiveTaskAgeMs: answer.oldestLiveTaskAgeMs },
      'mutation-verdict:behavior:operator-reads-count-the-live-tasks-of-every-leg',
    ).toEqual({ liveTasks: exactly(5), oldestLiveTaskAgeMs: 9_000 })
    // The live tasks are in no gauge of runs, and they move no instant of the queue's head.
    expect({
      pendingRuns: answer.gauges.pendingRuns,
      claimLagMs: answer.claimLagMs,
      nextWakeAtMs: answer.nextWakeAtMs,
    }).toEqual({ pendingRuns: exactly(0), claimLagMs: null, nextWakeAtMs: null })
    const empty = await readsAnswering(status({})).reads.queueStatus('q')
    expect({
      liveTasks: empty.gauges.liveTasks,
      oldestLiveTaskAgeMs: empty.oldestLiveTaskAgeMs,
    }).toEqual({ liveTasks: exactly(0), oldestLiveTaskAgeMs: null })
  })

  it('stops the gauge of live tasks at its cap, over the legs together', async () => {
    const half = OPERATOR_GAUGE_CAP / 2
    const atTheCap = await readsAnswering(
      status({
        live: Array.from({ length: half }, () => 1_000),
        moreLive: Array.from({ length: half }, () => 2_000),
      }),
    ).reads.queueStatus('q')
    const past = await readsAnswering(
      status({
        live: Array.from({ length: half }, () => 1_000),
        moreLive: Array.from({ length: half + 1 }, () => 2_000),
      }),
    ).reads.queueStatus('q')
    expect(
      [atTheCap.gauges.liveTasks, past.gauges.liveTasks],
      'mutation-verdict:behavior:operator-reads-stop-the-gauge-of-live-tasks-at-its-cap',
    ).toEqual([exactly(OPERATOR_GAUGE_CAP), { count: OPERATOR_GAUGE_CAP, atLeast: true }])
  })

  it('counts a live task whose enqueue instant is not readable, lists it, and dates the oldest from the rest', async () => {
    const answer = await readsAnswering(
      status({ live: ['long ago', NOW - 3_000] }),
    ).reads.queueStatus('q')
    expect(
      {
        liveTasks: answer.gauges.liveTasks,
        oldestLiveTaskAgeMs: answer.oldestLiveTaskAgeMs,
        corrupt: answer.corrupt,
      },
      'mutation-verdict:behavior:operator-reads-count-a-live-task-whose-instant-is-not-readable',
    ).toEqual({
      liveTasks: exactly(2),
      oldestLiveTaskAgeMs: 3_000,
      corrupt: [
        {
          field: 'tasks.enqueue_at_ms',
          taskId: 'l0',
          reason: 'not-an-exact-integer',
          stored: 'string',
        },
      ],
    })
  })
})

/** `aged-tasks` answers its three statements in order: the two legs of live tasks, and database time. */
const aged = (first: [string, Stored][], second: [string, Stored][] = [], nowMs: Stored = NOW) => {
  const leg = (rows: [string, Stored][]) =>
    rows.map(([taskId, at]) => ({
      task_id: taskId,
      task_name: 'job',
      state: 'sleeping',
      enqueue_at_ms: at,
    }))
  return { 'aged-tasks': [leg(first), leg(second), [{ now_ms: nowMs }]] }
}

describe("how an operator's read of a queue's oldest live tasks is read", () => {
  it('lists a task from the instant it is as old as asked, with its age, and not a millisecond before', async () => {
    const rows: [string, Stored][] = [
      ['a', NOW - 5_000],
      ['b', NOW - 1_000],
      ['c', NOW],
    ]
    const asOldAs = async (olderThanSeconds: number) => {
      const { reads } = readsAnswering(aged(rows))
      const answer = await reads.agedTasks('q', { olderThanSeconds, limit: 20 })
      return answer.tasks.rows.map((task) => [task.taskId, task.ageMs])
    }
    expect(
      {
        any: await asOldAs(0),
        aSecond: await asOldAs(1),
        aMillisecondMore: await asOldAs(1.001),
        fiveSeconds: await asOldAs(5),
        more: await asOldAs(5.001),
      },
      'mutation-verdict:behavior:operator-reads-list-a-task-once-it-is-as-old-as-asked',
    ).toEqual({
      any: [
        ['a', 5_000],
        ['b', 1_000],
        ['c', 0],
      ],
      aSecond: [
        ['a', 5_000],
        ['b', 1_000],
      ],
      aMillisecondMore: [['a', 5_000]],
      fiveSeconds: [['a', 5_000]],
      more: [],
    })
    const { reads, sent } = readsAnswering(aged(rows), 1)
    expect(await reads.agedTasks('q', { olderThanSeconds: 5, limit: 20 })).toEqual({
      nowMs: NOW,
      fakeClock: true,
      tasks: {
        rows: [
          {
            taskId: 'a',
            taskName: 'job',
            state: 'sleeping',
            enqueueAtMs: NOW - 5_000,
            ageMs: 5_000,
          },
        ],
        atLeast: false,
      },
      corrupt: [],
    })
    expect(sent).toEqual(['aged-tasks', 'fake-clock'])
  })

  it('merges the legs oldest first, and tasks of one instant by id in code point order', async () => {
    const { reads } = readsAnswering(
      aged(
        [
          ['t3', 100],
          ['t1', 300],
        ],
        [
          ['t2', 100],
          ['t0', 200],
          ['\u{1F600}', 100],
          ['\uFFFD', 100],
        ],
      ),
    )
    const answer = await reads.agedTasks('q', { olderThanSeconds: 0, limit: 20 })
    expect(
      answer.tasks.rows.map((task) => task.taskId),
      'mutation-verdict:behavior:operator-reads-merge-the-live-legs-oldest-first',
    ).toEqual(['t2', 't3', '\uFFFD', '\u{1F600}', 't0', 't1'])
  })

  it('reads each leg one row past the limit, lists the limit across the legs, and says when more are as old', async () => {
    const leg = (prefix: string, at: number): [string, Stored][] => [
      [`${prefix}0`, at],
      [`${prefix}1`, at + 1],
      [`${prefix}2`, at + 2],
    ]
    const { reads, args } = readsAnswering(aged(leg('x', 100), leg('y', 50)))
    const answer = await reads.agedTasks('q', { olderThanSeconds: 0, limit: 2 })
    expect(
      (args['aged-tasks'] ?? []).map((bound) => bound.at(-1)),
      'mutation-verdict:behavior:operator-reads-read-a-live-leg-one-row-past-its-limit',
    ).toEqual([3, 3, undefined])
    expect(
      { rows: answer.tasks.rows.map((task) => task.taskId), atLeast: answer.tasks.atLeast },
      'mutation-verdict:behavior:operator-reads-say-when-more-tasks-are-as-old',
    ).toEqual({ rows: ['y0', 'y1'], atLeast: true })
    // Exactly the limit across the legs holds no more.
    const exact = await readsAnswering(aged([['p', 1]], [['q', 2]])).reads.agedTasks('q', {
      olderThanSeconds: 0,
      limit: 2,
    })
    expect({ rows: exact.tasks.rows.length, atLeast: exact.tasks.atLeast }).toEqual({
      rows: 2,
      atLeast: false,
    })
  })

  it('lists a task whose enqueue instant is not readable however old was asked, with no age, and names it', async () => {
    const { reads } = readsAnswering(
      aged([
        ['young', NOW],
        ['broken', 1.5],
      ]),
    )
    const answer = await reads.agedTasks('q', { olderThanSeconds: 3600, limit: 20 })
    expect(
      { rows: answer.tasks.rows, corrupt: answer.corrupt },
      'mutation-verdict:behavior:operator-reads-list-a-task-whose-enqueue-instant-is-not-readable',
    ).toEqual({
      rows: [
        { taskId: 'broken', taskName: 'job', state: 'sleeping', enqueueAtMs: null, ageMs: null },
      ],
      corrupt: [
        {
          field: 'tasks.enqueue_at_ms',
          taskId: 'broken',
          reason: 'not-an-exact-integer',
          stored: 'number',
          value: '1.5',
        },
      ],
    })
    // With no database time nothing says a task is younger than asked, so every one is listed.
    const undated = await readsAnswering(aged([['young', NOW]], [], 'now')).reads.agedTasks('q', {
      olderThanSeconds: 3600,
      limit: 20,
    })
    expect({
      nowMs: undated.nowMs,
      rows: undated.tasks.rows.map((task) => [task.taskId, task.ageMs]),
      corrupt: undated.corrupt.map((entry) => entry.field),
    }).toEqual({ nowMs: null, rows: [['young', null]], corrupt: ['derived.epoch_ms'] })
  })

  it('refuses an age or a limit it cannot take, before anything is sent', async () => {
    const refused: unknown[] = []
    for (const options of [
      { olderThanSeconds: -1, limit: 20 },
      { olderThanSeconds: Number.NaN, limit: 20 },
      { olderThanSeconds: 0, limit: 0 },
      { olderThanSeconds: 0, limit: 1.5 },
      { olderThanSeconds: 0, limit: OPERATOR_LIST_CAP + 1 },
    ]) {
      const { reads, sent } = readsAnswering(aged([]))
      const answer = await reads.agedTasks('q', options).then(
        () => 'accepted',
        (error: unknown) => (error instanceof RangeError ? 'refused' : `another error: ${error}`),
      )
      refused.push([answer, sent])
    }
    expect(
      refused,
      'mutation-verdict:behavior:operator-reads-refuse-an-age-or-a-limit-it-cannot-take',
    ).toEqual(refused.map(() => ['refused', []]))
  })
})
