import {
  FencedBatch,
  type HeldOperatorReads,
  READS_SEED,
  type SqlExecutor,
  createOperatorReads,
  sqlFragment,
} from '@durablerun/core'
import { rollbackError, rollbackOutcome, sagaBegan } from './fragments.js'
import { FAKE_CLOCK_READ_SQL, NOW_MS } from './time.js'
import { TREE_DIALECT } from './tree.js'

/**
 * What this dialect supplies to core's operator reads: its batches, each labelled here and
 * run here, its read of the test clock, and its fragments. The reads themselves are core's
 * (`createOperatorReads`). It is a class with the executor as `this.db` because that is
 * where the batch checkers read a store's batches: sent as `this.db.batch(...)`, or run as
 * `batch.run(this.db)`, inside a member of a class.
 */
class PostgresOperatorReads {
  constructor(private readonly db: SqlExecutor) {}

  reads(): HeldOperatorReads {
    return createOperatorReads({
      run: (batch: FencedBatch) => batch.run(this.db),
      open: {
        taskFacts: () =>
          new FencedBatch('task-facts', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        taskIdByKey: () =>
          new FencedBatch('task-id-by-key', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
        eventState: () =>
          new FencedBatch('event-state', READS_SEED, { now: NOW_MS, tree: TREE_DIALECT }),
      },
      fakeClock: async () => {
        const [flag] = await this.db.batch(
          'fake-clock',
          [{ sql: FAKE_CLOCK_READ_SQL, args: [] }],
          'read',
        )
        return flag?.rows[0]?.fake_clock
      },
      sagaBegan: sqlFragment(sagaBegan('tasks')),
      rollbackOutcome: sqlFragment(rollbackOutcome('tasks')),
      rollbackError: sqlFragment(rollbackError('tasks')),
    })
  }
}

/**
 * The operator's read port (`OperatorReads`) over an executor of this store. It is apart
 * from the scheduler store: no engine actor calls it, and it sends only batches of reads.
 */
export function operatorReads(db: SqlExecutor): HeldOperatorReads {
  return new PostgresOperatorReads(db).reads()
}
