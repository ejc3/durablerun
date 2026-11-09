import type { SqlExecutor } from '@durablerun/core'
import { CURRENT_SCHEMA_VERSION } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import {
  type FaultSite,
  OWN_QUEUE,
  PURGE_EVERY_STATE,
  onDb,
  openCliDb,
  openerWrapping,
  refusing,
  runCli,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * A store that refuses its credential partway through a command (DESIGN.md section 3.11). A
 * refusal met at a command's first batch is held on every dialect by the case that runs
 * every store command against a store that refuses its credential, and the exit of a
 * refusal at every batch every command sends is held by the fault surface's file. These
 * hold what three commands print when the refusal comes after they have done something.
 * The refusal is injected at the executor, on libSQL, because a command does the same with
 * the type whatever dialect raised it.
 */

const refusingAt = (site: FaultSite) => (real: SqlExecutor) => refusing(real, site)

const answerOf = (stdout: string) =>
  JSON.parse(stdout) as Record<string, unknown> & { error?: { kind?: string; name?: string } }

describe('a store that refuses its credential partway through a command', () => {
  it('purge prints the units it reached and where it stopped, exits 4, and a repeat under a credential the store accepts purges the rest', () =>
    onDb('refused-purge-partway', async (db) => {
      const seeded = await seedTasks(db)
      // The database's own clock reads years past every seeded ending.
      await db.admin.setFakeNowEpochMs(null)
      const line = ['purge', ...PURGE_EVERY_STATE, '--execute', ...writeFlags(db), '--json']
      const run = await runCli(
        line,
        db.env,
        openerWrapping(refusingAt({ label: 'purge-unit', occurrence: 2 })),
      )
      const answer = answerOf(run.stdout)
      expect({
        exit: run.exit,
        kind: answer.error?.kind,
        purged: (answer.purged as { taskId: string }[]).map((unit) => unit.taskId),
        finished: answer.finished,
        stoppedAt: answer.stoppedAt,
      }).toEqual({
        exit: exitCode('unauthorized'),
        kind: 'store-access-refused',
        purged: [seeded.completed],
        finished: false,
        stoppedAt: { call: 'purge-unit', taskId: seeded.failed },
      })
      const again = answerOf((await runCli(line, db.env)).stdout)
      expect({ exit: again.exit, finished: again.finished }).toEqual({
        exit: 'done',
        finished: true,
      })
    }))

  it('migrate exits 4 at the version whose write is refused, and says which versions it applied and the version now recorded', async () => {
    const db = await openCliDb('libsql', 'refused-migrate-partway', 5)
    try {
      const run = await runCli(
        ['migrate', '--yes', '--target', db.target, '--json'],
        db.env,
        openerWrapping(refusingAt({ label: `migrate:v${CURRENT_SCHEMA_VERSION}`, occurrence: 1 })),
      )
      const versions = Array.from({ length: CURRENT_SCHEMA_VERSION - 6 }, (_, index) => index + 6)
      expect({ exit: run.exit, answer: answerOf(run.stdout) }).toMatchObject({
        exit: exitCode('unauthorized'),
        answer: {
          from: 5,
          to: CURRENT_SCHEMA_VERSION - 1,
          applied: versions,
          error: { kind: 'store-access-refused', name: 'StoreAccessRefusedError' },
        },
      })
    } finally {
      await db.close()
    }
  })

  it('selftest prints the calls it reached, marks the call that was refused failed, and exits 4', () =>
    onDb('refused-selftest-step', async (db) => {
      const [label] =
        COMMANDS.selftest.ports.find((port) => port.call === 'scheduler.emitEvent')?.labels ?? []
      if (label === undefined) throw new Error('selftest declares no emit')
      const run = await runCli(
        ['selftest', '--queue', OWN_QUEUE, '--target', db.target, '--json'],
        db.env,
        openerWrapping(refusingAt({ label, occurrence: 1 })),
      )
      const answer = answerOf(run.stdout) as ReturnType<typeof answerOf> & {
        passed?: boolean
        steps?: { call: string; result: string }[]
      }
      const steps = answer.steps ?? []
      const at = steps.findIndex((step) => step.call === 'scheduler.emitEvent')
      expect({
        exit: run.exit,
        passed: answer.passed,
        kind: answer.error?.kind,
        before: [...new Set(steps.slice(0, at).map((step) => step.result))],
        at: steps[at]?.result,
        after: [...new Set(steps.slice(at + 1).map((step) => step.result))],
      }).toEqual({
        exit: exitCode('unauthorized'),
        passed: false,
        kind: 'store-access-refused',
        before: ['ok'],
        at: 'failed',
        after: ['not-run'],
      })
    }))
})
