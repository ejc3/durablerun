import {
  AliasNode,
  type AliasedExpression,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  ColumnUpdateNode,
  type DatabaseConnection,
  DeleteQueryNode,
  DummyDriver,
  type Expression,
  FunctionNode,
  HavingNode,
  IdentifierNode,
  InsertQueryNode,
  Kysely,
  OnNode,
  type OperationNode,
  OperationNodeTransformer,
  OperatorNode,
  OrNode,
  OrderByItemNode,
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
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhenNode,
  WhereNode,
  createQueryId,
} from 'kysely'
import { FENCE_PREFIX, NOW, STAMP } from './engine-tokens.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlStatement } from './primitives.js'

// Task code shares this process and may replace a global such as `Map` while a pass
// runs. What these checks keep across calls lives in collections captured at module
// load, and nothing here constructs an ambient collection at call time. The checks on
// a statement's binds go further: they call captured operations and read own properties
// only, because they decide whether a store's admission reaches the statement.
const {
  ArrayBufferIsView: arrayBufferIsView,
  ObjectCreate: objectCreate,
  ObjectKeys: objectKeys,
  ReflectGet: reflectGet,
  WeakSet: TrustedWeakSet,
  WeakSetAdd: weakSetAdd,
  WeakSetHas: weakSetHas,
} = TASK_INTRINSICS

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
 * A node as a builder expression. The builder treats an object as an expression only
 * when it carries `expressionType`, so a bare node source would be bound as an ordinary
 * value.
 */
function nodeExpression<T>(node: OperationNode): Expression<T> {
  return {
    get expressionType(): T | undefined {
      return undefined
    },
    toOperationNode: () => node,
  }
}

/** This statement's own provenance value. */
export const stampValue = nodeExpression<string>(ValueNode.create(EngineToken.stamp))
/** The batch's clock. Legal only in a compare-and-set. */
export const nowValue = nodeExpression<number>(ValueNode.create(EngineToken.now))
/** The provenance value an earlier statement of the batch wrote. */
export function fenceValue(name: string): Expression<string> {
  return nodeExpression<string>(ValueNode.create(EngineToken.fence(name)))
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
 * Visit a bind and everything below it. `visit` returns true to stop the descent into a
 * value. Bytes are one value, never a list of indexes.
 */
function walkBinds(
  value: unknown,
  path: string,
  visit: (value: unknown, path: string) => boolean,
): void {
  if (visit(value, path)) return
  if (typeof value !== 'object' || value === null || arrayBufferIsView(value)) return
  const names = objectKeys(value)
  for (let at = 0; at < names.length; at += 1) {
    const name = names[at] as string
    walkBinds(
      reflectGet(value, name),
      path === 'bind' ? `bind '${name}'` : `${path}.${name}`,
      visit,
    )
  }
}

/**
 * Refuse an undefined bind, at any depth, before a statement is built. The builder
 * silently drops an undefined assignment, which would send a valid statement that skips
 * a column.
 */
export function requireDefinedBinds(statement: string, binds: unknown, path = 'bind'): void {
  walkBinds(binds, path, (value, at) => {
    if (value === undefined) {
      throw new TypeError(
        `${statement}: ${at} is undefined, so bind null explicitly if that is what you mean`,
      )
    }
    return false
  })
}

/** A statement minted by `defineStatement`. */
export interface DefinedStatement {
  readonly name: string
  readonly tree: StatementTree
}

const definedStatements = new TrustedWeakSet<object>()

/**
 * Define a statement once for every dialect. A batch accepts only statements minted
 * here, so every tree statement's binds passed `requireDefinedBinds`.
 */
export function defineStatement<Binds extends Readonly<Record<string, unknown>>>(
  name: string,
  build: (binds: Binds) => { toOperationNode(): StatementTree },
): (binds: Binds) => DefinedStatement {
  return (binds) => {
    requireDefinedBinds(name, binds)
    const outer = placements
    const placed: Placements = { head: null }
    placements = placed
    let tree: StatementTree
    try {
      tree = build(binds).toOperationNode()
    } finally {
      placements = outer
    }
    requirePlacedFragments(name, binds, placed)
    const statement = Object.freeze({ name, tree })
    weakSetAdd(definedStatements, statement)
    return statement
  }
}

/** True only for a statement `defineStatement` minted. */
export function isDefinedStatement(value: unknown): value is DefinedStatement {
  return typeof value === 'object' && value !== null && weakSetHas(definedStatements, value)
}

/**
 * Store-owned SQL text with its binds. In the text, `?` binds the next argument and
 * `$NOW$` is the batch clock. A dialect's fragments stay text, so one statement tree
 * serves every dialect and carries the dialect's predicates as data.
 */
export interface SqlFragment {
  readonly sql: string
  readonly args: SqlStatement['args']
}

const knownFragments = new TrustedWeakSet<object>()

/**
 * The fragments `rawSql` has placed during the statement build in progress, one entry
 * for each placement, or null outside a build. Placement is scoped to one build, so a
 * fragment another statement placed does not count here. The entries are a linked list
 * of own properties, which no replaced array method can reach.
 */
type Placement = { fragment: object | null; next: Placement | null }
type Placements = { head: Placement | null }
let placements: Placements | null = null

export function sqlFragment(sql: string, args: SqlFragment['args'] = []): SqlFragment {
  const fragment = Object.freeze({ sql, args: Object.freeze([...args]) })
  weakSetAdd(knownFragments, fragment)
  return fragment
}

/**
 * Refuse a fragment bind the statement took and never placed, at any depth. Each bind
 * that holds a fragment consumes one placement of it, so one object passed as two binds
 * needs two placements, and a bind placed twice is fine.
 */
function requirePlacedFragments(statement: string, binds: unknown, placed: Placements): void {
  walkBinds(binds, 'bind', (value, at) => {
    if (typeof value !== 'object' || value === null || !weakSetHas(knownFragments, value)) {
      return false
    }
    let placement = placed.head
    while (placement !== null && placement.fragment !== value) placement = placement.next
    if (placement === null) {
      throw new Error(`${statement}: ${at} is a fragment the statement never places`)
    }
    placement.fragment = null
    return true
  })
}

/**
 * Where a fragment stands, declared where it is placed and checked against the tree:
 * a `predicate` is a boolean that decides which rows are read or written, a `subquery`
 * is the operand a row must be IN, and a `value` is anything else, such as an assigned
 * value or an operand of an expression.
 */
export type RawRole = 'predicate' | 'subquery' | 'value'

const RAW_ROLES = ['predicate', 'subquery', 'value'] as const satisfies readonly RawRole[]
const mintedRaws: Readonly<Record<RawRole, WeakSet<object>>> = {
  predicate: new TrustedWeakSet<object>(),
  subquery: new TrustedWeakSet<object>(),
  value: new TrustedWeakSet<object>(),
}

function mintedRole(node: object): RawRole | undefined {
  return RAW_ROLES.find((role) => weakSetHas(mintedRaws[role], node))
}

/** A fragment's text read once: its literals' contents, and everything outside them. */
function readFragment(sql: string): { literals: string[]; outside: string; prefixed: boolean } {
  const literals: string[] = []
  let outside = ''
  let prefixed = false
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") {
      outside += sql[i]
      continue
    }
    // `E'…'`, `N'…'`, `X'…'`, and `U&'…'` are string forms with their own escape rules.
    if (/[A-Za-z&]/.test(sql[i - 1] ?? '')) prefixed = true
    let literal = ''
    for (i++; i < sql.length; i++) {
      if (sql[i] !== "'") literal += sql[i]
      else if (sql[i + 1] === "'") literal += sql[++i]
      else break
    }
    literals.push(literal)
    outside += "''"
  }
  return { literals, outside, prefixed }
}

/** Whether the text outside literals is one parenthesized group: its first `(` closes at its end. */
function isOneGroup(outside: string): boolean {
  const text = outside.trim()
  if (!text.startsWith('(')) return false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return i === text.length - 1
    }
  }
  return false
}

interface ParsedFragment {
  readonly pieces: readonly string[]
  readonly tokens: readonly ('bind' | 'now')[]
}

const FRAGMENT_TOKEN = new RegExp(String.raw`\?|${NOW.replaceAll('$', String.raw`\$`)}`, 'g')

/**
 * Validate a fragment's text for its role and split it at its binds and clock tokens.
 * The text is split without reading SQL beyond plain single-quoted literals, so anything
 * that would hide a token from that reading is refused: a comment, a dollar-quoted or
 * prefixed string, and a token inside a literal.
 */
function parseFragment(sql: string, role: RawRole): ParsedFragment {
  if (sql.includes(STAMP) || sql.includes(FENCE_PREFIX)) {
    throw new Error(
      'a SQL fragment may not hold a stamp or fence token: a tree carries those as nodes',
    )
  }
  const { literals, outside, prefixed } = readFragment(sql)
  if (outside.includes('--') || outside.includes('/*')) {
    throw new Error('a SQL fragment may not hold a comment: its text is split without reading SQL')
  }
  if (prefixed || /\$\w*\$/.test(outside.replaceAll(NOW, ''))) {
    throw new Error(
      'a SQL fragment may use only plain single-quoted literals: its text is split without reading SQL',
    )
  }
  if (literals.some((literal) => literal.includes('?') || literal.includes(NOW))) {
    throw new Error(
      'a SQL fragment may not hold a bind or the clock token inside a string literal: its text is split without reading SQL',
    )
  }
  if (role === 'subquery' && !isOneGroup(outside)) {
    throw new Error('a subquery fragment must be one parenthesized group')
  }
  const pieces: string[] = []
  const tokens: ('bind' | 'now')[] = []
  let last = 0
  for (const match of sql.matchAll(FRAGMENT_TOKEN)) {
    pieces.push(sql.slice(last, match.index))
    last = match.index + match[0].length
    tokens.push(match[0] === NOW ? 'now' : 'bind')
  }
  pieces.push(sql.slice(last))
  return { pieces, tokens }
}

// Store fragments are static text built on every call, so a fragment is validated and
// split once per role and text. The cap bounds the cache if a caller ever builds text
// from run-time values.
const PARSED_FRAGMENT_CAP = 512
const parsedFragments: Record<string, ParsedFragment> = objectCreate(null)
let parsedFragmentCount = 0

function parsedFragment(sql: string, role: RawRole): ParsedFragment {
  const key = `${role}:${sql}`
  const cached = parsedFragments[key]
  if (cached !== undefined) return cached
  const parsed = parseFragment(sql, role)
  if (parsedFragmentCount < PARSED_FRAGMENT_CAP) {
    parsedFragments[key] = parsed
    parsedFragmentCount++
  }
  return parsed
}

/**
 * A fragment as a raw node whose binds and clock are nodes, not text. Each `?` becomes
 * a value node and each `$NOW$` becomes the clock token, so the clock rules see it.
 *
 * A stamp or a fence never rides in a fragment: the rules that read them need them as
 * nodes of the tree. A predicate or value compiles inside parentheses, so an OR inside
 * it cannot void the conjuncts around it. A subquery must bring its own, because a
 * second pair would make it one scalar value.
 */
export function rawSql<T>(fragment: SqlFragment, role: RawRole): Expression<T> {
  const { pieces, tokens } = parsedFragment(fragment.sql, role)
  let bound = 0
  const parameters = tokens.map((token) =>
    ValueNode.create(token === 'now' ? EngineToken.now : fragment.args[bound++]),
  )
  if (bound !== fragment.args.length) {
    throw new TypeError(`a SQL fragment binds ${bound} of its ${fragment.args.length} arguments`)
  }
  const raw = RawNode.create(pieces, parameters)
  weakSetAdd(mintedRaws[role], raw)
  if (placements !== null) placements.head = { fragment, next: placements.head }
  return nodeExpression<T>(role === 'subquery' ? raw : ParensNode.create(raw))
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
  /** `?` placeholders in the compiled SQL. More than `parameters` means a node added one. */
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

/** The names a query's own tables answer to: each alias or bare table name, with its table. */
function tableScope(query: OperationNode): { name: string; table: string }[] {
  const sources: OperationNode[] = []
  if (UpdateQueryNode.is(query) && query.table !== undefined) sources.push(query.table)
  if (DeleteQueryNode.is(query)) sources.push(...query.from.froms)
  if (SelectQueryNode.is(query)) {
    sources.push(...(query.from?.froms ?? []), ...(query.joins ?? []).map((join) => join.table))
  }
  return sources.flatMap((source) => {
    const table = tableName(source)
    if (table === null) return []
    const name = AliasNode.is(source) && IdentifierNode.is(source.alias) ? source.alias.name : table
    return [{ name, table }]
  })
}

/** A fence that gates, and the table whose `fence_stamp` it is compared with. */
export interface GatingFence {
  readonly fence: string
  readonly table: string
}

/** A conjunct that IS `fence_stamp = <fence token>`, in either orientation. */
function fenceEquality(
  node: OperationNode,
  scope: readonly { name: string; table: string }[],
): GatingFence | null {
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
        ? scope.find((source) => source.name === qualifier)?.table
        : scope.length === 1
          ? scope[0]?.table
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

const COUNTING_OPERATORS = ['+', '-', '*', '/', '%', '||']

/**
 * Assignments that may count twice when a follow-on replays: `arithmetic` combines the
 * column it writes with an arithmetic or concatenation operator, however the operands
 * are ordered, qualified, or parenthesized, and `raw` names that column inside a
 * fragment, where the tree cannot see what is done with it. A self-reference built from
 * nodes, such as `COALESCE(column, …)`, is visible and allowed.
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
      if (operator === null || !COUNTING_OPERATORS.includes(operator)) return false
      return (
        referencedColumn(candidate.leftOperand) === column ||
        referencedColumn(candidate.rightOperand) === column
      )
    })
    if (arithmetic) return [{ column, how: 'arithmetic' }]
    const raw = someNode(
      update.value,
      (candidate) => RawNode.is(candidate) && mentions(candidate.sqlFragments.join(' '), column),
    )
    return raw ? [{ column, how: 'raw' }] : []
  })
}

/** The raw node the builder makes for itself: an ORDER BY direction. */
function isBuilderRaw(parent: OperationNode, node: OperationNode): boolean {
  return (
    OrderByItemNode.is(parent) &&
    parent.direction === node &&
    RawNode.is(node) &&
    node.parameters.length === 0 &&
    /^(?:asc|desc)$/i.test(node.sqlFragments.join('').trim())
  )
}

/** The operand a row must, or must not, be IN or EXIST in: a subquery position. */
function subqueryOperand(node: OperationNode): OperationNode | null {
  if (UnaryOperationNode.is(node) && operatorName(node.operator) === 'exists') {
    return unwrapParens(node.operand)
  }
  const operator = BinaryOperationNode.is(node) ? operatorName(node.operator) : null
  return BinaryOperationNode.is(node) && (operator === 'in' || operator === 'not in')
    ? unwrapParens(node.rightOperand)
    : null
}

/** The boolean a clause node holds: a WHERE, a HAVING, a JOIN's ON, or a CASE condition. */
function clauseBoolean(node: OperationNode): OperationNode | null {
  if (WhereNode.is(node)) return node.where
  if (HavingNode.is(node)) return node.having
  if (OnNode.is(node)) return node.on
  return WhenNode.is(node) ? node.condition : null
}

/**
 * Why a statement's raw fragments are not in order, or null when they are. Every raw
 * node must come from `rawSql`, stand in one place, and stand where its role says, so a
 * fragment declared a value cannot stand as a whole boolean. Position is read from the
 * tree: a predicate is a boolean of a WHERE, HAVING, ON, or CASE condition, through
 * AND, OR, NOT, and parentheses, at any depth. A subquery is the operand of IN, NOT IN,
 * or EXISTS there. Anything else is a value. The builder's own ORDER BY direction is the
 * one raw node `rawSql` does not mint.
 */
export function rawFragmentProblem(tree: OperationNode): string | null {
  const predicates: OperationNode[] = []
  const subqueries: OperationNode[] = []
  const markBoolean = (node: OperationNode): void => {
    const inner = unwrapParens(node)
    const operand = subqueryOperand(inner)
    if (RawNode.is(inner)) {
      predicates.push(inner)
    } else if (AndNode.is(inner) || OrNode.is(inner)) {
      markBoolean(inner.left)
      markBoolean(inner.right)
    } else if (operand !== null) {
      if (RawNode.is(operand)) subqueries.push(operand)
    } else if (UnaryOperationNode.is(inner)) {
      markBoolean(inner.operand)
    }
  }
  someNode(tree, (node) => {
    const boolean = clauseBoolean(node)
    if (boolean !== null) markBoolean(boolean)
    return false
  })

  const placed: OperationNode[] = []
  let problem: string | null = null
  const visit = (node: OperationNode): void => {
    for (const child of children(node)) {
      if (problem !== null) return
      if (RawNode.is(child) && !isBuilderRaw(node, child)) {
        const role = mintedRole(child)
        const position = predicates.includes(child)
          ? 'predicate'
          : subqueries.includes(child)
            ? 'subquery'
            : 'value'
        if (role === undefined) problem = 'a raw fragment that rawSql did not mint'
        else if (placed.includes(child))
          problem = 'a fragment placed twice: call rawSql once for each place'
        else if (role !== position) problem = `a '${role}' fragment standing as a ${position}`
        placed.push(child)
      }
      visit(child)
    }
  }
  visit(tree)
  return problem
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

const NODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
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
  InsertQueryNode: ['kind', 'into', 'columns', 'values', 'onConflict'],
  OnConflictNode: ['kind', 'columns', 'doNothing', 'updates', 'updateWhere'],
}

const GRAMMAR_NODES = [
  ...Object.keys(NODE_FIELDS),
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
  'OnConflictNode',
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
  'ValuesNode',
  'WhenNode',
  'WhereNode',
]

/**
 * Why a tree is outside the statement grammar, or null when it is inside. The grammar
 * is closed: a node kind or query clause it does not list is refused, so a builder
 * form nobody considered cannot slip past the checks that read the tree. A statement
 * that needs a new kind adds it here, with the check that reads it.
 *
 * It lists no common table expression, RETURNING, or `UPDATE … FROM`, no write below
 * the root, and no schema-qualified table. An INSERT takes one row of values or one
 * SELECT, with a conflict clause that names its columns. It binds what is built from nodes. A store
 * fragment is opaque text, reviewed through the generated corpus.
 */
export function statementGrammarProblem(tree: OperationNode): string | null {
  const visit = (node: OperationNode, isRoot: boolean): string | null => {
    if (!GRAMMAR_NODES.includes(node.kind)) return `node kind ${node.kind}`
    if (
      !isRoot &&
      (UpdateQueryNode.is(node) || DeleteQueryNode.is(node) || InsertQueryNode.is(node))
    ) {
      return `${node.kind} below the root`
    }
    const fields = NODE_FIELDS[node.kind]
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

/** The provenance an assignment list writes, read structurally. */
function assignedProvenance(updates: readonly ColumnUpdateNode[]) {
  const assigned = (column: string) => updates.filter((update) => assignedColumn(update) === column)
  const only = (list: readonly ColumnUpdateNode[]) => (list.length === 1 ? list[0] : undefined)
  const instant = only(assigned('fence_at_ms'))?.value
  const reference = instant !== undefined && ReferenceNode.is(instant) ? instant : undefined
  const column = reference === undefined ? null : columnName(reference.column)
  return {
    stamp: tokenOf(only(assigned('fence_stamp'))?.value)?.kind === 'stamp',
    clockInstant: tokenOf(instant)?.kind === 'now',
    /** The stored column the instant is copied from, when it is a plain reference. */
    copiedInstant:
      column === null ? null : { table: reference?.table?.table.identifier.name ?? null, column },
  }
}

/**
 * The provenance an INSERT writes, or null for any other statement. The inserted value
 * of a column is read by position, from one row of values or from the SELECT's list. A
 * conflict update is read like any other assignment list.
 */
export function insertProvenance(tree: OperationNode): {
  stamp: boolean
  clockInstant: boolean
  conflict: ReturnType<typeof assignedProvenance> | null
} | null {
  if (!InsertQueryNode.is(tree)) return null
  const columns = (tree.columns ?? []).map((column) => column.column.name)
  const inserted = (name: string): OperationNode | undefined => {
    const index = columns.indexOf(name)
    if (index < 0 || columns.lastIndexOf(name) !== index) return undefined
    const values = tree.values
    if (values !== undefined && ValuesNode.is(values)) {
      const [row, ...others] = values.values
      return others.length === 0 && row !== undefined && ValueListNode.is(row)
        ? row.values[index]
        : undefined
    }
    if (values !== undefined && SelectQueryNode.is(values)) {
      const selection = values.selections?.[index]?.selection
      return selection !== undefined && AliasNode.is(selection) ? selection.node : selection
    }
    return undefined
  }
  const updates = tree.onConflict?.updates
  return {
    stamp: tokenOf(inserted('fence_stamp'))?.kind === 'stamp',
    clockInstant: tokenOf(inserted('fence_at_ms'))?.kind === 'now',
    conflict: updates === undefined ? null : assignedProvenance(updates),
  }
}

/** An expression under an alias, for a SELECT list. Token and fragment expressions have no `as`. */
export function aliasedAs<T, A extends string>(
  expression: Expression<T>,
  alias: A,
): AliasedExpression<T, A> {
  return {
    get expression(): Expression<T> {
      return expression
    },
    get alias(): A {
      return alias
    },
    toOperationNode: () =>
      AliasNode.create(expression.toOperationNode(), IdentifierNode.create(alias)),
  }
}
