import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { digestKey, digestPeriod } from '../../../apps/dogfood/src/week-receipt.js'
import { parseInvocation } from '../src/commands.js'
import { ROOT } from './support.js'

/**
 * The workflow of the maintainer's week (BUILD.md exit test line 44 and receipt M1) holds a
 * database credential, writes each hour and deletes each day. These cases read the workflow
 * file: its one job is off until one repository variable is set, the job requires the
 * pinned database before any step holds the credential, and its two command steps, run here
 * against a stand-in for `pnpm`, send the commands as the verbs take them, each report to a
 * file and nothing of a report to the log.
 */

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: string
  readonly env?: Readonly<Record<string, string>>
  readonly with?: Readonly<Record<string, unknown>>
}

interface Job {
  readonly if?: string
  readonly env?: Readonly<Record<string, string>>
  readonly permissions?: unknown
  readonly steps: readonly Step[]
}

const workflow = parse(
  readFileSync(join(ROOT, '.github', 'workflows', 'operable-week.yml'), 'utf8'),
) as {
  readonly on: {
    readonly schedule: readonly { readonly cron: string }[]
    readonly workflow_dispatch: {
      readonly inputs: { readonly operation: { readonly options: readonly string[] } }
    }
  }
  readonly permissions: unknown
  readonly env?: unknown
  readonly jobs: Readonly<Record<string, Job>>
}

const jobs = Object.entries(workflow.jobs)
const [job] = Object.values(workflow.jobs)
if (job === undefined) throw new Error('the workflow has no job')

const GATE = "vars.DURABLERUN_WEEK_ENABLED == 'true'"
const GUARD = 'Require the pinned dedicated database'
const ENQUEUE = 'Enqueue the digest of this hour under its key'
const DAILY = 'Sample the queue, then purge until nothing more stands'

/** Whether a step, or a job's own environment, is handed a secret. */
const holdsASecret = (value: unknown): boolean => JSON.stringify(value ?? {}).includes('secrets.')

const stepNamed = (name: string): Step => {
  const step = job.steps.find((one) => one.name === name)
  if (step === undefined) throw new Error(`the job has no step named ${name}`)
  return step
}

/**
 * A stand-in for `pnpm` on the PATH of a step: it records its arguments, prints a report
 * for the command, and exits as the test says. Its `purge` says more remain for the first
 * STUB_MORE runs.
 */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const log = process.env.STUB_LOG
const sent = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean) : []
fs.appendFileSync(log, JSON.stringify(argv) + '\\n')
const verb = argv[2]
const purges = sent.filter((line) => JSON.parse(line)[2] === 'purge').length
process.stdout.write(JSON.stringify({ command: verb, more: verb === 'purge' && purges < Number(process.env.STUB_MORE ?? 0), secret: 'a-report-line' }) + '\\n')
process.stderr.write('a-line-on-stderr\\n')
process.exit(verb === process.env.STUB_FAIL ? 6 : 0)
`

interface StepRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** The command lines the step sent, each as the arguments after \`pnpm --silent cli\`. */
  readonly sent: string[][]
  /** The files the step left, by name. */
  readonly files: Record<string, string>
}

/** Run a step's script under bash, with the stand-in first on the PATH, in a directory of its own. */
function runStep(step: Step, env: Readonly<Record<string, string>>): StepRun {
  const dir = mkdtempSync(join(tmpdir(), 'durablerun-operable-week-'))
  try {
    const bin = join(dir, 'bin')
    const work = join(dir, 'work')
    spawnSync('mkdir', ['-p', bin, work])
    writeFileSync(join(bin, 'pnpm'), STUB)
    chmodSync(join(bin, 'pnpm'), 0o755)
    const log = join(dir, 'sent.log')
    const run = spawnSync('bash', ['-c', step.run ?? ''], {
      cwd: work,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_LOG: log, ...env },
    })
    const sent = (() => {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      } catch {
        return []
      }
    })()
    for (const argv of sent) expect(argv.slice(0, 2)).toEqual(['--silent', 'cli'])
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      sent: sent.map((argv) => argv.slice(2)),
      files: Object.fromEntries(
        readdirSync(work).map((name) => [name, readFileSync(join(work, name), 'utf8')]),
      ),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What the workflow hands its command steps, with a store URL that carries a path and a query. */
const STEP_ENV = {
  DURABLERUN_STORE_URL: 'libsql://week-database.example/path?mode=x',
  DURABLERUN_STORE_TOKEN: 'a-token',
  DURABLERUN_WEEK_QUEUE: 'digest',
  DURABLERUN_WEEK_REPOSITORY: 'example-owner/example-repository',
  DURABLERUN_WEEK_REF: 'main',
  DURABLERUN_WEEK_COMPLETED_AFTER: '7d',
  DURABLERUN_WEEK_CANCELLED_AFTER: '14d',
}

describe('the workflow of the operable week', () => {
  it('is off until its repository variable is set: its one job runs only under it, for a schedule and for a run by hand', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    // One job, whose whole condition is the variable: nothing beside it lets the job run.
    expect(
      jobs.map(([name, one]) => ({ name, condition: one.if })),
      'mutation-verdict:behavior:operable-week-workflow-is-off-until-enabled',
    ).toEqual([{ name: 'week', condition: GATE }])
    // Each schedule and each operation of a run by hand starts one of the two command
    // steps, and no step that sends a command runs without one.
    const commands = job.steps.filter((step) => step.run?.includes('pnpm --silent cli ') === true)
    expect(commands.map((step) => step.name)).toEqual([ENQUEUE, DAILY])
    const [hourly, daily] = workflow.on.schedule.map((entry) => entry.cron)
    expect(workflow.on.schedule.length).toBe(2)
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual(['enqueue', 'daily'])
    expect(commands.map((step) => step.if)).toEqual([
      `github.event.schedule == '${hourly}' || inputs.operation == 'enqueue'`,
      `github.event.schedule == '${daily}' || inputs.operation == 'daily'`,
    ])
    // The workflow's token can do nothing, and the job asks for no more.
    expect(workflow.permissions).toEqual({})
    expect(job.permissions).toBeUndefined()
  })

  it('requires the pinned database before any step holds the credential, and no action and no job environment holds it', () => {
    expect(holdsASecret(workflow.env)).toBe(false)
    expect(holdsASecret(job.env)).toBe(false)
    const guard = job.steps.findIndex((step) => step.name === GUARD)
    expect({
      guard: guard >= 0,
      firstWithTheCredential: job.steps.findIndex(holdsASecret),
    }).toEqual({ guard: true, firstWithTheCredential: guard })
    for (const step of job.steps.filter((one) => one.uses !== undefined)) {
      expect(holdsASecret(step)).toBe(false)
    }
    const step = stepNamed(GUARD)
    // The guard runs whichever command step follows it.
    expect(step.if).toBeUndefined()
    expect(step.env).toEqual({
      DURABLERUN_STORE_URL: '${{ secrets.DURABLERUN_WEEK_STORE_URL }}',
      DURABLERUN_STORE_TOKEN: '${{ secrets.DURABLERUN_WEEK_STORE_TOKEN }}',
      DURABLERUN_WEEK_EXPECTED_STORE_URL: '${{ vars.DURABLERUN_WEEK_STORE_URL }}',
    })
    const gate = (env: Record<string, string>): number | null =>
      spawnSync('bash', ['-c', step.run ?? ''], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      }).status
    const url = 'libsql://week-database.example'
    const held = { DURABLERUN_STORE_URL: url, DURABLERUN_STORE_TOKEN: 'a-token' }
    expect(
      {
        exact: gate({ ...held, DURABLERUN_WEEK_EXPECTED_STORE_URL: url }),
        another: gate({
          ...held,
          DURABLERUN_WEEK_EXPECTED_STORE_URL: 'libsql://another-database.example',
        }),
        noPin: gate(held),
        noUrl: gate({ DURABLERUN_STORE_TOKEN: 'a-token', DURABLERUN_WEEK_EXPECTED_STORE_URL: url }),
        noToken: gate({ DURABLERUN_STORE_URL: url, DURABLERUN_WEEK_EXPECTED_STORE_URL: url }),
        notRemote: gate({
          DURABLERUN_STORE_URL: 'file:local.db',
          DURABLERUN_STORE_TOKEN: 'a-token',
          DURABLERUN_WEEK_EXPECTED_STORE_URL: 'file:local.db',
        }),
      },
      'mutation-verdict:behavior:operable-week-workflow-requires-the-pinned-database',
    ).toEqual({ exact: 0, another: 1, noPin: 1, noUrl: 1, noToken: 1, notRemote: 1 })
  }, 60_000)

  it('enqueues the digest of the hour under its key, as the verb takes it, with its report in a file', () => {
    const before = digestKey(digestPeriod(Date.now()))
    const run = runStep(stepNamed(ENQUEUE), STEP_ENV)
    const after = digestKey(digestPeriod(Date.now()))
    expect({ status: run.status, log: run.stdout, stderr: run.stderr }).toEqual({
      status: 0,
      log: 'enqueue exited 0\n',
      stderr: '',
    })
    expect(run.sent.length).toBe(1)
    const invocation = parseInvocation(run.sent[0] ?? [])
    expect(
      {
        verb: invocation.spec.verb,
        taskName: invocation.args.taskName,
        key: [before, after].includes(invocation.strings.key ?? ''),
        params: JSON.parse(invocation.strings.params ?? 'null'),
        queue: invocation.strings.queue,
        target: invocation.strings.target,
        json: invocation.booleans.json,
        reveal: invocation.booleans.reveal,
      },
      'mutation-verdict:behavior:operable-week-workflow-enqueues-under-the-periods-key',
    ).toEqual({
      verb: 'enqueue',
      taskName: 'periodic-digest',
      key: true,
      params: { repository: 'example-owner/example-repository', ref: 'main' },
      queue: 'digest',
      // What \`--target\` names for a libSQL server: the URL's host, without its path or query.
      target: 'week-database.example',
      json: true,
      reveal: false,
    })
    // The report and what the command wrote on stderr are files, and neither is in the log.
    const names = Object.keys(run.files).sort()
    expect(names.length).toBe(2)
    expect(
      names.every((name) => /^week-enqueue-\d{4}-\d{2}-\d{2}T\d{2}\.(json|err)$/.test(name)),
    ).toBe(true)
    expect(Object.values(run.files).join('')).toContain('a-report-line')
    // A failed command fails the step with the command's exit.
    const failed = runStep(stepNamed(ENQUEUE), { ...STEP_ENV, STUB_FAIL: 'enqueue' })
    expect({ status: failed.status, log: failed.stdout }).toEqual({
      status: 6,
      log: 'enqueue exited 6\n',
    })
  }, 60_000)

  it('samples the queue and then purges with --execute until the verb says no more remain, as the verbs take them', () => {
    const step = stepNamed(DAILY)
    const run = runStep(step, { ...STEP_ENV, STUB_MORE: '2' })
    const sent = run.sent.map((argv) => parseInvocation(argv))
    // The verb said more remain twice, so the same command ran three times.
    expect(
      sent.map((invocation) => invocation.spec.verb),
      'mutation-verdict:behavior:operable-week-workflow-purges-until-no-more-remain',
    ).toEqual(['stats', 'sizes', 'purge', 'purge', 'purge'])
    expect({ status: run.status, log: run.stdout, stderr: run.stderr }).toEqual({
      status: 0,
      log: 'stats exited 0\nsizes exited 0\npurge run 1 exited 0\npurge run 2 exited 0\npurge run 3 exited 0\n',
      stderr: '',
    })
    for (const invocation of sent) {
      expect({ queue: invocation.strings.queue, json: invocation.booleans.json }).toEqual({
        queue: 'digest',
        json: true,
      })
      expect(invocation.booleans.reveal).toBe(false)
    }
    for (const purge of sent.slice(2)) {
      expect({ strings: purge.strings, execute: purge.booleans.execute }).toEqual({
        strings: {
          queue: 'digest',
          target: 'week-database.example',
          'completed-after': '7d',
          'cancelled-after': '14d',
        },
        execute: true,
      })
    }
    expect(Object.keys(run.files).length).toBe(10)
    expect(
      Object.keys(run.files)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/^week-\d{4}-\d{2}-\d{2}T\d{4}-/, ''))
        .sort(),
    ).toEqual(['purge-1.json', 'purge-2.json', 'purge-3.json', 'sizes.json', 'stats.json'])

    // A purge the store fails stops the job with the purge's exit, after that one run.
    const failed = runStep(step, { ...STEP_ENV, STUB_MORE: '2', STUB_FAIL: 'purge' })
    expect({
      status: failed.status,
      verbs: failed.sent.map((argv) => argv[0]),
    }).toEqual({ status: 6, verbs: ['stats', 'sizes', 'purge'] })
    // A sample that fails stops it before any purge.
    const noSample = runStep(step, { ...STEP_ENV, STUB_FAIL: 'sizes' })
    expect({
      status: noSample.status,
      verbs: noSample.sent.map((argv) => argv[0]),
    }).toEqual({ status: 6, verbs: ['stats', 'sizes'] })
    // With a window not set, nothing is sent.
    const { DURABLERUN_WEEK_CANCELLED_AFTER: _unset, ...noWindow } = STEP_ENV
    const refused = runStep(step, noWindow)
    expect({ status: refused.status, sent: refused.sent }).toEqual({ status: 1, sent: [] })
    // A purge that never says no more remain ends after fifty runs, and fails the job.
    const endless = runStep(step, { ...STEP_ENV, STUB_MORE: '1000' })
    expect({
      status: endless.status,
      purges: endless.sent.filter((argv) => argv[0] === 'purge').length,
    }).toEqual({ status: 1, purges: 50 })
  }, 300_000)

  it("sends every command's report to a file, keeps the files as the job's artifact whatever the job does, and prints no report", () => {
    const lines = job.steps
      .flatMap((step) => (step.run ?? '').split('\n'))
      .filter((line) => line.includes('pnpm --silent cli '))
    expect(lines.length).toBe(4)
    for (const line of lines) {
      expect({ line, toFiles: / > "[^"]+" 2> "[^"]+" \|\| code=\$\?$/.test(line) }).toEqual({
        line,
        toFiles: true,
      })
    }
    for (const step of job.steps) {
      expect(/\btee\b|--reveal|\bcat\b/.test(step.run ?? '')).toBe(false)
    }
    const last = job.steps.at(-1)
    expect({ uses: last?.uses, when: last?.if, path: last?.with?.path }).toEqual({
      uses: 'actions/upload-artifact@v4',
      when: 'always()',
      path: 'week-*',
    })
  })
})
