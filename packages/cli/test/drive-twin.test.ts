import { isDeepStrictEqual } from 'node:util'
import {
  type IdSource,
  SAGA_STARTED_PREFIX,
  type SchedulerStore,
  type SqlExecutor,
} from '@durablerun/core'
import { testIdSource } from '@durablerun/core/testing'
import {
  CURRENT_SCHEMA_VERSION,
  LibsqlSchedulerStore,
  READABLE_SCHEMA_WINDOW,
  SCHEMA_VERSION_NOTES,
  operatorReads,
} from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import type { StoreFixture } from '../../conformance/src/fixture.js'
import { runFuzzScenario } from '../../conformance/src/fuzz.js'
import { makeLibsqlFixture } from '../../conformance/test/fixture-libsql.js'
import { COMMANDS, SWEEP_DEFAULT_LIMIT, VERBS } from '../src/commands.js'
import { type ExitName, exitCode } from '../src/exit.js'
import { type StoreOpener, storeTarget } from '../src/open-store.js'
import { parkedOnAnEvent } from './explain-seeds.js'
import {
  COMPLETED_KEY,
  type CliDb,
  NOW_MS,
  QUEUE,
  SELECTED,
  type SeededTasks,
  type StartingSchema,
  claimActivated,
  dumpOf,
  openCliDb,
  runCli,
  seedTasks,
} from './support.js'

/**
 * Exit test line 38: a drive verb is its port call and nothing else. A command runs through
 * `main` against one database, and the port call it is runs against a twin: a second
 * database built the same way, by the same calls, with the same seeded ids. Both are handed
 * an id source of one seed, so a row either writes is the same row. After each, a dump of
 * every table of the one equals the dump of the other, and the command's answer is the
 * port's. A command that wrote a row its port call does not write, called the port with
 * another argument, or minted an id the port does not mint, leaves another dump.
 *
 * The twins are compared on every selected dialect at the build's schema version, on libSQL
 * at every version of the window its store's reads accept, the release alpha.1's version 5
 * among them, and on libSQL over the states a walk of the engine leaves.
 */

type Answer = Readonly<Record<string, unknown>> & {
  readonly error?: { readonly kind?: string; readonly message?: string }
}

/** A command line, without the flags every write takes, and the port call it is. */
interface Call {
  readonly line: readonly string[]
  port(store: SchedulerStore): Promise<unknown>
}

/** The commands, each as the port call the command table says it makes. */
const CALLS = {
  enqueue: (taskName: string, key: string, params?: string): Call => ({
    line: [
      'enqueue',
      taskName,
      '--key',
      key,
      ...(params === undefined ? [] : ['--params', params]),
    ],
    port: (store) => store.spawn(QUEUE, taskName, params ?? 'null', { idempotencyKey: key }),
  }),
  emit: (eventName: string, payload?: string): Call => ({
    line: ['emit', eventName, ...(payload === undefined ? [] : ['--payload', payload]), '--yes'],
    port: (store) => store.emitEvent(QUEUE, eventName, payload ?? 'null'),
  }),
  // --halt-rollback is what a task whose saga began needs, and a task with none takes it.
  cancel: (taskId: string): Call => ({
    line: ['cancel', taskId, '--yes', '--halt-rollback'],
    port: (store) => store.cancelTask(QUEUE, taskId),
  }),
  retry: (taskId: string): Call => ({
    line: ['retry', taskId, '--yes'],
    port: (store) => store.retryTask(QUEUE, taskId),
  }),
  sweep: (limit?: number): Call => ({
    line: ['sweep', ...(limit === undefined ? [] : ['--limit', String(limit)])],
    port: (store) => store.sweep(QUEUE, limit ?? SWEEP_DEFAULT_LIMIT),
  }),
} as const
type WriteVerb = keyof typeof CALLS
const WRITE_VERBS = Object.keys(CALLS) as WriteVerb[]

/**
 * What a command's answer says of the write, beside what the port call answered on the
 * twin, as a pair that must be equal. `emit` answers from reads of its own, which the dump
 * and the cases of the verb hold, so its pair is empty.
 */
const SAID: Readonly<Record<WriteVerb, (answer: Answer, ported: unknown) => [unknown, unknown]>> = {
  enqueue: (answer, ported) => {
    const spawned = ported as { taskId: string; runId: string; created: boolean }
    return [
      { taskId: answer.taskId, runId: answer.runId, created: answer.created },
      { taskId: spawned.taskId, runId: spawned.runId, created: spawned.created },
    ]
  },
  emit: () => [null, null],
  cancel: (answer, ported) => [answer.outcome === 'cancelled', ported],
  retry: (answer, ported) => {
    const revived = ported as { runId: string; attempt: number } | null
    return [
      answer.outcome === 'revived' ? { runId: answer.runId, attempt: answer.attempt } : null,
      revived === null ? null : { runId: revived.runId, attempt: revived.attempt },
    ]
  },
  sweep: (answer, ported) => [answer.transitions, ported],
}

interface Step {
  readonly name: string
  call(seeded: SeededTasks, prepared: string): Call
  /** Whether the call changes the database, so a comparison of two untouched dumps fails. */
  readonly changes: boolean
  readonly exit: ExitName
}

interface Twin {
  /** What is written after the seeded tasks, on both databases, and the id the steps take. */
  prepare?(db: CliDb): Promise<string>
  /** The commands, run in this order against the one pair of databases. */
  readonly steps: readonly Step[]
}

/** A task whose saga began and that is rolling back, which only --halt-rollback cancels. */
async function rollingBack(db: CliDb): Promise<string> {
  const task = await db.store.spawn(QUEUE, 'saga', '{}', { maxAttempts: 1 })
  const forward = await claimActivated(db, 'w-forward', task.taskId)
  await db.store.setCheckpoint(
    QUEUE,
    task.taskId,
    forward.runId,
    forward.claimToken,
    `${SAGA_STARTED_PREFIX}charge`,
    '1',
    60,
  )
  await db.store.fail(QUEUE, forward.runId, forward.claimToken, '{"name":"E"}', null)
  return task.taskId
}

/** A deadline passed, a launch lost and a lease lapsed: one of each transition a sweep makes. */
async function owedToASweep(db: CliDb): Promise<string> {
  const lost = await db.store.spawn(QUEUE, 'lost', '{}')
  await db.store.claim(QUEUE, 'w-lost', { leaseSeconds: 60, limit: 1 })
  const left = await db.store.spawn(QUEUE, 'left', '{}')
  await claimActivated(db, 'w-gone', left.taskId)
  await db.store.spawn(QUEUE, 'doomed', '{}', { cancellation: { maxDelaySeconds: 45 } })
  await db.admin.setFakeNowEpochMs(NOW_MS + 61_000)
  return lost.taskId
}

/** Each drive verb's commands over the seeded tasks, keyed by the verbs the calls above hold. */
const TWINS: Readonly<Record<WriteVerb, Twin>> = {
  enqueue: {
    steps: [
      {
        name: 'under a key no task has, with parameters',
        call: () => CALLS.enqueue('report', 'order-7', '{"n":1}'),
        changes: true,
        exit: 'done',
      },
      {
        name: 'under that key again',
        call: () => CALLS.enqueue('report', 'order-7', '{"n":2}'),
        changes: false,
        exit: 'done',
      },
      {
        name: 'under the key of a completed task',
        call: () => CALLS.enqueue('report', COMPLETED_KEY),
        changes: false,
        exit: 'done',
      },
      {
        name: 'under another key, with no parameters',
        call: () => CALLS.enqueue('another', 'order-8'),
        changes: true,
        exit: 'done',
      },
    ],
  },
  emit: {
    prepare: (db) => parkedOnAnEvent(db, null, {}, 'go-ahead'),
    steps: [
      {
        name: 'of an event a run awaits',
        call: () => CALLS.emit('go-ahead', '{"ok":true}'),
        changes: true,
        exit: 'done',
      },
      // A later emit changes no payload, and it is still a write: the engine stamps the
      // event's row with the batch that last wrote it.
      {
        name: 'of that event again, with another payload',
        call: () => CALLS.emit('go-ahead', '{"ok":false}'),
        changes: true,
        exit: 'done',
      },
      {
        name: 'of an event the seed emitted',
        call: () => CALLS.emit('page-ready'),
        changes: true,
        exit: 'done',
      },
      {
        name: 'of an event nothing awaits, with no payload',
        call: () => CALLS.emit('unheard'),
        changes: true,
        exit: 'done',
      },
    ],
  },
  cancel: {
    prepare: rollingBack,
    steps: [
      {
        name: 'of a task that is pending',
        call: (seeded) => CALLS.cancel(seeded.pending),
        changes: true,
        exit: 'done',
      },
      {
        name: 'of that task again',
        call: (seeded) => CALLS.cancel(seeded.pending),
        changes: false,
        exit: 'done',
      },
      {
        name: 'of a task that completed',
        call: (seeded) => CALLS.cancel(seeded.completed),
        changes: false,
        exit: 'refused',
      },
      {
        name: 'of a task that is not there',
        call: () => CALLS.cancel('no-such-task'),
        changes: false,
        exit: 'not-found',
      },
      {
        name: 'of a task that is rolling back',
        call: (_seeded, saga) => CALLS.cancel(saga),
        changes: true,
        exit: 'done',
      },
    ],
  },
  retry: {
    steps: [
      {
        name: 'of a task that failed',
        call: (seeded) => CALLS.retry(seeded.failed),
        changes: true,
        exit: 'done',
      },
      {
        name: 'of that task again',
        call: (seeded) => CALLS.retry(seeded.failed),
        changes: false,
        exit: 'done',
      },
      {
        name: 'of a task that completed',
        call: (seeded) => CALLS.retry(seeded.completed),
        changes: false,
        exit: 'refused',
      },
      {
        name: 'of a task that was cancelled',
        call: (seeded) => CALLS.retry(seeded.cancelled),
        changes: false,
        exit: 'refused',
      },
      {
        name: 'of a task that is not there',
        call: () => CALLS.retry('no-such-task'),
        changes: false,
        exit: 'not-found',
      },
    ],
  },
  sweep: {
    prepare: owedToASweep,
    steps: [
      { name: 'of one transition', call: () => CALLS.sweep(1), changes: true, exit: 'done' },
      { name: 'of the rest', call: () => CALLS.sweep(), changes: true, exit: 'done' },
      {
        name: 'of a queue with nothing owed',
        call: () => CALLS.sweep(),
        changes: false,
        exit: 'done',
      },
    ],
  },
}

/** Two databases of one dialect at one version, built by the same calls with the same ids. */
async function onTwins<T>(
  dialect: (typeof SELECTED)[number],
  name: string,
  schema: StartingSchema,
  body: (subject: CliDb, twin: CliDb) => Promise<T>,
): Promise<T> {
  const subject = await openCliDb(dialect, name, schema)
  try {
    const twin = await openCliDb(dialect, name, schema)
    try {
      return await body(subject, twin)
    } finally {
      await twin.close()
    }
  } finally {
    await subject.close()
  }
}

/**
 * Run every step of a verb against a pair of databases, and hold the two equal after each.
 * `marker` is the verdict marker of the case that asks, which names it in its own body.
 */
async function compared(
  dialect: (typeof SELECTED)[number],
  verb: WriteVerb,
  schema: StartingSchema,
  marker: string,
): Promise<number> {
  const { prepare, steps } = TWINS[verb]
  return onTwins(dialect, `twin-${verb}`, schema, async (subject, twin) => {
    const built = async (db: CliDb) => ({
      seeded: await seedTasks(db),
      prepared: (await prepare?.(db)) ?? '',
    })
    const on = { subject: await built(subject), twin: await built(twin) }
    // The twin is a twin: the two were built into one state, with the same ids.
    expect(on.subject).toEqual(on.twin)
    let before = await subject.dump()
    expect(await twin.dump(), 'the two databases start equal').toBe(before)
    for (const [index, step] of steps.entries()) {
      const where = `${dialect} at ${schema}: ${verb} ${step.name}`
      const call = step.call(on.subject.seeded, on.subject.prepared)
      // One seed to each side: an id the command mints is the id the port call mints.
      const seed = `drive-${index}`
      const run = await runCli(
        [...call.line, '--queue', QUEUE, '--target', subject.target, '--json'],
        subject.env,
        undefined,
        testIdSource(seed),
      )
      const ported = await call.port(twin.storeWith(testIdSource(seed)))
      const after = await subject.dump()
      expect({ where, same: after === (await twin.dump()) }, marker).toEqual({ where, same: true })
      const [said, did] = SAID[verb](JSON.parse(run.stdout) as Answer, ported)
      expect({ where, said }, marker).toEqual({ where, said: did })
      expect({ where, exit: run.exit, changed: after !== before }).toEqual({
        where,
        exit: exitCode(step.exit),
        changed: step.changes,
      })
      before = after
    }
    return steps.length
  })
}

describe('a drive verb is its port call and nothing else', () => {
  it('holds a twin for every command of the table that writes rows through a store', () => {
    // A command that joins the table as a write joins the calls above, or this fails.
    expect(
      VERBS.filter(
        (verb) => COMMANDS[verb].opensStore && COMMANDS[verb].writes && verb !== 'migrate',
      ),
    ).toEqual(WRITE_VERBS)
    for (const verb of WRITE_VERBS) {
      const { steps } = TWINS[verb]
      // Each verb has a step that changes the database and one that does not, so neither
      // an equal pair of untouched dumps nor a write that always lands passes alone. Every
      // emit is a write, so `emit` has no step of the second kind.
      expect([
        verb,
        steps.some((step) => step.changes),
        steps.some((step) => !step.changes),
      ]).toEqual([verb, true, verb !== 'emit'])
    }
  })

  for (const dialect of SELECTED) {
    describe(`[${dialect}]`, () => {
      it("every drive verb leaves the dump its port call leaves on a twin, at the build's schema version", async () => {
        for (const verb of WRITE_VERBS) {
          const steps = await compared(
            dialect,
            verb,
            'current',
            'mutation-verdict:behavior:cli-a-drive-verb-is-its-port-call',
          )
          expect([verb, steps]).toEqual([verb, TWINS[verb].steps.length])
        }
      }, 300_000)

      it("a drive verb exits 5 on a database below the window of its store's reads, names both versions, and changes nothing", async () => {
        // libSQL's window starts at version 5. The other two stores read their own version alone.
        const below =
          dialect === 'libsql' ? READABLE_SCHEMA_WINDOW.oldest - 1 : CURRENT_SCHEMA_VERSION - 1
        const db = await openCliDb(dialect, 'twin-below', below)
        try {
          const before = await db.dump()
          const seeded: SeededTasks = { completed: 'a', failed: 'b', cancelled: 'c', pending: 'd' }
          for (const verb of WRITE_VERBS) {
            const [step] = TWINS[verb].steps
            if (step === undefined) throw new Error(`${verb} has no step`)
            const run = await runCli(
              [...step.call(seeded, 'e').line, '--queue', QUEUE, '--target', db.target, '--json'],
              db.env,
            )
            const answer = JSON.parse(run.stdout) as Answer
            const message = answer.error?.message ?? ''
            expect(
              {
                verb,
                exit: run.exit,
                recorded: answer.recordedSchemaVersion,
                namesItsOwn: message.includes(`version ${below}`),
                namesTheBuilds: /this build reads versions \d+ to \d+/.test(message),
              },
              'mutation-verdict:behavior:cli-a-drive-verb-refuses-a-schema-below-the-window',
            ).toEqual({
              verb,
              exit: exitCode('schema'),
              recorded: below,
              namesItsOwn: true,
              namesTheBuilds: true,
            })
          }
          expect(await db.dump()).toBe(before)
        } finally {
          await db.close()
        }
      }, 120_000)
    })
  }
})

describe('the drive verbs at every schema version their store reads, on libSQL', () => {
  /**
   * The versions a drive verb may write at: the window the libSQL store's reads accept,
   * which starts at the version the release alpha.1 migrated to and ends at the build's. A
   * verb is allowed at a version because its twin passes there, and the list of the verbs
   * is the list of the twins. A verb whose twin fails at a version fails here by name, and
   * then the verb is refused at that version or the window moves.
   */
  const VERSIONS = Array.from(
    { length: READABLE_SCHEMA_WINDOW.newest - READABLE_SCHEMA_WINDOW.oldest + 1 },
    (_, index) => READABLE_SCHEMA_WINDOW.oldest + index,
  )

  it('starts at version 5, the version of the release alpha.1, and ends at the version of the build', () => {
    expect([VERSIONS[0], VERSIONS.at(-1)]).toEqual([5, CURRENT_SCHEMA_VERSION])
  })

  it("every drive verb leaves the dump its port call leaves on a twin, at every version from 5 to the build's", async () => {
    for (const version of VERSIONS) {
      for (const verb of WRITE_VERBS) {
        const steps = await compared(
          'libsql',
          verb,
          version,
          'mutation-verdict:behavior:cli-a-drive-verb-is-its-port-call',
        )
        expect([version, verb, steps]).toEqual([version, verb, TWINS[verb].steps.length])
      }
    }
  }, 300_000)
})

/** The walks: these seeds, each this many steps. A failing seed replays exactly. */
const WALKS = Array.from({ length: 10 }, (_, seed) => `drive-${seed}`)
const STEPS = 100

/**
 * What the commands over the walks must reach, so a comparison of nothing fails. Measured
 * when the case was written: 241 commands, of which 9 revivals and 17 retries that revived
 * nothing, 61 cancellations and 82 cancels that cancelled nothing, 12 transitions swept, 10
 * tasks spawned and 22 emits. Each floor sits below what was measured, so a change to the
 * walk that moves a seed does not fail the case, and a walk that leaves nothing to drive does.
 */
const FLOORS = {
  commands: 200,
  revived: 6,
  notRevived: 12,
  cancelled: 45,
  notCancelled: 60,
  swept: 8,
  spawned: 10,
  emitted: 15,
}

/** A store opener over a fixture's own database, so `main` drives the state a walk left. */
const over =
  (fixture: StoreFixture): StoreOpener =>
  async (_url, _token, ids: IdSource) => ({
    scheme: 'file:',
    window: READABLE_SCHEMA_WINDOW,
    notes: SCHEMA_VERSION_NOTES,
    admin: fixture.admin,
    scheduler: new LibsqlSchedulerStore(fixture.raw, ids),
    operator: operatorReads(fixture.raw),
    close: async () => undefined,
  })

async function column(raw: SqlExecutor, sql: string): Promise<string[]> {
  const [read] = await raw.batch('fixture:walk-read', [{ sql, args: [] }], 'read')
  return (read?.rows ?? []).map((row) => String(row.value))
}

describe('a drive verb over the states a walk of the engine leaves, on libSQL', () => {
  it('leaves the dump its port call leaves on a twin the same walk built, after every command', async () => {
    const url = 'file:/a-walk/subject.sqlite'
    const env = { DURABLERUN_STORE_URL: url }
    const target = await storeTarget(url)
    const reached = {
      commands: 0,
      revived: 0,
      notRevived: 0,
      cancelled: 0,
      notCancelled: 0,
      swept: 0,
      spawned: 0,
      emitted: 0,
    }
    const differed: string[] = []
    for (const walk of WALKS) {
      await runFuzzScenario(makeLibsqlFixture, walk, STEPS, (subject) =>
        runFuzzScenario(makeLibsqlFixture, walk, STEPS, async (twin) => {
          // A walk replays exactly, so the two fixtures hold one state.
          expect(await dumpOf('libsql', twin.raw), `walk ${walk}: the twins start equal`).toBe(
            await dumpOf('libsql', subject.raw),
          )
          const tasks = await column(
            subject.raw,
            `SELECT task_id AS value FROM tasks WHERE queue = '${QUEUE}' ORDER BY task_id`,
          )
          const failed = await column(
            subject.raw,
            `SELECT task_id AS value FROM tasks WHERE queue = '${QUEUE}' AND state = 'failed' ORDER BY task_id`,
          )
          // The events a wait names and the events that exist, but for the engine's own.
          const events = (
            await column(
              subject.raw,
              `SELECT event_name AS value FROM waits WHERE queue = '${QUEUE}' UNION SELECT event_name FROM events WHERE queue = '${QUEUE}' ORDER BY 1`,
            )
          ).filter((name) => !name.startsWith('$'))
          const [key] = await column(
            subject.raw,
            `SELECT idempotency_key AS value FROM tasks WHERE queue = '${QUEUE}' AND idempotency_key IS NOT NULL ORDER BY task_id LIMIT 1`,
          )
          const calls: [WriteVerb, Call][] = [
            ['sweep', CALLS.sweep(2)],
            ['sweep', CALLS.sweep()],
            ...failed.map((taskId): [WriteVerb, Call] => ['retry', CALLS.retry(taskId)]),
            ...events.map((name): [WriteVerb, Call] => [
              'emit',
              CALLS.emit(name, '{"by":"an operator"}'),
            ]),
            ['enqueue', CALLS.enqueue('report', `walk-${walk}`, '{"n":1}')],
            ...(key === undefined
              ? []
              : [['enqueue', CALLS.enqueue('report', key)] as [WriteVerb, Call]]),
            // Every task the walk left, the revived among them, and the ended ones, which refuse.
            ...tasks.map((taskId): [WriteVerb, Call] => ['cancel', CALLS.cancel(taskId)]),
            ...failed.map((taskId): [WriteVerb, Call] => ['retry', CALLS.retry(taskId)]),
            ['sweep', CALLS.sweep()],
          ]
          for (const [index, [verb, call]] of calls.entries()) {
            const seed = `walk-${index}`
            const run = await runCli(
              [...call.line, '--queue', QUEUE, '--target', target, '--json'],
              env,
              over(subject),
              testIdSource(seed),
            )
            const ported = await call.port(new LibsqlSchedulerStore(twin.raw, testIdSource(seed)))
            const answer = JSON.parse(run.stdout) as Answer
            const [said, did] = SAID[verb](answer, ported)
            const where = `walk ${walk}, command ${index}: ${call.line.join(' ')}`
            if ((await dumpOf('libsql', subject.raw)) !== (await dumpOf('libsql', twin.raw))) {
              differed.push(`${where}: the dumps differ`)
            }
            if (!isDeepStrictEqual(said, did)) {
              differed.push(`${where}: the answer is not the port's`)
            }
            if (![0, exitCode('refused')].includes(run.exit)) {
              differed.push(`${where}: exit ${run.exit}: ${run.stdout}`)
            }
            reached.commands += 1
            if (verb === 'retry') reached[ported === null ? 'notRevived' : 'revived'] += 1
            if (verb === 'cancel') reached[ported === true ? 'cancelled' : 'notCancelled'] += 1
            if (verb === 'sweep') reached.swept += (ported as unknown[]).length
            if (verb === 'enqueue' && (ported as { created: boolean }).created) reached.spawned += 1
            if (verb === 'emit') reached.emitted += 1
          }
        }).then(() => undefined),
      )
    }
    expect(
      differed,
      'mutation-verdict:behavior:cli-a-drive-verb-is-its-port-call-over-a-walk',
    ).toEqual([])
    const short = Object.entries(FLOORS)
      .filter(([name, floor]) => reached[name as keyof typeof FLOORS] < floor)
      .map(([name]) => name)
    expect({ short, reached }).toEqual({ short: [], reached })
  }, 600_000)
})
