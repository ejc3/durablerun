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
import type { DogfoodConfig, DogfoodFault } from './config.js'
import {
  type ObserveRepositoryRef,
  observeGitHubRef,
  type RefObservation,
  refJournalRegistry,
} from './ref-journal.js'

export interface DogfoodStartResult {
  taskId: string
  runId: string | null
  created: boolean
  queue: string
  idempotencyKey: string
}

export interface RefObservationCheckpoint {
  ordinal: number
  key: string
  observedAtEpochMs: number
  ownerRunId: string
  ownerAttempt: number
  snapshot: RefObservation
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
      expectedCheckpointCount: number | null
      observedCheckpointCount: number
      contiguousCheckpointCount: number
      refObservations: readonly RefObservationCheckpoint[]
      relaunches: number
      checkpointSpanMs: number | null
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
  if (name === 'observe-ref') return 1
  const match = /^observe-ref#([1-9][0-9]*)$/.exec(name)
  if (!match) return null
  const ordinal = Number(match[1])
  return Number.isSafeInteger(ordinal) && ordinal >= 2 ? ordinal : null
}

function expectedCheckpointCount(value: unknown): number | null {
  const parsed = optionalJson(value)
  if (parsed === null || typeof parsed !== 'object') return null
  const cycles = (parsed as Record<string, unknown>).cycles
  return typeof cycles === 'number' && Number.isSafeInteger(cycles) && cycles >= 1 ? cycles : null
}

export class DogfoodRuntime {
  readonly #raw: LibsqlExecutor
  readonly #store: LibsqlSchedulerStore
  readonly #config: DogfoodConfig
  readonly #ids: IdSource
  readonly #clock: Clock
  readonly #observe: ObserveRepositoryRef
  readonly #fault: DogfoodFault
  readonly #hardExit: (code: number) => never

  private constructor(
    raw: LibsqlExecutor,
    config: DogfoodConfig,
    deps: {
      ids: IdSource
      clock: Clock
      observe: ObserveRepositoryRef
      fault: DogfoodFault
      hardExit: (code: number) => never
    },
  ) {
    this.#raw = raw
    this.#config = config
    this.#ids = deps.ids
    this.#clock = deps.clock
    this.#observe = deps.observe
    this.#fault = deps.fault
    this.#hardExit = deps.hardExit
    this.#store = new LibsqlSchedulerStore(raw, deps.ids)
  }

  static async open(
    config: DogfoodConfig,
    deps: {
      ids?: IdSource
      clock?: Clock
      observe?: ObserveRepositoryRef
      fault?: DogfoodFault
      hardExit?: (code: number) => never
    } = {},
  ): Promise<DogfoodRuntime> {
    const raw = LibsqlExecutor.open(config.databaseUrl, config.authToken)
    try {
      await new LibsqlStoreAdmin(raw).migrate()
      return new DogfoodRuntime(raw, config, {
        ids: deps.ids ?? systemIdSource(),
        clock: deps.clock ?? systemClock(),
        observe: deps.observe ?? observeGitHubRef,
        fault: deps.fault ?? config.fault,
        hardExit: deps.hardExit ?? ((code): never => process.exit(code)),
      })
    } catch (error) {
      raw.close()
      throw error
    }
  }

  async start(): Promise<DogfoodStartResult> {
    const paramsJson = serializeTaskValue('ref-journal parameters', {
      repository: this.#config.repository,
      ref: this.#config.ref,
      cycles: this.#config.cycles,
      intervalSeconds: this.#config.intervalSeconds,
    })
    const result = await this.#store.spawn(this.#config.queue, 'ref-journal', paramsJson, {
      idempotencyKey: this.#config.idempotencyKey,
    })
    return {
      ...result,
      queue: this.#config.queue,
      idempotencyKey: this.#config.idempotencyKey,
    }
  }

  async tick(): Promise<TickResult> {
    const registry = refJournalRegistry(this.#observe, () => {
      if (this.#fault === 'worker-after-checkpoint') this.#hardExit(87)
    })
    return tick(
      {
        store: this.#store,
        ids: this.#ids,
        launcher: {
          launch: async (invocation) => {
            if (this.#fault === 'driver-before-activation') this.#hardExit(86)
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
      {
        queue: this.#config.queue,
        claimLimit: 1,
        sweepLimit: 10,
        leaseSeconds: this.#config.leaseSeconds,
      },
    )
  }

  async status(): Promise<DogfoodStatus> {
    const [tasks] = await this.#raw.batch(
      'dogfood:status-task',
      [
        {
          sql: `SELECT task_id, state, attempts, infra_retries, failure_reason,
                       completed_payload, params
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
          sql: `SELECT checkpoint_name, state, updated_at_ms, owner_run_id, owner_attempt
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
    const observations = (checkpoints?.rows ?? [])
      .map((row) => ({
        ordinal: checkpointOrdinal(String(row.checkpoint_name)),
        snapshot: optionalJson(row.state),
        key: String(row.checkpoint_name),
        observedAtEpochMs: Number(row.updated_at_ms),
        ownerRunId: String(row.owner_run_id),
        ownerAttempt: Number(row.owner_attempt),
      }))
      .filter(
        (item): item is RefObservationCheckpoint => item.ordinal !== null && item.snapshot !== null,
      )
      .sort((a, b) => a.ordinal - b.ordinal)
    let contiguousCheckpointCount = 0
    for (const observation of observations) {
      if (observation.ordinal !== contiguousCheckpointCount + 1) break
      contiguousCheckpointCount++
    }
    const first = observations[0]
    const last = observations.at(-1)
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
      expectedCheckpointCount: expectedCheckpointCount(task.params),
      observedCheckpointCount: observations.length,
      contiguousCheckpointCount,
      refObservations: observations,
      relaunches: Number(runs?.rows[0]?.relaunches ?? 0),
      checkpointSpanMs:
        first === undefined || last === undefined
          ? null
          : last.observedAtEpochMs - first.observedAtEpochMs,
    }
  }

  close(): void {
    this.#raw.close()
  }
}
