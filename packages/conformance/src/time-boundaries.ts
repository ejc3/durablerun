import {
  type ClaimedRun,
  INFRA_BACKOFF_SECONDS,
  INFRA_RETRY_CAP,
  MAX_DURATION_MS,
  MAX_EPOCH_MS,
  RELAUNCH_BACKOFF_BASE_SECONDS,
  RELAUNCH_CAP,
  type SpawnOptions,
  decodeBoundedInteger,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type StoreFixture, type StoreFixtureFactory, interposeAfterBatch } from './fixture.js'

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
  readonly exactMarker: `mutation-verdict:behavior:${string}`
  readonly overflowMarker: `mutation-verdict:behavior:${string}`
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
  return exactEpochInteger(value, column)
}

function exactEpochInteger(value: unknown, field: string): number {
  const decoded = decodeBoundedInteger(value, { min: 0, max: MAX_EPOCH_MS })
  if (!decoded.ok) {
    throw new RangeError(
      `timestamp boundary target ${field} must be an exact native integer (${decoded.reason})`,
    )
  }
  return decoded.value
}

async function durableSnapshot(fixture: StoreFixture): Promise<unknown> {
  const results = await fixture.raw.batch(
    'time-boundary:snapshot',
    [
      { sql: `SELECT * FROM tasks ORDER BY task_id`, args: [] },
      { sql: `SELECT * FROM runs ORDER BY task_id, attempt, run_id`, args: [] },
      { sql: `SELECT * FROM waits ORDER BY run_id, step_name`, args: [] },
      { sql: `SELECT * FROM events ORDER BY queue, event_name`, args: [] },
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

/**
 * A stricter dialect may make an invalid stored value unwritable. That is the
 * stronger result, provided the rejected setup itself leaves no partial row.
 */
async function tryInjectCorruption(
  fixture: StoreFixture,
  label: string,
  statements: readonly {
    sql: string
    args: readonly (string | number | bigint | null)[]
  }[],
): Promise<boolean> {
  const before = await durableSnapshot(fixture)
  try {
    await fixture.raw.batch(
      label,
      statements.map(({ sql, args }) => ({ sql, args: [...args] })),
    )
    return true
  } catch {
    expect(await durableSnapshot(fixture)).toEqual(before)
    return false
  }
}

const BOUNDARY_CASES: readonly TimeBoundaryCase[] = [
  {
    id: 'spawn enqueue deadline',
    deltaMs: 1,
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-spawn-enqueue-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-spawn-enqueue-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-spawn-cancellation-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-spawn-cancellation-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-claim-lease-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-claim-lease-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-activation-lease-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-activation-lease-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-activation-max-duration-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-activation-max-duration-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-heartbeat-lease-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-heartbeat-lease-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-lost-launch-relaunch-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-lost-launch-relaunch-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-claim-timeout-successor-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-claim-timeout-successor-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-driver-heartbeat-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-driver-heartbeat-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-reschedule-wake-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-reschedule-wake-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-suspend-wake-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-suspend-wake-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-user-retry-successor-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-user-retry-successor-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-checkpoint-lease-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-checkpoint-lease-overflow',
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
    exactMarker: 'mutation-verdict:behavior:timestamp-addition-event-timeout-exact',
    overflowMarker: 'mutation-verdict:behavior:timestamp-addition-event-timeout-overflow',
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

async function boundaryTargetsAt(
  makeFixture: StoreFixtureFactory,
  testCase: TimeBoundaryCase,
  seed: string,
  nowMs: number,
): Promise<readonly number[]> {
  const fixture = await fixtureAt(makeFixture, seed)
  try {
    const prepared = await testCase.prepare(fixture)
    await fixture.admin.setFakeNowEpochMs(nowMs)
    await prepared.invoke()
    return await prepared.targets()
  } finally {
    fixture.close()
  }
}

async function driverRows(fixture: StoreFixture, label: string) {
  const [drivers] = await fixture.raw.batch(
    label,
    [
      {
        sql: `SELECT driver_id, last_beat_ms, expires_at_ms
              FROM drivers WHERE queue = ? ORDER BY driver_id`,
        args: [Q],
      },
    ],
    'read',
  )
  return drivers?.rows
}

async function driverCleanupRows(
  fixture: StoreFixture,
  victimLastBeatMs: number,
  victimExpiresAtMs: number,
) {
  const sourceDriver = 'cleanup-source'
  const victimDriver = 'cleanup-victim'
  await fixture.raw.batch('time-boundary:driver-cleanup-setup', [
    {
      sql: `INSERT INTO drivers
              (queue, driver_id, last_beat_ms, expires_at_ms)
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      args: [
        Q,
        sourceDriver,
        NORMAL_NOW_MS - 1,
        NORMAL_NOW_MS + 60_000,
        Q,
        victimDriver,
        victimLastBeatMs,
        victimExpiresAtMs,
      ],
    },
  ])
  await fixture.store.driverHeartbeat(Q, sourceDriver, ONE_MS_SECONDS)
  return driverRows(fixture, 'time-boundary:driver-cleanup-after')
}

export function timestampBoundaryConformance(
  dialect: string,
  makeFixture: StoreFixtureFactory,
): void {
  describe(`timestamp boundaries [${dialect}]`, () => {
    for (const testCase of BOUNDARY_CASES) {
      it(`${testCase.id} preserves the epoch predecessor and accepts an exact MAX_EPOCH_MS result`, async () => {
        const exactTargets = await boundaryTargetsAt(
          makeFixture,
          testCase,
          `${testCase.id}:exact`,
          MAX_EPOCH_MS - testCase.deltaMs,
        )
        const belowCeilingTargets = await boundaryTargetsAt(
          makeFixture,
          testCase,
          `${testCase.id}:below-ceiling`,
          MAX_EPOCH_MS - testCase.deltaMs - 1,
        )
        expect(
          {
            exact: exactTargets.length > 0 && exactTargets.every((value) => value === MAX_EPOCH_MS),
            belowCeiling:
              belowCeilingTargets.length > 0 &&
              belowCeilingTargets.every((value) => value === MAX_EPOCH_MS - 1),
          },
          testCase.exactMarker,
        ).toEqual({ exact: true, belowCeiling: true })
      })

      it(`${testCase.id} refuses overflow by one without a partial transition`, async () => {
        const fixture = await fixtureAt(makeFixture, `${testCase.id}:overflow`)
        try {
          const prepared = await testCase.prepare(fixture)
          await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS - testCase.deltaMs + 1)
          const before = await durableSnapshot(fixture)
          await prepared.invoke().catch(() => undefined)
          expect(await durableSnapshot(fixture), testCase.overflowMarker).toEqual(before)
        } finally {
          fixture.close()
        }
      })
    }

    it('driver-heartbeat overflow preserves its source and expired cleanup victim', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:driver-heartbeat-overflow-cleanup')
      try {
        const sourceDriver = 'overflow-source'
        const victimDriver = 'expired-victim'
        const expected = [
          {
            driver_id: victimDriver,
            last_beat_ms: NORMAL_NOW_MS - 3,
            expires_at_ms: NORMAL_NOW_MS - 2,
          },
          {
            driver_id: sourceDriver,
            last_beat_ms: NORMAL_NOW_MS - 1,
            expires_at_ms: NORMAL_NOW_MS + 60_000,
          },
        ]
        await fixture.raw.batch('time-boundary:driver-heartbeat-overflow-cleanup-setup', [
          {
            sql: `INSERT INTO drivers
                    (queue, driver_id, last_beat_ms, expires_at_ms)
                  VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
            args: [
              Q,
              victimDriver,
              NORMAL_NOW_MS - 3,
              NORMAL_NOW_MS - 2,
              Q,
              sourceDriver,
              NORMAL_NOW_MS - 1,
              NORMAL_NOW_MS + 60_000,
            ],
          },
        ])
        const before = await driverRows(
          fixture,
          'time-boundary:driver-heartbeat-overflow-cleanup-before',
        )
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS)

        await fixture.store.driverHeartbeat(Q, sourceDriver, ONE_MS_SECONDS).catch(() => undefined)
        const after = await driverRows(
          fixture,
          'time-boundary:driver-heartbeat-overflow-cleanup-after',
        )
        expect(
          { before, after },
          'mutation-verdict:behavior:timestamp-driver-heartbeat-overflow-preserves-cleanup-inputs',
        ).toEqual({ before: expected, after: expected })
      } finally {
        fixture.close()
      }
    })

    it('driver cleanup refuses an expired row with an invalid last beat', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:driver-cleanup-last-beat')
      try {
        expect(
          await driverCleanupRows(fixture, -1, NORMAL_NOW_MS - 1),
          'mutation-verdict:behavior:timestamp-driver-cleanup-requires-last-beat-bound',
        ).toEqual([
          {
            driver_id: 'cleanup-source',
            last_beat_ms: NORMAL_NOW_MS,
            expires_at_ms: NORMAL_NOW_MS + 1,
          },
          {
            driver_id: 'cleanup-victim',
            last_beat_ms: -1,
            expires_at_ms: NORMAL_NOW_MS - 1,
          },
        ])
      } finally {
        fixture.close()
      }
    })

    it('driver cleanup refuses a row with an invalid expiry', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:driver-cleanup-expiry')
      try {
        expect(
          await driverCleanupRows(fixture, 0, -1),
          'mutation-verdict:behavior:timestamp-driver-cleanup-requires-expiry-bound',
        ).toEqual([
          {
            driver_id: 'cleanup-source',
            last_beat_ms: NORMAL_NOW_MS,
            expires_at_ms: NORMAL_NOW_MS + 1,
          },
          {
            driver_id: 'cleanup-victim',
            last_beat_ms: 0,
            expires_at_ms: -1,
          },
        ])
      } finally {
        fixture.close()
      }
    })

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

        expect(
          await fixture.store.sweep(Q, 1),
          'mutation-verdict:behavior:timestamp-terminal-relaunch-cap-at-max',
        ).toEqual([
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

        expect(
          await fixture.store.sweep(Q, 1),
          'mutation-verdict:behavior:timestamp-terminal-infra-cap-at-max',
        ).toEqual([
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
        expect(
          result,
          'mutation-verdict:behavior:timestamp-terminal-user-failure-at-max',
        ).toMatchObject({ state: 'failed' })
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
          cancellation: { maxDurationSeconds: 0.003 },
        })
        const run = await claimOne(fixture, 'existing-first-start-token', ONE_MS_SECONDS)
        await fixture.raw.batch('time-boundary:existing-first-start', [
          {
            sql: `UPDATE tasks SET first_started_at_ms = ?, cancel_at_ms = ?
                  WHERE task_id = ?`,
            args: [MAX_EPOCH_MS - 4, MAX_EPOCH_MS - 1, task.taskId],
          },
          {
            sql: `UPDATE runs SET started_at_ms = ? WHERE run_id = ?`,
            args: [MAX_EPOCH_MS - 4, run.runId],
          },
        ])
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS - 2)

        expect(
          await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen),
          'mutation-verdict:behavior:timestamp-activation-existing-first-start-at-max',
        ).not.toBeNull()
        expect(
          await scalar(
            fixture,
            `SELECT cancel_at_ms FROM tasks WHERE task_id = ?`,
            [task.taskId],
            'cancel_at_ms',
          ),
        ).toBe(MAX_EPOCH_MS - 1)
        expect(
          await scalar(
            fixture,
            `SELECT claim_expires_at_ms FROM runs WHERE run_id = ?`,
            [run.runId],
            'claim_expires_at_ms',
          ),
        ).toBe(MAX_EPOCH_MS - 1)
      } finally {
        fixture.close()
      }
    })

    it('accepts a max-duration just above the seconds ceiling when it rounds to the ms ceiling', async () => {
      const fixture = await fixtureAt(makeFixture, 'control:activation-rounded-duration-max')
      try {
        const durationSeconds = MAX_DURATION_MS / 1000 + 0.0004
        if (
          durationSeconds <= MAX_DURATION_MS / 1000 ||
          Math.round(durationSeconds * 1000) !== MAX_DURATION_MS
        ) {
          throw new Error('rounded max-duration setup does not straddle the seconds ceiling')
        }
        const firstStartedAtMs = MAX_EPOCH_MS - MAX_DURATION_MS - 1
        await fixture.admin.setFakeNowEpochMs(firstStartedAtMs)
        const task = await spawned(fixture, 'activation-rounded-duration-max', {
          cancellation: { maxDurationSeconds: durationSeconds },
        })
        const run = await claimOne(fixture, 'activation-rounded-duration-max-token')

        const activation = await fixture.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        const [persisted] = await fixture.raw.batch(
          'time-boundary:activation-rounded-duration-max-after',
          [
            {
              sql: `SELECT first_started_at_ms, cancel_at_ms
                    FROM tasks WHERE task_id = ?`,
              args: [task.taskId],
            },
          ],
          'read',
        )
        expect(
          {
            activated: activation !== null,
            task: persisted?.rows[0],
          },
          'mutation-verdict:behavior:timestamp-activation-rounded-duration-max',
        ).toEqual({
          activated: true,
          task: {
            first_started_at_ms: firstStartedAtMs,
            cancel_at_ms: MAX_EPOCH_MS - 1,
          },
        })
      } finally {
        fixture.close()
      }
    })

    it('skips a negative pending availability before the claim limit', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:claim-pending-available-lower')
      try {
        const poison = await spawned(fixture, 'claim-negative-pending')
        const healthy = await spawned(fixture, 'claim-healthy-pending')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:claim-negative-pending',
          [
            {
              sql: `UPDATE runs SET available_at_ms = -1 WHERE run_id = ?`,
              args: [poison.runId],
            },
          ],
        )
        if (!supported) return

        expect(
          (
            await fixture.store.claim(Q, 'claim-negative-pending-token', {
              leaseSeconds: 60,
              limit: 1,
            })
          ).map((run) => run.runId),
          'mutation-verdict:behavior:timestamp-claim-pending-lower-before-limit',
        ).toEqual([healthy.runId])
        const [poisoned] = await fixture.raw.batch(
          'time-boundary:claim-negative-pending-after',
          [
            {
              sql: `SELECT state, available_at_ms FROM runs WHERE run_id = ?`,
              args: [poison.runId],
            },
          ],
          'read',
        )
        expect(poisoned?.rows[0]).toMatchObject({
          state: 'pending',
          available_at_ms: -1,
        })
      } finally {
        fixture.close()
      }
    })

    it('skips a negative wait timeout before the sleeping claim limit', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:claim-sleeping-timeout-lower')
      try {
        const poison = await activated(fixture, 'claim-negative-sleeping')
        const poisonWait = await fixture.store.awaitEvent(
          Q,
          poison.taskId,
          poison.runId,
          poison.claimToken,
          'poison-step',
          'poison-event',
          60,
        )
        if (poisonWait.emitted) throw new Error('poison wait unexpectedly found an event')

        const healthy = await activated(fixture, 'claim-healthy-sleeping')
        const healthyWait = await fixture.store.awaitEvent(
          Q,
          healthy.taskId,
          healthy.runId,
          healthy.claimToken,
          'healthy-step',
          'healthy-event',
          60,
        )
        if (healthyWait.emitted) throw new Error('healthy wait unexpectedly found an event')

        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:claim-negative-sleeping',
          [
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [NORMAL_NOW_MS - 1, poison.runId],
            },
            {
              sql: `UPDATE waits SET timeout_at_ms = -1
                    WHERE run_id = ? AND step_name = ?`,
              args: [poison.runId, 'poison-step'],
            },
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [NORMAL_NOW_MS, healthy.runId],
            },
            {
              sql: `UPDATE waits SET timeout_at_ms = ?
                    WHERE run_id = ? AND step_name = ?`,
              args: [NORMAL_NOW_MS, healthy.runId, 'healthy-step'],
            },
          ],
        )
        if (!supported) return

        expect(
          (
            await fixture.store.claim(Q, 'claim-negative-sleeping-token', {
              leaseSeconds: 60,
              limit: 1,
            })
          ).map((run) => run.runId),
          'mutation-verdict:behavior:timestamp-claim-sleeping-timeout-lower-before-limit',
        ).toEqual([healthy.runId])
        const [poisonedRun, poisonedWait] = await fixture.raw.batch(
          'time-boundary:claim-negative-sleeping-after',
          [
            {
              sql: `SELECT state, available_at_ms FROM runs WHERE run_id = ?`,
              args: [poison.runId],
            },
            {
              sql: `SELECT timeout_at_ms FROM waits
                    WHERE run_id = ? AND step_name = ?`,
              args: [poison.runId, 'poison-step'],
            },
          ],
          'read',
        )
        expect(poisonedRun?.rows[0]).toMatchObject({
          state: 'sleeping',
          available_at_ms: NORMAL_NOW_MS - 1,
        })
        expect(poisonedWait?.rows[0]).toMatchObject({ timeout_at_ms: -1 })
      } finally {
        fixture.close()
      }
    })

    it('skips an out-of-range cancellation deadline before the claim limit', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:claim-cancel-upper')
      try {
        const poison = await spawned(fixture, 'claim-invalid-cancellation', {
          cancellation: { maxDelaySeconds: 60 },
        })
        const healthy = await spawned(fixture, 'claim-healthy-cancellation')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:claim-invalid-cancellation',
          [
            {
              sql: `UPDATE tasks SET cancel_at_ms = ? WHERE task_id = ?`,
              args: [MAX_EPOCH_MS + 1, poison.taskId],
            },
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [NORMAL_NOW_MS - 1, poison.runId],
            },
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [NORMAL_NOW_MS, healthy.runId],
            },
          ],
        )
        if (!supported) return

        expect(
          (
            await fixture.store.claim(Q, 'claim-invalid-cancellation-token', {
              leaseSeconds: 60,
              limit: 1,
            })
          ).map((run) => run.runId),
          'mutation-verdict:behavior:timestamp-claim-cancellation-upper-before-limit',
        ).toEqual([healthy.runId])
      } finally {
        fixture.close()
      }
    })

    for (const activatedBeforeExpiry of [false, true]) {
      const branch = activatedBeforeExpiry ? 'claim-timeout' : 'lost-launch'

      it(`${branch} sweep skips a negative claim expiry before its limit`, async () => {
        const fixture = await fixtureAt(makeFixture, `consumer:${branch}-expiry-lower`)
        try {
          await spawned(fixture, `${branch}-negative-expiry`)
          const poison = await claimOne(fixture, `${branch}-negative-expiry-token`)
          if (activatedBeforeExpiry) {
            const activation = await fixture.store.activate(
              Q,
              poison.runId,
              poison.claimToken,
              poison.claimGen,
            )
            if (!activation) throw new Error(`${branch} setup lost activation`)
          }

          await spawned(fixture, `${branch}-healthy-expiry`)
          const healthy = await claimOne(fixture, `${branch}-healthy-expiry-token`)
          if (activatedBeforeExpiry) {
            const activation = await fixture.store.activate(
              Q,
              healthy.runId,
              healthy.claimToken,
              healthy.claimGen,
            )
            if (!activation) throw new Error(`${branch} healthy setup lost activation`)
          }
          const supported = await tryInjectCorruption(
            fixture,
            'time-boundary:negative-claim-expiry',
            [
              {
                sql: `UPDATE runs SET claim_expires_at_ms = -1 WHERE run_id = ?`,
                args: [poison.runId],
              },
              {
                sql: `UPDATE runs SET claim_expires_at_ms = ? WHERE run_id = ?`,
                args: [NORMAL_NOW_MS - 1, healthy.runId],
              },
            ],
          )
          if (!supported) return

          const swept = await fixture.store.sweep(Q, 1)
          if (activatedBeforeExpiry) {
            expect(
              swept,
              'mutation-verdict:behavior:timestamp-sweep-timeout-lower-before-limit',
            ).toMatchObject([
              {
                kind: 'claim-timeout',
                runId: healthy.runId,
                taskId: healthy.taskId,
              },
            ])
          } else {
            expect(
              swept,
              'mutation-verdict:behavior:timestamp-sweep-lost-launch-lower-before-limit',
            ).toEqual([
              {
                kind: 'lost-launch',
                runId: healthy.runId,
                taskId: healthy.taskId,
                relaunchCount: 1,
              },
            ])
          }
          const [poisoned] = await fixture.raw.batch(
            'time-boundary:negative-claim-expiry-after',
            [
              {
                sql: `SELECT state, claim_expires_at_ms FROM runs WHERE run_id = ?`,
                args: [poison.runId],
              },
            ],
            'read',
          )
          expect(poisoned?.rows[0]).toMatchObject({
            state: 'running',
            claim_expires_at_ms: -1,
          })
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

          let supported = false
          let afterCorruption: unknown
          const interposed = interposeAfterBatch(fixture.raw, 'sweep:scan', async () => {
            supported = await tryInjectCorruption(fixture, 'time-boundary:claim-expiry-race', [
              {
                sql: `UPDATE runs SET claim_expires_at_ms = -1 WHERE run_id = ?`,
                args: [run.runId],
              },
            ])
            if (supported) afterCorruption = await durableSnapshot(fixture)
          })

          const swept = await fixture.storeOver(interposed.executor).sweep(Q, 1)
          if (!supported) return
          if (activatedBeforeExpiry) {
            expect(
              swept,
              'mutation-verdict:behavior:timestamp-sweep-timeout-rechecks-expiry-bound',
            ).toEqual([])
          } else {
            expect(
              swept,
              'mutation-verdict:behavior:timestamp-sweep-lost-launch-rechecks-expiry-bound',
            ).toEqual([])
          }
          expect(interposed.fired()).toBe(true)
          expect(afterCorruption).toBeDefined()
          expect(await durableSnapshot(fixture)).toEqual(afterCorruption)
        } finally {
          fixture.close()
        }
      })
    }

    it('nextWakeAt skips a negative pending availability', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:next-wake-pending-lower')
      try {
        const poison = await spawned(fixture, 'next-wake-negative-pending')
        const healthy = await spawned(fixture, 'next-wake-healthy-pending')
        const healthyWake = NORMAL_NOW_MS + 10
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:next-wake-negative-pending',
          [
            {
              sql: `UPDATE runs SET available_at_ms = -1 WHERE run_id = ?`,
              args: [poison.runId],
            },
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [healthyWake, healthy.runId],
            },
          ],
        )
        if (!supported) return

        const observed = await fixture.store.nextWakeAtEpochMs(Q).catch((error: unknown) => error)
        expect(observed, 'mutation-verdict:behavior:timestamp-next-wake-pending-lower').toBe(
          healthyWake,
        )
      } finally {
        fixture.close()
      }
    })

    it('nextWakeAt skips a negative sleeping availability', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:next-wake-sleeping-lower')
      try {
        const poison = await activated(fixture, 'next-wake-negative-sleeping')
        await fixture.store.reschedule(Q, poison.runId, poison.claimToken, {
          inSeconds: 60,
        })
        const healthy = await activated(fixture, 'next-wake-healthy-sleeping')
        await fixture.store.reschedule(Q, healthy.runId, healthy.claimToken, {
          inSeconds: 60,
        })
        const healthyWake = NORMAL_NOW_MS + 10
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:next-wake-negative-sleeping',
          [
            {
              sql: `UPDATE runs SET available_at_ms = -1 WHERE run_id = ?`,
              args: [poison.runId],
            },
            {
              sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = ?`,
              args: [healthyWake, healthy.runId],
            },
          ],
        )
        if (!supported) return

        const observed = await fixture.store.nextWakeAtEpochMs(Q).catch((error: unknown) => error)
        expect(observed, 'mutation-verdict:behavior:timestamp-next-wake-sleeping-lower').toBe(
          healthyWake,
        )
      } finally {
        fixture.close()
      }
    })

    it('nextWakeAt skips a negative running claim expiry', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:next-wake-expiry-lower')
      try {
        await spawned(fixture, 'next-wake-negative-expiry')
        const poison = await claimOne(fixture, 'next-wake-negative-expiry-token')
        await spawned(fixture, 'next-wake-healthy-expiry')
        const healthy = await claimOne(fixture, 'next-wake-healthy-expiry-token')
        const healthyWake = NORMAL_NOW_MS + 10
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:next-wake-negative-expiry',
          [
            {
              sql: `UPDATE runs SET claim_expires_at_ms = -1 WHERE run_id = ?`,
              args: [poison.runId],
            },
            {
              sql: `UPDATE runs SET claim_expires_at_ms = ? WHERE run_id = ?`,
              args: [healthyWake, healthy.runId],
            },
          ],
        )
        if (!supported) return

        const observed = await fixture.store.nextWakeAtEpochMs(Q).catch((error: unknown) => error)
        expect(observed, 'mutation-verdict:behavior:timestamp-next-wake-expiry-lower').toBe(
          healthyWake,
        )
      } finally {
        fixture.close()
      }
    })

    it('nextWakeAt skips a negative cancellation deadline', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:next-wake-cancel-lower')
      try {
        const poison = await spawned(fixture, 'next-wake-negative-cancel', {
          cancellation: { maxDelaySeconds: 60 },
        })
        const healthy = await spawned(fixture, 'next-wake-healthy-cancel', {
          cancellation: { maxDelaySeconds: 60 },
        })
        const healthyWake = NORMAL_NOW_MS + 10
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:next-wake-negative-cancel',
          [
            {
              sql: `UPDATE runs SET available_at_ms = NULL WHERE run_id IN (?, ?)`,
              args: [poison.runId, healthy.runId],
            },
            {
              sql: `UPDATE tasks SET cancel_at_ms = -1 WHERE task_id = ?`,
              args: [poison.taskId],
            },
            {
              sql: `UPDATE tasks SET cancel_at_ms = ? WHERE task_id = ?`,
              args: [healthyWake, healthy.taskId],
            },
          ],
        )
        if (!supported) return

        const observed = await fixture.store.nextWakeAtEpochMs(Q).catch((error: unknown) => error)
        expect(observed, 'mutation-verdict:behavior:timestamp-next-wake-cancel-lower').toBe(
          healthyWake,
        )
      } finally {
        fixture.close()
      }
    })

    it('expireLeaseNow refuses to launder an out-of-range stored expiry', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:expire-lease-upper')
      try {
        const run = await activated(fixture, 'expire-lease-invalid-expiry')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:expire-lease-invalid-expiry',
          [
            {
              sql: `UPDATE runs SET claim_expires_at_ms = ? WHERE run_id = ?`,
              args: [MAX_EPOCH_MS + 1, run.runId],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        const expired = await fixture.store.expireLeaseNow(Q, run.runId, run.claimToken)
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-expire-lease-validates-expiry-upper',
        ).toEqual(before)
        expect(expired).toBe(false)
      } finally {
        fixture.close()
      }
    })

    it('emit skips an invalid timed wait while delivering a healthy peer', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:emit-wait-lower')
      try {
        const poison = await activated(fixture, 'emit-negative-wait')
        const poisonWait = await fixture.store.awaitEvent(
          Q,
          poison.taskId,
          poison.runId,
          poison.claimToken,
          'poison-emit-step',
          'shared-emit-event',
          60,
        )
        if (poisonWait.emitted) throw new Error('poison emit wait unexpectedly found an event')

        const healthy = await activated(fixture, 'emit-healthy-wait')
        const healthyWait = await fixture.store.awaitEvent(
          Q,
          healthy.taskId,
          healthy.runId,
          healthy.claimToken,
          'healthy-emit-step',
          'shared-emit-event',
          60,
        )
        if (healthyWait.emitted) throw new Error('healthy emit wait unexpectedly found an event')

        const supported = await tryInjectCorruption(fixture, 'time-boundary:emit-negative-wait', [
          {
            sql: `UPDATE runs SET available_at_ms = -1 WHERE run_id = ?`,
            args: [poison.runId],
          },
          {
            sql: `UPDATE waits SET timeout_at_ms = -1
                    WHERE run_id = ? AND step_name = ?`,
            args: [poison.runId, 'poison-emit-step'],
          },
        ])
        if (!supported) return

        await fixture.store.emitEvent(Q, 'shared-emit-event', '{"ok":true}')
        const [poisonRun, healthyRun, poisonRegistration, healthyRegistration, event] =
          await fixture.raw.batch(
            'time-boundary:emit-negative-wait-after',
            [
              {
                sql: `SELECT state, available_at_ms, event_payload
                      FROM runs WHERE run_id = ?`,
                args: [poison.runId],
              },
              {
                sql: `SELECT state, available_at_ms, event_payload
                      FROM runs WHERE run_id = ?`,
                args: [healthy.runId],
              },
              {
                sql: `SELECT timeout_at_ms FROM waits
                      WHERE run_id = ? AND step_name = ?`,
                args: [poison.runId, 'poison-emit-step'],
              },
              {
                sql: `SELECT COUNT(*) AS count FROM waits
                      WHERE run_id = ? AND step_name = ?`,
                args: [healthy.runId, 'healthy-emit-step'],
              },
              {
                sql: `SELECT payload, emitted_at_ms FROM events
                      WHERE queue = ? AND event_name = ?`,
                args: [Q, 'shared-emit-event'],
              },
            ],
            'read',
          )
        expect(
          {
            poisonRun: poisonRun?.rows[0],
            healthyRun: healthyRun?.rows[0],
            poisonRegistration: poisonRegistration?.rows[0],
            healthyRegistrationCount: exactEpochInteger(
              healthyRegistration?.rows[0]?.count,
              'healthy-registration-count',
            ),
            event: event?.rows[0],
          },
          'mutation-verdict:behavior:timestamp-emit-validates-timed-wait-lower',
        ).toEqual({
          poisonRun: {
            state: 'sleeping',
            available_at_ms: -1,
            event_payload: null,
          },
          healthyRun: {
            state: 'pending',
            available_at_ms: NORMAL_NOW_MS,
            event_payload: '{"ok":true}',
          },
          poisonRegistration: { timeout_at_ms: -1 },
          healthyRegistrationCount: 0,
          event: { payload: '{"ok":true}', emitted_at_ms: NORMAL_NOW_MS },
        })
      } finally {
        fixture.close()
      }
    })

    it('activation refuses a negative persisted first-start instant atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:activation-first-start-lower')
      try {
        await spawned(fixture, 'activation-negative-first-start', {
          cancellation: { maxDurationSeconds: 60 },
        })
        const first = await claimOne(fixture, 'activation-negative-first-start-first')
        const firstActivation = await fixture.store.activate(
          Q,
          first.runId,
          first.claimToken,
          first.claimGen,
        )
        if (!firstActivation) throw new Error('first-start setup lost its first activation')
        await fixture.store.fail(Q, first.runId, first.claimToken, '{"name":"retry"}', {
          delaySeconds: 0,
        })
        const second = await claimOne(fixture, 'activation-negative-first-start-second')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:activation-negative-first-start',
          [
            {
              sql: `UPDATE tasks SET first_started_at_ms = -1 WHERE task_id = ?`,
              args: [second.taskId],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        const activation = await fixture.store
          .activate(Q, second.runId, second.claimToken, second.claimGen)
          .catch((error: unknown) => error)
        expect(await durableSnapshot(fixture)).toEqual(before)
        expect(activation).toBeNull()
      } finally {
        fixture.close()
      }
    })

    it('activation refuses a negative stored max-duration atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:activation-duration-lower')
      try {
        await spawned(fixture, 'activation-negative-duration', {
          cancellation: { maxDurationSeconds: 60 },
        })
        const run = await claimOne(fixture, 'activation-negative-duration-token')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:activation-negative-duration',
          [
            {
              sql: `UPDATE tasks SET cancellation = ? WHERE task_id = ?`,
              args: [JSON.stringify({ maxDurationSeconds: -1 }), run.taskId],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        const activation = await fixture.store
          .activate(Q, run.runId, run.claimToken, run.claimGen)
          .catch((error: unknown) => error)
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-activation-validates-stored-duration-lower',
        ).toEqual(before)
        expect(activation).toBeNull()
      } finally {
        fixture.close()
      }
    })

    it('activation refuses a stored max-duration above the duration bound atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:activation-duration-upper')
      try {
        await spawned(fixture, 'activation-oversized-duration', {
          cancellation: { maxDurationSeconds: 60 },
        })
        const run = await claimOne(fixture, 'activation-oversized-duration-token')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:activation-oversized-duration',
          [
            {
              sql: `UPDATE tasks SET cancellation = ? WHERE task_id = ?`,
              args: [
                JSON.stringify({
                  maxDurationSeconds: MAX_DURATION_MS / 1000 + 1,
                }),
                run.taskId,
              ],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        const activation = await fixture.store
          .activate(Q, run.runId, run.claimToken, run.claimGen)
          .catch((error: unknown) => error)
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-activation-validates-stored-duration-upper',
        ).toEqual(before)
        expect(activation).toBeNull()
      } finally {
        fixture.close()
      }
    })

    it('activation refuses a coercible string max-duration atomically', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:activation-duration-storage')
      try {
        await spawned(fixture, 'activation-string-duration', {
          cancellation: { maxDurationSeconds: 60 },
        })
        const run = await claimOne(fixture, 'activation-string-duration-token')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:activation-string-duration',
          [
            {
              sql: `UPDATE tasks SET cancellation = ? WHERE task_id = ?`,
              args: [JSON.stringify({ maxDurationSeconds: '60' }), run.taskId],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        const activation = await fixture.store
          .activate(Q, run.runId, run.claimToken, run.claimGen)
          .catch((error: unknown) => error)
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-activation-validates-stored-duration-storage',
        ).toEqual(before)
        expect(activation).toBeNull()
      } finally {
        fixture.close()
      }
    })

    it('re-emission refuses to propagate a negative stored event instant', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:event-emitted-lower')
      try {
        const run = await activated(fixture, 'event-negative-emitted')
        const wait = await fixture.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          'event-step',
          'stored-event',
          null,
        )
        if (wait.emitted) throw new Error('event propagation setup unexpectedly found an event')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:event-negative-emitted',
          [
            {
              sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                    VALUES (?, ?, ?, -1)`,
              args: [Q, 'stored-event', '{"stored":true}'],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        await fixture.store.emitEvent(Q, 'stored-event', '{"replacement":true}').catch(() => {})
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-emit-validates-existing-emitted-lower',
        ).toEqual(before)
      } finally {
        fixture.close()
      }
    })

    it('re-emission refuses to propagate an event instant above the epoch bound', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:event-emitted-upper')
      try {
        const run = await activated(fixture, 'event-oversized-emitted')
        const wait = await fixture.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          'event-step',
          'oversized-stored-event',
          null,
        )
        if (wait.emitted) throw new Error('event propagation setup unexpectedly found an event')
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:event-oversized-emitted',
          [
            {
              sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                    VALUES (?, ?, ?, ?)`,
              args: [Q, 'oversized-stored-event', '{"stored":true}', MAX_EPOCH_MS + 1],
            },
          ],
        )
        if (!supported) return
        const before = await durableSnapshot(fixture)

        await fixture.store
          .emitEvent(Q, 'oversized-stored-event', '{"replacement":true}')
          .catch(() => {})
        expect(
          await durableSnapshot(fixture),
          'mutation-verdict:behavior:timestamp-emit-validates-existing-emitted-upper',
        ).toEqual(before)
      } finally {
        fixture.close()
      }
    })

    it('re-emission preserves and propagates a valid event instant at the epoch ceiling', async () => {
      const fixture = await fixtureAt(makeFixture, 'control:event-emitted-max')
      try {
        const run = await activated(fixture, 'event-max-emitted')
        const wait = await fixture.store.awaitEvent(
          Q,
          run.taskId,
          run.runId,
          run.claimToken,
          'event-step',
          'max-stored-event',
          null,
        )
        if (wait.emitted) throw new Error('event ceiling setup unexpectedly found an event')
        await fixture.raw.batch('time-boundary:event-max-emitted', [
          {
            sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                  VALUES (?, ?, ?, ?)`,
            args: [Q, 'max-stored-event', '{"stored":true}', MAX_EPOCH_MS],
          },
        ])
        await fixture.admin.setFakeNowEpochMs(MAX_EPOCH_MS)

        await fixture.store.emitEvent(Q, 'max-stored-event', '{"replacement":true}')
        const [event, woken, registration] = await fixture.raw.batch(
          'time-boundary:event-max-emitted-after',
          [
            {
              sql: `SELECT payload, emitted_at_ms FROM events
                    WHERE queue = ? AND event_name = ?`,
              args: [Q, 'max-stored-event'],
            },
            {
              sql: `SELECT state, available_at_ms, event_payload
                    FROM runs WHERE run_id = ?`,
              args: [run.runId],
            },
            {
              sql: `SELECT COUNT(*) AS count FROM waits
                    WHERE run_id = ? AND step_name = ?`,
              args: [run.runId, 'event-step'],
            },
          ],
          'read',
        )
        expect(
          {
            event: event?.rows[0],
            run: woken?.rows[0],
            registrationCount: exactEpochInteger(
              registration?.rows[0]?.count,
              'max-event-registration-count',
            ),
          },
          'mutation-verdict:behavior:timestamp-emit-preserves-existing-emitted-max',
        ).toEqual({
          event: { payload: '{"stored":true}', emitted_at_ms: MAX_EPOCH_MS },
          run: {
            state: 'pending',
            available_at_ms: MAX_EPOCH_MS,
            event_payload: '{"stored":true}',
          },
          registrationCount: 0,
        })
      } finally {
        fixture.close()
      }
    })

    it('the boundary oracle rejects parseable timestamp text', () => {
      expect(
        () => exactEpochInteger(String(NORMAL_NOW_MS), 'text-probe'),
        'mutation-verdict:behavior:timestamp-boundary-oracle-rejects-text',
      ).toThrow(/exact native integer/)
    })

    it('the boundary oracle rejects a fractional timestamp number', () => {
      expect(
        () => exactEpochInteger(NORMAL_NOW_MS + 0.5, 'fractional-probe'),
        'mutation-verdict:behavior:timestamp-boundary-oracle-rejects-fractional',
      ).toThrow(/exact native integer/)
    })

    it('deadline cancellation skips a negative deadline before its limit', async () => {
      const fixture = await fixtureAt(makeFixture, 'consumer:cancel-deadline-lower')
      try {
        const poison = await spawned(fixture, 'cancel-negative-deadline', {
          cancellation: { maxDelaySeconds: 60 },
        })
        const healthy = await spawned(fixture, 'cancel-healthy-deadline', {
          cancellation: { maxDelaySeconds: 60 },
        })
        const supported = await tryInjectCorruption(
          fixture,
          'time-boundary:cancel-negative-deadline',
          [
            {
              sql: `UPDATE tasks SET cancel_at_ms = -1 WHERE task_id = ?`,
              args: [poison.taskId],
            },
            {
              sql: `UPDATE tasks SET cancel_at_ms = ? WHERE task_id = ?`,
              args: [NORMAL_NOW_MS - 1, healthy.taskId],
            },
          ],
        )
        if (!supported) return

        expect(
          await fixture.store.sweep(Q, 1),
          'mutation-verdict:behavior:timestamp-cancel-lower-before-limit',
        ).toEqual([
          {
            kind: 'cancelled',
            taskId: healthy.taskId,
            runId: healthy.runId,
          },
        ])
        const [poisonedTask, poisonedRun] = await fixture.raw.batch(
          'time-boundary:cancel-negative-deadline-after',
          [
            {
              sql: `SELECT state, cancel_at_ms FROM tasks WHERE task_id = ?`,
              args: [poison.taskId],
            },
            {
              sql: `SELECT state FROM runs WHERE run_id = ?`,
              args: [poison.runId],
            },
          ],
          'read',
        )
        expect(poisonedTask?.rows[0]).toMatchObject({
          state: 'pending',
          cancel_at_ms: -1,
        })
        expect(poisonedRun?.rows[0]).toMatchObject({ state: 'pending' })
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

        let supported = false
        let afterCorruption: unknown
        const interposed = interposeAfterBatch(fixture.raw, 'sweep:scan', async () => {
          supported = await tryInjectCorruption(fixture, 'time-boundary:cancel-deadline-race', [
            {
              sql: `UPDATE tasks SET cancel_at_ms = -1 WHERE task_id = ?`,
              args: [task.taskId],
            },
          ])
          if (supported) afterCorruption = await durableSnapshot(fixture)
        })

        const swept = await fixture.storeOver(interposed.executor).sweep(Q, 1)
        if (!supported) return
        expect(swept, 'mutation-verdict:behavior:timestamp-cancel-rechecks-deadline-bound').toEqual(
          [],
        )
        expect(interposed.fired()).toBe(true)
        expect(afterCorruption).toBeDefined()
        expect(await durableSnapshot(fixture)).toEqual(afterCorruption)
      } finally {
        fixture.close()
      }
    })
  })
}
