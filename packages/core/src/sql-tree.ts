import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  ColumnUpdateNode,
  type DatabaseConnection,
  DeleteQueryNode,
  DummyDriver,
  type Expression,
  FunctionNode,
  IdentifierNode,
  InsertQueryNode,
  Kysely,
  type OperationNode,
  OperationNodeTransformer,
  OperatorNode,
  OrNode,
  ParensNode,
  type QueryCompiler,
  type QueryId,
  RawNode,
  ReferenceNode,
  type RootOperationNode,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  TableNode,
  UnaryOperationNode,
  UpdateQueryNode,
  ValueNode,
  createQueryId,
} from 'kysely'
import { NOW, STAMP } from './engine-tokens.js'

/**
 * Engine tokens carried as value nodes whose values are these sentinel objects. A
 * check recognizes a token by identity, never by spelling, and compilation replaces
 * each one: a stamp or fence becomes a bind, and the clock becomes the batch's clock
 * expression.
 */
class EngineToken {
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

/**
 * An engine token as a builder expression. The builder treats an object as an
 * expression only when it carries `expressionType`, so a bare node source would be
 * bound as an ordinary value.
 */
function tokenExpression<T>(token: EngineToken): Expression<T> {
  const node = ValueNode.create(token)
  return {
    get expressionType(): T | undefined {
      return undefined
    },
    toOperationNode: () => node,
  }
}

/** This statement's own provenance value. */
export const stampValue = tokenExpression<string>(EngineToken.stamp)
/** The batch's clock. Legal only in a compare-and-set. */
export const nowValue = tokenExpression<number>(EngineToken.now)
/** The provenance value an earlier statement of the batch wrote. */
export function fenceValue(name: string): Expression<string> {
  return tokenExpression<string>(EngineToken.fence(name))
}

function tokenOf(node: OperationNode | undefined): EngineToken | null {
  return node !== undefined && ValueNode.is(node) && node.value instanceof EngineToken
    ? node.value
    : null
}

class CompileOnlyDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    throw new Error('statement builders only build trees: add the statement to a FencedBatch')
  }
}

/**
 * A builder that only builds trees. It never connects, and its own compiler is never
 * used: a batch compiles each tree with its store's dialect.
 */
export function compileOnlyBuilder<DB>(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new CompileOnlyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  })
}

/** A root statement node, as the query builders produce. */
export type StatementTree = RootOperationNode

/**
 * Refuse an undefined bind, at any depth, before a statement is built. The builder
 * silently drops an undefined assignment, which would send a valid statement that skips
 * a column.
 */
export function requireDefinedBinds(statement: string, binds: unknown, path = 'bind'): void {
  if (binds === undefined) {
    throw new TypeError(
      `${statement}: ${path} is undefined, so bind null explicitly if that is what you mean`,
    )
  }
  if (typeof binds !== 'object' || binds === null || binds instanceof Uint8Array) return
  for (const [name, value] of Object.entries(binds)) {
    requireDefinedBinds(statement, value, path === 'bind' ? `bind '${name}'` : `${path}.${name}`)
  }
}

/** A statement minted by `defineStatement`: its tree, and the raw booleans it declares. */
export interface DefinedStatement {
  readonly name: string
  readonly tree: StatementTree
  /** Raw fragments standing where a boolean decides which rows are read or written. */
  readonly rawBooleans: number
  /** Every other raw fragment: an assigned value, a subquery operand, an expression. */
  readonly rawValues: number
}

const definedStatements = new WeakSet<object>()

/**
 * Define a statement once for every dialect. A batch accepts only statements minted
 * here, so every tree statement's binds passed `requireDefinedBinds`, and every raw
 * fragment it carries is declared beside it, by position.
 */
export function defineStatement<Binds extends object>(
  name: string,
  shape: { readonly rawBooleans?: number; readonly rawValues?: number },
  build: (binds: Binds) => { toOperationNode(): StatementTree },
): (binds: Binds) => DefinedStatement {
  return (binds) => {
    requireDefinedBinds(name, binds)
    const statement = Object.freeze({
      name,
      tree: build(binds).toOperationNode(),
      rawBooleans: shape.rawBooleans ?? 0,
      rawValues: shape.rawValues ?? 0,
    })
    definedStatements.add(statement)
    return statement
  }
}

/** True only for a statement `defineStatement` minted. */
export function isDefinedStatement(value: unknown): value is DefinedStatement {
  return typeof value === 'object' && value !== null && definedStatements.has(value)
}

/**
 * Store-owned SQL text with its binds. In the text, `?` binds the next argument and
 * `$NOW$` is the batch clock. A dialect's fragments stay text, so one statement tree
 * serves every dialect and carries the dialect's predicates as data.
 */
export interface SqlFragment {
  readonly sql: string
  readonly args: ReadonlyArray<string | number | bigint | Uint8Array | null>
}

export function sqlFragment(sql: string, args: SqlFragment['args'] = []): SqlFragment {
  return Object.freeze({ sql, args: Object.freeze([...args]) })
}

/**
 * A fragment as a raw node whose binds and clock are nodes, not text. Each `?` becomes
 * a value node, so compiled placeholders equal bound arguments by construction, and
 * each `$NOW$` becomes the clock token, so the clock rules see it. A stamp or a fence
 * never rides in a fragment: the rules that read them need them as nodes of the tree.
 */
export function rawSql<T>(fragment: SqlFragment): Expression<T> {
  if (fragment.sql.includes(STAMP) || fragment.sql.includes('$FENCE:')) {
    throw new Error(
      'a SQL fragment may not hold a stamp or fence token: a tree carries those as nodes',
    )
  }
  const pieces: string[] = []
  const parameters: OperationNode[] = []
  let last = 0
  let bound = 0
  for (const match of fragment.sql.matchAll(/\?|\$NOW\$/g)) {
    pieces.push(fragment.sql.slice(last, match.index))
    last = match.index + match[0].length
    if (match[0] === NOW) {
      parameters.push(ValueNode.create(EngineToken.now))
    } else {
      parameters.push(ValueNode.create(fragment.args[bound]))
      bound++
    }
  }
  pieces.push(fragment.sql.slice(last))
  if (bound !== fragment.args.length) {
    throw new TypeError(`a SQL fragment binds ${bound} of its ${fragment.args.length} arguments`)
  }
  const node = RawNode.create(pieces, parameters)
  return {
    get expressionType(): T | undefined {
      return undefined
    },
    toOperationNode: () => node,
  }
}

/** The values a statement's tokens take in one batch invocation. */
export interface TokenBindings {
  /** The batch's clock expression, spliced as SQL where the clock token stands. */
  readonly now: string
  readonly stamp: string
  readonly fence: (name: string) => string
}

/** A compiled statement, with what its one tree walk saw. */
export interface CompiledTree {
  readonly sql: string
  readonly parameters: readonly unknown[]
  /** `?` placeholders in the compiled SQL. More than `parameters` means a raw fragment added one. */
  readonly placeholders: number
  /** Every fence the statement names, wherever it appears. */
  readonly fences: readonly string[]
  /** Whether the clock token appears anywhere in the statement. */
  readonly readsClock: boolean
}

class TokenBinder extends OperationNodeTransformer {
  #bindings: TokenBindings | null = null
  #fences: string[] = []
  #readsClock = false

  bind(tree: StatementTree, bindings: TokenBindings) {
    this.#bindings = bindings
    this.#fences = []
    this.#readsClock = false
    try {
      const bound = this.transformNode(tree)
      return { bound, fences: this.#fences, readsClock: this.#readsClock }
    } finally {
      this.#bindings = null
    }
  }

  override transformNode<T extends OperationNode | undefined>(node: T, queryId?: QueryId): T {
    const token = tokenOf(node)
    const bindings = this.#bindings
    if (token === null || bindings === null) return super.transformNode(node, queryId)
    if (token.kind === 'now') {
      this.#readsClock = true
      return RawNode.createWithSql(bindings.now) as unknown as T
    }
    if (token.kind === 'stamp') return ValueNode.create(bindings.stamp) as unknown as T
    const fence = token.fence as string
    this.#fences.push(fence)
    return ValueNode.create(bindings.fence(fence)) as unknown as T
  }
}

/** How one store turns a statement tree into SQL with `?` binds. */
export class TreeDialect {
  readonly #binder = new TokenBinder()

  constructor(readonly compiler: QueryCompiler) {
    Object.freeze(this)
  }

  /** Bind every engine token and compile, in one walk of the tree. */
  compile(tree: StatementTree, bindings: TokenBindings): CompiledTree {
    const { bound, fences, readsClock } = this.#binder.bind(tree, bindings)
    const compiled = this.compiler.compileQuery(bound, createQueryId())
    return {
      sql: compiled.sql,
      parameters: compiled.parameters,
      placeholders: compiled.sql.split('?').length - 1,
      fences,
      readsClock,
    }
  }
}

function unwrapParens(node: OperationNode): OperationNode {
  let current = node
  while (ParensNode.is(current)) current = current.node
  return current
}

function isNode(value: unknown): value is OperationNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}

/** Every child node. Kysely has no read-only walker, so this reads node fields generically. */
function children(node: OperationNode): OperationNode[] {
  if (ValueNode.is(node)) return []
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

function someNode(node: OperationNode, test: (node: OperationNode) => boolean): boolean {
  return test(node) || children(node).some((child) => someNode(child, test))
}

function whereOf(query: OperationNode): OperationNode | null {
  if (UpdateQueryNode.is(query) || DeleteQueryNode.is(query) || SelectQueryNode.is(query)) {
    return query.where?.where ?? null
  }
  return null
}

/** The top-level conjuncts of a WHERE clause, through parentheses and AND. */
function conjuncts(where: OperationNode): OperationNode[] {
  const node = unwrapParens(where)
  return AndNode.is(node) ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node]
}

function operatorName(node: OperationNode): string | null {
  return OperatorNode.is(node) ? node.operator : null
}

function columnName(node: OperationNode): string | null {
  return ColumnNode.is(node) ? node.column.name : null
}

function referencedColumn(node: OperationNode): string | null {
  const inner = unwrapParens(node)
  return ReferenceNode.is(inner) ? columnName(inner.column) : null
}

function tableName(node: OperationNode | undefined): string | null {
  if (node === undefined) return null
  const inner = AliasNode.is(node) ? node.node : node
  return TableNode.is(inner) ? inner.table.identifier.name : null
}

/** The names a query's own tables answer to: each alias or bare table name, to its table. */
function tableScope(query: OperationNode): Map<string, string> {
  const sources: OperationNode[] = []
  if (UpdateQueryNode.is(query) && query.table !== undefined) sources.push(query.table)
  if (DeleteQueryNode.is(query)) sources.push(...query.from.froms)
  if (SelectQueryNode.is(query)) {
    sources.push(...(query.from?.froms ?? []), ...(query.joins ?? []).map((join) => join.table))
  }
  const scope = new Map<string, string>()
  for (const source of sources) {
    const table = tableName(source)
    if (table === null) continue
    const alias =
      AliasNode.is(source) && IdentifierNode.is(source.alias) ? source.alias.name : table
    scope.set(alias, table)
  }
  return scope
}

/** A fence that gates, and the table whose `fence_stamp` it is compared with. */
export interface GatingFence {
  readonly fence: string
  readonly table: string
}

/** A conjunct that IS `fence_stamp = <fence token>`, in either orientation. */
function fenceEquality(node: OperationNode, scope: Map<string, string>): GatingFence | null {
  if (!BinaryOperationNode.is(node) || operatorName(node.operator) !== '=') return null
  for (const [column, value] of [
    [node.leftOperand, node.rightOperand],
    [node.rightOperand, node.leftOperand],
  ] as const) {
    const token = tokenOf(unwrapParens(value))
    const reference = unwrapParens(column)
    if (token?.kind !== 'fence' || token.fence === null) continue
    if (!ReferenceNode.is(reference) || columnName(reference.column) !== 'fence_stamp') continue
    // An unqualified column belongs to the query's only table. Anything else is
    // ambiguous, and an ambiguous fence gates nothing.
    const qualifier = reference.table?.table.identifier.name
    const table =
      qualifier !== undefined
        ? scope.get(qualifier)
        : scope.size === 1
          ? [...scope.values()][0]
          : undefined
    if (table !== undefined) return { fence: token.fence, table }
  }
  return null
}

/** A positive subquery a conjunct requires a row from: `EXISTS (…)` or `x IN (…)`. */
function requiredSubquery(node: OperationNode): OperationNode | null {
  if (UnaryOperationNode.is(node) && operatorName(node.operator) === 'exists') {
    return unwrapParens(node.operand)
  }
  if (BinaryOperationNode.is(node) && operatorName(node.operator) === 'in') {
    return unwrapParens(node.rightOperand)
  }
  return null
}

/**
 * The fences that gate every row a statement reads or writes. A fence gates when a
 * top-level WHERE conjunct is itself `fence_stamp = <fence>`, or requires a row from a
 * subquery whose own top-level WHERE is gated the same way. A fence joined by OR, under
 * NOT, or merely contained in a conjunct gates nothing, so it is not returned.
 *
 * This decides position, not correlation: a gated subquery that is not correlated to
 * the written row proves only that the batch won.
 */
export function gatingFences(query: OperationNode): GatingFence[] {
  const where = whereOf(query)
  if (where === null) return []
  const scope = tableScope(query)
  return conjuncts(where).flatMap((conjunct) => {
    const fence = fenceEquality(conjunct, scope)
    if (fence !== null) return [fence]
    const subquery = requiredSubquery(conjunct)
    return subquery !== null && SelectQueryNode.is(subquery) ? gatingFences(subquery) : []
  })
}

/** The column an assignment writes. The object and two-argument `set` forms differ in shape. */
function assignedColumn(update: ColumnUpdateNode): string | null {
  return referencedColumn(update.column) ?? columnName(update.column)
}

function assignments(query: OperationNode): readonly ColumnUpdateNode[] {
  return UpdateQueryNode.is(query) ? (query.updates ?? []) : []
}

function mentions(text: string, column: string): boolean {
  return new RegExp(String.raw`(?<![\w.])"?${column}"?(?!\w)`, 'i').test(text)
}

const COUNTING_OPERATORS = new Set(['+', '-', '*', '/', '%', '||'])

/**
 * Assignments that may count twice when a follow-on replays: `arithmetic` combines the
 * column it writes with an arithmetic or concatenation operator, however the operands
 * are ordered, qualified, or parenthesized, and `raw` hides that column inside a raw fragment, where the tree
 * cannot see what is done with it. A self-reference built from nodes, such as
 * `COALESCE(column, …)`, is visible and allowed.
 */
export function selfCountingAssignments(
  query: OperationNode,
): { column: string; how: 'arithmetic' | 'raw' }[] {
  return assignments(query).flatMap((update): { column: string; how: 'arithmetic' | 'raw' }[] => {
    const column = assignedColumn(update)
    if (column === null) return []
    const arithmetic = someNode(update.value, (candidate) => {
      if (!BinaryOperationNode.is(candidate)) return false
      const operator = operatorName(candidate.operator)
      if (operator === null || !COUNTING_OPERATORS.has(operator)) return false
      return (
        referencedColumn(candidate.leftOperand) === column ||
        referencedColumn(candidate.rightOperand) === column
      )
    })
    if (arithmetic) return [{ column, how: 'arithmetic' }]
    const raw = someNode(update.value, (candidate) => {
      if (!RawNode.is(candidate)) return false
      return (
        mentions(candidate.sqlFragments.join(' '), column) ||
        candidate.parameters.some((parameter) =>
          someNode(parameter, (inner) => referencedColumn(inner) === column),
        )
      )
    })
    return raw ? [{ column, how: 'raw' }] : []
  })
}

/** How many raw fragments a statement holds, wherever they stand. */
export function rawFragmentCount(tree: OperationNode): number {
  let count = 0
  someNode(tree, (candidate) => {
    if (RawNode.is(candidate)) count++
    return false
  })
  return count
}

/** Every raw fragment's text, wherever it stands. */
export function rawFragmentTexts(tree: OperationNode): string[] {
  const texts: string[] = []
  someNode(tree, (candidate) => {
    if (RawNode.is(candidate)) texts.push(candidate.sqlFragments.join(' '))
    return false
  })
  return texts
}

const CLOCK_FUNCTIONS = [
  'unixepoch',
  'julianday',
  'strftime',
  'now',
  'sysdate',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'getdate',
  'timeofday',
  'utc_timestamp',
  'utc_date',
  'utc_time',
  'localtime',
  'localtimestamp',
  'current_timestamp',
  'curdate',
  'curtime',
]

/**
 * A database clock spelled out in raw SQL text. This is a spelling list, the same one
 * `scripts/clock-lint.py` applies to store sources, because raw text is the one place a
 * tree cannot be read. The only clock a tree may hold is the clock token.
 */
export const CLOCK_SPELLING = new RegExp(
  [
    String.raw`\b(?:${CLOCK_FUNCTIONS.join('|')})\s*\(`,
    String.raw`\b(?:current_timestamp|current_time|current_date|localtime|localtimestamp|utc_timestamp|utc_date|utc_time)\b`,
    String.raw`\b(?:datetime|date|time)\s*\(\s*'now'`,
  ].join('|'),
  'i',
)

/** Clock functions called as function nodes, which no text scan of a store source sees. */
export function clockFunctionCalls(tree: OperationNode): string[] {
  const calls: string[] = []
  someNode(tree, (candidate) => {
    if (FunctionNode.is(candidate) && CLOCK_FUNCTIONS.includes(candidate.func.toLowerCase())) {
      calls.push(candidate.func)
    }
    return false
  })
  return calls
}

const QUERY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  UpdateQueryNode: ['kind', 'table', 'where', 'updates'],
  DeleteQueryNode: ['kind', 'from', 'where'],
  SelectQueryNode: [
    'kind',
    'from',
    'selections',
    'where',
    'joins',
    'groupBy',
    'having',
    'orderBy',
    'limit',
  ],
}

const GRAMMAR_NODES = new Set([
  ...Object.keys(QUERY_FIELDS),
  'AggregateFunctionNode',
  'AliasNode',
  'AndNode',
  'BinaryOperationNode',
  'CaseNode',
  'CastNode',
  'ColumnNode',
  'ColumnUpdateNode',
  'DataTypeNode',
  'FromNode',
  'FunctionNode',
  'GroupByItemNode',
  'GroupByNode',
  'HavingNode',
  'IdentifierNode',
  'JoinNode',
  'LimitNode',
  'OnNode',
  'OperatorNode',
  'OrNode',
  'OrderByItemNode',
  'OrderByNode',
  'ParensNode',
  'PrimitiveValueListNode',
  'RawNode',
  'ReferenceNode',
  'SchemableIdentifierNode',
  'SelectAllNode',
  'SelectionNode',
  'TableNode',
  'TupleNode',
  'UnaryOperationNode',
  'ValueListNode',
  'ValueNode',
  'WhenNode',
  'WhereNode',
])

/**
 * Why a tree is outside the statement grammar, or null when it is inside. The grammar
 * is closed: a node kind or query clause it does not list is refused, so a builder
 * form nobody considered cannot slip past the checks that read the tree. A statement
 * that needs a new kind adds it here, with the check that reads it.
 *
 * It lists no common table expression, RETURNING, or `UPDATE … FROM`, no write below
 * the root, and no schema-qualified table.
 */
export function statementGrammarProblem(tree: OperationNode): string | null {
  const visit = (node: OperationNode, isRoot: boolean): string | null => {
    if (!GRAMMAR_NODES.has(node.kind)) return `node kind ${node.kind}`
    if (!isRoot && (UpdateQueryNode.is(node) || DeleteQueryNode.is(node))) {
      return `${node.kind} below the root`
    }
    const fields = QUERY_FIELDS[node.kind]
    if (fields !== undefined) {
      const extra = Object.entries(node).find(
        ([field, value]) => value !== undefined && !fields.includes(field),
      )
      if (extra !== undefined) return `${node.kind}.${extra[0]}`
    }
    if (TableNode.is(node) && node.table.schema !== undefined) return 'a schema-qualified table'
    if (ColumnUpdateNode.is(node) && assignedColumn(node) === null) {
      return 'an assignment to something other than a column'
    }
    for (const child of children(node)) {
      const problem = visit(child, false)
      if (problem !== null) return problem
    }
    return null
  }
  return visit(tree, true)
}

/**
 * Raw SQL fragments standing where a boolean decides which rows are read or written: a
 * WHERE conjunct, an operand of AND, OR, or NOT beneath one, or the same inside a
 * required subquery. The escape hatch stays countable rather than invisible.
 */
export function rawBooleanFragments(query: OperationNode): number {
  const count = (node: OperationNode): number => {
    const inner = unwrapParens(node)
    if (RawNode.is(inner)) return 1
    if (AndNode.is(inner) || OrNode.is(inner)) return count(inner.left) + count(inner.right)
    const subquery = requiredSubquery(inner)
    if (subquery !== null) return SelectQueryNode.is(subquery) ? rawBooleanFragments(subquery) : 0
    return UnaryOperationNode.is(inner) ? count(inner.operand) : 0
  }
  const where = whereOf(query)
  return where === null ? 0 : count(where)
}

/** The table a statement writes: an UPDATE's table, a DELETE's first FROM, an INSERT's target. */
export function statementTable(tree: OperationNode): string | null {
  if (UpdateQueryNode.is(tree)) return tableName(tree.table)
  if (DeleteQueryNode.is(tree)) return tableName(tree.from.froms[0])
  if (InsertQueryNode.is(tree)) return tableName(tree.into)
  return null
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
  const assigned = (column: string) =>
    assignments(tree).filter((update) => assignedColumn(update) === column)
  const stamps = assigned('fence_stamp')
  const instants = assigned('fence_at_ms')
  const only = (list: readonly ColumnUpdateNode[]) => (list.length === 1 ? list[0] : undefined)
  return {
    stamp: tokenOf(only(stamps)?.value)?.kind === 'stamp',
    instant: instants.length === 1,
    clockInstant: tokenOf(only(instants)?.value)?.kind === 'now',
  }
}
