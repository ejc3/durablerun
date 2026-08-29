import {
  type Clock,
  type IdSource,
  LaunchOutcome,
  parseTaskValueJson,
  serializeTaskValue,
  systemClock,
  systemIdSource,
} from '@durablerun/core'
import { tick, type TickResult } from '@durablerun/driver'
import { runClaimedRun, type WorkerOutcome } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import type { DogfoodConfig } from './config.js'
import {
  repoHealthRegistry,
  type RepositorySnapshot,
  type SnapshotRepository,
  snapshotGitHubRepository,
} from './repo-health.js'

export interface DogfoodStartResult {
  taskId: string
  runId: string | null
  created: boolean
  queue: string
  idempotencyKey: string
}

export type DogfoodStatus =
  | { found: false; queue: string; idempotencyKey: string }
  | {
      found: true
      queue: string
      idempotencyKey: string
      taskId: string
      state: string
      attempts: number
      infraRetries: number
      failureReason: unknown | null
      completedResult: unknown | null
      integrityCheckpoints: readonly RepositorySnapshot[]
      relaunches: number
      firstStartedAtEpochMs: number | null
      lastCheckpointAtEpochMs: number | null
      observedSpanMs: number | null
    }

function endingKind(outcome: WorkerOutcome): 'completed' | 'failed' | 'crashed' | 'unknown' {
  if (outcome.kind === 'completed') return 'completed'
  if (outcome.kind === 'failed') return 'failed'
  if (outcome.kind === 'aborted' || outcome.kind === 'lease-lost') return 'crashed'
  return 'unknown'
}

function optionalJson(value: unknown): unknown | null {
  return typeof value === 'string' ? parseTaskValueJson(value) : null
}

function checkpointOrdinal(name: string): number | null {
  if (name === 'integrity') return 1
  const match = /^integrity#([2-9][0-9]*)$/.exec(name)
  return match ? Number(match[1]) : null
}

export class DogfoodRuntime {
  readonly #raw: LibsqlExecutor
  readonly #store: LibsqlSchedulerStore
  readonly #config: DogfoodConfig
  readonly #ids: IdSource
  readonly #clock: Clock
  readonly #snapshot: SnapshotRepository

  private constructor(
    raw: LibsqlExecutor,
    config: DogfoodConfig,
    deps: { ids: IdSource; clock: Clock; snapshot: SnapshotRepository },
  ) {
    this.#raw = raw
    this.#config = config
    this.#ids = deps.ids
    this.#clock = deps.clock
    this.#snapshot = deps.snapshot
    this.#store = new LibsqlSchedulerStore(raw, deps.ids)
  }

  static async open(
    config: DogfoodConfig,
    deps: {
      ids?: IdSource
      clock?: Clock
      snapshot?: SnapshotRepository
    } = {},
  ): Promise<DogfoodRuntime> {
    const raw = LibsqlExecutor.open(config.databaseUrl, config.authToken)
    try {
      await new LibsqlStoreAdmin(raw).migrate()
      return new DogfoodRuntime(raw, config, {
        ids: deps.ids ?? systemIdSource(),
        clock: deps.clock ?? systemClock(),
        snapshot: deps.snapshot ?? snapshotGitHubRepository,
      })
    } catch (error) {
      raw.close()
      throw error
    }
  }

  async start(): Promise<DogfoodStartResult> {
    const paramsJson = serializeTaskValue('repo-health parameters', {
      repository: this.#config.repository,
      ref: this.#config.ref,
      cycles: this.#config.cycles,
      intervalSeconds: this.#config.intervalSeconds,
    })
    const result = await this.#store.spawn(this.#config.queue, 'repo-health', paramsJson, {
      idempotencyKey: this.#config.idempotencyKey,
    })
    return {
      ...result,
      queue: this.#config.queue,
      idempotencyKey: this.#config.idempotencyKey,
    }
  }

  async tick(): Promise<TickResult> {
    const registry = repoHealthRegistry(this.#snapshot)
    return tick(
      {
        store: this.#store,
        ids: this.#ids,
        launcher: {
          launch: async (invocation) => {
            const outcome = await runClaimedRun(
              { store: this.#store, clock: this.#clock, registry },
              invocation,
            )
            return LaunchOutcome.ended({
              runId: invocation.runId,
              claimToken: invocation.claimToken,
              kind: endingKind(outcome),
            })
          },
        },
      },
      { queue: this.#config.queue, claimLimit: 1, sweepLimit: 10, leaseSeconds: 30 },
    )
  }

  async status(): Promise<DogfoodStatus> {
    const [tasks] = await this.#raw.batch(
      'dogfood:status-task',
      [
        {
          sql: `SELECT task_id, state, attempts, infra_retries, failure_reason,
                       completed_payload, first_started_at_ms
                FROM tasks WHERE queue = ? AND idempotency_key = ?`,
          args: [this.#config.queue, this.#config.idempotencyKey],
        },
      ],
      'read',
    )
    const task = tasks?.rows[0]
    if (!task) {
      return {
        found: false,
        queue: this.#config.queue,
        idempotencyKey: this.#config.idempotencyKey,
      }
    }
    const taskId = String(task.task_id)
    const [checkpoints, runs] = await this.#raw.batch(
      'dogfood:status-details',
      [
        {
          sql: `SELECT checkpoint_name, state, updated_at_ms
                FROM checkpoints WHERE task_id = ? AND queue = ?`,
          args: [taskId, this.#config.queue],
        },
        {
          sql: `SELECT COALESCE(SUM(relaunch_count), 0) AS relaunches
                FROM runs WHERE task_id = ? AND queue = ?`,
          args: [taskId, this.#config.queue],
        },
      ],
      'read',
    )
    const integrity = (checkpoints?.rows ?? [])
      .map((row) => ({
        ordinal: checkpointOrdinal(String(row.checkpoint_name)),
        snapshot: optionalJson(row.state),
        updatedAt: Number(row.updated_at_ms),
      }))
      .filter(
        (item): item is { ordinal: number; snapshot: RepositorySnapshot; updatedAt: number } =>
          item.ordinal !== null && item.snapshot !== null,
      )
      .sort((a, b) => a.ordinal - b.ordinal)
    const firstStartedAtEpochMs =
      task.first_started_at_ms === null ? null : Number(task.first_started_at_ms)
    const lastCheckpointAtEpochMs =
      integrity.length === 0 ? null : Math.max(...integrity.map((item) => item.updatedAt))
    return {
      found: true,
      queue: this.#config.queue,
      idempotencyKey: this.#config.idempotencyKey,
      taskId,
      state: String(task.state),
      attempts: Number(task.attempts),
      infraRetries: Number(task.infra_retries),
      failureReason: optionalJson(task.failure_reason),
      completedResult: optionalJson(task.completed_payload),
      integrityCheckpoints: integrity.map((item) => item.snapshot),
      relaunches: Number(runs?.rows[0]?.relaunches ?? 0),
      firstStartedAtEpochMs,
      lastCheckpointAtEpochMs,
      observedSpanMs:
        firstStartedAtEpochMs === null || lastCheckpointAtEpochMs === null
          ? null
          : lastCheckpointAtEpochMs - firstStartedAtEpochMs,
    }
  }

  close(): void {
    this.#raw.close()
  }
}
