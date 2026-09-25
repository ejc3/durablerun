/**
 * The alpha.1 compatibility harness, run by scripts/alpha1-compat.sh after it installs the
 * release assets of v0.1.0-alpha.1 into a consumer directory and checks their sha256.
 *
 * The deployed alpha runs alpha.1's host code on a libSQL database that alpha.1's own
 * migrate() took to version 5. The CLI migrates that database. Whether alpha.1 keeps working
 * on it afterwards is decided here, at every version the CLI can leave it at: the build's
 * version, which `migrate --yes` reaches through the bin, and each version between, which
 * the same command leaves when its store fails at the next version's batch (on libSQL each
 * version is its own batch). At each version alpha.1 first runs a cycle on version 5, as
 * the deployed alpha has, then the CLI migrates, then alpha.1 runs a spawn, claim, activate,
 * complete, await, emit, claim and complete cycle, and the CLI's `result` must read every
 * task alpha.1 wrote exactly as alpha.1's own getTaskResult reads it.
 *
 * A control shows the harness can fail: a planted migration that adds a column with no
 * default that may not be NULL, in the form version 10 gives NOT NULL on libSQL (a trigger
 * that refuses the write), must make alpha.1's cycle fail at its spawn.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CURRENT_SCHEMA_VERSION, LibsqlExecutor } from '@durablerun/store-libsql'
import { faulting, openerWrapping, runCli } from './support.js'

interface Alpha1Result {
  state: string
  completedPayloadJson?: string
  failureReasonJson?: string
}
interface Alpha1Claimed {
  runId: string
  taskId: string
  claimToken: string
  claimGen: number
  wake?: { event: string; step: string; payloadJson?: string }
}
interface Alpha1Executor {
  close(): void
}
interface Alpha1Store {
  spawn(queue: string, name: string, params: string, opts?: object): Promise<{ taskId: string }>
  claim(
    queue: string,
    token: string,
    opts: { leaseSeconds: number; limit: number },
  ): Promise<Alpha1Claimed[]>
  activate(queue: string, runId: string, token: string, gen: number): Promise<unknown>
  complete(queue: string, runId: string, token: string, result: string): Promise<void>
  fail(queue: string, runId: string, token: string, failure: string, retry: null): Promise<void>
  awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    token: string,
    step: string,
    event: string,
    timeout: number | null,
  ): Promise<{ emitted: boolean }>
  emitEvent(queue: string, event: string, payload: string): Promise<void>
  getTaskResult(queue: string, taskId: string): Promise<Alpha1Result | null>
}
interface Alpha1 {
  open(file: string): { executor: Alpha1Executor; store: Alpha1Store; migrate(): Promise<void> }
}

const QUEUE = 'alpha1'
const ROOT = new URL('../../..', import.meta.url)

async function loadAlpha1(consumer: string): Promise<Alpha1> {
  const from = (path: string) => pathToFileURL(join(consumer, 'node_modules', path)).href
  const core = (await import(from('@durablerun/core/dist/index.js'))) as {
    systemIdSource(): object
  }
  const store = (await import(from('@durablerun/store-libsql/dist/index.js'))) as {
    LibsqlExecutor: { open(url: string): Alpha1Executor }
    LibsqlSchedulerStore: new (db: Alpha1Executor, ids: object) => Alpha1Store
    LibsqlStoreAdmin: new (db: Alpha1Executor) => { migrate(): Promise<void> }
  }
  return {
    open(file) {
      const executor = store.LibsqlExecutor.open(`file:${file}`)
      const admin = new store.LibsqlStoreAdmin(executor)
      return {
        executor,
        store: new store.LibsqlSchedulerStore(executor, core.systemIdSource()),
        migrate: () => admin.migrate(),
      }
    },
  }
}

class CycleFailure extends Error {}

/** Run one step of alpha.1's cycle, naming the step when it fails. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new CycleFailure(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** alpha.1's cycle: one task completes, and one awaits an event, is woken, and completes. */
async function cycle(alpha1: Alpha1, file: string, round: string): Promise<string[]> {
  const { executor, store } = alpha1.open(file)
  try {
    const plain = await step('spawn', () =>
      store.spawn(QUEUE, 'plain', JSON.stringify({ round }), { idempotencyKey: `${round}-plain` }),
    )
    const waiting = await step('spawn', () => store.spawn(QUEUE, 'waiting', '{}'))
    const failing = await step('spawn', () =>
      store.spawn(QUEUE, 'failing', '{}', { maxAttempts: 1 }),
    )
    const claimed = await step('claim', () =>
      store.claim(QUEUE, `${round}-worker`, { leaseSeconds: 60, limit: 10 }),
    )
    for (const run of claimed) {
      await step('activate', () => store.activate(QUEUE, run.runId, run.claimToken, run.claimGen))
      if (run.taskId === plain.taskId) {
        await step('complete', () =>
          store.complete(QUEUE, run.runId, run.claimToken, JSON.stringify({ done: round })),
        )
      } else if (run.taskId === failing.taskId) {
        await step('fail', () =>
          store.fail(QUEUE, run.runId, run.claimToken, JSON.stringify({ why: round }), null),
        )
      } else if (run.taskId === waiting.taskId) {
        const awaited = await step('await', () =>
          store.awaitEvent(
            QUEUE,
            run.taskId,
            run.runId,
            run.claimToken,
            'wait',
            `${round}-go`,
            null,
          ),
        )
        if (awaited.emitted)
          throw new CycleFailure('await: the event was emitted before it was sent')
      }
    }
    await step('emit', () => store.emitEvent(QUEUE, `${round}-go`, JSON.stringify({ go: round })))
    const woken = await step('claim', () =>
      store.claim(QUEUE, `${round}-worker-2`, { leaseSeconds: 60, limit: 10 }),
    )
    const wake = woken.find((run) => run.taskId === waiting.taskId)
    if (wake?.wake?.payloadJson !== JSON.stringify({ go: round })) {
      throw new CycleFailure(`claim: the woken run carried ${JSON.stringify(wake?.wake)}`)
    }
    await step('activate', () => store.activate(QUEUE, wake.runId, wake.claimToken, wake.claimGen))
    await step('complete', () =>
      store.complete(QUEUE, wake.runId, wake.claimToken, wake.wake?.payloadJson ?? ''),
    )
    return [plain.taskId, waiting.taskId, failing.taskId]
  } finally {
    executor.close()
  }
}

/** What the CLI's `result --json --reveal` says of a task, as alpha.1's TaskResult. */
async function cliResult(file: string, taskId: string): Promise<Alpha1Result> {
  const run = await runCli(['result', taskId, '--queue', QUEUE, '--json', '--reveal'], {
    DURABLERUN_STORE_URL: `file:${file}`,
  })
  if (run.exit !== 0) throw new Error(`result ${taskId} exited ${run.exit}: ${run.stdout}`)
  const view = JSON.parse(run.stdout) as {
    state: string
    completedPayload?: { text: string }
    failureReason?: { text?: string; engine?: string }
  }
  const result: Alpha1Result = { state: view.state }
  if (view.completedPayload !== undefined) result.completedPayloadJson = view.completedPayload.text
  if (view.failureReason?.text !== undefined) result.failureReasonJson = view.failureReason.text
  return result
}

/** Take the file to `version` the way the CLI's migrate leaves it. */
async function cliMigrate(file: string, version: number): Promise<void> {
  if (version === CURRENT_SCHEMA_VERSION) {
    const bin = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/bin/durablerun.ts', 'migrate', '--yes', '--target', file],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? '', DURABLERUN_STORE_URL: `file:${file}` },
        encoding: 'utf8',
      },
    )
    if (bin.status !== 0) throw new Error(`migrate --yes exited ${bin.status}: ${bin.stderr}`)
    return
  }
  // The same command, meeting an outage at the next version's batch.
  const run = await runCli(
    ['migrate', '--yes', '--target', file],
    { DURABLERUN_STORE_URL: `file:${file}` },
    openerWrapping((real) =>
      faulting(real, { label: `migrate:v${version + 1}`, occurrence: 1 }, 'unavailable-before'),
    ),
  )
  if (run.exit !== 6)
    throw new Error(`migrate stopped before version ${version + 1} exited ${run.exit}`)
}

async function recordedVersion(file: string): Promise<number> {
  const run = await runCli(['doctor', '--queue', QUEUE, '--json'], {
    DURABLERUN_STORE_URL: `file:${file}`,
  })
  return (JSON.parse(run.stdout) as { recordedSchemaVersion: number }).recordedSchemaVersion
}

/** Every step at one version. A failure names the version and alpha.1's step. */
async function atVersion(alpha1: Alpha1, dir: string, version: number, plant: boolean) {
  const file = join(dir, `v${version}${plant ? '-planted' : ''}.sqlite`)
  const first = alpha1.open(file)
  try {
    await first.migrate()
  } finally {
    first.executor.close()
  }
  const written = await cycle(alpha1, file, 'deployed')
  await cliMigrate(file, version)
  const found = await recordedVersion(file)
  if (found !== version) throw new Error(`the CLI left version ${found}, not ${version}`)
  if (plant) {
    const db = LibsqlExecutor.open(`file:${file}`)
    try {
      await db.batch('control:planted-not-null', [
        { sql: 'ALTER TABLE tasks ADD COLUMN planted TEXT', args: [] },
        {
          sql: `CREATE TRIGGER tasks_planted_not_null BEFORE INSERT ON tasks
                WHEN NEW.planted IS NULL
                BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: tasks.planted'); END`,
          args: [],
        },
      ])
    } finally {
      db.close()
    }
  }
  try {
    written.push(...(await cycle(alpha1, file, `v${version}`)))
  } catch (error) {
    if (error instanceof CycleFailure) {
      throw new CycleFailure(`the alpha.1 cycle at version ${version} failed at ${error.message}`)
    }
    throw error
  }
  const { executor, store } = alpha1.open(file)
  try {
    for (const taskId of written) {
      const theirs = await store.getTaskResult(QUEUE, taskId)
      const ours = await cliResult(file, taskId)
      if (JSON.stringify(theirs) !== JSON.stringify(ours)) {
        throw new Error(
          `at version ${version} result read ${taskId} as ${JSON.stringify(ours)}, and alpha.1 reads ${JSON.stringify(theirs)}`,
        )
      }
    }
  } finally {
    executor.close()
  }
  return written.length
}

const consumer = process.argv[2]
if (consumer === undefined) throw new Error('usage: alpha1-compat.ts <consumer directory>')
const alpha1 = await loadAlpha1(consumer)
const dir = mkdtempSync(join(tmpdir(), 'durablerun-alpha1-'))
try {
  const versions: number[] = []
  let tasks = 0
  for (let version = 5; version <= CURRENT_SCHEMA_VERSION; version++) {
    tasks += await atVersion(alpha1, dir, version, false)
    versions.push(version)
  }
  const control = await atVersion(alpha1, dir, CURRENT_SCHEMA_VERSION, true).then(
    () => 'passed',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  const expected = `the alpha.1 cycle at version ${CURRENT_SCHEMA_VERSION} failed at spawn: `
  if (!control.startsWith(expected) || !control.includes('tasks.planted')) {
    throw new Error(`the planted NOT NULL control must fail at alpha.1's spawn, and it ${control}`)
  }
  console.log(
    `alpha1-compat: alpha.1 ran its cycle at versions ${versions.join(', ')}, and result read all ${tasks} tasks it wrote as its getTaskResult does; the planted NOT NULL control failed at spawn`,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
