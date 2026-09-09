import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  FatalTaskError,
  type SchedulerStore,
  StoreUnavailableError,
  systemIdSource,
} from '@durablerun/core'
import { type TaskContext, runClaimedRun } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import {
  PR_WATCHER_OBSERVATION_STEP,
  PR_WATCHER_TASK,
  type PrWatchObservation,
  createPrWatcher,
  parsePrWatchInput,
} from '../src/pr-watcher.js'

const selector = { kind: 'check-run' as const, name: 'verify', appId: 15368 }
const params = {
  repository: 'example/repository',
  pullNumber: 42,
  headSha: 'a'.repeat(40),
  checks: [selector],
}
const unavailable: PrWatchObservation = {
  kind: 'unavailable',
  observedAt: '2026-09-09T00:00:00.000Z',
  retryable: true,
  reason: 'http-429',
}
function snapshot(state: 'pending' | 'passed' | 'failed'): PrWatchObservation {
  return {
    kind: 'observed',
    observedAt: '2026-09-09T00:00:00.000Z',
    headSha: params.headSha,
    state: 'open',
    checks: [{ ...selector, state }],
  }
}
function context(sleeps: number[] = []): TaskContext {
  const unused = async (): Promise<never> => {
    throw new Error('unused context method')
  }
  return {
    attempt: 1,
    taskName: PR_WATCHER_TASK,
    step: async (_name, body) => body(),
    sleepFor: async (seconds) => {
      sleeps.push(seconds)
    },
    sleepUntil: unused,
    awaitEvent: unused,
    emitEvent: unused,
  }
}

test('watch parameters require explicit unique selectors and bounded polling', () => {
  assert.deepEqual(parsePrWatchInput(params), { ...params, maxPolls: 10, intervalSeconds: 60 })
  assert.equal(
    parsePrWatchInput({ ...params, checks: [{ kind: 'status', name: 'CI/Verify' }] }).checks[0]
      ?.name,
    'ci/verify',
  )
  for (const invalid of [
    null,
    { ...params, repository: 'example/../secret' },
    { ...params, repository: 'example/..' },
    { ...params, headSha: 'short' },
    { ...params, pullNumber: 0 },
    { ...params, checks: [] },
    { ...params, checks: [...params.checks, ...params.checks] },
    {
      ...params,
      checks: [
        { kind: 'status', name: 'CI' },
        { kind: 'status', name: 'ci' },
      ],
    },
    { ...params, checks: [{ kind: 'check-run', name: 'verify', appId: 0 }] },
    ...[null, 0, 31, 1.5, Number.NaN].map((maxPolls) => ({ ...params, maxPolls })),
    ...[null, 0, 59, 3601, Number.POSITIVE_INFINITY].map((intervalSeconds) => ({
      ...params,
      intervalSeconds,
    })),
  ]) {
    assert.throws(() => parsePrWatchInput(invalid), FatalTaskError)
  }
})

test('selected checks are non-vacuous and bound to commit, name, kind, and app', async () => {
  const passed = snapshot('passed')
  assert.equal(passed.kind, 'observed')
  if (passed.kind !== 'observed') throw new Error('observed fixture required')
  const cases: [PrWatchObservation, string][] = [
    [passed, 'ready'],
    [snapshot('failed'), 'failed'],
    [snapshot('pending'), 'timed-out'],
    [{ ...passed, checks: [] }, 'timed-out'],
    [{ ...passed, checks: [...passed.checks, ...passed.checks] }, 'timed-out'],
    [
      { ...passed, checks: [{ kind: 'check-run', name: 'verify', appId: 1, state: 'passed' }] },
      'timed-out',
    ],
    [{ ...passed, checks: [{ kind: 'status', name: 'verify', state: 'passed' }] }, 'timed-out'],
    [{ ...passed, checks: [{ ...selector, state: 'passed', name: 'other' }] }, 'timed-out'],
    [{ ...passed, headSha: 'b'.repeat(40) }, 'superseded'],
    [{ ...passed, state: 'closed' }, 'closed'],
    [{ ...unavailable, retryable: false }, 'unavailable'],
    [unavailable, 'unavailable'],
  ]
  for (const [observation, status] of cases) {
    const sleeps: number[] = []
    assert.deepEqual(
      await createPrWatcher(async () => observation)(context(sleeps), { ...params, maxPolls: 1 }),
      {
        status,
        repository: params.repository,
        pullNumber: params.pullNumber,
        headSha: params.headSha,
        polls: 1,
        latest: observation,
        attempt: 1,
      },
    )
    assert.deepEqual(sleeps, [])
  }
})

test('every selected producer must pass independently; unrelated producers do not count', async () => {
  const input = {
    ...params,
    checks: [...params.checks, { kind: 'status', name: 'CI' }],
    maxPolls: 1,
  }
  const states = ['pending', 'passed', 'failed', undefined] as const
  for (const checkState of states) {
    for (const statusState of states) {
      const observation = snapshot('passed')
      assert.equal(observation.kind, 'observed')
      if (observation.kind !== 'observed') throw new Error('observed fixture required')
      observation.checks = [{ kind: 'status', name: 'unselected', state: 'failed' }]
      if (checkState !== undefined) observation.checks.push({ ...selector, state: checkState })
      if (statusState !== undefined) {
        observation.checks.push({ kind: 'status', name: 'ci', state: statusState })
      }
      const result = await createPrWatcher(async () => observation)(context(), input)
      assert.equal(
        result.status,
        checkState === 'failed' || statusState === 'failed'
          ? 'failed'
          : checkState === 'passed' && statusState === 'passed'
            ? 'ready'
            : 'timed-out',
      )
    }
  }
})

test('transient failures back off, honor provider delay, reset on observation, and exhaust a budget', async () => {
  const sequence = [unavailable, unavailable, snapshot('pending'), unavailable, snapshot('passed')]
  const sleeps: number[] = []
  const result = await createPrWatcher(async () => {
    const next = sequence.shift()
    assert.ok(next, 'observation fixture cannot silently run out')
    return next
  })(context(sleeps), params)
  assert.equal(result.status, 'ready')
  assert.deepEqual(sleeps, [60, 120, 60, 60])
  const limitedSleeps: number[] = []
  await createPrWatcher(async () => ({ ...unavailable, retryAfterSeconds: 900 }))(
    context(limitedSleeps),
    { ...params, maxPolls: 3 },
  )
  assert.deepEqual(limitedSleeps, [900, 900])
  const cappedSleeps: number[] = []
  const exhausted = await createPrWatcher(async () => unavailable)(context(cappedSleeps), params)
  assert.equal(exhausted.status, 'unavailable')
  assert.deepEqual(cappedSleeps, [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600])
})

test('SDK controls escape unchanged instead of becoming observations', async () => {
  const control = new Error('opaque SDK control')
  for (const boundary of ['step', 'sleepFor'] as const) {
    const ctx = context()
    ctx[boundary] = async () => {
      throw control
    }
    await assert.rejects(
      createPrWatcher(async () => snapshot('pending'))(ctx, params),
      (error) => error === control,
    )
  }
})

const boundaryMethods = new Set(['setCheckpoint', 'suspendRun', 'complete'])
async function replay(fault?: { boundary: number; timing: 'before' | 'after' }) {
  const raw = LibsqlExecutor.open(':memory:')
  try {
    const admin = new LibsqlStoreAdmin(raw)
    await admin.migrate()
    const ids = systemIdSource()
    const real = new LibsqlSchedulerStore(raw, ids)
    let now = 1_000_000
    await admin.setFakeNowEpochMs(now)
    const spawned = await real.spawn('watch-test', PR_WATCHER_TASK, JSON.stringify(params))
    const boundaries: string[] = []
    let injected = false
    const store = new Proxy(real, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (typeof method !== 'function') return method
        return async (...args: unknown[]) => {
          const boundary = boundaryMethods.has(String(property))
          if (boundary) boundaries.push(String(property))
          const inject = boundary && !injected && boundaries.length === fault?.boundary
          if (inject && fault?.timing === 'before') {
            injected = true
            throw new StoreUnavailableError('injected invocation interruption')
          }
          const value = await method.apply(target, args)
          if (inject && fault?.timing === 'after') {
            injected = true
            throw new StoreUnavailableError('injected lost response')
          }
          return value
        }
      },
    }) as SchedulerStore
    const clock = {
      nowEpochMs: () => now,
      yieldTurn: async () => {},
      sleep: async (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else signal?.addEventListener('abort', () => resolve(), { once: true })
        }),
    }
    const sequence = [unavailable, snapshot('pending'), snapshot('passed')]
    const observerCalls: number[] = []
    const handler = createPrWatcher(async () => {
      const checkpoints = await real.getCheckpoints('watch-test', spawned.taskId, 100)
      const index = checkpoints.filter((cp) =>
        cp.checkpointName.startsWith(PR_WATCHER_OBSERVATION_STEP),
      ).length
      observerCalls.push(index)
      const next = sequence[index]
      assert.ok(next, 'observation fixture cannot silently run out')
      return next
    })
    let infraRetries = 0
    for (let round = 0; round < 12; round++) {
      if ((await real.getTaskResult('watch-test', spawned.taskId))?.state === 'completed') break
      const [run] = await real.claim('watch-test', ids.token(), { leaseSeconds: 1, limit: 1 })
      if (run) {
        infraRetries = Math.max(infraRetries, run.infraRetries)
        await runClaimedRun(
          { store, clock, registry: new Map([[PR_WATCHER_TASK, handler]]) },
          {
            queue: 'watch-test',
            runId: run.runId,
            claimToken: run.claimToken,
            claimGen: run.claimGen,
          },
        )
      }
      now += 120_000
      await admin.setFakeNowEpochMs(now)
      await real.sweep('watch-test', 10)
    }
    const result = await real.getTaskResult('watch-test', spawned.taskId)
    assert.equal(result?.state, 'completed', 'interrupted watcher must make terminal progress')
    assert.equal(injected, fault !== undefined, 'requested fault must actually fire')
    const checkpoints = await real.getCheckpoints('watch-test', spawned.taskId, 100)
    return {
      result: JSON.parse(result?.completedPayloadJson ?? 'null'),
      checkpoints: checkpoints.map(({ checkpointName, stateJson }) => ({
        checkpointName,
        stateJson,
      })),
      boundaries,
      infraRetries,
      observerCalls,
    }
  } finally {
    raw.close()
  }
}

test('released SDK replays the watcher across every observation, sleep, and completion boundary', async () => {
  const baseline = await replay()
  assert.equal(baseline.result.status, 'ready')
  assert.equal(baseline.result.attempt, 1)
  assert.equal(baseline.result.polls, 3)
  assert.deepEqual(baseline.observerCalls, [0, 1, 2])
  assert.deepEqual(baseline.boundaries, [
    'setCheckpoint',
    'suspendRun',
    'setCheckpoint',
    'suspendRun',
    'setCheckpoint',
    'complete',
  ])
  for (const [index, boundary] of baseline.boundaries.entries()) {
    for (const timing of ['before', 'after'] as const) {
      const recovered = await replay({ boundary: index + 1, timing })
      assert.deepEqual(recovered.result, baseline.result, `${boundary} ${timing}: result`)
      assert.deepEqual(
        recovered.checkpoints,
        baseline.checkpoints,
        `${boundary} ${timing}: checkpoints`,
      )
      assert.equal(
        recovered.infraRetries,
        timing === 'after' && boundary !== 'setCheckpoint' ? 0 : 1,
      )
      assert.deepEqual(
        recovered.observerCalls,
        timing === 'before' && boundary === 'setCheckpoint'
          ? baseline.observerCalls.flatMap((poll) => (poll === index / 2 ? [poll, poll] : [poll]))
          : baseline.observerCalls,
        'committed observations are never fetched again; an uncommitted read may repeat',
      )
    }
  }
})
