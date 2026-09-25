import {
  REASON_CANCELLED,
  REASON_CLAIM_TIMEOUT,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { VERBS, type Verb } from '../src/commands.js'
import { failureReason, resultView } from '../src/render.js'
import {
  type CliDb,
  QUEUE,
  SENTINEL,
  type SeededTasks,
  openCliDb,
  runCli,
  seedTasks,
} from './support.js'

/**
 * Exit test line 33: nothing a user wrote prints without --reveal. Each command's case runs
 * its command lines against a database whose params, headers, checkpoint state, event
 * payload, completed result, failure reason and idempotency key all hold the sentinel, in
 * human text and in --json, and reads stdout and stderr.
 */
interface SentinelCase {
  /** The command lines to run. */
  lines(db: CliDb, seeded: SeededTasks): string[][]
  /** Whether --reveal must print the sentinel, which shows the case reaches the values. */
  readonly shows: boolean
}

const CASES: Readonly<Record<Verb, SentinelCase>> = {
  help: { lines: () => [['help']], shows: false },
  doctor: { lines: () => [['doctor', '--queue', QUEUE]], shows: false },
  migrate: {
    lines: (db) => [
      ['migrate', '--target', db.target],
      ['migrate', '--target', db.target, '--yes'],
    ],
    shows: false,
  },
  result: {
    lines: (_db, seeded) => [
      ...Object.values(seeded).map((taskId) => ['result', taskId, '--queue', QUEUE]),
      ['result', 'no-such-task', '--queue', QUEUE],
    ],
    shows: true,
  },
  checkpoints: {
    lines: (_db, seeded) => [
      ['checkpoints', seeded.completed, '--queue', QUEUE],
      ['checkpoints', seeded.completed, '--queue', QUEUE, '--attempt', '1'],
    ],
    shows: true,
  },
}

/** Run one command's case, and fail with `marker` when the sentinel prints without --reveal. */
async function runCase(verb: Verb, marker: string): Promise<void> {
  const db = await openCliDb('libsql', `redaction-${verb}`)
  try {
    const seeded = await seedTasks(db)
    let shown = false
    for (const line of CASES[verb].lines(db, seeded)) {
      for (const output of [[], ['--json']]) {
        const run = await runCli([...line, ...output], db.env)
        expect(
          {
            line: [...line, ...output].join(' '),
            printed: `${run.stdout}${run.stderr}`.includes(SENTINEL),
          },
          marker,
        ).toEqual({ line: [...line, ...output].join(' '), printed: false })
        const revealed = await runCli([...line, ...output, '--reveal'], db.env)
        shown ||= `${revealed.stdout}${revealed.stderr}`.includes(SENTINEL)
      }
    }
    expect(shown, `${verb} --reveal printed the sentinel`).toBe(CASES[verb].shows)
  } finally {
    await db.close()
  }
}

describe('redaction', () => {
  it('walks the command table: every command has a sentinel case, and none prints the sentinel without --reveal', async () => {
    expect(Object.keys(CASES).sort()).toEqual([...VERBS].sort())
    for (const verb of VERBS) await runCase(verb, 'a command printed a value a user wrote')
  }, 60_000)

  it('result prints no value a user wrote without --reveal', async () => {
    await runCase('result', 'mutation-verdict:behavior:cli-redacts-result')
  })

  it('checkpoints prints no checkpoint state without --reveal', async () => {
    await runCase('checkpoints', 'mutation-verdict:behavior:cli-redacts-checkpoints')
  })

  it("result prints a failure reason the task's code wrote as its length and sha256", () => {
    const view = resultView(
      { state: 'failed', failureReasonJson: JSON.stringify({ message: SENTINEL }) },
      false,
    )
    expect(
      JSON.stringify(view).includes(SENTINEL),
      'mutation-verdict:behavior:cli-redacts-failure-reasons',
    ).toBe(false)
  })

  it("result prints a failed rollback's error as its length and sha256", () => {
    const view = resultView(
      {
        state: 'failed',
        failureReasonJson: REASON_CANCELLED,
        rollback: { outcome: 'failed', errorJson: JSON.stringify({ message: SENTINEL }) },
      },
      false,
    )
    expect(JSON.stringify(view)).not.toContain(SENTINEL)
    expect(
      JSON.stringify(
        resultView(
          {
            state: 'failed',
            failureReasonJson: REASON_CANCELLED,
            rollback: { outcome: 'failed', errorJson: JSON.stringify({ message: SENTINEL }) },
          },
          true,
        ),
      ),
    ).toContain(SENTINEL)
  })

  it('prints the four failure reasons the engine writes by name', async () => {
    for (const [reason, name] of [
      [REASON_CLAIM_TIMEOUT, '$ClaimTimeout'],
      [REASON_RELAUNCH_CAP, '$RelaunchCapExhausted'],
      [REASON_INFRA_CAP, '$InfraRetriesExhausted'],
      [REASON_CANCELLED, '$Cancelled'],
    ] as const) {
      expect(failureReason(reason, false)).toEqual({ engine: name })
    }
    const db = await openCliDb('libsql', 'redaction-engine')
    try {
      const seeded = await seedTasks(db)
      const run = await runCli(['result', seeded.cancelled, '--queue', QUEUE], db.env)
      expect(run.stdout).toContain('$Cancelled')
    } finally {
      await db.close()
    }
  })
})
