import {
  type DefinedStatement,
  EventName,
  FencedBatch,
  type SqlExecutor,
  type SqlStatement,
  checkpointWrite,
  claimCas,
  emitEventCas,
  registerWaitCas,
  reopenLostLaunchCas,
  sqlFragment,
  treeBuilder,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { countMysqlPlaceholders } from '../src/executor.js'
import { TREE_DIALECT } from '../src/tree.js'

type Tree = Parameters<typeof TREE_DIALECT.compile>[0]

/** Compile a tree with the dialect alone, past the batch rules, to reach the compiler's own refusals. */
const compiled = (query: { toOperationNode(): unknown }) =>
  TREE_DIALECT.compile(query.toOperationNode() as Tree, {
    now: 'CLOCK',
    stamp: 'stamp',
    fence: (name) => name,
  })

type Kind = 'cas' | 'casMany' | 'followOn'

/** What the MySQL dialect sends for one shared statement, with the clock spelled CLOCK. */
async function sent(kind: Kind, name: string, statement: DefinedStatement): Promise<SqlStatement> {
  const captured: SqlStatement[] = []
  const executor: SqlExecutor = {
    batch: async (_label, statements) => {
      captured.push(...statements)
      return statements.map(() => ({ rows: [], rowsAffected: 1 }))
    },
  }
  const batch = new FencedBatch('b', 'seed', { now: 'CLOCK', tree: TREE_DIALECT })
  if (kind === 'followOn') {
    // A follow-on needs a compare-and-set to follow. The lease one stamps the run it reads.
    batch.casTree('lease', leaseCas())
    batch.followOnTree(name, statement, 'one')
  } else if (kind === 'casMany') {
    batch.casManyTree(name, statement, 2)
  } else {
    batch.casTree(name, statement)
  }
  await batch.run(executor)
  const statementSent = captured[kind === 'followOn' ? 1 : 0]
  if (statementSent === undefined) throw new Error('the batch sent nothing')
  return statementSent
}

const leaseCas = () =>
  reopenLostLaunchCas({
    queue: 'q',
    runId: 'r1',
    claimGen: 1,
    launchLost: sqlFragment('activated_gen < claim_gen'),
    availableAt: sqlFragment('$NOW$ + (relaunch_count + 1) * 5000'),
    liveOwner: sqlFragment('1 = 1'),
    backoffFits: sqlFragment('1 = 1'),
  })

const binds = (statement: SqlStatement) => countMysqlPlaceholders(statement.sql)

describe('MySQL spelling of the shared statement trees', () => {
  it('assigns a column only after every assignment that reads it', async () => {
    // MySQL assigns left to right and a later assignment reads an earlier one's new
    // value. The shared tree assigns relaunch_count first and derives the backoff from
    // it second, which every other dialect reads as the stored count.
    const { sql } = await sent('cas', 'reopen', leaseCas())
    const due = sql.indexOf('`available_at_ms` = (CLOCK + (relaunch_count + 1) * 5000)')
    const count = sql.indexOf('`relaunch_count` = `relaunch_count` + ?')
    expect(
      { dueIsAssigned: due > -1, countIsAssigned: count > -1, readerFirst: due < count },
      'mutation-verdict:construction:mysql-set-readers-before-writers',
    ).toEqual({ dueIsAssigned: true, countIsAssigned: true, readerFirst: true })
  })

  it('refuses a SET list whose assignments read one another', () => {
    // No order gives both assignments the stored row, so there is nothing to compile.
    const swap = treeBuilder
      .updateTable('runs')
      .set((eb) => ({ claim_gen: eb.ref('activated_gen'), activated_gen: eb.ref('claim_gen') }))
      .where('run_id', '=', 'r1')
    expect(() => compiled(swap), 'mutation-verdict:construction:mysql-set-cycle-refused').toThrow(
      /read one another/,
    )
  })

  it('refuses a conflict arm that would read a column after assigning it', () => {
    const arm = treeBuilder
      .insertInto('events')
      .values({ queue: 'q', event_name: 'e', payload: '{}', emitted_at_ms: 1 })
      .onConflict((conflict) =>
        conflict.columns(['queue', 'event_name']).doUpdateSet((eb) => ({
          fence_stamp: eb.ref('events.payload'),
          payload: eb.ref('events.fence_stamp'),
        })),
      )
    expect(
      () => compiled(arm),
      'mutation-verdict:construction:mysql-upsert-stale-read-refused',
    ).toThrow(/after assigning it/)
  })

  it('reads the table it updates through a derived table', async () => {
    const statement = await sent(
      'casMany',
      'claim',
      claimCas({
        queue: 'q',
        claimToken: 'tok',
        leaseMs: 1000,
        candidateRunIds: sqlFragment(
          '(SELECT run_id FROM (SELECT r.run_id FROM runs r LIMIT ?) AS c)',
          [2],
        ),
        legacyWaitStep: sqlFragment('NULL'),
        leaseExpiresAt: sqlFragment('$NOW$ + ?', [1000]),
        leaseFits: sqlFragment('1 = 1'),
      }),
    )
    expect(statement.sql, 'mutation-verdict:construction:mysql-self-read-derived-table').toContain(
      'not exists (select `held`.`run_id` from (select * from `runs`) as `held` where',
    )
    expect(statement.sql.startsWith('update `runs` set ')).toBe(true)
    expect(binds(statement)).toBe(statement.args.length)
  })

  it('spells a conditional upsert as assignments that each carry the condition', async () => {
    const statement = await sent(
      'cas',
      'event',
      emitEventCas({
        queue: 'q',
        eventName: EventName.fromPort('test', 'e'),
        payloadJson: '{}',
        existingEventAdmits: sqlFragment('events.payload IS NOT NULL'),
      }),
    )
    const sql = statement.sql
    expect(sql).not.toMatch(/on conflict|is distinct from/i)
    expect(sql, 'mutation-verdict:construction:mysql-null-safe-inequality').toContain(
      'not (`events`.`fence_stamp` <=> ?)',
    )
    // The condition reads fence_stamp, so the stamp is assigned after the instant, and
    // a refused arm leaves each column as it was.
    const instant = sql.indexOf('`fence_at_ms` = if(')
    const stamp = sql.indexOf('`fence_stamp` = if(')
    expect({ instant: instant > -1, stampAfterInstant: stamp > instant }).toEqual({
      instant: true,
      stampAfterInstant: true,
    })
    expect(sql).toContain(', `events`.`fence_stamp`)')
    expect(sql).toContain(') as `excluded` on duplicate key update ')
    expect(binds(statement)).toBe(statement.args.length)
  })

  it('spells DO NOTHING as a key assigned to itself, read from the stored row', async () => {
    const statement = await sent(
      'cas',
      'register',
      registerWaitCas({
        queue: 'q',
        runId: 'r1',
        taskId: 't1',
        claimToken: 'tok',
        stepName: 's',
        eventName: EventName.fromPort('test', 'e'),
        awaitedTaskId: null,
        timeoutAt: sqlFragment('CASE WHEN ? IS NOT NULL THEN $NOW$ + ? ELSE NULL END', [5, 5]),
        timeoutFits: sqlFragment('? IS NULL OR 1 = 1', [5]),
        taskOwnsRun: sqlFragment('t.task_id = r.task_id AND t.queue = r.queue'),
        taskEligible: sqlFragment('t.cancel_at_ms IS NULL'),
        phase: 'open',
      }),
    )
    // The stored row is named, because an INSERT … SELECT makes the bare column ambiguous.
    expect(statement.sql, 'mutation-verdict:construction:mysql-upsert-do-nothing').toContain(
      'on duplicate key update `run_id` = `waits`.`run_id`',
    )
    expect(binds(statement)).toBe(statement.args.length)
  })

  it('names the incoming row excluded by selecting it through a derived table', async () => {
    const statement = await sent(
      'followOn',
      'checkpoint',
      checkpointWrite({
        runId: 'r1',
        checkpointName: 'c',
        stateJson: '{}',
        fence: 'lease',
        attemptStored: sqlFragment('f.attempt IS NOT NULL'),
      }),
    )
    expect(statement.sql, 'mutation-verdict:construction:mysql-upsert-incoming-row').toContain(
      ') select * from (select `f`.`task_id` as `task_id`, ',
    )
    expect(statement.sql).toContain(
      '`state` = if(`excluded`.`owner_attempt` >= `checkpoints`.`owner_attempt`, `excluded`.`state`, `checkpoints`.`state`)',
    )
    // owner_attempt is what the condition reads, so it is the last assignment.
    expect(statement.sql.trimEnd().endsWith('`checkpoints`.`owner_attempt`)')).toBe(true)
    expect(binds(statement)).toBe(statement.args.length)
  })
})
