import {
  type ClaimedRun,
  INFRA_BACKOFF_SECONDS,
  INFRA_RETRY_CAP,
  MAX_EPOCH_MS,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_CAP,
  type SqlExecutor,
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

function interposeAfterBatch(
  delegate: SqlExecutor,
  targetLabel: string,
  after: () => Promise<void>,
): { executor: SqlExecutor; fired: () => boolean } {
  let didFire = false
  return {
    executor: {
      batch: async (label, statements, mode) => {
        const results = await delegate.batch(label, statements, mode)
        if (!didFire && label === targetLabel) {
          didFire = true
          await after()
        }
        return results
      },
    },
    fired: () => didFire,
  }
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

    it('refuses a negative run availability before claiming atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:claim-available-lower')
      try {
        const run = await spawned(fixture, 'claim-negative-available')
        await fixture.raw.batch('time-boundary:claim-negative-available', [
          {
            sql: `UPDATE runs SET available_at_ms = -1 WHERE run_id = ?`,
            args: [run.runId],
          },
        ])
        const before = await durableSnapshot(fixture)

        expect(
          await fixture.store.claim(Q, 'claim-negative-available-token', {
            leaseSeconds: 60,
            limit: 1,
          }),
          'mutation-verdict:behavior:timestamp-claim-validates-available-lower-bound',
        ).toEqual([])
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-claim-validates-available-lower-bound',
        ).toEqual(before)
      } finally {
        fixture.close()
      }
    })

    it('refuses an out-of-range cancellation deadline before claiming atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:claim-cancel-upper')
      try {
        const task = await spawned(fixture, 'claim-invalid-cancellation', {
          cancellation: { maxDelaySeconds: 60 },
        })
        await fixture.raw.batch('time-boundary:claim-invalid-cancellation', [
          {
            sql: `UPDATE tasks SET cancel_at_ms = ? WHERE task_id = ?`,
            args: [MAX_EPOCH_MS + 1, task.taskId],
          },
        ])
        const before = await durableSnapshot(fixture)

        expect(
          await fixture.store.claim(Q, 'claim-invalid-cancellation-token', {
            leaseSeconds: 60,
            limit: 1,
          }),
          'mutation-verdict:behavior:timestamp-claim-validates-cancellation-upper-bound',
        ).toEqual([])
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-claim-validates-cancellation-upper-bound',
        ).toEqual(before)
      } finally {
        fixture.close()
      }
    })

    for (const activatedBeforeExpiry of [false, true]) {
      const branch = activatedBeforeExpiry ? 'claim-timeout' : 'lost-launch'

      it(`${branch} sweep refuses a negative claim expiry atomically`, async () => {
        const fixture = await fixtureAt(makeFixture, `consumer:${branch}-expiry-lower`)
        try {
          await spawned(fixture, `${branch}-negative-expiry`)
          const run = await claimOne(fixture, `${branch}-negative-expiry-token`)
          if (activatedBeforeExpiry) {
            const activation = await fixture.store.activate(
              Q,
              run.runId,
              run.claimToken,
              run.claimGen,
            )
            if (!activation) throw new Error(`${branch} setup lost activation`)
          }
          await fixture.raw.batch('time-boundary:negative-claim-expiry', [
            {
              sql: `UPDATE runs SET claim_expires_at_ms = -1 WHERE run_id = ?`,
              args: [run.runId],
            },
          ])
          const before = await durableSnapshot(fixture)

          expect(
            await fixture.store.sweep(Q, 1),
            'mutation-verdict:behavior:timestamp-sweep-validates-claim-expiry-lower-bound',
          ).toEqual([])
          expect(
            await durableSnapshot(fixture),
            'mutation-verdict:behavior:timestamp-sweep-validates-claim-expiry-lower-bound',
          ).toEqual(before)
        } finally {
          fixture.close()
        }
      })

      it(`${branch} sweep rechecks the claim expiry bound after discovery`, async () => {
        const fixture = await fixtureAt(makeFixture, `consumer:${branch}-expiry-race`)
        try {
          await spawned(fixture, `${branch}-expiry-race`)
          const run = await claimOne(fixture, `${branch}-expiry-race-token`)
          if (activatedBeforeExpiry) {
            const activation = await fixture.store.activate(
              Q,
              run.runId,
              run.claimToken,
              run.claimGen,
            )
            if (!activation) throw new Error(`${branch} setup lost activation`)
          }
          await fixture.admin.setFakeNowEpochMs(1_100_000)

          let afterCorruption: unknown
          const interposed = interposeAfterBatch(fixture.raw, 'sweep:scan', async () => {
            await fixture.raw.batch('time-boundary:claim-expiry-race', [
              {
                sql: `UPDATE runs SET claim_expires_at_ms = -1 WHERE run_id = ?`,
                args: [run.runId],
              },
            ])
            afterCorruption = await durableSnapshot(fixture)
          })

          expect(
            await fixture.storeOver(interposed.executor).sweep(Q, 1),
            'mutation-verdict:behavior:timestamp-sweep-rechecks-claim-expiry-bound',
          ).toEqual([])
          expect(interposed.fired()).toBe(true)
          expect(afterCorruption).toBeDefined()
          expect(
            await durableSnapshot(fixture),
            'mutation-verdict:behavior:timestamp-sweep-rechecks-claim-expiry-bound',
          ).toEqual(afterCorruption)
        } finally {
          fixture.close()
        }
      })
    }

    it('deadline cancellation refuses a negative deadline atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:cancel-deadline-lower')
      try {
        const task = await spawned(fixture, 'cancel-negative-deadline', {
          cancellation: { maxDelaySeconds: 60 },
        })
        await fixture.raw.batch('time-boundary:cancel-negative-deadline', [
          {
            sql: `UPDATE tasks SET cancel_at_ms = -1 WHERE task_id = ?`,
            args: [task.taskId],
          },
        ])
        const before = await durableSnapshot(fixture)

        expect(
          await fixture.store.sweep(Q, 1),
          'mutation-verdict:behavior:timestamp-cancel-validates-deadline-lower-bound',
        ).toEqual([])
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-cancel-validates-deadline-lower-bound',
        ).toEqual(before)
      } finally {
        fixture.close()
      }
    })

    it('deadline cancellation rechecks its bound after discovery', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:cancel-deadline-race')
      try {
        const task = await spawned(fixture, 'cancel-deadline-race', {
          cancellation: { maxDelaySeconds: 60 },
        })
        await fixture.admin.setFakeNowEpochMs(1_100_000)

        let afterCorruption: unknown
        const interposed = interposeAfterBatch(fixture.raw, 'sweep:scan', async () => {
          await fixture.raw.batch('time-boundary:cancel-deadline-race', [
            {
              sql: `UPDATE tasks SET cancel_at_ms = -1 WHERE task_id = ?`,
              args: [task.taskId],
            },
          ])
          afterCorruption = await durableSnapshot(fixture)
        })

        expect(
          await fixture.storeOver(interposed.executor).sweep(Q, 1),
          'mutation-verdict:behavior:timestamp-cancel-rechecks-deadline-bound',
        ).toEqual([])
        expect(interposed.fired()).toBe(true)
        expect(afterCorruption).toBeDefined()
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-cancel-rechecks-deadline-bound',
        ).toEqual(afterCorruption)
      } finally {
        fixture.close()
      }
    })
  })
}
