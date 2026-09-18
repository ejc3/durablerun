import {
  AggregateFunctionNode,
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
  SelectAllNode,
  SelectModifierNode,
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
import { FENCE_STATEMENT_NAME_SOURCE } from './contract.js'
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
  readonly tokens: readonly ('bind' | 'now' | { readonly fence: string })[]
}

const FENCE_TOKEN = String.raw`\$FENCE:(${FENCE_STATEMENT_NAME_SOURCE})\$`
const FRAGMENT_TOKEN = new RegExp(
  String.raw`\?|${NOW.replaceAll('$', String.raw`\$`)}|${FENCE_TOKEN}`,
  'g',
)

/** How many arguments a fragment's text binds: its `?` outside string literals. */
export function fragmentBinds(sql: string): number {
  return readFragment(sql).outside.split('?').length - 1
}

/**
 * Validate a fragment's text for its role and split it at its binds and clock tokens.
 * The text is split without reading SQL beyond plain single-quoted literals, so anything
 * that would hide a token from that reading is refused: a comment, a dollar-quoted or
 * prefixed string, and a token inside a literal.
 */
function parseFragment(sql: string, role: RawRole): ParsedFragment {
  if (sql.includes(STAMP)) {
    throw new Error(
      'a SQL fragment may not hold the stamp token: a tree assigns the stamp as a node',
    )
  }
  const { literals, outside, prefixed } = readFragment(sql)
  const fenceless = outside.replace(new RegExp(FENCE_TOKEN, 'g'), '')
  if (fenceless.includes(FENCE_PREFIX)) {
    throw new Error('a SQL fragment holds a malformed fence token')
  }
  if (outside.includes('--') || outside.includes('/*')) {
    throw new Error('a SQL fragment may not hold a comment: its text is split without reading SQL')
  }
  if (prefixed || /\$\w*\$/.test(fenceless.replaceAll(NOW, ''))) {
    throw new Error(
      'a SQL fragment may use only plain single-quoted literals: its text is split without reading SQL',
    )
  }
  // A well-formed token leaves nothing behind. Text left over beside one, such as a
  // second token run into the first, would compile into SQL the database rejects. This
  // runs after the dollar-quote check, so a dollar-quoted string keeps its own refusal.
  if (fenceless.replaceAll(NOW, '').includes('$')) {
    throw new Error('a SQL fragment holds a malformed fence token or a stray $')
  }
  if (
    literals.some(
      (literal) => literal.includes('?') || literal.includes(NOW) || literal.includes(FENCE_PREFIX),
    )
  ) {
    throw new Error(
      'a SQL fragment may not hold a bind, the clock token, or a fence token inside a string literal: its text is split without reading SQL',
    )
  }
  if (role === 'subquery' && !isOneGroup(outside)) {
    throw new Error('a subquery fragment must be one parenthesized group')
  }
  const pieces: string[] = []
  const tokens: ('bind' | 'now' | { readonly fence: string })[] = []
  let last = 0
  for (const match of sql.matchAll(FRAGMENT_TOKEN)) {
    pieces.push(sql.slice(last, match.index))
    last = match.index + match[0].length
    tokens.push(
      match[0] === '?' ? 'bind' : match[0] === NOW ? 'now' : { fence: match[1] as string },
    )
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
 * The stamp never rides in a fragment: the stamping rule reads it as an assigned node. A
 * fence token may, because generated and correlated subqueries carry one in store text.
 * It becomes a fence node, so it is bound and must name a fence of the batch, and it
 * gates nothing: the gating rule reads only a comparison built from nodes. A predicate
 * or value compiles inside parentheses, so an OR inside
 * it cannot void the conjuncts around it. A subquery must bring its own, because a
 * second pair would make it one scalar value.
 */
export function rawSql<T>(fragment: SqlFragment, role: RawRole): Expression<T> {
  const { pieces, tokens } = parsedFragment(fragment.sql, role)
  let bound = 0
  const parameters = tokens.map((token) =>
    ValueNode.create(
      token === 'bind'
        ? fragment.args[bound++]
        : token === 'now'
          ? EngineToken.now
          : EngineToken.fence(token.fence),
    ),
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

/** A fence in a gating position, and the table whose `fence_stamp` it is compared with. */
export interface GatingFence {
  readonly fence: string
  readonly table: string
  /** The name that fenced table answers to in the query that compares it. */
  readonly source: string
  /**
   * Whether every subquery between the fence and the statement's own rows is tied to
   * them (`isTied`). A fence that stands in a gating position and is not tied proves
   * only that the batch won, so it gates nothing.
   */
  readonly tied: boolean
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
    const source =
      qualifier !== undefined
        ? scope.find((candidate) => candidate.name === qualifier)
        : scope.length === 1
          ? scope[0]
          : undefined
    if (source !== undefined) {
      return { fence: token.fence, table: source.table, source: source.name, tied: true }
    }
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

/** The qualifier of a plain column reference, or null for anything else. */
function referenceQualifier(node: OperationNode): string | null {
  const inner = unwrapParens(node)
  return ReferenceNode.is(inner) ? (inner.table?.table.identifier.name ?? null) : null
}

/** The one source a SELECT reads, when it reads exactly one and joins nothing. */
function onlySource(select: SelectQueryNode): OperationNode | null {
  const froms = select.from?.froms ?? []
  const [only] = froms
  return froms.length === 1 && only !== undefined && (select.joins?.length ?? 0) === 0 ? only : null
}

/** The SELECT a derived table wraps, or null for a plain table. */
function derivedSelect(source: OperationNode): SelectQueryNode | null {
  const inner = AliasNode.is(source) ? source.node : source
  return SelectQueryNode.is(inner) ? inner : null
}

/**
 * The name a SELECT gives its single selection, when that selection is one plain column
 * of the SELECT's one source, or null. Through a derived table the column must be the
 * one the derived table itself selects this way, so the key is a stored column of the
 * fenced source all the way down: never a bind, an expression, or another table's key.
 */
function selectedSourceColumn(select: SelectQueryNode): string | null {
  const source = onlySource(select)
  const selections = select.selections ?? []
  const [only] = selections
  if (source === null || selections.length !== 1 || only === undefined) return null
  const aliased = only.selection
  const selection = AliasNode.is(aliased) ? aliased.node : aliased
  if (!ReferenceNode.is(selection)) return null
  const column = columnName(selection.column)
  if (column === null) return null
  const qualifier = selection.table?.table.identifier.name
  const derived = derivedSelect(source)
  const sourceName =
    AliasNode.is(source) && IdentifierNode.is(source.alias) ? source.alias.name : tableName(source)
  if (qualifier !== undefined && qualifier !== sourceName) return null
  if (derived !== null && selectedSourceColumn(derived) !== column) return null
  return AliasNode.is(aliased) && IdentifierNode.is(aliased.alias) ? aliased.alias.name : column
}

/**
 * Whether a required subquery is tied to the row of the query that requires it. The
 * subquery reads one source and joins nothing, so nothing beside the fenced rows can
 * supply a key or a match. `IN` ties it when its left side is a column and the subquery
 * selects one plain column of that source, directly or through one derived table.
 * `EXISTS` ties it when a top-level conjunct of the subquery equates a column of that
 * source with a column of an outer source, each named by its qualifier. A gated
 * subquery that is not tied proves only that the batch won, never that the row is one
 * the batch stamped.
 */
function isTied(
  conjunct: OperationNode,
  subquery: SelectQueryNode,
  outer: readonly { name: string }[],
): boolean {
  const source = onlySource(subquery)
  if (source === null) return false
  if (BinaryOperationNode.is(conjunct)) {
    return (
      ReferenceNode.is(unwrapParens(conjunct.leftOperand)) &&
      selectedSourceColumn(subquery) !== null
    )
  }
  const where = whereOf(subquery)
  if (where === null) return false
  const inner = tableScope(subquery)
  const isInner = (name: string | null) =>
    name !== null && inner.some((candidate) => candidate.name === name)
  const isOuter = (name: string | null) =>
    name !== null && !isInner(name) && outer.some((candidate) => candidate.name === name)
  return conjuncts(where).some((candidate) => {
    if (!BinaryOperationNode.is(candidate) || operatorName(candidate.operator) !== '=') {
      return false
    }
    const left = referenceQualifier(candidate.leftOperand)
    const right = referenceQualifier(candidate.rightOperand)
    return (isInner(left) && isOuter(right)) || (isOuter(left) && isInner(right))
  })
}

/**
 * The fences that stand in a gating position, each marked `tied` or not. A fence stands
 * there when a top-level WHERE conjunct is itself `fence_stamp = <fence>`, or requires a
 * row from a subquery whose own top-level WHERE is gated the same way. It gates every
 * row the statement reads or writes only when it is also `tied`: every such subquery on
 * the way is tied to the row that requires it (`isTied`). A fence joined by OR, under
 * NOT, or merely contained in a conjunct stands nowhere, so it is not returned. An
 * INSERT … SELECT is gated by what gates its SELECT, and a row of VALUES by nothing.
 */
export function gatingFences(query: OperationNode): GatingFence[] {
  if (InsertQueryNode.is(query)) {
    const selected = query.values
    return selected !== undefined && SelectQueryNode.is(selected) ? gatingFences(selected) : []
  }
  const where = whereOf(query)
  const scope = tableScope(query)
  const gated =
    where === null
      ? []
      : conjuncts(where).flatMap((conjunct) => {
          const fence = fenceEquality(conjunct, scope)
          if (fence !== null) return [fence]
          const subquery = requiredSubquery(conjunct)
          if (subquery === null || !SelectQueryNode.is(subquery)) return []
          if (!mayReturnNoRow(subquery)) return []
          const tied = isTied(conjunct, subquery, scope)
          return gatingFences(subquery).map((gate) => ({ ...gate, tied: gate.tied && tied }))
        })
  return [...gated, ...derivedTableGates(query)]
}

/**
 * Whether a SELECT returns no row when its WHERE matches none, so that a row required
 * from it proves its WHERE. An aggregate with no GROUP BY returns one row always. The
 * builder spells an aggregate more than one way and a fragment hides one, so an
 * ungrouped SELECT qualifies only when every selection is built from nodes and holds no
 * function of any kind. This is asked of a subquery a row is required from, and of a
 * derived table, never of the statement's own root: a tail may count the rows its own
 * WHERE gates, and a losing batch then counts none.
 */
function mayReturnNoRow(select: SelectQueryNode): boolean {
  if (select.groupBy !== undefined) return true
  // An ungrouped HAVING makes the SELECT one group, which returns a row regardless.
  if (select.having !== undefined) return false
  return (select.selections ?? []).every(
    (selection) =>
      !someNode(
        selection,
        (node) => AggregateFunctionNode.is(node) || FunctionNode.is(node) || RawNode.is(node),
      ),
  )
}

/**
 * A SELECT whose only source is one derived table reads a subset of that table's rows,
 * so whatever gates the derived table gates it. A join or a second source could add
 * rows, so either one gates nothing.
 */
function derivedTableGates(query: OperationNode): GatingFence[] {
  if (!SelectQueryNode.is(query)) return []
  const source = onlySource(query)
  const inner = source === null ? null : derivedSelect(source)
  return inner !== null && mayReturnNoRow(inner) ? gatingFences(inner) : []
}

/** The column an assignment writes. The object and two-argument `set` forms differ in shape. */
function assignedColumn(update: ColumnUpdateNode): string | null {
  return referencedColumn(update.column) ?? columnName(update.column)
}

/** What a statement assigns to a row that exists: an UPDATE's SET list, or an INSERT's conflict arm. */
function assignedUpdates(query: OperationNode): readonly ColumnUpdateNode[] {
  if (InsertQueryNode.is(query)) return query.onConflict?.updates ?? []
  return UpdateQueryNode.is(query) ? (query.updates ?? []) : []
}

/**
 * Whether a fragment's text may count on `column` of the row being written. The tree
 * cannot see what text does with a value, so any read of the assigned row counts: an
 * unqualified mention, or one qualified by the table being written, whatever wraps it.
 * A mention under another qualifier is another row, read through a subquery, and a copy
 * of it is fine. Arithmetic on it is refused all the same, as the text path refused
 * `x = t.x + 1` by name: `t.x + 1`, `1 + t.x`, and `(t.x + 1)` are one write.
 */
function mentions(text: string, column: string, table: string | null): boolean {
  const name = String.raw`"?${column}"?(?!\w)`
  const qualified = String.raw`\w+"?\."?${column}"?(?!\w)`
  const operator = String.raw`(?:[-+*/%]|\|\|)`
  return (
    new RegExp(String.raw`(?<![\w."])${name}`, 'i').test(text) ||
    (table !== null && new RegExp(String.raw`(?<!\w)"?${table}"?\.${name}`, 'i').test(text)) ||
    new RegExp(String.raw`${qualified}\s*\)*\s*${operator}`, 'i').test(text) ||
    new RegExp(String.raw`${operator}\s*\(*\s*"?${qualified}`, 'i').test(text)
  )
}

const COUNTING_OPERATORS = ['+', '-', '*', '/', '%', '||']

/**
 * Assignments that may count twice when a follow-on replays: `arithmetic` combines the
 * column it writes with an arithmetic or concatenation operator, however the operands
 * are ordered, qualified, or parenthesized, and `raw` names that column inside a
 * fragment, where the tree cannot see what is done with it. A self-reference built from
 * nodes, such as `COALESCE(column, …)`, is visible and allowed. In an INSERT's conflict
 * arm, `excluded` names the incoming row and never the row being written, so a read of
 * `excluded.column` is not a self-reference: a replay computes the same value again.
 */
export function selfCountingAssignments(
  query: OperationNode,
): { column: string; how: 'arithmetic' | 'raw' }[] {
  const table = statementTable(query)
  const incoming = InsertQueryNode.is(query) ? 'excluded' : null
  /** The column a node reads from the row being written, or null. */
  const writtenColumn = (node: OperationNode): string | null =>
    incoming !== null && referenceQualifier(node) === incoming ? null : referencedColumn(node)
  return assignedUpdates(query).flatMap(
    (update): { column: string; how: 'arithmetic' | 'raw' }[] => {
      const column = assignedColumn(update)
      if (column === null) return []
      // A fragment's reads of the incoming row are taken out before its text is read for
      // the written row, so `excluded.x + 1` passes and `excluded.x + x` does not.
      const written = (text: string): string =>
        incoming === null
          ? text
          : text.replace(
              new RegExp(String.raw`(?<![\w."])"?${incoming}"?\."?${column}"?(?!\w)`, 'gi'),
              ' 0 ',
            )
      const arithmetic = someNode(update.value, (candidate) => {
        if (!BinaryOperationNode.is(candidate)) return false
        const operator = operatorName(candidate.operator)
        if (operator === null || !COUNTING_OPERATORS.includes(operator)) return false
        return (
          writtenColumn(candidate.leftOperand) === column ||
          writtenColumn(candidate.rightOperand) === column
        )
      })
      if (arithmetic) return [{ column, how: 'arithmetic' }]
      const raw = someNode(
        update.value,
        (candidate) =>
          RawNode.is(candidate) &&
          mentions(written(candidate.sqlFragments.join(' ')), column, table),
      )
      return raw ? [{ column, how: 'raw' }] : []
    },
  )
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
  'unix_timestamp',
]

/**
 * A database clock spelled out in raw SQL text. This is a spelling list, the same one
 * `scripts/clock-lint.py` applies to store sources, because raw text is the one place a
 * tree cannot be read. A date function with no argument is on it: SQLite reads
 * `datetime()` as the current time. The only clock a tree may hold is the clock token, and
 * a clock called as a function node is outside the grammar, which lists no clock.
 */
export const CLOCK_SPELLING = new RegExp(
  [
    String.raw`\b(?:${CLOCK_FUNCTIONS.join('|')})\s*\(`,
    String.raw`\b(?:current_timestamp|current_time|current_date|localtime|localtimestamp|utc_timestamp|utc_date|utc_time)\b`,
    String.raw`\b(?:datetime|date|time)\s*\(\s*(?:'now'|\))`,
  ].join('|'),
  'i',
)

const NODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  UpdateQueryNode: ['kind', 'table', 'where', 'updates'],
  DeleteQueryNode: ['kind', 'from', 'where'],
  SelectQueryNode: [
    'kind',
    'frontModifiers',
    'from',
    'selections',
    'where',
    'joins',
    'groupBy',
    'having',
    'orderBy',
    'limit',
  ],
  SelectModifierNode: ['kind', 'modifier'],
  InsertQueryNode: ['kind', 'into', 'columns', 'values', 'onConflict'],
  OnConflictNode: ['kind', 'columns', 'indexWhere', 'doNothing', 'updates', 'updateWhere'],
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
 * The functions a statement may call, closed like the node kinds. A clock is a function,
 * and a list of clock spellings cannot name the next one, so a call the grammar does not
 * list is refused whatever it is. A statement that needs another function adds it here.
 */
const GRAMMAR_FUNCTIONS = ['coalesce']
const GRAMMAR_AGGREGATES = ['avg', 'count', 'max', 'min', 'sum']

/**
 * What the grammar requires of an INSERT beyond its node kinds. The checks that read an
 * insert's provenance go by column position, so a SELECT lists one plain selection for
 * each column: a star is one selection and many columns. A conflict clause names its
 * columns, or it would swallow a violation of any unique index. SQLite reads the ON of a
 * conflict clause as a join constraint when the SELECT before it has no WHERE. A
 * partial-index predicate on the conflict target holds column references, operators,
 * and inline values only.
 */
function insertShapeProblem(insert: InsertQueryNode): string | null {
  const values = insert.values
  if (values !== undefined && SelectQueryNode.is(values)) {
    const selections = values.selections ?? []
    // `select *` is a bare star, and `select t.*` is a reference whose column is one.
    const isStar = (node: OperationNode) =>
      SelectAllNode.is(node) || (ReferenceNode.is(node) && SelectAllNode.is(node.column))
    const plain = selections.every((selection) => !isStar(selection.selection))
    if (!plain || selections.length !== (insert.columns?.length ?? 0)) {
      return 'an INSERT … SELECT without one plain selection for each column'
    }
    if (insert.onConflict !== undefined && values.where === undefined) {
      return 'an INSERT … SELECT with ON CONFLICT and no WHERE, and it needs a WHERE for SQLite to parse it'
    }
  } else if (values === undefined || !ValuesNode.is(values) || values.values.length !== 1) {
    return 'an INSERT without exactly one row of values or one SELECT'
  }
  if (insert.onConflict !== undefined && (insert.onConflict.columns?.length ?? 0) === 0) {
    return 'an ON CONFLICT that names no columns'
  }
  // A partial index is matched by its predicate's text. SQLite refuses a predicate
  // with a parameter in it and PostgreSQL accepts one, so a bound value would run on one
  // dialect and fail on the other. Inline values such as NULL are part of the text.
  const indexWhere = insert.onConflict?.indexWhere
  if (indexWhere !== undefined) {
    if (someNode(indexWhere, (node) => RawNode.is(node))) {
      return 'an index predicate that holds a fragment'
    }
    if (someNode(indexWhere, (node) => ValueNode.is(node) && node.immediate !== true)) {
      return 'an index predicate that holds a bound value or a token'
    }
  }
  return null
}

/**
 * Why a tree is outside the statement grammar, or null when it is inside. The grammar
 * is closed: a node kind or query clause it does not list is refused, so a builder
 * form nobody considered cannot slip past the checks that read the tree. A statement
 * that needs a new kind adds it here, with the check that reads it.
 *
 * It lists no common table expression, RETURNING, or `UPDATE … FROM`, no write below
 * the root, and no schema-qualified table. An INSERT takes one row of values or one
 * SELECT, with a conflict clause that names its columns (`insertShapeProblem`). It binds
 * what is built from nodes. A store fragment is opaque text, reviewed through the
 * generated corpus.
 */
export function statementGrammarProblem(tree: OperationNode): string | null {
  const visit = (node: OperationNode, isRoot: boolean): string | null => {
    if (!GRAMMAR_NODES.includes(node.kind)) return `node kind ${node.kind}`
    if (FunctionNode.is(node) && !GRAMMAR_FUNCTIONS.includes(node.func.toLowerCase())) {
      return `a call of ${node.func}, which the grammar does not list`
    }
    if (AggregateFunctionNode.is(node) && !GRAMMAR_AGGREGATES.includes(node.func.toLowerCase())) {
      return `an aggregate call of ${node.func}, which the grammar does not list`
    }
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
    if (SelectModifierNode.is(node) && node.modifier !== 'Distinct') {
      return 'a SELECT modifier other than DISTINCT'
    }
    if (InsertQueryNode.is(node)) {
      const shape = insertShapeProblem(node)
      if (shape !== null) return shape
    }
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
 * The value an INSERT gives one column, read by column position from its one row of
 * values or from its SELECT's list. A column listed twice has no one position.
 */
function insertedValue(insert: InsertQueryNode, name: string): OperationNode | undefined {
  const columns = (insert.columns ?? []).map((column) => column.column.name)
  const index = columns.indexOf(name)
  if (index < 0 || columns.lastIndexOf(name) !== index) return undefined
  const values = insert.values
  if (values !== undefined && ValuesNode.is(values)) {
    // The grammar admits exactly one row.
    const row = values.values[0]
    return row !== undefined && ValueListNode.is(row) ? row.values[index] : undefined
  }
  if (values !== undefined && SelectQueryNode.is(values)) {
    const selection = values.selections?.[index]?.selection
    return selection !== undefined && AliasNode.is(selection) ? selection.node : selection
  }
  return undefined
}

/**
 * The provenance a follow-on INSERT … SELECT writes, or null for any other statement. A
 * follow-on may not read the clock, so its instant is the fenced row's own: a reference
 * to `fence_at_ms` of a source whose `fence_stamp` a top-level conjunct of the SELECT
 * compares with a fence. `fencedInstants` names every inserted column that takes exactly
 * that, so a preserved first instant can be held to it as well. `plain` is false when the
 * SELECT could return a row its WHERE did not match, which an insert would then write
 * with no gate: an aggregate or a function call in its list, built from nodes, or a
 * HAVING. A call spelled inside a value fragment is outside what this can read. This is asked here, of the statement's own
 * SELECT, and does not lean on what `gatingFences` decides about aggregates. `alone` is
 * false when the SELECT could return more rows than the fenced ones: a second FROM item,
 * a FROM item that is not the source the fence is compared on, or a join with no ON. A
 * join that carries its ON stays, because a revival reads the task's top run that way.
 */
export function followOnInsertProvenance(tree: OperationNode): {
  selects: boolean
  plain: boolean
  alone: boolean
  stamp: boolean
  /** The inserted columns whose value is the fenced row's own `fence_at_ms`. */
  fencedInstants: string[]
  conflict: boolean
} | null {
  if (!InsertQueryNode.is(tree)) return null
  const selected = tree.values
  const select = selected !== undefined && SelectQueryNode.is(selected) ? selected : null
  const where = select === null ? null : whereOf(select)
  const scope = select === null ? [] : tableScope(select)
  const fenced =
    where === null
      ? []
      : conjuncts(where).flatMap((conjunct) => {
          const fence = fenceEquality(conjunct, scope)
          return fence === null ? [] : [fence.source]
        })
  const froms = select?.from?.froms ?? []
  const [from] = froms
  const fromName =
    from === undefined
      ? null
      : AliasNode.is(from) && IdentifierNode.is(from.alias)
        ? from.alias.name
        : tableName(from)
  // An unqualified instant belongs to the only source, and to neither of two.
  const isFencedInstant = (name: string): boolean => {
    const instant = insertedValue(tree, name)
    if (instant === undefined || !ReferenceNode.is(instant)) return false
    const qualifier =
      instant.table?.table.identifier.name ?? (scope.length === 1 ? scope[0]?.name : undefined)
    return (
      columnName(instant.column) === 'fence_at_ms' &&
      qualifier !== undefined &&
      fenced.includes(qualifier)
    )
  }
  return {
    selects: select !== null,
    plain:
      select !== null &&
      select.having === undefined &&
      !(select.selections ?? []).some((selection) =>
        someNode(selection, (node) => AggregateFunctionNode.is(node) || FunctionNode.is(node)),
      ),
    // With no fence compared at all, the gate rule and the instant rule speak for it.
    alone:
      select !== null &&
      froms.length === 1 &&
      (fenced.length === 0 || (fromName !== null && fenced.includes(fromName))) &&
      (select.joins ?? []).every((join) => join.on !== undefined),
    stamp: tokenOf(insertedValue(tree, 'fence_stamp'))?.kind === 'stamp',
    fencedInstants: (tree.columns ?? [])
      .map((column) => column.column.name)
      .filter(isFencedInstant),
    conflict: tree.onConflict !== undefined,
  }
}

/**
 * The provenance an assignment list writes, read structurally: `fence_stamp` as the
 * stamp token, and `fence_at_ms` as anything, as the clock token, or as a copy of a
 * stored column. Each counts only when the column is assigned exactly once.
 */
function assignedProvenance(updates: readonly ColumnUpdateNode[]) {
  const assigned = (column: string) => updates.filter((update) => assignedColumn(update) === column)
  const only = (list: readonly ColumnUpdateNode[]) => (list.length === 1 ? list[0] : undefined)
  const instants = assigned('fence_at_ms')
  const instant = only(instants)?.value
  const reference = instant !== undefined && ReferenceNode.is(instant) ? instant : undefined
  const column = reference === undefined ? null : columnName(reference.column)
  return {
    stamp: tokenOf(only(assigned('fence_stamp'))?.value)?.kind === 'stamp',
    instant: instants.length === 1,
    clockInstant: tokenOf(instant)?.kind === 'now',
    /** The stored column the instant is copied from, when it is a plain reference. */
    copiedInstant: column === null ? null : { table: tableName(reference?.table), column },
    /** Every column the list assigns. */
    columns: updates.map(assignedColumn),
  }
}

/** The provenance a statement's assignments write: an UPDATE's SET list, or an INSERT's conflict arm. */
export function writesStampAssignments(tree: OperationNode): {
  stamp: boolean
  instant: boolean
  clockInstant: boolean
} {
  return assignedProvenance(assignedUpdates(tree))
}

/**
 * The provenance an INSERT writes, or null for any other statement. The inserted value
 * of a column is read by position, from one row of values or from the SELECT's list. A
 * conflict update is read like any other assignment list.
 */
export function insertProvenance(tree: OperationNode): {
  stamp: boolean
  clockInstant: boolean
  /** The columns whose inserted value is the clock token. */
  clockColumns: string[]
  conflict: ReturnType<typeof assignedProvenance> | null
} | null {
  if (!InsertQueryNode.is(tree)) return null
  const columns = (tree.columns ?? []).map((column) => column.column.name)
  const inserted = (name: string) => insertedValue(tree, name)
  const updates = tree.onConflict?.updates
  return {
    stamp: tokenOf(inserted('fence_stamp'))?.kind === 'stamp',
    clockInstant: tokenOf(inserted('fence_at_ms'))?.kind === 'now',
    clockColumns: columns.filter((name) => tokenOf(inserted(name))?.kind === 'now'),
    conflict: updates === undefined ? null : assignedProvenance(updates),
  }
}

/**
 * The columns and the SELECT list of an INSERT … SELECT, from one record, so a column and
 * its value cannot fall out of step. The insert stamp rule reads the list by position.
 */
export function insertedFrom<R extends Record<string, Expression<unknown>>>(record: R) {
  const columns = Object.keys(record) as (keyof R & string)[]
  return {
    columns,
    selections: () =>
      columns.map((column) => {
        const value = record[column]
        if (value === undefined) throw new Error(`insertedFrom: column '${column}' has no value`)
        return aliasedAs<unknown, typeof column>(value, column)
      }),
  }
}

/**
 * The provenance every statement that stamps a row assigns: this statement's stamp, and
 * the batch's one clock.
 */
export const FENCE_ASSIGNMENTS = Object.freeze({
  fence_stamp: stampValue,
  fence_at_ms: nowValue,
})

/** A column of the written row, as a value. */
export function columnValue<T>(column: string): Expression<T> {
  return nodeExpression<T>(ReferenceNode.create(ColumnNode.create(column)))
}

/**
 * `COALESCE(column, value)`: keep a column's value once it is set. Built from nodes, so
 * the counting rule sees the column's reference to itself, which it cannot inside a
 * fragment.
 */
export function coalesced<T>(column: string, value: Expression<T>): Expression<T> {
  return nodeExpression<T>(
    FunctionNode.create('coalesce', [
      columnValue(column).toOperationNode(),
      value.toOperationNode(),
    ]),
  )
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
