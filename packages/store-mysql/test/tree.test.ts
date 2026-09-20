import {
  type DefinedStatement,
  EventName,
  FencedBatch,
  type SqlExecutor,
  type SqlStatement,
  checkpointWrite,
  claimCas,
  defineStatement,
  emitEventCas,
  rawSql,
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

/** The claim's compare-and-set over two candidates, as a batch sends it. */
const sentClaim = () =>
  sent(
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
    const statement = await sentClaim()
    expect(statement.sql, 'mutation-verdict:construction:mysql-self-read-derived-table').toContain(
      'not exists (select `held`.`run_id` from (select * from `runs`) as `held` where',
    )
    expect(
      statement.sql.startsWith('update /*+ JOIN_PREFIX(`k`@`keys`, `runs`) */ `runs` force index'),
    ).toBe(true)
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

  it("reads a keyed update's keys first, and its table through the index of its key", async () => {
    const statement = await sentClaim()
    expect(
      statement.sql,
      'mutation-verdict:construction:mysql-keyed-write-names-its-key-index',
    ).toContain('`runs` force index (primary) set ')
    expect(statement.sql.startsWith('update /*+ JOIN_PREFIX(`k`@`keys`, `runs`) */ `runs` ')).toBe(
      true,
    )
    expect(binds(statement)).toBe(statement.args.length)
  })

  it("puts a keyed write's keys in a block of its own, named and kept whole", async () => {
    // The order hint names the block's one table, so the block needs its name, and the
    // server may not merge the block away, or there is no such table to name.
    const statement = await sentClaim()
    expect(
      statement.sql,
      'mutation-verdict:construction:mysql-keyed-write-keys-block-is-named',
    ).toContain('`run_id` in (select /*+ QB_NAME(`keys`) ')
    expect(
      statement.sql,
      'mutation-verdict:construction:mysql-keyed-write-keys-block-is-kept-whole',
    ).toContain(' NO_MERGE(`k`) */ * from (SELECT run_id FROM ')
    expect(statement.sql).toContain(') as `k`')
    expect(binds(statement)).toBe(statement.args.length)
  })

  it('writes a keyed delete in the form that takes an index, and reads its keys through the index of their stamp', () => {
    const { sql } = compiled(
      treeBuilder
        .deleteFrom('waits')
        .where((eb) =>
          eb(
            'run_id',
            'in',
            eb.selectFrom('runs as f').select('f.run_id').where('f.fence_stamp', '=', 'stamp'),
          ),
        ),
    )
    expect(sql, 'mutation-verdict:construction:mysql-keyed-delete-names-the-stamp-index').toBe(
      'delete /*+ JOIN_PREFIX(`k`@`keys`, `waits`) */ `waits` from `waits` force index (primary) where `run_id` in (select /*+ QB_NAME(`keys`) NO_MERGE(`k`) */ * from (select `f`.`run_id` from `runs` as `f` force index (runs_stamp) where `f`.`fence_stamp` = ?) as `k`)',
    )
  })

  it("takes the stamp a delete's keys compare on trust, which core does not", async () => {
    // The compiler reads one statement, and one statement cannot show that the stamp its
    // keys compare is the batch's own. Keys fenced on another batch's stamp compile, and
    // read that batch's entries through the index of the stamp. Core's gating rule is what
    // refuses them, because it knows the batch: the same tree, handed to a batch as a
    // follow-on, is refused before anything is compiled.
    const foreign = () =>
      treeBuilder
        .deleteFrom('waits')
        .where((eb) =>
          eb(
            'run_id',
            'in',
            eb
              .selectFrom('runs as f')
              .select('f.run_id')
              .where('f.fence_stamp', '=', 'another-batch:claim'),
          ),
        )
    expect(compiled(foreign()).sql).toContain('`runs` as `f` force index (runs_stamp) where ')
    const asAFollowOn = defineStatement('foreign', () => foreign())
    await expect(sent('followOn', 'foreign', asAFollowOn({}))).rejects.toThrow(
      /has no fence gating every row it reads or writes/,
    )
  })

  it('refuses a delete whose keys come from the table it writes', () => {
    // MySQL refuses a subquery that reads the table its statement writes, so the compiler
    // reads that table through a derived table, and a derived table takes no index hint. The
    // keys were sent as `(select * from runs) as f force index (runs_stamp)`, which the
    // server answers with a syntax error when the batch runs.
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('runs')
            .where((eb) =>
              eb(
                'run_id',
                'in',
                eb.selectFrom('runs as f').select('f.run_id').where('f.fence_stamp', '=', 'stamp'),
              ),
            ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-own-table-refused',
    ).toThrow('a delete of runs takes its keys from runs, the table it writes')
  })

  it('refuses a delete that no subquery keys', () => {
    // A DELETE reads its subquery's table with shared locks, so the rule for a delete's keys
    // has to reach every delete a tree sends. One keyed in a way the compiler does not
    // read, or not keyed at all, is refused, where it used to compile as the server
    // would plan it.
    const refused = 'a delete of waits is keyed by no subquery'
    expect(
      () => compiled(treeBuilder.deleteFrom('waits').where('status', '=', 'waiting')),
      'mutation-verdict:construction:mysql-unkeyed-delete-refused',
    ).toThrow(refused)
    expect(() =>
      compiled(
        treeBuilder
          .deleteFrom('waits')
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('runs as f')
                .select('f.run_id')
                .whereRef('f.run_id', '=', 'waits.run_id')
                .where('f.fence_stamp', '=', 'stamp'),
            ),
          ),
      ),
    ).toThrow(refused)
  })

  it('refuses a delete whose keys are not fenced on the stamp', () => {
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('waits')
            .where((eb) => eb('run_id', 'in', eb.selectFrom('runs as f').select('f.run_id'))),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-unfenced-keys-refused',
    ).toThrow('a delete of waits takes its keys from runs unfenced')
  })

  it('refuses a delete whose fenced keys come from a table that declares no index of its stamp', () => {
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('waits')
            .where((eb) =>
              eb(
                'run_id',
                'in',
                eb
                  .selectFrom('tasks as f')
                  .select('f.task_id')
                  .where('f.fence_stamp', '=', 'stamp'),
              ),
            ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-unindexed-stamp-refused',
    ).toThrow('a delete of waits takes its keys from tasks, which declares no index of its stamp')
  })

  it('refuses a delete whose keys are anything but a selection of one plain table', () => {
    const refused =
      'a delete of waits takes its keys from something other than a selection of one table'
    expect(() =>
      compiled(
        treeBuilder
          .deleteFrom('waits')
          .where((eb) =>
            eb(
              'run_id',
              'in',
              rawSql<string>(sqlFragment('(SELECT r.run_id FROM runs r)'), 'subquery'),
            ),
          ),
      ),
    ).toThrow(refused)
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('waits')
            .where((eb) =>
              eb(
                'run_id',
                'in',
                eb
                  .selectFrom(['runs as f', 'tasks as t'])
                  .select('f.run_id')
                  .where('f.fence_stamp', '=', 'stamp'),
              ),
            ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-keys-name-one-table',
    ).toThrow(refused)
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('waits')
            .where((eb) =>
              eb(
                'run_id',
                'in',
                eb.selectFrom('runs').select('runs.run_id').where('runs.fence_stamp', '=', 'stamp'),
              ),
            ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-keys-table-is-aliased',
    ).toThrow(refused)
    expect(
      () =>
        compiled(
          treeBuilder
            .deleteFrom('waits')
            .where((eb) =>
              eb(
                'run_id',
                'in',
                eb
                  .selectFrom('runs as f')
                  .innerJoin('tasks as t', 't.task_id', 'f.task_id')
                  .select('f.run_id')
                  .where('f.fence_stamp', '=', 'stamp'),
              ),
            ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-keys-join-nothing',
    ).toThrow(refused)
    expect(
      () =>
        compiled(
          treeBuilder.deleteFrom('waits').where((eb) =>
            eb(
              'run_id',
              'in',
              eb
                .selectFrom(
                  eb.selectFrom('runs as r').select(['r.run_id', 'r.fence_stamp']).as('f'),
                )
                .select('f.run_id')
                .where('f.fence_stamp', '=', 'stamp'),
            ),
          ),
        ),
      'mutation-verdict:construction:mysql-keyed-delete-keys-table-is-plain',
    ).toThrow(refused)
  })

  it('takes for a fence of the keys only an equality on the stamp of the table they come from', () => {
    const refused = 'a delete of waits takes its keys from runs unfenced'
    // The written table is in reach of the subquery, and its stamp is not the stamp of the keys.
    const theWrittenTablesStamp = treeBuilder.dynamic.ref<'f.fence_stamp'>('waits.fence_stamp')
    const keyedBy = (
      column: 'f.fence_stamp' | 'f.claim_token' | typeof theWrittenTablesStamp,
      operator: '=' | '!=',
    ) =>
      compiled(
        treeBuilder.deleteFrom('waits').where((eb) =>
          eb(
            'run_id',
            'in',
            eb
              .selectFrom('runs as f')
              .select('f.run_id')
              // One overload takes a column's name and another a built reference.
              .where(column as 'f.fence_stamp', operator, 'stamp'),
          ),
        ),
      )
    expect(
      () => keyedBy('f.claim_token', '='),
      'mutation-verdict:construction:mysql-keyed-delete-fence-is-the-stamp',
    ).toThrow(refused)
    expect(
      () => keyedBy(theWrittenTablesStamp, '='),
      'mutation-verdict:construction:mysql-keyed-delete-fence-is-the-sources',
    ).toThrow(refused)
    expect(
      () => keyedBy('f.fence_stamp', '!='),
      'mutation-verdict:construction:mysql-keyed-delete-fence-is-an-equality',
    ).toThrow(refused)
    expect(() => keyedBy('f.fence_stamp', '=')).not.toThrow()
  })

  it('finds the key of a write wherever it stands among the conditions', () => {
    const { sql } = compiled(
      treeBuilder
        .updateTable('runs')
        .set({ state: 'pending' })
        .where('state', '=', 'sleeping')
        .where((eb) =>
          eb(
            'run_id',
            'in',
            rawSql<string>(sqlFragment('(SELECT w.run_id FROM waits w)'), 'subquery'),
          ),
        ),
    )
    expect(sql, 'mutation-verdict:construction:mysql-keyed-write-key-stands-anywhere').toContain(
      '`runs` force index (primary) set ',
    )
    const underParentheses = compiled(
      treeBuilder
        .updateTable('runs')
        .set({ state: 'pending' })
        .where((eb) =>
          eb.parens(
            eb(
              'run_id',
              'in',
              rawSql<string>(sqlFragment('(SELECT w.run_id FROM waits w)'), 'subquery'),
            ),
          ),
        ),
    )
    expect(
      underParentheses.sql,
      'mutation-verdict:construction:mysql-keyed-write-key-stands-under-parentheses',
    ).toContain('`runs` force index (primary) set ')
  })

  it('takes no list of values for a key', () => {
    const listed = () =>
      compiled(
        treeBuilder
          .updateTable('tasks')
          .set({ state: 'failed' })
          .where('state', 'in', ['pending', 'running']),
      )
    expect(
      listed,
      'mutation-verdict:construction:mysql-keyed-write-key-is-a-subquery',
    ).not.toThrow()
    expect(listed().sql).toBe('update `tasks` set `state` = ? where `state` in (?, ?)')
  })

  it('refuses a write keyed by a column that names no index', () => {
    expect(
      () =>
        compiled(
          treeBuilder
            .updateTable('runs')
            .set({ state: 'pending' })
            .where((eb) => eb('queue', 'in', eb.selectFrom('tasks as t').select('t.queue'))),
        ),
      'mutation-verdict:construction:mysql-keyed-write-undeclared-key-refused',
    ).toThrow('a write of runs keyed by queue names no index to reach it through')
  })
})
