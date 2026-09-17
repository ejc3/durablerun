import { type OperationNode, SqliteQueryCompiler, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  FENCE_SET,
  FencedBatch,
  type SqlExecutor,
  type SqlFragment,
  type SqlResult,
  type SqlStatement,
  TreeDialect,
  treeBuilder as db,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
  sqlFragment,
  stampValue,
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

  it('refuses a fragment that holds a stamp or fence token, or binds the wrong count', () => {
    expect(() => predicate('fence_stamp = $STAMP$')).toThrow(/stamp or fence token/)
    expect(() => predicate('fence_stamp = $FENCE:win$')).toThrow(/stamp or fence token/)
    expect(() => predicate('queue = ?', ['q', 'extra'])).toThrow(/binds 1 of its 2/)
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
