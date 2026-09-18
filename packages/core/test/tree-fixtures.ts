import { type OperationNode, SqliteQueryCompiler } from 'kysely'
import {
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
} from '../src/index.js'

/** What `fenced-batch-tree.test.ts` and `fenced-batch-tree-verdicts.test.ts` both build on. */
export const CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`
export const dialect = new TreeDialect(new SqliteQueryCompiler())

export type Builder = { toOperationNode(): OperationNode }

/** A statement minted the way stores mint them, with no binds of its own. */
export const statement = (builder: Builder) => defineStatement('test', () => builder as never)({})
export const predicate = (text: string, args: SqlFragment['args'] = []) =>
  rawSql<boolean>(sqlFragment(text, args), 'predicate')
export const value = <T>(text: string, args: SqlFragment['args'] = []) =>
  rawSql<T>(sqlFragment(text, args), 'value')

export function batch(): FencedBatch {
  return new FencedBatch('b', 'seed', { now: CLOCK, tree: dialect })
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
