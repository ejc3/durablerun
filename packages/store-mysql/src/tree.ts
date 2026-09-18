import { TreeDialect } from '@durablerun/core'
import {
  AliasNode,
  type BinaryOperationNode,
  type ColumnUpdateNode,
  type DeleteQueryNode,
  FromNode,
  IdentifierNode,
  type InsertQueryNode,
  JoinNode,
  MysqlQueryCompiler,
  type OnConflictNode,
  type OperationNode,
  OperatorNode,
  RawNode,
  ReferenceNode,
  SelectQueryNode,
  TableNode,
  type UpdateQueryNode,
} from 'kysely'

/** The name a conflict arm reads the incoming row by, as PostgreSQL and SQLite spell it. */
const INCOMING = 'excluded'

function tableName(node: OperationNode | undefined): string | null {
  const inner = node !== undefined && AliasNode.is(node) ? node.node : node
  return inner !== undefined && TableNode.is(inner) ? inner.table.identifier.name : null
}

function assignedColumn(update: ColumnUpdateNode): string {
  const column = ReferenceNode.is(update.column) ? update.column.column : update.column
  const name = (column as { column?: { name?: unknown } }).column?.name
  if (typeof name !== 'string') throw new Error('a conflict arm assigns named columns')
  return name
}

function childNodes(node: OperationNode): OperationNode[] {
  const out: OperationNode[] = []
  for (const value of Object.values(node)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'object' && item !== null && typeof item.kind === 'string') {
        out.push(item as OperationNode)
      }
    }
  }
  return out
}

/**
 * The columns of the row already stored that `node` reads: a reference with no table, or
 * one qualified by the written table. A reference to the incoming row reads nothing the
 * arm assigns. A fragment is text, so it answers for every assigned column it spells.
 */
function storedColumnsRead(node: OperationNode, target: string, assigned: readonly string[]) {
  const read = new Set<string>()
  const walk = (current: OperationNode): void => {
    if (ReferenceNode.is(current)) {
      const table = current.table?.table.identifier.name
      const name = (current.column as { column?: { name?: unknown } }).column?.name
      if (typeof name === 'string' && (table === undefined || table === target)) read.add(name)
      return
    }
    if (RawNode.is(current)) {
      // A column qualified by another name reads another source, as `f.state` does in a
      // subquery over `runs f`. Unqualified, or qualified by the written table, it reads
      // the stored row.
      const text = current.sqlFragments.join(' ')
      for (const column of assigned) {
        const mention = new RegExp(
          `(?:([A-Za-z_][A-Za-z0-9_]*)\\.)?(?<![A-Za-z0-9_])${column}(?![A-Za-z0-9_])`,
          'g',
        )
        for (const match of text.matchAll(mention)) {
          if (match[1] === undefined || match[1] === target) read.add(column)
        }
      }
    }
    for (const child of childNodes(current)) walk(child)
  }
  walk(node)
  return read
}

/**
 * Order a SET list so an assignment that reads a stored column comes before the
 * assignment that writes it. A column's own assignment may read it: MySQL evaluates the
 * value before it assigns. The order is otherwise the tree's, so the compiled text is
 * stable.
 */
function readersBeforeWriters(
  updates: readonly ColumnUpdateNode[],
  target: string,
): readonly ColumnUpdateNode[] {
  const assigned = updates.map(assignedColumn)
  const reads = updates.map((update, index) => {
    const read = storedColumnsRead(update.value, target, assigned)
    read.delete(assigned[index] as string)
    return read
  })
  const remaining = updates.map((_, index) => index)
  const ordered: ColumnUpdateNode[] = []
  while (remaining.length > 0) {
    // Ready: no assignment still waiting reads the column this one writes.
    const ready = remaining.find((candidate) =>
      remaining.every(
        (other) => other === candidate || !reads[other]?.has(assigned[candidate] as string),
      ),
    )
    if (ready === undefined) {
      throw new Error(
        `store-mysql: the assignments of ${remaining
          .map((index) => assigned[index])
          .join(', ')} read one another, and MySQL assigns left to right`,
      )
    }
    ordered.push(updates[ready] as ColumnUpdateNode)
    remaining.splice(remaining.indexOf(ready), 1)
  }
  return ordered
}

/**
 * MySQL's spelling of a shared statement tree.
 *
 * - An upsert is `ON DUPLICATE KEY UPDATE`. It has no conflict target, no WHERE, and no
 *   DO NOTHING, so the conflict condition moves into each assignment as `IF(condition,
 *   value, column)` and DO NOTHING assigns a key column to itself. MySQL assigns left to
 *   right and a later assignment sees an earlier one's new value, so a column the
 *   condition reads is assigned last, and an order that would still read a new value is
 *   refused.
 * - The incoming row is named `excluded`, as a row alias of VALUES or as the derived
 *   table an INSERT … SELECT reads from.
 * - The null-safe comparisons are `<=>`.
 * - A single-table UPDATE assigns left to right too, and a later assignment reads an
 *   earlier one's new value, where the standard and the other dialects read the row as
 *   it was. `SET n = n + 1, due = f(n)` would compute `due` from the new `n`. The SET
 *   list is therefore reordered so every assignment that reads a column comes before the
 *   one that writes it, and a cycle is refused.
 * - MySQL refuses a subquery that reads the table its statement writes (error 1093)
 *   unless the read goes through a derived table. A self-read built from nodes is
 *   wrapped in one here. A store fragment wraps its own.
 */
class MysqlTreeCompiler extends MysqlQueryCompiler {
  #insertTarget: TableNode | null = null
  #writeTarget: string | null = null

  protected override visitInsertQuery(node: InsertQueryNode): void {
    if (node.onConflict === undefined) {
      super.visitInsertQuery(node)
      return
    }
    if (
      this.parentNode !== undefined ||
      node.into === undefined ||
      node.columns === undefined ||
      node.values === undefined ||
      node.with !== undefined ||
      node.replace === true ||
      node.orAction !== undefined ||
      node.top !== undefined ||
      node.output !== undefined ||
      node.defaultValues === true ||
      node.onDuplicateKey !== undefined ||
      node.returning !== undefined ||
      (node.endModifiers?.length ?? 0) > 0
    ) {
      throw new Error('store-mysql: an upsert outside the statement grammar')
    }
    const previous = this.#insertTarget
    this.#insertTarget = node.into
    try {
      this.append('insert into ')
      this.visitNode(node.into)
      this.append(' (')
      this.compileList(node.columns)
      this.append(') ')
      if (SelectQueryNode.is(node.values)) {
        this.requireSelectionsNamedAsColumns(node, node.values)
        this.append('select * from (')
        this.visitNode(node.values)
        this.append(`) as \`${INCOMING}\``)
      } else {
        this.visitNode(node.values)
        this.append(` as \`${INCOMING}\``)
      }
      this.append(' ')
      this.visitNode(node.onConflict)
    } finally {
      this.#insertTarget = previous
    }
  }

  /** `excluded.column` resolves by name, so each selection carries its column's name. */
  private requireSelectionsNamedAsColumns(insert: InsertQueryNode, select: SelectQueryNode): void {
    const columns = (insert.columns ?? []).map((column) => column.column.name)
    const selections = select.selections ?? []
    const named = selections.map(({ selection }) =>
      AliasNode.is(selection) && IdentifierNode.is(selection.alias) ? selection.alias.name : null,
    )
    if (columns.length !== named.length || columns.some((column, i) => column !== named[i])) {
      throw new Error(
        'store-mysql: an upsert that selects its row must alias each selection as its column',
      )
    }
  }

  protected override visitOnConflict(node: OnConflictNode): void {
    const into = this.#insertTarget
    const target = tableName(into ?? undefined)
    if (into === null || target === null)
      throw new Error('store-mysql: a conflict clause with no insert')
    if (
      node.columns === undefined ||
      node.constraint !== undefined ||
      node.indexExpression !== undefined
    ) {
      throw new Error('store-mysql: a conflict clause names its columns')
    }
    // `node.indexWhere` names a partial unique index. MySQL has none. Its unique indexes
    // already hold NULL keys apart, which is the one partial index the schema needs.
    this.append('on duplicate key update ')
    const stored = (column: OperationNode): void => {
      this.visitNode(into)
      this.append('.')
      this.visitNode(column)
    }
    if (node.updates === undefined) {
      const key = node.columns[0]
      if (key === undefined) throw new Error('store-mysql: a conflict clause names its columns')
      this.visitNode(key)
      this.append(' = ')
      stored(key)
      return
    }
    const condition = node.updateWhere?.where
    const assigned = node.updates.map(assignedColumn)
    const conditionReads =
      condition === undefined ? new Set<string>() : storedColumnsRead(condition, target, assigned)
    const ordered = [...node.updates].sort(
      (a, b) =>
        Number(conditionReads.has(assignedColumn(a))) -
        Number(conditionReads.has(assignedColumn(b))),
    )
    const written: string[] = []
    for (const update of ordered) {
      const reads = new Set([
        ...conditionReads,
        ...storedColumnsRead(update.value, target, assigned),
      ])
      const stale = written.find((column) => reads.has(column))
      if (stale !== undefined) {
        throw new Error(
          `store-mysql: the conflict arm would read ${stale} after assigning it, and MySQL assigns left to right`,
        )
      }
      written.push(assignedColumn(update))
    }
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
      stored(update.column)
      this.append(')')
    })
  }

  protected override visitBinaryOperation(node: BinaryOperationNode): void {
    const operator = OperatorNode.is(node.operator) ? node.operator.operator : null
    if (operator !== 'is distinct from' && operator !== 'is not distinct from') {
      super.visitBinaryOperation(node)
      return
    }
    if (operator === 'is distinct from') this.append('not (')
    this.visitNode(node.leftOperand)
    this.append(' <=> ')
    this.visitNode(node.rightOperand)
    if (operator === 'is distinct from') this.append(')')
  }

  protected override visitUpdateQuery(node: UpdateQueryNode): void {
    const target = tableName(node.table)
    const updates =
      target === null || node.updates === undefined
        ? node.updates
        : readersBeforeWriters(node.updates, target)
    this.writing(target, () =>
      super.visitUpdateQuery(updates === undefined ? node : { ...node, updates }),
    )
  }

  protected override visitDeleteQuery(node: DeleteQueryNode): void {
    this.writing(tableName(node.from.froms[0]), () => super.visitDeleteQuery(node))
  }

  private writing(target: string | null, visit: () => void): void {
    const previous = this.#writeTarget
    this.#writeTarget = target
    try {
      visit()
    } finally {
      this.#writeTarget = previous
    }
  }

  protected override visitTable(node: TableNode): void {
    if (!this.readsWrittenTable(node)) {
      super.visitTable(node)
      return
    }
    if (this.parentNode === undefined || !AliasNode.is(this.parentNode)) {
      throw new Error(
        `store-mysql: a subquery reads ${node.table.identifier.name}, the table its statement writes, with no alias to read it through`,
      )
    }
    this.append('(select * from ')
    super.visitTable(node)
    this.append(')')
  }

  /**
   * True for the written table named as a source of a subquery, which MySQL refuses. A
   * source already inside a derived table that cannot be merged is left alone: DISTINCT
   * or LIMIT makes MySQL materialize it.
   */
  private readsWrittenTable(node: TableNode): boolean {
    if (this.#writeTarget === null || node.table.identifier.name !== this.#writeTarget) return false
    const stack = this.nodeStack
    const parent = stack[stack.length - 2]
    const holder = parent !== undefined && AliasNode.is(parent) ? stack[stack.length - 3] : parent
    if (holder === undefined || !(FromNode.is(holder) || JoinNode.is(holder))) return false
    for (let index = stack.length - 1; index >= 0; index--) {
      const candidate = stack[index]
      if (candidate === undefined || !SelectQueryNode.is(candidate)) continue
      const above = stack[index - 1]
      const derived = above !== undefined && AliasNode.is(above)
      const materialized =
        candidate.limit !== undefined ||
        (candidate.frontModifiers ?? []).some(
          (modifier) => (modifier as { modifier?: unknown }).modifier === 'Distinct',
        )
      return !(derived && materialized)
    }
    // No enclosing SELECT: this is the statement's own table.
    return false
  }
}

/** How MySQL compiles a statement tree. Kysely is a compiler here, never a client. */
export const TREE_DIALECT = new TreeDialect(new MysqlTreeCompiler())
