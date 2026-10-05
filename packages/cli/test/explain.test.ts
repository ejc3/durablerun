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
  type Evidence,
  type Given,
  HUNG_RUN_MS,
  VERDICTS,
  type Verdict,
  answerView,
  diagnose,
  pastedLine,
  suggestion,
} from '../src/explain.js'
import type { StoreOpener } from '../src/open-store.js'
import {
  EXPLAIN_SEEDS,
  type ExplainSeed,
  SEED_WORKER,
  asleep,
  chainOfAwaits,
  fixture,
  onSeed,
  parkedOnAnEvent,
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

/** An answer, and how many times the facts of a task were read for it. */
async function ask(db: CliDb, taskId: string) {
  const recording = recordingOpener()
  const answer = await explain(db, taskId, recording.opener)
  const reads = recording.sent().filter((batch) => batch.label === 'task-facts').length
  return { answer, reads }
}

/** Everything `explain` can be given to fill a suggestion from: a queue, a store's target and a deployment. */
const EVERYTHING_GIVEN: Given = {
  queue: QUEUE,
  target: 'db.example.io:5432',
  url: 'https://deployment.example',
}

/** The arguments a POSIX shell reads back from the one line `explain` prints to paste. */
const shellReads = (line: string): string[] =>
  spawnSync('sh', ['-c', `printf '%s\\n' ${line.slice('pnpm cli '.length)}`], { encoding: 'utf8' })
    .stdout.split('\n')
    .slice(0, -1)

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
    // These nine say in their names that fixture SQL built them. Every other seed reaches its
    // state through the store's ports alone.
    expect(
      EXPLAIN_SEEDS.filter((seed) => seed.name.includes('fixture-built')).map((seed) => seed.cause),
    ).toEqual([
      'wait-outlives-its-event',
      'unreadable',
      'terminal-task-with-a-live-run',
      'live-task-without-one-live-run',
      'task-and-run-states-differ',
      'deadline-no-sweep-cancels',
      'lapsed-lease-no-sweep-reclaims',
      'due-run-no-claim-admits',
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
        if (seed.control === 'a live lease') {
          // The same lease kept alive past the hung-run bound: a long pass, and still not stuck.
          await at(NOW_MS + HUNG_RUN_MS - 1_000)
          const beat = await db.store.heartbeat(QUEUE, String(answer.facts.runId), SEED_WORKER, 60)
          expect(beat.held).toBe(true)
          await at(NOW_MS + HUNG_RUN_MS + 1)
          const long = await explain(db, taskId)
          expect({ cause: long.cause, stuck: long.verdict === 'stuck' }).toEqual({
            cause: 'running-past-the-hung-bound',
            stuck: false,
          })
        }
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
        past: ['running-past-the-hung-bound', 'ok', HUNG_RUN_MS + 1],
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

  it('a healthy first pass past the hung-run bound is not stuck, and no cancel is suggested for it', async () => {
    const db = await openCliDb('libsql', 'explain-hung-healthy')
    try {
      // The task says for itself how long it may run: two hours from its first start.
      const task = await db.store.spawn(QUEUE, 'job', '{}', {
        cancellation: { maxDurationSeconds: 7200 },
      })
      const run = await claimActivated(db, 'w-long', task.taskId)
      await db.admin.setFakeNowEpochMs(NOW_MS + HUNG_RUN_MS - 1_000)
      expect((await db.store.heartbeat(QUEUE, run.runId, run.claimToken, 60)).held).toBe(true)
      await db.admin.setFakeNowEpochMs(NOW_MS + HUNG_RUN_MS + 1)
      const answer = await explain(db, task.taskId)
      // Nothing is owed to a run under a live lease: the sweep takes nothing.
      expect(await db.store.sweep(QUEUE, 10)).toEqual([])
      expect(
        { cause: answer.cause, verdict: answer.verdict, cancelAtMs: answer.facts.cancelAtMs },
        'mutation-verdict:behavior:cli-explain-a-run-past-the-hung-bound-is-not-stuck',
      ).toEqual({
        cause: 'running-past-the-hung-bound',
        verdict: 'ok',
        cancelAtMs: NOW_MS + 7_200_000,
      })
      // The command table holds `cancel`, and the next command is still a look.
      expect(Object.hasOwn(COMMANDS, 'cancel')).toBe(true)
      const built = suggestion(
        { cause: answer.cause, verdict: answer.verdict, taskId: task.taskId },
        { queue: QUEUE, target: db.target },
      )
      expect(
        { built: Array.isArray(built) ? built[0] : built, printed: answer.next?.argv[0] },
        'mutation-verdict:behavior:cli-explain-never-suggests-cancel',
      ).toEqual({ built: 'inspect', printed: 'inspect' })
    } finally {
      await db.close()
    }
  })

  it('a parent parked on a child that is past the hung-run bound is waiting, as it was before the bound', async () => {
    const db = await openCliDb('libsql', 'explain-hung-child')
    try {
      const [parent, child] = await chainOfAwaits(db, 2)
      const run = await claimActivated(db, 'w-child', child ?? '')
      await db.admin.setFakeNowEpochMs(NOW_MS + HUNG_RUN_MS - 1_000)
      expect((await db.store.heartbeat(QUEUE, run.runId, run.claimToken, 60)).held).toBe(true)
      const read = async (ms: number) => {
        await db.admin.setFakeNowEpochMs(ms)
        const answer = await explain(db, parent ?? '')
        return { cause: answer.cause, verdict: answer.verdict, deepest: answer.deepest }
      }
      expect(await read(NOW_MS + HUNG_RUN_MS)).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'waiting',
        deepest: { taskId: child, cause: 'running-under-a-live-lease', verdict: 'ok' },
      })
      // One millisecond on the child's cause has another name. A worker is still running it.
      expect(
        await read(NOW_MS + HUNG_RUN_MS + 1),
        'mutation-verdict:behavior:cli-explain-a-parent-waits-for-a-child-a-worker-runs',
      ).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'waiting',
        deepest: { taskId: child, cause: 'running-past-the-hung-bound', verdict: 'ok' },
      })
    } finally {
      await db.close()
    }
  })

  it('names the cancellation deadline as the next instant when it comes before the wake, and prints it among the facts', async () => {
    const read = (answer: Answer) => ({
      cause: answer.cause,
      verdict: answer.verdict,
      nextTransitionAtMs: answer.nextTransitionAtMs,
      cancelAtMs: answer.facts.cancelAtMs,
    })
    // A sleeper that may run for a minute, asleep for two: the sweep cancels it at the
    // minute, which is before its timer.
    const db = await openCliDb('libsql', 'explain-deadline-first')
    try {
      const taskId = await asleep(db, 120, { cancellation: { maxDurationSeconds: 60 } })
      expect(
        read(await explain(db, taskId)),
        'mutation-verdict:behavior:cli-explain-next-transition-takes-an-earlier-deadline',
      ).toEqual({
        cause: 'sleeping-on-a-timer',
        verdict: 'waiting',
        nextTransitionAtMs: NOW_MS + 60_000,
        cancelAtMs: NOW_MS + 60_000,
      })
      // One millisecond before that instant nothing moves the task, and at it the sweep does.
      await db.admin.setFakeNowEpochMs(NOW_MS + 60_000 - 1)
      expect({
        swept: await db.store.sweep(QUEUE, 10),
        claimed: await db.store.claim(QUEUE, 'w-early', { leaseSeconds: 60, limit: 10 }),
      }).toEqual({ swept: [], claimed: [] })
      await db.admin.setFakeNowEpochMs(NOW_MS + 60_000)
      expect((await db.store.sweep(QUEUE, 10)).map((swept) => [swept.kind, swept.taskId])).toEqual([
        ['cancelled', taskId],
      ])
    } finally {
      await db.close()
    }
    // An await with no timeout has no clock of its own, and the task's deadline is one.
    const untimed = await openCliDb('libsql', 'explain-deadline-untimed')
    try {
      const taskId = await parkedOnAnEvent(untimed, null, {
        cancellation: { maxDurationSeconds: 60 },
      })
      expect(read(await explain(untimed, taskId))).toEqual({
        cause: 'awaiting-an-untimed-event',
        verdict: 'waiting',
        nextTransitionAtMs: NOW_MS + 60_000,
        cancelAtMs: NOW_MS + 60_000,
      })
    } finally {
      await untimed.close()
    }
    // A deadline after the wake leaves the wake as the next instant, and still prints.
    const later = await openCliDb('libsql', 'explain-deadline-later')
    try {
      const taskId = await asleep(later, 120, { cancellation: { maxDurationSeconds: 300 } })
      expect(read(await explain(later, taskId))).toEqual({
        cause: 'sleeping-on-a-timer',
        verdict: 'waiting',
        nextTransitionAtMs: NOW_MS + 120_000,
        cancelAtMs: NOW_MS + 300_000,
      })
    } finally {
      await later.close()
    }
  }, 60_000)

  it('at nextTransitionAtMs the engine moves the task, and one millisecond earlier it does not', async () => {
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
      'backing-off',
      'never-started',
      'never-started-alpha1-form',
      'awaiting-a-timed-event',
      'sleeping-on-a-timer',
    ])
    // Where a task's cancellation deadline comes before its run's wake, the instant is the
    // deadline and the sweep is what moves the task: it cancels at that instant and not
    // one millisecond earlier, and no claim takes the run at either.
    const minute = { cancellation: { maxDurationSeconds: 60 } }
    const deadlineFirst: Readonly<Record<string, (db: CliDb) => Promise<string>>> = {
      'a sleeper whose timer is after its deadline': (db) => asleep(db, 120, minute),
      'an await under a timeout that is after its deadline': (db) =>
        parkedOnAnEvent(db, 300, minute),
      'an await with no timeout': (db) => parkedOnAnEvent(db, null, minute),
    }
    for (const [name, build] of Object.entries(deadlineFirst)) {
      const db = await openCliDb('libsql', 'explain-deadline-moves')
      try {
        const taskId = await build(db)
        const next = (await explain(db, taskId)).nextTransitionAtMs
        expect({ name, next }).toEqual({ name, next: NOW_MS + 60_000 })
        const movedAt = async (ms: number) => {
          await db.admin.setFakeNowEpochMs(ms)
          const swept = await db.store.sweep(QUEUE, 10)
          const claimed = await db.store.claim(QUEUE, `w-${ms}`, { leaseSeconds: 60, limit: 10 })
          return { cancelled: swept.map((one) => one.taskId), claimed: claimed.length }
        }
        expect({
          name,
          early: await movedAt(NOW_MS + 60_000 - 1),
          onTime: await movedAt(NOW_MS + 60_000),
        }).toEqual({
          name,
          early: { cancelled: [], claimed: 0 },
          onTime: { cancelled: [taskId], claimed: 0 },
        })
      } finally {
        await db.close()
      }
    }
  }, 120_000)

  it('names a run asleep until its retry delay or its rollback delay has run, and reads a parent through to such a child', async () => {
    /** The cause, the verdict and the instant of an answer. */
    const read = (answer: Answer) => ({
      cause: answer.cause,
      verdict: answer.verdict,
      nextTransitionAtMs: answer.nextTransitionAtMs,
    })
    const backingOff = {
      cause: 'backing-off',
      verdict: 'waiting',
      nextTransitionAtMs: NOW_MS + 30_000,
    }
    const failure = '{"name":"Error"}'
    // A retry, which is the seed of the cause: the worker fails the run with attempts left
    // and a delay, as every default retry does, and the store inserts the next run asleep
    // until the delay has run.
    await onSeed('libsql', seedOf('backing-off'), async (db, taskId, at) => {
      expect(read(await explain(db, taskId))).toEqual(backingOff)
      // Once the delay has run the next claim takes the run, so it is a due run like any
      // other: waiting inside the grace, and stuck one millisecond past it.
      await at(NOW_MS + 30_000 + DUE_GRACE_MS)
      expect(read(await explain(db, taskId))).toEqual({
        cause: 'sleeping-past-its-wake',
        verdict: 'waiting',
        nextTransitionAtMs: NOW_MS + 30_000,
      })
      await at(NOW_MS + 30_000 + DUE_GRACE_MS + 1)
      expect(read(await explain(db, taskId))).toEqual({
        cause: 'sleeping-past-its-wake',
        verdict: 'stuck',
        nextTransitionAtMs: null,
      })
      const claimed = await db.store.claim(QUEUE, 'w-second', { leaseSeconds: 60, limit: 5 })
      expect(claimed.map((one) => one.taskId)).toEqual([taskId])
    })
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
      expect({ ...read(answer), deepest: answer.deepest }).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'waiting',
        nextTransitionAtMs: null,
        deepest: { taskId: child, cause: 'backing-off', verdict: 'waiting' },
      })
    } finally {
      await family.close()
    }
  }, 60_000)

  it('says of a due run that carries the wake fields of an await whether its event exists', async () => {
    const read = (answer: Answer) => ({
      cause: answer.cause,
      verdict: answer.verdict,
      event: answer.facts.event,
      eventExists: answer.facts.eventExists,
    })
    const woken = { cause: 'woken-unclaimed', verdict: 'waiting', event: 'approval' }
    // An emit woke the run, and the event it left exists.
    await onSeed('libsql', seedOf('woken-unclaimed'), async (db, taskId) => {
      expect(read(await explain(db, taskId))).toEqual({ ...woken, eventExists: true })
    })
    // An await that timed out, a failure for good, and a revival: the run that follows
    // carries the await's wake fields, and nobody emitted the event.
    const db = await openCliDb('libsql', 'explain-revived-after-a-timeout')
    try {
      const task = await db.store.spawn(QUEUE, 'job', '{}', { maxAttempts: 1 })
      const first = await claimActivated(db, 'w-first', task.taskId)
      await db.store.awaitEvent(
        QUEUE,
        task.taskId,
        first.runId,
        first.claimToken,
        'approve',
        'approval',
        30,
      )
      await db.admin.setFakeNowEpochMs(NOW_MS + 30_000)
      const again = await claimActivated(db, 'w-again', task.taskId)
      await db.store.fail(QUEUE, again.runId, again.claimToken, '{"name":"Error"}', null)
      expect(await db.store.retryTask(QUEUE, task.taskId)).not.toBeNull()
      expect(
        read(await explain(db, task.taskId)),
        'mutation-verdict:behavior:cli-explain-says-whether-a-wake-event-exists',
      ).toEqual({ ...woken, eventExists: false })
    } finally {
      await db.close()
    }
  })

  it('follows an await of a child one hop at a time to depth 8, and reports the deepest cause', async () => {
    /** The task ids of the chain of awaits an answer followed, the named task first. */
    const followed = (answer: Answer, taskId: string): string[] => {
      const chain = [taskId]
      for (let hop = answer.awaits; hop !== undefined; hop = hop.awaits) chain.push(hop.taskId)
      return chain
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
      // Each task along the chain names the completion event of the child it awaits. No
      // answer lists the tasks that wait on an event: no read finds them yet.
      const events: unknown[] = []
      for (
        let hop: Answer | undefined = answer;
        hop?.cause === 'awaiting-a-child';
        hop = hop.awaits
      ) {
        events.push(hop.facts.event)
      }
      expect(events).toEqual(chain.slice(1, CHILD_HOPS + 1).map(taskDoneEventName))
      expect(JSON.stringify(answer)).not.toContain('waitingTasks')
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

  it('reads a ring of awaits once: a task that waits on itself, and two that wait on each other', async () => {
    const reads = async (db: CliDb, taskId: string) => {
      const asked = await ask(db, taskId)
      return {
        cause: asked.answer.cause,
        verdict: asked.answer.verdict,
        followed: [asked.answer.facts.followed, asked.answer.awaits?.facts.followed],
        reads: asked.reads,
      }
    }
    // The store lets a run await any task of its queue, its own among them.
    const alone = await openCliDb('libsql', 'explain-ring-of-one')
    try {
      const task = await alone.store.spawn(QUEUE, 'job', '{}')
      const run = await claimActivated(alone, 'w-self', task.taskId)
      await alone.store.awaitTaskDone(
        QUEUE,
        task.taskId,
        run.runId,
        run.claimToken,
        'await-self',
        task.taskId,
        null,
      )
      expect(
        await reads(alone, task.taskId),
        'mutation-verdict:behavior:cli-explain-reads-a-ring-of-awaits-once',
      ).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'stuck',
        followed: ['ring', undefined],
        reads: 1,
      })
    } finally {
      await alone.close()
    }
    const pair = await openCliDb('libsql', 'explain-ring-of-two')
    try {
      const [first, second] = await chainOfAwaits(pair, 2)
      const run = await claimActivated(pair, 'w-second', second ?? '')
      await pair.store.awaitTaskDone(
        QUEUE,
        second ?? '',
        run.runId,
        run.claimToken,
        'await-first',
        first ?? '',
        null,
      )
      expect(await reads(pair, first ?? '')).toEqual({
        cause: 'awaiting-a-child',
        verdict: 'stuck',
        followed: ['followed', 'ring'],
        reads: 2,
      })
    } finally {
      await pair.close()
    }
  })

  it('a ring of awaits that no clock ends is stuck, and one that a timeout or a deadline ends is waiting', async () => {
    type SpawnOptions = Parameters<CliDb['store']['spawn']>[3]
    /** A task parked on its own completion, under a timeout or with none. */
    const waitsOnItself = async (
      db: CliDb,
      timeoutSeconds: number | null,
      options: SpawnOptions,
    ) => {
      const task = await db.store.spawn(QUEUE, 'job', '{}', options)
      const run = await claimActivated(db, 'w-self', task.taskId)
      await db.store.awaitTaskDone(
        QUEUE,
        task.taskId,
        run.runId,
        run.claimToken,
        'await-self',
        task.taskId,
        timeoutSeconds,
      )
      return task.taskId
    }
    const read = async (db: CliDb, taskId: string) => {
      const answer = await explain(db, taskId)
      return {
        cause: answer.cause,
        verdict: answer.verdict,
        nextTransitionAtMs: answer.nextTransitionAtMs,
        next: answer.next?.argv[0] ?? null,
        ringEndedBy: answer.facts.ringEndedBy,
      }
    }
    const ring = { cause: 'awaiting-a-child', next: null }
    // No timeout and no cancellation deadline: nothing ends the wait, now or a year on, so
    // no move can come. The next command is a look, and never a cancel.
    const never = await openCliDb('libsql', 'explain-ring-nothing-ends')
    try {
      const taskId = await waitsOnItself(never, null, {})
      const stuck = {
        ...ring,
        verdict: 'stuck',
        nextTransitionAtMs: null,
        next: 'inspect',
        ringEndedBy: 'nothing',
      }
      expect(
        await read(never, taskId),
        'mutation-verdict:behavior:cli-explain-a-ring-no-clock-ends-is-stuck',
      ).toEqual(stuck)
      await never.admin.setFakeNowEpochMs(NOW_MS + 365 * 86_400_000)
      expect(await read(never, taskId)).toEqual(stuck)
    } finally {
      await never.close()
    }
    // A timeout on the await, or a cancellation deadline on the task, ends the ring.
    const ended = {
      ...ring,
      verdict: 'waiting',
      nextTransitionAtMs: NOW_MS + 60_000,
      ringEndedBy: 'a-clock',
    }
    const timed = await openCliDb('libsql', 'explain-ring-timeout')
    try {
      expect(await read(timed, await waitsOnItself(timed, 60, {}))).toEqual(ended)
    } finally {
      await timed.close()
    }
    const bounded = await openCliDb('libsql', 'explain-ring-deadline')
    try {
      const options = { cancellation: { maxDurationSeconds: 60 } }
      expect(await read(bounded, await waitsOnItself(bounded, null, options))).toEqual(ended)
    } finally {
      await bounded.close()
    }
    // Two tasks that wait on each other, where only the second's await has a timeout: the
    // first has no clock of its own, and the second's ends the ring for both. Asked about
    // either, the ring closes at the other, so the facts of the task asked about name none.
    const pair = await openCliDb('libsql', 'explain-ring-one-clock')
    try {
      const [first, second] = await chainOfAwaits(pair, 2)
      const run = await claimActivated(pair, 'w-second', second ?? '')
      await pair.store.awaitTaskDone(
        QUEUE,
        second ?? '',
        run.runId,
        run.claimToken,
        'await-first',
        first ?? '',
        60,
      )
      expect({
        first: await read(pair, first ?? ''),
        second: await read(pair, second ?? ''),
      }).toEqual({
        first: { ...ring, verdict: 'waiting', nextTransitionAtMs: null },
        second: { ...ring, verdict: 'waiting', nextTransitionAtMs: NOW_MS + 60_000 },
      })
    } finally {
      await pair.close()
    }
  })

  it('every suggestion emitted parses, holds no --yes and never names emit', async () => {
    const emitted: string[][] = []
    for (const seed of EXPLAIN_SEEDS) {
      await onSeed('libsql', seed, async (db, taskId, at) => {
        // The environment names a deployment, so a cause that names `tick` is filled.
        const env = { ...db.env, DURABLERUN_BASE_URL: 'https://deployment.example/app' }
        const asked = async () => {
          const run = await runCli(['explain', taskId, '--queue', QUEUE, '--json'], env)
          return JSON.parse(run.stdout) as Answer
        }
        const answers = [await asked()]
        // The same seed once the driver is late for it, for the causes that have a clock.
        await at(NOW_MS + 30 * 86_400_000)
        answers.push(await asked())
        for (const answer of answers) {
          if (answer.next === null) continue
          emitted.push(answer.next.argv)
          expect(answer.next.command).toBe(`pnpm cli ${answer.next.argv.join(' ')}`)
        }
      })
    }
    // And every cause under every verdict, handed everything `explain` can be given, so the
    // builder is asked about pairs no seed reaches.
    const built: string[][] = []
    for (const cause of Object.keys(CAUSES) as Cause[]) {
      for (const verdict of VERDICTS) {
        const next = suggestion({ cause, verdict, taskId: 'a-task' }, EVERYTHING_GIVEN)
        if (next === null) continue
        if ('withheld' in next) throw new Error(`${cause} under ${verdict}: ${next.withheld}`)
        built.push([...next])
      }
    }
    for (const argv of [...emitted, ...built]) {
      expect(
        {
          argv,
          confirms: argv.includes('--yes'),
          emits: argv[0] === 'emit',
          cancels: argv[0] === 'cancel',
        },
        'mutation-verdict:behavior:cli-explain-suggests-no-yes',
      ).toEqual({ argv, confirms: false, emits: false, cancels: false })
    }
    // Every suggestion parses as the command it names, the ones printed and the ones built.
    for (const argv of [...emitted, ...built]) {
      expect(parseInvocation(argv).spec.verb).toBe(argv[0])
    }
    // Two reads and the two drive verbs a late cause names, and no other command.
    const verbs = new Set(['result', 'inspect', 'sweep', 'tick'])
    expect(new Set(emitted.map((argv) => argv[0]))).toEqual(verbs)
    expect(new Set(built.map((argv) => argv[0]))).toEqual(verbs)
    // A waiting verdict owes no command, whatever the cause.
    for (const cause of Object.keys(CAUSES) as Cause[]) {
      expect(
        suggestion({ cause, verdict: 'waiting', taskId: 'a-task' }, EVERYTHING_GIVEN),
        'mutation-verdict:behavior:cli-explain-a-waiting-verdict-owes-no-command',
      ).toBeNull()
    }
  }, 120_000)

  it('says what each cause that names a drive verb suggests, filled only from what explain was given', () => {
    // Every cause names a command the table holds: no suggestion waits for a verb.
    expect(
      Object.entries(CAUSES)
        .filter(([, spec]) => spec.next !== null && !Object.hasOwn(COMMANDS, spec.next))
        .map(([cause]) => cause),
    ).toEqual([])
    const stuck = (cause: Cause, given: Given) =>
      suggestion({ cause, verdict: 'stuck', taskId: 'a-task' }, given)
    // The five causes whose command is a drive verb, each with what it prints when the
    // driver is late: a sweep of the queue with the store named again, or a tick of the
    // deployment the environment names. Neither takes a task.
    const driven = (Object.keys(CAUSES) as Cause[]).filter((cause) =>
      ['sweep', 'tick'].includes(CAUSES[cause].next ?? ''),
    )
    const sweep = ['sweep', '--queue=q', '--target=db.example.io:5432']
    const tick = ['tick', '--url=https://deployment.example']
    expect(
      Object.fromEntries(driven.map((cause) => [cause, stuck(cause, EVERYTHING_GIVEN)])),
      'mutation-verdict:behavior:cli-explain-fills-a-drive-verb-from-what-it-was-given',
    ).toEqual({
      'cancellation-deadline-passed': sweep,
      'lease-lapsed-unswept': sweep,
      'woken-unclaimed': tick,
      'pending-due-unclaimed': tick,
      'sleeping-past-its-wake': tick,
    })
    // With no deployment named, a tick is withheld with its reason, and a sweep is not.
    const noDeployment = { queue: QUEUE, target: 'db.example.io:5432' }
    expect(stuck('pending-due-unclaimed', noDeployment)).toEqual({
      withheld: 'explain knows no value for --url of tick',
    })
    expect(stuck('lease-lapsed-unswept', noDeployment)).toEqual(sweep)
    // A command whose argument `explain` has no value for is withheld the same way.
    const unknown: CommandSpec = { ...COMMANDS.result, positionals: ['somethingElse'] }
    expect(
      suggestion({ cause: 'completed', verdict: 'ok', taskId: 'a-task' }, EVERYTHING_GIVEN, {
        result: unknown,
      }),
    ).toEqual({ withheld: 'explain knows no value for <somethingElse> of result' })
  })

  it('builds a next command the parser of the CLI reads, for a queue whose name begins with a dash', async () => {
    const db = await openCliDb('libsql', 'explain-dash-queue')
    try {
      for (const queue of ['-q', '--json']) {
        const task = await db.store.spawn(queue, 'job', '{}')
        const run = await claimActivated(db, `w${queue}`, task.taskId, queue)
        await db.store.complete(queue, run.runId, run.claimToken, '{}')
        const printed = await runCli(['explain', task.taskId, `--queue=${queue}`, '--json'], db.env)
        const next = (JSON.parse(printed.stdout) as Answer).next
        if (next === null) throw new Error('a completed task prints a next command')
        /** What the parser reads of the suggestion, or the words it refuses it with. */
        const parsed = (() => {
          try {
            const { spec, args, strings } = parseInvocation(next.argv)
            return { verb: spec.verb, taskId: args.taskId, queue: strings.queue }
          } catch (error) {
            return String(error).split('\n')[0]
          }
        })()
        expect(
          { queue, parsed },
          'mutation-verdict:behavior:cli-explain-a-required-flag-and-its-value-are-one-argument',
        ).toEqual({ queue, parsed: { verb: 'result', taskId: task.taskId, queue } })
        // The one line to paste is the same arguments, as a shell reads it back.
        expect(shellReads(next.command)).toEqual(next.argv)
      }
    } finally {
      await db.close()
    }
  })

  it('withholds a next command it cannot fill, and says what it has no value for', () => {
    // `sweep` writes, so it requires the store named again with --target. Handed no target,
    // the builder has no value for it.
    const built = (() => {
      try {
        return suggestion(
          { cause: 'lease-lapsed-unswept', verdict: 'stuck', taskId: 'a-task' },
          { queue: QUEUE },
        )
      } catch (error) {
        return `threw ${String(error)}`
      }
    })()
    expect(
      built,
      'mutation-verdict:behavior:cli-explain-withholds-a-command-it-cannot-fill',
    ).toEqual({ withheld: 'explain knows no value for --target of sweep' })
    // The diagnosis stands without the command, and the answer says why there is none.
    const stuck: Diagnosis = {
      taskId: 'a-task',
      cause: 'lease-lapsed-unswept',
      verdict: 'stuck',
      nextTransitionAtMs: null,
      ended: false,
      facts: { runId: 'a-run' },
    }
    expect(answerView(stuck, { queue: QUEUE })).toMatchObject({
      taskId: 'a-task',
      cause: 'lease-lapsed-unswept',
      verdict: 'stuck',
      facts: { runId: 'a-run' },
      next: null,
      nextWithheld: 'explain knows no value for --target of sweep',
    })
  })

  it('prints a suggestion as one line a shell reads back as the same arguments', () => {
    const argv = ['inspect', "a task's id", '--queue=a queue; rm -rf "$HOME"']
    const line = pastedLine(argv)
    expect(line.startsWith('pnpm cli ')).toBe(true)
    expect(shellReads(line), 'mutation-verdict:behavior:cli-explain-quotes-a-pasted-line').toEqual(
      argv,
    )
    // A plain word is pasted as it is.
    expect(pastedLine(['result', 'task-01', '--queue=q'])).toBe('pnpm cli result task-01 --queue=q')
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
    // An integer outside its bounds, fixture-built: the cause names the field and its row.
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
        facts: { notReadable: [{ field: 'runs.claim_gen', runId: expect.any(String) }] },
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

/** The engine's guards admit the row: its claim takes the run, and its sweep the run and the task. */
const THE_ENGINE_TAKES_IT = { claimTakes: true, sweepReclaims: true, sweepCancels: true }

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
    // Every piece of evidence a cause could ask for is handed over, so an arm that takes one
    // of these shapes answers its cause, and the comparison below is what fails.
    const evidence = {
      checkpoints: 1,
      waiters: { waiters: { rows: [], atLeast: false }, corrupt: [] },
    }
    for (const [shape, facts] of Object.entries(shapes)) {
      const answer = answered(diagnose(facts, evidence))
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

  it('says of a row that is not readable which row it is and which field, and quotes no stored value', () => {
    const rogue = `rogue-${SENTINEL}`
    const parked = {
      state: 'sleeping',
      wakeEvent: 'e',
      wakeStep: 's',
      availableAtMs: null,
    } as const
    const corrupt = {
      field: 'runs.attempt',
      runId: 'r',
      reason: 'out-of-range',
      stored: 'number',
      value: '-3',
    } as const
    const facts = (given: TaskFacts) => {
      const answer = answered(diagnose(given))
      expect(JSON.stringify(answer)).not.toContain(SENTINEL)
      return [answer.cause, answer.facts]
    }
    expect(
      {
        run: facts(factsOf({ state: rogue }, { task: { state: 'pending' } })),
        wait: facts(factsOf(parked, { waits: [{ ...waitOf('e', null), status: rogue }] })),
        integer: facts(factsOf({ attempt: null }, { corrupt: [corrupt] })),
        outcome: facts({ ...factsOf({}), outcome: { refused: `refused ${rogue}` } }),
        // A task's own state is refused by the outcome's decoder, and is named as well.
        task: facts({
          ...factsOf({}, { task: { state: rogue } }),
          outcome: { refused: `task t has unknown state ${rogue}` },
        }),
      },
      'mutation-verdict:behavior:cli-explain-unreadable-names-the-row-and-the-field',
    ).toEqual({
      run: ['unreadable', { notReadable: [{ field: 'runs.state', runId: 'r' }] }],
      wait: ['unreadable', { notReadable: [{ field: 'waits.status', runId: 'r', stepName: 's' }] }],
      integer: ['unreadable', { notReadable: [{ field: 'runs.attempt', runId: 'r' }] }],
      outcome: ['unreadable', { notReadable: [{ field: 'outcome' }] }],
      task: ['unreadable', { notReadable: [{ field: 'outcome' }, { field: 'tasks.state' }] }],
    })
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
      // A move is owed, so the cause first asks whether the engine's sweep takes it.
      expect(diagnose(facts)).toEqual({ needs: 'admission' })
      const answer = answered(diagnose(facts, { admission: THE_ENGINE_TAKES_IT }))
      expect([run, answer.cause, answer.verdict, answer.facts.dueAtMs]).toEqual([
        run,
        'cancellation-deadline-passed',
        'waiting',
        NOW_MS - 1,
      ])
    }
  })

  it('asks whether the engine takes a move it is owed, names the row it does not take, and reads a row that moved as it stood', () => {
    const lateBy = NOW_MS - DUE_GRACE_MS - 1
    // One state for each move the driver owes: a deadline passed, a lease lapsed, a pending
    // run due, and a sleeping run past its wake, each later than the grace.
    const owed = {
      deadline: factsOf(
        { state: 'pending', availableAtMs: NOW_MS + 60_000 },
        { task: { cancelAtMs: lateBy } },
      ),
      lease: factsOf({ state: 'running', claimExpiresAtMs: lateBy }),
      pending: factsOf({ state: 'pending', availableAtMs: lateBy, activatedGen: 0, claimGen: 0 }),
      sleeping: factsOf({ state: 'sleeping', availableAtMs: lateBy }),
    }
    const taken = THE_ENGINE_TAKES_IT
    const read = (facts: TaskFacts, admission: NonNullable<Evidence['admission']>) => {
      const answer = answered(diagnose(facts, { admission, checkpoints: 1 }))
      return [answer.cause, answer.verdict, answer.facts.owedAtMs ?? answer.facts.dueAtMs]
    }
    const each = (admission: NonNullable<Evidence['admission']>) =>
      Object.fromEntries(
        Object.entries(owed).map(([move, facts]) => [move, read(facts, admission)]),
      )
    for (const facts of Object.values(owed)) {
      expect(diagnose(facts, { checkpoints: 1 })).toEqual({ needs: 'admission' })
    }
    // Every guard admits the row: the late cause answers, and the driver is late for it.
    const late = {
      deadline: ['cancellation-deadline-passed', 'stuck', lateBy],
      lease: ['lease-lapsed-unswept', 'stuck', lateBy],
      pending: ['pending-due-unclaimed', 'stuck', lateBy],
      sleeping: ['sleeping-past-its-wake', 'stuck', lateBy],
    }
    expect(each(taken)).toEqual(late)
    // The one guard that would take the move refuses the row: no tick and no sweep comes to
    // it, and the cause says so, however the other two answer.
    expect(
      {
        deadline: read(owed.deadline, { ...taken, sweepCancels: false }),
        lease: read(owed.lease, { ...taken, sweepReclaims: false }),
        pending: read(owed.pending, { ...taken, claimTakes: false }),
        sleeping: read(owed.sleeping, { ...taken, claimTakes: false }),
      },
      'mutation-verdict:behavior:cli-explain-names-a-move-the-engine-does-not-take',
    ).toEqual({
      deadline: ['deadline-no-sweep-cancels', 'inconsistent', lateBy],
      lease: ['lapsed-lease-no-sweep-reclaims', 'inconsistent', lateBy],
      pending: ['due-run-no-claim-admits', 'inconsistent', lateBy],
      sleeping: ['due-run-no-claim-admits', 'inconsistent', lateBy],
    })
    // A guard that refuses a move the cause is not about decides nothing.
    expect({
      deadline: read(owed.deadline, { ...taken, claimTakes: false, sweepReclaims: false }),
      lease: read(owed.lease, { ...taken, claimTakes: false, sweepCancels: false }),
      pending: read(owed.pending, { ...taken, sweepReclaims: false, sweepCancels: false }),
    }).toEqual({ deadline: late.deadline, lease: late.lease, pending: late.pending })
    // The rows moved between the two reads: the answer is read as it stood, and asking
    // again answers it.
    expect(
      each('moved'),
      'mutation-verdict:behavior:cli-explain-reads-a-row-that-moved-as-it-stood',
    ).toEqual(late)
  })

  it('asks for the waits on the event an await names, and lists every one of them', () => {
    const parked = factsOf(
      { state: 'sleeping', wakeEvent: 'approval', wakeStep: 's', availableAtMs: null },
      { waits: [waitOf('approval', null)] },
    )
    expect(diagnose(parked)).toEqual({ needs: 'waiters', eventName: 'approval' })
    const waiter = (taskId: string, timeoutAtMs: number | null) => ({
      taskId,
      runId: `run-of-${taskId}`,
      stepName: 's',
      timeoutAtMs,
    })
    const rows = [waiter('t', null), waiter('u', NOW_MS + 5_000), waiter('v', null)]
    const listed = answered(
      diagnose(parked, { waiters: { waiters: { rows, atLeast: true }, corrupt: [] } }),
    )
    expect([listed.cause, listed.verdict, listed.facts]).toEqual([
      'awaiting-an-untimed-event',
      'waiting',
      {
        runId: 'r',
        event: 'approval',
        step: 's',
        waiters: rows.map(({ taskId, runId, timeoutAtMs }) => ({
          taskId,
          runId,
          step: 's',
          timeoutAtMs,
        })),
        moreWaiters: true,
      },
    ])
    // A wait of the list whose timeout is not readable is named, and no list is printed
    // beside it: the answer is the one a row of the task's own gets.
    const refused = answered(
      diagnose(parked, {
        waiters: {
          waiters: { rows, atLeast: false },
          corrupt: [
            {
              field: 'waits.timeout_at_ms',
              runId: 'run-of-u',
              stepName: 's',
              reason: 'out-of-range',
              stored: 'number',
              value: '-7',
            },
          ],
        },
      }),
    )
    expect([refused.cause, refused.verdict, refused.facts]).toEqual([
      'unreadable',
      'inconsistent',
      { notReadable: [{ field: 'waits.timeout_at_ms', runId: 'run-of-u', stepName: 's' }] },
    ])
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
    const admission = THE_ENGINE_TAKES_IT
    expect([
      answered(diagnose(overdue, { checkpoints: 0, admission })).verdict,
      answered(diagnose(overdue, { checkpoints: 1, admission })).verdict,
    ]).toEqual(['waiting', 'stuck'])

    const child = taskDoneEventName('the-child')
    const parent = factsOf(
      { state: 'sleeping', wakeEvent: child, wakeStep: 's', availableAtMs: NOW_MS + 60_000 },
      { waits: [waitOf(child, NOW_MS + 60_000)] },
    )
    expect(diagnose(parent)).toEqual({ needs: 'child', taskId: 'the-child' })
    // Once the child is read, the cause asks for the waits on the child's completion.
    expect(diagnose(parent, { child: 'absent' })).toEqual({ needs: 'waiters', eventName: child })
    const waiters = { waiters: { rows: [], atLeast: false }, corrupt: [] }
    const through = (evidence: Parameters<typeof diagnose>[1]) => {
      const answer = answered(diagnose(parent, { ...evidence, waiters }))
      return [answer.cause, answer.verdict, answer.nextTransitionAtMs, answer.facts.followed]
    }
    const childIs = (cause: Cause, verdict: Verdict, ended = false): Diagnosis => ({
      taskId: 'the-child',
      cause,
      verdict,
      nextTransitionAtMs: null,
      ended,
      facts: {},
    })
    expect(
      {
        absent: through({ child: 'absent' }),
        notFollowed: through({ child: 'not-followed' }),
        waiting: through({ child: childIs('sleeping-on-a-timer', 'waiting') }),
        running: through({ child: childIs('running-under-a-live-lease', 'ok') }),
        // An ok child that has not ended is one a worker runs, whatever its cause is called.
        runningLong: through({ child: childIs('running-past-the-hung-bound', 'ok') }),
        stuck: through({ child: childIs('pending-due-unclaimed', 'stuck') }),
        inconsistent: through({ child: childIs('unreadable', 'inconsistent') }),
        unexplained: through({ child: childIs('unexplained', 'unexplained') }),
        // A child that ended woke its waiters in the batch that ended it.
        ended: through({ child: childIs('completed', 'ok', true) }),
      },
      'mutation-verdict:behavior:cli-explain-vouches-for-no-child-it-cannot-read-as-live',
    ).toEqual({
      absent: ['awaiting-a-child', 'unexplained', null, 'absent'],
      notFollowed: ['awaiting-a-child', 'unexplained', null, 'not-followed'],
      // The parent's own next instant is its await's timeout.
      waiting: ['awaiting-a-child', 'waiting', NOW_MS + 60_000, 'followed'],
      running: ['awaiting-a-child', 'waiting', NOW_MS + 60_000, 'followed'],
      runningLong: ['awaiting-a-child', 'waiting', NOW_MS + 60_000, 'followed'],
      stuck: ['awaiting-a-child', 'stuck', null, 'followed'],
      inconsistent: ['awaiting-a-child', 'inconsistent', null, 'followed'],
      unexplained: ['awaiting-a-child', 'unexplained', null, 'followed'],
      ended: ['awaiting-a-child', 'unexplained', null, 'followed'],
    })
  })
})

describe('explain of an await on libSQL', () => {
  it('answers unreadable and exits 10 when another wait on the same event holds a timeout that is not readable', async () => {
    const db = await openCliDb('libsql', 'explain-waiter-not-readable')
    try {
      const asked = await parkedOnAnEvent(db, null)
      const other = await parkedOnAnEvent(db, 300)
      const before = await explain(db, asked)
      expect({ exit: before.exit, cause: before.cause }).toEqual({
        exit: 0,
        cause: 'awaiting-an-untimed-event',
      })
      // Fixture-built: no engine path writes a timeout outside its bounds.
      await fixture(db, 'UPDATE waits SET timeout_at_ms = -7 WHERE task_id = ?', [other])
      const answer = await explain(db, asked)
      expect(
        { exit: answer.exit, cause: answer.cause, verdict: answer.verdict, facts: answer.facts },
        'mutation-verdict:behavior:cli-explain-names-a-waiter-it-cannot-read',
      ).toEqual({
        exit: 10,
        cause: 'unreadable',
        verdict: 'inconsistent',
        facts: {
          notReadable: [
            { field: 'waits.timeout_at_ms', runId: expect.any(String), stepName: 'approve' },
          ],
        },
      })
      // In text the answer prints on stdout, as every answer of explain does.
      const text = await runCli(['explain', asked, '--queue', QUEUE], db.env)
      expect({
        exit: text.exit,
        stderr: text.stderr,
        names: text.stdout.includes('waits.timeout_at_ms'),
      }).toEqual({
        exit: 10,
        stderr: '',
        names: true,
      })
    } finally {
      await db.close()
    }
  })

  it('reads the waiters of an event once for each task it follows that awaits one', async () => {
    const db = await openCliDb('libsql', 'explain-waiter-reads')
    try {
      const [parent] = await chainOfAwaits(db, 3)
      const recording = recordingOpener()
      const answer = await explain(db, parent ?? '', recording.opener)
      const sent = (label: string) =>
        recording.sent().filter((batch) => batch.label === label).length
      // Two of the three tasks await their child. The last is due and awaits nothing.
      expect({
        cause: answer.cause,
        facts: sent('task-facts'),
        waiters: sent('event-waiters'),
      }).toEqual({ cause: 'awaiting-a-child', facts: 3, waiters: 2 })
    } finally {
      await db.close()
    }
  })
})
