import {
  type AwaitedEventFacts,
  type CorruptInteger,
  DEFAULT_MAX_ATTEMPTS,
  INFRA_BACKOFF_SECONDS,
  InvalidDurableStringError,
  OPERATOR_READ_METHODS,
  OPERATOR_READ_STRINGS,
  PERSISTED_INTEGER_BOUNDS,
  REASON_CANCELLED,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  type RunFacts,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  type SpawnOptions,
  type SqlExecutor,
  type SqlResult,
  type TaskFacts,
  type TaskOutcomeFacts,
  type TaskRowFacts,
  type WaitFacts,
  childSpawnKey,
  taskDoneEventName,
} from '@durablerun/core'
import { RecordingExecutor } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import {
  type StorageCorruption,
  type StoreFixture,
  type StoreFixtureFactory,
  corruptionTarget,
  executeStorageCorruption,
} from './fixture.js'
import { snapshot } from './poison-matrix.js'
import {
  awaitOwned,
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  readOne,
  withFixture,
} from './scenario.js'

/**
 * The operator's reads (`OperatorReads`, DESIGN.md §3.11) on one dialect. Core holds the
 * one implementation, and a store reaches it through the factory its package exports, so
 * what is held here is what a dialect can still get wrong: the rows its statements answer
 * with, the kind of value its driver hands back for a count or an instant, and what its
 * schema lets a column hold.
 *
 * Every seeded state is built by driving the engine under the test clock, and its expected
 * answer is written out from what the scenario did, with no value read back from the
 * database. The same expected answer is compared on every dialect, so the dialects agree
 * with each other because each agrees with it. A state no engine path reaches is built
 * with raw fixture SQL, and its name says so.
 */

const Q = 'q'
const START = 1_000_000
const CAUSE = '{"name":"ForwardBoom"}'
const ROLLBACK_BOOM = '{"name":"RollbackBoom"}'

interface Seeded {
  readonly taskId: string
  readonly expected: TaskFacts
}

/** A fixture and its test clock, which starts at `START`. */
interface World {
  readonly f: StoreFixture
  at(ms: number): Promise<void>
}

async function spawn(f: StoreFixture, taskName: string, options?: SpawnOptions) {
  const spawned = await f.store.spawn(Q, taskName, '{}', options)
  if (!spawned.created || spawned.runId === null) throw new Error(`${taskName} was not created`)
  return { taskId: spawned.taskId, runId: spawned.runId }
}

const taskOf = (taskId: string, over: Partial<TaskRowFacts> = {}): TaskRowFacts => ({
  taskId,
  queue: Q,
  taskName: 'job',
  state: 'pending',
  attempts: 0,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  infraRetries: 0,
  enqueueAtMs: START,
  firstStartedAtMs: null,
  cancelAtMs: null,
  idempotencyKey: null,
  parentTaskId: null,
  sagaBegan: false,
  ...over,
})

const runOf = (runId: string, over: Partial<RunFacts> = {}): RunFacts => ({
  runId,
  queue: Q,
  state: 'pending',
  attempt: 1,
  claimGen: 0,
  activatedGen: 0,
  relaunchCount: 0,
  claimExpiresAtMs: null,
  heartbeatAtMs: null,
  availableAtMs: START,
  wakeEvent: null,
  wakeStep: null,
  startedAtMs: null,
  completedAtMs: null,
  failedAtMs: null,
  ...over,
})

/** A run that was claimed once and activated at `START`, which is where most seeds begin. */
const startedRun = (runId: string, over: Partial<RunFacts> = {}): RunFacts =>
  runOf(runId, { claimGen: 1, activatedGen: 1, startedAtMs: START, ...over })

const answer = (
  nowMs: number,
  task: TaskRowFacts,
  runs: RunFacts[],
  more: { outcome?: TaskOutcomeFacts; waits?: WaitFacts[]; events?: AwaitedEventFacts[] } = {},
): TaskFacts => ({
  nowMs,
  fakeClock: true,
  task,
  // A live task has no outcome but its state.
  outcome: more.outcome ?? { result: { state: task.state as 'pending' } },
  runs,
  waits: more.waits ?? [],
  events: more.events ?? [],
  corrupt: [],
})

/** A run parked on an event, and the wait it registered, as both seeds of an await need them. */
async function parkedOn(
  { f, at }: World,
  timeoutSeconds: number | null,
): Promise<{ taskId: string; runId: string; stepName: string; eventName: string }> {
  const task = await spawn(f, 'job')
  const run = await claimActivated(f.store, Q, 'w1')
  await at(START + 1_000)
  expect(await awaitOwned(f.store, Q, run, 'approve', 'approval', timeoutSeconds)).toEqual({
    emitted: false,
  })
  return { taskId: task.taskId, runId: run.runId, stepName: 'approve', eventName: 'approval' }
}

/** A task whose one registered step started and whose failure began its saga, with its first pass. */
async function rollingBack({ f, at }: World) {
  const task = await spawn(f, 'saga', { maxAttempts: 1 })
  const forward = await claimActivated(f.store, Q, 'w-forward')
  await checkpointOwned(f.store, Q, forward, `${SAGA_STARTED_PREFIX}a`, '1', 60)
  await at(START + 1_000)
  expect(await f.store.fail(Q, forward.runId, forward.claimToken, CAUSE, null)).toEqual({
    rollingBack: true,
  })
  const pass = await claimActivated(f.store, Q, 'w-pass')
  return { task, forward, pass }
}

/** What a saga's two runs read as once the pass that ended it failed at `endedAt`. */
const sagaRuns = (forwardId: string, passId: string, endedAt: number): RunFacts[] => [
  startedRun(forwardId, { state: 'failed', heartbeatAtMs: START, failedAtMs: START + 1_000 }),
  runOf(passId, {
    state: 'failed',
    attempt: 2,
    claimGen: 1,
    activatedGen: 1,
    availableAtMs: START + 1_000,
    heartbeatAtMs: START + 1_000,
    startedAtMs: START + 1_000,
    failedAtMs: endedAt,
  }),
]

/** A parent parked on its child, which is pending. */
async function parentAndChild({ f, at }: World) {
  const parent = await spawn(f, 'parent')
  const parentRun = await claimActivated(f.store, Q, 'w-parent')
  const child = await f.store.spawn(Q, 'child', '{}', {
    childOf: {
      parentQueue: Q,
      parentTaskId: parent.taskId,
      runId: parentRun.runId,
      claimToken: parentRun.claimToken,
      replayKey: 'site:1',
    },
  })
  if (child.runId === null) throw new Error('the child was not created')
  await at(START + 1_000)
  expect(await awaitTaskOwned(f.store, Q, parentRun, 'await-child', child.taskId, null)).toEqual({
    emitted: false,
  })
  return { parent, parentRun, child: { taskId: child.taskId, runId: child.runId } }
}

const SEEDS: readonly { readonly name: string; build(world: World): Promise<Seeded> }[] = [
  {
    name: 'a delayed task under a caller key and a start deadline',
    build: async ({ f }) => {
      const task = await spawn(f, 'job', {
        idempotencyKey: 'order-7',
        startDelaySeconds: 3600,
        maxAttempts: 3,
        cancellation: { maxDelaySeconds: 60 },
      })
      const due = START + 3_600_000
      return {
        taskId: task.taskId,
        expected: answer(
          START,
          taskOf(task.taskId, {
            maxAttempts: 3,
            enqueueAtMs: due,
            cancelAtMs: due + 60_000,
            idempotencyKey: 'order-7',
          }),
          [runOf(task.runId, { availableAtMs: due })],
        ),
      }
    },
  },
  {
    name: 'a claimed run that no worker has activated',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      await at(START + 1_000)
      await claimOne(f.store, Q, 'w1', 60)
      return {
        taskId: task.taskId,
        expected: answer(START + 1_000, taskOf(task.taskId, { state: 'running' }), [
          runOf(task.runId, {
            state: 'running',
            claimGen: 1,
            claimExpiresAtMs: START + 61_000,
            heartbeatAtMs: START + 1_000,
          }),
        ]),
      }
    },
  },
  {
    name: 'a running task under a lease its worker extended',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      await at(START + 1_000)
      const run = await claimOne(f.store, Q, 'w1', 60)
      await at(START + 2_000)
      await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
      await at(START + 5_000)
      expect((await f.store.heartbeat(Q, run.runId, run.claimToken, 30)).held).toBe(true)
      return {
        taskId: task.taskId,
        expected: answer(
          START + 5_000,
          taskOf(task.taskId, { state: 'running', firstStartedAtMs: START + 2_000 }),
          [
            runOf(task.runId, {
              state: 'running',
              claimGen: 1,
              activatedGen: 1,
              claimExpiresAtMs: START + 35_000,
              heartbeatAtMs: START + 5_000,
              startedAtMs: START + 2_000,
            }),
          ],
        ),
      }
    },
  },
  {
    name: 'a task sleeping on a timer',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      const run = await claimActivated(f.store, Q, 'w1')
      await at(START + 1_000)
      await f.store.reschedule(Q, run.runId, run.claimToken, { inSeconds: 120 })
      return {
        taskId: task.taskId,
        expected: answer(
          START + 1_000,
          taskOf(task.taskId, { state: 'sleeping', firstStartedAtMs: START }),
          [startedRun(task.runId, { state: 'sleeping', availableAtMs: START + 121_000 })],
        ),
      }
    },
  },
  {
    name: 'a task awaiting an event under a timeout',
    build: async (world) => {
      const parked = await parkedOn(world, 300)
      return {
        taskId: parked.taskId,
        expected: answer(
          START + 1_000,
          taskOf(parked.taskId, { state: 'sleeping', firstStartedAtMs: START }),
          [
            startedRun(parked.runId, {
              state: 'sleeping',
              availableAtMs: START + 301_000,
              wakeEvent: 'approval',
              wakeStep: 'approve',
            }),
          ],
          {
            waits: [
              {
                runId: parked.runId,
                stepName: 'approve',
                eventName: 'approval',
                status: 'waiting',
                timeoutAtMs: START + 301_000,
                createdAtMs: START + 1_000,
              },
            ],
            events: [{ eventName: 'approval', exists: false, emittedAtMs: null }],
          },
        ),
      }
    },
  },
  {
    name: 'a task awaiting an event with no timeout',
    build: async (world) => {
      const parked = await parkedOn(world, null)
      return {
        taskId: parked.taskId,
        expected: answer(
          START + 1_000,
          taskOf(parked.taskId, { state: 'sleeping', firstStartedAtMs: START }),
          [
            startedRun(parked.runId, {
              state: 'sleeping',
              availableAtMs: null,
              wakeEvent: 'approval',
              wakeStep: 'approve',
            }),
          ],
          {
            waits: [
              {
                runId: parked.runId,
                stepName: 'approve',
                eventName: 'approval',
                status: 'waiting',
                timeoutAtMs: null,
                createdAtMs: START + 1_000,
              },
            ],
            events: [{ eventName: 'approval', exists: false, emittedAtMs: null }],
          },
        ),
      }
    },
  },
  {
    name: 'a task an emitted event woke, which no worker has claimed',
    build: async (world) => {
      const parked = await parkedOn(world, null)
      await world.at(START + 2_000)
      await world.f.store.emitEvent(Q, 'approval', '{"approved":true}')
      return {
        taskId: parked.taskId,
        expected: answer(
          START + 2_000,
          taskOf(parked.taskId, { firstStartedAtMs: START }),
          [
            startedRun(parked.runId, {
              availableAtMs: START + 2_000,
              wakeEvent: 'approval',
              wakeStep: 'approve',
            }),
          ],
          // The emit consumed the wait, and the run still names the event that woke it.
          { events: [{ eventName: 'approval', exists: true, emittedAtMs: START + 2_000 }] },
        ),
      }
    },
  },
  {
    name: 'a completed task',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      const run = await claimActivated(f.store, Q, 'w1')
      await at(START + 3_000)
      await f.store.complete(Q, run.runId, run.claimToken, '{"answer":42}')
      return {
        taskId: task.taskId,
        expected: answer(
          START + 3_000,
          taskOf(task.taskId, { state: 'completed', firstStartedAtMs: START }),
          [
            startedRun(task.runId, {
              state: 'completed',
              heartbeatAtMs: START,
              completedAtMs: START + 3_000,
            }),
          ],
          { outcome: { result: { state: 'completed', completedPayloadJson: '{"answer":42}' } } },
        ),
      }
    },
  },
  {
    name: 'a task that failed for good on its second attempt',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job', { maxAttempts: 2 })
      const first = await claimActivated(f.store, Q, 'w1')
      await at(START + 1_000)
      await f.store.fail(Q, first.runId, first.claimToken, '{"name":"Flaky"}', { delaySeconds: 30 })
      await at(START + 31_000)
      const second = await claimActivated(f.store, Q, 'w2')
      await at(START + 32_000)
      await f.store.fail(Q, second.runId, second.claimToken, '{"name":"Broken"}', null)
      return {
        taskId: task.taskId,
        expected: answer(
          START + 32_000,
          taskOf(task.taskId, {
            state: 'failed',
            attempts: 2,
            maxAttempts: 2,
            firstStartedAtMs: START,
          }),
          [
            startedRun(first.runId, {
              state: 'failed',
              heartbeatAtMs: START,
              failedAtMs: START + 1_000,
            }),
            runOf(second.runId, {
              state: 'failed',
              attempt: 2,
              claimGen: 1,
              activatedGen: 1,
              availableAtMs: START + 31_000,
              heartbeatAtMs: START + 31_000,
              startedAtMs: START + 31_000,
              failedAtMs: START + 32_000,
            }),
          ],
          { outcome: { result: { state: 'failed', failureReasonJson: '{"name":"Broken"}' } } },
        ),
      }
    },
  },
  {
    name: 'a task cancelled before it started',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      await at(START + 1_000)
      expect(await f.store.cancelTask(Q, task.taskId)).toBe(true)
      return {
        taskId: task.taskId,
        expected: answer(
          START + 1_000,
          taskOf(task.taskId, { state: 'cancelled' }),
          [runOf(task.runId, { state: 'cancelled' })],
          { outcome: { result: { state: 'cancelled', failureReasonJson: REASON_CANCELLED } } },
        ),
      }
    },
  },
  {
    name: 'a saga whose rollback ran',
    build: async (world) => {
      const { f, at } = world
      const { task, forward, pass } = await rollingBack(world)
      await checkpointOwned(f.store, Q, pass, `${SAGA_ROLLBACK_PREFIX}a`, 'null', 60)
      await at(START + 2_000)
      await f.store.fail(Q, pass.runId, pass.claimToken, CAUSE, null)
      return {
        taskId: task.taskId,
        expected: answer(
          START + 2_000,
          taskOf(task.taskId, {
            taskName: 'saga',
            state: 'failed',
            // The pass is one ordinal past the budget, and the pass that ends the task
            // charges its own ordinal, as any failing run does.
            attempts: 2,
            maxAttempts: 2,
            firstStartedAtMs: START,
            sagaBegan: true,
          }),
          sagaRuns(forward.runId, pass.runId, START + 2_000),
          {
            outcome: {
              result: {
                state: 'failed',
                failureReasonJson: CAUSE,
                rollback: { outcome: 'complete' },
              },
            },
          },
        ),
      }
    },
  },
  {
    name: 'a saga a failed rollback halted',
    build: async (world) => {
      const { f, at } = world
      const { task, forward, pass } = await rollingBack(world)
      await at(START + 2_000)
      await f.store.failRollback(Q, pass.runId, pass.claimToken, CAUSE, null, {
        stepKey: 'a',
        errorJson: ROLLBACK_BOOM,
      })
      return {
        taskId: task.taskId,
        expected: answer(
          START + 2_000,
          taskOf(task.taskId, {
            taskName: 'saga',
            state: 'failed',
            attempts: 2,
            maxAttempts: 2,
            firstStartedAtMs: START,
            sagaBegan: true,
          }),
          sagaRuns(forward.runId, pass.runId, START + 2_000),
          {
            outcome: {
              result: {
                state: 'failed',
                failureReasonJson: CAUSE,
                rollback: { outcome: 'failed', errorJson: ROLLBACK_BOOM },
              },
            },
          },
        ),
      }
    },
  },
  {
    name: 'a parent awaiting its child',
    build: async (world) => {
      const { parent, parentRun, child } = await parentAndChild(world)
      const done = taskDoneEventName(child.taskId)
      return {
        taskId: parent.taskId,
        expected: answer(
          START + 1_000,
          taskOf(parent.taskId, {
            taskName: 'parent',
            state: 'sleeping',
            firstStartedAtMs: START,
          }),
          [
            startedRun(parentRun.runId, {
              state: 'sleeping',
              availableAtMs: null,
              wakeEvent: done,
              wakeStep: 'await-child',
            }),
          ],
          {
            waits: [
              {
                runId: parentRun.runId,
                stepName: 'await-child',
                eventName: done,
                status: 'waiting',
                timeoutAtMs: null,
                createdAtMs: START + 1_000,
              },
            ],
            events: [{ eventName: done, exists: false, emittedAtMs: null }],
          },
        ),
      }
    },
  },
  {
    name: 'a child, whose key names its parent',
    build: async (world) => {
      const { parent, child } = await parentAndChild(world)
      return {
        taskId: child.taskId,
        expected: answer(
          START + 1_000,
          taskOf(child.taskId, {
            taskName: 'child',
            idempotencyKey: childSpawnKey(parent.taskId, 'site:1'),
            parentTaskId: parent.taskId,
          }),
          [runOf(child.runId)],
        ),
      }
    },
  },
  {
    name: "a parent its child's ending woke",
    build: async (world) => {
      const { f, at } = world
      const { parent, parentRun, child } = await parentAndChild(world)
      const childRun = await claimActivated(f.store, Q, 'w-child')
      expect(childRun.taskId).toBe(child.taskId)
      await at(START + 2_000)
      await f.store.complete(Q, childRun.runId, childRun.claimToken, '"done"')
      const done = taskDoneEventName(child.taskId)
      return {
        taskId: parent.taskId,
        expected: answer(
          START + 2_000,
          taskOf(parent.taskId, { taskName: 'parent', firstStartedAtMs: START }),
          [
            startedRun(parentRun.runId, {
              availableAtMs: START + 2_000,
              wakeEvent: done,
              wakeStep: 'await-child',
            }),
          ],
          { events: [{ eventName: done, exists: true, emittedAtMs: START + 2_000 }] },
        ),
      }
    },
  },
  {
    name: 'a launch that was lost, which the sweep reopened',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      await claimOne(f.store, Q, 'w1', 30)
      await at(START + 31_000)
      expect((await f.store.sweep(Q, 10)).map((swept) => swept.kind)).toEqual(['lost-launch'])
      return {
        taskId: task.taskId,
        expected: answer(START + 31_000, taskOf(task.taskId), [
          runOf(task.runId, {
            claimGen: 1,
            relaunchCount: 1,
            availableAtMs: START + 31_000 + RELAUNCH_BACKOFF_BASE_SECONDS * 1_000,
          }),
        ]),
      }
    },
  },
  {
    name: 'a worker that died, whose run the sweep retried',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      await claimActivated(f.store, Q, 'w1', 30)
      await at(START + 31_000)
      const [swept] = await f.store.sweep(Q, 10)
      if (swept?.kind !== 'claim-timeout') throw new Error('the sweep found no claim timeout')
      return {
        taskId: task.taskId,
        expected: answer(
          START + 31_000,
          taskOf(task.taskId, { infraRetries: 1, firstStartedAtMs: START }),
          [
            startedRun(task.runId, {
              state: 'failed',
              // The sweep fails the run for its expired lease and leaves the expiry it
              // read, where a worker's own failure clears it.
              claimExpiresAtMs: START + 30_000,
              heartbeatAtMs: START,
              failedAtMs: START + 31_000,
            }),
            runOf(swept.successorRunId, {
              attempt: 2,
              availableAtMs: START + 31_000 + INFRA_BACKOFF_SECONDS * 1_000,
            }),
          ],
        ),
      }
    },
  },
  {
    name: 'a completed row with no payload, built with fixture SQL, which the decoders refuse',
    build: async ({ f, at }) => {
      const task = await spawn(f, 'job')
      const run = await claimActivated(f.store, Q, 'w1')
      await at(START + 3_000)
      await f.store.complete(Q, run.runId, run.claimToken, '{"answer":42}')
      await f.raw.batch('fixture:contradiction', [
        { sql: 'UPDATE tasks SET completed_payload = NULL WHERE task_id = ?', args: [task.taskId] },
      ])
      return {
        taskId: task.taskId,
        expected: answer(
          START + 3_000,
          taskOf(task.taskId, { state: 'completed', firstStartedAtMs: START }),
          [
            startedRun(task.runId, {
              state: 'completed',
              heartbeatAtMs: START,
              completedAtMs: START + 3_000,
            }),
          ],
          {
            outcome: { refused: `task ${task.taskId} is completed but has no completed payload` },
          },
        ),
      }
    },
  },
]

/** Every count and instant an answer names, by the name of its member. */
const NUMBERS = new Set([
  'nowMs',
  'attempts',
  'maxAttempts',
  'infraRetries',
  'enqueueAtMs',
  'firstStartedAtMs',
  'cancelAtMs',
  'attempt',
  'claimGen',
  'activatedGen',
  'relaunchCount',
  'claimExpiresAtMs',
  'heartbeatAtMs',
  'availableAtMs',
  'startedAtMs',
  'completedAtMs',
  'failedAtMs',
  'timeoutAtMs',
  'createdAtMs',
  'emittedAtMs',
])

/** The counts and instants of an answer that are neither a JavaScript number nor null, and how many are numbers. */
function numbersOf(value: unknown, path = 'facts'): { wrong: string[]; numbers: number } {
  const found = { wrong: [] as string[], numbers: 0 }
  if (value === null || typeof value !== 'object') return found
  for (const [key, inner] of Object.entries(value)) {
    const at = `${path}.${key}`
    if (NUMBERS.has(key)) {
      if (typeof inner === 'number') found.numbers += 1
      else if (inner !== null) found.wrong.push(`${at} is a ${typeof inner}`)
      continue
    }
    const below = numbersOf(inner, at)
    found.wrong.push(...below.wrong)
    found.numbers += below.numbers
  }
  return found
}

/** The task's outcome as `getTaskResult` answers it, or the words it refuses the row with. */
const viaTheStore = (f: StoreFixture, taskId: string): Promise<unknown> =>
  f.store.getTaskResult(Q, taskId).then(
    (result) => ({ result }),
    (error: unknown) => ({ refused: error instanceof RangeError ? error.message : String(error) }),
  )

type Rows = { taskId: string; runId: string; stepName: string; eventName: string }

/** The seeds the generated cases plant a value in: a parked run with its wait, and a woken run with its event. */
const PLANTED_IN = {
  parked: (world: World) => parkedOn(world, 300),
  woken: async (world: World) => {
    const parked = await parkedOn(world, null)
    await world.at(START + 2_000)
    await world.f.store.emitEvent(Q, 'approval', '{}')
    return parked
  },
}

type Table = 'tasks' | 'runs' | 'waits' | 'events'
/** The four tables the reads select an integer from. They select none of `checkpoints` or `drivers`. */
const TABLES: readonly Table[] = ['tasks', 'runs', 'waits', 'events']

/** Where each persisted integer the reads consume stands in the answer. */
const READ_AS: Readonly<Record<string, readonly (string | number)[]>> = {
  'tasks.attempts': ['task', 'attempts'],
  'tasks.max_attempts': ['task', 'maxAttempts'],
  'tasks.infra_retries': ['task', 'infraRetries'],
  'tasks.enqueue_at_ms': ['task', 'enqueueAtMs'],
  'tasks.first_started_at_ms': ['task', 'firstStartedAtMs'],
  'tasks.cancel_at_ms': ['task', 'cancelAtMs'],
  'runs.attempt': ['runs', 0, 'attempt'],
  'runs.claim_gen': ['runs', 0, 'claimGen'],
  'runs.activated_gen': ['runs', 0, 'activatedGen'],
  'runs.relaunch_count': ['runs', 0, 'relaunchCount'],
  'runs.claim_expires_at_ms': ['runs', 0, 'claimExpiresAtMs'],
  'runs.heartbeat_at_ms': ['runs', 0, 'heartbeatAtMs'],
  'runs.available_at_ms': ['runs', 0, 'availableAtMs'],
  'runs.started_at_ms': ['runs', 0, 'startedAtMs'],
  'runs.completed_at_ms': ['runs', 0, 'completedAtMs'],
  'runs.failed_at_ms': ['runs', 0, 'failedAtMs'],
  'waits.timeout_at_ms': ['waits', 0, 'timeoutAtMs'],
  'waits.created_at_ms': ['waits', 0, 'createdAtMs'],
  'events.emitted_at_ms': ['events', 0, 'emittedAtMs'],
}

/** The persisted integers of those tables the reads do not select, each with why. */
const NOT_READ: Readonly<Record<string, string>> = {
  'tasks.cancelled_at_ms': 'the state and the outcome say a task was cancelled',
  'tasks.created_at_ms': 'the enqueue instant is what an operator asks about',
  'tasks.fence_at_ms': 'provenance, which the engine reads and an operator does not',
  'runs.lease_ms': "the lease's expiry is read, and its length decides nothing an operator asks",
  'runs.created_at_ms': 'the available and start instants are what an operator asks about',
  'runs.fence_at_ms': 'provenance, which the engine reads and an operator does not',
  'waits.fence_at_ms': 'provenance, which the engine reads and an operator does not',
  'events.fence_at_ms': 'provenance, which the engine reads and an operator does not',
}

/**
 * The registered mutation that deletes each field's guard, by the field. A marker is a
 * literal because the mutation audit reads it from this source.
 */
const GUARD_VERDICTS: Readonly<Record<string, string>> = {
  'tasks.attempts': 'mutation-verdict:behavior:operator-reads-guard-tasks-attempts',
  'tasks.max_attempts': 'mutation-verdict:behavior:operator-reads-guard-tasks-max-attempts',
  'tasks.infra_retries': 'mutation-verdict:behavior:operator-reads-guard-tasks-infra-retries',
  'tasks.enqueue_at_ms': 'mutation-verdict:behavior:operator-reads-guard-tasks-enqueue-at-ms',
  'tasks.first_started_at_ms':
    'mutation-verdict:behavior:operator-reads-guard-tasks-first-started-at-ms',
  'tasks.cancel_at_ms': 'mutation-verdict:behavior:operator-reads-guard-tasks-cancel-at-ms',
  'runs.attempt': 'mutation-verdict:behavior:operator-reads-guard-runs-attempt',
  'runs.claim_gen': 'mutation-verdict:behavior:operator-reads-guard-runs-claim-gen',
  'runs.activated_gen': 'mutation-verdict:behavior:operator-reads-guard-runs-activated-gen',
  'runs.relaunch_count': 'mutation-verdict:behavior:operator-reads-guard-runs-relaunch-count',
  'runs.claim_expires_at_ms':
    'mutation-verdict:behavior:operator-reads-guard-runs-claim-expires-at-ms',
  'runs.heartbeat_at_ms': 'mutation-verdict:behavior:operator-reads-guard-runs-heartbeat-at-ms',
  'runs.available_at_ms': 'mutation-verdict:behavior:operator-reads-guard-runs-available-at-ms',
  'runs.started_at_ms': 'mutation-verdict:behavior:operator-reads-guard-runs-started-at-ms',
  'runs.completed_at_ms': 'mutation-verdict:behavior:operator-reads-guard-runs-completed-at-ms',
  'runs.failed_at_ms': 'mutation-verdict:behavior:operator-reads-guard-runs-failed-at-ms',
  'waits.timeout_at_ms': 'mutation-verdict:behavior:operator-reads-guard-waits-timeout-at-ms',
  'waits.created_at_ms': 'mutation-verdict:behavior:operator-reads-guard-waits-created-at-ms',
  'events.emitted_at_ms': 'mutation-verdict:behavior:operator-reads-guard-events-emitted-at-ms',
}

/** Every persisted integer of the tables the reads select from, as core's bounds name them. */
const FIELDS = TABLES.flatMap((table) =>
  Object.entries(PERSISTED_INTEGER_BOUNDS[table]).map(([column, bounds]) => ({
    table,
    column,
    field: `${table}.${column}`,
    min: bounds.min,
    max: bounds.max,
  })),
)

/** A copy of an answer with null at one place, which is what a corrupt integer reads as. */
function withNullAt(facts: TaskFacts, path: readonly (string | number)[]): unknown {
  const copy = structuredClone(facts) as unknown
  let holder = copy as Record<string | number, unknown>
  for (const step of path.slice(0, -1)) holder = holder[step] as Record<string | number, unknown>
  holder[path[path.length - 1] as string | number] = null
  return copy
}

/** The row of a table that a seed made, as a storage corruption names it. */
function rowOf(table: Table, rows: Rows, column: string, invalidRepresentation: string) {
  const identity = {
    tasks: { taskId: rows.taskId },
    runs: { runId: rows.runId },
    waits: { runId: rows.runId, stepName: rows.stepName },
    events: { queue: Q, eventName: rows.eventName },
  }[table]
  return { table, column, invalidRepresentation, ...identity } as unknown as Exclude<
    StorageCorruption,
    { invalidRepresentation: 'over-width' }
  >
}

/** How a corrupt entry names the row of a table. */
const entryIdentity = (table: Table, rows: Rows): Partial<CorruptInteger> =>
  ({
    tasks: {},
    runs: { runId: rows.runId },
    waits: { runId: rows.runId, stepName: rows.stepName },
    events: { eventName: rows.eventName },
  })[table]

export function operatorReadsConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`operator reads [${dialect}]`, () => {
    const inWorld = <T>(name: string, body: (world: World) => Promise<T>): Promise<T> =>
      withFixture(makeFixture, `operator-reads-${name}`, async (f) => {
        const at = (ms: number) => f.admin.setFakeNowEpochMs(ms)
        await at(START)
        return body({ f, at })
      })

    describe('answers every seeded state with one canonical answer, the same on every dialect', () => {
      for (const [index, seed] of SEEDS.entries()) {
        it(seed.name, () =>
          inWorld(`seed-${index}`, async (world) => {
            const { f } = world
            const { taskId, expected } = await seed.build(world)
            const recorder = new RecordingExecutor(f.raw)
            const before = await snapshot(f.raw)
            const facts = await f.operatorReadsOver(recorder).taskFacts(Q, taskId)
            // Every count and instant is a JavaScript number, whatever the driver returned.
            const { wrong, numbers } = numbersOf(facts)
            expect(wrong, 'mutation-verdict:behavior:operator-reads-answer-numbers').toEqual([])
            expect(numbers).toBeGreaterThan(8)
            expect(facts).toEqual(expected)
            // One batch is the snapshot, the flag of the test clock follows it, and both
            // are batches of reads that change no row.
            expect(recorder.batches.map((batch) => [batch.label, batch.mode])).toEqual([
              ['task-facts', 'read'],
              ['fake-clock', 'read'],
            ])
            expect(await snapshot(f.raw)).toEqual(before)
            // The outcome is the one `getTaskResult` answers with, a refusal included.
            expect(facts?.outcome).toEqual(await viaTheStore(f, taskId))
          }))
      }
    })

    it('answers null for a task the queue does not hold, and for a task of another queue', () =>
      inWorld('absent', async ({ f }) => {
        const task = await spawn(f, 'job')
        const reads = f.operatorReadsOver(f.raw)
        expect(await reads.taskFacts(Q, 'no-such-task')).toBeNull()
        expect(await reads.taskFacts('another-queue', task.taskId)).toBeNull()
        expect((await reads.taskFacts(Q, task.taskId))?.task.taskId).toBe(task.taskId)
      }))

    it('reports the server clock when the test clock is not set', () =>
      inWorld('real-clock', async ({ f }) => {
        const task = await spawn(f, 'job')
        await f.admin.setFakeNowEpochMs(null)
        const facts = await f.operatorReadsOver(f.raw).taskFacts(Q, task.taskId)
        expect(facts?.fakeClock).toBe(false)
        // The server's own clock, which is this century's and not the instant a test wrote.
        expect(facts?.nowMs).toBeGreaterThan(1_600_000_000_000)
      }))

    it('selects no params, headers, event payload, run result or checkpoint state', () =>
      inWorld('selected', async ({ f }) => {
        const planted = {
          params: 'sentinel-params-1c6e',
          headers: 'sentinel-headers-7a2d',
          checkpoint: 'sentinel-checkpoint-93bf',
          event: 'sentinel-event-0e58',
        }
        const outcome = 'sentinel-outcome-d417'
        const task = await f.store.spawn(Q, 'job', JSON.stringify({ p: planted.params }), {
          headers: { trace: planted.headers },
        })
        const first = await claimActivated(f.store, Q, 'w1')
        await checkpointOwned(f.store, Q, first, 'step', JSON.stringify(planted.checkpoint), 60)
        await awaitOwned(f.store, Q, first, 'approve', 'approval', null)
        await f.store.emitEvent(Q, 'approval', JSON.stringify({ e: planted.event }))
        const returned: SqlResult[] = []
        const watching: SqlExecutor = {
          batch: async (label, statements, control) => {
            const results = await f.raw.batch(label, statements, control)
            returned.push(...results)
            return results
          },
        }
        const reads = f.operatorReadsOver(watching)
        // Woken by the event: its run carries the event's payload.
        const woken = await reads.taskFacts(Q, task.taskId)
        expect(woken?.events).toEqual([{ eventName: 'approval', exists: true, emittedAtMs: START }])
        const second = await claimActivated(f.store, Q, 'w2')
        await f.store.complete(Q, second.runId, second.claimToken, JSON.stringify({ r: outcome }))
        const completed = await reads.taskFacts(Q, task.taskId)
        const text = JSON.stringify(returned)
        expect(
          Object.entries(planted)
            .filter(([, sentinel]) => text.includes(sentinel))
            .map(([where]) => where),
        ).toEqual([])
        // The outcome is the one value a task's code wrote that the answer holds, and the
        // watch saw it, so the watch can see a value.
        expect(text).toContain(outcome)
        expect(completed?.outcome).toEqual({
          result: { state: 'completed', completedPayloadJson: JSON.stringify({ r: outcome }) },
        })
        const columns = new Set(returned.flatMap((result) => result.rows.flatMap(Object.keys)))
        expect(
          ['params', 'headers', 'payload', 'event_payload', 'result', 'claimed_by'].filter(
            (column) => columns.has(column),
          ),
        ).toEqual([])
      }))

    it('orders waits and events by their UTF-16 code units, which no collation of the database decides', () =>
      inWorld('order', async (world) => {
        const { f } = world
        const parked = await parkedOn(world, null)
        // Fixture-built: a run registers one wait, so the others are written as rows. The
        // names sort one way by code unit, another by code point, and a third by a
        // linguistic collation.
        const names = ['b', 'Z', '_', 'A', 'é', '\u{1F600}', '～']
        await f.raw.batch(
          'fixture:waits',
          names.flatMap((name) => [
            {
              sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
                    VALUES (?, ?, ?, ?, ?, 'waiting', ?)`,
              args: [parked.runId, name, Q, parked.taskId, `on-${name}`, START],
            },
          ]),
        )
        await f.store.emitEvent(Q, 'on-Z', '{}')
        const facts = await f.operatorReadsOver(f.raw).taskFacts(Q, parked.taskId)
        const sorted = ['A', 'Z', '_', 'approve', 'b', 'é', '\u{1F600}', '～']
        expect(
          facts?.waits.map((wait) => wait.stepName),
          'mutation-verdict:behavior:operator-reads-order-their-own-lists',
        ).toEqual(sorted)
        expect(facts?.events.map((event) => event.eventName)).toEqual([
          'approval',
          'on-A',
          'on-Z',
          'on-_',
          'on-b',
          'on-é',
          'on-\u{1F600}',
          'on-～',
        ])
        expect(facts?.events.filter((event) => event.exists)).toEqual([
          { eventName: 'on-Z', exists: true, emittedAtMs: START + 1_000 },
        ])
      }))

    describe('a persisted integer outside its bounds is listed, never skipped and never thrown', () => {
      it('names every persisted integer of the tables it selects from as read or as not read', () => {
        expect(FIELDS.map(({ field }) => field).sort()).toEqual(
          [...Object.keys(READ_AS), ...Object.keys(NOT_READ)].sort(),
        )
        expect(Object.keys(GUARD_VERDICTS).sort()).toEqual(Object.keys(READ_AS).sort())
      })

      for (const { table, column, field, min, max } of FIELDS) {
        const path = READ_AS[field]
        const title =
          path === undefined
            ? `${field} is not read: a value outside its bounds changes no answer`
            : `${field} outside its bounds is listed as corrupt, read as null, and changes nothing else`
        it(title, () =>
          inWorld(`corrupt-${field}`, async (world) => {
            const { f } = world
            const rows = await PLANTED_IN[table === 'events' ? 'woken' : 'parked'](world)
            const reads = f.operatorReadsOver(f.raw)
            const clean = await reads.taskFacts(Q, rows.taskId)
            if (clean === null) throw new Error('the seeded task is not there')
            const { where, identityArgs } = corruptionTarget(rowOf(table, rows, column, 'none'))
            const original = (
              await readOne(
                f.raw,
                `SELECT ${column} AS v FROM ${table} WHERE ${where}`,
                identityArgs,
              )
            )?.v
            if (original === undefined || original instanceof Uint8Array) {
              throw new Error(`${field} has no stored value to restore`)
            }
            const restore = () =>
              f.raw.batch('fixture:restore', [
                {
                  sql: `UPDATE ${table} SET ${column} = ? WHERE ${where}`,
                  args: [original, ...identityArgs],
                },
              ])
            const listed = (entry: Partial<CorruptInteger>) =>
              path === undefined ? [] : [{ field, ...entryIdentity(table, rows), ...entry }]
            const expectedWith = path === undefined ? clean : withNullAt(clean, path)
            const observed: unknown[] = []
            const expected: unknown[] = []
            // Below the bounds, negative, and past them: every dialect stores these.
            for (const bad of [...new Set([-1, min - 1, max + 1])]) {
              await f.raw.batch('fixture:out-of-range', [
                {
                  sql: `UPDATE ${table} SET ${column} = ? WHERE ${where}`,
                  args: [bad, ...identityArgs],
                },
              ])
              const facts = await reads.taskFacts(Q, rows.taskId)
              observed.push({ bad, corrupt: facts?.corrupt, rest: { ...facts, corrupt: [] } })
              expected.push({
                bad,
                corrupt: listed({ reason: 'out-of-range', stored: 'number', value: String(bad) }),
                rest: expectedWith,
              })
              await restore()
            }
            // A fraction, and text: a dialect whose column refuses the value has nothing to read.
            for (const invalidRepresentation of ['fractional-real', 'non-integer'] as const) {
              const disposition = await executeStorageCorruption(
                f,
                rowOf(table, rows, column, invalidRepresentation),
              )
              const facts = await reads.taskFacts(Q, rows.taskId)
              const [entry] = facts?.corrupt ?? []
              observed.push({
                invalidRepresentation,
                disposition,
                corrupt: facts?.corrupt.map(({ value: _value, ...rest }) => rest),
                // The fixture chooses the fraction it plants, and it is copied as text.
                copied: entry?.value === undefined ? 'no value' : /^\d\.5$/.test(entry.value),
                rest: { ...facts, corrupt: [] },
              })
              const injected = disposition === 'injected'
              const fraction = invalidRepresentation === 'fractional-real'
              expected.push({
                invalidRepresentation,
                disposition,
                corrupt: injected
                  ? listed({
                      reason: 'not-an-exact-integer',
                      stored: fraction ? 'number' : 'string',
                    })
                  : [],
                copied: injected && fraction && path !== undefined ? true : 'no value',
                rest: injected ? expectedWith : clean,
              })
              await restore()
            }
            expect(observed, GUARD_VERDICTS[field]).toEqual(expected)
            expect(await reads.taskFacts(Q, rows.taskId)).toEqual(clean)
          }))
      }
    })

    it('finds a task by its idempotency key, in its own queue alone, and a child by the key the engine built', () =>
      inWorld('by-key', async (world) => {
        const { f } = world
        const reads = f.operatorReadsOver(f.raw)
        // First, so the claim inside takes the parent's run and no other.
        const { parent, child } = await parentAndChild(world)
        const keyed = await spawn(f, 'job', { idempotencyKey: 'order-7' })
        const elsewhere = await f.store.spawn('another-queue', 'job', '{}', {
          idempotencyKey: 'order-7',
        })
        await spawn(f, 'unkeyed')
        const recorder = new RecordingExecutor(f.raw)
        const watched = f.operatorReadsOver(recorder)
        expect({
          byKey: await watched.taskIdByKey(Q, 'order-7'),
          inAnotherQueue: await reads.taskIdByKey('another-queue', 'order-7'),
          aKeyNoTaskHas: await reads.taskIdByKey(Q, 'order-8'),
          aQueueWithNoTask: await reads.taskIdByKey('an-empty-queue', 'order-7'),
          theChild: await reads.taskIdByKey(Q, childSpawnKey(parent.taskId, 'site:1')),
        }).toEqual({
          byKey: keyed.taskId,
          inAnotherQueue: elsewhere.taskId,
          aKeyNoTaskHas: null,
          aQueueWithNoTask: null,
          theChild: child.taskId,
        })
        expect(recorder.batches.map((batch) => [batch.label, batch.mode])).toEqual([
          ['task-id-by-key', 'read'],
        ])
      }))

    it('says whether an event exists and when it was emitted, a completion event included, and nothing of its payload', () =>
      inWorld('event-state', async (world) => {
        const { f, at } = world
        const { child } = await parentAndChild(world)
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        const done = taskDoneEventName(child.taskId)
        const absent = { exists: false, emittedAtMs: null, corrupt: [] }
        expect(await reads.eventState(Q, 'approval')).toEqual(absent)
        expect(await reads.eventState(Q, done)).toEqual(absent)
        await at(START + 4_000)
        await f.store.emitEvent(Q, 'approval', '{"secret":"sentinel-payload"}')
        const childRun = await claimActivated(f.store, Q, 'w-child')
        await at(START + 5_000)
        await f.store.complete(Q, childRun.runId, childRun.claimToken, '"done"')
        const emitted = await reads.eventState(Q, 'approval')
        expect(emitted).toEqual({ exists: true, emittedAtMs: START + 4_000, corrupt: [] })
        expect(JSON.stringify(emitted)).not.toContain('sentinel-payload')
        expect(await reads.eventState(Q, done)).toEqual({
          exists: true,
          emittedAtMs: START + 5_000,
          corrupt: [],
        })
        expect(await reads.eventState('another-queue', 'approval')).toEqual(absent)
        expect(new Set(recorder.batches.map((batch) => `${batch.label}/${batch.mode}`))).toEqual(
          new Set(['event-state/read']),
        )
        // An instant outside its bounds is listed here as it is in a task's facts.
        await f.raw.batch('fixture:out-of-range', [
          {
            sql: 'UPDATE events SET emitted_at_ms = -1 WHERE queue = ? AND event_name = ?',
            args: [Q, 'approval'],
          },
        ])
        expect(await reads.eventState(Q, 'approval')).toEqual({
          exists: true,
          emittedAtMs: null,
          corrupt: [
            {
              field: 'events.emitted_at_ms',
              eventName: 'approval',
              reason: 'out-of-range',
              stored: 'number',
              value: '-1',
            },
          ],
        })
      }))

    it('refuses a string no store keeps, or one past the width, at every place, and sends nothing', () =>
      inWorld('strings', async ({ f }) => {
        const recorder = new RecordingExecutor(f.raw)
        const reads = f.operatorReadsOver(recorder)
        const answers: unknown[] = []
        for (const method of OPERATOR_READ_METHODS) {
          for (const [index, name] of OPERATOR_READ_STRINGS[method].entries()) {
            for (const bad of ['a\u0000b', 'a\uD800b', 'x'.repeat(256)]) {
              const args: string[] = ['q', 'a-name']
              args[index] = bad
              const call = reads[method] as (...made: string[]) => Promise<unknown>
              answers.push({
                place: `${method}[${index}](${name})`,
                refused: await call(...args).then(
                  () => false,
                  (error: unknown) => error instanceof InvalidDurableStringError,
                ),
              })
            }
          }
        }
        expect(
          answers.filter((answer) => (answer as { refused: boolean }).refused !== true),
        ).toEqual([])
        expect(answers).toHaveLength(18)
        expect(recorder.batches).toEqual([])
      }))
  })
}
