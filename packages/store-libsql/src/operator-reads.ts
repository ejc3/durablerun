import {
  FencedBatch,
  type OperatorReads,
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
 * (`createOperatorReads`).
 */
class LibsqlOperatorReads {
  constructor(private readonly db: SqlExecutor) {}

  reads(): OperatorReads {
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
export function operatorReads(db: SqlExecutor): OperatorReads {
  return new LibsqlOperatorReads(db).reads()
}
