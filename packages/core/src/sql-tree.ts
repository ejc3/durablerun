import {
  type BinaryOperationNode,
  type ColumnNode,
  type ColumnUpdateNode,
  type Expression,
  type OperationNode,
  OperationNodeTransformer,
  type OperatorNode,
  type QueryCompiler,
  type QueryId,
  RawNode,
  type ReferenceNode,
  type RootOperationNode,
  type ValueNode,
  ValueNode as ValueNodeFactory,
  createQueryId,
} from 'kysely'

/**
 * Engine tokens carried as value nodes whose values are these sentinel objects.
 * A check recognizes a token by identity, never by spelling, and the batch compiler
 * replaces each one: a stamp or fence becomes a bind, and the clock becomes the
 * dialect's clock expression.
 */
export class EngineToken {
  private constructor(
    readonly kind: 'stamp' | 'now' | 'fence',
    readonly fence: string | null,
  ) {
    Object.freeze(this)
  }
  static readonly stamp = new EngineToken('stamp', null)
  static readonly now = new EngineToken('now', null)
  static fence(name: string): EngineToken {
    return new EngineToken('fence', name)
  }
}

/** The stamp, clock, and fence tokens as builder values. */
export const stampValue: Expression<string> = {
  get expressionType(): string | undefined {
    return undefined
  },
  toOperationNode: () => tokenNode(EngineToken.stamp),
}
export const nowValue: Expression<number> = {
  get expressionType(): number | undefined {
    return undefined
  },
  toOperationNode: () => tokenNode(EngineToken.now),
}
export function fenceValue(name: string): Expression<string> {
  return tokenExpression<string>(EngineToken.fence(name))
}

/** A value node for an engine token. */
export function tokenNode(token: EngineToken): ValueNode {
  return ValueNodeFactory.create(token)
}

/**
 * An engine token as a query builder expression. The builder treats an object as an
 * expression only when it carries `expressionType`, so a bare node source would be
 * bound as an ordinary value.
 */
export function tokenExpression<T>(token: EngineToken): Expression<T> {
  return {
    get expressionType(): T | undefined {
      return undefined
    },
    toOperationNode: () => tokenNode(token),
  }
}

function tokenOf(node: OperationNode | undefined): EngineToken | null {
  return node?.kind === 'ValueNode' && (node as ValueNode).value instanceof EngineToken
    ? ((node as ValueNode).value as EngineToken)
    : null
}

function unwrapParens(node: OperationNode): OperationNode {
  let current = node
  while (current.kind === 'ParensNode')
    current = (current as unknown as { node: OperationNode }).node
  return current
}

/** Every child node, in no particular order. */
function children(node: OperationNode): OperationNode[] {
  const out: OperationNode[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item)
    } else if (isNode(value)) {
      out.push(value)
    }
  }
  return out
}

function isNode(value: unknown): value is OperationNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}

function someNode(node: OperationNode, test: (node: OperationNode) => boolean): boolean {
  if (test(node)) return true
  return children(node).some((child) => someNode(child, test))
}

function whereOf(query: OperationNode): OperationNode | null {
  const where = (query as { where?: { where: OperationNode } }).where
  return where === undefined ? null : where.where
}

/** The top-level conjuncts of a WHERE clause, through parentheses and AND. */
export function conjuncts(where: OperationNode): OperationNode[] {
  const node = unwrapParens(where)
  if (node.kind === 'AndNode') {
    const and = node as unknown as { left: OperationNode; right: OperationNode }
    return [...conjuncts(and.left), ...conjuncts(and.right)]
  }
  return [node]
}

function operatorName(node: OperationNode): string | null {
  return node.kind === 'OperatorNode' ? (node as OperatorNode).operator : null
}

function columnName(node: OperationNode): string | null {
  return node.kind === 'ColumnNode' ? (node as ColumnNode).column.name : null
}

function referencedColumn(node: OperationNode): string | null {
  const inner = unwrapParens(node)
  if (inner.kind !== 'ReferenceNode') return null
  return columnName((inner as ReferenceNode).column)
}

/** A conjunct that IS `fence_stamp = <fence token>`, in either orientation. */
function fenceEquality(node: OperationNode): string | null {
  const inner = unwrapParens(node)
  if (inner.kind !== 'BinaryOperationNode') return null
  const binary = inner as BinaryOperationNode
  if (operatorName(binary.operator) !== '=') return null
  for (const [column, value] of [
    [binary.leftOperand, binary.rightOperand],
    [binary.rightOperand, binary.leftOperand],
  ] as const) {
    const token = tokenOf(unwrapParens(value))
    if (referencedColumn(column) === 'fence_stamp' && token?.kind === 'fence') return token.fence
  }
  return null
}

/**
 * The fences that gate every row a statement writes: top-level WHERE conjuncts that
 * are themselves a fence equality. A fence joined by OR, under NOT, or merely
 * contained in a conjunct gates nothing, so it is not returned.
 */
export function gatingFences(query: OperationNode): string[] {
  const where = whereOf(query)
  if (where === null) return []
  return conjuncts(where).flatMap((conjunct) => {
    const fence = fenceEquality(conjunct)
    return fence === null ? [] : [fence]
  })
}

/** Whether a statement reads the batch clock anywhere in its tree. */
export function readsClock(node: OperationNode): boolean {
  return someNode(node, (candidate) => tokenOf(candidate)?.kind === 'now')
}

/** Every fence token a statement names, wherever it appears. */
export function namedFences(node: OperationNode): string[] {
  const names: string[] = []
  someNode(node, (candidate) => {
    const token = tokenOf(candidate)
    if (token?.kind === 'fence' && token.fence !== null) names.push(token.fence)
    return false
  })
  return names
}

/**
 * Assignments whose value adds to or subtracts from the column it writes, however the
 * operands are ordered, qualified, or parenthesized. Replaying such a follow-on counts
 * twice.
 */
export function blindCounters(query: OperationNode): string[] {
  const updates = (query as { updates?: readonly ColumnUpdateNode[] }).updates ?? []
  return updates.flatMap((update) => {
    const column = columnName(update.column)
    if (column === null) return []
    const blind = someNode(update.value, (candidate) => {
      if (candidate.kind !== 'BinaryOperationNode') return false
      const binary = candidate as BinaryOperationNode
      const operator = operatorName(binary.operator)
      if (operator !== '+' && operator !== '-') return false
      return (
        referencedColumn(binary.leftOperand) === column ||
        (operator === '+' && referencedColumn(binary.rightOperand) === column)
      )
    })
    return blind ? [column] : []
  })
}

/**
 * Raw SQL fragments standing where a boolean decides which rows are written: a WHERE
 * conjunct, or an operand of AND, OR, or NOT beneath one. The escape hatch stays
 * countable rather than invisible.
 */
export function rawBooleanFragments(query: OperationNode): number {
  const where = whereOf(query)
  if (where === null) return 0
  const count = (node: OperationNode): number => {
    const inner = unwrapParens(node)
    switch (inner.kind) {
      case 'RawNode':
        return 1
      case 'AndNode':
      case 'OrNode': {
        const pair = inner as unknown as { left: OperationNode; right: OperationNode }
        return count(pair.left) + count(pair.right)
      }
      case 'UnaryOperationNode':
        return count((inner as unknown as { operand: OperationNode }).operand)
      default:
        return 0
    }
  }
  return count(where)
}

/** How one dialect turns a statement tree into SQL with `?` binds. */
export interface TreeDialect {
  readonly compiler: QueryCompiler
  /** The dialect's database clock expression, spliced where the clock token stands. */
  readonly now: string
}

/** The values a statement's tokens take in one batch invocation. */
export interface TokenBindings {
  readonly stamp: string
  readonly fence: (name: string) => string
}

class TokenBinder extends OperationNodeTransformer {
  constructor(
    private readonly dialect: TreeDialect,
    private readonly bindings: TokenBindings,
  ) {
    super()
  }

  override transformNode<T extends OperationNode | undefined>(node: T, queryId?: QueryId): T {
    const token = tokenOf(node)
    if (token === null) return super.transformNode(node, queryId)
    const replacement =
      token.kind === 'now'
        ? RawNode.createWithSql(this.dialect.now)
        : ValueNodeFactory.create(
            token.kind === 'stamp'
              ? this.bindings.stamp
              : this.bindings.fence(token.fence as string),
          )
    return replacement as unknown as T
  }
}

/** A root statement node, as the query builders produce. */
export type StatementTree = RootOperationNode

/** Compile a statement tree to dialect SQL, binding every engine token. */
export function compileTree(
  dialect: TreeDialect,
  tree: StatementTree,
  bindings: TokenBindings,
): { sql: string; parameters: readonly unknown[] } {
  const bound = new TokenBinder(dialect, bindings).transformNode(tree)
  const compiled = dialect.compiler.compileQuery(bound, createQueryId())
  return { sql: compiled.sql, parameters: compiled.parameters }
}

function tableName(node: OperationNode | undefined): string | null {
  if (node === undefined) return null
  const inner = node.kind === 'AliasNode' ? (node as unknown as { node: OperationNode }).node : node
  if (inner.kind !== 'TableNode') return null
  return (inner as unknown as { table: { identifier: { name: string } } }).table.identifier.name
}

/** The table a statement writes: an UPDATE's table, a DELETE's first FROM, an INSERT's target. */
export function statementTable(tree: OperationNode): string | null {
  switch (tree.kind) {
    case 'UpdateQueryNode':
      return tableName((tree as unknown as { table?: OperationNode }).table)
    case 'DeleteQueryNode':
      return tableName(
        (tree as unknown as { from: { froms: readonly OperationNode[] } }).from.froms[0],
      )
    case 'InsertQueryNode':
      return tableName((tree as unknown as { into?: OperationNode }).into)
    default:
      return null
  }
}

/**
 * Which provenance assignments an UPDATE makes: `fence_stamp` to the stamp token, and
 * `fence_at_ms` to anything or, for a compare-and-set, to the clock token. Each counts
 * only when the column is assigned exactly once.
 */
export function writesStampAssignments(tree: OperationNode): {
  stamp: boolean
  instant: boolean
  clockInstant: boolean
} {
  const updates = (tree as { updates?: readonly ColumnUpdateNode[] }).updates ?? []
  const assigned = (column: string) =>
    updates.filter((update) => columnName(update.column) === column)
  const stamps = assigned('fence_stamp')
  const instants = assigned('fence_at_ms')
  const only = (list: readonly ColumnUpdateNode[]) => (list.length === 1 ? list[0] : undefined)
  return {
    stamp: tokenOf(only(stamps)?.value)?.kind === 'stamp',
    instant: instants.length === 1,
    clockInstant: tokenOf(only(instants)?.value)?.kind === 'now',
  }
}
