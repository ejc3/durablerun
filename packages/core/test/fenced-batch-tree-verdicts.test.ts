import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  FencedBatch,
  aliasedAs,
  treeBuilder as db,
  fenceValue,
  isFencedBatchBindError,
  nowValue,
  rawSql,
  sqlFragment,
  stampValue,
} from '../src/index.js'
import {
  CLOCK,
  type Loose,
  accepts,
  batch,
  batchWithClock,
  capturingExecutor,
  cas,
  checkpoint,
  eventInsert,
  eventRow,
  eventUpsert,
  fenced,
  followOn,
  gate,
  joined,
  joinedRead,
  keyIn,
  loose,
  many,
  predicate,
  recorded,
  refuses,
  refusesAs,
  stampedTasks,
  statement,
  successor,
  tail,
  taskFollowOn,
  tasksSetting,
  tasksWhere,
  throughDerived,
  tiedBy,
  tiedKeys,
  value,
  waitInsert,
  winCas,
  withCas,
} from './tree-fixtures.js'

/**
 * One test for each registered mutation of a tree rule. A mutation deletes one condition,
 * and its test builds the nearest shape only that condition refuses, beside a control the
 * rule accepts. `fenced-batch-tree.test.ts` holds the rules' wider cases. These tests are
 * the ones `scripts/mutation-probe.py` runs, one for each mutant, so each carries exactly
 * one marker and nothing a second mutant could trip first.
 */

const NO_GATE = /has no fence gating every row/
const UNTIED = /not tied to the rows it reads or writes/
const PLAIN = /must select plain columns and values/

// Refused shapes that more than one condition holds, each named once.
/** A gate that compares the fence and ties nothing to the task it completes. */
const untiedGate = () => tiedBy((select) => select.where('f.run_id', '=', 'r1'))
/** A second FROM source beside the fenced run. */
const besideTasks = () => loose.selectFrom(['runs as f', 'tasks as t2'])
/** The stamp of the statement this one follows, inserted as its own. */
const fenceAsStamp = () => successor({ stamp: fenceValue('win') })
/** An aggregate where a plain column belongs. */
const aggregated = () => successor({ task: (eb: Loose) => eb.fn.max('f.task_id') })
/** A raw node nobody minted, standing as a predicate. */
const unmintedPredicate = () => taskFollowOn().where(sql.raw<boolean>(`task_name = 'job'`))

describe('the tree path', () => {
  describe('stamping', () => {
    it('refuses a compare-and-set of a table that carries no provenance', () => {
      expect(() => cas('win', winCas())).not.toThrow()
      refuses(
        'mutation-verdict:construction:tree-cas-writes-fenced-table',
        /must write a provenance-carrying table/,
        () =>
          cas(
            'win',
            loose.updateTable('checkpoints').set({ status: 'x' }).where('task_id', '=', 't1'),
          ),
      )
    })

    it('refuses a compare-and-set update that assigns the clock and no stamp', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-update-stamp',
        /must assign fence_stamp the stamp and fence_at_ms the clock/,
        () =>
          cas(
            'win',
            db
              .updateTable('runs')
              .set({ state: 'completed', fence_at_ms: nowValue })
              .where('run_id', '=', 'r1'),
          ),
      )
    })

    it('refuses a compare-and-set update whose instant is not the clock', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-update-clock-instant',
        /must assign fence_stamp the stamp and fence_at_ms the clock/,
        () =>
          cas(
            'win',
            db
              .updateTable('runs')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
              .where('run_id', '=', 'r1'),
          ),
      )
    })

    it('refuses a follow-on update of a fenced table that assigns an instant and no stamp', () => {
      expect(() =>
        followOn(tasksSetting({ fence_stamp: stampValue, fence_at_ms: 5 })),
      ).not.toThrow()
      refuses('mutation-verdict:construction:tree-followon-update-stamp', /does not stamp it/, () =>
        followOn(tasksSetting({ fence_at_ms: 5 })),
      )
    })

    it('refuses a follow-on update of a fenced table that assigns the stamp and no instant', () => {
      refuses(
        'mutation-verdict:construction:tree-followon-update-instant',
        /does not stamp it/,
        () => followOn(tasksSetting({ fence_stamp: stampValue })),
      )
    })

    it('refuses a stamp assigned twice', () => {
      refuses(
        'mutation-verdict:construction:tree-stamp-assigned-once',
        /must assign fence_stamp the stamp/,
        () => cas('win', winCas().set('fence_stamp', 'forged')),
      )
    })

    it('refuses a follow-on instant assigned twice', () => {
      refuses(
        'mutation-verdict:construction:tree-followon-instant-assigned-once',
        /does not stamp it/,
        () =>
          followOn(tasksSetting({ fence_stamp: stampValue, fence_at_ms: 5 }).set('fence_at_ms', 7)),
      )
    })

    it('refuses a compare-and-set clock assigned twice', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-instant-assigned-once',
        /must assign fence_stamp the stamp and fence_at_ms the clock/,
        () => cas('win', winCas().set('fence_at_ms', 7)),
      )
    })

    it('refuses a fence value assigned as the stamp of an update', () => {
      refuses(
        'mutation-verdict:construction:tree-update-stamp-is-the-stamp-token',
        /does not stamp it/,
        () => followOn(tasksSetting({ fence_stamp: fenceValue('win'), fence_at_ms: 5 })),
      )
    })

    it('refuses the stamp assigned where the clock belongs', () => {
      refuses(
        'mutation-verdict:construction:tree-update-clock-is-the-clock-token',
        /must assign fence_stamp the stamp and fence_at_ms the clock/,
        () =>
          cas(
            'win',
            loose
              .updateTable('runs')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: stampValue })
              .where('run_id', '=', 'r1'),
          ),
      )
    })

    it('refuses a compare-and-set that is a DELETE', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-refuses-delete',
        /must be an UPDATE or an INSERT/,
        () => cas('win', loose.deleteFrom('runs').where('run_id', '=', 'r1')),
      )
    })

    it('refuses a follow-on that is a SELECT', () => {
      refuses(
        'mutation-verdict:construction:tree-statement-kind',
        /must be an UPDATE, a DELETE, or an INSERT … SELECT/,
        () =>
          followOn(
            db.selectFrom('runs').select('state').where('fence_stamp', '=', fenceValue('win')),
          ),
      )
    })
  })

  describe('the gate', () => {
    it('refuses a follow-on that compares no fence', () => {
      expect(() => followOn(taskFollowOn())).not.toThrow()
      refuses('mutation-verdict:construction:tree-positive-fence-required', NO_GATE, () =>
        followOn(stampedTasks().where('task_id', '=', 't1')),
      )
    })

    it('refuses a fence joined to the row by OR', () => {
      refuses('mutation-verdict:construction:tree-top-level-or-reach', NO_GATE, () =>
        followOn(
          loose
            .updateTable('runs')
            .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
            .where((eb: Loose) =>
              eb.or([eb('run_id', '=', 'r1'), eb('fence_stamp', '=', fenceValue('win'))]),
            ),
        ),
      )
    })

    it('refuses a fence compared with anything but equality', () => {
      const compared = (operator: string) =>
        loose
          .updateTable('runs')
          .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where('run_id', '=', 'r1')
          .where('fence_stamp', operator as never, fenceValue('win'))
      expect(() => followOn(compared('='))).not.toThrow()
      refuses('mutation-verdict:construction:tree-fence-equality-operator', NO_GATE, () =>
        followOn(compared('is not')),
      )
    })

    it('refuses a fence compared with a column that is not the stamp', () => {
      refuses('mutation-verdict:construction:tree-fence-equality-column', NO_GATE, () =>
        followOn(
          loose
            .updateTable('runs')
            .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
            .where('run_id', '=', fenceValue('win')),
        ),
      )
    })

    it('refuses an unqualified stamp when the statement reads two sources', () => {
      expect(() => tail(joinedRead('f.fence_stamp'))).not.toThrow()
      refuses('mutation-verdict:construction:tree-fence-equality-ambiguous-source', NO_GATE, () =>
        tail(joinedRead('fence_stamp')),
      )
    })

    it('refuses a gate that asks for the row to be absent from the fenced keys', () => {
      refuses('mutation-verdict:construction:tree-gate-not-in', NO_GATE, () =>
        followOn(tasksWhere((eb) => eb('task_id', 'not in', tiedKeys(eb)))),
      )
    })

    it('refuses a fence token that names no statement, wherever it stands', () => {
      refuses(
        'mutation-verdict:construction:tree-raw-fence-token-check',
        /names no statement of this batch/,
        () =>
          followOn(
            taskFollowOn().where((eb) =>
              eb.or([eb('task_name', '=', 'job'), eb('fence_stamp', '=', fenceValue('missing'))]),
            ),
          ),
      )
    })

    it('refuses a tail that is not a SELECT', () => {
      refuses('mutation-verdict:construction:tree-tail-must-select', /must be a SELECT/, () =>
        tail(taskFollowOn()),
      )
    })

    it('refuses an open tail that gives no reason', () => {
      const others = () => db.selectFrom('events').select('payload').where('queue', '=', 'q')
      expect(() => withCas().openTailTree('read', 'a reason', statement(others()))).not.toThrow()
      refuses('mutation-verdict:construction:tree-open-tail-reason', /needs a reason/, () =>
        withCas().openTailTree('read', ' ', statement(others())),
      )
    })

    it('refuses an open tail whose fence is compared on a table that fence does not stamp', () => {
      refuses(
        'mutation-verdict:construction:tree-open-tail-table-check',
        /stamps 'runs', but the statement compares tasks\.fence_stamp/,
        () =>
          withCas().openTailTree(
            'read',
            'a reason',
            statement(
              db.selectFrom('tasks').select('state').where('fence_stamp', '=', fenceValue('win')),
            ),
          ),
      )
    })

    it('refuses a gate that asks for no fenced row to exist', () => {
      refuses('mutation-verdict:construction:tree-gate-exists-operator', NO_GATE, () =>
        followOn(
          tasksWhere((eb) =>
            eb.unary(
              'not exists',
              fenced(eb).select('f.run_id').whereRef('f.task_id', '=', 'tasks.task_id'),
            ),
          ),
        ),
      )
    })

    it('refuses an unqualified stamp when a joined source shares the scope', () => {
      refuses('mutation-verdict:construction:tree-scope-includes-joins', NO_GATE, () =>
        tail(joinedRead('fence_stamp')),
      )
    })

    it('refuses an unqualified stamp when a second FROM source shares the scope', () => {
      refuses('mutation-verdict:construction:tree-scope-includes-every-from', NO_GATE, () =>
        tail(
          loose
            .selectFrom(['runs as f', 'tasks as t'])
            .select('f.state')
            .where('fence_stamp', '=', fenceValue('win')),
        ),
      )
    })

    it('refuses a fence compared on the stamp of the outer row', () => {
      refuses('mutation-verdict:construction:tree-fence-equality-qualifier-in-scope', NO_GATE, () =>
        many(
          tasksWhere((eb) =>
            eb.exists(
              eb
                .selectFrom('runs as f')
                .select('f.run_id')
                .where('tasks.fence_stamp', '=', fenceValue('win'))
                .whereRef('f.task_id', '=', 'tasks.task_id'),
            ),
          ),
        ),
      )
    })

    it('names the tie when a gate is refused for being untied', () => {
      refusesAs('mutation-verdict:construction:tree-gate-untied-message', UNTIED, NO_GATE, () =>
        many(untiedGate()),
      )
    })

    it('refuses a fence on a name no statement of the batch has', () => {
      refuses(
        'mutation-verdict:construction:tree-fence-names-a-statement',
        /names no statement of this batch/,
        () =>
          followOn(
            loose
              .updateTable('runs')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
              .where('run_id', '=', 'r1')
              .where('fence_stamp', '=', fenceValue('missing')),
          ),
      )
    })

    it('refuses a fence on a statement that writes no stamp', () => {
      const cleared = withCas().followOnTree(
        'cleared',
        statement(
          loose
            .deleteFrom('waits')
            .where((eb: Loose) => eb('run_id', 'in', fenced(eb).select('f.run_id'))),
        ),
        { many: 'a test' },
      )
      refuses(
        'mutation-verdict:construction:tree-fence-source-writes-a-stamp',
        /which writes no stamp/,
        () =>
          cleared.followOnTree(
            'after',
            statement(
              loose
                .updateTable('runs')
                .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
                .where('run_id', '=', 'r1')
                .where('fence_stamp', '=', fenceValue('cleared')),
            ),
            'one',
          ),
      )
    })

    it('refuses the stamp compared with the stamp column as a gate', () => {
      refusesAs(
        'mutation-verdict:construction:tree-fence-equality-is-a-fence-token',
        NO_GATE,
        /names no statement of this batch/,
        () =>
          followOn(
            loose
              .updateTable('runs')
              .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
              .where('run_id', '=', 'r1')
              .where('fence_stamp', '=', stampValue),
          ),
      )
    })
  })

  describe('a subquery that may not return a row whatever it matched', () => {
    const counted = (selection: (eb: Loose) => Loose, having = false) =>
      tasksWhere((eb) => {
        const inner = fenced(eb)
          .select((s: Loose) => selection(s))
          .whereRef('f.task_id', '=', 'tasks.task_id')
        return eb.exists(having ? inner.having((h: Loose) => h(h.fn.countAll(), '>=', 0)) : inner)
      })
    const plain = (eb: Loose) => eb.ref('f.run_id').as('run_id')

    it('reads no gate through a subquery whose selection always returns a row', () => {
      expect(() => followOn(counted(plain))).not.toThrow()
      refuses('mutation-verdict:construction:tree-gate-subquery-may-return-no-row', NO_GATE, () =>
        followOn(counted((eb) => eb.fn.countAll().as('n'))),
      )
    })

    it('reads no gate through an ungrouped HAVING', () => {
      refuses('mutation-verdict:construction:tree-no-row-having', NO_GATE, () =>
        followOn(counted(plain, true)),
      )
    })

    it('reads no gate through an aggregate node', () => {
      refuses('mutation-verdict:construction:tree-no-row-aggregate', NO_GATE, () =>
        followOn(counted((eb) => eb.fn.countAll().as('n'))),
      )
    })

    it('reads no gate through a function node', () => {
      refuses('mutation-verdict:construction:tree-no-row-function', NO_GATE, () =>
        followOn(counted((eb) => eb.fn('count', [eb.ref('f.run_id')]).as('n'))),
      )
    })

    it('reads no gate through a selection spelled in a fragment', () => {
      refuses('mutation-verdict:construction:tree-no-row-raw', NO_GATE, () =>
        followOn(counted(() => aliasedAs(value<number>('COUNT(*)'), 'n'))),
      )
    })

    it('reads no gate through a derived table that always returns a row', () => {
      const through = (grouped: boolean) => {
        const inner = loose
          .selectFrom('runs')
          .select((eb: Loose) => eb.fn.countAll().as('n'))
          .where('fence_stamp', '=', fenceValue('win'))
        return loose.selectFrom((grouped ? inner.groupBy('task_id') : inner).as('c')).select('n')
      }
      expect(() => tail(through(true))).not.toThrow()
      refuses('mutation-verdict:construction:tree-derived-gate-may-return-no-row', NO_GATE, () =>
        tail(through(false)),
      )
    })

    it('reads every selection, so one plain column beside an aggregate gates nothing', () => {
      refuses('mutation-verdict:construction:tree-no-row-every-selection', NO_GATE, () =>
        followOn(counted((eb) => [eb.ref('f.run_id').as('run_id'), eb.fn.countAll().as('n')])),
      )
    })
  })

  describe('the tie of a subquery gate to the fenced source', () => {
    it('counts only the gates that are tied', () => {
      expect(() =>
        many(tiedBy((select) => select.whereRef('f.task_id', '=', 'tasks.task_id'))),
      ).not.toThrow()
      refuses('mutation-verdict:construction:tree-gate-counts-only-tied', UNTIED, () =>
        many(untiedGate()),
      )
    })

    it('carries the tie of a subquery onto the fence inside it', () => {
      refuses('mutation-verdict:construction:tree-gate-requires-tie', UNTIED, () =>
        many(untiedGate()),
      )
    })

    it('reads one FROM source in a gating subquery', () => {
      expect(() => many(keyIn(tiedKeys))).not.toThrow()
      refuses('mutation-verdict:construction:tree-one-source-froms', UNTIED, () =>
        many(
          keyIn((eb) =>
            eb.selectFrom(['runs as f', 'tasks as t2']).where(gate).select('f.task_id'),
          ),
        ),
      )
    })

    it('reads no join in a gating subquery', () => {
      refuses('mutation-verdict:construction:tree-one-source-joins', UNTIED, () =>
        many(
          keyIn((eb) =>
            fenced(eb).innerJoin('tasks as t2', 't2.queue', 'f.queue').select('f.task_id'),
          ),
        ),
      )
    })

    it('ties IN by a column on its left', () => {
      refuses('mutation-verdict:construction:tree-tie-in-left-column', UNTIED, () =>
        many(tasksWhere((eb) => eb(eb.val('t1'), 'in', tiedKeys(eb)))),
      )
    })

    it('ties IN by a selected column of the fenced source', () => {
      refuses('mutation-verdict:construction:tree-tie-in-selects-source-column', UNTIED, () =>
        many(keyIn((eb) => fenced(eb).select(eb.val('t-victim').as('task_id')))),
      )
    })

    it('ties IN by one selection and no more', () => {
      refuses('mutation-verdict:construction:tree-tie-in-one-selection', UNTIED, () =>
        many(keyIn((eb) => fenced(eb).select(['f.task_id', eb.val('t-victim').as('other')]))),
      )
    })

    it('ties IN by a plain column and never an expression over one', () => {
      refuses('mutation-verdict:construction:tree-tie-in-plain-column', UNTIED, () =>
        many(keyIn((eb) => fenced(eb).select(eb('f.attempt', '+', 1).as('task_id')))),
      )
    })

    it('ties IN by a column the fenced source owns, never one of the outer row', () => {
      refuses('mutation-verdict:construction:tree-tie-in-source-qualifier', UNTIED, () =>
        many(keyIn((eb) => fenced(eb).select('tasks.task_id'))),
      )
    })

    it('ties IN through a derived table only by the column that table selects from the fenced source', () => {
      expect(() =>
        many(throughDerived((eb) => fenced(eb).select('f.task_id as source_key').distinct())),
      ).not.toThrow()
      refuses('mutation-verdict:construction:tree-tie-in-derived-column', UNTIED, () =>
        many(
          throughDerived((eb) => fenced(eb).select(eb.val('t-victim').as('source_key')).distinct()),
        ),
      )
    })

    it('ties EXISTS only when the subquery reads the fenced source alone', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-one-source', UNTIED, () =>
        many(
          tasksWhere((eb) =>
            eb.exists(
              eb
                .selectFrom(['runs as f', 'tasks as t2'])
                .where(gate)
                .select('f.run_id')
                .whereRef('t2.task_id', '=', 'tasks.task_id'),
            ),
          ),
        ),
      )
    })

    it('ties EXISTS by an equality and no other comparison', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-equality', UNTIED, () =>
        many(tiedBy((select) => select.whereRef('f.task_id', '!=', 'tasks.task_id'))),
      )
    })

    it('reads a name the subquery shadows as the inner source', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-shadowed-outer', UNTIED, () =>
        many(
          tasksWhere((eb) =>
            eb.exists(
              eb
                .selectFrom('runs as tasks')
                .select('tasks.run_id')
                .where('tasks.fence_stamp', '=', fenceValue('win'))
                .whereRef('tasks.task_id', '=', 'tasks.task_id'),
            ),
          ),
        ),
      )
    })

    it('refuses an untied subquery nested inside a tied one', () => {
      refuses('mutation-verdict:construction:tree-gate-inner-tie-carried', UNTIED, () =>
        many(
          keyIn((eb) =>
            eb
              .selectFrom('runs as f')
              .select('f.task_id')
              .where((inner: Loose) =>
                inner.exists(
                  inner
                    .selectFrom('runs as g')
                    .select('g.run_id')
                    .where('g.fence_stamp', '=', fenceValue('win'))
                    .where('g.run_id', '=', 'r1'),
                ),
              ),
          ),
        ),
      )
    })

    it('ties EXISTS by an outer column that names a source of the statement', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-outer-in-scope', UNTIED, () =>
        many(tiedBy((select) => select.whereRef('f.task_id', '=', 'elsewhere.task_id'))),
      )
    })

    const compared = (left: (eb: Loose) => Loose, right: (eb: Loose) => Loose) =>
      many(tiedBy((select, eb) => select.where(eb(left(eb), '=', right(eb)))))
    const bound = (eb: Loose) => eb.val('t1')
    const innerColumn = (eb: Loose) => eb.ref('f.task_id')
    const outerColumn = (eb: Loose) => eb.ref('tasks.task_id')

    it('ties nothing by a value equal to an outer column', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-value-equals-outer', UNTIED, () =>
        compared(bound, outerColumn),
      )
    })

    it('ties nothing by a column of the fenced source equal to a value', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-inner-equals-value', UNTIED, () =>
        compared(innerColumn, bound),
      )
    })

    it('ties nothing by an outer column equal to a value', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-outer-equals-value', UNTIED, () =>
        compared(outerColumn, bound),
      )
    })

    it('ties nothing by a value equal to a column of the fenced source', () => {
      refuses('mutation-verdict:construction:tree-tie-exists-value-equals-inner', UNTIED, () =>
        compared(bound, innerColumn),
      )
    })
  })

  describe('a follow-on that inserts', () => {
    const ALONE = /must select from the fenced row alone/
    const INSTANT = /fence_at_ms as the fenced row's own fence_at_ms/

    it('selects plain columns and values', () => {
      expect(() => followOn(successor())).not.toThrow()
      refuses('mutation-verdict:construction:tree-followon-insert-plain', PLAIN, () =>
        followOn(aggregated()),
      )
    })

    it('selects with no HAVING', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-no-having', PLAIN, () =>
        followOn(
          successor({
            from: (select: Loose) => select.having((eb: Loose) => eb(eb.fn.countAll(), '>=', 0)),
          }),
        ),
      )
    })

    it('selects no aggregate node', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-no-aggregate', PLAIN, () =>
        followOn(aggregated()),
      )
    })

    it('selects no function node', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-no-function', PLAIN, () =>
        followOn(successor({ task: (eb: Loose) => eb.fn('upper', [eb.ref('f.task_id')]) })),
      )
    })

    it('selects from the fenced row alone', () => {
      expect(() => followOn(successor({ from: joined }))).not.toThrow()
      refuses('mutation-verdict:construction:tree-followon-insert-alone', ALONE, () =>
        followOn(successor({ from: besideTasks })),
      )
    })

    it('selects from one FROM item', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-one-from', ALONE, () =>
        followOn(successor({ from: besideTasks })),
      )
    })

    it('selects from the source whose stamp it compares', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-from-is-fenced', ALONE, () =>
        followOn(
          successor({
            from: () =>
              loose.selectFrom('tasks as t2').innerJoin('runs as f', 'f.task_id', 't2.task_id'),
          }),
        ),
      )
    })

    it('carries an ON with every join', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-join-on', ALONE, () =>
        followOn(successor({ from: (select: Loose) => select.crossJoin('tasks as t2') })),
      )
    })

    it('inserts the stamp', () => {
      // The fence's value is the stamp of the statement this one follows, not its own.
      refuses(
        'mutation-verdict:construction:tree-followon-insert-stamp',
        /must insert fence_stamp as the stamp/,
        () => followOn(fenceAsStamp()),
      )
    })

    it('inserts an instant read from the fenced row', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-instant', INSTANT, () =>
        followOn(successor({ instant: (eb: Loose) => eb.val(5) })),
      )
    })

    it('reads the instant from fence_at_ms and no other column', () => {
      refuses('mutation-verdict:construction:tree-followon-insert-instant-column', INSTANT, () =>
        followOn(successor({ instant: (eb: Loose) => eb.ref('f.available_at_ms') })),
      )
    })

    it('reads the instant from the source whose stamp it compares', () => {
      refuses(
        'mutation-verdict:construction:tree-followon-insert-instant-fenced-source',
        INSTANT,
        () =>
          followOn(successor({ from: joined, instant: (eb: Loose) => eb.ref('t.fence_at_ms') })),
      )
    })

    it('reads an unqualified instant only when there is one source', () => {
      expect(() =>
        followOn(successor({ instant: (eb: Loose) => eb.ref('fence_at_ms') })),
      ).not.toThrow()
      refuses('mutation-verdict:construction:tree-followon-insert-instant-ambiguous', INSTANT, () =>
        followOn(successor({ from: joined, instant: (eb: Loose) => eb.ref('fence_at_ms') })),
      )
    })

    it('takes a preserved first instant from the fenced row', () => {
      expect(() => followOn(recorded((eb: Loose) => eb.ref('f.fence_at_ms')))).not.toThrow()
      refuses(
        'mutation-verdict:construction:tree-followon-insert-preserved-instant',
        /must insert events\.emitted_at_ms as the fenced row's own fence_at_ms/,
        () => followOn(recorded((eb: Loose) => eb.val(123))),
      )
    })

    it('carries no conflict clause into a stamped table', () => {
      refuses(
        'mutation-verdict:construction:tree-followon-insert-no-conflict',
        /may carry no conflict clause/,
        () =>
          followOn(
            successor().onConflict((conflict: Loose) => conflict.columns(['run_id']).doNothing()),
          ),
      )
    })

    it('refuses a fence value inserted as the stamp', () => {
      refuses(
        'mutation-verdict:construction:tree-followon-insert-stamp-is-the-stamp-token',
        /must insert fence_stamp as the stamp/,
        () => followOn(fenceAsStamp()),
      )
    })

    it('says a VALUES follow-on is refused for being VALUES', () => {
      refusesAs(
        'mutation-verdict:construction:tree-followon-insert-selects',
        /takes a SELECT, never VALUES/,
        PLAIN,
        () => followOn(eventInsert()),
      )
    })
  })

  describe('a compare-and-set that inserts', () => {
    const PRESERVE = /must preserve events\.emitted_at_ms while re-stamping/
    const preserved = (eb: Loose) => ({
      fence_stamp: stampValue,
      fence_at_ms: eb.ref('events.emitted_at_ms'),
    })

    it('inserts the stamp', () => {
      expect(() => cas('event', eventInsert())).not.toThrow()
      refuses(
        'mutation-verdict:construction:tree-cas-insert-stamp',
        /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
        () => cas('event', eventRow({ fence_stamp: 'forged' })),
      )
    })

    it('inserts the clock as the instant', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-insert-clock-instant',
        /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
        () => cas('event', eventRow({ fence_at_ms: 5 })),
      )
    })

    it('inserts the clock as a preserved first instant', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-insert-preserved-clock',
        /must insert events\.emitted_at_ms as the clock/,
        () => cas('event', eventRow({ emitted_at_ms: 12345 })),
      )
    })

    it('refuses an event upsert that re-stamps at the current statement instant', () => {
      expect(() => cas('event', eventUpsert(preserved))).not.toThrow()
      refuses(
        'mutation-verdict:construction:tree-event-upsert-requires-preserved-instant',
        PRESERVE,
        () =>
          cas(
            'event',
            eventUpsert(() => ({ fence_stamp: stampValue, fence_at_ms: nowValue })),
          ),
      )
    })

    it('copies the preserved instant from the row that is there', () => {
      refuses('mutation-verdict:construction:tree-upsert-preserved-instant-table', PRESERVE, () =>
        cas(
          'event',
          eventUpsert((eb) => ({
            fence_stamp: stampValue,
            fence_at_ms: eb.ref('excluded.emitted_at_ms'),
          })),
        ),
      )
    })

    it('copies the preserved instant from its own column', () => {
      refuses('mutation-verdict:construction:tree-upsert-preserved-instant-column', PRESERVE, () =>
        cas(
          'event',
          eventUpsert((eb) => ({
            fence_stamp: stampValue,
            fence_at_ms: eb.ref('events.fence_at_ms'),
          })),
        ),
      )
    })

    it('re-stamps the row a conflict leaves in place', () => {
      refuses('mutation-verdict:construction:tree-upsert-restamps', PRESERVE, () =>
        cas(
          'event',
          eventUpsert((eb) => ({ fence_at_ms: eb.ref('events.emitted_at_ms') })),
        ),
      )
    })

    it('re-stamps the instant with the stamp', () => {
      const upsert = (set: object) =>
        waitInsert().onConflict((oc) =>
          oc.columns(['run_id', 'step_name']).doUpdateSet(set as never),
        )
      expect(() =>
        cas('register', upsert({ fence_stamp: stampValue, fence_at_ms: nowValue })),
      ).not.toThrow()
      refuses(
        'mutation-verdict:construction:tree-upsert-restamps-instant',
        /does not re-stamp the row and its instant/,
        () => cas('register', upsert({ fence_stamp: stampValue })),
      )
    })

    it('assigns only provenance over a preserved fact', () => {
      refuses(
        'mutation-verdict:construction:tree-upsert-preserved-fact-columns',
        /may assign only fence_stamp and fence_at_ms/,
        () =>
          cas(
            'event',
            eventUpsert((eb) => ({ ...preserved(eb), payload: 'second' })),
          ),
      )
    })

    it('refuses the clock token inserted as the stamp', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-insert-stamp-is-the-stamp-token',
        /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
        () => cas('event', eventRow({ fence_stamp: nowValue })),
      )
    })

    it('refuses the stamp inserted where the clock belongs', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-insert-clock-is-the-clock-token',
        /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
        () => cas('event', eventRow({ fence_at_ms: stampValue })),
      )
    })

    it('refuses the stamp inserted as a preserved first instant', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-insert-preserved-is-the-clock-token',
        /must insert events\.emitted_at_ms as the clock/,
        () => cas('event', eventRow({ emitted_at_ms: stampValue })),
      )
    })
  })

  describe('counting assignments', () => {
    it('refuses arithmetic on the column a follow-on assigns', () => {
      refuses(
        'mutation-verdict:construction:tree-counting-arithmetic',
        /bumps a counter blindly/,
        () => followOn(taskFollowOn().set((eb) => ({ attempts: eb('attempts', '+', 1) }))),
      )
    })

    it('refuses a fragment that reads the column a follow-on assigns', () => {
      refuses(
        'mutation-verdict:construction:tree-counting-raw-fragment',
        /raw fragment that mentions 'attempts'/,
        () => followOn(taskFollowOn().set({ attempts: value<number>('attempts + 1') })),
      )
    })

    it('reads the conflict arm of an insert', () => {
      refuses(
        'mutation-verdict:construction:tree-counting-reads-conflict-arm',
        /bumps a counter blindly/,
        () => followOn(checkpoint({ owner: (eb: Loose) => eb('owner_attempt', '+', 1) })),
      )
    })

    it('reads excluded as the incoming row when it is built from nodes', () => {
      expect(() =>
        followOn(checkpoint({ owner: (eb: Loose) => eb('owner_attempt', '+', 1) })),
      ).toThrow(/bumps a counter blindly/)
      accepts('mutation-verdict:construction:tree-counting-excluded-is-incoming', () =>
        followOn(checkpoint({ owner: (eb: Loose) => eb('excluded.owner_attempt', '+', 1) })),
      )
    })

    it('reads excluded as the incoming row when it is spelled in a fragment', () => {
      expect(() =>
        followOn(
          checkpoint({ owner: () => value<number>('excluded.owner_attempt + owner_attempt') }),
        ),
      ).toThrow(/raw fragment that mentions 'owner_attempt'/)
      accepts('mutation-verdict:construction:tree-counting-excluded-in-fragment', () =>
        followOn(checkpoint({ owner: () => value<number>('excluded.owner_attempt + 1') })),
      )
    })

    it('refuses a count written column first', () => {
      refuses(
        'mutation-verdict:construction:tree-counting-left-operand',
        /bumps a counter blindly/,
        () => followOn(taskFollowOn().set((eb) => ({ attempts: eb('attempts', '+', 1) }))),
      )
    })

    it('refuses a count written column last', () => {
      refuses(
        'mutation-verdict:construction:tree-counting-right-operand',
        /bumps a counter blindly/,
        () =>
          followOn(
            (taskFollowOn() as Loose).set((eb: Loose) => ({
              attempts: eb(eb.val(1), '+', eb.ref('attempts')),
            })),
          ),
      )
    })

    it('says a blind count is a blind count', () => {
      refusesAs(
        'mutation-verdict:construction:tree-counting-arithmetic-message',
        /bumps a counter blindly/,
        /raw fragment that mentions/,
        () => followOn(taskFollowOn().set((eb) => ({ attempts: eb('attempts', '+', 1) }))),
      )
    })
  })

  describe('the clock', () => {
    it('refuses the clock token in a follow-on', () => {
      refuses(
        'mutation-verdict:construction:tree-clock-ban-token-in-followon',
        /reads the clock/,
        () => followOn(taskFollowOn().set({ first_started_at_ms: nowValue })),
      )
    })

    it('refuses a clock called as a function node', () => {
      refuses('mutation-verdict:construction:tree-clock-function-node', /reads the clock/, () =>
        followOn(
          taskFollowOn().set((eb) => ({ first_started_at_ms: eb.fn<number>('unixepoch', []) })),
        ),
      )
    })

    it('refuses a clock spelled in a fragment', () => {
      refuses(
        'mutation-verdict:construction:tree-clock-spelling-in-fragment',
        /reads the clock/,
        () =>
          followOn(
            taskFollowOn().set({ first_started_at_ms: value<number>(`unixepoch('subsec')*1000`) }),
          ),
      )
    })

    it('refuses a second clock in a compare-and-set', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-second-clock',
        /spells out a database clock/,
        () => cas('win', winCas().where(predicate('lease_ms < unixepoch()'))),
      )
    })

    it('refuses the text of the batch clock in a follow-on fragment', () => {
      // A clock no spelling list names, so only the comparison with the batch's own text sees it.
      const clock = '(SELECT 7)'
      const started = (text: string) =>
        batchWithClock(clock)
          .casTree('win', statement(winCas()))
          .followOnTree(
            'task',
            statement(taskFollowOn().set({ first_started_at_ms: value<number>(text) })),
            'one',
          )
      expect(() => started('(SELECT 8)')).not.toThrow()
      refuses('mutation-verdict:construction:tree-clock-text-in-followon', /reads the clock/, () =>
        started(clock),
      )
    })

    it('says a follow-on that spells a clock reads the clock', () => {
      refusesAs(
        'mutation-verdict:construction:tree-followon-spelled-clock-message',
        /reads the clock/,
        /spells out a database clock/,
        () =>
          followOn(
            taskFollowOn().set({ first_started_at_ms: value<number>(`unixepoch('subsec')*1000`) }),
          ),
      )
    })
  })

  describe('the statement, its fragments, and its binds', () => {
    it('refuses a statement defineStatement did not mint', () => {
      refuses(
        'mutation-verdict:construction:tree-statement-defined',
        /must come from defineStatement/,
        () => batch().casTree('win', { name: 'forged', tree: winCas().toOperationNode() }),
      )
    })

    it('refuses a shape outside the statement grammar', () => {
      refuses(
        'mutation-verdict:construction:tree-statement-grammar',
        /outside the statement grammar/,
        () => cas('win', winCas().returningAll()),
      )
    })

    it('reads the problems of its raw fragments', () => {
      refuses(
        'mutation-verdict:construction:tree-raw-fragment-problems-read',
        /a raw fragment that rawSql did not mint/,
        () => followOn(unmintedPredicate()),
      )
    })

    it('refuses one fragment node placed twice', () => {
      const once = predicate('1 = 1')
      refuses('mutation-verdict:construction:tree-raw-fragment-placed-once', /placed twice/, () =>
        followOn(taskFollowOn().where(once).where(once)),
      )
    })

    it('refuses a fragment standing outside its declared role', () => {
      refuses(
        'mutation-verdict:construction:tree-raw-fragment-role',
        /a 'value' fragment standing as a predicate/,
        () =>
          followOn(
            taskFollowOn().where(rawSql<boolean>(sqlFragment(`task_name = 'job'`), 'value')),
          ),
      )
    })

    it('compiles a value fragment inside parentheses', async () => {
      const scaled = winCas().set((eb) => ({
        attempt: eb(value<number>('attempt + ?', [1]), '*', 2),
      }))
      const { captured, executor } = capturingExecutor(1)
      await cas('win', scaled).run(executor)
      expect(
        captured[0]?.sql,
        'mutation-verdict:construction:tree-value-fragment-parens',
      ).toContain('(attempt + ?) * ?')
    })

    const unboundPlaceholder = () => followOn(taskFollowOn().where('headers', '?', 'key'))
    const booleanBind = () => followOn(taskFollowOn().where('task_name', '=', true as never))
    const thrownBy = (action: () => unknown): unknown => {
      try {
        action()
      } catch (error) {
        return error
      }
      return undefined
    }

    it('refuses a placeholder no argument binds', () => {
      refuses(
        'mutation-verdict:construction:tree-bind-placeholder-count',
        /placeholders/,
        unboundPlaceholder,
      )
    })

    it('reports an unbound placeholder as a compiler bind error', () => {
      expect(
        isFencedBatchBindError(thrownBy(unboundPlaceholder)),
        'mutation-verdict:construction:tree-bind-placeholder-count-brand',
      ).toBe(true)
    })

    it('refuses an argument the driver cannot bind', () => {
      refuses(
        'mutation-verdict:construction:tree-bind-argument-type',
        /argument \d+ is boolean/,
        booleanBind,
      )
    })

    it('reports an unbindable argument as a compiler bind error', () => {
      expect(
        isFencedBatchBindError(thrownBy(booleanBind)),
        'mutation-verdict:construction:tree-bind-argument-type-brand',
      ).toBe(true)
    })

    it('says an unminted raw node was never minted', () => {
      refusesAs(
        'mutation-verdict:construction:tree-raw-fragment-unminted-message',
        /a raw fragment that rawSql did not mint/,
        /fragment standing as a/,
        () => followOn(unmintedPredicate()),
      )
    })

    it('says a batch without a tree dialect has none', () => {
      refusesAs(
        'mutation-verdict:construction:tree-needs-a-dialect',
        /the batch has no tree dialect/,
        /Cannot read properties of null/,
        () => new FencedBatch('b', 'seed', { now: CLOCK }).casTree('win', statement(winCas())),
      )
    })

    it('refuses a many-row bound that is not a whole number', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-many-max-is-an-integer',
        /max must be a positive integer/,
        () => batch().casManyTree('win', statement(winCas()), 1.5),
      )
    })

    it('refuses a many-row bound below one', () => {
      refuses(
        'mutation-verdict:construction:tree-cas-many-max-is-positive',
        /max must be a positive integer/,
        () => batch().casManyTree('win', statement(winCas()), 0),
      )
    })

    it('refuses a statement name outside the stamp grammar', () => {
      refuses('mutation-verdict:construction:tree-statement-name-grammar', /name must match/, () =>
        cas('not a name', winCas()),
      )
    })

    it('refuses a second statement of the same name', () => {
      refuses(
        'mutation-verdict:construction:tree-statement-name-unique',
        /duplicate statement name 'win'/,
        () => withCas().followOnTree('win', statement(taskFollowOn()), 'one'),
      )
    })

    it('refuses a statement that is not a compare-and-set after a lock', () => {
      refuses(
        'mutation-verdict:construction:tree-lock-precedes-a-cas',
        /followed immediately by a CAS/,
        () =>
          batch()
            .lockEvent({ queue: 'q', eventName: 'e' })
            .openTailTree(
              'read',
              'a reason',
              statement(db.selectFrom('events').select('payload').where('queue', '=', 'q')),
            ),
      )
    })
  })
})
