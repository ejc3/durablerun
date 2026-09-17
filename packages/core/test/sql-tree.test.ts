import { type OperationNode, SqliteQueryCompiler, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  TreeDialect,
  compileOnlyBuilder,
  fenceValue,
  gatingFences,
  nowValue,
  rawFragmentProblem,
  rawSql,
  selfCountingAssignments,
  sqlFragment,
  stampValue,
} from '../src/index.js'

// biome-ignore lint/suspicious/noExplicitAny: the checks read trees, not table types
const db = compileOnlyBuilder<any>()
const fence = () => fenceValue('complete')
// biome-ignore lint/suspicious/noExplicitAny: an expression builder over untyped tables
const fencedRuns = (eb: any) =>
  eb.selectFrom('runs as f').select('f.task_id').where('f.fence_stamp', '=', fence())

/** A containment check: does the WHERE clause CONTAIN a fence column anywhere? */
function containsFence(query: OperationNode): boolean {
  const where = (query as { where?: { where: OperationNode } }).where
  return where !== undefined && JSON.stringify(where.where).includes('"name":"fence_stamp"')
}

describe('SQL tree checks', () => {
  const update = () => db.updateTable('tasks').set({ state: 'completed' })
  const shapes = [
    {
      shape: 'a fence as a top-level AND conjunct',
      query: update().where('run_id', '=', 'r').where('fence_stamp', '=', fence()),
      gates: true,
    },
    {
      shape: 'a fence joined by a top-level OR',
      query: update().where((eb) =>
        eb.or([eb('run_id', '=', 'r'), eb('fence_stamp', '=', fence())]),
      ),
      gates: false,
    },
    {
      shape: 'a fence under NOT EXISTS',
      query: db.deleteFrom('waits').where((eb) => eb.not(eb.exists(fencedRuns(eb)))),
      gates: false,
    },
    {
      shape: 'a fence under NOT (EXISTS (…))',
      query: db.deleteFrom('waits').where((eb) => eb.not(eb.parens(eb.exists(fencedRuns(eb))))),
      gates: false,
    },
    {
      shape: 'a conjunct that contains a fence but is not one',
      query: update()
        .where('run_id', '=', 'r')
        .where((eb) => eb.or([eb('fence_stamp', '=', fence()), eb('state', '=', 'pending')])),
      gates: false,
    },
    {
      shape: 'a fence equality written value first',
      query: update().where((eb) => eb(fence(), '=', eb.ref('fence_stamp'))),
      gates: true,
    },
    {
      shape: 'a fence inside a required EXISTS subquery',
      query: db.deleteFrom('waits').where((eb) => eb.exists(fencedRuns(eb))),
      gates: true,
    },
    {
      shape: 'a fence inside a required IN subquery',
      query: update().where((eb) => eb('task_id', 'in', fencedRuns(eb))),
      gates: true,
    },
    {
      shape: 'a fence joined by OR inside a required subquery',
      query: update().where((eb) =>
        eb(
          'task_id',
          'in',
          eb
            .selectFrom('runs as f')
            .select('f.task_id')
            .where((inner) =>
              inner.or([inner('f.run_id', '=', 'r'), inner('f.fence_stamp', '=', fence())]),
            ),
        ),
      ),
      gates: false,
    },
  ]

  it('decides whether a fence gates every row, for every shape', () => {
    const decided = shapes.map(({ shape, query }) => ({
      shape,
      gates: gatingFences(query.toOperationNode()).length > 0,
    }))
    expect(decided).toEqual(shapes.map(({ shape, gates }) => ({ shape, gates })))
  })

  it('pins that a conjunct must BE a fence: a containment check accepts every shape that does not gate', () => {
    const wronglyAccepted = shapes
      .filter(({ query, gates }) => containsFence(query.toOperationNode()) !== gates)
      .map(({ shape }) => shape)
    expect(wronglyAccepted).toEqual([
      'a fence joined by a top-level OR',
      'a fence under NOT EXISTS',
      'a fence under NOT (EXISTS (…))',
      'a conjunct that contains a fence but is not one',
      'a fence joined by OR inside a required subquery',
    ])
  })

  it('names the table whose stamp a gating fence is compared with', () => {
    expect(gatingFences(shapes[0]?.query.toOperationNode() as OperationNode)).toEqual([
      { fence: 'complete', table: 'tasks' },
    ])
    expect(gatingFences(shapes[7]?.query.toOperationNode() as OperationNode)).toEqual([
      { fence: 'complete', table: 'runs' },
    ])
    const ambiguous = db
      .selectFrom('runs as r')
      .innerJoin('tasks as t', 't.task_id', 'r.task_id')
      .select('r.run_id')
      .where('fence_stamp', '=', fence())
    expect(gatingFences(ambiguous.toOperationNode())).toEqual([])
  })

  it('finds a counting assignment however it is written, and allows derived values', () => {
    const found = [
      update().set((eb) => ({ attempts: eb('attempts', '+', 1) })),
      update().set((eb) => ({ attempts: eb(eb.val(1), '+', eb.ref('attempts')) })),
      update().set((eb) => ({ attempts: eb.parens(eb('tasks.attempts', '-', 1)) })),
      update().set('attempts', (eb) => eb('attempts', '+', 1)),
      update().set((eb) => ({ attempts: eb('attempts', '*', 2) })),
      update().set((eb) => ({ attempts: eb(eb.val(5), '-', eb.ref('attempts')) })),
      update().set({ attempts: sql<number>`attempts + 1` }),
      update().set((eb) => ({ attempts: eb('infra_retries', '+', 1) })),
      update().set((eb) => ({ attempts: eb.selectFrom('runs as f').select('f.attempt') })),
      update().set((eb) => ({ attempts: eb.fn.coalesce('attempts', eb.val(0)) })),
    ].map((query) => selfCountingAssignments(query.toOperationNode()).map(({ how }) => how))
    expect(found).toEqual([
      ['arithmetic'],
      ['arithmetic'],
      ['arithmetic'],
      ['arithmetic'],
      ['arithmetic'],
      ['arithmetic'],
      ['raw'],
      [],
      [],
      [],
    ])
  })

  it('places every raw fragment by its declared role, and refuses one rawSql did not mint', () => {
    const predicate = (text: string) => rawSql<boolean>(sqlFragment(text), 'predicate')
    const placed = db
      .updateTable('runs')
      .set({ state: 'completed', result: rawSql<string>(sqlFragment(`json('x')`), 'value') })
      .where('run_id', '=', 'r')
      .where(predicate(`typeof(lease_ms) = 'integer'`))
      .where((eb) =>
        eb.or([
          eb('state', '=', 'running'),
          eb.not(predicate('w.timeout_at_ms IS runs.available_at_ms')),
        ]),
      )
      .where((eb) =>
        eb.exists(
          eb.selectFrom('tasks as t').select('t.task_id').where(predicate(`t.state = 'x'`)),
        ),
      )
      .where((eb) => eb('run_id', 'in', rawSql<string>(sqlFragment(`(SELECT 'r')`), 'subquery')))
    expect(rawFragmentProblem(placed.toOperationNode())).toBeNull()

    const unminted = db.updateTable('runs').set({ state: 'x' }).where(sql<boolean>`1 = 1`)
    expect(rawFragmentProblem(unminted.toOperationNode())).toBe(
      'a raw fragment that rawSql did not mint',
    )
    const misplaced = db
      .updateTable('runs')
      .set({ state: 'x' })
      .where(rawSql<boolean>(sqlFragment('1 = 1'), 'value'))
    expect(rawFragmentProblem(misplaced.toOperationNode())).toBe(
      "a 'value' fragment standing as a predicate",
    )
    const ordered = db.selectFrom('runs').select('run_id').orderBy('run_id', 'desc')
    expect(rawFragmentProblem(ordered.toOperationNode())).toBeNull()
  })

  it('binds stamps and fences, splices the clock, and reports what the walk saw', () => {
    const tree = db
      .updateTable('runs')
      .set({ state: 'completed', completed_at_ms: nowValue, fence_stamp: stampValue })
      .where('run_id', '=', 'r1')
      .where('fence_stamp', '=', fenceValue('claim'))
      .toOperationNode()
    const compiled = new TreeDialect(new SqliteQueryCompiler()).compile(tree, {
      now: '(SELECT 7)',
      stamp: 'seed:complete',
      fence: (name: string) => `seed:${name}`,
    })
    expect(compiled).toEqual({
      sql: 'update "runs" set "state" = ?, "completed_at_ms" = (SELECT 7), "fence_stamp" = ? where "run_id" = ? and "fence_stamp" = ?',
      parameters: ['completed', 'seed:complete', 'r1', 'seed:claim'],
      placeholders: 4,
      fences: ['claim'],
      readsClock: true,
    })
  })

  it('never executes: the builder only builds trees', async () => {
    await expect(db.selectFrom('runs').selectAll().execute()).rejects.toThrow(/only build trees/)
  })
})
