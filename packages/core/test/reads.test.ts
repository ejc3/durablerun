import { describe, expect, it } from 'vitest'
import {
  QUEUE_TABLES,
  checkpointsRead,
  claimedTaskNameRead,
  sqlFragment,
  tableRowsRead,
} from '../src/index.js'
import { batch, capturingExecutor, loose, statement } from './tree-fixtures.js'

/**
 * A partial index is matched by the literal in the statement's text. A bound state is a
 * placeholder there, so a read that binds one cannot use an index declared on that state.
 * The shared reads write a state inline, and a batch of reads refuses one that is bound.
 */
describe('the states a read compares', () => {
  async function sent(read: Parameters<ReturnType<typeof batch>['readTree']>[1]) {
    const { captured, executor } = capturingExecutor(0)
    await batch().readTree('read', read).run(executor)
    const [only] = captured
    if (only === undefined) throw new Error('the read sent no statement')
    return only
  }

  it('claimed-task-name writes the running state inline', async () => {
    const { sql, args } = await sent(
      claimedTaskNameRead({
        queue: 'q',
        runId: 'r1',
        claimToken: 'w1',
        claimGen: 1,
        taskOwnsRun: sqlFragment('t.task_id = r.task_id'),
      }),
    )
    expect(args).toEqual(['r1', 'q', 'w1', 1, 1])
    expect(sql).toContain(`"r"."state" = 'running'`)
  })

  it('get-checkpoints writes the committed status inline', async () => {
    const { sql, args } = await sent(
      checkpointsRead({
        queue: 'q',
        taskId: 't1',
        visibleThrough: 2,
        ownerMatches: sqlFragment('owner.run_id = c.owner_run_id'),
      }),
    )
    expect(args).toEqual(['t1', 'q', 2])
    expect(sql).toContain(`"c"."status" = 'committed'`)
  })

  it('a read that got no answer throws, and is never taken for no row', async () => {
    const read = statement(loose.selectFrom('runs').select('run_id').where('run_id', '=', 'r1'))
    await expect(
      batch()
        .readTree('read', read)
        .run({ batch: async () => [] }),
    ).rejects.toThrow(/returned 0 results for 1 statements/)
  })

  it('a read answered with no rows array throws, as a read that got no answer does', async () => {
    const read = statement(loose.selectFrom('runs').select('run_id').where('run_id', '=', 'r1'))
    const executor = { batch: async () => [{ rowsAffected: 0 }] } as never
    await expect(batch().readTree('read', read).run(executor)).rejects.toThrow(
      /answered read 'read' with no rows/,
    )
  })

  it('a batch of reads refuses a state compared with a bound value', () => {
    const bound = statement(
      loose.selectFrom('runs').select('run_id').where('state', '=', 'running'),
    )
    expect(() => batch().readTree('read', bound)).toThrow(
      /a state column compared with a bound value/,
    )
  })
})

/**
 * `sizes` counts one queue's rows of a table up to a cap, so it needs a count over a
 * derived table that carries the LIMIT. A batch of reads holds every statement to the
 * closed grammar, so a batch that takes this statement is the grammar accepting it.
 */
describe('a count over a derived table that carries a LIMIT', () => {
  it('is inside the statement grammar, for every table it counts, and binds the queue and one row past the cap', async () => {
    for (const table of QUEUE_TABLES) {
      const { captured, executor } = capturingExecutor(0)
      await batch()
        .readTree('read', tableRowsRead({ table, queue: 'q', cap: 1_000_000 }))
        .run(executor)
      expect(captured).toEqual([
        {
          sql: `select count(*) as "row_count" from (select "queue" from "${table}" where "queue" = ? limit ?) as "counted"`,
          args: ['q', 1_000_001],
        },
      ])
    }
  })
})
