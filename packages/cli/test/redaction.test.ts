import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import {
  REASON_CANCELLED,
  REASON_CLAIM_TIMEOUT,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { VERBS, type Verb } from '../src/commands.js'
import { type Io, lastCatch } from '../src/main.js'
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

/**
 * A credential planted in the store URL's password and in the token. A database credential
 * is full admin, so it prints in no stream of any command, `--reveal` included, which shows
 * values users wrote and never the store's credentials.
 */
const CREDENTIAL = 'pw-4b7e2c'

/**
 * Store URLs whose password holds the credential. Each password holds a character a URL's
 * password must percent-encode, and several of the URLs do not parse at all, which is the
 * common typo an operator makes.
 */
const CREDENTIAL_URLS: readonly string[] = [
  `postgres://admin:${CREDENTIAL}#x@db.example.io:5432/app`,
  `mysql://root:${CREDENTIAL}#x@db.example.io:3306/app`,
  `postgresql://admin:${CREDENTIAL}/x@db.example.io/app`,
  `postgresql://admin:${CREDENTIAL}@x@127.0.0.1:1/app`,
  `mysql://root:${CREDENTIAL}%zz@127.0.0.1:1/app`,
  `postgres://admin:${CREDENTIAL}\nx@127.0.0.1:1/app`,
  `postgres://admin:${CREDENTIAL}@[bad/app`,
  `mysql://root:${CREDENTIAL}@127.0.0.1:99999/app`,
  `libsql://tok:${CREDENTIAL}@exa mple.io`,
  `libsql://tok:${CREDENTIAL}@127.0.0.1:1`,
  `https://tok:${CREDENTIAL}@127.0.0.1:1`,
]

/** Each command's lines against a URL that holds a credential, keyed by the table's verbs. */
const CREDENTIAL_LINES: Readonly<Record<Verb, (target: string) => string[][]>> = {
  help: () => [['help']],
  doctor: () => [['doctor', '--queue', QUEUE]],
  migrate: (target) => [
    ['migrate', '--target', target],
    ['migrate', '--target', target, '--yes'],
    ['migrate', '--target', 'elsewhere', '--yes'],
  ],
  result: () => [['result', 'a-task', '--queue', QUEUE]],
  checkpoints: () => [['checkpoints', 'a-task', '--queue', QUEUE, '--attempt', '1']],
}

/** What --target names for a URL, or a stand-in for a URL that names nothing. */
function targetOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return 'x'
  }
}

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'durablerun.ts')

describe('redaction', () => {
  it('a credential in the store URL or its token prints in no stream of any command, and every command answers with an exit code', async () => {
    expect(Object.keys(CREDENTIAL_LINES).sort()).toEqual([...VERBS].sort())
    for (const url of CREDENTIAL_URLS) {
      for (const token of [undefined, `token-${CREDENTIAL}`]) {
        const env = { DURABLERUN_STORE_URL: url, DURABLERUN_STORE_TOKEN: token }
        for (const verb of VERBS) {
          for (const line of CREDENTIAL_LINES[verb](targetOf(url))) {
            for (const extra of [[], ['--json'], ['--reveal'], ['--json', '--reveal']]) {
              const argv = [...line, ...extra]
              let printed: string
              let threw = false
              try {
                const run = await runCli(argv, env)
                printed = `${run.stdout}${run.stderr}`
              } catch (error) {
                // A throw from main reached the bin, and Node printed it as inspect shows it.
                threw = true
                printed = inspect(error)
              }
              expect(
                {
                  url: JSON.stringify(url).replaceAll(CREDENTIAL, '<credential>'),
                  token: token !== undefined,
                  argv: argv.join(' '),
                  printed: printed.includes(CREDENTIAL),
                  threw,
                },
                'mutation-verdict:behavior:cli-store-url-prints-no-credential',
              ).toEqual({
                url: JSON.stringify(url).replaceAll(CREDENTIAL, '<credential>'),
                token: token !== undefined,
                argv: argv.join(' '),
                printed: false,
                threw: false,
              })
            }
          }
        }
      }
    }
  }, 120_000)

  it("the bin's last catch prints an unexpected error's name and nothing of its message or fields", async () => {
    let printed = ''
    const io: Io = {
      out: (text) => {
        printed += text
      },
      err: (text) => {
        printed += text
      },
    }
    const thrown = Object.assign(new TypeError(`Invalid URL mysql://root:${CREDENTIAL}@x`), {
      input: `mysql://root:${CREDENTIAL}@x`,
    })
    const exit = await lastCatch(io, () => Promise.reject(thrown))
    expect(
      { exit, printed: printed.includes(CREDENTIAL), named: printed.includes('TypeError') },
      'mutation-verdict:behavior:cli-last-catch-prints-only-a-name',
    ).toEqual({ exit: 1, printed: false, named: true })
    printed = ''
    expect(await lastCatch(io, () => Promise.reject(`thrown ${CREDENTIAL}`))).toBe(1)
    expect(printed).not.toContain(CREDENTIAL)
    expect(await lastCatch(io, () => Promise.resolve(0))).toBe(0)
  })

  it('the bin prints no credential from a store URL that does not parse, and exits 2', () => {
    for (const url of [
      `mysql://root:${CREDENTIAL}#x@db.example.io:3306/app`,
      `postgres://admin:${CREDENTIAL}@[bad/app`,
      `libsql://tok:${CREDENTIAL}@exa mple.io`,
    ]) {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', BIN, 'doctor', '--queue', QUEUE, '--json'],
        {
          cwd: ROOT,
          env: { PATH: process.env.PATH ?? '', DURABLERUN_STORE_URL: url },
          encoding: 'utf8',
        },
      )
      expect({
        url: url.replaceAll(CREDENTIAL, '<credential>'),
        exit: child.status,
        printed: `${child.stdout}${child.stderr}`.includes(CREDENTIAL),
      }).toEqual({ url: url.replaceAll(CREDENTIAL, '<credential>'), exit: 2, printed: false })
    }
  }, 60_000)

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
