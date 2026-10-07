import type { MatrixFault } from '@durablerun/conformance'
import { testIdSource } from '@durablerun/core/testing'
import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import {
  CLI_FAULTS,
  COMMANDS,
  type CliFault,
  type CommandSpec,
  VERBS,
  type Verb,
  declaresLabel,
  faultExit,
} from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import { openStore } from '../src/open-store.js'
import { asleep, chainOfAwaits, parkedOnAnEvent } from './explain-seeds.js'
import { owedToASweep } from './queue-seeds.js'
import {
  COMPLETED_KEY,
  type CliDb,
  type FaultSite,
  PURGE_WINDOWS,
  QUEUE,
  SELECTED,
  SENTINEL,
  type SeededTasks,
  type StartingSchema,
  childrenOfARunningParent,
  faulting,
  openCliDb,
  openerWrapping,
  recordingIds,
  recordingOpener,
  runCli,
  seedTasks,
  withoutMinted,
  writeFlags,
} from './support.js'

/**
 * Exit test line 34: the CLI's own generated fault surface. A fault is injected at the
 * executor, as the CLI sees it, at every batch a store command sends, one sending at a time,
 * from each starting state the command runs from: the executor rejects with
 * StoreUnavailableError before the batch is sent, rejects after the batch commits, or
 * delivers the batch twice. It is a CLI-level injection, not SimWorld's SimCrash. The
 * command table declares the exit each fault ends in, its labels must cover every batch
 * sent, and every label and faultsAt entry it declares must be sent from some starting
 * state. After each case, running the same command again reaches the state one successful
 * run leaves, and for a read prints what that run printed. A read also leaves every table as
 * it found it, and migrate leaves a recorded version between the one it started from and
 * the build's. A drive verb mints ids, and the repeat is another process, whose ids are not
 * the first run's: the repeat's ids go on from where the first run's stopped, and the two
 * states are compared with the ids each run minted read as one placeholder. Every database
 * holds the redaction sentinel of line 33 where it holds tasks, and no run of any case
 * prints it.
 */

/** The matrix's kinds, which the CLI injects under the same names. A new kind fails to compile. */
const AS_THE_CLI_MEETS: Readonly<Record<MatrixFault, CliFault>> = {
  'crash-before': 'crash-before',
  'crash-after': 'crash-after',
  duplicate: 'duplicate',
}

type StoreVerb = Exclude<Verb, 'help' | 'tick'>

/** The commands that open a store, which are the ones a fault at the executor meets. */
const STORE_VERBS = VERBS.filter((verb): verb is StoreVerb => COMMANDS[verb].opensStore)

interface Scenario {
  /** The starting state, as the test names it. */
  readonly name: string
  readonly schema: StartingSchema
  /**
   * The dialects on which tasks are written first, through the current store. A database that
   * was never initialized holds none, and on a version 5 MySQL database the current store's
   * claim names an index version 5 lacks. The release alpha.1 wrote version 5 on libSQL alone.
   */
  readonly seeded: readonly (typeof SELECTED)[number][]
  /** One more task written after those, through the current store, whose id the line takes. */
  prepare?(db: CliDb): Promise<string>
  line(db: CliDb, seeded: SeededTasks | undefined, prepared: string | undefined): string[]
}

const ALL: readonly (typeof SELECTED)[number][] = ['libsql', 'postgres', 'mysql']

const migrateFrom = (
  name: string,
  schema: StartingSchema,
  seeded: readonly (typeof SELECTED)[number][],
): Scenario => ({
  name,
  schema,
  seeded,
  line: (db) => ['migrate', '--yes', '--target', db.target, '--json'],
})

const readAt = (line: (seeded: SeededTasks | undefined) => string[]): readonly Scenario[] => [
  { name: 'the current version', schema: 'current', seeded: ALL, line: (_db, s) => line(s) },
]

/** The flags every write to a queue takes: the queue, the store named again, and JSON. */
const named = (db: CliDb): string[] => [...writeFlags(db), '--json']

/** A drive verb's one starting state: the current version, with tasks written on every dialect. */
const writeAt = (name: string, line: (db: CliDb, seeded: SeededTasks) => string[]): Scenario => ({
  name,
  schema: 'current',
  seeded: ALL,
  line: (db, seeded) => {
    if (seeded === undefined) throw new Error('a write scenario starts from a seeded database')
    return line(db, seeded)
  },
})

/** The idempotency key the `enqueue` scenario spawns under, which holds the sentinel. */
const ENQUEUE_KEY = `enqueue-${SENTINEL}`

/** The completed task a read names. */
const completed = (seeded: SeededTasks | undefined): string => {
  if (seeded === undefined) throw new Error('a read scenario starts from a seeded database')
  return seeded.completed
}

/** Each store command's starting states and command line, keyed by the table's verbs. */
const SCENARIOS: Readonly<Record<StoreVerb, readonly Scenario[]>> = {
  doctor: readAt(() => ['doctor', '--queue', QUEUE, '--json']),
  migrate: [
    migrateFrom('a database that was never initialized', 'empty', []),
    migrateFrom('version 5, the release alpha.1', 5, ['libsql', 'postgres']),
    migrateFrom('one version below the build', CURRENT_SCHEMA_VERSION - 1, ALL),
  ],
  result: readAt((seeded) => ['result', completed(seeded), '--queue', QUEUE, '--json']),
  checkpoints: readAt((seeded) => ['checkpoints', completed(seeded), '--queue', QUEUE, '--json']),
  // By a key, `inspect` sends the read by key and then every batch a read by id sends, so
  // the one scenario meets each batch the command declares.
  inspect: [
    {
      name: 'the current version, by an idempotency key',
      schema: 'current',
      seeded: ALL,
      line: () => ['inspect', '--key', COMPLETED_KEY, '--queue', QUEUE, '--json'],
    },
  ],
  // By the key of a started run parked on a timer, `explain` sends the read by key, the
  // facts and the checkpoints. Of a parent parked on its child it reads the facts of both
  // and the waiters of the child's completion, so a fault also meets the second task's
  // reads, and between the two scenarios each batch it declares is sent.
  explain: [
    {
      name: 'the current version, by the key of a run asleep on a timer',
      schema: 'current',
      seeded: ALL,
      prepare: (db) => asleep(db, 120, { idempotencyKey: ASLEEP_KEY }),
      line: () => ['explain', '--key', ASLEEP_KEY, '--queue', QUEUE, '--json'],
    },
    {
      name: 'the current version, of a parent parked on its child',
      schema: 'current',
      seeded: ALL,
      prepare: async (db) => (await chainOfAwaits(db, 2))[0] ?? '',
      line: (_db, _seeded, parent) => ['explain', parent ?? '', '--queue', QUEUE, '--json'],
    },
  ],
  // With --older-than, `stuck` sends each batch it declares.
  stuck: readAt(() => ['stuck', '--queue', QUEUE, '--json', '--older-than', '1h']),
  stats: readAt(() => ['stats', '--queue', QUEUE, '--json']),
  sizes: readAt(() => ['sizes', '--queue', QUEUE, '--json']),
  // Under a key and with parameters that hold the sentinel of line 33.
  enqueue: [
    writeAt('the current version, under a key no task has', (db) => [
      'enqueue',
      'report',
      '--key',
      ENQUEUE_KEY,
      '--params',
      JSON.stringify({ secret: SENTINEL }),
      ...named(db),
    ]),
    // Under a key a task holds, so the command reads the task it found.
    {
      ...writeAt('the current version, under a key a task holds', (db) => [
        'enqueue',
        'report',
        '--key',
        HELD_KEY,
        ...named(db),
      ]),
      prepare: async (db) =>
        (await db.store.spawn(QUEUE, 'report', 'null', { idempotencyKey: HELD_KEY })).taskId,
    },
  ],
  // An emit sends each batch it declares: the event's state and its waiters before the
  // write, and its stored payload after. A run is parked on the event, so the write wakes it.
  emit: [
    {
      ...writeAt('the current version, of an event a run awaits', (db) => [
        'emit',
        'go-ahead',
        '--payload',
        JSON.stringify({ secret: SENTINEL }),
        '--yes',
        ...named(db),
      ]),
      prepare: (db) => parkedOnAnEvent(db, null, {}, 'go-ahead'),
    },
  ],
  cancel: [
    writeAt('the current version, of a task that is pending', (db, seeded) => [
      'cancel',
      seeded.pending,
      '--yes',
      ...named(db),
    ]),
  ],
  // A revival sends the read of the task and the write. What the guard says of the task is
  // read only when the port answers null, which a task that is live makes it do.
  retry: [
    writeAt('the current version, of a task that failed', (db, seeded) => [
      'retry',
      seeded.failed,
      '--yes',
      ...named(db),
    ]),
    writeAt('the current version, of a task that is live', (db, seeded) => [
      'retry',
      seeded.pending,
      '--yes',
      ...named(db),
    ]),
  ],
  // A sweep with one of each transition to make, so it sends each batch it declares.
  sweep: [
    {
      ...writeAt(
        'the current version, of a queue with a deadline passed, a launch lost and a lease lapsed',
        (db) => ['sweep', ...named(db)],
      ),
      prepare: async (db) => (await owedToASweep(db)).lost.taskId,
    },
  ],
  // A dry run reads what the barrier says of every candidate. With --execute the purge of
  // each is sent, and the barrier is read of the one it keeps, so between the two scenarios
  // each batch the command declares is sent, and a fault meets the read after a purge the
  // port answered kept as well as the purge itself.
  purge: [
    {
      ...writeAt('the current version, a dry run of units that are years old', (db) =>
        purgeLine(db),
      ),
      prepare: aKeptCandidate,
    },
    {
      ...writeAt(
        'the current version, with --execute, of units the barrier lets go and one it keeps',
        (db) => purgeLine(db, '--failed-after', '1h', '--execute'),
      ),
      prepare: aKeptCandidate,
    },
  ],
}

/** The windows every `purge` scenario names, and the flags every write takes. */
const purgeLine = (db: CliDb, ...more: string[]): string[] => [
  'purge',
  ...PURGE_WINDOWS,
  ...more,
  ...named(db),
]

/**
 * What a `purge` scenario adds to the seeded tasks: a child that completed under a parent
 * that is still running, which is a candidate the barrier keeps. The test clock is then
 * cleared, because a purge refuses under one, and every ending above is years old by the
 * database's own clock.
 */
async function aKeptCandidate(db: CliDb): Promise<string> {
  const [child] = await childrenOfARunningParent(db, 1)
  await db.admin.setFakeNowEpochMs(null)
  return String(child)
}

/** The idempotency key of the task the second `enqueue` scenario finds. */
const HELD_KEY = 'a-key-a-task-holds'

/** The idempotency key of the sleeping task the first `explain` scenario writes. */
const ASLEEP_KEY = 'asleep-under-a-key'

/** A database in a scenario's starting state, and the command line that runs against it. */
async function prepared(dialect: (typeof SELECTED)[number], verb: StoreVerb, scenario: Scenario) {
  const db = await openCliDb(dialect, `faults-${verb}`, scenario.schema)
  const seeded = scenario.seeded.includes(dialect) ? await seedTasks(db) : undefined
  return { db, line: scenario.line(db, seeded, await scenario.prepare?.(db)) }
}

/** The labels of every batch one run without a fault sends, from one starting state. */
async function cleanLabels(
  dialect: (typeof SELECTED)[number],
  verb: StoreVerb,
  scenario: Scenario,
): Promise<string[]> {
  const { db, line } = await prepared(dialect, verb, scenario)
  try {
    const recording = recordingOpener()
    const run = await runCli(line, db.env, recording.opener)
    expect(run.exit, run.stdout).toBe(0)
    return recording.sent().map((batch) => batch.label)
  } finally {
    await db.close()
  }
}

/**
 * Whether one label the table writes, `migrate:v<N>` among them, matches a label sent. The
 * table's own matcher reads a command's every label, so it is asked about a command that
 * declares this one alone.
 */
function meets(spec: CommandSpec, declared: string, label: string): boolean {
  return declaresLabel(
    { ...spec, ports: [{ call: 'admin.schemaVersion', labels: [declared] }] },
    label,
  )
}

/** Line 33's check: a run without --reveal prints the sentinel in neither stream. */
function expectNoSentinel(
  run: { readonly stdout: string; readonly stderr: string },
  where: string,
) {
  expect(`${run.stdout}${run.stderr}`.includes(SENTINEL), `${where} printed the sentinel`).toBe(
    false,
  )
}

/** Every sending of every label, in order, of one run without a fault. */
function sitesOf(labels: readonly string[]): FaultSite[] {
  const seen = new Map<string, number>()
  return labels.map((label) => {
    const occurrence = (seen.get(label) ?? 0) + 1
    seen.set(label, occurrence)
    return { label, occurrence }
  })
}

async function faultSurface(
  dialect: (typeof SELECTED)[number],
  verb: StoreVerb,
  scenario: Scenario,
  only?: { readonly fault: CliFault; readonly marker: string },
): Promise<number> {
  const spec = COMMANDS[verb]
  const clean = await prepared(dialect, verb, scenario)
  const recording = recordingOpener()
  // The ids the run without a fault mints, and below, the ids each faulted run and its
  // repeat mint. Every first run starts the same seeded source, so a fault's run mints what
  // the clean run minted up to the fault.
  const cleanIds = recordingIds(testIdSource('cli'))
  let untouched: string
  let settled: string
  let answer: string
  let from: number
  try {
    untouched = await clean.db.dump()
    from = await clean.db.admin.schemaVersion()
    const run = await runCli(clean.line, clean.db.env, recording.opener, cleanIds.ids)
    expect(run.exit, run.stdout).toBe(0)
    expectNoSentinel(run, `${dialect} ${verb} from ${scenario.name}: the clean run`)
    settled = await clean.db.dump()
    answer = run.stdout
  } finally {
    await clean.db.close()
  }
  const labels = recording.sent().map((batch) => batch.label)
  for (const label of labels) expect(declaresLabel(spec, label), `${verb} sent ${label}`).toBe(true)
  let cases = 0
  for (const site of sitesOf(labels)) {
    for (const fault of only === undefined ? CLI_FAULTS : [only.fault]) {
      const where = `${dialect} ${verb} from ${scenario.name}: ${fault} at ${site.label} #${site.occurrence}`
      const { db, line } = await prepared(dialect, verb, scenario)
      const minting = recordingIds(testIdSource('cli'))
      try {
        expect(await db.dump(), `${where}: the starting state`).toBe(untouched)
        const hit = await runCli(
          line,
          db.env,
          openerWrapping((real) => faulting(real, site, fault)),
          minting.ids,
        )
        expect({ where, exit: hit.exit }, only?.marker ?? where).toEqual({
          where,
          exit: exitCode(faultExit(spec, site.label, fault)),
        })
        expectNoSentinel(hit, where)
        if (spec.repeat === 'resumes') {
          const recorded = await db.admin.schemaVersion()
          expect(
            recorded >= from && recorded <= CURRENT_SCHEMA_VERSION,
            `${where}: recorded version ${recorded}`,
          ).toBe(true)
        } else if (!spec.writes) {
          expect(await db.dump(), `${where}: a read changed a table`).toBe(untouched)
        }
        // The repeat is another process: its ids go on from where the first run's stopped.
        const again = await runCli(line, db.env, openStore, minting.ids)
        expect(again.exit, `${where}: the repeat`).toBe(0)
        expectNoSentinel(again, `${where}: the repeat`)
        const state = (dump: string): string =>
          withoutMinted(dump, [...cleanIds.minted, ...minting.minted])
        expect(state(await db.dump()), only?.marker ?? `${where}: the repeat's state`).toBe(
          state(settled),
        )
        if (spec.repeat === 'read') expect(again.stdout, `${where}: the repeat`).toBe(answer)
        cases++
      } finally {
        await db.close()
      }
    }
  }
  return cases
}

describe('the CLI fault surface', () => {
  it('has scenarios for every store command in the table, and every matrix kind', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...STORE_VERBS].sort())
    for (const scenarios of Object.values(SCENARIOS)) expect(scenarios.length).toBeGreaterThan(0)
    expect(Object.values(AS_THE_CLI_MEETS).sort()).toEqual([...CLI_FAULTS].sort())
  })

  it('a read that meets an unavailable store before its batch exits 6 and changes nothing', async () => {
    const [scenario] = SCENARIOS.result
    if (scenario === undefined) throw new Error('result has no scenario')
    const cases = await faultSurface('libsql', 'result', scenario, {
      fault: 'crash-before',
      marker: 'mutation-verdict:behavior:cli-unavailable-store-exits-6',
    })
    expect(cases).toBeGreaterThan(0)
  })

  // Exit test line 34's red for the drive verbs. The answer to the spawn is lost after the
  // batch commits, and the command is run again by a process whose ids are its own. Under
  // the key it finds the task the first run made. Spawned under no key it would make a
  // second task, and the state after the repeat would hold two where a clean run leaves one.
  it('an enqueue whose answer was lost, run again, finds the task under its key and spawns no second one', async () => {
    const [scenario] = SCENARIOS.enqueue
    if (scenario === undefined) throw new Error('enqueue has no scenario')
    const cases = await faultSurface('libsql', 'enqueue', scenario, {
      fault: 'crash-after',
      marker: 'mutation-verdict:behavior:cli-enqueue-spawns-under-its-key',
    })
    expect(cases).toBeGreaterThan(0)
  })

  for (const dialect of SELECTED) {
    describe(`[${dialect}]`, () => {
      it('every batch label and faultsAt entry the command table declares is sent from some starting state', async () => {
        for (const verb of STORE_VERBS) {
          const spec = COMMANDS[verb]
          const sent = new Set<string>()
          for (const scenario of SCENARIOS[verb]) {
            for (const label of await cleanLabels(dialect, verb, scenario)) sent.add(label)
          }
          const declared = [
            ...spec.ports.flatMap((port) => port.labels),
            ...Object.keys(spec.faultsAt ?? {}),
          ]
          for (const label of declared) {
            expect(
              { verb, label, sent: [...sent].some((one) => meets(spec, label, one)) },
              'mutation-verdict:behavior:cli-every-declared-label-is-sent',
            ).toEqual({ verb, label, sent: true })
          }
        }
      }, 120_000)

      for (const verb of STORE_VERBS) {
        for (const scenario of SCENARIOS[verb]) {
          it(`${verb} from ${scenario.name} under every fault kind at every batch it sends`, async () => {
            const cases = await faultSurface(dialect, verb, scenario)
            expect(cases).toBeGreaterThanOrEqual(CLI_FAULTS.length)
          }, 300_000)
        }
      }
    })
  }
})
