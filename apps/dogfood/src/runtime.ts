import {
  type Clock,
  type IdSource,
  TASK_RESULT_COLUMNS,
  decodeTaskResult,
  parseTaskValueJson,
  serializeTaskValue,
  systemClock,
  systemIdSource,
} from '@durablerun/core'
import { type TickResult, inlineLauncher, tick } from '@durablerun/driver'
import type { WorkerOutcome } from '@durablerun/sdk'
import {
  LibsqlExecutor,
  LibsqlSchedulerStore,
  LibsqlStoreAdmin,
  NOW_MS,
} from '@durablerun/store-libsql'
import {
  DOGFOOD_CHECKPOINT_NAME,
  DOGFOOD_TASK_NAME,
  type DogfoodConfig,
  type DogfoodFault,
  type DogfoodJournalParameters,
  dogfoodJournalParameters,
  dogfoodWorkloadIntent,
  parseDogfoodJournalParameters,
} from './config.js'
import { requireDogfoodWorkload } from './receipt.js'
import {
  type ObserveRepositoryRef,
  type RefObservation,
  observeGitHubRef,
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
      taskName: string
      state: string
      attempts: number
      infraRetries: number
      failureReason: unknown | null
      completedResult: unknown | null
      durableParameters: DogfoodJournalParameters | null
      taskCreatedAtEpochMs: number
      databaseNowEpochMs: number
      observedCheckpointCount: number
      contiguousCheckpointCount: number
      refObservations: readonly RefObservationCheckpoint[]
      relaunches: number
      checkpointSpanMs: number | null
    }

type DogfoodWorkerDisposition = 'task' | 'infrastructure' | null

const DOGFOOD_WORKER_DISPOSITIONS = {
  completed: null,
  suspended: null,
  'retry-scheduled': 'task',
  failed: 'task',
  superseded: null,
  'lease-lost': 'infrastructure',
  aborted: 'infrastructure',
  deferred: 'task',
} as const satisfies Record<WorkerOutcome['kind'], DogfoodWorkerDisposition>

function optionalJson(value: unknown): unknown | null {
  return typeof value === 'string' ? parseTaskValueJson(value) : null
}

function checkpointOrdinal(name: string): number | null {
  if (name === DOGFOOD_CHECKPOINT_NAME) return 1
  const match = /^#([1-9][0-9]*)$/.exec(name.slice(DOGFOOD_CHECKPOINT_NAME.length))
  if (!match) return null
  const ordinal = Number(match[1])
  return Number.isSafeInteger(ordinal) && ordinal >= 2 ? ordinal : null
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
      hardExit: (code: number) => never
    },
  ) {
    this.#raw = raw
    this.#config = config
    this.#ids = deps.ids
    this.#clock = deps.clock
    this.#observe = deps.observe
    this.#fault = config.fault
    this.#hardExit = deps.hardExit
    this.#store = new LibsqlSchedulerStore(raw, deps.ids)
  }

  static async open(
    config: DogfoodConfig,
    deps: {
      ids?: IdSource
      clock?: Clock
      observe?: ObserveRepositoryRef
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
        hardExit: deps.hardExit ?? ((code): never => process.exit(code)),
      })
    } catch (error) {
      raw.close()
      throw error
    }
  }

  async start(): Promise<DogfoodStartResult> {
    const paramsJson = serializeTaskValue(
      'ref-journal parameters',
      dogfoodJournalParameters(this.#config),
    )
    const result = await this.#store.spawn(this.#config.queue, DOGFOOD_TASK_NAME, paramsJson, {
      idempotencyKey: this.#config.idempotencyKey,
    })
    if (!result.created) {
      requireDogfoodWorkload(await this.status(), dogfoodWorkloadIntent(this.#config))
    }
    return {
      ...result,
      queue: this.#config.queue,
      idempotencyKey: this.#config.idempotencyKey,
    }
  }

  async tick(): Promise<TickResult> {
    let observedFailure:
      | { kind: 'worker'; failureKind: 'task' | 'infrastructure'; outcome: WorkerOutcome['kind'] }
      | { kind: 'launcher'; cause: unknown }
      | undefined
    const registry = refJournalRegistry(this.#observe, () => {
      if (this.#fault === 'worker-after-checkpoint') this.#hardExit(87)
    })
    const worker = inlineLauncher(
      { store: this.#store, clock: this.#clock, registry },
      {
        onOutcome(outcome) {
          const failureKind = DOGFOOD_WORKER_DISPOSITIONS[outcome.kind]
          if (failureKind !== null) {
            observedFailure = { kind: 'worker', failureKind, outcome: outcome.kind }
          }
        },
      },
    )
    const result = await tick(
      {
        store: this.#store,
        ids: this.#ids,
        launcher: {
          launch: async (invocation) => {
            try {
              if (this.#fault === 'driver-before-activation') this.#hardExit(86)
              return await worker.launch(invocation)
            } catch (cause) {
              observedFailure = { kind: 'launcher', cause }
              throw cause
            }
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
    if (observedFailure?.kind === 'worker') {
      throw new Error(
        `dogfood tick observed ${observedFailure.failureKind} failure (${observedFailure.outcome})`,
      )
    }
    if (observedFailure?.kind === 'launcher') {
      throw new Error('dogfood tick observed launcher failure', { cause: observedFailure.cause })
    }
    if (result.launchFailed !== 0) throw new Error('dogfood tick observed launcher failure')
    return result
  }

  async status(): Promise<DogfoodStatus> {
    const [tasks] = await this.#raw.batch(
      'dogfood:status-task',
      [
        {
          sql: `SELECT task_id, task_name, attempts, infra_retries, params, created_at_ms,
                       ${TASK_RESULT_COLUMNS}, ${NOW_MS} AS database_now_ms
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
    const outcome = decodeTaskResult(taskId, task)
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
      taskName: String(task.task_name),
      state: outcome.state,
      attempts: Number(task.attempts),
      infraRetries: Number(task.infra_retries),
      failureReason: optionalJson(outcome.failureReasonJson),
      completedResult: optionalJson(outcome.completedPayloadJson),
      durableParameters: parseDogfoodJournalParameters(optionalJson(task.params)),
      taskCreatedAtEpochMs: Number(task.created_at_ms),
      databaseNowEpochMs: Number(task.database_now_ms),
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
