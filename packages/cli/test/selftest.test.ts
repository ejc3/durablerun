import {
  PermanentStoreError,
  QUEUE_TABLES,
  type SqlExecutor,
  type SqlResult,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { COMMANDS, NOT_SENT_BY_SELFTEST } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import { type OpenedStore, type StoreOpener, openStore } from '../src/open-store.js'
import { SELFTEST_TASK } from '../src/selftest.js'
import {
  type CliDb,
  type JsonAnswer,
  OWN_QUEUE,
  QUEUE,
  SELECTED,
  STORE_COMMANDS,
  changedBy,
  faulting,
  onDb,
  openCliDb,
  openerWrapping,
  recordingOpener,
  rowsByQueue,
  runCli,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * Exit test line 44's `selftest`: it sends every batch a command of this CLI sends, to a
 * queue of its own, and says what each call answered. The cases hold what it sends to the
 * command table, what it leaves to the database, each refusal to having written nothing,
 * and each check of an answer to a store that answers otherwise.
 */

const line = (db: Pick<CliDb, 'target'>, queue = OWN_QUEUE): string[] => [
  'selftest',
  '--queue',
  queue,
  '--target',
  db.target,
  '--json',
]

interface Step {
  readonly call: string
  readonly labels: readonly string[]
  readonly result: string
  readonly found?: string
  readonly failedAt?: string
}

type Report = JsonAnswer & {
  readonly passed?: boolean
  readonly steps?: readonly Step[]
  readonly labels?: Readonly<Record<string, string>>
  readonly notSent?: Readonly<Record<string, string>>
}

const report = (stdout: string): Report => JSON.parse(stdout) as Report

/** Every batch label selftest declares. */
const DECLARED = COMMANDS.selftest.ports.flatMap((port) => port.labels)

/** Another queue of the same database, which holds nothing. */
const ELSEWHERE = 'a-queue-nobody-wrote-to'

/**
 * A store whose one call answers of another queue, which holds nothing, where selftest
 * asked of its own: a write lands there, and a read answers what an empty queue answers.
 * The clock is of no queue, so it answers no instant at all.
 */
const answeringOfAnotherQueue =
  (call: string): StoreOpener =>
  async (url, token, ids, options) => {
    const store = await openStore(url, token, ids, options)
    if (call === 'admin.nowEpochMs') {
      return { ...store, admin: { ...store.admin, nowEpochMs: async () => Number.NaN } }
    }
    const [port, method] = call.split('.') as ['scheduler' | 'operator' | 'retention', string]
    const real = store[port] as unknown as Record<
      string,
      (queue: string, ...rest: unknown[]) => unknown
    >
    const moved = (_queue: string, ...rest: unknown[]) => real[method]?.(ELSEWHERE, ...rest)
    return { ...store, [port]: { ...real, [method]: moved } } as OpenedStore
  }

/**
 * The calls whose answer of the queue selftest wrote is the answer of an empty queue: what
 * would tell the two apart is a run a worker claimed, or a unit a window old, and selftest
 * makes neither. Of these it shows that the database takes the batch and answers nothing.
 */
const ANSWERS_AS_AN_EMPTY_QUEUE: readonly string[] = [
  'scheduler.getCheckpoints',
  'operator.eventWaiters',
  'scheduler.retryTask',
  'retention.purgeCandidates',
  'retention.purgeUnit',
]

/**
 * The two reads whose answer shows at the step of another call, because that step reads
 * the state its write left through them. Every other call shows at a step of its own.
 */
const SHOWS_AT: Readonly<Record<string, string>> = {
  'operator.taskIdByKey': 'scheduler.spawn',
  'operator.eventState': 'scheduler.emitEvent',
}

describe('what selftest sends', () => {
  it('declares every batch label a store command declares, or names it with the reason it is not sent', () => {
    const named = Object.keys(NOT_SENT_BY_SELFTEST)
    const others = STORE_COMMANDS.filter((spec) => spec.verb !== 'selftest')
    for (const spec of others) {
      for (const label of spec.ports.flatMap((port) => port.labels)) {
        expect(
          { verb: spec.verb, label, held: DECLARED.includes(label) || named.includes(label) },
          'mutation-verdict:behavior:cli-selftest-declares-or-names-every-label',
        ).toEqual({ verb: spec.verb, label, held: true })
      }
    }
    // A label is sent or it is not, and one it names as not sent is a label of another command.
    const elsewhere = others.flatMap((spec) => spec.ports.flatMap((port) => port.labels))
    for (const label of named) {
      expect({
        label,
        declared: DECLARED.includes(label),
        ofACommand: elsewhere.includes(label),
      }).toEqual({ label, declared: false, ofACommand: true })
    }
    for (const reason of Object.values(NOT_SENT_BY_SELFTEST)) expect(reason).not.toBe('')
    expect(COMMANDS.selftest.repeat).toBe('fresh-queue')
  })

  for (const dialect of SELECTED) {
    it(`[${dialect}] passes by the database's own clock: a step for every call it declares, every label ok, and the rest of the database as it was`, async () => {
      const db = await openCliDb(dialect, 'selftest-passes')
      try {
        await seedTasks(db)
        await db.admin.setFakeNowEpochMs(null)
        const before = await db.dump()
        const run = await runCli(line(db), db.env)
        expect(run.exit, run.stdout).toBe(0)
        const answer = report(run.stdout)
        expect(answer).toMatchObject({
          queue: OWN_QUEUE,
          taskName: SELFTEST_TASK,
          passed: true,
          notSent: NOT_SENT_BY_SELFTEST,
        })
        const steps = answer.steps ?? []
        expect(steps.filter((step) => step.result !== 'ok')).toEqual([])
        expect([...new Set(steps.map((step) => step.call))].sort()).toEqual(
          COMMANDS.selftest.ports.map((port) => port.call).sort(),
        )
        expect(answer.labels).toEqual(Object.fromEntries(DECLARED.map((label) => [label, 'ok'])))
        // What it leaves: two tasks, their runs and three events in its own queue, so it
        // deleted none of them, and every other row as it was. PostgreSQL holds one row more
        // there, the lock an emit takes on its event's name.
        const after = rowsByQueue(await db.dump(), OWN_QUEUE)
        expect(after.elsewhere).toEqual(rowsByQueue(before, OWN_QUEUE).elsewhere)
        const tables = after.ofTheQueue.map((row) => row.slice(0, row.indexOf(' ')))
        expect(
          tables.filter((table) => (QUEUE_TABLES as readonly string[]).includes(table)),
        ).toEqual(['events', 'events', 'events', 'runs', 'runs', 'tasks', 'tasks'])
      } finally {
        await db.close()
      }
    }, 120_000)
  }

  it('prints the same report as text, on stdout', () =>
    onDb('selftest-text', async (db) => {
      const run = await runCli(
        line(db).filter((word) => word !== '--json'),
        db.env,
      )
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({ exit: 0, stderr: '' })
      expect(run.stdout).toContain('passed: true')
      for (const label of DECLARED) expect(run.stdout).toContain(`${label}: ok`)
      for (const label of Object.keys(NOT_SENT_BY_SELFTEST)) expect(run.stdout).toContain(label)
    }))
})

describe('what selftest refuses, having written nothing', () => {
  it('refuses a queue that holds a row with exit 2, prints the counts, and sends only reads', () =>
    onDb('selftest-not-empty', async (db) => {
      await seedTasks(db)
      const recording = recordingOpener()
      const { out: run, unchanged } = await changedBy(db, () =>
        runCli(['selftest', ...writeFlags(db), '--json'], db.env, recording.opener),
      )
      const answer = report(run.stdout)
      expect(
        { exit: run.exit, kind: answer.error?.kind, unchanged },
        'mutation-verdict:behavior:cli-selftest-refuses-a-queue-that-holds-rows',
      ).toEqual({ exit: exitCode('usage'), kind: 'queue-not-empty', unchanged: true })
      expect(recording.sent().map((batch) => batch.mode)).toEqual(['read', 'read'])
      expect(answer).toMatchObject({ queue: QUEUE, tables: { tasks: { count: 4 } } })
    }))

  it("refuses a database below the build's schema version with exit 5, at a version its reads accept, and changes nothing", async () => {
    const db = await openCliDb('libsql', 'selftest-older', 5)
    try {
      const { out: run, unchanged } = await changedBy(db, () => runCli(line(db), db.env))
      const answer = report(run.stdout)
      expect(
        { exit: run.exit, recorded: answer.recordedSchemaVersion, unchanged },
        'mutation-verdict:behavior:cli-selftest-refuses-a-schema-that-is-not-the-builds',
      ).toEqual({ exit: exitCode('schema'), recorded: 5, unchanged: true })
      expect(answer.error?.message).toContain('migrate the branch or the snapshot first')
    } finally {
      await db.close()
    }
  })
})

/** A store that refuses every batch under one label and takes every other. */
const refusing =
  (refused: string) =>
  (real: SqlExecutor): SqlExecutor => ({
    batch: (label, statements, control) =>
      label === refused
        ? Promise.reject(new PermanentStoreError(`the store refuses '${label}'`))
        : real.batch(label, statements, control),
  })

describe('what selftest says of a store that refuses one batch', () => {
  it('prints each label by what was sent, for every label it sends: the label the store refused as failed, the labels answered before it as ok, and the rest as not-run', async () => {
    // The order of a run nothing fails: where each label is first sent.
    const firstSent = new Map<string, number>()
    await onDb('selftest-label-order', async (db) => {
      const recording = recordingOpener()
      expect((await runCli(line(db), db.env, recording.opener)).exit).toBe(0)
      for (const [index, batch] of recording.sent().entries()) {
        if (!firstSent.has(batch.label)) firstSent.set(batch.label, index)
      }
    })
    const labels = [...new Set(DECLARED)]
    expect(labels.filter((label) => !firstSent.has(label))).toEqual([])
    // Every label is tried, and what each run printed otherwise is listed whole.
    const differed: unknown[] = []
    for (const refused of labels) {
      await onDb(`selftest-refuses-${refused}`, async (db) => {
        const run = await runCli(line(db), db.env, openerWrapping(refusing(refused)))
        const answer = report(run.stdout)
        const at = firstSent.get(refused) ?? -1
        const expected = Object.fromEntries(
          labels.map((label) => {
            const first = firstSent.get(label) ?? -1
            return [label, label === refused ? 'failed' : first < at ? 'ok' : 'not-run']
          }),
        )
        const printed = answer.labels ?? {}
        // The step that was running names the label that failed, which need not be its own.
        const failedAt = (answer.steps ?? [])
          .filter((step) => step.result === 'failed')
          .map((step) => step.failedAt)
        const wrong = labels.filter((label) => printed[label] !== expected[label])
        if (
          wrong.length > 0 ||
          run.exit !== exitCode('permanent') ||
          failedAt.length !== 1 ||
          failedAt[0] !== refused
        ) {
          differed.push({
            refused,
            exit: run.exit,
            failedAt,
            wrong: Object.fromEntries(wrong.map((label) => [label, printed[label] ?? null])),
          })
        }
      })
    }
    expect(
      differed,
      'mutation-verdict:behavior:cli-selftest-prints-a-label-by-what-was-sent',
    ).toEqual([])
  }, 300_000)
})

/** A text no row of the engine holds, planted in an answer. */
const BOGUS = 'bogus-7f3a'

/**
 * The ways an answer is bent into one the store's decoders, or the checks of a batch's
 * shape, may refuse: every text of every row replaced, every value null, no row at all,
 * and one result too few.
 */
const BENT: Readonly<Record<string, (results: SqlResult[]) => SqlResult[]>> = {
  'every text replaced': (results) =>
    results.map((result) => ({
      ...result,
      rows: result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            typeof value === 'string' ? BOGUS : value,
          ]),
        ),
      ),
    })),
  'every value null': (results) =>
    results.map((result) => ({
      ...result,
      rows: result.rows.map((row) =>
        Object.fromEntries(Object.keys(row).map((column) => [column, null])),
      ),
    })),
  'no row': (results) => results.map(() => ({ rows: [], rowsAffected: 0 })),
  'one result too few': (results) => results.slice(0, -1),
}

/** A store that takes every batch and bends the answer to one label. */
const answering =
  (label: string, bend: (results: SqlResult[]) => SqlResult[]) =>
  (real: SqlExecutor): SqlExecutor => ({
    batch: async (sent, statements, control) => {
      const results = await real.batch(sent, statements, control)
      return sent === label ? bend(results) : results
    },
  })

describe('what selftest says of a database whose answer cannot be read', () => {
  it('exits 11 and never 1 when the database answers a row the decoders refuse: the step is unexpected, the label is the one that was answered, and the row prints only with --reveal', () =>
    onDb('selftest-refused-row', async (db) => {
      // A task's outcome answered with a state that is not the engine's own.
      const everyTextReplaced = BENT['every text replaced']
      if (everyTextReplaced === undefined) throw new Error('no such bend')
      const opener = openerWrapping(answering('task-result', everyTextReplaced))
      const run = await runCli(line(db), db.env, opener)
      const answer = report(run.stdout)
      const at = (answer.steps ?? []).find((step) => step.result !== 'ok')
      expect(
        {
          exit: run.exit,
          result: at?.result,
          label: answer.labels?.['task-result'],
          failed: Object.values(answer.labels ?? {}).filter((result) => result === 'failed'),
          saysTheLabel: at?.found?.includes('task-result'),
          printsTheRow: `${run.stdout}${run.stderr}`.includes(BOGUS),
        },
        'mutation-verdict:behavior:cli-selftest-reads-a-refused-row-as-an-answer',
      ).toEqual({
        exit: exitCode('failed'),
        result: 'unexpected',
        label: 'unexpected',
        failed: [],
        saysTheLabel: true,
        printsTheRow: false,
      })
      // With --reveal the decoder's own words print, and they quote the row.
      const revealed = await runCli(
        [...line(db, `${OWN_QUEUE}-revealed`), '--reveal'],
        db.env,
        opener,
        testIdSource('selftest-revealed'),
      )
      expect({ exit: revealed.exit, printsTheRow: revealed.stdout.includes(BOGUS) }).toEqual({
        exit: exitCode('failed'),
        printsTheRow: true,
      })
    }))

  it('exits as a defect of the CLI for no answer of the database: every label it sends, bent four ways, ends the run as passed, as refused, or as answered otherwise', async () => {
    const labels = [...new Set(DECLARED)]
    const exits = new Map<number, number>()
    const internal: string[] = []
    const printedOk: string[] = []
    for (const label of labels) {
      for (const [how, bend] of Object.entries(BENT)) {
        await onDb(`selftest-bent-${label}-${how}`, async (db) => {
          const run = await runCli(line(db), db.env, openerWrapping(answering(label, bend)))
          exits.set(run.exit, (exits.get(run.exit) ?? 0) + 1)
          // A run that the bent answer ended never prints the bent label as ok, and what it
          // says was refused never names another label alone: a step that was answered under
          // two labels read them together.
          if (run.exit === exitCode('failed')) {
            const answer = report(run.stdout)
            const found = (answer.steps ?? []).find((step) => step.result === 'unexpected')?.found
            const namesAnother =
              found?.startsWith('the answer to ') === true &&
              !found.startsWith(`the answer to ${label} `)
            if (answer.labels?.[label] !== 'unexpected' || namesAnother) {
              printedOk.push(`${label}, ${how}: ${answer.labels?.[label]}, ${found}`)
            }
          }
          // A bent read of the schema version is a schema the build does not read, exit 5,
          // and bent counts of the queue's rows can read as a queue that holds rows, exit 2.
          if (![0, exitCode('usage'), exitCode('schema'), exitCode('failed')].includes(run.exit)) {
            internal.push(`${label}, ${how}: exit ${run.exit}`)
          }
        })
      }
    }
    expect(
      internal,
      'mutation-verdict:behavior:cli-selftest-reads-a-refused-row-as-an-answer',
    ).toEqual([])
    expect(
      printedOk,
      'mutation-verdict:behavior:cli-selftest-marks-every-label-a-step-was-answered-under',
    ).toEqual([])
    // Most bent answers are seen: the run that passes all the same is the exception.
    expect(exits.get(exitCode('failed')) ?? 0).toBeGreaterThan(labels.length * 2)
    expect(exits.get(exitCode('internal'))).toBeUndefined()
  }, 600_000)
})

describe('what selftest says of a store that answers otherwise', () => {
  it('exits 11 at the step that checks a call when that call answers of another queue, says what it answered, and runs no step after it, for every call it checks', async () => {
    const calls = COMMANDS.selftest.ports
      .map((port) => port.call)
      .filter((call) => call !== 'admin.schemaVersion')
    expect(calls.length).toBeGreaterThan(ANSWERS_AS_AN_EMPTY_QUEUE.length + 10)
    const passedWith: string[] = []
    for (const call of calls) {
      await onDb(`selftest-otherwise-${call}`, async (db) => {
        const run = await runCli(line(db), db.env, answeringOfAnotherQueue(call))
        const answer = report(run.stdout)
        if (run.exit === 0) {
          passedWith.push(call)
          return
        }
        const steps = answer.steps ?? []
        const at = steps.findIndex((step) => step.result !== 'ok')
        expect(
          {
            call,
            at: steps[at]?.call,
            exit: run.exit,
            passed: answer.passed,
            stopped: steps[at]?.result,
            says: typeof steps[at]?.found === 'string' && steps[at]?.found !== '',
            after: [...new Set(steps.slice(at + 1).map((step) => step.result))],
            labelsOfTheStep: (steps[at]?.labels ?? []).map((label) => answer.labels?.[label]),
          },
          'mutation-verdict:behavior:cli-selftest-checks-what-each-call-answered',
        ).toEqual({
          call,
          at: SHOWS_AT[call] ?? call,
          exit: exitCode('failed'),
          passed: false,
          stopped: 'unexpected',
          says: true,
          after: at === steps.length - 1 ? [] : ['not-run'],
          labelsOfTheStep: (steps[at]?.labels ?? []).map(() => 'unexpected'),
        })
      })
    }
    expect(
      passedWith,
      'mutation-verdict:behavior:cli-selftest-checks-what-each-call-answered',
    ).toEqual(ANSWERS_AS_AN_EMPTY_QUEUE)
  }, 120_000)

  it('prints the report on stdout with the calls it reached when the store fails a call, and exits as the failure does', () =>
    onDb('selftest-failed-call', async (db) => {
      const [label] =
        COMMANDS.selftest.ports.find((port) => port.call === 'scheduler.emitEvent')?.labels ?? []
      if (label === undefined) throw new Error('selftest declares no emit')
      const run = await runCli(
        line(db),
        db.env,
        openerWrapping((real) => faulting(real, { label, occurrence: 1 }, 'crash-before')),
      )
      const answer = report(run.stdout)
      const steps = answer.steps ?? []
      const at = steps.findIndex((step) => step.call === 'scheduler.emitEvent')
      expect({
        exit: run.exit,
        passed: answer.passed,
        kind: answer.error?.kind,
        before: [...new Set(steps.slice(0, at).map((step) => step.result))],
        at: steps[at]?.result,
        after: [...new Set(steps.slice(at + 1).map((step) => step.result))],
        label: answer.labels?.[label],
      }).toEqual({
        exit: exitCode('unavailable'),
        passed: false,
        kind: 'store-unavailable',
        before: ['ok'],
        at: 'failed',
        after: ['not-run'],
        label: 'failed',
      })
      const text = await runCli(
        line(db, `${OWN_QUEUE}-text`).filter((word) => word !== '--json'),
        db.env,
        openerWrapping((real) => faulting(real, { label, occurrence: 1 }, 'crash-before')),
        // Another process, whose ids are its own.
        testIdSource('selftest-text'),
      )
      expect(text.exit).toBe(exitCode('unavailable'))
      expect(text.stdout).toContain('passed: false')
      expect(text.stdout).toContain(`${label}: failed`)
    }))
})
