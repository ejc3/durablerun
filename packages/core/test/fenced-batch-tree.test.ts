import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  EngineToken,
  FencedBatch,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  type StoreTables,
  tokenExpression,
} from '../src/index.js'

/**
 * Each tree check paired: a shape it must refuse, and the nearest legitimate shape it
 * must still allow, as `fenced-batch.test.ts` does for text statements.
 */
const CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`
const dialect = { compiler: new SqliteQueryCompiler(), now: CLOCK }
const db = new Kysely<StoreTables>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new SqliteIntrospector(d),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
})
const stamp = tokenExpression<string>(EngineToken.stamp)
const now = tokenExpression<number>(EngineToken.now)
const fence = (name: string) => tokenExpression<string>(EngineToken.fence(name))

function batch(): FencedBatch {
  return new FencedBatch('b', 'seed', { now: CLOCK, tree: dialect })
}

function withCas(b: FencedBatch = batch()): FencedBatch {
  return b.casTree(
    'win',
    'runs',
    db
      .updateTable('runs')
      .set({ state: 'completed', completed_at_ms: now, fence_stamp: stamp, fence_at_ms: now })
      .where('run_id', '=', 'r1')
      .where('state', '=', 'running'),
  )
}

const taskFollowOn = () =>
  db
    .updateTable('tasks')
    .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: 5 })
    .where('task_id', '=', 't1')
    .where('fence_stamp', '=', fence('win'))

describe('FencedBatch tree statements', () => {
  it('compiles a compare-and-set and a gated follow-on with every token bound', async () => {
    let captured: readonly SqlStatement[] = []
    const executor: SqlExecutor = {
      async batch(_label, statements) {
        captured = statements
        return statements.map(() => ({ rows: [], rowsAffected: 1 }) as SqlResult)
      },
    }
    const result = await withCas()
      .followOnTree('task', 'tasks', taskFollowOn(), 'one')
      .run(executor)
    expect(result.won).toBe('win')
    expect(captured).toEqual([
      {
        sql: `update "runs" set "state" = ?, "completed_at_ms" = ${CLOCK}, "fence_stamp" = ?, "fence_at_ms" = ${CLOCK} where "run_id" = ? and "state" = ?`,
        args: ['completed', 'seed:win', 'r1', 'running'],
      },
      {
        sql: 'update "tasks" set "state" = ?, "fence_stamp" = ?, "fence_at_ms" = ? where "task_id" = ? and "fence_stamp" = ?',
        args: ['completed', 'seed:task', 5, 't1', 'seed:win'],
      },
    ])
  })

  it('refuses a compare-and-set that does not stamp its target', () => {
    expect(() =>
      batch().casTree(
        'win',
        'runs',
        db
          .updateTable('runs')
          .set({ state: 'completed', fence_at_ms: now })
          .where('run_id', '=', 'r1'),
      ),
    ).toThrow(/must assign fence_stamp the stamp and fence_at_ms the clock/)
  })

  it('refuses a follow-on whose fence is joined by OR, and allows one that gates', () => {
    const ored = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: 5 })
      .where((eb) => eb.or([eb('task_id', '=', 't1'), eb('fence_stamp', '=', fence('win'))]))
    expect(() => withCas().followOnTree('task', 'tasks', ored, 'one')).toThrow(
      /no fence gating every row/,
    )
    expect(() => withCas().followOnTree('task', 'tasks', taskFollowOn(), 'one')).not.toThrow()
  })

  it('refuses a follow-on that reads the clock by token or through a raw fragment', () => {
    const byToken = taskFollowOn().set({ first_started_at_ms: now })
    const byRaw = taskFollowOn().set({ first_started_at_ms: sql<number>`${sql.raw(CLOCK)}` })
    expect(() => withCas().followOnTree('task', 'tasks', byToken, 'one')).toThrow(/reads the clock/)
    expect(() => withCas().followOnTree('task', 'tasks', byRaw, 'one')).toThrow(/reads the clock/)
  })

  it('refuses a blind counter in a follow-on', () => {
    const counting = taskFollowOn().set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    expect(() => withCas().followOnTree('task', 'tasks', counting, 'one')).toThrow(
      /bumps a counter blindly/,
    )
  })

  it('refuses a fence naming no statement of the batch', () => {
    const stray = db
      .updateTable('tasks')
      .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: 5 })
      .where('fence_stamp', '=', fence('missing'))
    expect(() => withCas().followOnTree('task', 'tasks', stray, 'one')).toThrow(
      /names no statement/,
    )
  })

  it('refuses a follow-on that updates a fenced table without stamping it', () => {
    const unstamped = db
      .updateTable('tasks')
      .set({ state: 'completed' })
      .where('task_id', '=', 't1')
      .where('fence_stamp', '=', fence('win'))
    expect(() => withCas().followOnTree('task', null, unstamped, 'one')).toThrow(
      /does not stamp it/,
    )
  })

  it('refuses a raw fragment that adds a placeholder no argument binds', () => {
    const unbound = taskFollowOn().where(sql<boolean>`${sql.raw('task_name = ?')}`)
    expect(() => withCas().followOnTree('task', 'tasks', unbound, 'one')).toThrow(/placeholders/)
  })

  it('refuses a blind counter written with the two-argument set form', () => {
    const counting = taskFollowOn().set('attempts', (eb) => eb('attempts', '+', 1))
    expect(() => withCas().followOnTree('task', 'tasks', counting, 'one')).toThrow(
      /bumps a counter blindly/,
    )
  })

  it('refuses a second assignment to a provenance column', () => {
    const forged = db
      .updateTable('runs')
      .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: now })
      .set('fence_stamp', 'forged')
      .where('run_id', '=', 'r1')
    expect(() => batch().casTree('win', 'runs', forged)).toThrow(
      /must assign fence_stamp the stamp/,
    )
  })

  it('refuses a counter hidden in a raw fragment', () => {
    const rawText = taskFollowOn().set({ attempts: sql<number>`attempts + 1` })
    const rawReference = taskFollowOn().set({ attempts: sql<number>`${sql.ref('attempts')} + 1` })
    expect(() => withCas().followOnTree('task', 'tasks', rawText, 'one')).toThrow(/attempts/)
    expect(() => withCas().followOnTree('task', 'tasks', rawReference, 'one')).toThrow(/attempts/)
  })

  it('refuses a data-modifying common table expression under a tail', () => {
    const tail = db
      .with('gone', (q) => q.deleteFrom('runs').returningAll())
      .selectFrom('runs')
      .select('run_id')
      .where('fence_stamp', '=', fence('win'))
    expect(() => withCas().tailTree('payload', tail)).toThrow(/statement grammar/)
  })

  it('refuses a fence compared on a table its statement did not stamp', () => {
    expect(() => withCas().followOnTree('task', 'tasks', taskFollowOn(), 'one')).toThrow(
      /stamps 'runs'/,
    )
  })

  it('refuses UPDATE FROM and a schema-qualified table', () => {
    const updateFrom = db
      .updateTable('tasks')
      .from('runs')
      .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: 5 })
      .where('runs.fence_stamp', '=', fence('win'))
    const otherSchema = db
      .withSchema('other')
      .updateTable('runs')
      .set({ state: 'completed', fence_stamp: stamp, fence_at_ms: now })
      .where('run_id', '=', 'r1')
    expect(() => withCas().followOnTree('task', 'tasks', updateFrom, 'one')).toThrow(
      /statement grammar/,
    )
    expect(() => batch().casTree('win', 'runs', otherSchema)).toThrow(/statement grammar/)
  })

  it('refuses a follow-on that respells the clock or calls it as a function', () => {
    const respelled = taskFollowOn().set({
      first_started_at_ms: sql<number>`${sql.raw("unixepoch('subsec')*1000")}`,
    })
    const called = taskFollowOn().set((eb) => ({
      first_started_at_ms: eb.fn<number>('unixepoch', []),
    }))
    expect(() => withCas().followOnTree('task', 'tasks', respelled, 'one')).toThrow(
      /reads the clock/,
    )
    expect(() => withCas().followOnTree('task', 'tasks', called, 'one')).toThrow(/reads the clock/)
  })

  it('refuses a tree statement in a batch without a tree dialect', () => {
    const textOnly = new FencedBatch('b', 'seed', { now: CLOCK })
    expect(() => withCas(textOnly)).toThrow(/has no tree dialect/)
  })

  it('refuses a tail that is not a SELECT, and allows a fenced SELECT', () => {
    expect(() => withCas().tailTree('payload', taskFollowOn())).toThrow(/must be a SELECT/)
    const payload = db.selectFrom('runs').select('run_id').where('fence_stamp', '=', fence('win'))
    expect(() => withCas().tailTree('payload', payload)).not.toThrow()
  })
})
