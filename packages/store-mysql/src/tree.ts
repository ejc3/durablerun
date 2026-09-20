import { TreeDialect } from '@durablerun/core'
import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
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
  ParensNode,
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

/** The name a reference is qualified by, if any, and the stored column it names. */
function referenced(reference: ReferenceNode): {
  readonly table: string | undefined
  readonly name: string | null
} {
  return {
    table: reference.table?.table.identifier.name,
    name: ColumnNode.is(reference.column) ? reference.column.column.name : null,
  }
}

/** The operator a condition names, or null for anything that is not a plain operator. */
const operatorOf = (node: OperationNode): string | null =>
  OperatorNode.is(node) ? node.operator : null

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
      const { table, name } = referenced(current)
      if (name !== null && (table === undefined || table === target)) read.add(name)
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
 * The index a keyed write reaches its table through, by table and key column.
 *
 * A keyed write is an UPDATE or DELETE whose WHERE requires `column IN (subquery)`: a
 * follow-on keyed by the rows its batch stamped, the claim keyed by its candidates, a wake
 * keyed by its waiters. To MySQL that is a join, and the server picks the order. Over a
 * small table, or when the keys are a large part of the table, it read the written table
 * FIRST, by a scan or through another index, and the write then held a lock on every row
 * it had read. Measured on MySQL 8.4, inside each batch, from
 * `performance_schema.data_locks`: the claim's update locked every run of a table of one
 * to five rows at a limit of one, and of 20, 120, and 400 rows at a limit of half the
 * table, so two claimers, each holding the run its locking leg chose, waited for each
 * other and one was rolled back. 16 of the 165 keyed writes a small database sent did not
 * take their key, and an emit held four runs to write one.
 *
 * So the keys are read FIRST, the written table SECOND, through the index of its key, and
 * whatever else the statement joins after them. The compiler puts the key source, a
 * generated selection and a store's fragment alike, in a query block of its own, named and
 * kept whole, and an optimizer hint opens the join order with that block's one table and
 * then the written table. A statement's other subqueries, which the server may turn into
 * joins, ask about the written row, so they have to come after it to be looked up by it.
 * Two looser orders were measured and lost. With the written table after EVERY table
 * (`JOIN_SUFFIX`) the emit's update reached `tasks` with no run in hand and walked the live
 * tasks of its queue, 2,009 rows beside 2,000, where this walks 9. With the keys merely
 * ahead of the written table (`JOIN_ORDER`) the server, under statistics it had not yet
 * recalculated, still read `tasks` first, and a completion walked 1,204 rows beside 2,000
 * tasks, where this walks 1. The index is an index hint, which
 * the server refuses when the index is gone. Neither is enough alone: with the index alone
 * the claim still scanned at one and two rows, and four updates of `tasks` that had gone
 * through another index became scans, and with an order alone one update still scanned
 * its table. A semijoin materialization hint, and first match switched off, each held a
 * small table and lost a limit of half the table, where the server scans the written
 * table and looks each row up in the materialized keys.
 */
const KEY_INDEXES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  runs: { run_id: 'primary', task_id: 'runs_task_attempt' },
  tasks: { task_id: 'primary' },
  waits: { run_id: 'primary' },
}

/** What a keyed write carries none of. An UPDATE has no FROM besides, and a DELETE no USING. */
const NOT_IN_A_KEYED_WRITE = [
  'with',
  'top',
  'output',
  'joins',
  'returning',
  'orderBy',
  'limit',
  'explain',
  'endModifiers',
] as const

/**
 * Every delete a tree sends on MySQL is keyed by a subquery. A DELETE reads its subquery's
 * table with shared locks, so the rule for a delete's keys (`stampedKeys`) has to reach
 * every one. A delete keyed in a way this compiler does not read, or keyed by nothing, is
 * refused, where it would otherwise be written as the server plans it.
 */
const unkeyedDelete = (target: string | null): Error =>
  new Error(
    `store-mysql: a delete of ${target ?? 'something other than one table'} is keyed by no subquery, so nothing says how its keys are read`,
  )

/** The query block a write's keys are read in, and the name the block's one table goes by. */
const KEYS = { block: 'keys', table: 'k' } as const

/** Read the keys, then the written table, then whatever else the statement joins. */
const keysFirst = (target: string): string =>
  `/*+ JOIN_PREFIX(\`${KEYS.table}\`@\`${KEYS.block}\`, \`${target}\`) */`

/** The conditions a WHERE requires together: its chain of ANDs, flattened, through any parentheses. */
function requiredConditions(node: OperationNode | undefined): readonly OperationNode[] {
  if (node === undefined) return []
  if (ParensNode.is(node)) return requiredConditions(node.node)
  return AndNode.is(node)
    ? [...requiredConditions(node.left), ...requiredConditions(node.right)]
    : [node]
}

/**
 * The column a write of `target` is keyed by, with the condition that keys it: the one
 * required `column IN (subquery)` of its WHERE, wherever it stands among the conditions. A list of values is no subquery. A
 * fragment in a subquery's place arrives bare, where a value or a predicate arrives in
 * parentheses.
 */
function keyOf(
  where: OperationNode | undefined,
  target: string,
): { readonly column: string; readonly condition: BinaryOperationNode } | null {
  const found = requiredConditions(where).flatMap((condition) => {
    if (!BinaryOperationNode.is(condition) || !ReferenceNode.is(condition.leftOperand)) return []
    const operator = operatorOf(condition.operator)
    const subquery =
      SelectQueryNode.is(condition.rightOperand) || RawNode.is(condition.rightOperand)
    if (operator !== 'in' || !subquery) return []
    const { table, name } = referenced(condition.leftOperand)
    return name !== null && (table === undefined || table === target)
      ? [{ column: name, condition }]
      : []
  })
  if (found.length > 1) {
    throw new Error(
      `store-mysql: a write of ${target} is keyed by ${found.map((key) => key.column).join(' and by ')}, and one index reaches it`,
    )
  }
  return found[0] ?? null
}

/** The index a write reaches its table through, with the condition that keys it, or null for a write no subquery keys. */
function keyIndex(
  target: string | null,
  where: OperationNode | undefined,
): { readonly index: string; readonly condition: BinaryOperationNode } | null {
  if (target === null) return null
  const key = keyOf(where, target)
  if (key === null) return null
  const index = KEY_INDEXES[target]?.[key.column]
  if (index === undefined) {
    throw new Error(
      `store-mysql: a write of ${target} keyed by ${key.column} names no index to reach it through`,
    )
  }
  return { index, condition: key.condition }
}

/**
 * The index of a table's statement stamp, for each table a keyed delete takes its keys
 * from. A DELETE reads its subquery's table with shared locks, even under READ COMMITTED,
 * where a single-table UPDATE reads it with none. Through an index of the queue and the
 * state, the search for the rows this batch stamped covers other transactions' rows, waits
 * for each one still held, and two such batches deadlock: the claim's delete of expired
 * waits did, between claimers, once `waits` held a few dozen rows. Every stamping write
 * changes the stamp, so a stamped row's entry in the stamp's index is its own
 * transaction's, and a search of that index for one batch's stamp touches no other entry.
 * It waits for nothing, so it needs no SKIP LOCKED, which was measured and not taken:
 * InnoDB skips by index record, and it skipped a row its own transaction had stamped while
 * another transaction held that row's entry in the index the keys were read through.
 */
const STAMP_INDEXES: Readonly<Record<string, string>> = { runs: 'runs_stamp' }

/** Whether a condition is `alias.fence_stamp = …`, the stamp of the table read as `alias`. */
function requiresStampOf(alias: string, condition: OperationNode): boolean {
  if (!BinaryOperationNode.is(condition) || !ReferenceNode.is(condition.leftOperand)) return false
  const operator = operatorOf(condition.operator)
  const { table, name } = referenced(condition.leftOperand)
  return operator === '=' && table === alias && name === 'fence_stamp'
}

/**
 * The table a delete of `target` takes its keys from, and the index of that table's stamp.
 * The keys are a selection of one plain table, read under an alias, that requires the
 * table's stamp: what core generates for every delete that follows a fence. A source of
 * any other shape is refused, because nothing else is known to touch this transaction's
 * rows alone. So are keys from the table the delete writes: MySQL reads that table through
 * a derived table, which takes no index hint. The rest of the selection is core's to
 * refuse. That the stamp compared is this batch's own is core's gating rule, which no
 * single statement can show.
 */
function stampedKeys(
  target: string,
  keys: OperationNode | undefined,
): { readonly from: AliasNode; readonly index: string } {
  const selection = keys !== undefined && SelectQueryNode.is(keys) ? keys : undefined
  const [from, ...more] = selection?.from?.froms ?? []
  const table = tableName(from)
  const source =
    from !== undefined && AliasNode.is(from) && IdentifierNode.is(from.alias)
      ? { from, named: from.alias.name }
      : null
  if (source === null || table === null || more.length > 0 || (selection?.joins ?? []).length > 0) {
    throw new Error(
      `store-mysql: a delete of ${target} takes its keys from something other than a selection of one table`,
    )
  }
  if (table === target) {
    throw new Error(
      `store-mysql: a delete of ${target} takes its keys from ${table}, the table it writes`,
    )
  }
  const fenced = requiredConditions(selection?.where?.where).some((condition) =>
    requiresStampOf(source.named, condition),
  )
  if (!fenced) {
    throw new Error(`store-mysql: a delete of ${target} takes its keys from ${table} unfenced`)
  }
  const through = STAMP_INDEXES[table]
  if (through === undefined) {
    throw new Error(
      `store-mysql: a delete of ${target} takes its keys from ${table}, which declares no index of its stamp`,
    )
  }
  return { from: source.from, index: through }
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
 * - A write keyed by a subquery reads its keys first and its table second, through the
 *   index of its key (`KEY_INDEXES`). A DELETE takes an index hint only in its
 *   multiple-table form, so a keyed DELETE is written in it, its keys are read through the
 *   index of their stamp (`STAMP_INDEXES`), and a delete that no subquery keys is refused.
 */
class MysqlTreeCompiler extends MysqlQueryCompiler {
  #insertTarget: TableNode | null = null
  #writeTarget: string | null = null
  #keysFrom: { readonly from: AliasNode; readonly index: string } | null = null
  #key: BinaryOperationNode | null = null

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
    if (node === this.#key) {
      // A keyed write's keys, in a block of the compiler's own, kept whole so it can be named.
      this.visitNode(node.leftOperand)
      this.append(
        ` in (select /*+ QB_NAME(\`${KEYS.block}\`) NO_MERGE(\`${KEYS.table}\`) */ * from `,
      )
      this.visitNode(node.rightOperand)
      this.append(` as \`${KEYS.table}\`)`)
      return
    }
    const operator = operatorOf(node.operator)
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
    const keyed = keyIndex(target, node.where?.where)
    this.writing(target, () => {
      if (keyed === null || target === null || node.table === undefined) {
        super.visitUpdateQuery(updates === undefined ? node : { ...node, updates })
        return
      }
      this.requireKeyedGrammar(
        [node.table],
        [node.from, ...NOT_IN_A_KEYED_WRITE.map((clause) => node[clause])],
      )
      this.append(`update ${keysFirst(target)} `)
      this.visitKeyedTarget(node.table, keyed.index)
      this.append(' set ')
      this.compileList(updates ?? [])
      this.visitKeyedWhere(node.where, keyed.condition)
    })
  }

  protected override visitDeleteQuery(node: DeleteQueryNode): void {
    const [table] = node.from.froms
    const target = tableName(table)
    const keyed = keyIndex(target, node.where?.where)
    if (keyed === null || target === null || table === undefined) throw unkeyedDelete(target)
    this.writing(target, () => {
      this.requireKeyedGrammar(node.from.froms, [
        node.using,
        ...NOT_IN_A_KEYED_WRITE.map((clause) => node[clause]),
      ])
      const keysFrom = stampedKeys(target, keyed.condition.rightOperand)
      this.append(`delete ${keysFirst(target)} `)
      this.visitNode(table)
      this.append(' from ')
      this.visitKeyedTarget(table, keyed.index)
      this.visitKeyedWhere(node.where, keyed.condition, keysFrom)
    })
  }

  /** The table a keyed delete takes its keys from is read through the index of its stamp. */
  protected override visitAlias(node: AliasNode): void {
    super.visitAlias(node)
    if (node === this.#keysFrom?.from) this.append(` force index (${this.#keysFrom.index})`)
  }

  /** A keyed write is one plain table, its assignments, and its WHERE. Anything more is refused. */
  private requireKeyedGrammar(tables: readonly OperationNode[], clauses: readonly unknown[]): void {
    const [table, ...others] = tables
    const present = (clause: unknown) =>
      clause !== undefined && !(Array.isArray(clause) && clause.length === 0)
    if (
      this.parentNode !== undefined ||
      table === undefined ||
      !TableNode.is(table) ||
      others.length > 0 ||
      clauses.some(present)
    ) {
      throw new Error('store-mysql: a keyed write outside the statement grammar')
    }
  }

  /** The written table, reached through the index of its key. */
  private visitKeyedTarget(table: OperationNode, index: string): void {
    this.visitNode(table)
    this.append(` force index (${index})`)
  }

  /** A keyed write's WHERE: its key condition is written as a block, and a delete's keys are read by their stamp. */
  private visitKeyedWhere(
    where: OperationNode | undefined,
    key: BinaryOperationNode,
    keysFrom: ReturnType<typeof stampedKeys> | null = null,
  ): void {
    if (where === undefined) throw new Error('store-mysql: a keyed write with no WHERE')
    this.#key = key
    this.#keysFrom = keysFrom
    try {
      this.append(' ')
      this.visitNode(where)
    } finally {
      this.#key = null
      this.#keysFrom = null
    }
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
