import { expressionBuilder } from 'kysely'
import type { SagaPhasePredicate } from '../sagas.js'
import {
  FENCE_ASSIGNMENTS,
  type SqlFragment,
  defineStatement,
  fenceValue,
  insertedFrom,
  nowValue,
  rawSql,
} from '../sql-tree.js'
import { type StoreTables, treeBuilder } from '../store-tables.js'
import { whereClaimedRun } from './claimed-run.js'

/**
 * `set-checkpoint`'s compare-and-set: a run still running under its claim, for this
 * task, extends its lease and takes the stamp the checkpoint write fences on. The lease
 * deadline and its headroom guard are the store's, read together with its own casts.
 */
export const checkpointLeaseCas = defineStatement(
  'set-checkpoint',
  (binds: {
    queue: string
    taskId: string
    runId: string
    claimToken: string
    leaseExpiresAt: SqlFragment
    admission: SqlFragment
    leaseFits: SqlFragment
    /**
     * What the saga phase requires of this write (DESIGN.md §3.10): a forward checkpoint
     * only before the phase, and a rollback's only inside it.
     */
    sagaPhase: SagaPhasePredicate
  }) =>
    treeBuilder
      .updateTable('runs')
      .set({
        claim_expires_at_ms: rawSql<number>(binds.leaseExpiresAt, 'value'),
        heartbeat_at_ms: nowValue,
        ...FENCE_ASSIGNMENTS,
      })
      .$call(whereClaimedRun(binds))
      .where('task_id', '=', binds.taskId)
      .where(rawSql<boolean>(binds.admission, 'predicate'))
      .where(rawSql<boolean>(binds.leaseFits, 'predicate'))
      .$if(binds.sagaPhase !== 'open', (query) =>
        query.where(rawSql<boolean>(binds.sagaPhase as SqlFragment, 'predicate')),
      ),
)

/**
 * The checkpoint write both placements share: the inline `set-checkpoint`, and the
 * marker a suspension leaves. It is one statement because its conflict arm is
 * wire-visible. Two write sites drifting apart would mean one path kept a step's state
 * and the other discarded it.
 *
 * The row is the fenced run's own: its task, its queue, its id, its attempt, and its
 * fence instant as the update time, so the write reads no clock. On a conflict a lower
 * attempt loses to the row already there. That comparison is a last-writer-wins
 * tiebreak and never the fence: a lower-attempt writer under a still-valid lease is
 * dropped in silence, and its lease still extends.
 */
export const checkpointWrite = defineStatement(
  'checkpoint write',
  (binds: {
    runId: string
    checkpointName: string
    stateJson: string
    /**
     * The statement of this batch that stamped the run: a compare-and-set, or the
     * insert of the rollback pass a saga marker belongs to.
     */
    fence: 'lease' | 'suspend' | 'fail' | 'rollback-pass'
    /** The run's stored attempt is one a checkpoint can record. */
    attemptStored: SqlFragment
  }) => {
    const eb = expressionBuilder<{ f: StoreTables['runs'] }, 'f'>()
    const { columns, selections } = insertedFrom({
      task_id: eb.ref('f.task_id'),
      checkpoint_name: eb.val(binds.checkpointName),
      queue: eb.ref('f.queue'),
      state: eb.val(binds.stateJson),
      owner_run_id: eb.ref('f.run_id'),
      owner_attempt: eb.ref('f.attempt'),
      updated_at_ms: eb.ref('f.fence_at_ms'),
    })
    return treeBuilder
      .insertInto('checkpoints')
      .columns(columns)
      .expression(
        treeBuilder
          .selectFrom('runs as f')
          .select(selections)
          .where('f.run_id', '=', binds.runId)
          .where(rawSql<boolean>(binds.attemptStored, 'predicate'))
          .where('f.fence_stamp', '=', fenceValue(binds.fence)),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['task_id', 'checkpoint_name'])
          .doUpdateSet((arm) => ({
            state: arm.ref('excluded.state'),
            owner_run_id: arm.ref('excluded.owner_run_id'),
            owner_attempt: arm.ref('excluded.owner_attempt'),
            updated_at_ms: arm.ref('excluded.updated_at_ms'),
          }))
          .whereRef('excluded.owner_attempt', '>=', 'checkpoints.owner_attempt'),
      )
  },
)
