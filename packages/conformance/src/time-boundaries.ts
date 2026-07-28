import {
  type ClaimedRun,
  INFRA_BACKOFF_SECONDS,
  INFRA_RETRY_CAP,
  MAX_EPOCH_MS,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_CAP,
  type SpawnOptions,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'

const Q = 'time-boundary'
const NORMAL_NOW_MS = 1_000_000
const ONE_MS_SECONDS = 0.001

interface PreparedBoundary {
  invoke(): Promise<void>
  targets(): Promise<readonly number[]>
}

interface TimeBoundaryCase {
  readonly id: string
  readonly deltaMs: number
  prepare(fixture: StoreFixture): Promise<PreparedBoundary>
}

async function spawned(
  fixture: StoreFixture,
  taskName: string,
  options?: SpawnOptions,
): Promise<{ taskId: string; runId: string }> {
  const result = await fixture.store.spawn(Q, taskName, '{}', options)
  if (!result.created || result.runId === null) {
    throw new Error(`timestamp boundary setup did not create ${taskName}`)
  }
  return { taskId: result.taskId, runId: result.runId }
}

async function claimOne(
  fixture: StoreFixture,
  token: string,
  leaseSeconds = 60,
): Promise<ClaimedRun> {
  const [run] = await fixture.store.claim(Q, token, { leaseSeconds, limit: 1 })
  if (!run) throw new Error(`timestamp boundary setup did not claim ${token}`)
  return run
}

async function activated(
  fixture: StoreFixture,
  taskName: string,
  options?: SpawnOptions,
): Promise<ClaimedRun> {
  await spawned(fixture, taskName, options)
  const run = await claimOne(fixture, `${taskName}-claim`)
  const activation = await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen)
  if (!activation) throw new Error(`timestamp boundary setup did not activate ${taskName}`)
  return activation
}

async function scalar(
  fixture: StoreFixture,
  sql: string,
  args: readonly (string | number | bigint | null)[],
  column: string,
): Promise<number> {
  const [result] = await fixture.raw.batch(
    'time-boundary:scalar',
    [{ sql, args: [...args] }],
    'read',
  )
  const value = result?.rows[0]?.[column]
  if (value === null || value === undefined) {
    throw new Error(`timestamp boundary target ${column} is absent`)
  }
  return Number(value)
}

async function durableSnapshot(fixture: StoreFixture): Promise<unknown> {
  const results = await fixture.raw.batch(
    'time-boundary:snapshot',
    [
      { sql: `SELECT * FROM tasks ORDER BY task_id`, args: [] },
      { sql: `SELECT * FROM runs ORDER BY task_id, attempt, run_id`, args: [] },
      { sql: `SELECT * FROM waits ORDER BY run_id, step_name`, args: [] },
      {
        sql: `SELECT * FROM checkpoints ORDER BY task_id, checkpoint_name`,
        args: [],
      },
      { sql: `SELECT * FROM drivers ORDER BY queue, driver_id`, args: [] },
    ],
    'read',
  )
  return results.map((result) => result.rows)
}

const BOUNDARY_CASES: readonly TimeBoundaryCase[] = [
  {
    id: 'spawn enqueue deadline',
    deltaMs: 1,
    async prepare(fixture) {
      let runId: string | null = null
      return {
        async invoke() {
          runId = (
            await spawned(fixture, 'spawn-enqueue', {
              startDelaySeconds: ONE_MS_SECONDS,
            })
          ).runId
        },
        async targets() {
          if (runId === null) throw new Error('spawn enqueue target is absent')
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs WHERE run_id = ?`,
              [runId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'spawn cancellation deadline',
    deltaMs: 1,
    async prepare(fixture) {
      let taskId: string | null = null
      return {
        async invoke() {
          taskId = (
            await spawned(fixture, 'spawn-cancel', {
              cancellation: { maxDelaySeconds: ONE_MS_SECONDS },
            })
          ).taskId
        },
        async targets() {
          if (taskId === null) throw new Error('spawn cancellation target is absent')
          return [
            await scalar(
              fixture,
              `SELECT cancel_at_ms FROM tasks WHERE task_id = ?`,
              [taskId],
              'cancel_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'claim lease deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const initial = await spawned(fixture, 'claim-lease')
      let runId = initial.runId
      return {
        async invoke() {
          runId = (await claimOne(fixture, 'claim-lease-token', ONE_MS_SECONDS)).runId
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
              [runId],
              'claim_expires_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'activation lease deadline',
    deltaMs: 1,
    async prepare(fixture) {
      await spawned(fixture, 'activate-lease')
      const run = await claimOne(fixture, 'activate-lease-token', ONE_MS_SECONDS)
      return {
        async invoke() {
          const result = await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          if (!result) throw new Error('activation lease boundary lost its claim')
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'claim_expires_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'activation max-duration deadline',
    deltaMs: 2,
    async prepare(fixture) {
      const task = await spawned(fixture, 'activate-duration', {
        cancellation: { maxDurationSeconds: 0.002 },
      })
      const run = await claimOne(fixture, 'activate-duration-token', ONE_MS_SECONDS)
      return {
        async invoke() {
          const result = await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen)
          if (!result) throw new Error('activation duration boundary lost its claim')
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT cancel_at_ms FROM tasks WHERE task_id = ?`,
              [task.taskId],
              'cancel_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'heartbeat lease deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'heartbeat-lease')
      return {
        async invoke() {
          const result = await fixture.store.heartbeat(Q, run.runId, run.claimToken, ONE_MS_SECONDS)
          if (!result.held) throw new Error('heartbeat boundary lost its claim')
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'claim_expires_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'lost-launch relaunch deadline',
    deltaMs: RELAUNCH_BACKOFF_BASE_SECONDS * 1000,
    async prepare(fixture) {
      await spawned(fixture, 'lost-launch')
      const run = await claimOne(fixture, 'lost-launch-token', ONE_MS_SECONDS)
      return {
        async invoke() {
          const [result] = await fixture.store.sweep(Q, 1)
          if (result?.kind !== 'lost-launch') {
            throw new Error(`expected lost-launch boundary outcome, got ${result?.kind}`)
          }
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'claim-timeout successor deadline',
    deltaMs: INFRA_BACKOFF_SECONDS * 1000,
    async prepare(fixture) {
      const run = await activated(fixture, 'claim-timeout')
      return {
        async invoke() {
          const [result] = await fixture.store.sweep(Q, 1)
          if (result?.kind !== 'claim-timeout') {
            throw new Error(`expected claim-timeout boundary outcome, got ${result?.kind}`)
          }
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs
               WHERE task_id = ? AND attempt = 2`,
              [run.taskId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'driver heartbeat deadline',
    deltaMs: 1,
    async prepare(fixture) {
      return {
        async invoke() {
          await fixture.store.driverHeartbeat(Q, 'driver', ONE_MS_SECONDS)
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT expires_at_ms FROM drivers WHERE queue = ? AND driver_id = ?`,
              [Q, 'driver'],
              'expires_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'reschedule wake deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'reschedule')
      return {
        async invoke() {
          await fixture.store.reschedule(Q, run.runId, run.claimToken, {
            inSeconds: ONE_MS_SECONDS,
          })
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'suspend wake deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'suspend')
      return {
        async invoke() {
          await fixture.store.suspendRun(
            Q,
            run.runId,
            run.claimToken,
            { inSeconds: ONE_MS_SECONDS },
            { key: '$sleep', stateJson: '{}' },
          )
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'user-retry successor deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'user-retry')
      return {
        async invoke() {
          await fixture.store.fail(Q, run.runId, run.claimToken, '{"name":"retry"}', {
            delaySeconds: ONE_MS_SECONDS,
          })
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs
               WHERE task_id = ? AND attempt = 2`,
              [run.taskId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'checkpoint lease deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'checkpoint')
      return {
        async invoke() {
          await fixture.store.setCheckpoint(
            Q,
            run.taskId,
            run.runId,
            run.claimToken,
            'step',
            '{}',
            ONE_MS_SECONDS,
          )
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'claim_expires_at_ms',
            ),
          ]
        },
      }
    },
  },
  {
    id: 'event timeout deadline',
    deltaMs: 1,
    async prepare(fixture) {
      const run = await activated(fixture, 'await-event')
      return {
        async invoke() {
          const result = await fixture.store.awaitEvent(
            Q,
            run.taskId,
            run.runId,
            run.claimToken,
            'step',
            'event',
            ONE_MS_SECONDS,
          )
          if (result.emitted) throw new Error('event boundary unexpectedly found an event')
        },
        async targets() {
          return [
            await scalar(
              fixture,
              `SELECT timeout_at_ms FROM waits WHERE run_id = ? AND step_name = ?`,
              [run.runId, 'step'],
              'timeout_at_ms',
            ),
            await scalar(
              fixture,
              `SELECT available_at_ms FROM runs WHERE run_id = ?`,
              [run.runId],
              'available_at_ms',
            ),
          ]
        },
      }
    },
  },
]

async function fixtureAt(makeFixture: StoreFixtureFactory, seed: string): Promise<StoreFixture> {
  const fixture = await makeFixture(seed)
  await fixture.admin.setFakeNowEpochMs(NORMAL_NOW_MS)
  return fixture
}

export function timestampBoundaryConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`timestamp addition boundaries [${dialect}]`, () => {
    for (const testCase of BOUNDARY_CASES) {
      it(`${testCase.id} accepts an exact MAX_EPOCH_MS result`, async () => {
        const fixture = await fixtureAt(makeFixture, `${testCase.id}:exact`)
        try {
          const prepared = await testCase.prepare(fixture)
          await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS - testCase.deltaMs)
          await prepared.invoke()
          const targets = await prepared.targets()
          expect(targets).not.toHaveLength(0)
          expect(targets.every((value) => value === MAX_EPOCH_MS)).toBe(true)
        } finally {
          fixture.close()
        }
      })

      it(`${testCase.id} refuses overflow by one without a partial transition`, async () => {
        const fixture = await fixtureAt(makeFixture, `${testCase.id}:overflow`)
        try {
          const prepared = await testCase.prepare(fixture)
          await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS - testCase.deltaMs + 1)
          const before = await durableSnapshot(fixture)
          await prepared.invoke().catch(() => undefined)
          expect(
            await durableSnapshot(fixture),
            'mutation-verdict:behavior:timestamp-addition-bounds',
          ).toEqual(before)
        } finally {
          fixture.close()
        }
      })
    }

    it('allows the relaunch-cap terminal arm at the epoch ceiling', async () => {
      const fixture = await fixtureAt(makeFixture, 'terminal:relaunch-cap')
      try {
        await spawned(fixture, 'terminal-relaunch')
        const run = await claimOne(fixture, 'terminal-relaunch-token', ONE_MS_SECONDS)
        await fixture.raw.batch('time-boundary:relaunch-cap', [
          {
            sql: `UPDATE runs SET relaunch_count = ? WHERE run_id = ?`,
            args: [RELAUNCH_CAP, run.runId],
          },
        ])
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS)

        expect(await fixture.store.sweep(Q, 1)).toEqual([
          {
            kind: 'relaunch-cap-exhausted',
            runId: run.runId,
            taskId: run.taskId,
          },
        ])
      } finally {
        fixture.close()
      }
    })

    it('allows the infra-cap terminal arm at the epoch ceiling', async () => {
      const fixture = await fixtureAt(makeFixture, 'terminal:infra-cap')
      try {
        const run = await activated(fixture, 'terminal-infra')
        await fixture.raw.batch('time-boundary:infra-cap', [
          {
            sql: `UPDATE tasks SET infra_retries = ? WHERE task_id = ?`,
            args: [INFRA_RETRY_CAP, run.taskId],
          },
          {
            sql: `UPDATE runs SET attempt = ? WHERE run_id = ?`,
            args: [INFRA_RETRY_CAP + 1, run.runId],
          },
        ])
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS)

        expect(await fixture.store.sweep(Q, 1)).toEqual([
          {
            kind: 'infra-cap-exhausted',
            runId: run.runId,
            taskId: run.taskId,
          },
        ])
      } finally {
        fixture.close()
      }
    })

    it('allows terminal user failure when retry budget is exhausted', async () => {
      const fixture = await fixtureAt(makeFixture, 'terminal:user-budget')
      try {
        const run = await activated(fixture, 'terminal-user', {
          maxAttempts: 1,
        })
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS)
        await fixture.store.fail(Q, run.runId, run.claimToken, '{"name":"done"}', {
          delaySeconds: ONE_MS_SECONDS,
        })

        const result = await fixture.store.getTaskResult(Q, run.taskId)
        expect(result).toMatchObject({ state: 'failed' })
        expect(
          await scalar(
            fixture,
            `SELECT COUNT(*) AS count FROM runs WHERE task_id = ?`,
            [run.taskId],
            'count',
          ),
        ).toBe(1)
      } finally {
        fixture.close()
      }
    })

    it('uses an existing first-start instant for max-duration on reactivation', async () => {
      const fixture = await fixtureAt(makeFixture, 'control:existing-first-start')
      try {
        const task = await spawned(fixture, 'existing-first-start', {
          cancellation: { maxDurationSeconds: 0.002 },
        })
        const run = await claimOne(fixture, 'existing-first-start-token', ONE_MS_SECONDS)
        await fixture.raw.batch('time-boundary:existing-first-start', [
          {
            sql: `UPDATE tasks SET first_started_at_ms = ?, cancel_at_ms = ?
                  WHERE task_id = ?`,
            args: [MAX_EPOCH_MS - 2, MAX_EPOCH_MS, task.taskId],
          },
          {
            sql: `UPDATE runs SET started_at_ms = ? WHERE run_id = ?`,
            args: [MAX_EPOCH_MS - 2, run.runId],
          },
        ])
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS - 1)

        expect(
          await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen),
        ).not.toBeNull()
        expect(
          await scalar(
            fixture,
            `SELECT cancel_at_ms FROM tasks WHERE task_id = ?`,
            [task.taskId],
            'cancel_at_ms',
          ),
        ).toBe(MAX_EPOCH_MS)
        expect(
          await scalar(
            fixture,
            `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
            [run.runId],
            'claim_expires_at_ms',
          ),
        ).toBe(MAX_EPOCH_MS)
      } finally {
        fixture.close()
      }
    })
  })
}
