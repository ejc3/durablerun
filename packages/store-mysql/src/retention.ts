import {
  FencedBatch,
  type HeldRetention,
  type IdSource,
  PERSISTED_INTEGER_BOUNDS,
  READS_SEED,
  type SqlExecutor,
  TERMINAL_STATES,
  type TerminalState,
  createRetention,
  sqlFragment,
} from '@durablerun/core'
import { storedIntegerWithin } from './fragments.js'
import { NOW_MS } from './time.js'
import { TREE_DIALECT } from './tree.js'

const STAMP = PERSISTED_INTEGER_BOUNDS.tasks.fence_at_ms

/**
 * The tasks of a queue that ended in one state and hold a stamp instant in range, which
 * `tasks_terminal` hands out in the order of their stamps: the rows a leg of
 * `purge-candidates` takes. One leg to an ended state, because the index orders by the
 * stamp within a state. Each binds the queue once.
 * MySQL has no partial index, so `tasks_terminal` holds every task, and a leg names its
 * one state and nothing of the others.
 */
const ENDED_TASKS = Object.fromEntries(
  TERMINAL_STATES.map((state) => [
    state,
    `t.queue = ? AND t.state = '${state}'
    AND ${storedIntegerWithin(STAMP, 't')}`,
  ]),
) as Readonly<Record<TerminalState, string>>

/** The row `tasks` holds a stamp instant in range: what a purge reads a unit's age from. */
const STAMP_STORED = storedIntegerWithin(STAMP)

/**
 * What this dialect supplies to core's retention: its three batches, each labelled here and
 * run here, and its two fragments. The purge itself is core's (`createRetention`). It is a
 * class with the executor as `this.db` because that is where the batch checkers read a
 * store's batches: run as `batch.run(this.db)`, inside a member of a class.
 */
class MysqlRetention {
  constructor(
    private readonly db: SqlExecutor,
    private readonly ids: IdSource,
  ) {}

  port(): HeldRetention {
    return createRetention({
      run: (batch: FencedBatch) => batch.run(this.db),
      open: {
        purgeCandidates: () =>
          new FencedBatch('purge-candidates', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        purgeUnit: () =>
          new FencedBatch('purge-unit', this.ids.token(), { now: NOW_MS, tree: TREE_DIALECT }),
        purgeAdmission: () =>
          new FencedBatch('purge-admission', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
      },
      endedTasks: (state, queue) => sqlFragment(ENDED_TASKS[state], [queue]),
      stampStored: sqlFragment(STAMP_STORED),
    })
  }
}

/**
 * The retention port (`Retention`, DESIGN.md §3.12) over an executor of this store: the
 * purge of whole units of ended tasks. It is apart from the scheduler store, and no
 * engine actor calls it. `ids` mints the seed of each purge's batch.
 */
export function retention(db: SqlExecutor, ids: IdSource): HeldRetention {
  return new MysqlRetention(db, ids).port()
}
