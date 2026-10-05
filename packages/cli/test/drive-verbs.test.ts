import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RETRY_GUARD, type RetryGuardConjunct } from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { RETRY_REFUSALS } from '../../conformance/src/operator-admission.js'
import { Q as PLANTED_IN } from '../../conformance/src/operator-reads.js'
import { COMMANDS, SWEEP_DEFAULT_LIMIT, VERBS } from '../src/commands.js'
import { CAUSE_OF_CONJUNCT, RETRY_CAUSES } from '../src/drive.js'
import { exitCode } from '../src/exit.js'
import { type StoreOpener, openStore } from '../src/open-store.js'
import { userValue } from '../src/render.js'
import { fixture, parkedOnAnEvent } from './explain-seeds.js'
import { owedToASweep } from './queue-seeds.js'
import {
  type CliDb,
  type JsonAnswer,
  NOW_MS,
  QUEUE,
  SENTINEL,
  type SeededTasks,
  onDb,
  recordingOpener,
  rollingBack,
  runCli,
  sagaStepStarted,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * The drive verbs through `main` on libSQL (exit test line 38): what each prints, the
 * stream it prints on and the exit it ends in, what it refuses, and that a refusal changes
 * nothing and names its cause from a read after the port answered. That each verb is the
 * store's port call and nothing else is held on every dialect by drive-twin.test.ts.
 */

/** A command line without one flag and its value. */
const without = (line: readonly string[], flag: string): string[] =>
  line.filter((word, index) => word !== flag && line[index - 1] !== flag)

let driven = 0
/** Run a command with --json. Each run is a process of its own, so each mints ids of its own. */
async function drive(db: CliDb, argv: readonly string[], env: CliDb['env'] = db.env) {
  driven += 1
  const run = await runCli([...argv, '--json'], env, undefined, testIdSource(`driven-${driven}`))
  return { exit: run.exit, stderr: run.stderr, answer: JSON.parse(run.stdout) as JsonAnswer }
}

/** What a run changed: its answer, and whether a dump of every table is as it was before. */
async function changedBy<T>(db: CliDb, run: () => Promise<T>) {
  const before = await db.dump()
  const out = await run()
  return { out, unchanged: (await db.dump()) === before }
}

interface Seeded extends SeededTasks {
  /** Pending, and past the deadline it had to start by, so a sweep cancels it. */
  readonly doomed: string
}

/** The seeded tasks, one more that a sweep cancels, and the clock a minute on. */
async function seeded(db: CliDb): Promise<Seeded> {
  const tasks = await seedTasks(db)
  const doomed = await db.store.spawn(QUEUE, 'doomed', '{}', {
    cancellation: { maxDelaySeconds: 30 },
  })
  await db.admin.setFakeNowEpochMs(NOW_MS + 60_000)
  return { ...tasks, doomed: doomed.taskId }
}

/**
 * Each verb that writes through a store: a command line that changes the database when it
 * runs against the seeded tasks, and whether the verb takes --yes.
 */
const WRITES = {
  enqueue: {
    line: (db: CliDb, _seeded: Seeded) => [
      'enqueue',
      'report',
      '--key',
      'order-7',
      ...writeFlags(db),
    ],
    yes: false,
  },
  emit: {
    line: (db: CliDb, _seeded: Seeded) => ['emit', 'approval', '--yes', ...writeFlags(db)],
    yes: true,
  },
  cancel: {
    line: (db: CliDb, tasks: Seeded) => ['cancel', tasks.pending, '--yes', ...writeFlags(db)],
    yes: true,
  },
  retry: {
    line: (db: CliDb, tasks: Seeded) => ['retry', tasks.failed, '--yes', ...writeFlags(db)],
    yes: true,
  },
  sweep: {
    line: (db: CliDb, _seeded: Seeded) => ['sweep', ...writeFlags(db)],
    yes: false,
  },
} as const
type WriteVerb = keyof typeof WRITES
const WRITE_VERBS = Object.keys(WRITES) as WriteVerb[]

/** The cause the CLI names for each conjunct of the retry guard, written out and not read from the code. */
const CAUSE_NAMED: Readonly<Record<RetryGuardConjunct, string>> = {
  failed: 'not-failed',
  ownsEveryRun: 'run-in-another-queue',
  hasAFailureReason: 'no-failure-reason',
  hasNoCompletedPayload: 'completed-payload',
  hasARun: 'no-run',
  hasNoLiveRun: 'live-run',
  attemptsInRange: 'counter-out-of-range',
  infraRetriesInRange: 'counter-out-of-range',
  everyRunOrdinalInRange: 'counter-out-of-range',
  budgetTakesOneMore: 'counter-out-of-range',
  chargeIsTheAttemptsOrOneMore: 'out-of-accounting',
  sagaNotBegun: 'saga-began',
  chargeWithinBudget: 'out-of-accounting',
}

describe('the drive verbs on libSQL', () => {
  it('are the commands of the table that write through a store, and each requires --target and --queue', () => {
    expect(
      VERBS.filter(
        (verb) => COMMANDS[verb].opensStore && COMMANDS[verb].writes && verb !== 'migrate',
      ),
    ).toEqual(WRITE_VERBS)
    for (const verb of WRITE_VERBS) {
      const { flags } = COMMANDS[verb]
      expect({
        verb,
        target: flags.target?.required,
        queue: flags.queue?.required,
        // The three that an operator should read first take --yes, and the two that are
        // safe to send again do not.
        yes: Object.hasOwn(flags, 'yes'),
      }).toEqual({ verb, target: true, queue: true, yes: WRITES[verb].yes })
    }
    // An idempotency key is not optional: a repeat after a lost answer must find its task.
    expect(COMMANDS.enqueue.flags.key?.required).toBe(true)
  })

  it('a write with a --target that is not its store exits 2, opens nothing and changes nothing, whichever verb it is', async () => {
    for (const verb of WRITE_VERBS) {
      await onDb(`drive-target-${verb}`, async (db) => {
        const tasks = await seeded(db)
        const line = WRITES[verb].line(db, tasks)
        const elsewhere = line.map((word) => (word === db.target ? `${db.target}.other` : word))
        const { opener, sent } = recordingOpener()
        const before = await db.dump()
        const refused = await runCli([...elsewhere, '--json'], db.env, opener)
        expect(
          {
            verb,
            exit: refused.exit,
            kind: (JSON.parse(refused.stdout) as JsonAnswer).error?.kind,
            sent: sent().length,
            unchanged: (await db.dump()) === before,
          },
          'mutation-verdict:behavior:cli-a-drive-verb-names-its-store',
        ).toEqual({ verb, exit: 2, kind: 'target-mismatch', sent: 0, unchanged: true })
        // With no --target at all the command line is refused as the table refuses it.
        const unnamed = await changedBy(db, () => drive(db, without(line, '--target')))
        expect({ verb, exit: unnamed.out.exit, unchanged: unnamed.unchanged }).toEqual({
          verb,
          exit: 2,
          unchanged: true,
        })
        // The control: named for its own store, the same command changes the database.
        const sentRight = await changedBy(db, () => drive(db, line))
        expect({ verb, exit: sentRight.out.exit, unchanged: sentRight.unchanged }).toEqual({
          verb,
          exit: 0,
          unchanged: false,
        })
      })
    }
  })

  it('emit, cancel and retry without --yes exit 2 with confirmation-required, change nothing and say what they would do, and with --yes change the database', async () => {
    for (const verb of WRITE_VERBS.filter((one) => WRITES[one].yes)) {
      await onDb(`drive-yes-${verb}`, async (db) => {
        const tasks = await seeded(db)
        const line = WRITES[verb].line(db, tasks)
        const unconfirmed = line.filter((word) => word !== '--yes')
        const asked = await changedBy(db, () => drive(db, unconfirmed))
        expect(
          {
            verb,
            exit: asked.out.exit,
            kind: asked.out.answer.error?.kind,
            unchanged: asked.unchanged,
            saysWhatItWouldDo: asked.out.answer.error?.message?.includes(`${verb} would`),
          },
          'mutation-verdict:behavior:cli-a-confirmed-write-changes-nothing-without-yes',
        ).toEqual({
          verb,
          exit: 2,
          kind: 'confirmation-required',
          unchanged: true,
          saysWhatItWouldDo: true,
        })
        // In text the refusal prints on stderr.
        const text = await runCli(unconfirmed, db.env)
        expect({
          verb,
          exit: text.exit,
          stdout: text.stdout,
          names: text.stderr.includes('kind: confirmation-required'),
        }).toEqual({ verb, exit: 2, stdout: '', names: true })
        // The control: confirmed, the same command changes the database.
        const confirmed = await changedBy(db, () => drive(db, line))
        expect({ verb, exit: confirmed.out.exit, unchanged: confirmed.unchanged }).toEqual({
          verb,
          exit: 0,
          unchanged: false,
        })
      })
    }
  })

  it('reads no store and no queue from another variable: TURSO_* and DURABLERUN_QUEUE are not read', () =>
    onDb('drive-no-fallback', async (db) => {
      const tasks = await seeded(db)
      const elsewhere = {
        TURSO_DATABASE_URL: db.url,
        TURSO_AUTH_TOKEN: 'a-token',
        DURABLERUN_QUEUE: QUEUE,
      }
      const before = await db.dump()
      const answers: unknown[] = []
      for (const verb of WRITE_VERBS) {
        const line = WRITES[verb].line(db, tasks)
        // No DURABLERUN_STORE_URL: the store another variable names is not opened.
        const noStore = await drive(db, line, elsewhere)
        // No --queue: the queue another variable names is not written to.
        const noQueue = await drive(db, without(line, '--queue'), { ...db.env, ...elsewhere })
        answers.push({
          verb,
          noStore: [noStore.exit, noStore.answer.error?.message],
          noQueue: [noQueue.exit, noQueue.answer.error?.message?.split('\n')[0]],
        })
      }
      expect(answers, 'mutation-verdict:behavior:cli-store-url-has-no-fallback').toEqual(
        WRITE_VERBS.map((verb) => ({
          verb,
          noStore: [2, 'set DURABLERUN_STORE_URL to the store to open'],
          noQueue: [2, `${verb} requires --queue`],
        })),
      )
      expect(await db.dump()).toBe(before)
    }))

  it('creates no database: a drive verb of a file that is not there exits 5 and leaves no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-drive-missing-'))
    try {
      const file = join(dir, 'never.sqlite')
      const env = { DURABLERUN_STORE_URL: `file:${file}` }
      const flags = ['--queue', QUEUE, '--target', file, '--json']
      const exits: unknown[] = []
      for (const line of [
        ['enqueue', 'report', '--key', 'a-key'],
        ['emit', 'an-event', '--yes'],
        ['cancel', 'a-task', '--yes'],
        ['retry', 'a-task', '--yes'],
        ['sweep'],
      ]) {
        const run = await runCli([...line, ...flags], env)
        exits.push([line[0], run.exit, existsSync(file)])
      }
      expect(exits, 'mutation-verdict:behavior:cli-a-drive-verb-creates-no-database').toEqual(
        WRITE_VERBS.map((verb) => [verb, exitCode('schema'), false]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('enqueue on libSQL', () => {
  it('spawns a task under its key with the parameters it was given, and a repeat under the key answers the same task', () =>
    onDb('drive-enqueue', async (db) => {
      const first = await drive(db, [
        'enqueue',
        'report',
        '--key',
        'order-7',
        '--params',
        '{ "a" : 1 }',
        ...writeFlags(db),
      ])
      expect({ exit: first.exit, created: first.answer.created }).toEqual({
        exit: 0,
        created: true,
      })
      // The task is the store's own: a claim takes its run, with the name and the
      // parameters, which were written as one canonical JSON value.
      const [claimed] = await db.store.claim(QUEUE, 'a-worker', { leaseSeconds: 60, limit: 1 })
      expect({
        taskId: claimed?.taskId,
        runId: claimed?.runId,
        taskName: claimed?.taskName,
        params: claimed?.paramsJson,
      }).toEqual({
        taskId: first.answer.taskId,
        runId: first.answer.runId,
        taskName: 'report',
        params: '{"a":1}',
      })
      // The same key again, from a process whose ids are its own, with other parameters:
      // nothing is created, and the answer names the task the first run made.
      const again = await changedBy(db, () =>
        drive(db, [
          'enqueue',
          'report',
          '--key',
          'order-7',
          '--params',
          '{"b":2}',
          ...writeFlags(db),
        ]),
      )
      expect({
        exit: again.out.exit,
        created: again.out.answer.created,
        taskId: again.out.answer.taskId,
        runId: again.out.answer.runId,
        unchanged: again.unchanged,
      }).toEqual({
        exit: 0,
        created: false,
        taskId: first.answer.taskId,
        runId: first.answer.runId,
        unchanged: true,
      })
      // With no --params the parameters are null, as a hosted enqueue's are.
      const bare = await drive(db, ['enqueue', 'report', '--key', 'order-8', ...writeFlags(db)])
      const [second] = await db.store.claim(QUEUE, 'a-worker-2', { leaseSeconds: 60, limit: 1 })
      expect({ taskId: second?.taskId, params: second?.paramsJson }).toEqual({
        taskId: bare.answer.taskId,
        params: 'null',
      })
      // In text the answer prints on stdout, with the key and the parameters as digests.
      const text = await runCli(
        ['enqueue', 'report', '--key', 'order-9', ...writeFlags(db)],
        db.env,
      )
      const key = userValue('order-9', false)
      expect({ exit: text.exit, stderr: text.stderr }).toEqual({ exit: 0, stderr: '' })
      expect(text.stdout.split('\n')).toEqual(
        expect.arrayContaining([
          'created: true',
          `idempotencyKey: <${key.bytes} bytes, sha256 ${key.sha256}>`,
        ]),
      )
    }))

  it('refuses a command line with no key, parameters that are no JSON and a key of the engine, and none changes anything', () =>
    onDb('drive-enqueue-refused', async (db) => {
      const before = await db.dump()
      const { opener, sent } = recordingOpener()
      const noJson = await runCli(
        ['enqueue', 'report', '--key', 'k', '--params', '{not json', ...writeFlags(db), '--json'],
        db.env,
        opener,
      )
      // Parameters that are no JSON are refused before anything opens.
      expect({ exit: noJson.exit, sent: sent().length }).toEqual({ exit: 2, sent: 0 })
      const noKey = await drive(db, ['enqueue', 'report', ...writeFlags(db)])
      expect([noKey.exit, noKey.answer.error?.message?.split('\n')[0]]).toEqual([
        2,
        'enqueue requires --key',
      ])
      // A key that starts with $ is the engine's. The port refuses it in words that quote
      // the key, so they print only with --reveal.
      const reserved = ['enqueue', 'report', '--key', '$spawn:forged', ...writeFlags(db)]
      const hidden = await drive(db, reserved)
      const shown = await drive(db, [...reserved, '--reveal'])
      expect({
        hidden: [hidden.exit, hidden.answer.error?.message?.includes('$spawn:forged')],
        shown: [shown.exit, shown.answer.error?.message?.includes('$spawn:forged')],
      }).toEqual({ hidden: [3, false], shown: [3, true] })
      expect(await db.dump()).toBe(before)
    }))
})

describe('emit on libSQL', () => {
  it('creates an event and wakes the runs parked on it, and a later emit is told the digest of the payload that stands', () =>
    onDb('drive-emit', async (db) => {
      const parked = await parkedOnAnEvent(db, null, {}, 'go-ahead')
      const flags = writeFlags(db)
      const first = await drive(db, [
        'emit',
        'go-ahead',
        '--payload',
        '{ "ok" : true }',
        '--yes',
        ...flags,
      ])
      const stored = userValue('{"ok":true}', false)
      expect(first).toMatchObject({
        exit: 0,
        answer: {
          outcome: 'created',
          event: 'go-ahead',
          waitersBefore: 1,
          moreWaiters: false,
          payloadMatches: true,
          storedPayload: stored,
        },
      })
      // The run that was parked is woken: it is due, and carries the event.
      const woken = await drive(db, ['explain', parked, '--queue', QUEUE])
      expect(woken.answer.cause).toBe('woken-unclaimed')
      // A second emit with another payload changes no payload. The answer says the event
      // was there, with the digest of what it holds, which is the first emit's.
      const second = await drive(db, [
        'emit',
        'go-ahead',
        '--payload',
        '{"ok":false}',
        '--yes',
        ...flags,
      ])
      expect(
        {
          exit: second.exit,
          outcome: second.answer.outcome,
          payloadMatches: second.answer.payloadMatches,
          storedPayload: second.answer.storedPayload,
          sent: second.answer.payload,
        },
        'mutation-verdict:behavior:cli-emit-says-already-emitted-with-the-stored-digest',
      ).toEqual({
        exit: 0,
        outcome: 'already-emitted',
        payloadMatches: false,
        storedPayload: stored,
        sent: userValue('{"ok":false}', false),
      })
      // The same payload again is still an event that was already there.
      const same = await drive(db, [
        'emit',
        'go-ahead',
        '--payload',
        '{"ok":true}',
        '--yes',
        ...flags,
      ])
      expect([same.answer.outcome, same.answer.payloadMatches]).toEqual(['already-emitted', true])
      // With no payload the event's payload is null, as a hosted emit's is.
      const bare = await drive(db, ['emit', 'bare', '--yes', ...flags])
      expect(bare.answer.storedPayload).toEqual(userValue('null', false))
    }))

  it("never prints the text of the payload an event holds, --reveal or not, and prints the caller's own only with --reveal", () =>
    onDb('drive-emit-redacted', async (db) => {
      // The seeded event's payload holds the sentinel.
      await seedTasks(db)
      const line = [
        'emit',
        'page-ready',
        '--payload',
        '{"mine":"caller-text"}',
        '--yes',
        ...writeFlags(db),
      ]
      const printed: string[] = []
      for (const extra of [[], ['--json'], ['--reveal'], ['--json', '--reveal']]) {
        const run = await runCli([...line, ...extra], db.env)
        expect(run.exit).toBe(0)
        printed.push(`${run.stdout}${run.stderr}`)
      }
      expect(
        printed.map((text) => text.includes(SENTINEL)),
        'mutation-verdict:behavior:cli-emit-never-prints-the-stored-payload',
      ).toEqual([false, false, false, false])
      // What the caller passed is the caller's own, and prints with --reveal.
      expect(printed.map((text) => text.includes('caller-text'))).toEqual([
        false,
        false,
        true,
        true,
      ])
    }))

  it('answers reserved-name for a name of the engine, and sends nothing', () =>
    onDb('drive-emit-reserved', async (db) => {
      const { opener, sent } = recordingOpener()
      const run = await runCli(
        ['emit', '$task-done:a-task', '--yes', ...writeFlags(db), '--json'],
        db.env,
        opener,
      )
      expect(
        {
          exit: run.exit,
          kind: (JSON.parse(run.stdout) as JsonAnswer).error?.kind,
          sent: sent().length,
        },
        'mutation-verdict:behavior:cli-emit-refuses-a-reserved-name',
      ).toEqual({ exit: exitCode('refused'), kind: 'reserved-name', sent: 0 })
      // A payload that is no JSON is refused before anything opens, too.
      const noJson = await runCli(
        ['emit', 'an-event', '--payload', '{not json', '--yes', ...writeFlags(db)],
        db.env,
        opener,
      )
      expect({ exit: noJson.exit, sent: sent().length }).toEqual({ exit: 2, sent: 0 })
    }))
})

describe('cancel on libSQL', () => {
  it('cancels a live task, reports a task cancelled already, and names a task that ended another way or is not there', () =>
    onDb('drive-cancel', async (db) => {
      const tasks = await seedTasks(db)
      const cancelled = await drive(db, ['cancel', tasks.pending, '--yes', ...writeFlags(db)])
      expect(cancelled).toMatchObject({
        exit: 0,
        answer: { outcome: 'cancelled', stateBefore: 'pending', taskId: tasks.pending },
      })
      const result = await drive(db, ['result', tasks.pending, '--queue', QUEUE])
      expect(result.answer.state).toBe('cancelled')
      // Again: the port answers false, and the task as it stands says why.
      const again = await changedBy(db, () =>
        drive(db, ['cancel', tasks.pending, '--yes', ...writeFlags(db)]),
      )
      expect({
        exit: again.out.exit,
        outcome: again.out.answer.outcome,
        unchanged: again.unchanged,
      }).toEqual({ exit: 0, outcome: 'already-cancelled', unchanged: true })
      const ended = await changedBy(db, () =>
        drive(db, ['cancel', tasks.completed, '--yes', ...writeFlags(db)]),
      )
      const absent = await drive(db, ['cancel', 'no-such-task', '--yes', ...writeFlags(db)])
      expect(
        {
          ended: [ended.out.exit, ended.out.answer.error?.cause, ended.out.answer.state],
          saysAsOfThisRead: ended.out.answer.error?.message?.includes('As of this read'),
          unchanged: ended.unchanged,
          absent: [absent.exit, absent.answer.error?.kind],
        },
        'mutation-verdict:behavior:cli-cancel-names-why-the-port-answered-false',
      ).toEqual({
        ended: [exitCode('refused'), 'already-terminal', 'completed'],
        saysAsOfThisRead: true,
        unchanged: true,
        absent: [exitCode('not-found'), 'not-found'],
      })
      // In text a refusal prints on stderr.
      const text = await runCli(['cancel', tasks.completed, '--yes', ...writeFlags(db)], db.env)
      expect({
        exit: text.exit,
        stdout: text.stdout,
        names: text.stderr.includes('cause: already-terminal'),
      }).toEqual({ exit: exitCode('refused'), stdout: '', names: true })
    }))

  it('refuses a task whose saga began without --halt-rollback, prints the rollback facts, and cancels it with the flag', () =>
    onDb('drive-cancel-saga', async (db) => {
      // A registered step started, and the task's failure placed a rollback pass.
      const { taskId, forward } = await rollingBack(db)
      const line = ['cancel', taskId, '--yes', ...writeFlags(db)]
      const refused = await changedBy(db, () => drive(db, line))
      expect(
        {
          exit: refused.out.exit,
          kind: refused.out.answer.error?.kind,
          namesTheFlag: refused.out.answer.error?.message?.includes('--halt-rollback'),
          sagaBegan: refused.out.answer.sagaBegan,
          rollback: refused.out.answer.rollback,
          unchanged: refused.unchanged,
        },
        'mutation-verdict:behavior:cli-cancel-halts-a-rollback-only-when-told',
      ).toEqual({
        exit: 2,
        kind: 'confirmation-required',
        namesTheFlag: true,
        sagaBegan: true,
        // The forward run that failed, and the rollback pass that follows it, for which the
        // engine raised the budget by one.
        rollback: {
          attempts: 1,
          maxAttempts: 2,
          runs: [
            { runId: forward.runId, attempt: 1, state: 'failed' },
            { runId: expect.any(String), attempt: 2, state: 'pending' },
          ],
        },
        unchanged: true,
      })
      // Without --yes it says both flags are needed, and changes nothing either.
      const asked = await changedBy(db, () => drive(db, ['cancel', taskId, ...writeFlags(db)]))
      expect([
        asked.out.exit,
        asked.out.answer.error?.message?.includes('--yes and --halt-rollback'),
        asked.unchanged,
      ]).toEqual([2, true, true])
      const halted = await drive(db, [...line, '--halt-rollback'])
      expect([halted.exit, halted.answer.outcome]).toEqual([0, 'cancelled'])
      // A task whose saga has not begun takes the flag and needs none.
      const plain = await db.store.spawn(QUEUE, 'plain', '{}')
      const withFlag = await drive(db, [
        'cancel',
        plain.taskId,
        '--yes',
        '--halt-rollback',
        ...writeFlags(db),
      ])
      expect([withFlag.exit, withFlag.answer.outcome]).toEqual([0, 'cancelled'])
    }))

  it('leaves a task uncancelled when its saga begins between the read and the write, and prints the rollback facts', () =>
    onDb('drive-cancel-saga-begins', async (db) => {
      const { taskId, forward, fail } = await sagaStepStarted(db)
      // The store as the command opens it, but for one thing: once the command has read the
      // task, and before it writes, the task's worker fails it, and the saga begins.
      let began = false
      const sagaBeginsAfterTheRead: StoreOpener = async (url, token, ids, options) => {
        const opened = await openStore(url, token, ids, options)
        return {
          ...opened,
          operator: {
            ...opened.operator,
            taskFacts: async (queue, id) => {
              const facts = await opened.operator.taskFacts(queue, id)
              if (!began) {
                began = true
                await fail()
              }
              return facts
            },
          },
        }
      }
      const run = await runCli(
        ['cancel', taskId, '--yes', ...writeFlags(db), '--json'],
        db.env,
        sagaBeginsAfterTheRead,
        testIdSource('saga-begins'),
      )
      const answer = JSON.parse(run.stdout) as JsonAnswer
      const after = await drive(db, ['inspect', taskId, '--queue', QUEUE])
      expect({
        began,
        exit: run.exit,
        kind: answer.error?.kind,
        namesTheFlag: answer.error?.message?.includes('--halt-rollback'),
        sagaBegan: answer.sagaBegan,
        rollback: answer.rollback,
        // The task is as its worker left it: rolling back, with the pass still to run.
        taskAfter: (after.answer.task as { state?: string } | undefined)?.state,
        runsAfter: (after.answer.runs as { attempt: number; state: string }[]).map((one) => [
          one.attempt,
          one.state,
        ]),
      }).toEqual({
        began: true,
        exit: 2,
        kind: 'confirmation-required',
        namesTheFlag: true,
        sagaBegan: true,
        rollback: {
          attempts: 1,
          maxAttempts: 2,
          runs: [
            { runId: forward.runId, attempt: 1, state: 'failed' },
            { runId: expect.any(String), attempt: 2, state: 'pending' },
          ],
        },
        taskAfter: 'pending',
        runsAfter: [
          [1, 'failed'],
          [2, 'pending'],
        ],
      })
      // The first task leaves the queue, so the next claim takes the second task's run.
      expect(await db.store.cancelTask(QUEUE, taskId)).toBe(true)
      // With the flag the same interleaving cancels the task: the operator said to halt it.
      const told = await sagaStepStarted(db)
      began = false
      const haltedAnyway: StoreOpener = async (url, token, ids, options) => {
        const opened = await openStore(url, token, ids, options)
        return {
          ...opened,
          operator: {
            ...opened.operator,
            taskFacts: async (queue, id) => {
              const facts = await opened.operator.taskFacts(queue, id)
              if (!began) {
                began = true
                await told.fail()
              }
              return facts
            },
          },
        }
      }
      const halted = await runCli(
        ['cancel', told.taskId, '--yes', '--halt-rollback', ...writeFlags(db), '--json'],
        db.env,
        haltedAnyway,
        testIdSource('saga-halted'),
      )
      expect([halted.exit, (JSON.parse(halted.stdout) as JsonAnswer).outcome]).toEqual([
        0,
        'cancelled',
      ])
    }))

  it('names a live task one of whose runs is in another queue, which the port refuses, fixture-built', () =>
    onDb('drive-cancel-elsewhere', async (db) => {
      const task = await db.store.spawn(QUEUE, 'job', '{}')
      // Fixture-built: no engine path gives a task a run in another queue.
      await fixture(db, "UPDATE runs SET queue = 'elsewhere' WHERE task_id = ?", [task.taskId])
      const refused = await changedBy(db, () =>
        drive(db, ['cancel', task.taskId, '--yes', ...writeFlags(db)]),
      )
      expect({
        exit: refused.out.exit,
        cause: refused.out.answer.error?.cause,
        runs: (refused.out.answer.runsInAnotherQueue as unknown[] | undefined)?.length,
        unchanged: refused.unchanged,
      }).toEqual({
        exit: exitCode('refused'),
        cause: 'run-in-another-queue',
        runs: 1,
        unchanged: true,
      })
    }))
})

describe('retry on libSQL', () => {
  it('revives a failed task, and a repeat reports the live run it finds', () =>
    onDb('drive-retry', async (db) => {
      const tasks = await seedTasks(db)
      const revived = await drive(db, ['retry', tasks.failed, '--yes', ...writeFlags(db)])
      expect(revived).toMatchObject({
        exit: 0,
        answer: { outcome: 'revived', attempt: 2, stateBefore: 'failed' },
      })
      const explained = await drive(db, ['explain', tasks.failed, '--queue', QUEUE])
      expect(explained.answer.cause).toBe('pending-due-unclaimed')
      const again = await changedBy(db, () =>
        drive(db, ['retry', tasks.failed, '--yes', ...writeFlags(db)]),
      )
      expect(
        {
          exit: again.out.exit,
          outcome: again.out.answer.outcome,
          runId: again.out.answer.runId,
          unchanged: again.unchanged,
        },
        'mutation-verdict:behavior:cli-retry-reports-the-live-run-a-repeat-finds',
      ).toEqual({
        exit: 0,
        outcome: 'already-live',
        runId: revived.answer.runId,
        unchanged: true,
      })
      const absent = await drive(db, ['retry', 'no-such-task', '--yes', ...writeFlags(db)])
      expect([absent.exit, absent.answer.error?.kind]).toEqual([exitCode('not-found'), 'not-found'])
    }))

  describe('a revival the guard refuses is named by the conjunct that is false, from a read after the refusal', () => {
    it('plants a state for every conjunct of the retry guard, and between them every cause the CLI names', () => {
      // The states are the conformance package's own, planted in the queue these tests use.
      expect(PLANTED_IN).toBe(QUEUE)
      expect(Object.keys(RETRY_REFUSALS)).toEqual([...RETRY_GUARD])
      expect(Object.keys(CAUSE_NAMED)).toEqual([...RETRY_GUARD])
      // Nine causes between the thirteen conjuncts. The tenth is a task that is not there,
      // which the case above holds: it has no conjunct to read.
      expect([...new Set(Object.values(CAUSE_NAMED))].sort()).toEqual([...RETRY_CAUSES].sort())
      expect(CAUSE_OF_CONJUNCT).toEqual(CAUSE_NAMED)
    })

    for (const name of RETRY_GUARD) {
      const planted = RETRY_REFUSALS[name]
      it(`${name}: ${planted.what}`, () =>
        onDb(`drive-retry-${name}`, async (db) => {
          const taskId = await planted.build(db)
          const refused = await changedBy(db, () =>
            drive(db, ['retry', taskId, '--yes', ...writeFlags(db)]),
          )
          expect(
            {
              conjunct: name,
              exit: refused.out.exit,
              kind: refused.out.answer.error?.kind,
              cause: refused.out.answer.error?.cause,
              conjunctsNotHeld: refused.out.answer.conjunctsNotHeld,
              saysAsOfThisRead: refused.out.answer.error?.message?.includes('As of this read'),
              unchanged: refused.unchanged,
            },
            'mutation-verdict:behavior:cli-retry-names-the-conjunct-that-refuses',
          ).toEqual({
            conjunct: name,
            exit: exitCode('refused'),
            kind: 'refused',
            // The first false conjunct, in the guard's order, gives the cause.
            cause: CAUSE_NAMED[planted.leavesFalse[0] ?? name],
            conjunctsNotHeld: planted.leavesFalse,
            saysAsOfThisRead: true,
            unchanged: true,
          })
          // In text the refusal prints on stderr, with its cause.
          const text = await runCli(['retry', taskId, '--yes', ...writeFlags(db)], db.env)
          expect({
            exit: text.exit,
            stdout: text.stdout,
            names: text.stderr.includes(`cause: ${CAUSE_NAMED[planted.leavesFalse[0] ?? name]}`),
          }).toEqual({ exit: exitCode('refused'), stdout: '', names: true })
        }))
    }
  })
})

describe('sweep on libSQL', () => {
  it("cancels what is past its deadline and takes back the runs whose lease lapsed, up to its limit, and prints the queue's next wake", () =>
    onDb('drive-sweep', async (db) => {
      // A launch that is lost, a started run whose worker is gone, and a task past the
      // deadline it had to start by.
      const { lost, left, doomed } = await owedToASweep(db)
      // One transition at a time: the sweep says it filled its limit.
      const one = await drive(db, ['sweep', '--limit', '1', ...writeFlags(db)])
      expect(one).toMatchObject({
        exit: 0,
        answer: {
          limit: 1,
          swept: 1,
          atLimit: true,
          transitions: [{ kind: 'cancelled', taskId: doomed.taskId, runId: doomed.runId }],
        },
      })
      const rest = await drive(db, ['sweep', ...writeFlags(db)])
      expect({
        exit: rest.exit,
        limit: rest.answer.limit,
        atLimit: rest.answer.atLimit,
        transitions: (rest.answer.transitions as { kind: string; taskId: string; runId: string }[])
          .map((one) => [one.kind, one.taskId, one.runId])
          .sort(),
        nextWake: rest.answer.nextWakeAtEpochMs,
      }).toEqual({
        exit: 0,
        limit: SWEEP_DEFAULT_LIMIT,
        atLimit: false,
        transitions: [
          ['claim-timeout', left.taskId, left.runId],
          ['lost-launch', lost.taskId, lost.runId],
        ].sort(),
        nextWake: await db.store.nextWakeAtEpochMs(QUEUE),
      })
      // Nothing is left for a sweep: it makes no transition, and says so.
      const none = await changedBy(db, () => drive(db, ['sweep', ...writeFlags(db)]))
      expect([none.out.answer.swept, none.out.answer.transitions, none.unchanged]).toEqual([
        0,
        [],
        true,
      ])
      // In text the answer prints on stdout.
      const text = await runCli(['sweep', ...writeFlags(db)], db.env)
      expect({
        exit: text.exit,
        stderr: text.stderr,
        swept: text.stdout.includes('swept: 0'),
      }).toEqual({
        exit: 0,
        stderr: '',
        swept: true,
      })
    }))

  it('refuses a limit it cannot read with exit 2, and sends nothing', () =>
    onDb('drive-sweep-limit', async (db) => {
      for (const limit of ['0', '1001', 'ten', '-1']) {
        const { opener, sent } = recordingOpener()
        const run = await runCli(
          ['sweep', `--limit=${limit}`, ...writeFlags(db), '--json'],
          db.env,
          opener,
        )
        expect({ limit, exit: run.exit, sent: sent().length }).toEqual({ limit, exit: 2, sent: 0 })
      }
    }))
})
