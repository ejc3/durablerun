import type { MatrixFault } from '@durablerun/conformance'
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
import {
  type CliDb,
  type FaultSite,
  QUEUE,
  SELECTED,
  SENTINEL,
  type SeededTasks,
  type StartingSchema,
  faulting,
  openCliDb,
  openerWrapping,
  recordingOpener,
  runCli,
  seedTasks,
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
 * the build's. Every database holds the redaction sentinel of line 33 where it holds tasks,
 * and no run of any case prints it.
 */

/** The matrix's kinds, which the CLI injects under the same names. A new kind fails to compile. */
const AS_THE_CLI_MEETS: Readonly<Record<MatrixFault, CliFault>> = {
  'crash-before': 'crash-before',
  'crash-after': 'crash-after',
  duplicate: 'duplicate',
}

type StoreVerb = Exclude<Verb, 'help'>

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
  line(db: CliDb, seeded: SeededTasks | undefined): string[]
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
}

/** A database in a scenario's starting state, and the command line that runs against it. */
async function prepared(dialect: (typeof SELECTED)[number], verb: StoreVerb, scenario: Scenario) {
  const db = await openCliDb(dialect, `faults-${verb}`, scenario.schema)
  const seeded = scenario.seeded.includes(dialect) ? await seedTasks(db) : undefined
  return { db, line: scenario.line(db, seeded) }
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
  let untouched: string
  let settled: string
  let answer: string
  let from: number
  try {
    untouched = await clean.db.dump()
    from = await clean.db.admin.schemaVersion()
    const run = await runCli(clean.line, clean.db.env, recording.opener)
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
      try {
        expect(await db.dump(), `${where}: the starting state`).toBe(untouched)
        const hit = await runCli(
          line,
          db.env,
          openerWrapping((real) => faulting(real, site, fault)),
        )
        expect({ where, exit: hit.exit }, only?.marker ?? where).toEqual({
          where,
          exit: exitCode(faultExit(spec, site.label, fault)),
        })
        expectNoSentinel(hit, where)
        if (spec.writes) {
          const recorded = await db.admin.schemaVersion()
          expect(
            recorded >= from && recorded <= CURRENT_SCHEMA_VERSION,
            `${where}: recorded version ${recorded}`,
          ).toBe(true)
        } else {
          expect(await db.dump(), `${where}: a read changed a table`).toBe(untouched)
        }
        const again = await runCli(line, db.env)
        expect(again.exit, `${where}: the repeat`).toBe(0)
        expectNoSentinel(again, `${where}: the repeat`)
        expect(await db.dump(), `${where}: the repeat's state`).toBe(settled)
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
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      VERBS.filter((verb) => COMMANDS[verb].opensStore).sort(),
    )
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

  for (const dialect of SELECTED) {
    describe(`[${dialect}]`, () => {
      it('every batch label and faultsAt entry the command table declares is sent from some starting state', async () => {
        for (const verb of VERBS) {
          if (verb === 'help') continue
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

      for (const verb of VERBS) {
        if (verb === 'help') continue
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
