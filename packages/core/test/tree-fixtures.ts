import { type OperationNode, SqliteQueryCompiler } from 'kysely'
import { expect } from 'vitest'
import {
  EventName,
  FencedBatch,
  type SqlExecutor,
  type SqlFragment,
  type SqlResult,
  type SqlStatement,
  TreeDialect,
  aliasedAs,
  compileOnlyBuilder,
  treeBuilder as db,
  defineStatement,
  fenceValue,
  nowValue,
  rawSql,
  sqlFragment,
  stampValue,
  statementTable,
} from '../src/index.js'

/** What `fenced-batch-tree.test.ts` and `fenced-batch-tree-verdicts.test.ts` both build on. */
export const CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`
const dialect = new TreeDialect(new SqliteQueryCompiler())

export type Builder = { toOperationNode(): OperationNode }

/** A statement whose definition names the lock of an event, as core's event statements do. */
export const onEvent = (builder: Builder, queue = 'q', eventName = 'e') =>
  defineStatement(
    'test',
    () => builder as never,
    () => ({ queue, eventName: EventName.fromPort('test', eventName) }),
  )({})
/** True of an INSERT into `events` or `waits`, which a batch admits only under its event's lock. */
const insertsAnEvent = (builder: Builder) => {
  const tree = builder.toOperationNode()
  return tree.kind === 'InsertQueryNode' && ['events', 'waits'].includes(statementTable(tree) ?? '')
}
/**
 * A statement minted the way stores mint them, with no binds of its own. These fixtures
 * have one event, `e` of queue `q`, and a statement that records it or registers a wait on
 * it names its lock as core's event statements do, so the rule each test is about is the
 * one that answers. The lock rule's own cases mint their statements themselves.
 */
export const statement = (builder: Builder) =>
  insertsAnEvent(builder) ? onEvent(builder) : defineStatement('test', () => builder as never)({})
export const predicate = (text: string, args: SqlFragment['args'] = []) =>
  rawSql<boolean>(sqlFragment(text, args), 'predicate')
export const value = <T>(text: string, args: SqlFragment['args'] = []) =>
  rawSql<T>(sqlFragment(text, args), 'value')

/** A batch whose clock expression is the text given, for the rules that compare against it. */
export function batchWithClock(now: string): FencedBatch {
  return new FencedBatch('b', 'seed', { now, tree: dialect })
}

export function batch(label = 'b'): FencedBatch {
  return new FencedBatch(label, 'seed', { now: CLOCK, tree: dialect })
}

/** An executor that records what it was sent and reports `rowsAffected` for each statement. */
export function capturingExecutor(rowsAffected: number) {
  const captured: SqlStatement[] = []
  const executor: SqlExecutor = {
    async batch(_label, statements) {
      captured.push(...statements)
      return statements.map(() => ({ rows: [], rowsAffected }) as SqlResult)
    },
  }
  return { captured, executor }
}

export const winCas = () =>
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

export function withCas(b: FencedBatch = batch()): FencedBatch {
  return b.casTree('win', statement(winCas()))
}

/** Tasks owned by the run this batch's compare-and-set stamped. */
export const taskFollowOn = () =>
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

export const followOn = (builder: Builder) =>
  withCas().followOnTree('task', statement(builder), 'one')

// The shapes of an inserting statement, loosely typed so a test can write what is refused.
// biome-ignore lint/suspicious/noExplicitAny: table types would not let a test write the shapes refused here
export type Loose = any
export const loose = compileOnlyBuilder<Loose>()
export const key = (eb: Loose) => eb('f.run_id', '=', 'r1')
export const gate = (eb: Loose) => eb('f.fence_stamp', '=', fenceValue('win'))
export const either = (eb: Loose) => eb.or([key(eb), gate(eb)])
export const joined = (select: Loose) => select.innerJoin('tasks as t', 't.task_id', 'f.task_id')

/** A successor run, selected from the run this batch's compare-and-set stamped. */
export const successor = (
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
export const checkpoint = (
  shape: {
    where?: (eb: Loose) => Loose
    owner?: (eb: Loose) => Loose
    updatedAt?: (eb: Loose) => Loose
  } = {},
) => {
  const insert = loose
    .insertInto('checkpoints')
    .columns(['task_id', 'owner_attempt', 'updated_at_ms'])
    .expression(
      loose
        .selectFrom('runs as f')
        .select((eb: Loose) => [
          eb.ref('f.task_id').as('task_id'),
          eb.ref('f.attempt').as('owner_attempt'),
          aliasedAs(shape.updatedAt?.(eb) ?? eb.ref('f.fence_at_ms'), 'updated_at_ms'),
        ])
        .where((eb: Loose) => shape.where?.(eb) ?? eb.and([key(eb), gate(eb)])),
    )
  const owner = shape.owner
  return owner === undefined
    ? insert
    : insert.onConflict((conflict: Loose) =>
        conflict.columns(['task_id']).doUpdateSet((eb: Loose) => ({ owner_attempt: owner(eb) })),
      )
}

/** An event recorded from the fenced run. `emitted` is null to leave the column out. */
export const recorded = (emitted: ((eb: Loose) => Loose) | null) =>
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

export const eventInsert = () =>
  db.insertInto('events').values({
    queue: 'q',
    event_name: 'e',
    payload: 'p',
    emitted_at_ms: nowValue,
    fence_stamp: stampValue,
    fence_at_ms: nowValue,
  })

// A follow-on update of tasks, and the subquery gates the tie tests put on it.
/** The fenced source: the run this batch's compare-and-set stamped. */
export const fenced = (eb: Loose) => eb.selectFrom('runs as f').where(gate)
/** The fenced source beside a second FROM source, which can supply rows of its own. */
export const widened = (eb: Loose) => eb.selectFrom(['runs as f', 'tasks as t2']).where(gate)
export const stampedTasks = () =>
  loose.updateTable('tasks').set({ state: 'completed', fence_stamp: stampValue, fence_at_ms: 5 })
export const tasksWhere = (where: (eb: Loose) => Loose) => stampedTasks().where(where)
export const keyIn = (keys: (eb: Loose) => Loose) =>
  tasksWhere((eb) => eb('task_id', 'in', keys(eb)))
export const tiedKeys = (eb: Loose) => fenced(eb).select('f.task_id')
export const tiedBy = (tie: (select: Loose, eb: Loose) => Loose) =>
  tasksWhere((eb) => eb.exists(tie(fenced(eb).select('f.run_id'), eb)))
/** IN through one derived table, which selects `source_key` however the test says. */
export const throughDerived = (inner: (eb: Loose) => Loose) =>
  keyIn((eb) => eb.selectFrom(inner(eb).as('fenced_source')).select('source_key'))
/** A follow-on update of tasks, gated and tied, with whatever provenance the test gives it. */
export const tasksSetting = (assignments: object) =>
  loose
    .updateTable('tasks')
    .set({ state: 'completed', ...assignments })
    .where((eb: Loose) => eb('task_id', 'in', tiedKeys(eb)))

/** An upsert of the one event, with the conflict arm the test gives it. */
export const eventUpsert = (set: (eb: Loose) => object) =>
  (eventInsert() as Loose).onConflict((conflict: Loose) =>
    conflict.columns(['queue', 'event_name']).doUpdateSet((eb: Loose) => set(eb)),
  )
export const waitInsert = () =>
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
/** The one event as a row of VALUES, with the columns the test overrides. */
export const eventRow = (row: object) =>
  loose.insertInto('events').values({
    queue: 'q',
    event_name: 'e',
    payload: 'p',
    emitted_at_ms: nowValue,
    fence_stamp: stampValue,
    fence_at_ms: nowValue,
    ...row,
  })

/** A tail that joins the fenced run to its task, comparing whichever stamp the test names. */
export const joinedRead = (stamp: string) =>
  loose
    .selectFrom('runs as f')
    .innerJoin('tasks as t', 't.task_id', 'f.task_id')
    .select('f.state')
    .where(stamp, '=', fenceValue('win'))

export const taskInsert = () =>
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

/** A stamped wait selected from every run, with a conflict clause and no WHERE before it. */
export const unguardedWaitInsert = () =>
  db
    .insertInto('waits')
    .columns([
      'run_id',
      'step_name',
      'queue',
      'task_id',
      'event_name',
      'status',
      'created_at_ms',
      'fence_stamp',
      'fence_at_ms',
    ])
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

// What a registered mutation's test asserts with. The marker is the first line of the
// failure, which is how `scripts/mutation-probe.py` attributes a caught mutant.

/** Fail with the marker when the refusal is gone. A different refusal fails as itself. */
export function refuses(marker: string, expected: RegExp, action: () => unknown): void {
  try {
    action()
  } catch (error) {
    expect(String(error)).toMatch(expected)
    return
  }
  throw new Error(marker)
}

/** Fail with the marker when a shape the rule allows is refused, and keep what refused it. */
export function accepts(marker: string, action: () => unknown): void {
  expect(action, marker).not.toThrow()
}

/**
 * For a condition whose deletion leaves the shape refused by the next rule: the refusal
 * must be `expected`, and the marker is the failure when it has become `replacement`.
 * The message is what such a condition decides. An accepted shape, or a third refusal,
 * fails as itself.
 */
export function refusesAs(
  marker: string,
  expected: RegExp,
  replacement: RegExp,
  action: () => unknown,
): void {
  let refusal: unknown
  try {
    action()
  } catch (error) {
    refusal = error
  }
  if (refusal === undefined) throw new Error('expected the shape to be refused')
  if (expected.test(String(refusal))) return
  if (replacement.test(String(refusal))) throw new Error(marker)
  throw refusal
}

export const cas = (name: string, builder: Builder) => batch().casTree(name, statement(builder))
export const many = (builder: Builder) =>
  withCas().followOnTree('task', statement(builder), { many: 'a test' })
export const tail = (builder: Builder) => withCas().tailTree('read', statement(builder))
