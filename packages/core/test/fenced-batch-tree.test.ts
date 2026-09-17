import {
  type ExpressionBuilder,
  type OperationNode,
  SelectModifierNode,
  SelectQueryNode,
  SqliteQueryCompiler,
  sql,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  FENCE_SET,
  FencedBatch,
  type SqlExecutor,
  type SqlFragment,
  type SqlResult,
  type SqlStatement,
  type StoreTables,
  TreeDialect,
  aliasedAs,
  capLostLaunchCas,
  coalesced,
  compileOnlyBuilder,
  treeBuilder as db,
  defineStatement,
  emitEventCas,
  failClaimTimeoutCas,
  fenceValue,
  nowValue,
  rawSql,
  registerWaitCas,
  reopenLostLaunchCas,
  spawnTaskCas,
  sqlFragment,
  stampValue,
  suspendCas,
} from '../src/index.js'

/**
 * Each tree check paired: a shape it must refuse, and the nearest legitimate shape it
 * must still allow, as `fenced-batch.test.ts` does for text statements.
 */
const CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`
const dialect = new TreeDialect(new SqliteQueryCompiler())

type Builder = { toOperationNode(): OperationNode }

/** A statement minted the way stores mint them, with no binds of its own. */
const statement = (builder: Builder) => defineStatement('test', () => builder as never)({})
const predicate = (text: string, args: SqlFragment['args'] = []) =>
  rawSql<boolean>(sqlFragment(text, args), 'predicate')
const value = <T>(text: string, args: SqlFragment['args'] = []) =>
  rawSql<T>(sqlFragment(text, args), 'value')

function batch(): FencedBatch {
  return new FencedBatch('b', 'seed', { now: CLOCK, tree: dialect })
}

/** An executor that records what it was sent and reports `rowsAffected` for each statement. */
function capturingExecutor(rowsAffected: number) {
  const captured: SqlStatement[] = []
  const executor: SqlExecutor = {
    async batch(_label, statements) {
      captured.push(...statements)
      return statements.map(() => ({ rows: [], rowsAffected }) as SqlResult)
    },
  }
  return { captured, executor }
}

const winCas = () =>
  db
    .updateTable('runs')
    .set({
      state: 'completed',
      completed_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    })
    .where('run_id', '=', 'r1')
    .where('state', '=', 'running')

function withCas(b: FencedBatch = batch()): FencedBatch {
  return b.casTree('win', statement(winCas()))
}

/** Tasks owned by the run this batch's compare-and-set stamped. */
const taskFollowOn = () =>
  db
    .updateTable('tasks')
    .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
    .where((eb) =>
      eb(
        'task_id',
        'in',
        eb
          .selectFrom('runs as f')
          .select('f.task_id')
          .where('f.run_id', '=', 'r1')
          .where('f.fence_stamp', '=', fenceValue('win')),
      ),
    )

const followOn = (builder: Builder) => withCas().followOnTree('task', statement(builder), 'one')

describe('FencedBatch tree statements', () => {
  it('compiles a compare-and-set and a gated follow-on with every token bound', async () => {
    const { captured, executor } = capturingExecutor(1)
    const result = await followOn(taskFollowOn()).run(executor)
    expect(result.won).toBe('win')
    expect(captured).toEqual([
      {
        sql: `update "runs" set "state" = ?, "completed_at_ms" = ${CLOCK}, "fence_stamp" = ?, "fence_at_ms" = ${CLOCK} where "run_id" = ? and "state" = ?`,
        args: ['completed', 'seed:win', 'r1', 'running'],
      },
      {
        sql: 'update "tasks" set "state" = ?, "fence_stamp" = ?, "fence_at_ms" = ? where "task_id" in (select "f"."task_id" from "runs" as "f" where "f"."run_id" = ? and "f"."fence_stamp" = ?)',
        args: ['completed', 'seed:task', 5, 'r1', 'seed:win'],
      },
    ])
  })

  it('refuses a statement that defineStatement did not mint, and an undefined bind', () => {
    const forged = { name: 'forged', tree: winCas().toOperationNode() }
    expect(() => batch().casTree('win', forged)).toThrow(/must come from defineStatement/)
    const keyed = defineStatement('keyed', (binds: { runId: string }) =>
      db.updateTable('runs').set({ state: 'completed' }).where('run_id', '=', binds.runId),
    )
    expect(() => keyed({ runId: undefined as never })).toThrow(/bind 'runId' is undefined/)
    const nested = defineStatement('nested', (binds: { wake: { at: number } }) =>
      db.updateTable('runs').set({ available_at_ms: binds.wake.at }).where('run_id', '=', 'r1'),
    )
    expect(() => nested({ wake: { at: undefined as never } })).toThrow(
      /bind 'wake'.at is undefined/,
    )
  })

  it('refuses a compare-and-set that does not stamp its table', () => {
    const unstamped = db
      .updateTable('runs')
      .set({ state: 'completed', fence_at_ms: nowValue })
      .where('run_id', '=', 'r1')
    expect(() => batch().casTree('win', statement(unstamped))).toThrow(
      /must assign fence_stamp the stamp and fence_at_ms the clock/,
    )
  })

  it('refuses a second assignment to a provenance column', () => {
    const forged = winCas().set('fence_stamp', 'forged')
    expect(() => batch().casTree('win', statement(forged))).toThrow(
      /must assign fence_stamp the stamp/,
    )
  })

  it('refuses a follow-on that updates a fenced table without stamping it', () => {
    const plain = db
      .updateTable('tasks')
      .set({ state: 'completed' })
      .where((eb) =>
        eb(
          'task_id',
          'in',
          eb
            .selectFrom('runs as f')
            .select('f.task_id')
            .where('f.fence_stamp', '=', fenceValue('win')),
        ),
      )
    expect(() => followOn(plain)).toThrow(/does not stamp it/)
  })

  it('refuses a follow-on whose fence is joined by OR, and allows one that gates', () => {
    const ored = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where((eb) => eb.or([eb('task_id', '=', 't1'), eb('fence_stamp', '=', fenceValue('win'))]))
    expect(() => followOn(ored)).toThrow(/no fence gating every row/)
    expect(() => followOn(taskFollowOn())).not.toThrow()
  })

  it('refuses a fence compared on a table its statement did not stamp', () => {
    const inert = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where('task_id', '=', 't1')
      .where('fence_stamp', '=', fenceValue('win'))
    expect(() => followOn(inert)).toThrow(/stamps 'runs'/)
  })

  it('refuses a fence naming no statement of the batch', () => {
    const stray = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where('fence_stamp', '=', fenceValue('missing'))
    expect(() => followOn(stray)).toThrow(/names no statement/)
  })

  it('refuses a follow-on that reads the clock, however the clock is spelled', () => {
    const spellings = [
      taskFollowOn().set({ first_started_at_ms: nowValue }),
      taskFollowOn().set({ first_started_at_ms: value<number>(CLOCK) }),
      taskFollowOn().set({ first_started_at_ms: value<number>(`unixepoch('subsec')*1000`) }),
      taskFollowOn().set((eb) => ({ first_started_at_ms: eb.fn<number>('unixepoch', []) })),
      taskFollowOn().set({ first_started_at_ms: value<number>('$NOW$ + ?', [5]) }),
    ]
    for (const spelling of spellings) expect(() => followOn(spelling)).toThrow(/reads the clock/)
  })

  it('lets a compare-and-set carry the batch clock in a fragment, and no other clock', () => {
    const batchClock = winCas().where(predicate(`lease_ms < ${CLOCK}`))
    const otherClock = winCas().where(predicate('lease_ms < unixepoch()'))
    expect(() => batch().casTree('win', statement(batchClock))).not.toThrow()
    expect(() => batch().casTree('win', statement(otherClock))).toThrow(
      /spells out a database clock/,
    )
  })

  it('refuses a counting assignment in a follow-on, however it is written', () => {
    const arithmetic = [
      taskFollowOn().set((eb) => ({ attempts: eb('attempts', '+', 1) })),
      taskFollowOn().set('attempts', (eb) => eb('attempts', '+', 1)),
    ]
    for (const counting of arithmetic) {
      expect(() => followOn(counting)).toThrow(/bumps a counter blindly/)
    }
    const hidden = taskFollowOn().set({ attempts: value<number>('attempts + 1') })
    expect(() => followOn(hidden)).toThrow(/raw fragment that mentions 'attempts'/)
  })

  it('refuses a raw fragment rawSql did not mint, or one standing outside its declared role', () => {
    const unminted = taskFollowOn().where(sql.raw<boolean>(`task_name = 'job'`))
    const unmintedBind = taskFollowOn().where(sql.raw<boolean>('task_name = ?'))
    const valueAsPredicate = taskFollowOn().where(
      rawSql<boolean>(sqlFragment(`task_name = 'job'`), 'value'),
    )
    const predicateAsValue = taskFollowOn().set({
      last_attempt_run: rawSql<string>(sqlFragment(`'r1'`), 'predicate'),
    })
    const predicateAsSubquery = taskFollowOn().where((eb) =>
      eb('task_name', 'in', rawSql<string>(sqlFragment(`(SELECT 'job')`), 'predicate')),
    )
    expect(() => followOn(unminted)).toThrow(/a raw fragment that rawSql did not mint/)
    expect(() => followOn(unmintedBind)).toThrow(/a raw fragment that rawSql did not mint/)
    expect(() => followOn(valueAsPredicate)).toThrow(/a 'value' fragment standing as a predicate/)
    expect(() => followOn(predicateAsValue)).toThrow(/a 'predicate' fragment standing as a value/)
    expect(() => followOn(predicateAsSubquery)).toThrow(
      /a 'predicate' fragment standing as a subquery/,
    )

    const placed = taskFollowOn()
      .set({ last_attempt_run: value<string>(`'r1'`) })
      .where(predicate(`task_name = 'job'`))
      .where((eb) =>
        eb('task_name', 'in', rawSql<string>(sqlFragment(`(SELECT 'job')`), 'subquery')),
      )
    expect(() => followOn(placed)).not.toThrow()
    expect(() => rawSql(sqlFragment(`SELECT 'job'`), 'subquery')).toThrow(/one parenthesized group/)
    expect(() => rawSql(sqlFragment(`(SELECT 'a') UNION (SELECT ')')`), 'subquery')).toThrow(
      /one parenthesized group/,
    )
    expect(() => rawSql(sqlFragment(`((SELECT ')') UNION (SELECT 'b'))`), 'subquery')).not.toThrow()
  })

  it('parenthesizes a fragment, so an OR inside it cannot void the conjuncts before it', async () => {
    const ored = winCas().where(predicate('lease_ms < ? OR lease_ms IS NULL', [5]))
    const { captured, executor } = capturingExecutor(1)
    await batch().casTree('win', statement(ored)).run(executor)
    expect(captured[0]?.sql).toContain('and (lease_ms < ? OR lease_ms IS NULL)')
  })

  it('refuses a fragment whose string literal holds a bind or the clock token', () => {
    expect(() => predicate("failure_reason <> 'at $NOW$'")).toThrow(/string literal/)
    expect(() => predicate("task_name = 'why?'")).toThrow(/string literal/)
    expect(() => predicate("task_name = 'it''s' AND queue = ?", ['q'])).not.toThrow()
  })

  it('does not count the raw nodes the builder makes for itself', () => {
    const ordered = db
      .selectFrom('runs')
      .select('run_id')
      .where('fence_stamp', '=', fenceValue('win'))
      .orderBy('run_id', 'desc')
    expect(() => withCas().tailTree('payload', statement(ordered))).not.toThrow()
  })

  it('turns the binds and clock of a fragment into nodes, and compiles a many-row compare-and-set', async () => {
    const claimMany = winCas().where(predicate('lease_ms < $NOW$ + ? AND queue = ?', [250, 'q']))
    const { captured, executor } = capturingExecutor(2)
    const result = await batch().casManyTree('win', statement(claimMany), 3).run(executor)
    expect(result).toMatchObject({ won: 'win', count: 2 })
    expect(captured).toEqual([
      {
        sql: `update "runs" set "state" = ?, "completed_at_ms" = ${CLOCK}, "fence_stamp" = ?, "fence_at_ms" = ${CLOCK} where "run_id" = ? and "state" = ? and (lease_ms < ${CLOCK} + ? AND queue = ?)`,
        args: ['completed', 'seed:win', 'r1', 'running', 250, 'q'],
      },
    ])
  })

  it('holds a many-row compare-and-set to its row bound', async () => {
    const overBound = batch().casManyTree('win', statement(winCas()), 1)
    await expect(overBound.run(capturingExecutor(2).executor)).rejects.toThrow(
      /affected 2 rows, at most 1 allowed/,
    )
    expect(() => batch().casManyTree('win', statement(winCas()), 0)).toThrow(
      /max must be a positive/,
    )
  })

  it('refuses a fragment that holds the stamp token, or binds the wrong count', () => {
    expect(() => predicate('fence_stamp = $STAMP$')).toThrow(/may not hold the stamp token/)
    expect(() => predicate('queue = ?', ['q', 'extra'])).toThrow(/binds 1 of its 2/)
  })

  it('carries a fence token in a fragment as a node that is bound and gates nothing', async () => {
    // Bound, in order with the binds around it.
    const correlated = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where('task_id', 'in', (eb) =>
        eb
          .selectFrom('runs')
          .select('runs.task_id')
          .where('runs.fence_stamp', '=', fenceValue('win')),
      )
      .where(
        predicate(
          'queue = ? AND EXISTS (SELECT 1 FROM runs r WHERE r.fence_stamp = $FENCE:win$ AND r.run_id = ?)',
          ['q', 'r1'],
        ),
      )
    const { captured, executor } = capturingExecutor(1)
    await batch()
      .casTree('win', statement(winCas()))
      .followOnTree('t', statement(correlated), 'one')
      .run(executor)
    expect(captured[1]?.args.slice(-3)).toEqual(['q', 'seed:win', 'r1'])
    // It must name a fence of the batch, like a fence built from nodes.
    const stranger = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where('task_id', 'in', (eb) =>
        eb
          .selectFrom('runs')
          .select('runs.task_id')
          .where('runs.fence_stamp', '=', fenceValue('win')),
      )
      .where(predicate('EXISTS (SELECT 1 FROM runs r WHERE r.fence_stamp = $FENCE:nobody$)'))
    expect(() => followOn(stranger)).toThrow(/nobody/)
    // It gates nothing: the gating rule reads a comparison built from nodes.
    const ungated = db
      .updateTable('runs')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where(predicate('fence_stamp = $FENCE:win$'))
    expect(() => followOn(ungated)).toThrow(/has no fence gating/)
    // A token the splitter cannot see as one is refused.
    expect(() => predicate(`reason <> 'at $FENCE:win$'`)).toThrow(/inside a string literal/)
    expect(() => predicate('fence_stamp = $FENCE:not a name$')).toThrow(/malformed fence token/)
  })

  describe('generated follow-ons are trees', () => {
    const generated = () =>
      batch().cas('win', 'runs', `UPDATE runs SET state = 'x', ${FENCE_SET} WHERE run_id = ?`, [
        'r',
      ])
    const mirror = (set: Record<string, unknown>, setArgs: SqlStatement['args'] = []) =>
      generated().derived('mirror', {
        relation: 'runs-to-tasks',
        fence: 'win',
        where: 'f.run_id = ?',
        whereArgs: ['r'],
        set: set as never,
        setArgs,
        rows: 'one',
      })

    it('gives each text value the arguments it binds, and refuses a count that does not add up', () => {
      expect(() => mirror({ state: `'failed'`, failure_reason: '?' }, ['why'])).not.toThrow()
      // A missing argument is refused where the value is minted, and a stray one here.
      expect(() => mirror({ state: `'failed'`, failure_reason: '?' }, [])).toThrow(
        /a SQL fragment binds 1 of its 0 arguments/,
      )
      expect(() => mirror({ state: `'failed'` }, ['stray'])).toThrow(
        /set binds 0 of its 1 arguments/,
      )
    })

    it('refuses an UPDATE with nothing to assign, and a value that is neither text nor an expression', () => {
      expect(() => mirror({})).toThrow(/UPDATE set cannot be empty/)
      expect(() => mirror({ state: 5 })).toThrow(/neither SQL text nor an expression/)
      expect(() => mirror({ state: { sql: `'failed'` } })).toThrow(
        /neither SQL text nor an expression/,
      )
    })

    it('holds a generated statement to the follow-on rules a hand-built tree meets', () => {
      // The clock, as the token and as a spelling.
      expect(() => mirror({ first_started_at_ms: '$NOW$' })).toThrow(/reads the clock/)
      expect(() => mirror({ first_started_at_ms: `unixepoch('subsec')` })).toThrow(
        /reads the clock/,
      )
      // A value that reads the column it is assigned to counts twice on a replay, and a
      // fragment hides what is done with it.
      expect(() => mirror({ attempts: 'attempts + 1' })).toThrow(
        /assigns 'attempts' from a raw fragment that mentions 'attempts'/,
      )
      expect(() => mirror({ first_started_at_ms: 'COALESCE(first_started_at_ms, 5)' })).toThrow(
        /raw fragment that mentions 'first_started_at_ms'/,
      )
      // The same read built from nodes is visible, and allowed.
      expect(() =>
        mirror({
          first_started_at_ms: coalesced('first_started_at_ms', value<number>('?', [5])),
        }),
      ).not.toThrow()
      // A fence inside a value must name a fence of this batch.
      expect(() =>
        mirror({
          state: '(SELECT f.state FROM runs f WHERE f.fence_stamp = $FENCE:nobody$)',
        }),
      ).toThrow(/nobody/)
      expect(() =>
        mirror({ state: '(SELECT f.state FROM runs f WHERE f.fence_stamp = $FENCE:win$)' }),
      ).not.toThrow()
    })

    it('refuses a self-count in a fragment under any qualifier', () => {
      // The text path refused `x = t.x + 1` by name. A qualified read of the assigned
      // column beside an arithmetic operator counts twice on a replay, whatever the
      // qualifier, and whatever wraps the fragment.
      for (const counting of ['tasks.attempts + 1', '1 + tasks.attempts', '(tasks.attempts + 1)']) {
        expect(() => mirror({ attempts: counting }), counting).toThrow(/'attempts'/)
      }
      expect(() =>
        mirror({ attempts: coalesced('attempts', value<number>('tasks.attempts + 1')) }),
      ).toThrow(/'attempts'/)
      // A qualified read of another row with no arithmetic is a copy, and stays allowed.
      expect(() =>
        mirror({ state: '(SELECT f.state FROM runs f WHERE f.fence_stamp = $FENCE:win$)' }),
      ).not.toThrow()
    })

    it('refuses any read of the assigned row in a fragment, and arithmetic on another row', () => {
      // A mention qualified by the table being written IS the assigned row, whatever the
      // text does with it: a function call between the operator and the name hid it.
      for (const counting of ['1 + COALESCE(tasks.attempts, 0)', 'abs(tasks.attempts)']) {
        expect(() => mirror({ attempts: counting }), counting).toThrow(/'attempts'/)
      }
      // Another row's column beside arithmetic, which the text path refused by name.
      for (const counting of ['f.attempts + 1', '1 + f.attempts']) {
        expect(() => mirror({ attempts: counting }), counting).toThrow(/'attempts'/)
      }
      // Another row's column with no arithmetic is a copy.
      expect(() =>
        mirror({ attempts: '(SELECT f.attempts FROM runs f WHERE f.fence_stamp = $FENCE:win$)' }),
      ).not.toThrow()
    })

    it('reads no gate through an ungrouped HAVING', () => {
      // HAVING with no GROUP BY makes the subquery one group, which returns a row even
      // when its WHERE matched nothing, so EXISTS over it is always true.
      const gatedBy = (having: boolean) =>
        db
          .updateTable('tasks')
          .set({ state: 'failed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where((eb) => {
            const inner = eb
              .selectFrom('runs as f')
              .select('f.run_id')
              .where('f.fence_stamp', '=', fenceValue('win'))
              .whereRef('f.task_id', '=', 'tasks.task_id')
            return eb.exists(having ? inner.having((h) => h.fn.countAll<number>(), '>=', 0) : inner)
          })
      expect(() => followOn(gatedBy(false))).not.toThrow()
      expect(() => followOn(gatedBy(true))).toThrow(/fence/)
    })

    it('refuses arguments whose text is missing or empty', () => {
      // A computed correlation that comes out empty must not widen the write to every
      // row under the fence, with its arguments dropped on the floor.
      const derivedWith = (selection: Record<string, unknown>) =>
        generated().derived('mirror', {
          relation: 'runs-to-tasks',
          fence: 'win',
          set: { state: `'failed'` },
          rows: 'one',
          ...selection,
        } as never)
      expect(() => derivedWith({ whereArgs: ['r'] })).toThrow(/whereArgs/)
      expect(() => derivedWith({ where: '', whereArgs: ['r'] })).toThrow(/where/)
      expect(() => derivedWith({ where: '' })).toThrow(/where/)
      expect(() =>
        derivedWith({ where: 'f.run_id = ?', whereArgs: ['r'], narrowArgs: ['x'] }),
      ).toThrow(/narrowArgs/)
      expect(() =>
        derivedWith({ where: 'f.run_id = ?', whereArgs: ['r'], narrow: '', narrowArgs: [] }),
      ).toThrow(/narrow/)
      expect(() => derivedWith({ where: 'f.run_id = ?', whereArgs: ['r'] })).not.toThrow()
    })

    it('reads no gate through a subquery that returns a row whether or not one matched', () => {
      // An aggregate with no GROUP BY returns one row always, so EXISTS over it is always
      // true. The builder has more than one way to spell an aggregate, and a fragment
      // hides one, so a gating subquery selects plain columns and values only.
      const gatedBy = (selection: (eb: ExpressionBuilder<StoreTables, 'runs'>) => unknown) =>
        db
          .updateTable('tasks')
          .set({ state: 'failed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('runs as f')
                .select((inner) => selection(inner as never) as never)
                .where('f.fence_stamp', '=', fenceValue('win'))
                .whereRef('f.task_id', '=', 'tasks.task_id'),
            ),
          )
      expect(() =>
        followOn(gatedBy((eb) => eb.ref('f.run_id' as never).as('run_id'))),
      ).not.toThrow()
      expect(() =>
        followOn(gatedBy((eb) => eb.fn('count', [eb.ref('f.run_id' as never)]).as('n'))),
      ).toThrow(/fence/)
      expect(() => followOn(gatedBy(() => aliasedAs(value<number>('COUNT(*)'), 'n')))).toThrow(
        /fence/,
      )
      // The same through a derived table: one row always, so IN over it gates nothing.
      const keysFrom = (grouped: boolean) => {
        const inner = db
          .selectFrom('runs as f')
          .select((eb) => eb.fn.count<number>('f.run_id').as('source_key'))
          .where('f.fence_stamp', '=', fenceValue('win'))
        return db
          .selectFrom((grouped ? inner.groupBy('f.task_id') : inner).as('fenced_source'))
          .select('source_key')
      }
      const sealedBy = (keys: Builder) =>
        db
          .updateTable('runs')
          .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where('run_id', 'in', keys as never)
      expect(() => followOn(sealedBy(keysFrom(false)))).toThrow(/fence/)
      // Grouped, the derived table returns no row when nothing matched, but a count is
      // not a stored column of the fenced row, so it cannot be the key IN selects.
      expect(() => followOn(sealedBy(keysFrom(true)))).toThrow(/not tied to the rows/)
      // A grouped aggregate still gates where no key is asked of it: under EXISTS.
      const countedBy = (grouped: boolean) =>
        db
          .updateTable('tasks')
          .set({ state: 'failed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where((eb) => {
            const inner = eb
              .selectFrom('runs as f')
              .select((counted) => counted.fn.count<number>('f.run_id').as('n'))
              .where('f.fence_stamp', '=', fenceValue('win'))
              .whereRef('f.task_id', '=', 'tasks.task_id')
            return eb.exists(grouped ? inner.groupBy('f.task_id') : inner)
          })
      expect(() => followOn(countedBy(true))).not.toThrow()
      expect(() => followOn(countedBy(false))).toThrow(/fence/)
    })

    it('still lets a tail count the rows this batch stamped', () => {
      // The aggregate rule is about a row REQUIRED from a subquery. A tail whose own
      // WHERE is the fence counts stamped rows, and a losing batch reads zero.
      const counted = db
        .selectFrom('runs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('fence_stamp', '=', fenceValue('win'))
      expect(() => generated().tailTree('count', statement(counted))).not.toThrow()
    })

    it('refuses a fence token with anything left over', () => {
      expect(() => predicate('x = $FENCE:a$FENCE:b$')).toThrow(/malformed fence token|stray/)
      expect(() => predicate('x = $FENCE:win$$')).toThrow(/malformed fence token|stray/)
      expect(() => predicate('x = $FENCE:win$')).not.toThrow()
    })

    it('refuses a set value that only looks like an expression', () => {
      // An object with a toOperationNode and nothing else is not the builder's expression,
      // and was bound as data.
      expect(() =>
        mirror({ state: { toOperationNode: () => ({ kind: 'ValueNode', value: 'x' }) } }),
      ).toThrow(/neither SQL text nor an expression/)
    })

    it('gates through one derived table, and through nothing that could add a row', () => {
      const gatedKeys = () =>
        db
          .selectFrom('runs as f')
          .select('f.run_id as source_key')
          .distinct()
          .where('f.fence_stamp', '=', fenceValue('win'))
          .as('fenced_source')
      const sealed = (keys: Builder) =>
        db
          .updateTable('runs')
          .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
          .where('run_id', 'in', keys as never)
      expect(() => followOn(sealed(db.selectFrom(gatedKeys()).select('source_key')))).not.toThrow()
      // A join or a second source can add rows the fence never saw.
      expect(() =>
        followOn(
          sealed(
            db
              .selectFrom(gatedKeys())
              .innerJoin('runs as other', (join) => join.onRef('other.queue', '=', 'other.queue'))
              .select('other.run_id'),
          ),
        ),
      ).toThrow(/has no fence gating/)
      expect(() =>
        followOn(
          sealed(
            db.selectFrom([gatedKeys(), 'runs as other'] as never).select('other.run_id' as never),
          ),
        ),
      ).toThrow(/has no fence gating/)
      // An aggregate with no GROUP BY returns a row whether or not the fence matched.
      const counted = db
        .updateTable('runs')
        .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('runs as f')
              .select((inner) => inner.fn.countAll().as('n'))
              .where('f.fence_stamp', '=', fenceValue('win')),
          ),
        )
      expect(() => followOn(counted)).toThrow(/has no fence gating/)
    })

    it('admits DISTINCT and no other SELECT modifier', () => {
      const tail = (select: Builder) => withCas().tailTree('read', statement(select))
      const fenced = () =>
        db.selectFrom('runs').select('run_id').where('fence_stamp', '=', fenceValue('win'))
      expect(() => tail(fenced().distinct())).not.toThrow()
      expect(() => tail(fenced().forUpdate())).toThrow(/outside the statement grammar/)
      const node = fenced().toOperationNode()
      const forged = {
        toOperationNode: () =>
          SelectQueryNode.cloneWithFrontModifier(node, SelectModifierNode.create('SkipLocked')),
      }
      expect(() => tail(forged)).toThrow(/a SELECT modifier other than DISTINCT/)
    })
  })

  it('refuses shapes outside the statement grammar', () => {
    const tailOverWrite = db
      .with('gone', (q) => q.deleteFrom('runs').returningAll())
      .selectFrom('runs')
      .select('run_id')
      .where('fence_stamp', '=', fenceValue('win'))
    const updateFrom = db
      .updateTable('tasks')
      .from('runs')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
      .where('runs.fence_stamp', '=', fenceValue('win'))
    const otherSchema = db
      .withSchema('other')
      .updateTable('runs')
      .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: nowValue })
      .where('run_id', '=', 'r1')
    const returning = winCas().returningAll()
    expect(() => withCas().tailTree('payload', statement(tailOverWrite))).toThrow(
      /outside the statement grammar: it holds SelectQueryNode.with/,
    )
    expect(() => followOn(updateFrom)).toThrow(
      /outside the statement grammar: it holds UpdateQueryNode.from/,
    )
    expect(() => batch().casTree('win', statement(otherSchema))).toThrow(/a schema-qualified table/)
    expect(() => batch().casTree('win', statement(returning))).toThrow(/UpdateQueryNode.returning/)
  })

  it('adds and compiles tree statements while task code has replaced the global Map', () => {
    const win = statement(winCas())
    const task = statement(taskFollowOn())
    const payload = statement(
      db.selectFrom('runs as r').select('r.run_id').where('r.fence_stamp', '=', fenceValue('win')),
    )
    class PoisonedMap {
      constructor() {
        throw new Error('task-installed Map constructor ran')
      }
    }
    const original = globalThis.Map
    let thrown: unknown
    try {
      ;(globalThis as { Map: unknown }).Map = PoisonedMap
      batch().casTree('win', win).followOnTree('task', task, 'one').tailTree('payload', payload)
    } catch (error) {
      thrown = error
    } finally {
      ;(globalThis as { Map: unknown }).Map = original
    }
    expect(thrown).toBeUndefined()
  })

  it('places a raw subquery under NOT IN as a subquery, with one pair of parentheses', async () => {
    const excluded = winCas().where((eb) =>
      eb('run_id', 'not in', rawSql<string>(sqlFragment(`(SELECT 'r2')`), 'subquery')),
    )
    const { captured, executor } = capturingExecutor(1)
    await batch().casTree('win', statement(excluded)).run(executor)
    expect(captured[0]?.sql).toContain(`"run_id" not in (SELECT 'r2')`)
  })

  it('places a predicate in any boolean clause, and refuses a value standing there', () => {
    const grouped = (having: ReturnType<typeof predicate>) =>
      db
        .selectFrom('runs')
        .select('task_id')
        .where('fence_stamp', '=', fenceValue('win'))
        .groupBy('task_id')
        .having(having)
    expect(() =>
      withCas().tailTree('payload', statement(grouped(predicate('COUNT(*) = 1')))),
    ).not.toThrow()
    expect(() =>
      withCas().tailTree(
        'payload',
        statement(grouped(rawSql<boolean>(sqlFragment('COUNT(*) = 1'), 'value'))),
      ),
    ).toThrow(/a 'value' fragment standing as a predicate/)
  })

  it('refuses an operator that compiles to a placeholder no argument binds', () => {
    const jsonKey = taskFollowOn().where('headers', '?', 'key')
    expect(() => followOn(jsonKey)).toThrow(/placeholders/)
  })

  it('refuses a fragment with a comment or a string form its scanner cannot read', () => {
    expect(() => predicate("/* don't */ x = 'at $NOW$' /* ' */")).toThrow(/comment/)
    expect(() => predicate('x = 1 -- trailing')).toThrow(/comment/)
    expect(() => rawSql(sqlFragment('(SELECT 1 /* ( */) OR (1=1 /* ) */)'), 'subquery')).toThrow(
      /comment/,
    )
    expect(() => predicate('x = $q$ $NOW$ $q$')).toThrow(/plain single-quoted/)
    expect(() => predicate("x = E'it\\'s $NOW$ here'")).toThrow(/plain single-quoted/)
    expect(() => predicate("json_extract(x, '$.kind') = 'fixed' AND y < $NOW$")).not.toThrow()
  })

  it('refuses one fragment node placed twice', () => {
    const once = predicate('1 = 1')
    const reused = taskFollowOn()
      .set({ last_attempt_run: once as never })
      .where(once)
    expect(() => followOn(reused)).toThrow(/placed twice/)
  })

  it('refuses a fragment bind the statement never places', () => {
    const unplaced = defineStatement('unplaced', (_binds: { admission: SqlFragment }) =>
      db.updateTable('runs').set({ state: 'completed' }).where('run_id', '=', 'r1'),
    )
    expect(() => unplaced({ admission: sqlFragment('1 = 1') })).toThrow(/never places/)

    // Placement is per statement build. A fragment another statement placed, or one
    // object passed as two binds with one placed, is still unplaced here.
    const placing = defineStatement('placing', (binds: { admission: SqlFragment }) =>
      db
        .updateTable('runs')
        .set({ state: 'completed' })
        .where(rawSql<boolean>(binds.admission, 'predicate')),
    )
    const shared = sqlFragment('1 = 1')
    placing({ admission: shared })
    expect(() => unplaced({ admission: shared })).toThrow(/bind 'admission' is a fragment/)
    const half = defineStatement('half', (binds: { first: SqlFragment; second: SqlFragment }) =>
      db
        .updateTable('runs')
        .set({ state: 'completed' })
        .where(rawSql<boolean>(binds.first, 'predicate')),
    )
    expect(() => half({ first: shared, second: shared })).toThrow(/bind 'second' is a fragment/)
    const twice = defineStatement('twice', (binds: { wakeAt: SqlFragment }) =>
      db
        .updateTable('runs')
        .set({ available_at_ms: rawSql<number>(binds.wakeAt, 'value') })
        .where(rawSql<boolean>(binds.wakeAt, 'predicate')),
    )
    expect(() => twice({ wakeAt: sqlFragment('1') })).not.toThrow()
  })

  it('builds a generated follow-on while task code has replaced the global Set', () => {
    class PoisonedSet {
      constructor() {
        throw new Error('task-installed Set constructor ran')
      }
    }
    const original = globalThis.Set
    let thrown: unknown
    try {
      ;(globalThis as { Set: unknown }).Set = PoisonedSet
      batch()
        .cas('win', 'runs', `UPDATE runs SET state = 'x', ${FENCE_SET} WHERE run_id = ?`, ['r'])
        .derived('task', {
          relation: 'runs-to-tasks',
          fence: 'win',
          where: 'f.run_id = ?',
          whereArgs: ['r'],
          set: { state: `'completed'` },
          rows: 'one',
        })
    } catch (error) {
      thrown = error
    } finally {
      ;(globalThis as { Set: unknown }).Set = original
    }
    expect(thrown).toBeUndefined()
  })

  describe('placement under operations task code has replaced', () => {
    type Fn = (...args: unknown[]) => unknown
    const fragment = sqlFragment('1 = 1')
    const binds = { admission: fragment }
    const update = () => db.updateTable('runs').set({ state: 'completed' })
    const unplaced = defineStatement('unplaced', (_binds: { admission: SqlFragment }) =>
      update().where('run_id', '=', 'r1'),
    )
    const placing = defineStatement('placing', (taken: { admission: SqlFragment }) =>
      update().where(rawSql<boolean>(taken.admission, 'predicate')),
    )
    const half = defineStatement('half', (taken: { first: SqlFragment; second: SqlFragment }) =>
      update().where(rawSql<boolean>(taken.first, 'predicate')),
    )
    const nothing = {
      next: () => ({ done: true as const, value: undefined }),
      [Symbol.iterator]() {
        return this
      },
    }
    // Each replacement misbehaves only for this test's objects, so the builder and the
    // test runner keep working while it is installed.
    const hostile: [string, object, PropertyKey, (original: Fn) => unknown][] = [
      [
        'Array.prototype.indexOf finds the fragment anywhere',
        Array.prototype,
        'indexOf',
        (original) =>
          function (this: unknown[], ...args: unknown[]) {
            return args[0] === fragment ? 0 : Reflect.apply(original, this, args)
          },
      ],
      [
        'Array.prototype.splice removes nothing',
        Array.prototype,
        'splice',
        (original) =>
          function (this: unknown[], ...args: unknown[]) {
            return this[0] === fragment ? [] : Reflect.apply(original, this, args)
          },
      ],
      [
        'Array.prototype.push drops the fragment',
        Array.prototype,
        'push',
        (original) =>
          function (this: unknown[], ...args: unknown[]) {
            return args[0] === fragment ? this.length : Reflect.apply(original, this, args)
          },
      ],
      [
        'Object.entries hides the binds',
        Object,
        'entries',
        (original) => (value: unknown) => (value === binds ? [] : original(value)),
      ],
      [
        'Object.keys hides the binds',
        Object,
        'keys',
        (original) => (value: unknown) => (value === binds ? [] : original(value)),
      ],
      [
        'the array iterator yields nothing for the binds',
        Array.prototype,
        Symbol.iterator,
        (original) =>
          function (this: unknown[]) {
            const first = this[0]
            const ours = first === 'admission' || (Array.isArray(first) && first[0] === 'admission')
            return ours ? nothing : Reflect.apply(original, this, [])
          },
      ],
      [
        'Uint8Array claims the binds as bytes',
        Uint8Array,
        Symbol.hasInstance,
        (original) => (value: unknown) =>
          value === binds || Reflect.apply(original, Uint8Array, [value]),
      ],
    ]

    it.each(hostile)('%s', (_label, target, key, replacement) => {
      const attempt = (run: () => unknown): string => {
        try {
          run()
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      }
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      const outcomes = { unplaced: '', placed: '', half: '' }
      Object.defineProperty(target, key, {
        configurable: true,
        writable: true,
        value: replacement(Reflect.get(target, key) as Fn),
      })
      try {
        outcomes.unplaced = attempt(() => unplaced(binds))
        outcomes.placed = attempt(() => placing(binds))
        outcomes.half = attempt(() => half({ first: fragment, second: fragment }))
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(target, key)
        else Object.defineProperty(target, key, descriptor)
      }
      expect(outcomes.unplaced).toMatch(/bind 'admission' is a fragment the statement never places/)
      expect(outcomes.placed).toBe('accepted')
      expect(outcomes.half).toMatch(/bind 'second' is a fragment the statement never places/)
    })
  })

  const eventInsert = () =>
    db.insertInto('events').values({
      queue: 'q',
      event_name: 'e',
      payload: 'p',
      emitted_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    })

  it('stamps an inserting compare-and-set by position, and keeps a preserved instant on conflict', async () => {
    const upsert = eventInsert().onConflict((conflict) =>
      conflict
        .columns(['queue', 'event_name'])
        .doUpdateSet((eb) => ({
          fence_stamp: stampValue,
          fence_at_ms: eb.ref('events.emitted_at_ms'),
        }))
        .where((eb) => eb('events.fence_stamp', 'is not', stampValue)),
    )
    const { captured, executor } = capturingExecutor(1)
    await batch().casTree('event', statement(upsert)).run(executor)
    expect(captured).toEqual([
      {
        sql: `insert into "events" ("queue", "event_name", "payload", "emitted_at_ms", "fence_stamp", "fence_at_ms") values (?, ?, ?, ${CLOCK}, ?, ${CLOCK}) on conflict ("queue", "event_name") do update set "fence_stamp" = ?, "fence_at_ms" = "events"."emitted_at_ms" where "events"."fence_stamp" is not ?`,
        args: ['q', 'e', 'p', 'seed:event', 'seed:event', 'seed:event'],
      },
    ])
  })

  it('refuses an insert that does not stamp its row, or an upsert that does not re-stamp as its table requires', () => {
    const unstamped = db
      .insertInto('events')
      .values({ queue: 'q', event_name: 'e', payload: 'p', emitted_at_ms: nowValue })
    expect(() => batch().casTree('event', statement(unstamped))).toThrow(
      /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
    )
    const misplaced = db
      .insertInto('events')
      .columns(['queue', 'event_name', 'fence_stamp', 'fence_at_ms'])
      .expression(
        db.selectNoFrom((eb) => [
          eb.val('q').as('queue'),
          aliasedAs(stampValue, 'event_name'),
          eb.val('e').as('fence_stamp'),
          aliasedAs(nowValue, 'fence_at_ms'),
        ]),
      )
    expect(() => batch().casTree('event', statement(misplaced))).toThrow(
      /must insert fence_stamp as the stamp/,
    )
    const conflict = (set: 'clock' | 'none') =>
      eventInsert().onConflict((oc) =>
        oc
          .columns(['queue', 'event_name'])
          .doUpdateSet(
            set === 'clock' ? { fence_stamp: stampValue, fence_at_ms: nowValue } : { payload: 'x' },
          ),
      )
    // An event's first instant is a preserved fact: a re-emit keeps it and takes the stamp.
    expect(() => batch().casTree('event', statement(conflict('clock')))).toThrow(
      /must preserve events.emitted_at_ms while re-stamping/,
    )
    expect(() => batch().casTree('event', statement(conflict('none')))).toThrow(
      /must preserve events.emitted_at_ms while re-stamping/,
    )
    const waitInsert = () =>
      db.insertInto('waits').values({
        run_id: 'r1',
        step_name: 's',
        queue: 'q',
        task_id: 't1',
        event_name: 'e',
        status: 'waiting',
        created_at_ms: nowValue,
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      })
    const silentUpsert = waitInsert().onConflict((oc) =>
      oc.columns(['run_id', 'step_name']).doUpdateSet({ status: 'waiting' }),
    )
    expect(() => batch().casTree('register', statement(silentUpsert))).toThrow(
      /does not re-stamp the row and its instant/,
    )
    const leaveAlone = waitInsert().onConflict((oc) =>
      oc.columns(['run_id', 'step_name']).doNothing(),
    )
    expect(() => batch().casTree('register', statement(leaveAlone))).not.toThrow()
  })

  const WAIT_COLUMNS = [
    'run_id',
    'step_name',
    'queue',
    'task_id',
    'event_name',
    'status',
    'created_at_ms',
    'fence_stamp',
    'fence_at_ms',
  ] as const

  it('refuses an INSERT … SELECT whose star selection shifts the provenance positions', () => {
    // The star is one selection and many columns, so the stamp read at selection 1
    // lands in whatever column the expanded star pushes it to. Three columns for three
    // selections, so only the star is wrong.
    const shifted = db
      .insertInto('waits')
      .columns(['run_id', 'fence_stamp', 'fence_at_ms'])
      .expression(
        db
          .selectFrom('events')
          .selectAll('events')
          .select(() => [aliasedAs(stampValue, 'fence_stamp'), aliasedAs(nowValue, 'fence_at_ms')])
          .where('events.queue', '=', 'q') as never,
      )
    expect(() => batch().casTree('register', statement(shifted))).toThrow(
      /one plain selection for each column/,
    )
    const bareStar = db
      .insertInto('waits')
      .columns(['run_id', 'fence_stamp', 'fence_at_ms'])
      .expression(
        db
          .selectFrom('events')
          .selectAll()
          .select(() => [aliasedAs(stampValue, 'fence_stamp'), aliasedAs(nowValue, 'fence_at_ms')])
          .where('events.queue', '=', 'q') as never,
      )
    expect(() => batch().casTree('register', statement(bareStar))).toThrow(
      /one plain selection for each column/,
    )
  })

  it('refuses a conflict arm that overwrites the preserved fact it re-stamps', () => {
    const overwriting = eventInsert().onConflict((conflict) =>
      conflict.columns(['queue', 'event_name']).doUpdateSet((eb) => ({
        fence_stamp: stampValue,
        fence_at_ms: eb.ref('events.emitted_at_ms'),
        emitted_at_ms: nowValue,
        payload: 'second',
      })),
    )
    expect(() => batch().casTree('event', statement(overwriting))).toThrow(
      /may assign only fence_stamp and fence_at_ms/,
    )
  })

  it('refuses an insert that binds the preserved first instant instead of reading the clock', () => {
    const clientInstant = db.insertInto('events').values({
      queue: 'q',
      event_name: 'e',
      payload: 'p',
      emitted_at_ms: 12345,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    })
    expect(() => batch().casTree('event', statement(clientInstant))).toThrow(
      /must insert events.emitted_at_ms as the clock/,
    )
  })

  it('holds every condition of the insert rules, one refusal each', () => {
    const refused = (name: string, builder: Builder, why: RegExp) =>
      expect(() => batch().casTree(name, statement(builder))).toThrow(why)
    const conflict = (set: (eb: ExpressionBuilder<StoreTables, 'events'>) => object) =>
      eventInsert().onConflict((oc) =>
        oc.columns(['queue', 'event_name']).doUpdateSet((eb) => set(eb as never) as never),
      )
    // The clock, where the existing case covers only the stamp.
    refused(
      'event',
      db.insertInto('events').values({
        queue: 'q',
        event_name: 'e',
        payload: 'p',
        emitted_at_ms: nowValue,
        fence_stamp: stampValue,
        fence_at_ms: 5,
      }),
      /must insert fence_stamp as the stamp and fence_at_ms as the clock/,
    )
    // A conflict arm that copies the right instant and takes no stamp.
    refused(
      'event',
      conflict((eb) => ({ fence_at_ms: eb.ref('events.emitted_at_ms') })),
      /must preserve events.emitted_at_ms while re-stamping/,
    )
    // The right column of the wrong row: the proposed row's instant is this emit's clock.
    refused(
      'event',
      conflict((eb) => ({
        fence_stamp: stampValue,
        fence_at_ms: eb.ref('excluded.emitted_at_ms' as never),
      })),
      /must preserve events.emitted_at_ms while re-stamping/,
    )
    // The right row and the wrong column.
    refused(
      'event',
      conflict((eb) => ({ fence_stamp: stampValue, fence_at_ms: eb.ref('events.fence_at_ms') })),
      /must preserve events.emitted_at_ms while re-stamping/,
    )
    // A column listed twice has no one position to read.
    refused(
      'register',
      db
        .insertInto('waits')
        .columns(['fence_stamp', 'fence_stamp', 'fence_at_ms'] as never)
        .expression(
          db
            .selectNoFrom(() => [
              aliasedAs(stampValue, 'fence_stamp'),
              aliasedAs(stampValue, 'again'),
              aliasedAs(nowValue, 'fence_at_ms'),
            ])
            .where(predicate('1 = 1')) as never,
        ),
      /must insert fence_stamp as the stamp/,
    )
    // Two rows, and a SELECT with fewer selections than columns.
    const row = {
      queue: 'q',
      event_name: 'e',
      payload: 'p',
      emitted_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    }
    refused('event', db.insertInto('events').values([row, row]), /exactly one row of values/)
    refused(
      'register',
      db
        .insertInto('waits')
        .columns(['run_id', 'fence_stamp', 'fence_at_ms'])
        .expression(
          db.selectNoFrom(() => [
            aliasedAs(stampValue, 'fence_stamp'),
            aliasedAs(nowValue, 'fence_at_ms'),
          ]) as never,
        ),
      /one plain selection for each column/,
    )
  })

  it('refuses an ON CONFLICT that names no columns', () => {
    const anyIndex = eventInsert().onConflict((conflict) => conflict.doNothing())
    expect(() => batch().casTree('event', statement(anyIndex))).toThrow(/names no columns/)
  })

  const taskInsert = () =>
    db.insertInto('tasks').values({
      task_id: 't1',
      queue: 'q',
      task_name: 'job',
      params: '{}',
      retry_strategy: '{}',
      max_attempts: 1,
      state: 'pending',
      attempts: 0,
      infra_retries: 0,
      enqueue_at_ms: nowValue,
      created_at_ms: nowValue,
      fence_stamp: stampValue,
      fence_at_ms: nowValue,
    })

  it('allows a conflict target narrowed by a partial-index predicate, and no other kind of target', async () => {
    const partial = taskInsert().onConflict((conflict) =>
      conflict
        .columns(['queue', 'idempotency_key'])
        .where('idempotency_key', 'is not', null)
        .doNothing(),
    )
    const { captured, executor } = capturingExecutor(1)
    await batch().casTree('task', statement(partial)).run(executor)
    expect(captured[0]?.sql).toContain(
      'on conflict ("queue", "idempotency_key") where "idempotency_key" is not null do nothing',
    )
    // A constraint name or an index expression names no columns, so the statement
    // cannot say which unique index it may lose on.
    const byConstraint = taskInsert().onConflict((conflict) =>
      conflict.constraint('tasks_idem').doNothing(),
    )
    expect(() => batch().casTree('task', statement(byConstraint))).toThrow(/names no columns/)
    const byExpression = taskInsert().onConflict((conflict) =>
      conflict.expression(sql`lower(queue)`).doNothing(),
    )
    expect(() => batch().casTree('task', statement(byExpression))).toThrow(/names no columns/)
  })

  it('refuses an index predicate that holds a bind or a fragment', () => {
    // A partial index is matched by its predicate's text. SQLite refuses a predicate
    // with a parameter in it, and PostgreSQL accepts one, so a bound predicate is a
    // statement that runs on one dialect and fails on the other.
    const bound = taskInsert().onConflict((conflict) =>
      conflict.columns(['queue', 'idempotency_key']).where('state', '=', 'pending').doNothing(),
    )
    expect(() => batch().casTree('task', statement(bound))).toThrow(/index predicate/)
    const opaque = taskInsert().onConflict((conflict) =>
      conflict
        .columns(['queue', 'idempotency_key'])
        .where(predicate('idempotency_key IS NOT NULL'))
        .doNothing(),
    )
    expect(() => batch().casTree('task', statement(opaque))).toThrow(/index predicate/)
  })
  it('refuses an INSERT … SELECT with ON CONFLICT and no WHERE', () => {
    // SQLite reads the ON of an unguarded SELECT's conflict clause as a join constraint.
    const unguarded = db
      .insertInto('waits')
      .columns([...WAIT_COLUMNS])
      .expression(
        db
          .selectFrom('runs')
          .select((eb) => [
            eb.ref('runs.run_id').as('run_id'),
            eb.val('s').as('step_name'),
            eb.ref('runs.queue').as('queue'),
            eb.ref('runs.task_id').as('task_id'),
            eb.val('e').as('event_name'),
            eb.val('waiting').as('status'),
            aliasedAs(nowValue, 'created_at_ms'),
            aliasedAs(stampValue, 'fence_stamp'),
            aliasedAs(nowValue, 'fence_at_ms'),
          ]),
      )
      .onConflict((conflict) => conflict.columns(['run_id', 'step_name']).doNothing())
    expect(() => batch().casTree('register', statement(unguarded))).toThrow(/needs a WHERE/)
  })

  describe('a follow-on that inserts', () => {
    // biome-ignore lint/suspicious/noExplicitAny: table types would not let a test write the shapes refused here
    type Loose = any
    const loose = compileOnlyBuilder<Loose>()
    const key = (eb: Loose) => eb('f.run_id', '=', 'r1')
    const gate = (eb: Loose) => eb('f.fence_stamp', '=', fenceValue('win'))
    const either = (eb: Loose) => eb.or([key(eb), gate(eb)])
    const joined = (select: Loose) => select.innerJoin('tasks as t', 't.task_id', 'f.task_id')

    /** A successor run, selected from the run this batch's compare-and-set stamped. */
    const successor = (
      shape: {
        from?: (select: Loose) => Loose
        task?: (eb: Loose) => Loose
        stamp?: Loose
        instant?: (eb: Loose) => Loose
        where?: (eb: Loose) => Loose
      } = {},
    ) => {
      const from = loose.selectFrom('runs as f')
      return loose
        .insertInto('runs')
        .columns(['run_id', 'queue', 'task_id', 'fence_stamp', 'fence_at_ms'])
        .expression(
          (shape.from?.(from) ?? from)
            .select((eb: Loose) => [
              eb.val('r2').as('run_id'),
              eb.ref('f.queue').as('queue'),
              aliasedAs(shape.task?.(eb) ?? eb.ref('f.task_id'), 'task_id'),
              aliasedAs(shape.stamp ?? stampValue, 'fence_stamp'),
              aliasedAs(shape.instant?.(eb) ?? eb.ref('f.fence_at_ms'), 'fence_at_ms'),
            ])
            .where((eb: Loose) => shape.where?.(eb) ?? eb.and([key(eb), gate(eb)])),
        )
    }

    /** A checkpoint written from the fenced run. Checkpoints carry no provenance. */
    const checkpoint = (
      shape: { where?: (eb: Loose) => Loose; owner?: (eb: Loose) => Loose } = {},
    ) => {
      const insert = loose
        .insertInto('checkpoints')
        .columns(['task_id', 'owner_attempt'])
        .expression(
          loose
            .selectFrom('runs as f')
            .select((eb: Loose) => [
              eb.ref('f.task_id').as('task_id'),
              eb.ref('f.attempt').as('owner_attempt'),
            ])
            .where((eb: Loose) => shape.where?.(eb) ?? eb.and([key(eb), gate(eb)])),
        )
      const owner = shape.owner
      return owner === undefined
        ? insert
        : insert.onConflict((conflict: Loose) =>
            conflict
              .columns(['task_id'])
              .doUpdateSet((eb: Loose) => ({ owner_attempt: owner(eb) })),
          )
    }

    const refused = (builder: Builder, why: RegExp) => expect(() => followOn(builder)).toThrow(why)

    it('inserts a stamped row selected from the fenced row, and later statements fence on it', async () => {
      const { captured, executor } = capturingExecutor(1)
      await withCas()
        .followOnTree('successor', statement(successor()), 'one')
        .tailTree(
          'inserted',
          statement(
            db
              .selectFrom('runs')
              .select('attempt')
              .where('run_id', '=', 'r2')
              .where('fence_stamp', '=', fenceValue('successor')),
          ),
        )
        .run(executor)
      expect(captured[1]).toEqual({
        sql: 'insert into "runs" ("run_id", "queue", "task_id", "fence_stamp", "fence_at_ms") select ? as "run_id", "f"."queue" as "queue", "f"."task_id" as "task_id", ? as "fence_stamp", "f"."fence_at_ms" as "fence_at_ms" from "runs" as "f" where ("f"."run_id" = ? and "f"."fence_stamp" = ?)',
        args: ['r2', 'seed:successor', 'r1', 'seed:win'],
      })
      expect(captured[2]?.args).toEqual(['r2', 'seed:successor'])
    })

    it('takes a SELECT and never VALUES, because only a SELECT can be gated', () => {
      refused(eventInsert(), /takes a SELECT, never VALUES/)
      refused(loose.insertInto('checkpoints').values({ task_id: 't' }), /never VALUES/)
    })

    it('gates the SELECT of an insert as it gates any statement', () => {
      expect(() => followOn(checkpoint())).not.toThrow()
      refused(checkpoint({ where: key }), /has no fence gating every row/)
      refused(checkpoint({ where: either }), /has no fence gating every row/)
    })

    it('stamps the inserted row, and takes its instant from the fenced row and nowhere else', () => {
      const instant = /fence_at_ms as the fenced row's own fence_at_ms/
      refused(successor({ stamp: fenceValue('win') }), /must insert fence_stamp as the stamp/)
      refused(successor({ stamp: sql.lit('s') }), /must insert fence_stamp as the stamp/)
      // Not a bind, and not another column of the fenced row.
      refused(successor({ instant: (eb) => eb.val(5) }), instant)
      refused(successor({ instant: (eb) => eb.ref('f.available_at_ms') }), instant)
      // Not a row the fence does not gate: a joined table, or any table when the fence
      // is missing or sits under OR.
      expect(() => followOn(successor({ from: joined }))).not.toThrow()
      refused(successor({ from: joined, instant: (eb) => eb.ref('t.fence_at_ms') }), instant)
      refused(successor({ where: key }), instant)
      refused(successor({ where: either }), instant)
      // An unqualified instant belongs to the only source, and to neither of two.
      expect(() => followOn(successor({ instant: (eb) => eb.ref('fence_at_ms') }))).not.toThrow()
      refused(successor({ from: joined, instant: (eb) => eb.ref('fence_at_ms') }), instant)
    })

    it('selects from the fenced row alone, so no second source multiplies what it inserts', () => {
      const alone = /must select from the fenced row alone/
      const beside = () => loose.selectFrom(['runs as f', 'tasks as t2'])
      // One FROM item, the fenced source. A join is explicit and carries its ON.
      expect(() => followOn(successor())).not.toThrow()
      expect(() => followOn(successor({ from: joined }))).not.toThrow()
      // A second FROM item inserts one stamped run for every task, whichever it selects.
      refused(successor({ from: beside, task: (eb) => eb.ref('t2.task_id') }), alone)
      refused(successor({ from: beside }), alone)
      // The one FROM item is another table, and the fenced row only joins it.
      refused(
        successor({
          from: () =>
            loose.selectFrom('tasks as t2').innerJoin('runs as f', 'f.task_id', 't2.task_id'),
        }),
        alone,
      )
    })

    it('takes a preserved first instant from the fenced row too, as a compare-and-set takes it from the clock', () => {
      const preserved = /must insert events\.emitted_at_ms as the fenced row's own fence_at_ms/
      /** An event recorded from the fenced run. `emitted` is null to leave the column out. */
      const recorded = (emitted: ((eb: Loose) => Loose) | null) =>
        loose
          .insertInto('events')
          .columns([
            'queue',
            'event_name',
            'payload',
            ...(emitted === null ? [] : ['emitted_at_ms']),
            'fence_stamp',
            'fence_at_ms',
          ])
          .expression(
            loose
              .selectFrom('runs as f')
              .select((eb: Loose) => [
                eb.ref('f.queue').as('queue'),
                eb.val('e').as('event_name'),
                eb.val('p').as('payload'),
                ...(emitted === null ? [] : [aliasedAs(emitted(eb), 'emitted_at_ms')]),
                aliasedAs(stampValue, 'fence_stamp'),
                eb.ref('f.fence_at_ms').as('fence_at_ms'),
              ])
              .where((eb: Loose) => eb.and([key(eb), gate(eb)])),
          )
      expect(() => followOn(recorded((eb) => eb.ref('f.fence_at_ms')))).not.toThrow()
      // Not a bind, not another column of the fenced row, and not left to a default.
      refused(
        recorded((eb) => eb.val(123)),
        preserved,
      )
      refused(
        recorded((eb) => eb.ref('f.available_at_ms')),
        preserved,
      )
      refused(recorded(null), preserved)
    })

    it('never takes the clock for the instant', () => {
      // The instant rule speaks first, and the clock rule would refuse it next.
      refused(
        successor({ instant: () => nowValue }),
        /fence_at_ms as the fenced row's own fence_at_ms/,
      )
    })

    it('selects plain columns and values, so no row appears that the fence did not match', () => {
      const plain = /must select plain columns and values/
      refused(successor({ task: (eb) => eb.fn.max('f.task_id') }), plain)
      refused(successor({ task: (eb) => eb.fn('upper', [eb.ref('f.task_id')]) }), plain)
      refused(
        successor({
          from: (select) => select.having((eb: Loose) => eb(eb.fn.countAll(), '>=', 0)),
        }),
        plain,
      )
    })

    it('reads a value fragment for a function call, as it reads nodes for one', () => {
      const plain = /must select plain columns and values/
      const taskFrom = (text: string, args: SqlFragment['args'] = []) =>
        successor({ task: () => value<string>(text, args) })
      // The node rule refuses every function node, so the text rule refuses every call,
      // however it is spaced or quoted, and not a list of aggregate spellings.
      refused(taskFrom('max(f.task_id)'), plain)
      refused(taskFrom('MAX (f.task_id)'), plain)
      refused(taskFrom('"max"(f.task_id)'), plain)
      refused(taskFrom('coalesce(f.task_id, ?)', ['t']), plain)
      refused(taskFrom('(SELECT min(t2.task_id) FROM tasks t2)'), plain)
      // Plain text stays: a column, arithmetic in parentheses, a keyword before a
      // parenthesis, and a call that is only the inside of a string literal.
      expect(() => followOn(taskFrom('f.task_id'))).not.toThrow()
      expect(() => followOn(taskFrom('(f.task_id)'))).not.toThrow()
      expect(() =>
        followOn(taskFrom("CASE WHEN f.attempt IN (1, 2) THEN f.task_id ELSE 'max(x)' END")),
      ).not.toThrow()
    })

    it('reads each value by position, so a star is refused', () => {
      refused(
        loose
          .insertInto('runs')
          .columns(['run_id'])
          .expression(loose.selectFrom('runs as f').selectAll().where(gate)),
        /without one plain selection for each column/,
      )
    })

    it('carries no conflict clause into a stamped table', () => {
      refused(
        successor().onConflict((conflict: Loose) => conflict.columns(['run_id']).doNothing()),
        /may carry no conflict clause/,
      )
    })

    describe('what these rules still do not check', () => {
      // Each exhibit is ACCEPTED, beside a control the same rule refuses. They mark
      // where the rules stop, so nobody takes them for more than they are.
      it('accepts a gate tied on a column that is not a key, which reaches rows the fenced row does not own', async () => {
        const completeTasks = (tie: boolean) =>
          db
            .updateTable('tasks')
            .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
            .where((eb) =>
              eb.exists(
                (tie
                  ? eb.selectFrom('runs as f').whereRef('f.queue', '=', 'tasks.queue')
                  : eb.selectFrom('runs as f')
                )
                  .select('f.run_id')
                  .where('f.run_id', '=', 'r1')
                  .where('f.fence_stamp', '=', fenceValue('win')),
              ),
            )
        // The control: with no tie at all the write is refused.
        refused(completeTasks(false), /not tied to the rows it reads or writes/)
        // The exhibit: one run's stamp, tied by its queue alone, completes every task in
        // that queue. The rule asks for a tie and cannot ask whether the tie is a key,
        // because an event legitimately wakes every run in its queue this way.
        const { captured, executor } = capturingExecutor(1)
        await withCas()
          .followOnTree('tasks', statement(completeTasks(true)), { many: 'the exhibit' })
          .run(executor)
        expect(captured[1]?.sql).toBe(
          'update "tasks" set "state" = ?, "fence_stamp" = ?, "fence_at_ms" = ? where exists (select "f"."run_id" from "runs" as "f" where "f"."queue" = "tasks"."queue" and "f"."run_id" = ? and "f"."fence_stamp" = ?)',
        )
      })

      it('accepts values read from a joined row that no node ties to the fenced row', () => {
        // The join's ON is store text. The rule holds the instant to the fenced source
        // and says nothing of where the other values come from.
        const fromAnyTask = successor({
          from: (select) =>
            select.innerJoin('tasks as t', (join: Loose) => join.on(predicate('1 = 1'))),
          task: (eb) => eb.ref('t.task_id'),
        })
        expect(() => followOn(fromAnyTask)).not.toThrow()
        // The control: the same joined row may not supply the instant.
        refused(
          successor({ from: joined, instant: (eb) => eb.ref('t.fence_at_ms') }),
          /fence_at_ms as the fenced row's own fence_at_ms/,
        )
      })

      it('refuses every call in a value fragment, a harmless scalar one included', () => {
        // The text rule cannot tell an aggregate from a scalar function, because a name
        // is all it reads, so it refuses both. The cost is a false refusal: lower() adds
        // no row. A value that needs a scalar function is built from nodes, where the
        // same refusal applies, or computed by the caller and bound.
        const plain = /must select plain columns and values/
        refused(successor({ task: () => value<string>('max(f.task_id)') }), plain)
        refused(successor({ task: () => value<string>('lower(f.task_id)') }), plain)
        refused(successor({ task: (eb) => eb.fn('lower', [eb.ref('f.task_id')]) }), plain)
      })
    })

    it('reads a conflict arm under the counting rule', () => {
      expect(() =>
        followOn(checkpoint({ owner: (eb) => eb.ref('excluded.owner_attempt') })),
      ).not.toThrow()
      // `excluded` is the incoming row, never the row being written, so arithmetic on it
      // counts nothing twice, in nodes or in a fragment.
      expect(() =>
        followOn(checkpoint({ owner: (eb) => eb('excluded.owner_attempt', '+', 1) })),
      ).not.toThrow()
      expect(() =>
        followOn(checkpoint({ owner: () => value<number>('excluded.owner_attempt + 1') })),
      ).not.toThrow()
      refused(checkpoint({ owner: (eb) => eb('owner_attempt', '+', 1) }), /bumps a counter blindly/)
      refused(
        checkpoint({ owner: () => value<number>('excluded.owner_attempt + owner_attempt') }),
        /raw fragment that mentions 'owner_attempt'/,
      )
      refused(
        checkpoint({ owner: (eb) => eb('checkpoints.owner_attempt', '+', 1) }),
        /bumps a counter blindly/,
      )
    })
  })

  it('counts a gated subquery only when it is tied to the row the statement writes', () => {
    const gatedBy = (tie: boolean) =>
      db
        .updateTable('tasks')
        .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
        .where((eb) =>
          eb.exists(
            (tie
              ? eb.selectFrom('runs as f').whereRef('f.task_id', '=', 'tasks.task_id')
              : eb.selectFrom('runs as f').where('f.run_id', '=', 'r1')
            )
              .select('f.run_id')
              .where('f.fence_stamp', '=', fenceValue('win')),
          ),
        )
    expect(() => followOn(gatedBy(true))).not.toThrow()
    // It would complete every task in the table whenever this batch won.
    expect(() => followOn(gatedBy(false))).toThrow(/not tied to the rows it reads or writes/)
  })

  it('ties a subquery gate to the fenced source, and lets nothing widen it', () => {
    // biome-ignore lint/suspicious/noExplicitAny: table types would not let a test write the shapes refused here
    type Loose = any
    const loose = compileOnlyBuilder<Loose>()
    const gate = (eb: Loose) => eb('f.fence_stamp', '=', fenceValue('win'))
    const tasks = (where: (eb: Loose) => Loose) =>
      loose
        .updateTable('tasks')
        .set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
        .where(where)
    const keyIn = (keys: (eb: Loose) => Loose) => tasks((eb) => eb('task_id', 'in', keys(eb)))
    const fenced = (eb: Loose) => eb.selectFrom('runs as f').where(gate)
    const widened = (eb: Loose) => eb.selectFrom(['runs as f', 'tasks as t2']).where(gate)
    const throughDerived = (inner: (eb: Loose) => Loose) =>
      keyIn((eb) => eb.selectFrom(inner(eb).as('fenced_source')).select('source_key'))
    const shapes: { shape: string; query: Builder; tied: boolean }[] = [
      {
        shape: 'IN selects a column of the fenced source',
        query: keyIn((eb) => fenced(eb).select('f.task_id')),
        tied: true,
      },
      {
        shape: "IN selects a bound value, so the key is the caller's and not the fenced row's",
        query: keyIn((eb) => fenced(eb).select(eb.val('t-victim').as('task_id'))),
        tied: false,
      },
      {
        shape: 'IN selects an expression over the fenced column',
        query: keyIn((eb) => fenced(eb).select(eb('f.attempt', '+', 1).as('task_id'))),
        tied: false,
      },
      {
        shape: 'IN selects the key of a second FROM source',
        query: keyIn((eb) => widened(eb).select('t2.task_id')),
        tied: false,
      },
      {
        shape: 'IN reads a second FROM source beside the fenced one',
        query: keyIn((eb) => widened(eb).select('f.task_id')),
        tied: false,
      },
      {
        shape: 'IN selects the key of a joined source',
        query: keyIn((eb) =>
          fenced(eb).innerJoin('tasks as t2', 't2.queue', 'f.queue').select('t2.task_id'),
        ),
        tied: false,
      },
      {
        shape: 'EXISTS equates the fenced source with the outer row',
        query: tasks((eb) =>
          eb.exists(fenced(eb).select('f.run_id').whereRef('f.task_id', '=', 'tasks.task_id')),
        ),
        tied: true,
      },
      {
        shape: 'EXISTS equates a second inner source with the outer row',
        query: tasks((eb) =>
          eb.exists(widened(eb).select('f.run_id').whereRef('t2.task_id', '=', 'tasks.task_id')),
        ),
        tied: false,
      },
      {
        shape: 'IN through a derived table that selects a column of the fenced source',
        query: throughDerived((eb) => fenced(eb).select('f.task_id as source_key').distinct()),
        tied: true,
      },
      {
        shape: 'IN through a derived table that selects a bound value',
        query: throughDerived((eb) =>
          fenced(eb).select(eb.val('t-victim').as('source_key')).distinct(),
        ),
        tied: false,
      },
      {
        shape: 'IN through a derived table over two FROM sources',
        query: throughDerived((eb) => widened(eb).select('t2.task_id as source_key').distinct()),
        tied: false,
      },
    ]
    const decided = shapes.map(({ shape, query }) => {
      try {
        withCas().followOnTree('task', statement(query), { many: 'a test' })
        return { shape, tied: true }
      } catch (error) {
        const untied = /not tied to the rows it reads or writes/.test(String(error))
        return { shape, tied: untied ? false : String(error) }
      }
    })
    expect(decided).toEqual(shapes.map(({ shape, tied }) => ({ shape, tied })))
  })

  it('reads an open tail with every rule but the gate, and makes it say why', () => {
    const others = () => db.selectFrom('events').select('payload').where('queue', '=', 'q')
    expect(() => withCas().tailTree('read', statement(others()))).toThrow(/has no fence gating/)
    expect(() =>
      withCas().openTailTree('read', 'another batch wrote the event', statement(others())),
    ).not.toThrow()
    expect(() => withCas().openTailTree('read', ' ', statement(others()))).toThrow(/needs a reason/)
    expect(() =>
      withCas().openTailTree(
        'read',
        'a reason',
        statement(others().where('emitted_at_ms', '<', nowValue)),
      ),
    ).toThrow(/reads the clock/)
    expect(() => withCas().openTailTree('read', 'a reason', statement(winCas()))).toThrow(
      /must be a SELECT/,
    )
  })

  it('skips the gate of an open tail and nothing else: a fence it compares must be on the table that fence stamps', () => {
    // The compare-and-set named `win` stamps runs, so comparing it with a task's stamp
    // never matches. A gated tail is refused for that, and an open one must be too.
    const misplaced = () =>
      db.selectFrom('tasks').select('state').where('fence_stamp', '=', fenceValue('win'))
    const never =
      /stamps 'runs', but the statement compares tasks\.fence_stamp, which never matches/
    expect(() => withCas().tailTree('read', statement(misplaced()))).toThrow(never)
    expect(() => withCas().openTailTree('read', 'a reason', statement(misplaced()))).toThrow(never)
    // An open tail may still compare a fence on the table it stamps.
    const placed = () =>
      db.selectFrom('runs').select('state').where('fence_stamp', '=', fenceValue('win'))
    expect(() => withCas().openTailTree('read', 'a reason', statement(placed()))).not.toThrow()
  })

  it('passes the shared spawn and sweep statements through a batch', async () => {
    const spawn = spawnTaskCas({
      taskId: 't1',
      queue: 'q',
      taskName: 'job',
      paramsJson: '{}',
      headersJson: null,
      retryStrategyJson: '{}',
      maxAttempts: 3,
      cancellationJson: null,
      idempotencyKey: null,
      enqueueAt: sqlFragment('$NOW$ + ?', [0]),
      cancelAt: sqlFragment('$NOW$ + ? + ?', [0, null]),
      identityFree: sqlFragment('NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)', ['t1']),
      enqueueFits: sqlFragment('? >= 0', [0]),
      cancelFits: sqlFragment('? IS NULL OR ? >= 0', [null, 0]),
    })
    const swept = { queue: 'q', runId: 'r1', claimGen: 2 }
    const owner = 'EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = runs.task_id)'
    const reopen = reopenLostLaunchCas({
      ...swept,
      launchLost: sqlFragment('activated_gen < claim_gen'),
      availableAt: sqlFragment('$NOW$ + MIN((relaunch_count + 1) * 5, 60) * 1000'),
      liveOwner: sqlFragment(owner),
      backoffFits: sqlFragment('1 = 1'),
    })
    const cap = capLostLaunchCas({
      ...swept,
      launchLost: sqlFragment('activated_gen < claim_gen'),
      owner: sqlFragment(`${owner} OR 1 = 0`),
    })
    const timeout = failClaimTimeoutCas({
      ...swept,
      timedOut: sqlFragment('activated_gen = claim_gen'),
      admission: sqlFragment(owner),
    })
    const sent: string[] = []
    for (const [name, cas] of [
      ['task', spawn],
      ['reopen', reopen],
      ['cap', cap],
      ['fail', timeout],
    ] as const) {
      const { captured, executor } = capturingExecutor(1)
      await batch().casTree(name, cas).run(executor)
      sent.push(captured[0]?.sql ?? '')
    }
    expect(sent[0]).toContain(
      'insert into "tasks" ("task_id", "queue", "task_name", "params", "headers", "retry_strategy", "max_attempts", "cancellation", "idempotency_key", "state", "enqueue_at_ms", "cancel_at_ms", "created_at_ms", "fence_stamp", "fence_at_ms") select ',
    )
    expect(sent[0]).toContain(
      'on conflict ("queue", "idempotency_key") where "idempotency_key" is not null do nothing',
    )
    // Every sweep keys on the generation its scan read, as nodes.
    const sweptClaim = 'where "run_id" = ? and "queue" = ? and "state" = ? and "claim_gen" = ?'
    expect(sent[1]).toContain('"relaunch_count" = "relaunch_count" + ?')
    expect(sent[1]).toContain(
      `${sweptClaim} and (activated_gen < claim_gen) and "relaunch_count" < ?`,
    )
    expect(sent[2]).toContain(
      `${sweptClaim} and (activated_gen < claim_gen) and "relaunch_count" = ?`,
    )
    // The owner alternatives stay inside their parentheses.
    expect(sent[2]).toContain(`and (${owner} OR 1 = 0)`)
    expect(sent[3]).toContain(`${sweptClaim} and (activated_gen = claim_gen) and (${owner})`)
    // A claim timeout keeps the expired deadline on the failed run, as its text did.
    expect(sent[3]).not.toContain('"claim_expires_at_ms"')
  })

  it('passes the shared suspend and event statements through a batch', async () => {
    const wakeAt = sqlFragment('(CASE WHEN ? = 1 THEN $NOW$ + ? ELSE ? END)', [1, 5_000, 0])
    const suspend = suspendCas({
      queue: 'q',
      runId: 'r1',
      claimToken: 'tok',
      wakeAt,
      wakeFits: sqlFragment('(CASE WHEN ? = 1 THEN 1 ELSE 1 END)', [1]),
      admission: sqlFragment('EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = runs.task_id)'),
    })
    const register = registerWaitCas({
      queue: 'q',
      runId: 'r1',
      taskId: 't1',
      stepName: 's',
      eventName: 'e',
      timeoutAt: sqlFragment('CASE WHEN ? IS NOT NULL THEN $NOW$ + ? ELSE NULL END', [5, 5]),
      timeoutFits: sqlFragment('? IS NULL OR 1 = 1', [5]),
      claimToken: 'tok',
      taskOwnsRun: sqlFragment('t.task_id = r.task_id AND t.queue = r.queue'),
      taskEligible: sqlFragment('t.cancel_at_ms IS NULL'),
    })
    const emit = emitEventCas({
      queue: 'q',
      eventName: 'e',
      payloadJson: '{}',
      existingEventAdmits: sqlFragment('events.payload IS NOT NULL'),
    })
    const sent: string[] = []
    for (const [name, cas] of [
      ['suspend', suspend],
      ['register', register],
      ['event', emit],
    ] as const) {
      const { captured, executor } = capturingExecutor(1)
      await batch().casTree(name, cas).run(executor)
      sent.push(captured[0]?.sql ?? '')
    }
    expect(sent[0]).toContain('"wake_event" = ?, "event_payload" = ?, "wake_step" = ?')
    expect(sent[0]).toContain(
      `case when ((CASE WHEN ? = 1 THEN ${CLOCK} + ? ELSE ? END)) <= ${CLOCK}`,
    )
    expect(sent[1]).toContain('on conflict ("run_id", "step_name") do nothing')
    // The claim's identity is nodes, whatever fragments a store passes.
    expect(sent[1]).toContain(
      'inner join "tasks" as "t" on (t.task_id = r.task_id AND t.queue = r.queue) where "r"."run_id" = ? and "r"."queue" = ? and "r"."task_id" = ? and "r"."claimed_by" = ? and "r"."state" = ? and (t.cancel_at_ms IS NULL)',
    )
    expect(sent[1]).toContain(
      `(CASE WHEN ? IS NOT NULL THEN ${CLOCK} + ? ELSE NULL END) as "timeout_at_ms"`,
    )
    expect(sent[2]).toContain(
      'do update set "fence_stamp" = ?, "fence_at_ms" = "events"."emitted_at_ms" where "events"."fence_stamp" is distinct from ? and (events.payload IS NOT NULL)',
    )
  })

  it('refuses a tree statement in a batch without a tree dialect', () => {
    const textOnly = new FencedBatch('b', 'seed', { now: CLOCK })
    expect(() => withCas(textOnly)).toThrow(/has no tree dialect/)
  })

  it('refuses a tail that is not a SELECT, and allows a fenced SELECT', () => {
    expect(() => withCas().tailTree('payload', statement(taskFollowOn()))).toThrow(
      /must be a SELECT/,
    )
    const payload = db
      .selectFrom('runs')
      .select('run_id')
      .where('fence_stamp', '=', fenceValue('win'))
    expect(() => withCas().tailTree('payload', statement(payload))).not.toThrow()
  })
})
