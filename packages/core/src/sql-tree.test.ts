import {
  DummyDriver,
  Kysely,
  type OperationNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  EngineToken,
  blindCounters,
  compileTree,
  conjuncts,
  gatingFences,
  rawBooleanFragments,
  readsClock,
  tokenExpression,
} from './sql-tree.js'

// biome-ignore lint/suspicious/noExplicitAny: the checks read trees, not table types
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new SqliteIntrospector(d),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
})
const fenceValue = () => tokenExpression<string>(EngineToken.fence('complete'))

/** The check PR3.9's first AST draft used: does a conjunct CONTAIN a fence equality? */
function containsFence(query: OperationNode): boolean {
  const where = (query as { where?: { where: OperationNode } }).where
  if (where === undefined) return false
  return JSON.stringify(where.where, (_key, value) =>
    value instanceof EngineToken ? `token:${value.kind}` : value,
  ).includes('"name":"fence_stamp"')
}

describe('SQL tree checks', () => {
  const shapes = [
    {
      shape: 'a fence as a top-level AND conjunct',
      query: db
        .updateTable('tasks')
        .set({ state: 'completed' })
        .where('run_id', '=', 'r')
        .where('fence_stamp', '=', fenceValue()),
      gates: true,
    },
    {
      shape: 'a fence joined by a top-level OR',
      query: db
        .updateTable('tasks')
        .set({ state: 'completed' })
        .where((eb) => eb.or([eb('run_id', '=', 'r'), eb('fence_stamp', '=', fenceValue())])),
      gates: false,
    },
    {
      shape: 'a fence under NOT EXISTS',
      query: db
        .deleteFrom('waits')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('runs as f')
                .select('f.run_id')
                .where('f.fence_stamp', '=', fenceValue()),
            ),
          ),
        ),
      gates: false,
    },
    {
      shape: 'a fence under NOT (EXISTS (…))',
      query: db
        .deleteFrom('waits')
        .where((eb) =>
          eb.not(
            eb.parens(
              eb.exists(
                eb
                  .selectFrom('runs as f')
                  .select('f.run_id')
                  .where('f.fence_stamp', '=', fenceValue()),
              ),
            ),
          ),
        ),
      gates: false,
    },
    {
      shape: 'a conjunct that contains a fence but is not one',
      query: db
        .updateTable('tasks')
        .set({ state: 'completed' })
        .where('run_id', '=', 'r')
        .where((eb) => eb.or([eb('fence_stamp', '=', fenceValue()), eb('state', '=', 'pending')])),
      gates: false,
    },
    {
      shape: 'a fence equality written value first',
      query: db
        .updateTable('tasks')
        .set({ state: 'completed' })
        .where('run_id', '=', 'r')
        .where((eb) => eb(eb.val(EngineToken.fence('complete')), '=', eb.ref('fence_stamp'))),
      gates: true,
    },
  ]

  it('decides whether a fence gates every written row, for every shape', () => {
    const decided = shapes.map(({ shape, query }) => ({
      shape,
      gates: gatingFences(query.toOperationNode()).length > 0,
    }))
    expect(decided).toEqual(shapes.map(({ shape, gates }) => ({ shape, gates })))
  })

  it('pins that a conjunct must BE a fence: the containment draft accepts the OR shapes', () => {
    const containment = shapes.map(({ shape, query }) => ({
      shape,
      gates: containsFence(query.toOperationNode()),
    }))
    expect(
      containment.filter(({ gates }, i) => gates !== shapes[i]?.gates).map(({ shape }) => shape),
    ).toEqual([
      'a fence joined by a top-level OR',
      'a fence under NOT EXISTS',
      'a fence under NOT (EXISTS (…))',
      'a conjunct that contains a fence but is not one',
    ])
  })

  it('finds a blind counter however its operands are written, and allows derived values', () => {
    const counters = [
      db.updateTable('tasks').set((eb) => ({ attempts: eb('attempts', '+', 1) })),
      db.updateTable('tasks').set((eb) => ({ attempts: eb(eb.val(1), '+', eb.ref('attempts')) })),
      db.updateTable('tasks').set((eb) => ({ attempts: eb.parens(eb('tasks.attempts', '-', 1)) })),
      db.updateTable('tasks').set((eb) => ({ attempts: eb('infra_retries', '+', 1) })),
      db
        .updateTable('tasks')
        .set((eb) => ({ attempts: eb.selectFrom('runs as f').select('f.attempt') })),
    ].map((query) => blindCounters(query.toOperationNode()))
    expect(counters).toEqual([['attempts'], ['attempts'], ['attempts'], [], []])
  })

  it('finds the clock token anywhere in a statement', () => {
    const now = () => tokenExpression<number>(EngineToken.now)
    expect(
      readsClock(db.updateTable('runs').set({ completed_at_ms: now() }).toOperationNode()),
    ).toBe(true)
    expect(
      readsClock(
        db
          .updateTable('runs')
          .set({ completed_at_ms: 5 })
          .where('fence_stamp', '=', fenceValue())
          .toOperationNode(),
      ),
    ).toBe(false)
  })

  it('counts raw fragments that decide which rows are written', () => {
    const query = db
      .updateTable('runs')
      .set({ state: 'completed', result: sql`json(${'x'})` })
      .where('run_id', '=', 'r')
      .where(sql<boolean>`typeof(lease_ms) = 'integer'`)
      .where((eb) =>
        eb.or([
          eb('state', '=', 'running'),
          eb.not(sql<boolean>`w.timeout_at_ms IS runs.available_at_ms`),
        ]),
      )
    const node = query.toOperationNode()
    expect(conjuncts((node as { where: { where: OperationNode } }).where.where)).toHaveLength(3)
    expect(rawBooleanFragments(node)).toBe(2)
  })
})

describe('compileTree', () => {
  it('binds stamps and fences, splices the clock, and keeps question-mark binds', () => {
    const dialect = { compiler: new SqliteQueryCompiler(), now: '(SELECT 7)' }
    const tree = db
      .updateTable('runs')
      .set({
        state: 'completed',
        completed_at_ms: tokenExpression<number>(EngineToken.now),
        fence_stamp: tokenExpression<string>(EngineToken.stamp),
      })
      .where('run_id', '=', 'r1')
      .where('fence_stamp', '=', tokenExpression<string>(EngineToken.fence('claim')))
      .toOperationNode()
    const compiled = compileTree(dialect, tree, {
      stamp: 'seed:complete',
      fence: (name: string) => `seed:${name}`,
    })
    expect(compiled.sql).toBe(
      'update "runs" set "state" = ?, "completed_at_ms" = (SELECT 7), "fence_stamp" = ? where "run_id" = ? and "fence_stamp" = ?',
    )
    expect(compiled.parameters).toEqual(['completed', 'seed:complete', 'r1', 'seed:claim'])
  })
})
