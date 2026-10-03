import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_ATTEMPTS,
  SAGA_STARTED_PREFIX,
  type TaskFacts,
  taskDoneEventName,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandSpec, parseInvocation, usage } from '../src/commands.js'
import {
  ARMS,
  CAUSES,
  CHILD_HOPS,
  type Cause,
  DUE_GRACE_MS,
  type Diagnosis,
  HUNG_RUN_MS,
  VERDICTS,
  type Verdict,
  diagnose,
  pastedLine,
  suggestion,
} from '../src/explain.js'
import type { StoreOpener } from '../src/open-store.js'
import {
  EXPLAIN_SEEDS,
  type ExplainSeed,
  asleep,
  chainOfAwaits,
  fixture,
  onSeed,
  seedWorld,
} from './explain-seeds.js'
import {
  type CliDb,
  NOW_MS,
  QUEUE,
  SENTINEL,
  claimActivated,
  openCliDb,
  openerWrapping,
  recordingOpener,
  runCli,
} from './support.js'

const DESIGN = fileURLToPath(new URL('../../../DESIGN.md', import.meta.url))

/** DESIGN.md section 3.11, the operator CLI. */
function designSection(): string {
  const text = readFileSync(DESIGN, 'utf8')
  const start = text.indexOf('### 3.11 The operator CLI')
  expect(start, 'DESIGN.md has section 3.11').toBeGreaterThan(0)
  return text.slice(start, text.indexOf('\n### 3.12', start))
}

/** What `explain --json` printed, with the exit it ended in. */
interface Answer {
  readonly exit: number
  readonly cause: Cause
  readonly verdict: Verdict
  readonly nextTransitionAtMs: number | null
  readonly databaseNowEpochMs: number
  readonly facts: Readonly<Record<string, unknown>>
  readonly next: { readonly argv: string[]; readonly command: string } | null
  readonly deepest?: { readonly taskId: string; readonly cause: Cause; readonly verdict: Verdict }
  readonly awaits?: Answer & { readonly taskId: string }
}

/** Run `explain --json` of one task, through an opener of the test's own when it gives one. */
async function explain(db: CliDb, taskId: string, opener?: StoreOpener): Promise<Answer> {
  const run = await runCli(['explain', taskId, '--queue', QUEUE, '--json'], db.env, opener)
  return { ...(JSON.parse(run.stdout) as Answer), exit: run.exit }
}

function seedOf(cause: Cause): ExplainSeed {
  const seed = EXPLAIN_SEEDS.find((one) => one.cause === cause)
  if (seed === undefined) throw new Error(`no seed for ${cause}`)
  return seed
}

/** The causes whose verdict turns on how late the instant they name is. */
const LATE = EXPLAIN_SEEDS.filter((seed) => CAUSES[seed.cause].verdict === 'late')

describe('explain on libSQL', () => {
  it("DESIGN.md's cause table is the one in the code, with its three constants", () => {
    const section = designSection()
    const rows = section
      .split('\n')
      .map((line) =>
        /^\| ([a-z0-9-]+) \| (ok|waiting|stuck|inconsistent|unexplained|late|child) \| ([a-z]+) \| (.+) \|$/.exec(
          line,
        ),
      )
      .filter((match) => match !== null)
      .map(([, cause, verdict, next, meaning]) => ({ cause, verdict, next, meaning }))
    expect(rows).toEqual(
      Object.entries(CAUSES).map(([cause, spec]) => ({
        cause,
        verdict: spec.verdict,
        next: spec.next ?? 'none',
        meaning: spec.meaning,
      })),
    )
    // The causes are asked in the table's order, and `unexplained` is what is left.
    expect(Object.keys(ARMS)).toEqual(
      Object.keys(CAUSES).filter((cause) => cause !== 'unexplained'),
    )
    expect(section).toContain(`\`DUE_GRACE_MS\`, ${DUE_GRACE_MS / 1000} seconds`)
    expect(section).toContain(`\`HUNG_RUN_MS\`, ${HUNG_RUN_MS / 60_000} minutes`)
    expect(section).toContain(`\`CHILD_HOPS\`, ${CHILD_HOPS} awaits`)
  })

  it('has one seed for every cause of the table, and a seed no engine path reaches says it is fixture-built', () => {
    expect(EXPLAIN_SEEDS.map((seed) => seed.cause).sort()).toEqual(Object.keys(CAUSES).sort())
    for (const seed of EXPLAIN_SEEDS) {
      const rule = CAUSES[seed.cause].verdict
      // A cause with a verdict of its own is seeded at that verdict.
      if (rule !== 'late' && rule !== 'child') {
        expect({ cause: seed.cause, verdict: seed.verdict }).toEqual({
          cause: seed.cause,
          verdict: rule,
        })
      }
    }
    // These six say in their names that fixture SQL built them. Every other seed reaches its
    // state through the store's ports alone.
    expect(
      EXPLAIN_SEEDS.filter((seed) => seed.name.includes('fixture-built')).map((seed) => seed.cause),
    ).toEqual([
      'wait-outlives-its-event',
      'unreadable',
      'terminal-task-with-a-live-run',
      'live-task-without-one-live-run',
      'task-and-run-states-differ',
      'unexplained',
    ])
  })

  it('the six healthy controls never come back stuck', async () => {
    const controls = EXPLAIN_SEEDS.filter((seed) => seed.control !== undefined)
    expect(controls.map((seed) => seed.control)).toEqual([
      'a live lease',
      'a start delay',
      'a task enqueued ahead of the build that registers it',
      'a timed await inside its timeout',
      'an untimed await',
      'a sleep',
    ])
    /** The two no clock ever turns stuck: the plan's decision for a task no build runs yet, and for an approval. */
    const never = ['a task enqueued ahead of the build that registers it', 'an untimed await']
    for (const seed of controls) {
      await onSeed('libsql', seed, async (db, taskId, at) => {
        const answer = await explain(db, taskId)
        expect(
          { control: seed.control, cause: answer.cause, stuck: answer.verdict === 'stuck' },
          'mutation-verdict:behavior:cli-explain-answers-stuck-for-no-healthy-state',
        ).toEqual({ control: seed.control, cause: seed.cause, stuck: false })
        if (!never.includes(seed.control ?? '')) return
        await at(NOW_MS + 365 * 86_400_000)
        const later = await explain(db, taskId)
        expect({ control: seed.control, cause: later.cause, verdict: later.verdict }).toEqual({
          control: seed.control,
          cause: seed.cause,
          verdict: 'waiting',
        })
      })
    }
  }, 60_000)

  it('a move the driver owes is waiting until it is DUE_GRACE_MS late, and stuck one millisecond later', async () => {
    expect(LATE.map((seed) => seed.cause)).toEqual([
      'cancellation-deadline-passed',
      'lease-lapsed-unswept',
      'woken-unclaimed',
      'pending-due-unclaimed',
      'sleeping-past-its-wake',
    ])
    for (const seed of LATE) {
      await onSeed('libsql', seed, async (db, taskId, at) => {
        const due = (await explain(db, taskId)).facts.dueAtMs as number
        await at(due + DUE_GRACE_MS)
        const atTheEdge = await explain(db, taskId)
        await at(due + DUE_GRACE_MS + 1)
        const past = await explain(db, taskId)
        const read = (answer: Answer) => ({
          cause: answer.cause,
          verdict: answer.verdict,
          nextTransitionAtMs: answer.nextTransitionAtMs,
          lateByMs: answer.facts.lateByMs,
        })
        expect(
          { atTheEdge: read(atTheEdge), past: read(past) },
          'mutation-verdict:behavior:cli-explain-grace-ends-after-its-last-millisecond',
        ).toEqual({
          atTheEdge: {
            cause: seed.cause,
            verdict: 'waiting',
            nextTransitionAtMs: due,
            lateByMs: DUE_GRACE_MS,
          },
          past: {
            cause: seed.cause,
            verdict: 'stuck',
            nextTransitionAtMs: null,
            lateByMs: DUE_GRACE_MS + 1,
          },
        })
      })
    }
  }, 60_000)

  it('a run claimed once is hung one millisecond past HUNG_RUN_MS, and a run claimed again never is', async () => {
    await onSeed('libsql', seedOf('running-past-the-hung-bound'), async (db, taskId, at) => {
      const past = await explain(db, taskId)
      await at(NOW_MS + HUNG_RUN_MS)
      const atTheEdge = await explain(db, taskId)
      expect(
        {
          atTheEdge: [atTheEdge.cause, atTheEdge.verdict],
          past: [past.cause, past.verdict, past.facts.runningForMs],
        },
        'mutation-verdict:behavior:cli-explain-hung-bound-ends-after-its-last-millisecond',
      ).toEqual({
        atTheEdge: ['running-under-a-live-lease', 'ok'],
        past: ['running-past-the-hung-bound', 'stuck', HUNG_RUN_MS + 1],
      })
    })
    // A run that slept and was claimed again: no fact says when its second pass began, so
    // however long ago the run first started, it is not named hung.
    await onSeed('libsql', seedOf('sleeping-on-a-timer'), async (db, taskId, at) => {
      await at(NOW_MS + 120_000)
      const again = await claimActivated(db, 'w-again', taskId)
      for (let beat = 1; beat <= 2 * (HUNG_RUN_MS / 1_800_000); beat++) {
        await at(NOW_MS + 120_000 + beat * 1_800_000 - 1)
        expect((await db.store.heartbeat(QUEUE, again.runId, again.claimToken, 1800)).held).toBe(
          true,
        )
      }
      const answer = await explain(db, taskId)
      expect(
        [answer.cause, answer.verdict, answer.facts.activated],
        'mutation-verdict:behavior:cli-explain-hung-bound-holds-only-a-run-claimed-once',
      ).toEqual(['running-under-a-live-lease', 'ok', true])
    })
  }, 60_000)

  it('at nextTransitionAtMs a claim takes the run, and one millisecond earlier none does', async () => {
    const moved: string[] = []
    for (const seed of EXPLAIN_SEEDS.filter((one) => one.verdict === 'waiting')) {
      await onSeed('libsql', seed, async (db, taskId, at) => {
        const answer = await explain(db, taskId)
        const next = answer.nextTransitionAtMs
        // A run that is already due has its instant behind it, and an untimed await has none.
        if (answer.verdict !== 'waiting' || next === null || next <= answer.databaseNowEpochMs) {
          return
        }
        await at(next - 1)
        const early = await db.store.claim(QUEUE, 'w-early', { leaseSeconds: 60, limit: 10 })
        await at(next)
        const onTime = await db.store.claim(QUEUE, 'w-on-time', { leaseSeconds: 60, limit: 10 })
        expect(
          { cause: seed.cause, early: early.length, onTime: onTime.map((run) => run.taskId) },
          'mutation-verdict:behavior:cli-explain-next-transition-is-the-instant-the-engine-moves-at',
        ).toEqual({ cause: seed.cause, early: 0, onTime: [taskId] })
        moved.push(seed.cause)
      })
    }
    // Every waiting seed that a clock moves was moved, so the check above ran for each.
    expect(moved).toEqual([
      'pending-delayed',
      'never-started',
      'never-started-alpha1-form',
      'awaiting-a-timed-event',
      'sleeping-on-a-timer',
    ])
  }, 120_000)

  it('names a run asleep until its retry delay or its rollback delay has run, and reads a parent through to such a child', async () => {
    /** The cause, the verdict and the instant of an answer, with the cause as plain text. */
    const read = (answer: Answer) => ({
      cause: String(answer.cause),
      verdict: answer.verdict,
      nextTransitionAtMs: answer.nextTransitionAtMs,
    })
    const backingOff = {
      cause: 'backing-off',
      verdict: 'waiting',
      nextTransitionAtMs: NOW_MS + 30_000,
    }
    const failure = '{"name":"Error"}'
    // A retry: the worker fails the run with attempts left and a delay, as every default
    // retry does, and the store inserts the next run asleep until the delay has run.
    const db = await openCliDb('libsql', 'explain-backoff')
    try {
      const task = await db.store.spawn(QUEUE, 'job', '{}', { maxAttempts: 3 })
      const run = await claimActivated(db, 'w-first', task.taskId)
      await db.store.fail(QUEUE, run.runId, run.claimToken, failure, { delaySeconds: 30 })
      expect(read(await explain(db, task.taskId))).toEqual(backingOff)
      // Once the delay has run the next claim takes the run, so it is a due run like any
      // other: waiting inside the grace, and stuck one millisecond past it.
      const at = (ms: number) => db.admin.setFakeNowEpochMs(ms)
      await at(NOW_MS + 30_000 + DUE_GRACE_MS)
      expect(read(await explain(db, task.taskId))).toEqual({
        cause: 'sleeping-past-its-wake',
        verdict: 'waiting',
        nextTransitionAtMs: NOW_MS + 30_000,
      })
      await at(NOW_MS + 30_000 + DUE_GRACE_MS + 1)
      expect(read(await explain(db, task.taskId))).toEqual({
        cause: 'sleeping-past-its-wake',
        verdict: 'stuck',
        nextTransitionAtMs: null,
      })
      const claimed = await db.store.claim(QUEUE, 'w-second', { leaseSeconds: 60, limit: 5 })
      expect(claimed.map((one) => one.taskId)).toEqual([task.taskId])
    } finally {
      await db.close()
    }
    // A rollback pass: a rollback failed with budget left and a delay, and the next pass
    // sleeps until the delay has run.
    const saga = await openCliDb('libsql', 'explain-backoff-rollback')
    try {
      const task = await saga.store.spawn(QUEUE, 'saga', '{}', { maxAttempts: 1 })
      const forward = await claimActivated(saga, 'w-forward', task.taskId)
      await saga.store.setCheckpoint(
        QUEUE,
        task.taskId,
        forward.runId,
        forward.claimToken,
        `${SAGA_STARTED_PREFIX}charge`,
        '1',
        60,
      )
      await saga.store.fail(QUEUE, forward.runId, forward.claimToken, failure, null)
      const pass = await claimActivated(saga, 'w-pass', task.taskId)
      await saga.store.failRollback(
        QUEUE,
        pass.runId,
        pass.claimToken,
        failure,
        { delaySeconds: 30 },
        { stepKey: 'charge', errorJson: failure },
      )
      expect(read(await explain(saga, task.taskId))).toEqual(backingOff)
    } finally {
      await saga.close()
    }
    // A parent parked on a child that is backing off waits as the child does.
    const family = await openCliDb('libsql', 'explain-backoff-child')
    try {
      const [parent, child] = await chainOfAwaits(family, 2)
      const run = await claimActivated(family, 'w-child', child ?? '')
      await family.store.fail(QUEUE, run.runId, run.claimToken, failure, { delaySeconds: 30 })
      const answer = await explain(family, parent ?? '')
      expect({
        ...read(answer),
        deepest: { ...answer.deepest, cause: String(answer.deepest?.cause) },
      }).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'waiting',
        nextTransitionAtMs: null,
        deepest: { taskId: child, cause: 'backing-off', verdict: 'waiting' },
      })
    } finally {
      await family.close()
    }
  }, 60_000)

  it('follows an await of a child one hop at a time to depth 8, and reports the deepest cause', async () => {
    /** The task ids of the chain of awaits an answer followed, the named task first. */
    const followed = (answer: Answer, taskId: string): string[] => {
      const chain = [taskId]
      for (let hop = answer.awaits; hop !== undefined; hop = hop.awaits) chain.push(hop.taskId)
      return chain
    }
    /** An answer, and how many times the facts of a task were read for it. */
    const ask = async (db: CliDb, taskId: string) => {
      const recording = recordingOpener()
      const answer = await explain(db, taskId, recording.opener)
      const reads = recording.sent().filter((batch) => batch.label === 'task-facts').length
      return { answer, reads }
    }
    // Ten tasks, each but the last parked on the next. The ninth is CHILD_HOPS awaits from
    // the first, so its own child is left unread, and nothing vouches for what that child is
    // doing.
    const long = await openCliDb('libsql', 'explain-chain-long')
    try {
      const chain = await chainOfAwaits(long, CHILD_HOPS + 2)
      const { answer, reads } = await ask(long, chain[0] ?? '')
      expect(
        {
          exit: answer.exit,
          reads,
          followed: followed(answer, chain[0] ?? ''),
          deepest: answer.deepest,
          verdict: answer.verdict,
        },
        'mutation-verdict:behavior:cli-explain-follows-a-child-to-depth-8',
      ).toEqual({
        exit: 0,
        reads: CHILD_HOPS + 1,
        followed: chain.slice(0, CHILD_HOPS + 1),
        deepest: { taskId: chain[CHILD_HOPS], cause: 'awaiting-a-child', verdict: 'unexplained' },
        verdict: 'unexplained',
      })
    } finally {
      await long.close()
    }
    // Nine tasks: the last is CHILD_HOPS awaits away and is read, and its cause is reported.
    const db = await openCliDb('libsql', 'explain-chain')
    try {
      const chain = await chainOfAwaits(db, CHILD_HOPS + 1)
      const last = chain[CHILD_HOPS] ?? ''
      const { answer, reads } = await ask(db, chain[0] ?? '')
      expect({
        reads,
        cause: answer.cause,
        verdict: answer.verdict,
        deepest: answer.deepest,
      }).toEqual({
        reads: CHILD_HOPS + 1,
        cause: 'awaiting-a-child',
        verdict: 'waiting',
        deepest: { taskId: last, cause: 'pending-due-unclaimed', verdict: 'waiting' },
      })
      // The tasks waiting on an event are the ones this read saw: each task along the chain
      // is listed under the completion event of the child it awaits.
      const waiting: unknown[] = []
      for (
        let hop: Answer | undefined = answer;
        hop?.cause === 'awaiting-a-child';
        hop = hop.awaits
      ) {
        waiting.push([hop.facts.event, hop.facts.waitingTasks])
      }
      expect(waiting).toEqual(
        chain
          .slice(0, CHILD_HOPS)
          .map((taskId, index) => [taskDoneEventName(chain[index + 1] ?? ''), [taskId]]),
      )
      // A child the driver is late for makes every task that waits on it stuck, and the next
      // command is the one for the child: none yet, because `tick` is not in the table.
      await seedWorld(db).at(NOW_MS + DUE_GRACE_MS + 1)
      const late = (await ask(db, chain[0] ?? '')).answer
      expect({ verdict: late.verdict, deepest: late.deepest, next: late.next }).toEqual({
        verdict: 'stuck',
        deepest: { taskId: last, cause: 'pending-due-unclaimed', verdict: 'stuck' },
        next: null,
      })
    } finally {
      await db.close()
    }
  }, 60_000)

  it('every suggestion emitted parses, holds no --yes and never names emit', async () => {
    const emitted: string[][] = []
    for (const seed of EXPLAIN_SEEDS) {
      await onSeed('libsql', seed, async (db, taskId, at) => {
        const answers = [await explain(db, taskId)]
        // The same seed once the driver is late for it, for the causes that have a clock.
        await at(NOW_MS + 30 * 86_400_000)
        answers.push(await explain(db, taskId))
        for (const answer of answers) {
          if (answer.next === null) continue
          emitted.push(answer.next.argv)
          expect(answer.next.command).toBe(`pnpm cli ${answer.next.argv.join(' ')}`)
        }
      })
    }
    // A command table that already holds the verbs a later build adds, each with the flag
    // that confirms a write, so the builder is asked about them too.
    const drive = (verb: string, positionals: string[]): CommandSpec => ({
      ...COMMANDS.result,
      verb: verb as CommandSpec['verb'],
      positionals,
      flags: {
        ...COMMANDS.result.flags,
        yes: { type: 'boolean', description: 'confirm the change' },
      },
      writes: true,
    })
    const later: Readonly<Record<string, CommandSpec>> = {
      ...COMMANDS,
      sweep: drive('sweep', []),
      tick: drive('tick', []),
      cancel: drive('cancel', ['taskId']),
      emit: drive('emit', []),
    }
    const built: string[][] = []
    for (const cause of Object.keys(CAUSES) as Cause[]) {
      for (const verdict of VERDICTS) {
        const argv = suggestion({ cause, verdict, taskId: 'a-task' }, QUEUE, later)
        if (argv !== null) built.push([...argv])
      }
    }
    for (const argv of [...emitted, ...built]) {
      expect(
        { argv, confirms: argv.includes('--yes'), emits: argv[0] === 'emit' },
        'mutation-verdict:behavior:cli-explain-suggests-no-yes',
      ).toEqual({ argv, confirms: false, emits: false })
    }
    // Every suggestion a command of today's table carries parses as that command.
    for (const argv of emitted) expect(parseInvocation(argv).spec.verb).toBe(argv[0])
    expect(new Set(emitted.map((argv) => argv[0]))).toEqual(new Set(['result', 'inspect']))
    expect(new Set(built.map((argv) => argv[0]))).toEqual(
      new Set(['result', 'inspect', 'sweep', 'tick', 'cancel']),
    )
    // A waiting verdict owes no command, whatever the cause.
    for (const cause of Object.keys(CAUSES) as Cause[]) {
      expect(
        suggestion({ cause, verdict: 'waiting', taskId: 'a-task' }, QUEUE, later),
        'mutation-verdict:behavior:cli-explain-a-waiting-verdict-owes-no-command',
      ).toBeNull()
    }
  }, 120_000)

  it('names the causes whose suggestion no command of the table carries yet', () => {
    // `sweep`, `tick` and `cancel` join the command table with the drive verbs. Until then a
    // cause that names one of them prints no next command. The pull request that adds them
    // empties this list, and has to say here what each of these causes then suggests.
    const notYet = Object.entries(CAUSES)
      .filter(([, spec]) => spec.next !== null && !Object.hasOwn(COMMANDS, spec.next))
      .map(([cause, spec]) => `${cause}: ${spec.next}`)
    expect(notYet).toEqual([
      'cancellation-deadline-passed: sweep',
      'lease-lapsed-unswept: sweep',
      'running-past-the-hung-bound: cancel',
      'woken-unclaimed: tick',
      'pending-due-unclaimed: tick',
      'sleeping-past-its-wake: tick',
    ])
    // Stuck, each of them prints no next command today.
    for (const line of notYet) {
      const cause = line.slice(0, line.indexOf(':')) as Cause
      expect(suggestion({ cause, verdict: 'stuck', taskId: 'a-task' }, QUEUE)).toBeNull()
    }
    // A verb in the table whose argument or required flag `explain` knows no value for is a
    // defect of the table of causes, and is refused out loud.
    const unknown: CommandSpec = { ...COMMANDS.result, positionals: ['somethingElse'] }
    expect(() =>
      suggestion({ cause: 'completed', verdict: 'ok', taskId: 'a-task' }, QUEUE, {
        result: unknown,
      }),
    ).toThrow(/explain knows no value for somethingElse of result/)
  })

  it('prints a suggestion as one line a shell reads back as the same arguments', () => {
    const argv = ['inspect', "a task's id", '--queue', 'a queue; rm -rf "$HOME"']
    const line = pastedLine(argv)
    expect(line.startsWith('pnpm cli ')).toBe(true)
    const read = spawnSync('sh', ['-c', `printf '%s\\n' ${line.slice('pnpm cli '.length)}`], {
      encoding: 'utf8',
    })
    expect(
      read.stdout.split('\n').slice(0, -1),
      'mutation-verdict:behavior:cli-explain-quotes-a-pasted-line',
    ).toEqual(argv)
    // A plain word is pasted as it is.
    expect(pastedLine(['result', 'task-01', '--queue', 'q'])).toBe(
      'pnpm cli result task-01 --queue q',
    )
  })

  it('prints its answer on stdout whatever it exits with, and exits 10 for a row inspect exits 10 for', async () => {
    const inspectExit = async (db: CliDb, taskId: string) =>
      (await runCli(['inspect', taskId, '--queue', QUEUE, '--json'], db.env)).exit
    // A row the decoders refuse.
    await onSeed('libsql', seedOf('unreadable'), async (db, taskId) => {
      const answer = await explain(db, taskId)
      expect(
        { exit: answer.exit, cause: answer.cause, inspect: await inspectExit(db, taskId) },
        'mutation-verdict:behavior:cli-explain-exits-10-for-an-unreadable-row',
      ).toEqual({ exit: 10, cause: 'unreadable', inspect: 10 })
      const text = await runCli(['explain', taskId, '--queue', QUEUE], db.env)
      expect(
        {
          exit: text.exit,
          stderr: text.stderr,
          named: text.stdout.split('\n').includes('cause: unreadable'),
        },
        'mutation-verdict:behavior:cli-explain-prints-its-answer-on-stdout',
      ).toEqual({ exit: 10, stderr: '', named: true })
    })
    // An integer outside its bounds, fixture-built: the cause names the field.
    await onSeed('libsql', seedOf('pending-due-unclaimed'), async (db, taskId) => {
      await fixture(db, 'UPDATE runs SET claim_gen = -3 WHERE task_id = ?', [taskId])
      const answer = await explain(db, taskId)
      expect({
        exit: answer.exit,
        cause: answer.cause,
        verdict: answer.verdict,
        facts: answer.facts,
        inspect: await inspectExit(db, taskId),
      }).toEqual({
        exit: 10,
        cause: 'unreadable',
        verdict: 'inconsistent',
        facts: { outcome: 'readable', corruptFields: ['runs.claim_gen'] },
        inspect: 10,
      })
    })
    // A checkpoint row the decoders refuse, where the cause turns on the task's checkpoints:
    // it is not read as a task that has none. The store's read leaves out a row whose owner
    // ordinal is outside its bounds before the decoders see it, so the row is handed to them
    // here by an executor that answers the read with one.
    await onSeed('libsql', seedOf('sleeping-on-a-timer'), async (db, taskId) => {
      const refusedByTheDecoders = openerWrapping((real) => ({
        batch: async (label, statements, control) => {
          const results = await real.batch(label, statements, control)
          if (label !== 'get-checkpoints') return results
          return results.map((result) => ({
            ...result,
            rows: result.rows.map((row) => ({ ...row, owner_attempt: -1 })),
          }))
        },
      }))
      const answer = await explain(db, taskId, refusedByTheDecoders)
      expect({ exit: answer.exit, cause: answer.cause, facts: answer.facts }).toEqual({
        exit: 10,
        cause: 'unreadable',
        facts: { checkpoints: 'unreadable' },
      })
      // The known limit DESIGN.md section 3.11 records: the same value planted in the stored
      // row is left out by the read, so the task reads as one with no checkpoint. A read
      // that lists such a row changes this expectation.
      await fixture(db, 'UPDATE checkpoints SET owner_attempt = -1 WHERE task_id = ?', [taskId])
      const planted = await explain(db, taskId)
      expect([planted.exit, planted.cause]).toEqual([0, 'never-started-alpha1-form'])
    })
    // A child that is not readable makes the answer exit 10 too, under the parent's own cause.
    const db = await openCliDb('libsql', 'explain-unreadable-child')
    try {
      const [parent, child] = await chainOfAwaits(db, 2)
      await fixture(db, 'UPDATE runs SET claim_gen = -3 WHERE task_id = ?', [child ?? ''])
      const answer = await explain(db, parent ?? '')
      expect({
        exit: answer.exit,
        cause: answer.cause,
        verdict: answer.verdict,
        deepest: answer.deepest,
      }).toEqual({
        exit: 10,
        cause: 'awaiting-a-child',
        verdict: 'inconsistent',
        deepest: { taskId: child, cause: 'unreadable', verdict: 'inconsistent' },
      })
    } finally {
      await db.close()
    }
  }, 60_000)

  it('exits 8 for a task or a key the queue does not hold, on stderr in text, and does not print the key', async () => {
    const db = await openCliDb('libsql', 'explain-absent')
    try {
      const byId = await runCli(['explain', 'no-such-task', '--queue', QUEUE, '--json'], db.env)
      expect({ exit: byId.exit, error: JSON.parse(byId.stdout).error }).toEqual({
        exit: 8,
        error: { kind: 'not-found', message: `no task no-such-task in queue ${QUEUE}` },
      })
      const text = await runCli(['explain', 'no-such-task', '--queue', QUEUE], db.env)
      expect({
        exit: text.exit,
        stdout: text.stdout,
        said: text.stderr.includes(`no task no-such-task in queue ${QUEUE}`),
      }).toEqual({ exit: 8, stdout: '', said: true })
      for (const extra of [[], ['--reveal']]) {
        const byKey = await runCli(
          ['explain', '--key', `absent-${SENTINEL}`, '--queue', QUEUE, '--json', ...extra],
          db.env,
        )
        expect({ exit: byKey.exit, printed: byKey.stdout.includes(SENTINEL) }).toEqual({
          exit: 8,
          printed: false,
        })
      }
    } finally {
      await db.close()
    }
  })

  it('takes a task id or --key as inspect does, and answers the same by either', async () => {
    expect(usage(COMMANDS.explain)).toBe(
      'explain (<taskId> | --key <K>) [--json] --queue <Q> [--reveal]',
    )
    const { opener, sent } = recordingOpener()
    for (const argv of [
      ['explain', '--queue', QUEUE],
      ['explain', 'a-task', '--key', 'a-key', '--queue', QUEUE],
      ['explain', 'a-task'],
    ]) {
      const run = await runCli([...argv, '--json'], { DURABLERUN_STORE_URL: ':memory:' }, opener)
      expect({ argv: argv.join(' '), exit: run.exit }).toEqual({ argv: argv.join(' '), exit: 2 })
    }
    expect(sent()).toEqual([])
    const db = await openCliDb('libsql', 'explain-key')
    try {
      const taskId = await asleep(db, 120, { idempotencyKey: `key-${SENTINEL}` })
      const byId = await runCli(['explain', taskId, '--queue', QUEUE, '--json'], db.env)
      const byKey = await runCli(
        ['explain', '--key', `key-${SENTINEL}`, '--queue', QUEUE, '--json'],
        db.env,
      )
      expect({ exit: byKey.exit, same: byKey.stdout === byId.stdout }).toEqual({
        exit: 0,
        same: true,
      })
      expect(JSON.parse(byKey.stdout)).toMatchObject({ taskId, cause: 'sleeping-on-a-timer' })
      // The key is a value a user wrote, and the answer holds none.
      expect(byKey.stdout).not.toContain(SENTINEL)
    } finally {
      await db.close()
    }
  })
})

/** Facts of one live task with one run, as `diagnose` is given them, with what a case changes. */
function factsOf(
  run: Partial<TaskFacts['runs'][number]>,
  more: Partial<Pick<TaskFacts, 'waits' | 'events' | 'corrupt' | 'nowMs'>> & {
    readonly task?: Partial<TaskFacts['task']>
  } = {},
): TaskFacts {
  const state = run.state ?? 'pending'
  return {
    nowMs: NOW_MS,
    fakeClock: true,
    task: {
      taskId: 't',
      queue: QUEUE,
      taskName: 'job',
      state,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      infraRetries: 0,
      enqueueAtMs: NOW_MS,
      firstStartedAtMs: null,
      cancelAtMs: null,
      idempotencyKey: null,
      parentTaskId: null,
      sagaBegan: false,
      ...more.task,
    },
    outcome: { result: { state: 'pending' } },
    runs: [
      {
        runId: 'r',
        queue: QUEUE,
        state,
        attempt: 1,
        claimGen: 1,
        activatedGen: 1,
        relaunchCount: 0,
        claimExpiresAtMs: null,
        heartbeatAtMs: null,
        availableAtMs: NOW_MS,
        wakeEvent: null,
        wakeStep: null,
        startedAtMs: NOW_MS,
        completedAtMs: null,
        failedAtMs: null,
        ...run,
      },
    ],
    waits: more.waits ?? [],
    events: more.events ?? [],
    corrupt: more.corrupt ?? [],
    ...(more.nowMs === undefined ? {} : { nowMs: more.nowMs }),
  }
}

/** A wait that the run of `factsOf` registered. */
const waitOf = (eventName: string, timeoutAtMs: number | null): TaskFacts['waits'][number] => ({
  runId: 'r',
  stepName: 's',
  eventName,
  status: 'waiting',
  timeoutAtMs,
  createdAtMs: NOW_MS,
})

/** What `diagnose` answered, which these cases require to be an answer and not a request. */
function answered(asked: ReturnType<typeof diagnose>): Diagnosis {
  if ('needs' in asked) throw new Error(`diagnose asked for ${asked.needs}`)
  return asked
}

describe('diagnose', () => {
  it('answers unexplained for facts no arm takes, and never a healthy verdict', () => {
    const parked = {
      state: 'sleeping',
      wakeEvent: 'e',
      wakeStep: 's',
      availableAtMs: null,
    } as const
    const shapes: Readonly<Record<string, TaskFacts>> = {
      'a running run that holds no lease': factsOf({ state: 'running' }),
      'a pending run with no instant it is due at': factsOf({ availableAtMs: null }),
      'a sleeping run with no timer and no event': factsOf({
        state: 'sleeping',
        availableAtMs: null,
      }),
      'a sleeping run that names an event no wait registers': factsOf(parked),
      'a sleeping run whose wait names another step': factsOf(parked, {
        waits: [{ ...waitOf('e', null), stepName: 'another' }],
      }),
      'a sleeping run whose wait times out at another instant than the run is due': factsOf(
        { ...parked, availableAtMs: NOW_MS + 5_000 },
        { waits: [waitOf('e', NOW_MS + 9_000)] },
      ),
      'a sleeping run whose wait was delivered': factsOf(parked, {
        waits: [{ ...waitOf('e', null), status: 'delivered' }],
      }),
      'a sleeping run that two waits match, registered before runs named their step': factsOf(
        { ...parked, wakeStep: null },
        { waits: [waitOf('e', null), { ...waitOf('e', null), stepName: 'second' }] },
      ),
      'a run parked on an event that no worker started': factsOf(
        { ...parked, activatedGen: 0 },
        { waits: [waitOf('e', null)] },
      ),
      'a run parked on an event under a timeout that no worker started': factsOf(
        { ...parked, activatedGen: 0, availableAtMs: NOW_MS + 5_000 },
        { waits: [waitOf('e', NOW_MS + 5_000)] },
      ),
    }
    for (const [shape, facts] of Object.entries(shapes)) {
      const answer = answered(diagnose(facts, { checkpoints: 1 }))
      expect(
        { shape, cause: answer.cause, verdict: answer.verdict, next: answer.nextTransitionAtMs },
        'mutation-verdict:behavior:cli-explain-reads-no-cause-from-rows-that-disagree',
      ).toEqual({
        shape,
        cause: 'unexplained',
        verdict: 'unexplained',
        next: null,
      })
    }
    // No verdict and no cause says a run can be claimed: a claim's admission reads what the
    // facts do not hold, the stored retry strategy and headers among it.
    expect(VERDICTS).toEqual(['ok', 'waiting', 'stuck', 'inconsistent', 'unexplained'])
    for (const [cause, spec] of Object.entries(CAUSES)) {
      expect(`${cause} ${spec.meaning}`).not.toMatch(/claimable|can be claimed|will be claimed/)
    }
  })

  it("answers unreadable for a state that is not the engine's own, a corrupt integer, and a database with no time", () => {
    const rogue = `rogue-${SENTINEL}`
    const corrupt = {
      field: 'runs.attempt',
      runId: 'r',
      reason: 'out-of-range',
      stored: 'number',
    } as const
    const shapes: Readonly<Record<string, TaskFacts>> = {
      "a run in a state that is not the engine's own": factsOf(
        { state: rogue },
        { task: { state: 'pending' } },
      ),
      "a wait in a status that is not the engine's own": factsOf(
        { state: 'sleeping', wakeEvent: 'e', wakeStep: 's', availableAtMs: null },
        { waits: [{ ...waitOf('e', null), status: rogue }] },
      ),
      'a corrupt integer': factsOf({ attempt: null }, { corrupt: [corrupt] }),
      'an outcome the decoders refuse': {
        ...factsOf({}),
        outcome: { refused: `refused ${rogue}` },
      },
      'a database time that is corrupt': factsOf(
        {},
        {
          nowMs: null,
          corrupt: [{ field: 'database.now_ms', reason: 'out-of-range', stored: 'null' }],
        },
      ),
    }
    for (const [shape, facts] of Object.entries(shapes)) {
      const answer = answered(diagnose(facts))
      expect({ shape, cause: answer.cause, verdict: answer.verdict }).toEqual({
        shape,
        cause: 'unreadable',
        verdict: 'inconsistent',
      })
      // What it says of the row quotes nothing the row holds.
      expect(JSON.stringify(answer)).not.toContain(SENTINEL)
    }
  })

  it('names a live task past its cancellation deadline by the deadline, whatever its run is doing', () => {
    const overdue = { task: { cancelAtMs: NOW_MS - 1 } }
    const runs = {
      running: factsOf({ state: 'running', claimExpiresAtMs: NOW_MS + 60_000 }, overdue),
      pending: factsOf({ state: 'pending', availableAtMs: NOW_MS + 60_000 }, overdue),
      deferred: factsOf(
        { state: 'sleeping', activatedGen: 0, availableAtMs: NOW_MS + 60_000 },
        overdue,
      ),
    }
    for (const [run, facts] of Object.entries(runs)) {
      const answer = answered(diagnose(facts))
      expect([run, answer.cause, answer.verdict, answer.facts.dueAtMs]).toEqual([
        run,
        'cancellation-deadline-passed',
        'waiting',
        NOW_MS - 1,
      ])
    }
  })

  it('asks for the evidence a cause turns on, once, and answers from it', () => {
    const timer = factsOf({ state: 'sleeping', availableAtMs: NOW_MS + 60_000 })
    expect(diagnose(timer)).toEqual({ needs: 'checkpoints' })
    const read = (checkpoints: number | 'unreadable') => {
      const answer = answered(diagnose(timer, { checkpoints }))
      return [answer.cause, answer.verdict, answer.nextTransitionAtMs]
    }
    expect({ none: read(0), some: read(3), refused: read('unreadable') }).toEqual({
      none: ['never-started-alpha1-form', 'waiting', NOW_MS + 60_000],
      some: ['sleeping-on-a-timer', 'waiting', NOW_MS + 60_000],
      refused: ['unreadable', 'inconsistent', null],
    })
    // A task with no checkpoint whose timer has passed is still the task no build runs, and
    // one with a checkpoint is a sleeper the driver is late for.
    const overdue = factsOf({ state: 'sleeping', availableAtMs: NOW_MS - DUE_GRACE_MS - 1 })
    expect([
      answered(diagnose(overdue, { checkpoints: 0 })).verdict,
      answered(diagnose(overdue, { checkpoints: 1 })).verdict,
    ]).toEqual(['waiting', 'stuck'])

    const child = taskDoneEventName('the-child')
    const parent = factsOf(
      { state: 'sleeping', wakeEvent: child, wakeStep: 's', availableAtMs: NOW_MS + 60_000 },
      { waits: [waitOf(child, NOW_MS + 60_000)] },
    )
    expect(diagnose(parent)).toEqual({ needs: 'child', taskId: 'the-child' })
    const through = (evidence: Parameters<typeof diagnose>[1]) => {
      const answer = answered(diagnose(parent, evidence))
      return [answer.cause, answer.verdict, answer.nextTransitionAtMs, answer.facts.followed]
    }
    const childIs = (cause: Cause, verdict: Verdict): Diagnosis => ({
      taskId: 'the-child',
      cause,
      verdict,
      nextTransitionAtMs: null,
      facts: {},
    })
    expect(
      {
        absent: through({ child: 'absent' }),
        notFollowed: through({ child: 'not-followed' }),
        waiting: through({ child: childIs('sleeping-on-a-timer', 'waiting') }),
        running: through({ child: childIs('running-under-a-live-lease', 'ok') }),
        stuck: through({ child: childIs('pending-due-unclaimed', 'stuck') }),
        inconsistent: through({ child: childIs('unreadable', 'inconsistent') }),
        unexplained: through({ child: childIs('unexplained', 'unexplained') }),
        // A child that ended woke its waiters in the batch that ended it.
        ended: through({ child: childIs('completed', 'ok') }),
      },
      'mutation-verdict:behavior:cli-explain-vouches-for-no-child-it-cannot-read-as-live',
    ).toEqual({
      absent: ['awaiting-a-child', 'unexplained', null, 'absent'],
      notFollowed: ['awaiting-a-child', 'unexplained', null, 'not-followed'],
      // The parent's own next instant is its await's timeout.
      waiting: ['awaiting-a-child', 'waiting', NOW_MS + 60_000, 'followed'],
      running: ['awaiting-a-child', 'waiting', NOW_MS + 60_000, 'followed'],
      stuck: ['awaiting-a-child', 'stuck', null, 'followed'],
      inconsistent: ['awaiting-a-child', 'inconsistent', null, 'followed'],
      unexplained: ['awaiting-a-child', 'unexplained', null, 'followed'],
      ended: ['awaiting-a-child', 'unexplained', null, 'followed'],
    })
  })
})
