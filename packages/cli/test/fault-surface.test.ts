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
 * Exit test line 34: the CLI's own generated fault surface. Every batch a command sends is
 * met, one sending at a time, by each of the fault matrix's kinds as the CLI meets them.
 * The command table declares the exit each kind ends in, and the table's labels must cover
 * every batch sent. After each case every table equals either the state before the command
 * or the state one run without a fault leaves, and running the command again ends at that
 * second state and, for a read, prints what the run without a fault printed.
 */

/** The matrix's kinds as the CLI meets them. A kind the matrix adds fails to compile here. */
const AS_THE_CLI_MEETS: Readonly<Record<MatrixFault, CliFault>> = {
  'crash-before': 'unavailable-before',
  'crash-after': 'crash-after',
  duplicate: 'duplicate',
}

interface Scenario {
  readonly schema: StartingSchema
  line(db: CliDb, seeded: SeededTasks): string[]
}

/** Each store command's starting state and command line, keyed by the table's verbs. */
const SCENARIOS: Readonly<Record<Exclude<Verb, 'help'>, Scenario>> = {
  doctor: { schema: 'current', line: () => ['doctor', '--queue', QUEUE, '--json'] },
  // One version below, so the run sends one version's write and a fault leaves either state.
  migrate: {
    schema: CURRENT_SCHEMA_VERSION - 1,
    line: (db) => ['migrate', '--yes', '--target', db.target, '--json'],
  },
  result: {
    schema: 'current',
    line: (_db, seeded) => ['result', seeded.completed, '--queue', QUEUE, '--json'],
  },
  checkpoints: {
    schema: 'current',
    line: (_db, seeded) => ['checkpoints', seeded.completed, '--queue', QUEUE, '--json'],
  },
}

/** Every starting state a command's fault surface runs from. */
function scenariosOf(verb: Exclude<Verb, 'help'>): readonly Scenario[] {
  return [SCENARIOS[verb]]
}

/** The labels of every batch one run without a fault sends, from one starting state. */
async function cleanLabels(
  dialect: (typeof SELECTED)[number],
  verb: Exclude<Verb, 'help'>,
  scenario: Scenario,
): Promise<string[]> {
  const db = await openCliDb(dialect, `labels-${verb}`, scenario.schema)
  try {
    const seeded = await seedTasks(db)
    const recording = recordingOpener()
    const run = await runCli(scenario.line(db, seeded), db.env, recording.opener)
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

async function prepared(dialect: (typeof SELECTED)[number], verb: Exclude<Verb, 'help'>) {
  const db = await openCliDb(dialect, `faults-${verb}`, SCENARIOS[verb].schema)
  const seeded = await seedTasks(db)
  return { db, seeded, line: SCENARIOS[verb].line(db, seeded) }
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
  verb: Exclude<Verb, 'help'>,
  only?: { readonly fault: CliFault; readonly marker: string },
): Promise<number> {
  const spec = COMMANDS[verb]
  const clean = await prepared(dialect, verb)
  const recording = recordingOpener()
  let untouched: string
  let settled: string
  let answer: string
  try {
    untouched = await clean.db.dump()
    const run = await runCli(clean.line, clean.db.env, recording.opener)
    expect(run.exit, run.stdout).toBe(0)
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
      const where = `${dialect} ${verb}: ${fault} at ${site.label} #${site.occurrence}`
      const { db, line } = await prepared(dialect, verb)
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
        const after = await db.dump()
        expect([untouched, settled].includes(after), `${where}: a state no run leaves`).toBe(true)
        const again = await runCli(line, db.env)
        expect(again.exit, `${where}: the repeat`).toBe(0)
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
  it('has a scenario for every store command in the table, and every matrix kind', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      VERBS.filter((verb) => COMMANDS[verb].opensStore).sort(),
    )
    expect(Object.values(AS_THE_CLI_MEETS).sort()).toEqual([...CLI_FAULTS].sort())
  })

  it('a read that meets an unavailable store before its batch exits 6 and changes nothing', async () => {
    const cases = await faultSurface('libsql', 'result', {
      fault: 'unavailable-before',
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
          for (const scenario of scenariosOf(verb)) {
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
        it(`${verb} under every fault kind at every batch it sends`, async () => {
          const cases = await faultSurface(dialect, verb)
          expect(cases).toBeGreaterThanOrEqual(CLI_FAULTS.length)
        }, 300_000)
      }
    })
  }
})
