import { type OperationNode, SqliteQueryCompiler, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  FencedBatch,
  type SqlExecutor,
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

/** A statement minted the way stores mint them, with no binds of its own. */
function statement(builder: { toOperationNode(): OperationNode }, rawBooleans = 0, rawValues = 0) {
  return defineStatement('test', { rawBooleans, rawValues }, () => builder as never)({})
}

function batch(): FencedBatch {
  return new FencedBatch('b', 'seed', { now: CLOCK, tree: dialect })
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

const followOn = (builder: { toOperationNode(): OperationNode }, rawBooleans = 0, rawValues = 0) =>
  withCas().followOnTree('task', statement(builder, rawBooleans, rawValues), 'one')

describe('FencedBatch tree statements', () => {
  it('compiles a compare-and-set and a gated follow-on with every token bound', async () => {
    let captured: readonly SqlStatement[] = []
    const executor: SqlExecutor = {
      async batch(_label, statements) {
        captured = statements
        return statements.map(() => ({ rows: [], rowsAffected: 1 }) as SqlResult)
      },
    }
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
    const forged = {
      name: 'forged',
      tree: winCas().toOperationNode(),
      rawBooleans: 0,
      rawValues: 0,
    }
    expect(() => batch().casTree('win', forged)).toThrow(/must come from defineStatement/)
    const define = defineStatement('keyed', {}, (binds: { runId: string }) =>
      db.updateTable('runs').set({ state: 'completed' }).where('run_id', '=', binds.runId),
    )
    expect(() => define({ runId: undefined as never })).toThrow(/bind 'runId' is undefined/)
    const nested = defineStatement('nested', {}, (binds: { wake: { at: number } }) =>
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
      { builder: taskFollowOn().set({ first_started_at_ms: nowValue }), rawValues: 0 },
      {
        builder: taskFollowOn().set({ first_started_at_ms: sql.raw<number>(CLOCK) }),
        rawValues: 1,
      },
      {
        builder: taskFollowOn().set({
          first_started_at_ms: sql.raw<number>(`unixepoch('subsec')*1000`),
        }),
        rawValues: 1,
      },
      {
        builder: taskFollowOn().set((eb) => ({
          first_started_at_ms: eb.fn<number>('unixepoch', []),
        })),
        rawValues: 0,
      },
      {
        builder: taskFollowOn().set({
          first_started_at_ms: rawSql<number>(sqlFragment('$NOW$ + ?', [5])),
        }),
        rawValues: 1,
      },
    ]
    for (const { builder, rawValues } of spellings) {
      expect(() => followOn(builder, 0, rawValues)).toThrow(/reads the clock/)
    }
  })

  it('lets a compare-and-set carry the batch clock in a fragment, and no other clock', () => {
    const batchClock = winCas().where(sql.raw<boolean>(`lease_ms < ${CLOCK}`))
    const otherClock = winCas().where(sql.raw<boolean>('lease_ms < unixepoch()'))
    expect(() => batch().casTree('win', statement(batchClock, 1))).not.toThrow()
    expect(() => batch().casTree('win', statement(otherClock, 1))).toThrow(
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
    const raw = [
      { builder: taskFollowOn().set({ attempts: sql<number>`attempts + 1` }), rawValues: 1 },
      // A column reference inside a raw template is itself a raw fragment.
      {
        builder: taskFollowOn().set({ attempts: sql<number>`${sql.ref('attempts')} + 1` }),
        rawValues: 2,
      },
    ]
    for (const { builder, rawValues } of raw) {
      expect(() => followOn(builder, 0, rawValues)).toThrow(/raw fragment that mentions 'attempts'/)
    }
  })

  it('refuses a raw boolean the statement does not declare, and a placeholder it adds', () => {
    const undeclared = taskFollowOn().where(sql.raw<boolean>(`task_name = 'job'`))
    const unbound = taskFollowOn().where(sql.raw<boolean>('task_name = ?'))
    expect(() => followOn(undeclared)).toThrow(
      /holds 1 raw boolean fragments and 0 raw value fragments, but 'test' declares 0 and 0/,
    )
    const undeclaredValue = taskFollowOn().set({ last_attempt_run: sql.raw<string>(`'r1'`) })
    expect(() => followOn(undeclaredValue)).toThrow(/and 1 raw value fragments/)
    expect(() => followOn(undeclaredValue, 0, 1)).not.toThrow()
    expect(() => followOn(undeclared, 1)).not.toThrow()
    expect(() => followOn(unbound, 1)).toThrow(/2 placeholders|placeholders for/)
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

  it('turns the binds and clock of a fragment into nodes, and compiles a many-row compare-and-set', async () => {
    const claimMany = winCas().where(
      rawSql<boolean>(sqlFragment('lease_ms < $NOW$ + ? AND queue = ?', [250, 'q'])),
    )
    let captured: readonly SqlStatement[] = []
    const executor: SqlExecutor = {
      async batch(_label, statements) {
        captured = statements
        return statements.map(() => ({ rows: [], rowsAffected: 2 }) as SqlResult)
      },
    }
    const result = await batch().casManyTree('win', statement(claimMany, 1), 3).run(executor)
    expect(result).toMatchObject({ won: 'win', count: 2 })
    expect(captured).toEqual([
      {
        sql: `update "runs" set "state" = ?, "completed_at_ms" = ${CLOCK}, "fence_stamp" = ?, "fence_at_ms" = ${CLOCK} where "run_id" = ? and "state" = ? and lease_ms < ${CLOCK} + ? AND queue = ?`,
        args: ['completed', 'seed:win', 'r1', 'running', 250, 'q'],
      },
    ])
    expect(() => batch().casManyTree('win', statement(winCas()), 0)).toThrow(
      /max must be a positive/,
    )
  })

  it('refuses a fragment that holds a stamp or fence token, or binds the wrong count', () => {
    expect(() => rawSql(sqlFragment('fence_stamp = $STAMP$'))).toThrow(/stamp or fence token/)
    expect(() => rawSql(sqlFragment('fence_stamp = $FENCE:win$'))).toThrow(/stamp or fence token/)
    expect(() => rawSql(sqlFragment('queue = ?', ['q', 'extra']))).toThrow(/binds 1 of its 2/)
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
