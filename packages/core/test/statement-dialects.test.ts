import {
  type BinaryOperationNode,
  ColumnNode,
  type ColumnUpdateNode,
  MysqlQueryCompiler,
  type OnConflictNode,
  type OperationNode,
  OperatorNode,
  SqliteQueryCompiler,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  type DefinedStatement,
  EventName,
  FencedBatch,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  TreeDialect,
  emitEventCas,
  registerWaitCas,
  reviveCas,
  sqlFragment,
} from '../src/index.js'

/**
 * A shared statement is a tree, and a dialect's compiler spells it. The upserts in
 * core are built with the builder's conflict clause and the standard null-safe
 * inequality, which MySQL spells differently. This compiler shows that the tree
 * carries what a MySQL spelling needs: the conflict target, the assignments, and the
 * condition. It checks spelling only. `store-mysql` proves behaviour against a real
 * server, through the conformance suite.
 */
class MysqlSpellingCompiler extends MysqlQueryCompiler {
  protected override visitOnConflict(node: OnConflictNode): void {
    this.append('on duplicate key update ')
    if (node.updates === undefined) {
      // DO NOTHING: MySQL's idiom is an assignment that changes nothing.
      const target = node.columns?.[0]
      if (target === undefined) throw new Error('a conflict clause names its columns')
      this.visitNode(target)
      this.append(' = ')
      this.visitNode(target)
      return
    }
    const condition = node.updateWhere?.where
    const read = condition === undefined ? [] : columnNames(condition)
    // MySQL assigns left to right, and a later assignment sees an earlier one's new
    // value. A column the condition reads is therefore assigned last.
    const ordered = [...node.updates].sort(
      (a, b) => Number(read.includes(assigned(a))) - Number(read.includes(assigned(b))),
    )
    ordered.forEach((update, index) => {
      if (index > 0) this.append(', ')
      this.visitNode(update.column)
      this.append(' = ')
      if (condition === undefined) {
        this.visitNode(update.value)
        return
      }
      this.append('if(')
      this.visitNode(condition)
      this.append(', ')
      this.visitNode(update.value)
      this.append(', ')
      this.visitNode(update.column)
      this.append(')')
    })
  }

  protected override visitBinaryOperation(node: BinaryOperationNode): void {
    const operator = OperatorNode.is(node.operator) ? node.operator.operator : null
    if (operator !== 'is distinct from') {
      super.visitBinaryOperation(node)
      return
    }
    this.append('not (')
    this.visitNode(node.leftOperand)
    this.append(' <=> ')
    this.visitNode(node.rightOperand)
    this.append(')')
  }
}

function assigned(update: ColumnUpdateNode): string {
  return ColumnNode.is(update.column) ? update.column.column.name : ''
}

function columnNames(node: OperationNode): string[] {
  if (ColumnNode.is(node)) return [node.column.name]
  const names: string[] = []
  for (const value of Object.values(node)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'object' && item !== null && typeof item.kind === 'string') {
        names.push(...columnNames(item as OperationNode))
      }
    }
  }
  return names
}

const emit = () =>
  emitEventCas({
    queue: 'q',
    eventName: EventName.fromPort('test', 'e'),
    payloadJson: '{}',
    existingEventAdmits: sqlFragment('events.payload IS NOT NULL'),
  })
const register = () =>
  registerWaitCas({
    queue: 'q',
    runId: 'r1',
    taskId: 't1',
    claimToken: 'tok',
    stepName: 's',
    eventName: EventName.fromPort('test', 'e'),
    timeoutAt: sqlFragment('CASE WHEN ? IS NOT NULL THEN $NOW$ + ? ELSE NULL END', [5, 5]),
    timeoutFits: sqlFragment('? IS NULL OR 1 = 1', [5]),
    taskOwnsRun: sqlFragment('t.task_id = r.task_id AND t.queue = r.queue'),
    taskEligible: sqlFragment('t.cancel_at_ms IS NULL'),
    phase: sqlFragment('NOT EXISTS (SELECT 1 FROM checkpoints sp WHERE sp.task_id = ?)', ['t1']),
  })

async function sent(dialect: TreeDialect, clock: string, name: string, cas: DefinedStatement) {
  const captured: SqlStatement[] = []
  const executor: SqlExecutor = {
    async batch(_label, statements) {
      captured.push(...statements)
      return statements.map(() => ({ rows: [], rowsAffected: 1 }) as SqlResult)
    },
  }
  await new FencedBatch('b', 'seed', { now: clock, tree: dialect }).casTree(name, cas).run(executor)
  const [statement] = captured
  if (statement === undefined) throw new Error('the batch sent nothing')
  return statement
}

describe('guards a shared statement builds from nodes', () => {
  it('revives only a failed task, whatever admission a store passes', async () => {
    const revive = reviveCas({
      queue: 'q',
      taskId: 't1',
      runId: 'r2',
      charged: sqlFragment('1'),
      admission: sqlFragment('1 = 1'),
    })
    const { sql, args } = await sent(
      new TreeDialect(new SqliteQueryCompiler()),
      `CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
      'revive',
      revive,
    )
    expect(sql).toContain('"task_id" = ? and "queue" = ? and "state" = ? and (1 = 1)')
    expect(args).toContain('failed')
  })
})

describe('one statement tree, spelled by each dialect', () => {
  const mysql = new TreeDialect(new MysqlSpellingCompiler())
  const sqlite = new TreeDialect(new SqliteQueryCompiler())
  const MYSQL_CLOCK = 'CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS SIGNED)'
  const SQLITE_CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`

  it('spells the event upsert without ON CONFLICT or IS DISTINCT FROM for MySQL', async () => {
    const { sql, args } = await sent(mysql, MYSQL_CLOCK, 'event', emit())
    expect(sql).not.toMatch(/on conflict|is distinct from/i)
    expect(sql).toContain('on duplicate key update ')
    expect(sql).toContain('not (`events`.`fence_stamp` <=> ?)')
    // The condition reads fence_stamp, so the stamp is assigned after the instant.
    expect(sql.indexOf('`fence_at_ms` = if(')).toBeGreaterThan(-1)
    expect(sql.indexOf('`fence_stamp` = if(')).toBeGreaterThan(sql.indexOf('`fence_at_ms` = if('))
    expect(sql.split('?').length - 1).toBe(args?.length)
  })

  it('spells the wait registration, whose conflict does nothing, for MySQL', async () => {
    const { sql, args } = await sent(mysql, MYSQL_CLOCK, 'register', register())
    expect(sql).not.toMatch(/on conflict/i)
    expect(sql).toContain('on duplicate key update `run_id` = `run_id`')
    expect(sql.split('?').length - 1).toBe(args?.length)
  })

  it('takes the spelling from the compiler: the same trees say ON CONFLICT on SQLite', async () => {
    expect((await sent(sqlite, SQLITE_CLOCK, 'event', emit())).sql).toContain(
      'on conflict ("queue", "event_name") do update set',
    )
    expect((await sent(sqlite, SQLITE_CLOCK, 'register', register())).sql).toContain(
      'on conflict ("run_id", "step_name") do nothing',
    )
  })
})
