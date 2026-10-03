import { createHash } from 'node:crypto'
import { DEFAULT_MAX_ATTEMPTS, type TaskFacts } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { COMMANDS, usage } from '../src/commands.js'
import { factsView, whatIsNotReadable } from '../src/inspect.js'
import { userValue } from '../src/render.js'
import {
  COMPLETED_KEY,
  NOW_MS,
  QUEUE,
  SENTINEL,
  claimActivated,
  openCliDb,
  recordingOpener,
  runCli,
  seedTasks,
} from './support.js'

/** An answer printed with --json. */
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>

/** Text no schema's check lets a state or a status hold. */
const ROGUE = `rogue-${SENTINEL}`

/**
 * A task's facts as the view is given them, holding the three stored texts every schema
 * checks. No row a store wrote holds another, so a case that needs one builds the facts.
 */
function factsHolding(
  stored: { task: string; run: string; wait: string },
  outcome: TaskFacts['outcome'] = { result: { state: 'pending' } },
): TaskFacts {
  return {
    nowMs: NOW_MS,
    fakeClock: true,
    task: {
      taskId: 't',
      queue: QUEUE,
      taskName: 'report',
      state: stored.task,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      infraRetries: 0,
      enqueueAtMs: NOW_MS,
      firstStartedAtMs: null,
      cancelAtMs: null,
      idempotencyKey: null,
      parentTaskId: null,
      sagaBegan: false,
    },
    outcome,
    runs: [
      {
        runId: 'r',
        queue: QUEUE,
        state: stored.run,
        attempt: 1,
        claimGen: 0,
        activatedGen: 0,
        relaunchCount: 0,
        claimExpiresAtMs: null,
        heartbeatAtMs: null,
        availableAtMs: NOW_MS,
        wakeEvent: null,
        wakeStep: null,
        startedAtMs: null,
        completedAtMs: null,
        failedAtMs: null,
      },
    ],
    waits: [
      {
        runId: 'r',
        stepName: 's',
        eventName: 'e',
        status: stored.wait,
        timeoutAtMs: null,
        createdAtMs: NOW_MS,
      },
    ],
    events: [],
    corrupt: [],
  }
}

/**
 * `inspect` on libSQL. cli-dialects.test.ts holds its answers equal on every selected
 * dialect, and the operator-reads conformance surface holds the facts themselves.
 */
describe('inspect on libSQL', () => {
  it('prints one snapshot of a task: its row, its outcome, its runs, its waits and the events they name', async () => {
    const db = await openCliDb('libsql', 'inspect-snapshot')
    try {
      const seeded = await seedTasks(db)
      const run = await runCli(['inspect', seeded.pending, '--queue', QUEUE, '--json'], db.env)
      expect(run.exit, run.stdout).toBe(0)
      const { dialect: _dialect, runs, ...answer } = parsed(run.stdout)
      expect(answer).toEqual({
        command: 'inspect',
        exit: 'done',
        queue: QUEUE,
        taskId: seeded.pending,
        databaseNowEpochMs: NOW_MS,
        fakeClock: true,
        task: {
          taskName: 'report',
          state: 'pending',
          attempts: 0,
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          infraRetries: 0,
          // The task was enqueued with a start an hour off.
          enqueueAtMs: NOW_MS + 3_600_000,
          firstStartedAtMs: null,
          cancelAtMs: null,
          idempotencyKey: null,
          parentTaskId: null,
          sagaBegan: false,
        },
        outcome: { state: 'pending' },
        waits: [],
        events: [],
        corrupt: [],
      })
      expect(runs).toMatchObject([
        { state: 'pending', attempt: 1, claimGen: 0, availableAtMs: NOW_MS + 3_600_000 },
      ])
      // Human text names every field on a line of its own.
      const text = await runCli(['inspect', seeded.pending, '--queue', QUEUE], db.env)
      expect(text.exit).toBe(0)
      expect(text.stdout).toContain('  state: pending\n')
      expect(text.stdout).toContain('corrupt: (none)\n')
    } finally {
      await db.close()
    }
  })

  it('finds a task by its idempotency key, and prints the key as its length and sha256', async () => {
    const db = await openCliDb('libsql', 'inspect-key')
    try {
      const seeded = await seedTasks(db)
      const byId = await runCli(['inspect', seeded.completed, '--queue', QUEUE, '--json'], db.env)
      const byKey = await runCli(
        ['inspect', '--key', COMPLETED_KEY, '--queue', QUEUE, '--json'],
        db.env,
      )
      expect(byKey.exit, byKey.stdout).toBe(0)
      expect(byKey.stdout).toBe(byId.stdout)
      const task = parsed(byKey.stdout).task as Record<string, unknown>
      expect(task.idempotencyKey).toEqual({
        bytes: Buffer.byteLength(COMPLETED_KEY),
        sha256: createHash('sha256').update(COMPLETED_KEY).digest('hex'),
      })
      const revealed = await runCli(
        ['inspect', '--key', COMPLETED_KEY, '--queue', QUEUE, '--json', '--reveal'],
        db.env,
      )
      expect(
        (parsed(revealed.stdout).task as { idempotencyKey: { text?: string } }).idempotencyKey.text,
      ).toBe(COMPLETED_KEY)
    } finally {
      await db.close()
    }
  })

  it('exits 8 for a task or a key the queue does not hold, and does not print the key', async () => {
    const db = await openCliDb('libsql', 'inspect-absent')
    try {
      await seedTasks(db)
      const byId = await runCli(['inspect', 'no-such-task', '--queue', QUEUE, '--json'], db.env)
      expect({ exit: byId.exit, error: parsed(byId.stdout).error }).toEqual({
        exit: 8,
        error: { kind: 'not-found', message: `no task no-such-task in queue ${QUEUE}` },
      })
      for (const extra of [[], ['--reveal']]) {
        const byKey = await runCli(
          ['inspect', '--key', `absent-${SENTINEL}`, '--queue', QUEUE, '--json', ...extra],
          db.env,
        )
        expect({ exit: byKey.exit, printed: byKey.stdout.includes(SENTINEL) }).toEqual({
          exit: 8,
          printed: false,
        })
      }
      // An answer that read nothing prints on stderr in text, and nothing on stdout.
      const text = await runCli(['inspect', 'no-such-task', '--queue', QUEUE], db.env)
      expect({
        exit: text.exit,
        stdout: text.stdout,
        said: text.stderr.includes(`no task no-such-task in queue ${QUEUE}`),
      }).toEqual({ exit: 8, stdout: '', said: true })
      // The key finds a task of its own queue alone.
      const elsewhere = await runCli(
        ['inspect', '--key', COMPLETED_KEY, '--queue', 'another-queue', '--json'],
        db.env,
      )
      expect(elsewhere.exit).toBe(8)
    } finally {
      await db.close()
    }
  })

  it('prints a corrupt row where it stands and exits 10, so a script does not read it as a clean answer', async () => {
    const db = await openCliDb('libsql', 'inspect-corrupt')
    try {
      const seeded = await seedTasks(db)
      const clean = parsed(
        (await runCli(['inspect', seeded.pending, '--queue', QUEUE, '--json'], db.env)).stdout,
      )
      // Fixture-built: a claim generation no engine path writes.
      await db.raw.batch('fixture:corrupt', [
        { sql: 'UPDATE runs SET claim_gen = -3 WHERE task_id = ?', args: [seeded.pending] },
      ])
      const run = await runCli(['inspect', seeded.pending, '--queue', QUEUE, '--json'], db.env)
      const answer = parsed(run.stdout)
      const [cleanRun] = clean.runs as Record<string, unknown>[]
      expect(
        { exit: run.exit, named: answer.exit, corrupt: answer.corrupt, runs: answer.runs },
        'mutation-verdict:behavior:cli-inspect-exits-10-for-a-corrupt-row',
      ).toEqual({
        exit: 10,
        named: 'unreadable',
        corrupt: [
          {
            field: 'runs.claim_gen',
            runId: cleanRun?.runId,
            reason: 'out-of-range',
            stored: 'number',
            value: '-3',
          },
        ],
        // Every other fact prints as it did, and the corrupt one reads as null.
        runs: [{ ...cleanRun, claimGen: null }],
      })
      expect({ ...answer, exit: 'done', corrupt: [], runs: clean.runs }).toEqual(clean)
    } finally {
      await db.close()
    }
  })

  it('prints the snapshot on stdout in text as it does with --json, whatever it exits with', async () => {
    const db = await openCliDb('libsql', 'inspect-corrupt-text')
    try {
      const seeded = await seedTasks(db)
      // Fixture-built: a claim generation no engine path writes.
      await db.raw.batch('fixture:corrupt', [
        { sql: 'UPDATE runs SET claim_gen = -3 WHERE task_id = ?', args: [seeded.pending] },
      ])
      const run = await runCli(['inspect', seeded.pending, '--queue', QUEUE], db.env)
      expect(
        {
          exit: run.exit,
          stderr: run.stderr,
          theTask: run.stdout.includes('  state: pending\n'),
          theCorruptField: run.stdout.includes('runs.claim_gen'),
        },
        'mutation-verdict:behavior:cli-inspect-prints-a-snapshot-on-stdout',
      ).toEqual({ exit: 10, stderr: '', theTask: true, theCorruptField: true })
    } finally {
      await db.close()
    }
  })

  it("prints a state or a status that is not one of the engine's own as a hidden value unless --reveal", () => {
    // Every schema checks these columns, so no row a store wrote holds such a value, and the
    // view is given the facts directly.
    const rogue = ROGUE
    const facts = factsHolding(
      { task: rogue, run: rogue, wait: rogue },
      { refused: `task t has unknown state ${rogue}` },
    )
    const shown = (given: TaskFacts, reveal: boolean) => {
      const view = factsView(given, {}, reveal) as unknown as {
        task: { state: unknown }
        runs: { state: unknown }[]
        waits: { status: unknown }[]
      }
      return { task: view.task.state, run: view.runs[0]?.state, wait: view.waits[0]?.status }
    }
    const hidden = userValue(rogue, false)
    expect(
      shown(facts, false),
      'mutation-verdict:behavior:cli-inspect-hides-an-unknown-state',
    ).toEqual({ task: hidden, run: hidden, wait: hidden })
    expect(JSON.stringify(hidden)).not.toContain(SENTINEL)
    const revealed = userValue(rogue, true)
    expect(shown(facts, true)).toEqual({ task: revealed, run: revealed, wait: revealed })
    // One of the engine's own prints as it is.
    const known: TaskFacts = {
      ...facts,
      task: { ...facts.task, state: 'cancelled' },
      runs: facts.runs.map((run) => ({ ...run, state: 'sleeping' })),
      waits: facts.waits.map((wait) => ({ ...wait, status: 'delivered' })),
    }
    expect(shown(known, false)).toEqual({ task: 'cancelled', run: 'sleeping', wait: 'delivered' })
  })

  it("exits 10 for a run's state or a wait's status that is not one of the engine's own", async () => {
    const db = await openCliDb('libsql', 'inspect-rogue-state')
    try {
      const seeded = await seedTasks(db)
      // Fixture-built: the schema's check refuses such a state, so it is set aside for the
      // one statement that plants it.
      await db.raw.batch('fixture:rogue', [
        { sql: 'PRAGMA ignore_check_constraints = ON', args: [] },
        { sql: "UPDATE runs SET state = 'rogue-state' WHERE task_id = ?", args: [seeded.pending] },
        { sql: 'PRAGMA ignore_check_constraints = OFF', args: [] },
      ])
      const run = await runCli(['inspect', seeded.pending, '--queue', QUEUE, '--json'], db.env)
      const answer = parsed(run.stdout)
      expect(
        { exit: run.exit, named: answer.exit, outcome: answer.outcome, corrupt: answer.corrupt },
        'mutation-verdict:behavior:cli-inspect-exits-10-for-an-unknown-run-state',
      ).toEqual({ exit: 10, named: 'unreadable', outcome: { state: 'pending' }, corrupt: [] })
    } finally {
      await db.close()
    }
    // A wait's status, on facts given directly: the seeded tasks register no wait.
    const own = { task: 'pending', run: 'sleeping', wait: 'waiting' }
    expect(
      {
        own: whatIsNotReadable(factsHolding(own)).length === 0,
        rogueWait: whatIsNotReadable(factsHolding({ ...own, wait: ROGUE })).length === 0,
      },
      'mutation-verdict:behavior:cli-inspect-exits-10-for-an-unknown-wait-status',
    ).toEqual({ own: true, rogueWait: false })
  })

  it('takes a task id or --key, one of them and not both, and refuses each other line before a store opens', async () => {
    expect(usage(COMMANDS.inspect)).toBe(
      'inspect (<taskId> | --key <K>) [--json] --queue <Q> [--reveal]',
    )
    // A pair that names a flag the command does not have is refused, never dropped.
    expect(() =>
      usage({ ...COMMANDS.inspect, alternative: { positional: 'taskId', flag: 'kye' } }),
    ).toThrow(/its alternative must name one of its arguments and one of its string flags/)
    const { opener, sent } = recordingOpener()
    for (const argv of [
      ['inspect', '--queue', QUEUE],
      ['inspect', 'a-task', '--key', 'a-key', '--queue', QUEUE],
      ['inspect', 'a-task', 'another-task', '--queue', QUEUE],
      ['inspect', 'a-task'],
    ]) {
      const run = await runCli([...argv, '--json'], { DURABLERUN_STORE_URL: ':memory:' }, opener)
      expect({ argv: argv.length, exit: run.exit, error: parsed(run.stdout).error }).toMatchObject({
        argv: argv.length,
        exit: 2,
        error: { kind: 'usage' },
      })
    }
    expect(sent()).toEqual([])
  })

  it("prints the parent a child's key names, and the key itself as its length and sha256", async () => {
    const db = await openCliDb('libsql', 'inspect-child')
    try {
      const parent = await db.store.spawn(QUEUE, 'parent', '{}')
      const run = await claimActivated(db, 'w-parent', parent.taskId)
      const child = await db.store.spawn(QUEUE, 'child', '{}', {
        childOf: {
          parentQueue: QUEUE,
          parentTaskId: parent.taskId,
          runId: run.runId,
          claimToken: run.claimToken,
          replayKey: 'charge-card',
        },
      })
      const answer = parsed(
        (await runCli(['inspect', child.taskId, '--queue', QUEUE, '--json'], db.env)).stdout,
      )
      expect(answer.task).toMatchObject({
        taskName: 'child',
        parentTaskId: parent.taskId,
        idempotencyKey: {
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      })
      expect(JSON.stringify(answer.task)).not.toContain('charge-card')
    } finally {
      await db.close()
    }
  })
})
