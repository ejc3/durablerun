import type { UpdateQueryBuilder, UpdateResult } from 'kysely'
import { nowValue } from '../sql-tree.js'
import type { StoreTables } from '../store-tables.js'

export type RunsUpdate = UpdateQueryBuilder<StoreTables, 'runs', 'runs', UpdateResult>

/**
 * What every worker write requires of its run: this run, in this queue, still running
 * under this claim token. A guard added here reaches every such write.
 */
export const whereClaimedRun =
  (binds: { runId: string; queue: string; claimToken: string }) =>
  (update: RunsUpdate): RunsUpdate =>
    update
      .where('run_id', '=', binds.runId)
      .where('queue', '=', binds.queue)
      .where('claimed_by', '=', binds.claimToken)
      .where('state', '=', 'running')

/** The event wake a run carried, cleared once its worker has processed it. */
export const CLEARED_WAKE_COLUMNS = {
  wake_event: null,
  event_payload: null,
  wake_step: null,
} as const

export type TasksUpdate = UpdateQueryBuilder<StoreTables, 'tasks', 'tasks', UpdateResult>

/** What every write to one task requires: this task, in this queue. */
export const whereTaskInQueue =
  (binds: { taskId: string; queue: string }) =>
  (update: TasksUpdate): TasksUpdate =>
    update.where('task_id', '=', binds.taskId).where('queue', '=', binds.queue)

/**
 * What every transition that fails a run assigns: the state, the instant, the reason,
 * and the claim token given up. `fail` and the relaunch cap also clear the lease
 * deadline. The claim-timeout sweep keeps it: the deadline that expired is the evidence
 * the sweep acted on, and nothing reads it on a run that is no longer running.
 */
export const failedRunColumns = (reason: string) =>
  ({ state: 'failed', failed_at_ms: nowValue, failure_reason: reason, claimed_by: null }) as const
