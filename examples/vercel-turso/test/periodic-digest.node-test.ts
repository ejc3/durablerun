import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { type SchedulerStore, systemIdSource } from '@durablerun/core'
import { runClaimedRun } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import {
  PERIODIC_DIGEST_OBSERVATION_STEP,
  PERIODIC_DIGEST_SETTLE_SECONDS,
  PERIODIC_DIGEST_TASK,
  type RefObservation,
  createPeriodicDigest,
} from '../src/periodic-digest.js'
import { taskRegistry } from '../src/tasks.js'

const QUEUE = 'digest-test'
const START = Date.parse('2026-10-01T00:00:00.000Z')
const HOUR_MS = 3_600_000
const PARAMS = { repository: 'example/project', ref: 'main' }
const keyOf = (period: number): string => `digest-${period}`

/** What the ref names during one period: a commit of the period's own. */
function commitOf(period: number): RefObservation {
  return { commitSha: period.toString(16).padStart(40, '0') }
}

interface World {
  readonly store: SchedulerStore
  /** How often each store method was called. */
  readonly calls: Map<string, number>
  /** The periods the observer was asked about, in order, one entry a call. */
  readonly observed: number[]
  now(): number
  /** Move the test clock forward to an instant. */
  advanceTo(epochMs: number): Promise<void>
  enqueue(period: number, params?: unknown): ReturnType<SchedulerStore['spawn']>
  /** Run every run as it comes due, moving the test clock no further than `untilMs`. */
  drive(untilMs: number): Promise<void>
  close(): void
}

/**
 * The released store and SDK under the store's test clock, with an observer that answers
 * from the clock's hour and fails for the periods named.
 */
async function world(failing: readonly number[] = []): Promise<World> {
  const raw = LibsqlExecutor.open(':memory:')
  const admin = new LibsqlStoreAdmin(raw)
  await admin.migrate()
  const ids = systemIdSource()
  const real = new LibsqlSchedulerStore(raw, ids)
  let now = START
  await admin.setFakeNowEpochMs(now)
  const calls = new Map<string, number>()
  const store = new Proxy(real, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver)
      if (typeof method !== 'function') return method
      return (...args: unknown[]) => {
        calls.set(String(property), (calls.get(String(property)) ?? 0) + 1)
        return method.apply(target, args)
      }
    },
  }) as SchedulerStore
  const observed: number[] = []
  const handler = createPeriodicDigest(async () => {
    const period = Math.floor((now - START) / HOUR_MS)
    observed.push(period)
    if (failing.includes(period)) throw new Error('github-http-503')
    return commitOf(period)
  })
  const clock = {
    nowEpochMs: () => now,
    elapsedMs: () => now,
    yieldTurn: async () => {},
    sleep: async (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
  }
  return {
    store,
    calls,
    observed,
    now: () => now,
    async advanceTo(epochMs) {
      assert.ok(epochMs >= now, 'the test clock only moves forward')
      now = epochMs
      await admin.setFakeNowEpochMs(now)
    },
    enqueue: (period, params = PARAMS) =>
      real.spawn(QUEUE, PERIODIC_DIGEST_TASK, JSON.stringify(params), {
        idempotencyKey: keyOf(period),
      }),
    async drive(untilMs) {
      for (;;) {
        const claimed = await real.claim(QUEUE, ids.token(), { leaseSeconds: 30, limit: 10 })
        for (const run of claimed) {
          await runClaimedRun(
            { store, clock, registry: new Map([[PERIODIC_DIGEST_TASK, handler]]) },
            { queue: QUEUE, runId: run.runId, claimToken: run.claimToken, claimGen: run.claimGen },
          )
        }
        if (claimed.length > 0) continue
        const next = await real.nextWakeAtEpochMs(QUEUE)
        if (next === null || next > untilMs) return
        assert.ok(next > now, 'a run that is due and that no claim takes would spin here')
        now = next
        await admin.setFakeNowEpochMs(now)
      }
    },
    close: () => raw.close(),
  }
}

/** Enqueue each period at the start of its hour and drive the queue to the end of that hour. */
async function runPeriods(
  w: World,
  periods: number,
  paramsOf: (period: number) => unknown = () => PARAMS,
): Promise<string[]> {
  const taskIds: string[] = []
  for (let period = 0; period < periods; period++) {
    const startMs = START + period * HOUR_MS
    await w.advanceTo(startMs)
    const spawned = await w.enqueue(period, paramsOf(period))
    assert.equal(spawned.created, true)
    taskIds.push(spawned.taskId)
    await w.drive(startMs + HOUR_MS - 1)
  }
  return taskIds
}

async function outcomeOf(w: World, taskId: string) {
  const result = await w.store.getTaskResult(QUEUE, taskId)
  const checkpoints = await w.store.getCheckpoints(QUEUE, taskId, 100)
  return {
    state: result?.state,
    result:
      result?.completedPayloadJson === undefined ? null : JSON.parse(result.completedPayloadJson),
    checkpoints: checkpoints.map(({ checkpointName, stateJson }) => ({
      checkpointName,
      stateJson,
    })),
  }
}

test('the registry holds the digest under its name', () => {
  assert.equal(typeof taskRegistry.get(PERIODIC_DIGEST_TASK), 'function')
})

test('48 periods are 48 completed tasks, each with one read and one sleep, ended inside its period', async () => {
  const w = await world()
  try {
    const taskIds: string[] = []
    for (let period = 0; period < 48; period++) {
      const startMs = START + period * HOUR_MS
      await w.advanceTo(startMs)
      const spawned = await w.enqueue(period)
      taskIds.push(spawned.taskId)
      await w.drive(startMs + HOUR_MS - 1)
      // The last wake the queue needed inside the hour was the end of the digest's one
      // sleep, and the task has its result there.
      assert.equal(w.now(), startMs + PERIODIC_DIGEST_SETTLE_SECONDS * 1000)
      assert.deepEqual((await outcomeOf(w, spawned.taskId)).result, {
        ...PARAMS,
        ...commitOf(period),
        settledSeconds: PERIODIC_DIGEST_SETTLE_SECONDS,
        attempt: 1,
      })
    }
    assert.equal(new Set(taskIds).size, 48)
    for (const taskId of taskIds) {
      const outcome = await outcomeOf(w, taskId)
      assert.equal(outcome.state, 'completed')
      // One checkpoint for the read, and one marker of the engine's own for the sleep.
      const names = outcome.checkpoints.map(({ checkpointName }) => checkpointName)
      assert.equal(names.length, 2)
      assert.equal(names.filter((name) => name === PERIODIC_DIGEST_OBSERVATION_STEP).length, 1)
      assert.equal(names.filter((name) => name.startsWith('$')).length, 1)
    }
    assert.deepEqual(
      w.observed,
      Array.from({ length: 48 }, (_unused, period) => period),
    )
    assert.equal(w.calls.get('setCheckpoint'), 48)
    assert.equal(w.calls.get('suspendRun'), 48)
    assert.equal(w.calls.get('complete'), 48)
    // It emits no event and awaits none, and nothing failed.
    for (const never of ['emitEvent', 'awaitEvent', 'fail']) {
      assert.equal(w.calls.get(never), undefined, never)
    }
  } finally {
    w.close()
  }
})

test('a failed period does not touch the next', async () => {
  const failed = 2
  const refused = 4
  const paramsOf = (period: number): unknown => (period === refused ? null : PARAMS)
  const baseline = await world()
  const w = await world([failed])
  try {
    const expected = await runPeriods(baseline, 6)
    const taskIds = await runPeriods(w, 6, paramsOf)
    for (const [period, taskId] of taskIds.entries()) {
      const outcome = await outcomeOf(w, taskId)
      if (period === failed || period === refused) {
        assert.equal(outcome.state, 'failed', `period ${period}`)
      } else {
        assert.deepEqual(outcome, await outcomeOf(baseline, expected[period] ?? ''))
        assert.equal(outcome.state, 'completed')
      }
    }
    // A read that fails is retried until the task's attempts are used up, inside its own
    // period. A task whose parameters name no repository fails at once, and reads nothing.
    assert.deepEqual(w.observed, [0, 1, 2, 2, 2, 2, 2, 3, 5])
    assert.equal(w.calls.get('fail'), 6)
    assert.equal(w.calls.get('complete'), 4)
  } finally {
    baseline.close()
    w.close()
  }
})

test('enqueuing a period again returns the same task', async () => {
  const w = await world()
  try {
    const first = await w.enqueue(0)
    const again = await w.enqueue(0)
    assert.equal(first.created, true)
    assert.deepEqual(
      { taskId: again.taskId, created: again.created },
      { taskId: first.taskId, created: false },
    )
    await w.drive(START + HOUR_MS - 1)
    // A period that has completed is still one task, and a third enqueue runs nothing.
    const afterItEnded = await w.enqueue(0)
    assert.deepEqual(
      { taskId: afterItEnded.taskId, created: afterItEnded.created },
      { taskId: first.taskId, created: false },
    )
    await w.drive(START + 2 * HOUR_MS - 1)
    assert.deepEqual(w.observed, [0])
    assert.equal((await outcomeOf(w, first.taskId)).state, 'completed')
    const next = await w.enqueue(1)
    assert.equal(next.created, true)
    assert.notEqual(next.taskId, first.taskId)
  } finally {
    w.close()
  }
})
