import {
  BinaryOperationNode,
  ColumnNode,
  OperatorNode,
  QueryNode,
  SelectModifierNode,
  SelectQueryNode,
  sql,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  type SqlFragment,
  aliasedAs,
  treeBuilder as db,
  defineStatement,
  fenceValue,
  literalValue,
  nowValue,
  rawSql,
  sqlFragment,
  stampValue,
  statementGrammarProblem,
} from '../src/index.js'
import {
  type Builder,
  type Loose,
  accepts,
  cas,
  eventInsert,
  followOn,
  gate,
  key,
  loose,
  predicate,
  refuses,
  refusesAs,
  tail,
  taskFollowOn,
  taskInsert,
  tasksWhere,
  tiedKeys,
  unguardedWaitInsert,
  value,
  winCas,
} from './tree-fixtures.js'

/**
 * One test for each registered mutation of a rule that lives in `sql-tree.ts`: the text of
 * a fragment, the binds of a statement, the statement grammar, where a fragment stands,
 * and the spellings of a clock and of a count. `fenced-batch-tree-verdicts.test.ts` holds
 * the rules a batch applies. Each test builds the nearest shape only its condition
 * refuses, and carries that mutation's marker and no other.
 *
 * A spelling list is a rule for each entry, so each entry has a row in a table here, and
 * each row is its own test.
 */

const fencedRuns = () =>
  db.selectFrom('runs').select('run_id').where('fence_stamp', '=', fenceValue('win'))
const setting = (assigned: (eb: Loose) => object) =>
  followOn((taskFollowOn() as Loose).set((eb: Loose) => assigned(eb)))
const startedAt = (text: string) =>
  followOn(taskFollowOn().set({ first_started_at_ms: value<number>(text) }))
const attempts = (text: string) => followOn(taskFollowOn().set({ attempts: value<number>(text) }))
const subquery = (text: string) => rawSql<string>(sqlFragment(text), 'subquery')
/** A fragment declared a value, standing wherever the test puts it. */
const asValue = (text = '1 = 1') => value<boolean>(text)

describe('the tree rules', () => {
  describe('the text of a fragment', () => {
    it('refuses the stamp token', () => {
      refusesAs(
        'mutation-verdict:construction:tree-fragment-stamp-token',
        /may not hold the stamp token/,
        /plain single-quoted literals/,
        () => predicate('fence_stamp = $STAMP$'),
      )
    })

    it('refuses a line comment', () => {
      refuses('mutation-verdict:construction:tree-fragment-line-comment', /comment/, () =>
        predicate('x = 1 -- trailing'),
      )
    })

    it('refuses a block comment', () => {
      refuses('mutation-verdict:construction:tree-fragment-block-comment', /comment/, () =>
        predicate('x = 1 /* trailing */'),
      )
    })

    it('refuses a prefixed string literal', () => {
      refuses(
        'mutation-verdict:construction:tree-fragment-prefixed-literal',
        /plain single-quoted literals/,
        () => predicate("x = E'escaped'"),
      )
    })

    it('refuses a dollar-quoted string', () => {
      refusesAs(
        'mutation-verdict:construction:tree-fragment-dollar-quoted',
        /plain single-quoted literals/,
        /a stray \$/,
        () => predicate('x = $q$ quoted $q$'),
      )
    })

    it('refuses a stray dollar sign', () => {
      refuses('mutation-verdict:construction:tree-fragment-stray-dollar', /a stray \$/, () =>
        predicate('x = $1'),
      )
    })

    it('refuses a malformed fence token', () => {
      refusesAs(
        'mutation-verdict:construction:tree-fragment-malformed-fence-token',
        /malformed fence token$/,
        /or a stray \$/,
        () => predicate('x = $FENCE:not a name$'),
      )
    })

    it('refuses a bind inside a string literal', () => {
      refuses('mutation-verdict:construction:tree-fragment-bind-in-literal', /string literal/, () =>
        predicate("task_name = 'why?'", ['bound']),
      )
    })

    it('refuses the clock token inside a string literal', () => {
      refuses(
        'mutation-verdict:construction:tree-fragment-clock-in-literal',
        /string literal/,
        () => predicate("failure_reason <> 'at $NOW$'"),
      )
    })

    it('refuses a fence token inside a string literal', () => {
      refuses(
        'mutation-verdict:construction:tree-fragment-fence-in-literal',
        /string literal/,
        () => predicate("failure_reason <> 'at $FENCE:win$'"),
      )
    })

    it('refuses a subquery fragment that is not one group', () => {
      refuses(
        'mutation-verdict:construction:tree-subquery-fragment-one-group',
        /one parenthesized group/,
        () => subquery("SELECT 'job'"),
      )
    })

    it('refuses text before the group of a subquery fragment', () => {
      refuses(
        'mutation-verdict:construction:tree-subquery-fragment-opens',
        /one parenthesized group/,
        () => subquery("'other', (SELECT 'job')"),
      )
    })

    it('refuses text after the group of a subquery fragment', () => {
      refuses(
        'mutation-verdict:construction:tree-subquery-fragment-closes-at-end',
        /one parenthesized group/,
        () => subquery("(SELECT 'a') UNION (SELECT 'b')"),
      )
    })

    it('validates a text again for each role it is placed in', () => {
      // Valid as a predicate, and no parenthesized group, so not valid as a subquery.
      const text = 'validated_once_for_each_role = 1'
      predicate(text)
      refuses(
        'mutation-verdict:construction:tree-fragment-cache-keyed-by-role',
        /one parenthesized group/,
        () => subquery(text),
      )
    })

    it('refuses an argument the text never binds', () => {
      refuses(
        'mutation-verdict:construction:tree-fragment-unused-argument',
        /binds 1 of its 2 arguments/,
        () => predicate('queue = ?', ['q', 'extra']),
      )
    })

    it('refuses a placeholder with no argument', () => {
      refuses(
        'mutation-verdict:construction:tree-fragment-missing-argument',
        /binds 2 of its 1 arguments/,
        () => predicate('queue = ? AND task_name = ?', ['q']),
      )
    })
  })

  describe('the binds of a statement', () => {
    const update = () => db.updateTable('runs').set({ state: 'completed' })

    it('refuses an undefined bind', () => {
      const keyed = defineStatement('keyed', (binds: { runId: string }) =>
        update().where('run_id', '=', binds.runId),
      )
      refuses(
        'mutation-verdict:construction:tree-bind-undefined',
        /bind 'runId' is undefined/,
        () => keyed({ runId: undefined as never }),
      )
    })

    it('refuses an undefined bind below the first level', () => {
      const nested = defineStatement('nested', (binds: { wake: { at: number } }) =>
        db.updateTable('runs').set({ available_at_ms: binds.wake.at }).where('run_id', '=', 'r1'),
      )
      refuses(
        'mutation-verdict:construction:tree-bind-undefined-nested',
        /bind 'wake'\.at is undefined/,
        () => nested({ wake: { at: undefined as never } }),
      )
    })

    it('refuses a fragment the statement never places', () => {
      const unplaced = defineStatement('unplaced', (_binds: { admission: SqlFragment }) =>
        update().where('run_id', '=', 'r1'),
      )
      refuses('mutation-verdict:construction:tree-fragment-never-placed', /never places/, () =>
        unplaced({ admission: sqlFragment('1 = 1') }),
      )
    })

    it('counts one placement for one bind', () => {
      const half = defineStatement('half', (binds: { first: SqlFragment; second: SqlFragment }) =>
        update().where(rawSql<boolean>(binds.first, 'predicate')),
      )
      const shared = sqlFragment('1 = 1')
      refuses(
        'mutation-verdict:construction:tree-fragment-placement-consumed',
        /bind 'second' is a fragment the statement never places/,
        () => half({ first: shared, second: shared }),
      )
    })
  })

  describe('the statement grammar', () => {
    const GRAMMAR = /outside the statement grammar/
    /**
     * A gated follow-on whose second conjunct requires the task to be IN a write. The
     * builder binds a write as a value, so only a tree built from nodes holds this shape.
     */
    const nesting = (write: Builder) =>
      followOn({
        toOperationNode: () =>
          QueryNode.cloneWithWhere(
            tasksWhere((eb) => eb('task_id', 'in', tiedKeys(eb))).toOperationNode(),
            BinaryOperationNode.create(
              ColumnNode.create('task_id'),
              OperatorNode.create('in'),
              write.toOperationNode(),
            ),
          ),
      })

    it('refuses a node kind it does not list', () => {
      refuses('mutation-verdict:construction:tree-grammar-node-kind', /node kind OverNode/, () =>
        tail(
          loose
            .selectFrom('runs')
            .select((eb: Loose) => eb.fn.countAll().over().as('n'))
            .where('fence_stamp', '=', fenceValue('win')),
        ),
      )
    })

    it('refuses an UPDATE below the root', () => {
      refuses('mutation-verdict:construction:tree-grammar-update-below-root', GRAMMAR, () =>
        nesting(loose.updateTable('runs').set({ state: 'failed' })),
      )
    })

    it('refuses a DELETE below the root', () => {
      refuses('mutation-verdict:construction:tree-grammar-delete-below-root', GRAMMAR, () =>
        nesting(loose.deleteFrom('runs')),
      )
    })

    it('refuses an INSERT below the root', () => {
      refuses('mutation-verdict:construction:tree-grammar-insert-below-root', GRAMMAR, () =>
        nesting(loose.insertInto('runs').values({ run_id: 'r2' })),
      )
    })

    it('refuses a query clause it does not list', () => {
      // UPDATE … FROM holds only node kinds the grammar lists, so the clause list alone refuses it.
      refuses(
        'mutation-verdict:construction:tree-grammar-node-fields',
        /UpdateQueryNode\.from/,
        () =>
          cas(
            'win',
            loose
              .updateTable('runs')
              .from('tasks')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: nowValue })
              .where('run_id', '=', 'r1'),
          ),
      )
    })

    it('refuses a function it does not list', () => {
      refuses(
        'mutation-verdict:construction:tree-grammar-function-list',
        /a call of current_date, which the grammar does not list/,
        () => setting((eb) => ({ first_started_at_ms: eb.fn('current_date', []) })),
      )
    })

    it('reads a function name in any case', () => {
      accepts('mutation-verdict:construction:tree-grammar-function-case-fold', () =>
        setting((eb) => ({
          first_started_at_ms: eb.fn('COALESCE', [eb.ref('first_started_at_ms'), eb.val(5)]),
        })),
      )
    })

    it('refuses an aggregate it does not list', () => {
      refuses(
        'mutation-verdict:construction:tree-grammar-aggregate-list',
        /an aggregate call of now, which the grammar does not list/,
        () => setting((eb) => ({ first_started_at_ms: eb.fn.agg('now') })),
      )
    })

    it('reads an aggregate name in any case', () => {
      accepts('mutation-verdict:construction:tree-grammar-aggregate-case-fold', () =>
        tail(
          loose
            .selectFrom('runs')
            .select((eb: Loose) => eb.fn.agg('COUNT', ['run_id']).as('n'))
            .where('fence_stamp', '=', fenceValue('win')),
        ),
      )
    })

    it('refuses a schema-qualified table', () => {
      refuses(
        'mutation-verdict:construction:tree-grammar-schema-qualified',
        /a schema-qualified table/,
        () =>
          cas(
            'win',
            loose
              .withSchema('other')
              .updateTable('runs')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: nowValue })
              .where('run_id', '=', 'r1'),
          ),
      )
    })

    it('refuses a SELECT modifier other than DISTINCT', () => {
      const skipLocked = {
        toOperationNode: () =>
          SelectQueryNode.cloneWithFrontModifier(
            fencedRuns().toOperationNode(),
            SelectModifierNode.create('SkipLocked'),
          ),
      }
      refuses(
        'mutation-verdict:construction:tree-grammar-select-modifier',
        /a SELECT modifier other than DISTINCT/,
        () => tail(skipLocked),
      )
    })

    it('refuses an assignment to something other than a column', () => {
      refuses(
        'mutation-verdict:construction:tree-grammar-assigns-a-column',
        /an assignment to something other than a column/,
        () => followOn((taskFollowOn() as Loose).set(value<string>('task_name'), 'job')),
      )
    })

    it('reads the nodes below the root', () => {
      refuses(
        'mutation-verdict:construction:tree-grammar-reads-children',
        /a schema-qualified table/,
        () =>
          followOn(
            tasksWhere((eb) =>
              eb(
                'task_id',
                'in',
                loose.withSchema('other').selectFrom('runs as f').where(gate).select('f.task_id'),
              ),
            ),
          ),
      )
    })

    it('holds an INSERT to its shape', () => {
      refuses('mutation-verdict:construction:tree-grammar-insert-shape', /names no columns/, () =>
        cas(
          'event',
          (eventInsert() as Loose).onConflict((oc: Loose) => oc.doNothing()),
        ),
      )
    })
  })

  describe('a set operation', () => {
    const leg = () => loose.selectFrom('runs').select('run_id')
    const problem = (joined: Builder, reading: boolean) =>
      statementGrammarProblem(joined.toOperationNode(), reading)
    const OTHER = 'a set operation other than UNION ALL'

    it('belongs to a batch of reads alone', () => {
      expect(problem(leg().unionAll(leg()), true)).toBeNull()
      expect(
        problem(leg().unionAll(leg()), false),
        'mutation-verdict:construction:tree-set-operation-reads-only',
      ).toBe('a set operation outside a batch of reads')
    })

    it('is read wherever the tree holds one', () => {
      expect(
        problem(leg().except(leg()), true),
        'mutation-verdict:construction:tree-set-operation-checked',
      ).toBe(OTHER)
    })

    it('is refused when it is not a UNION ALL', () => {
      expect(
        problem(leg().intersect(leg()), true),
        'mutation-verdict:construction:tree-set-operation-union-all-only',
      ).toBe(OTHER)
    })

    it('is refused as a UNION that drops duplicate rows', () => {
      expect(
        problem(leg().union(leg()), true),
        'mutation-verdict:construction:tree-union-needs-all',
      ).toBe(OTHER)
    })

    it('is refused as another operation that keeps duplicate rows', () => {
      expect(
        problem(leg().intersectAll(leg()), true),
        'mutation-verdict:construction:tree-set-operation-is-union',
      ).toBe(OTHER)
    })
  })

  describe('a state a read compares', () => {
    const runs = () => loose.selectFrom('runs as r').select('r.run_id')
    const problem = (read: Builder, reading = true) =>
      statementGrammarProblem(read.toOperationNode(), reading)
    // Matched as text: a matcher that wants a string refuses null before it prints the
    // marker, and null is what a mutant that admits the read answers.
    const BOUND = /^a state column compared with a bound value/

    it('is refused when it is bound', () => {
      expect(
        String(problem(runs().where('r.state', '=', 'running'))),
        'mutation-verdict:construction:tree-read-state-literal',
      ).toMatch(BOUND)
      // A transition finds its row by key, so it may bind the state it compares.
      expect(problem(runs().where('r.state', '=', 'running'), false)).toBeNull()
    })

    it('is admitted as an inline literal', () => {
      expect(
        problem(runs().where('r.state', '=', literalValue('running'))),
        'mutation-verdict:construction:tree-read-state-literal-admitted',
      ).toBeNull()
    })

    it('is the only column held to a literal', () => {
      expect(
        problem(runs().where('r.run_id', '=', 'r1')),
        'mutation-verdict:construction:tree-read-state-names-the-column',
      ).toBeNull()
    })

    it('counts an inline value as no bind', () => {
      expect(
        problem(
          loose
            .selectFrom('checkpoints as c')
            .select('c.state')
            .where('c.status', '=', literalValue('committed')),
        ),
        'mutation-verdict:construction:tree-read-bind-is-not-immediate',
      ).toBeNull()
    })

    it('counts another column as no bind', () => {
      expect(
        problem(
          loose
            .selectFrom('runs as r')
            .innerJoin('tasks as t', 't.task_id', 'r.task_id')
            .select('r.run_id')
            .whereRef('r.state', '=', 't.state'),
        ),
        'mutation-verdict:construction:tree-read-bind-is-a-value',
      ).toBeNull()
    })

    it('holds a checkpoint status to a literal as well', () => {
      expect(
        String(
          problem(
            loose
              .selectFrom('checkpoints as c')
              .select('c.state')
              .where('c.status', '=', 'committed'),
          ),
        ),
        'mutation-verdict:construction:tree-read-status-is-a-state',
      ).toMatch(BOUND)
    })
  })

  describe('the shape of an INSERT', () => {
    const PLAIN = /one plain selection for each column/
    const EVENT = {
      queue: 'q',
      event_name: 'e',
      payload: 'p',
      emitted_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    }
    /** A follow-on insert into a table with no provenance, so only the grammar reads its list. */
    const checkpointsFrom = (columns: string[], select: (from: Loose) => Loose) =>
      followOn(
        loose
          .insertInto('checkpoints')
          .columns(columns)
          .expression(
            select(loose.selectFrom('runs as f')).where((eb: Loose) => eb.and([key(eb), gate(eb)])),
          ),
      )

    it('refuses a star', () => {
      refuses('mutation-verdict:construction:tree-insert-shape-star', PLAIN, () =>
        checkpointsFrom(['task_id'], (from) => from.selectAll()),
      )
    })

    it('refuses a qualified star', () => {
      refuses('mutation-verdict:construction:tree-insert-shape-qualified-star', PLAIN, () =>
        checkpointsFrom(['task_id'], (from) => from.selectAll('f')),
      )
    })

    it('refuses fewer selections than columns', () => {
      refuses('mutation-verdict:construction:tree-insert-shape-selection-count', PLAIN, () =>
        checkpointsFrom(['task_id', 'owner_attempt'], (from) => from.select('f.task_id')),
      )
    })

    it('refuses an INSERT … SELECT with ON CONFLICT and no WHERE', () => {
      refuses(
        'mutation-verdict:construction:tree-insert-shape-conflict-needs-where',
        /needs a WHERE/,
        () => cas('register', unguardedWaitInsert()),
      )
    })

    it('refuses an INSERT with neither VALUES nor a SELECT', () => {
      refusesAs(
        'mutation-verdict:construction:tree-insert-shape-values-or-select',
        /exactly one row of values or one SELECT/,
        /must insert fence_stamp as the stamp/,
        () => cas('event', loose.insertInto('events')),
      )
    })

    it('refuses two rows of VALUES', () => {
      refuses(
        'mutation-verdict:construction:tree-insert-shape-one-row',
        /exactly one row of values/,
        () => cas('event', loose.insertInto('events').values([EVENT, EVENT])),
      )
    })

    it('refuses an ON CONFLICT that names no columns', () => {
      refuses(
        'mutation-verdict:construction:tree-insert-shape-conflict-names-columns',
        /names no columns/,
        () =>
          cas(
            'event',
            (eventInsert() as Loose).onConflict((oc: Loose) => oc.doNothing()),
          ),
      )
    })

    it('refuses a fragment in an index predicate', () => {
      refuses(
        'mutation-verdict:construction:tree-insert-shape-index-predicate-fragment',
        /an index predicate that holds a fragment/,
        () =>
          cas(
            'task',
            (taskInsert() as Loose).onConflict((oc: Loose) =>
              oc
                .columns(['queue', 'idempotency_key'])
                .where(predicate('idempotency_key IS NOT NULL'))
                .doNothing(),
            ),
          ),
      )
    })

    it('refuses a bound value in an index predicate', () => {
      refuses(
        'mutation-verdict:construction:tree-insert-shape-index-predicate-bind',
        /an index predicate that holds a bound value/,
        () =>
          cas(
            'task',
            (taskInsert() as Loose).onConflict((oc: Loose) =>
              oc.columns(['queue', 'idempotency_key']).where('state', '=', 'pending').doNothing(),
            ),
          ),
      )
    })

    it('refuses a provenance column listed twice', () => {
      refuses(
        'mutation-verdict:construction:tree-inserted-column-listed-once',
        /must insert fence_stamp as the stamp/,
        () =>
          cas(
            'register',
            loose
              .insertInto('waits')
              // The wait names the fixtures' event, so the lock rule has nothing to say and
              // the stamp rule is the one that answers.
              .columns(['event_name', 'fence_stamp', 'fence_stamp', 'fence_at_ms'])
              .expression(
                loose
                  .selectNoFrom((eb: Loose) => [
                    eb.val('e').as('event_name'),
                    aliasedAs(stampValue, 'fence_stamp'),
                    aliasedAs(stampValue, 'again'),
                    aliasedAs(nowValue, 'fence_at_ms'),
                  ])
                  .where(predicate('1 = 1')),
              ),
          ),
      )
    })
  })

  describe('where a fragment stands', () => {
    const AS_PREDICATE = /a 'value' fragment standing as a predicate/
    const AS_SUBQUERY = /a 'value' fragment standing as a subquery/
    const selected = (): Loose => value<string>("(SELECT 'job')")

    it('reads the operand of EXISTS as a subquery', () => {
      refusesAs(
        'mutation-verdict:construction:tree-role-operand-of-exists',
        AS_SUBQUERY,
        AS_PREDICATE,
        () => followOn((taskFollowOn() as Loose).where((eb: Loose) => eb.exists(selected()))),
      )
    })

    it('reads the operand of IN as a subquery', () => {
      refuses('mutation-verdict:construction:tree-role-operand-of-in', AS_SUBQUERY, () =>
        followOn((taskFollowOn() as Loose).where((eb: Loose) => eb('task_name', 'in', selected()))),
      )
    })

    it('reads the operand of NOT IN as a subquery', () => {
      refuses('mutation-verdict:construction:tree-role-operand-of-not-in', AS_SUBQUERY, () =>
        followOn(
          (taskFollowOn() as Loose).where((eb: Loose) => eb('task_name', 'not in', selected())),
        ),
      )
    })

    it('reads a whole WHERE as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-of-where', AS_PREDICATE, () =>
        cas('win', winCas().clearWhere().where(asValue())),
      )
    })

    it('reads a whole HAVING as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-of-having', AS_PREDICATE, () =>
        tail(fencedRuns().groupBy('run_id').having(asValue('COUNT(*) = 1'))),
      )
    })

    it('reads a whole ON as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-of-on', AS_PREDICATE, () =>
        tail(
          loose
            .selectFrom('runs as f')
            .innerJoin('tasks as t', (join: Loose) => join.on(asValue()))
            .select('f.state')
            .where('f.fence_stamp', '=', fenceValue('win')),
        ),
      )
    })

    it('reads a whole CASE condition as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-of-when', AS_PREDICATE, () =>
        setting((eb) => ({ infra_retries: eb.case().when(asValue()).then(1).else(0).end() })),
      )
    })

    it('reads a conjunct as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-under-and', AS_PREDICATE, () =>
        followOn(taskFollowOn().where(asValue())),
      )
    })

    it('reads a disjunct as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-under-or', AS_PREDICATE, () =>
        followOn(
          (taskFollowOn() as Loose).where((eb: Loose) =>
            eb.or([asValue(), eb('task_name', '=', 'job')]),
          ),
        ),
      )
    })

    it('reads the operand of NOT as a predicate', () => {
      refuses('mutation-verdict:construction:tree-role-boolean-under-not', AS_PREDICATE, () =>
        followOn((taskFollowOn() as Loose).where((eb: Loose) => eb.not(asValue()))),
      )
    })

    it('reads a subquery only under IN, NOT IN, and EXISTS', () => {
      refuses(
        'mutation-verdict:construction:tree-role-operand-only-of-in-or-exists',
        /a 'subquery' fragment standing as a value/,
        () =>
          followOn(
            (taskFollowOn() as Loose).where((eb: Loose) =>
              eb('task_name', '=', subquery("(SELECT 'job')")),
            ),
          ),
      )
    })

    describe('the raw node the builder makes for an ORDER BY direction', () => {
      const UNMINTED = /a raw fragment that rawSql did not mint/

      it('is exempt only as the direction, never as the ORDER BY expression', () => {
        accepts('control: a direction the builder made', () =>
          tail(fencedRuns().orderBy('run_id', 'desc')),
        )
        refuses(
          'mutation-verdict:construction:tree-builder-raw-stands-as-direction',
          UNMINTED,
          () => tail((fencedRuns() as Loose).orderBy(sql.raw('desc'))),
        )
      })

      it('carries no parameter', () => {
        refuses('mutation-verdict:construction:tree-builder-raw-has-no-parameters', UNMINTED, () =>
          tail((fencedRuns() as Loose).orderBy('run_id', sql`desc ${1}`)),
        )
      })

      it('reads asc or desc and nothing else', () => {
        refuses('mutation-verdict:construction:tree-builder-raw-text', UNMINTED, () =>
          tail((fencedRuns() as Loose).orderBy('run_id', sql.raw('desc nulls last'))),
        )
      })
    })
  })

  describe('the spellings of a clock', () => {
    const READS = /reads the clock/
    // A name that is also a bare keyword below has no row: the keyword arm refuses its call too.
    const CALLED = [
      ['unixepoch', 'mutation-verdict:construction:tree-clock-function-unixepoch'],
      ['julianday', 'mutation-verdict:construction:tree-clock-function-julianday'],
      ['strftime', 'mutation-verdict:construction:tree-clock-function-strftime'],
      ['now', 'mutation-verdict:construction:tree-clock-function-now'],
      ['sysdate', 'mutation-verdict:construction:tree-clock-function-sysdate'],
      ['clock_timestamp', 'mutation-verdict:construction:tree-clock-function-clock-timestamp'],
      [
        'statement_timestamp',
        'mutation-verdict:construction:tree-clock-function-statement-timestamp',
      ],
      [
        'transaction_timestamp',
        'mutation-verdict:construction:tree-clock-function-transaction-timestamp',
      ],
      ['getdate', 'mutation-verdict:construction:tree-clock-function-getdate'],
      ['timeofday', 'mutation-verdict:construction:tree-clock-function-timeofday'],
      ['curdate', 'mutation-verdict:construction:tree-clock-function-curdate'],
      ['curtime', 'mutation-verdict:construction:tree-clock-function-curtime'],
      ['unix_timestamp', 'mutation-verdict:construction:tree-clock-function-unix-timestamp'],
    ] as const
    for (const [name, marker] of CALLED) {
      it(`refuses ${name} called in a fragment`, () => {
        refuses(marker, READS, () => startedAt(`${name}()`))
      })
    }

    it('refuses the call of a name that is also a bare keyword, by the keyword arm', () => {
      // These six are in the list of clock functions and need no entry there for text:
      // deleting one leaves its call refused, which is why they have no mutation.
      for (const name of [
        'utc_timestamp',
        'utc_date',
        'utc_time',
        'localtime',
        'localtimestamp',
        'current_timestamp',
      ]) {
        expect(() => startedAt(`${name}()`), name).toThrow(READS)
      }
    })

    it('refuses a clock spelled in upper case in a fragment', () => {
      refuses('mutation-verdict:construction:tree-clock-spelling-case-fold', READS, () =>
        startedAt('SYSDATE()'),
      )
    })

    it('refuses a clock function called in a fragment', () => {
      refuses('mutation-verdict:construction:tree-clock-spelling-call-arm', READS, () =>
        startedAt('sysdate()'),
      )
    })

    it('refuses a bare clock keyword in a fragment', () => {
      refuses('mutation-verdict:construction:tree-clock-spelling-keyword-arm', READS, () =>
        startedAt('current_date'),
      )
    })

    it('refuses a date function with no argument in a fragment', () => {
      refuses('mutation-verdict:construction:tree-clock-spelling-no-argument-arm', READS, () =>
        startedAt('datetime()'),
      )
    })

    it('refuses a read of the fake clock row in a fragment', () => {
      // The test clock lives in meta. A fragment that reads it has read the clock, by a
      // door no clock function names.
      refuses('mutation-verdict:construction:tree-clock-spelling-fake-clock-arm', READS, () =>
        startedAt("(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'fake_now_ms')"),
      )
    })

    it('refuses the literal now in a fragment, whatever function takes it', () => {
      refuses('mutation-verdict:construction:tree-clock-now-literal', READS, () =>
        startedAt("timediff('now', '2000-01-01')"),
      )
    })

    it('refuses age in a fragment, with one argument and with two', () => {
      // PostgreSQL's age() with one argument measures from the current date, so it reads
      // the clock. With two it reads none and is refused all the same: no statement calls
      // it, and telling the two apart would mean reading SQL.
      expect(() => startedAt('age(created_at)')).toThrow(READS)
      expect(() => startedAt('age(created_at, updated_at)')).toThrow(READS)
    })

    const KEYWORDS = [
      ['current_timestamp', 'mutation-verdict:construction:tree-clock-keyword-current-timestamp'],
      ['current_time', 'mutation-verdict:construction:tree-clock-keyword-current-time'],
      ['current_date', 'mutation-verdict:construction:tree-clock-keyword-current-date'],
      ['localtime', 'mutation-verdict:construction:tree-clock-keyword-localtime'],
      ['localtimestamp', 'mutation-verdict:construction:tree-clock-keyword-localtimestamp'],
      ['utc_timestamp', 'mutation-verdict:construction:tree-clock-keyword-utc-timestamp'],
      ['utc_date', 'mutation-verdict:construction:tree-clock-keyword-utc-date'],
      ['utc_time', 'mutation-verdict:construction:tree-clock-keyword-utc-time'],
    ] as const
    for (const [word, marker] of KEYWORDS) {
      it(`refuses the bare keyword ${word} in a fragment`, () => {
        refuses(marker, READS, () => startedAt(word))
      })
    }

    const NO_ARGUMENT = [
      ['datetime', 'mutation-verdict:construction:tree-clock-no-argument-datetime'],
      ['date', 'mutation-verdict:construction:tree-clock-no-argument-date'],
      ['time', 'mutation-verdict:construction:tree-clock-no-argument-time'],
    ] as const
    for (const [word, marker] of NO_ARGUMENT) {
      it(`refuses ${word} called with no argument in a fragment`, () => {
        refuses(marker, READS, () => startedAt(`${word}()`))
      })
    }
  })

  describe('the spellings of a count', () => {
    const OPERATORS = [
      ['plus', '+', 'mutation-verdict:construction:tree-counting-operator-plus'],
      ['minus', '-', 'mutation-verdict:construction:tree-counting-operator-minus'],
      ['times', '*', 'mutation-verdict:construction:tree-counting-operator-times'],
      ['divide', '/', 'mutation-verdict:construction:tree-counting-operator-divide'],
      ['modulo', '%', 'mutation-verdict:construction:tree-counting-operator-modulo'],
      ['concat', '||', 'mutation-verdict:construction:tree-counting-operator-concat'],
    ] as const
    for (const [word, operator, marker] of OPERATORS) {
      it(`refuses a count spelled with ${word}`, () => {
        refuses(marker, /bumps a counter blindly/, () =>
          setting((eb) => ({ attempts: eb('attempts', operator, 1) })),
        )
      })
    }

    const MENTIONS = /raw fragment that mentions 'attempts'/

    it('sees an unqualified read of the assigned column in a fragment', () => {
      refuses('mutation-verdict:construction:tree-counting-mention-unqualified', MENTIONS, () =>
        attempts('coalesce(attempts, 0)'),
      )
    })

    it('sees a read of the assigned column through the written table in a fragment', () => {
      refuses('mutation-verdict:construction:tree-counting-mention-table-qualified', MENTIONS, () =>
        attempts('coalesce(tasks.attempts, 0)'),
      )
    })

    it('sees arithmetic after the column of another row in a fragment', () => {
      refuses('mutation-verdict:construction:tree-counting-mention-operator-after', MENTIONS, () =>
        attempts('(SELECT t.attempts + 1 FROM tasks t)'),
      )
    })

    it('sees arithmetic before the column of another row in a fragment', () => {
      refuses('mutation-verdict:construction:tree-counting-mention-operator-before', MENTIONS, () =>
        attempts('(SELECT 1 + t.attempts FROM tasks t)'),
      )
    })
  })
})

/**
 * The rules a scan of store SQL text applied to text alone, asked of the tree. Each test
 * carries one mutation's marker, and each shape is the nearest one only its condition decides.
 */
describe('a second definition of eligibility', () => {
  const STATE_LIST = /holds a list of states that is none of the defined sets/
  const DEADLINE = /holds a test of cancel_at_ms built from nodes/
  const runsWhere = (where: (eb: Loose) => Loose) =>
    cas(
      'win',
      loose
        .updateTable('runs')
        .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: nowValue })
        .where('run_id', '=', 'r1')
        .where(where),
    )
  const stateIn = (states: readonly unknown[]) => runsWhere((eb) => eb('state', 'in', states))

  describe('a list of states', () => {
    it('refuses a list built from nodes that is none of the defined sets', () => {
      refuses('mutation-verdict:construction:tree-state-list-built-from-nodes', STATE_LIST, () =>
        stateIn(['pending', 'running']),
      )
    })

    it('refuses such a list when its values are value nodes', () => {
      refuses('mutation-verdict:construction:tree-state-list-of-value-nodes', STATE_LIST, () =>
        runsWhere((eb) => eb('state', 'in', [eb.val('pending'), eb.val('running')])),
      )
    })

    const SETS = [
      [
        'live',
        ['pending', 'running', 'sleeping'],
        'mutation-verdict:construction:tree-state-set-live',
      ],
      ['queued', ['pending', 'sleeping'], 'mutation-verdict:construction:tree-state-set-queued'],
      [
        'terminal',
        ['completed', 'failed', 'cancelled'],
        'mutation-verdict:construction:tree-state-set-terminal',
      ],
    ] as const
    for (const [name, states, marker] of SETS) {
      it(`accepts the ${name} states, in any order`, () => {
        accepts(marker, () => stateIn([...states].reverse()))
      })
    }

    it('accepts one state, which defines no set', () => {
      accepts('mutation-verdict:construction:tree-state-list-one-state', () => stateIn(['pending']))
    })

    it('accepts a list on a state column that names no state', () => {
      accepts('mutation-verdict:construction:tree-state-list-names-a-state', () =>
        stateIn(['{"step":1}', '{"step":2}']),
      )
    })

    it('refuses a defined set with one state more', () => {
      refuses('mutation-verdict:construction:tree-state-list-length', STATE_LIST, () =>
        stateIn(['pending', 'running', 'sleeping', 'failed']),
      )
    })

    it('refuses a list as long as a defined set that is not one', () => {
      refuses('mutation-verdict:construction:tree-state-list-members', STATE_LIST, () =>
        stateIn(['pending', 'running', 'failed']),
      )
      // Terminal states alone name states too.
      refuses('two of the terminal states', STATE_LIST, () => stateIn(['completed', 'failed']))
    })

    it('reads a list only when it is compared with a state column, so caller data is never judged', () => {
      accepts('mutation-verdict:construction:tree-state-list-keys-on-the-column', () =>
        runsWhere((eb) => eb('queue', 'in', ['failed', 'orders'])),
      )
      // A row of inserted values names a state beside its other columns, and is no list of states.
      accepts('a row of inserted values', () => cas('task', taskInsert()))
    })

    it('reads the state column through a cast or a call around it, as the deadline is read', () => {
      refuses('a cast around the column', STATE_LIST, () =>
        runsWhere((eb) => eb(eb.cast(eb.ref('state'), 'text'), 'in', ['pending', 'running'])),
      )
      refuses('a call around the column', STATE_LIST, () =>
        runsWhere((eb) =>
          eb(eb.fn('coalesce', [eb.ref('state'), eb.val('pending')]), 'in', ['pending', 'running']),
        ),
      )
      accepts('the live states through a cast', () =>
        runsWhere((eb) =>
          eb(eb.cast(eb.ref('state'), 'text'), 'in', ['pending', 'running', 'sleeping']),
        ),
      )
    })

    it('reads a quoted state column in the text of a fragment', () => {
      for (const text of [
        `"state" IN ('pending','running')`,
        "`state` IN ('pending','running')",
        `t."state" not in ('pending','running')`,
      ]) {
        refuses(text, STATE_LIST, () => runsWhere(() => predicate(text)))
      }
      accepts('the live states on a quoted column', () =>
        runsWhere(() => predicate(`"state" IN ('pending','running','sleeping')`)),
      )
    })

    it('reads a qualified state column, and NOT IN as it reads IN', () => {
      refuses('a qualified column', STATE_LIST, () =>
        runsWhere((eb) => eb('runs.state', 'in', ['pending', 'running'])),
      )
      refuses('NOT IN', STATE_LIST, () =>
        runsWhere((eb) => eb('state', 'not in', ['pending', 'running'])),
      )
    })

    it('never quotes the list, which may hold bound data', () => {
      expect(() => stateIn(['pending', 'a-customer-secret'])).toThrow(STATE_LIST)
      expect(() => stateIn(['pending', 'a-customer-secret'])).not.toThrow(/a-customer-secret/)
    })

    it('refuses such a list in the text of a fragment', () => {
      for (const text of [
        "state IN ('pending','running')",
        "t.state not in ( 'pending' , 'running' )",
        "state = ANY ('pending','running')",
      ]) {
        refuses('mutation-verdict:construction:tree-state-list-in-a-fragment', STATE_LIST, () =>
          runsWhere(() => predicate(text)),
        )
      }
      accepts('a fragment that lists the live states', () =>
        runsWhere(() => predicate("state IN ('pending','running','sleeping')")),
      )
    })

    it('reads the binds a list in a fragment takes, after the binds before it', () => {
      refuses('mutation-verdict:construction:tree-state-list-bound-in-a-fragment', STATE_LIST, () =>
        runsWhere(() => predicate('queue = ? AND state IN (?, ?)', ['q', 'pending', 'running'])),
      )
      refuses('a partly bound list', STATE_LIST, () =>
        runsWhere(() => predicate("state IN ('pending', ?)", ['running'])),
      )
      accepts('the queued states, bound', () =>
        runsWhere(() => predicate('queue = ? AND state IN (?, ?)', ['q', 'sleeping', 'pending'])),
      )
    })

    it('reads a list in a fragment only when it is compared with a state column', () => {
      accepts('mutation-verdict:construction:tree-state-list-fragment-keys-on-the-column', () =>
        runsWhere(() => predicate('queue IN (?, ?)', ['failed', 'orders'])),
      )
    })

    it('reads every list of a fragment, and a defined one before it clears nothing', () => {
      refuses(
        'mutation-verdict:construction:tree-state-list-every-list-of-a-fragment',
        STATE_LIST,
        () =>
          runsWhere(() =>
            predicate("state IN ('pending','sleeping') OR state IN ('pending','running')"),
          ),
      )
    })

    it('keeps the first problem it finds, whatever the statement holds after it', () => {
      refuses(
        'mutation-verdict:construction:tree-eligibility-first-problem-stands',
        STATE_LIST,
        () =>
          runsWhere((eb) =>
            eb.and([
              eb('state', 'in', ['pending', 'running']),
              eb('state', 'in', ['pending', 'sleeping']),
            ]),
          ),
      )
    })

    it('is asked of a statement of every kind', () => {
      refuses(
        'mutation-verdict:construction:tree-eligibility-asked-of-every-statement',
        STATE_LIST,
        () =>
          tail(
            loose
              .selectFrom('runs')
              .select('run_id')
              .where('fence_stamp', '=', fenceValue('win'))
              .where('state', 'in', ['pending', 'running']),
          ),
      )
    })

    it('does not read these spellings of a set, which is what a check of spellings cannot do', () => {
      // The false negatives, run. Each defines the set {pending, running}, which is no
      // defined set, and each passes.
      const EXHIBITS: Readonly<Record<string, (eb: Loose) => Loose>> = {
        'alternatives joined by OR': (eb) =>
          eb.or([eb('state', '=', 'pending'), eb('state', '=', 'running')]),
        'one-state lists joined by OR': (eb) =>
          eb.or([eb('state', 'in', ['pending']), eb('state', 'in', ['running'])]),
        'a chain of <>': (eb) =>
          eb.and([
            eb('state', '<>', 'sleeping'),
            eb('state', '<>', 'completed'),
            eb('state', '<>', 'failed'),
            eb('state', '<>', 'cancelled'),
          ]),
        'CASE arms': (eb) =>
          eb(
            eb
              .case()
              .when('state', '=', 'pending')
              .then(1)
              .when('state', '=', 'running')
              .then(1)
              .else(0)
              .end(),
            '=',
            1,
          ),
        'alternatives in a fragment': () => predicate("(state = 'pending' OR state = 'running')"),
        'an array in a fragment': () => predicate("state = ANY(ARRAY['pending','running'])"),
        'a join to a list of values in a fragment': () =>
          predicate("state IN (SELECT v FROM (VALUES ('pending'), ('running')) AS s(v))"),
      }
      for (const [name, where] of Object.entries(EXHIBITS)) accepts(name, () => runsWhere(where))
      // The complement of a defined set is that set's other half, and the rule reads it as
      // the defined set it lists: NOT IN the terminal states defines the live states again.
      accepts('the complement of a defined set', () =>
        runsWhere((eb) => eb('state', 'not in', ['completed', 'failed', 'cancelled'])),
      )
    })
  })

  describe('a test of the cancellation deadline', () => {
    it('refuses every comparison of cancel_at_ms built from nodes', () => {
      for (const operator of ['<', '<=', '>', '>=', '=', '==', '!=', '<>', 'is distinct from']) {
        refuses('mutation-verdict:construction:tree-deadline-refuses-a-comparison', DEADLINE, () =>
          runsWhere((eb) => eb('cancel_at_ms', operator, 5)),
        )
      }
      refuses('BETWEEN', DEADLINE, () => runsWhere((eb) => eb.between('cancel_at_ms', 0, 5)))
    })

    it('refuses it with the column on the right', () => {
      refuses('mutation-verdict:construction:tree-deadline-either-side', DEADLINE, () =>
        runsWhere((eb) => eb(eb.val(5), '>=', eb.ref('cancel_at_ms'))),
      )
    })

    it('refuses it with arithmetic or a call around the column', () => {
      // Arithmetic is an operator on the column, so it is refused as itself. A call is no
      // operator, so only reading below the operand finds the column inside it.
      refuses('arithmetic around the column', DEADLINE, () =>
        runsWhere((eb) => eb(eb('cancel_at_ms', '-', 5), '<=', 0)),
      )
      refuses('mutation-verdict:construction:tree-deadline-under-a-call', DEADLINE, () =>
        runsWhere((eb) => eb(eb.fn('coalesce', [eb.ref('cancel_at_ms'), eb.val(0)]), '<=', 5)),
      )
    })

    it('accepts IS NULL', () => {
      accepts('mutation-verdict:construction:tree-deadline-test-is-null', () =>
        runsWhere((eb) => eb('cancel_at_ms', 'is', null)),
      )
    })

    it('accepts IS NOT NULL', () => {
      accepts('mutation-verdict:construction:tree-deadline-test-is-not-null', () =>
        runsWhere((eb) => eb('cancel_at_ms', 'is not', null)),
      )
    })

    it('accepts any operator on another column', () => {
      accepts('mutation-verdict:construction:tree-deadline-names-the-column', () =>
        runsWhere((eb) => eb('available_at_ms', '<=', 5)),
      )
    })

    it('judges a subquery as its own statement, and not as an operand of the comparison that holds it', () => {
      accepts('mutation-verdict:construction:tree-deadline-stops-at-a-subquery', () =>
        runsWhere((eb) =>
          eb(
            'task_id',
            'in',
            eb.selectFrom('tasks').select('task_id').where('cancel_at_ms', 'is', null),
          ),
        ),
      )
      refuses('a comparison inside the subquery', DEADLINE, () =>
        runsWhere((eb) =>
          eb(
            'task_id',
            'in',
            eb.selectFrom('tasks').select('task_id').where('cancel_at_ms', '<=', 5),
          ),
        ),
      )
    })

    it('does not read a comparison written in a fragment, which is where a store compares the deadline', () => {
      // The false negative, run: a second comparison of the deadline written as text in a
      // core statement passes this rule. The scan of store SQL text cannot see core either.
      accepts('a comparison in a fragment', () => runsWhere(() => predicate('cancel_at_ms <= 5')))
    })
  })
})
