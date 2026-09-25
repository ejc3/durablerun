import type { MatrixFault } from '@durablerun/conformance'
import { RecordingExecutor } from '@durablerun/core/testing'
import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import {
  CLI_FAULTS,
  COMMANDS,
  type CliFault,
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
  const recorders: RecordingExecutor[] = []
  let untouched: string
  let settled: string
  let answer: string
  try {
    untouched = await clean.db.dump()
    const run = await runCli(
      clean.line,
      clean.db.env,
      openerWrapping((real) => {
        const recorder = new RecordingExecutor(real)
        recorders.push(recorder)
        return recorder
      }),
    )
    expect(run.exit, run.stdout).toBe(0)
    settled = await clean.db.dump()
    answer = run.stdout
  } finally {
    await clean.db.close()
  }
  const labels = recorders.flatMap((recorder) => recorder.labels)
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
