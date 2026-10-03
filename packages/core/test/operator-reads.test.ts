import { describe, expect, it } from 'vitest'
import {
  InvalidDurableStringError,
  OPERATOR_READ_METHODS,
  OPERATOR_READ_STRINGS,
  type OperatorReadsDialect,
  PORT_STRING_RULES,
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
function readsAnswering(answers: Readonly<Record<string, SqlRow[][]>>, fakeClock: unknown = 0) {
  const sent: string[] = []
  const executor: SqlExecutor = {
    batch: async (label, statements) => {
      sent.push(label)
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
    },
    fakeClock: async () => {
      sent.push('fake-clock')
      return fakeClock
    },
    sagaBegan: sqlFragment('1 = 0'),
    rollbackOutcome: sqlFragment('NULL'),
    rollbackError: sqlFragment('NULL'),
  }
  return { reads: createOperatorReads(dialect), sent }
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
} as const

describe("the strings an operator's read carries", () => {
  it('names every string of every method of the port, each under a rule of the port table', () => {
    expect(Object.keys(OPERATOR_READ_STRINGS)).toEqual(Object.keys(CALLS))
    expect(OPERATOR_READ_METHODS).toEqual(Object.keys(CALLS))
    for (const method of OPERATOR_READ_METHODS) {
      expect(OPERATOR_READ_STRINGS[method].length).toBe(CALLS[method].length)
      for (const name of OPERATOR_READ_STRINGS[method]) {
        expect(PORT_STRING_RULES[name], `${method}: ${name}`).toBe('identifier')
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
          ['string', 'string', 'undefined', 'number'].map((bad) => ({
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
