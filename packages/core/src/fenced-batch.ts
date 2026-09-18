import { type Expression, type Kysely, SelectQueryNode, isExpression } from 'kysely'
import type { EventName } from './child-tasks.js'
import {
  DERIVED_WRITABLE_COLUMNS,
  type DerivedWritableColumn,
  FENCED_TABLES,
  FENCE_RELATIONS,
  FENCE_STATEMENT_NAME_SOURCE,
  type FenceRelation,
  type FenceTable,
  PRESERVED_FENCE_INSTANTS,
  type SelfFenceRelation,
  isFenceStatementName,
} from './contract.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import type {
  SqlBatchMode,
  SqlClaimLockCoordinates,
  SqlExecutor,
  SqlResult,
  SqlStatement,
  SqlTransactionLock,
} from './primitives.js'
import {
  CLOCK_SPELLING,
  type DefinedStatement,
  type StatementTree,
  type TreeDialect,
  columnValue,
  defineStatement,
  fenceValue,
  followOnInsertProvenance,
  fragmentBinds,
  fragmentOutsideLiterals,
  gatingFences,
  insertProvenance,
  isDefinedStatement,
  mayReturnNoRow,
  rawFragmentProblem,
  rawFragmentTexts,
  rawSql,
  selfCountingAssignments,
  sqlFragment,
  stampValue,
  statementGrammarProblem,
  statementTable,
  writesStampAssignments,
} from './sql-tree.js'
import { treeBuilder } from './store-tables.js'

/**
 * Structural enforcement of DESIGN.md §3.4 rules 1, 2 and 8.
 *
 * A FencedBatch is one engine transition: one or more mutually exclusive
 * compare-and-set statements, each of which WRITES its own provenance into
 * the row it transitions, followed by statements that may only touch rows
 * carrying that provenance. The builder throws at construction time when a
 * statement does not have that shape, so "a losing batch still writes" and
 * "two clock reads in one batch" stop being mistakes to avoid and become
 * sentences you cannot say.
 *
 * Every statement is a statement tree (`sql-tree.ts`), compiled once when it is added,
 * and the rules read the tree. Raw fragment text is the one thing a tree cannot read,
 * and `addTree` says how it is held.
 *
 * Three things make it work, and each replaced a bug that shipped:
 *
 * 1. THE STAMP NAMES A STATEMENT, NOT A BATCH. `casTree('a', …)` writes
 *    `<seed>:a`; a follow-on says `fence('a')` and gets exactly that. One
 *    stamp for the whole batch aliases across its statements, so a follow-on
 *    asking "does the row at this id carry my stamp" could be answered by a
 *    DIFFERENT row the same batch stamped — which is how a failing run whose
 *    successor id collided with its own answered for the successor and
 *    skipped the only statement that records why the task failed.
 *
 * 2. THE PRIMITIVE GENERATES THE FENCE VALUE. `fence(name)` throws unless
 *    `name` is a statement already added to THIS batch that writes a stamp.
 *    A typo, or a fence on a statement added later (whose provenance cannot
 *    exist yet), is a construction error rather than a filter that silently
 *    matches nothing.
 *
 * 3. A FOLLOW-ON CANNOT READ THE CLOCK. The clock is refused outside a CAS: as the
 *    clock token, as the batch clock's own text, and as a spelling of a clock.
 *    Follow-ons derive instants from `fence_at_ms`, the one value the CAS
 *    recorded. Real libSQL and MySQL re-read the wall clock per statement —
 *    measured at ~2% divergence between two statements of one local batch —
 *    so any pair of statements that must agree on "now" eventually will not.
 *
 * Results come back by NAME; positional destructuring of batch results was
 * its own reviewed hazard.
 */

const {
  Set: TrustedSet,
  TypeError: TrustedTypeError,
  WeakSet: TrustedWeakSet,
  WeakSetAdd: weakSetAdd,
  WeakSetHas: weakSetHas,
} = TASK_INTRINSICS
const bindCompilationErrors = new TrustedWeakSet<object>()

function bindCompilationError(message: string): TypeError {
  const error = new TrustedTypeError(message)
  weakSetAdd(bindCompilationErrors, error)
  return error
}

/** True only for an authentic compiler bind failure from this module. */
export function isFencedBatchBindError(value: unknown): value is TypeError {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    weakSetHas(bindCompilationErrors, value)
  )
}

/**
 * How many rows a statement may write. `'one'` is checked after the batch
 * commits; `{ many: reason }` costs a written justification, because
 * "this one really can touch many rows" is exactly the judgement that should
 * not be made silently.
 */
export type RowBound = 'one' | { many: string }

/** The audited bound a declaration stands for. Nothing reads a `many` reason: writing it is its job. */
const atMostRows = (rows: RowBound): number | null => (rows === 'one' ? 1 : null)

interface DerivedSelection<R extends FenceRelation = FenceRelation> {
  relation: R
  fence: string
  where?: string
  whereArgs?: SqlStatement['args']
  narrow?: string
  narrowArgs?: SqlStatement['args']
  /**
   * The one queue both sides are in, for a queue-scoped relation: the source rows and
   * the written rows each compare their queue with this bind. Without it the source is
   * correlated to the target on the queue, which is as safe and runs the source once
   * for every target row. A source selected by key pays nothing for that. A source
   * selected by queue and state pays the target table times the queue's backlog.
   */
  queue?: string
  rows: 'one' | 'source-keys'
}

type RelationTarget<R extends FenceRelation> = (typeof FENCE_RELATIONS)[R]['target']

/**
 * The table a generated statement writes: a relation's target, never null.
 *
 * A hand-written follow-on may deliberately carry no stamped target. Keeping the
 * generated statement's target in its own type prevents that broader
 * representation from making `null` an expressible generated UPDATE.
 */
export type GeneratedUpdateTarget = RelationTarget<FenceRelation>

/**
 * What a generated UPDATE assigns a column: SQL text with `?` binds, or an expression
 * built from nodes. A value that reads the column it is assigned to must be nodes, such
 * as `coalesced(column, …)`, because the counting rule cannot read a fragment.
 */
export type DerivedValue = string | Expression<unknown>

type DerivedSet<R extends FenceRelation> = Partial<
  Record<DerivedWritableColumn<RelationTarget<R>>, DerivedValue>
>

type DerivedSpec<R extends FenceRelation = FenceRelation> =
  | (DerivedSelection<R> & {
      set?: undefined
      setArgs?: never
    })
  | (DerivedSelection<R> & {
      set: DerivedSet<R>
      setArgs?: SqlStatement['args']
    })

type InternalDerivedSpec<R extends FenceRelation> =
  | (DerivedSelection<R> & {
      set?: undefined
      setArgs?: never
    })
  | (DerivedSelection<R> & {
      set: Readonly<Partial<Record<string, DerivedValue>>>
      setArgs?: SqlStatement['args']
    })

type Kind = 'cas' | 'casMany' | 'followOn' | 'tail'

interface Named {
  name: string
  kind: Kind
  /** Present while this statement's stamp may still be consumed. */
  fence: { target: FenceTable; sealedBy: string | null } | null
  /** The most rows it may write, audited after the batch commits. Null is no bound. */
  atMost: number | null
  /** Compiled once, when the statement was added, so what was checked is what runs. */
  compiled: SqlStatement
}

/**
 * The builder generated follow-ons are built with. A relation names its tables and
 * columns at run time, from the closed `FENCE_RELATIONS` contract, so the builder's
 * static table types do not apply here.
 */
const generatedBuilder = treeBuilder as unknown as Kysely<Record<string, Record<string, unknown>>>

const clockReadRule = (at: string): string =>
  `${at} reads the clock — only a CAS may, and every later statement derives its instants from the fence_at_ms the CAS recorded (§3.4 rule 8)`
const blindCounterRule = (at: string): string =>
  `${at} bumps a counter blindly (x = x + n) — an exact replay of this batch re-matches its own stamped rows and counts twice; derive the value from the winning row's post-state instead`

export interface FencedResult {
  /** The name of the CAS that won, or null if none did. */
  won: string | null
  /** Rows the winning CAS affected (1 for `cas`, up to `max` for `casMany`). */
  count: number
  results: Record<string, SqlResult>
}

export class FencedBatch {
  private readonly statements: Named[] = []
  private readonly transactionLocks: SqlTransactionLock[] = []
  private readonly now: string
  private readonly tree: TreeDialect

  /**
   * @param label the batch's tracing and fault-injection address
   * @param seed  unique per invocation; every stamp this batch writes is
   *              `<seed>:<statement name>`
   * @param opts  the batch clock's SQL text, and the dialect that compiles its trees
   */
  constructor(
    readonly label: string,
    readonly seed: string,
    opts: { now: string; tree: TreeDialect },
  ) {
    // $NOW$ is spliced as raw SQL, so a bind inside it would desynchronize
    // every arg list in the batch.
    if (opts.now.includes('?')) {
      throw new Error(
        `FencedBatch[${label}] clock expression contains '?' — it is spliced as SQL, not bound`,
      )
    }
    // The type requires the dialect. Untyped code gets the same answer here, with the
    // batch's label, and not a read of undefined when its first statement compiles.
    if (typeof (opts.tree as TreeDialect | undefined)?.compile !== 'function') {
      throw new Error(
        `FencedBatch[${label}] needs the dialect that compiles its trees: pass it as \`tree\``,
      )
    }
    this.now = opts.now
    this.tree = opts.tree
    // The source audit proves that callers constructed this exact class, but
    // JavaScript reflection could otherwise replace run() after construction
    // and turn an already-authorized binding into an arbitrary executor door.
    // The statements array remains mutable, so the builder API still works;
    // only the instance's identity and own properties are sealed.
    Object.freeze(this)
  }

  /**
   * Serialize this event transition against every transition for the same
   * `(queue, eventName)` coordinate.
   *
   * The lock is a transaction prelude rather than a statement: callers name
   * only inert key data, while the dialect executor owns the lock SQL. It must
   * be declared before the batch's first statement, and the first statement
   * after it must be the fenced CAS whose branch the lock protects.
   */
  lockEvent(coordinates: { readonly queue: string; readonly eventName: EventName }): this {
    const { queue, eventName } = coordinates
    return this.addTransactionLock({ kind: 'event', queue, eventName: eventName?.value })
  }

  /**
   * Serialize same-token claim attempts before either selects candidates.
   * Candidate row locks alone are disjoint, so they cannot provide this gate.
   */
  lockClaim(coordinates: SqlClaimLockCoordinates): this {
    const { queue, claimToken } = coordinates
    return this.addTransactionLock({ kind: 'claim', queue, claimToken })
  }

  private addTransactionLock(lock: SqlTransactionLock): this {
    const coordinate = lock.kind === 'event' ? lock.eventName : lock.claimToken
    if (typeof lock.queue !== 'string' || typeof coordinate !== 'string') {
      throw new TypeError(
        `FencedBatch[${this.label}] ${lock.kind} lock coordinates must be strings`,
      )
    }
    if (this.statements.length !== 0) {
      throw new Error(
        `FencedBatch[${this.label}] ${lock.kind} lock must be declared before every SQL statement`,
      )
    }
    if (this.transactionLocks.length !== 0) {
      throw new Error(`FencedBatch[${this.label}] already has a transaction lock`)
    }
    this.transactionLocks.push(Object.freeze({ ...lock }))
    return this
  }

  /**
   * The provenance value written by an earlier stamp-writing statement.
   * Compiles to a bind of `<seed>:<name>`.
   */
  fence(name: string): string {
    this.requireFenceSource(name, `fence('${name}')`)
    return `$FENCE:${name}$`
  }

  /**
   * The check behind `fence()`, applied to EVERY fence token in a statement's
   * text — because the token `fence()` returns is ordinary text, so it can be
   * typed by hand and skip the call entirely. A hand-written
   * `$FENCE:whatever$` compiles to a bind of a value nothing in the batch ever
   * writes, so the statement matches no rows: silently, forever, with the
   * batch reporting success. That is worse than the bug the fence prevents,
   * since a follow-on that never runs looks exactly like one with nothing to
   * do. Enforcing here rather than in `fence()` makes the two spellings
   * equivalent instead of making one of them a hole.
   */
  private requireFenceSource(
    name: string,
    at: string,
  ): { target: FenceTable; sealedBy: string | null } {
    const source = this.statements.find((s) => s.name === name)
    if (!source) {
      throw new Error(
        `FencedBatch[${this.label}] ${at} names no statement of this batch — add it before the statement that fences on it`,
      )
    }
    if (source.fence === null) {
      throw new Error(
        `FencedBatch[${this.label}] ${at} names '${name}', which writes no stamp — there is no provenance to fence on`,
      )
    }
    if (source.fence.sealedBy !== null) {
      throw new Error(
        `FencedBatch[${this.label}] ${at}: fence '${name}' was already sealed by '${source.fence.sealedBy}' — later statements must depend on '${source.fence.sealedBy}'`,
      )
    }
    return source.fence
  }

  /**
   * A follow-on whose row set is GENERATED from the fence.
   *
   * This is the shape every UPDATE and DELETE follow-on should have, and the
   * reason is not tidiness. When the caller writes the WHERE clause, the
   * primitive can only inspect what the caller wrote. Every false negative this
   * primitive has ever had was in that inspection: a fence joined by OR, a fence
   * under `NOT (…)`, a WHERE inside a comment. Generating the selection removes
   * the thing being inspected.
   *
   *   UPDATE <target> SET <set>, <provenance>
   *   WHERE <key> IN (SELECT f.<column> FROM <from> f WHERE <where> AND f.fence_stamp = …)
   *     AND (<narrow>)
   *
   * The statement is built as a tree from the closed relation contract, and it
   * takes the tree path like any other tree statement, so the gating, stamping,
   * clock, and counting rules read what was generated. The caller's `where`,
   * `narrow`, and text values enter as fragments: bound, bracketed, and opaque.
   *
   * `narrow` is ANDed and parenthesised, so it can only ever SHRINK the set —
   * there is no way to write an alternative that widens it.
   *
   * A `'source-keys'` row declaration is a structural bound, not a post-commit
   * row-count alarm. The target key is selected from the paired source key in
   * the closed `FENCE_RELATIONS` ledger, and this method verifies that the fence
   * actually stamps that source table. Therefore the distinct target keys are
   * a subset of the stamped source keys by construction. Several physical rows
   * may share one logical key (for example, several waits for one run).
   *
   * For an UPDATE, `where`'s arguments are supplied once and bound twice, because the
   * correlation appears in both the provenance subquery and the row selection.
   * Callers were duplicating them by hand, which is its own quiet hazard.
   *
   * The presence of `set` selects UPDATE rather than DELETE. Assignment
   * targets come from the closed per-table contract; callers supply only
   * scalar right-hand sides, as text or as an expression built from nodes. A
   * value that reads the column it is assigned to must be nodes. Every UPDATE
   * target is a FenceTable and the primitive always generates its provenance.
   */
  derived<R extends FenceRelation>(name: string, spec: DerivedSpec<R>): this {
    return this.derivedInternal(name, spec, null)
  }

  private derivedInternal<R extends FenceRelation>(
    name: string,
    spec: InternalDerivedSpec<R>,
    sealedSelfKey: string | null,
  ): this {
    const relation = this.relation(spec.relation, `derived('${name}')`)
    const { key, from, column } = relation
    const target: GeneratedUpdateTarget = relation.target
    // The fence must exist and be unsealed. That it stamps the table this relation reads
    // is the tree path's gating rule, which compares the fence's table with the table
    // whose fence_stamp the generated selection reads.
    this.requireFenceSource(spec.fence, `derived('${name}')`)
    const assignments =
      spec.set === undefined ? [] : (Object.entries(spec.set) as Array<[string, DerivedValue]>)
    const allowedColumns = new TrustedSet<string>(DERIVED_WRITABLE_COLUMNS[target])
    if (sealedSelfKey !== null) allowedColumns.add(sealedSelfKey)
    for (const [column, expression] of assignments) {
      const isProvenanceColumn = /fence_(?:stamp|at_ms)/i.test(column)
      if (isProvenanceColumn) {
        throw new Error(
          `FencedBatch[${this.label}] derived('${name}') caller set controls provenance`,
        )
      }
      if (!isProvenanceColumn && !allowedColumns.has(column)) {
        throw new Error(
          `FencedBatch[${this.label}] derived('${name}') column '${column}' is not writable for ${target}`,
        )
      }
      if (typeof expression === 'string') {
        assertSetExpression(`FencedBatch[${this.label}] derived('${name}')`, column, expression)
      } else if (!isExpression(expression)) {
        throw new Error(
          `FencedBatch[${this.label}] derived('${name}') set value for '${column}' is neither SQL text nor an expression`,
        )
      }
    }
    // The source rows this statement follows: the rows of `from` that carry the fence,
    // narrowed by the caller's correlation. `rawSql` compiles a predicate inside
    // parentheses, for the same reason `narrow` is bracketed: AND binds tighter than OR,
    // so an unbracketed `a OR b` would compile to `a OR (b AND fence)` and let every row
    // matching `a` into the selection unstamped.
    // The closed relation contract owns queue correlation. Task/run ownership
    // is queue-scoped, while runs-to-waits deliberately follows authoritative
    // run_id through a corrupt denormalized wait queue so terminal cleanup can
    // remove the bad witness rather than strand it.
    // Each call builds fresh nodes, because a fragment stands in one place.
    // Live output never branches on the batch label. The mutation probe may inject a
    // label-scoped defect here, so one generated transition can be broken for its own
    // verdict without poisoning every other one.
    // A computed correlation that comes out empty must not widen the write to every row
    // under the fence, so empty text is refused, and so are arguments with no text.
    for (const [text, args] of [
      ['where', 'whereArgs'],
      ['narrow', 'narrowArgs'],
    ] as const) {
      if (spec[text] === '') {
        throw new Error(
          `FencedBatch[${this.label}] derived('${name}') ${text} is empty: omit it to correlate nothing`,
        )
      }
      if (spec[text] === undefined && (spec[args]?.length ?? 0) > 0) {
        throw new Error(
          `FencedBatch[${this.label}] derived('${name}') has ${args} and no ${text} to bind them`,
        )
      }
    }
    const whereArgs = spec.whereArgs ?? []
    const boundQueue = spec.queue
    if (boundQueue !== undefined && spec.set === undefined) {
      throw new Error(
        `FencedBatch[${this.label}] derived('${name}') binds a queue on a DELETE: no generated DELETE follows a queue-scoped relation, so nothing holds that shape`,
      )
    }
    if (boundQueue !== undefined && !relation.queueScoped) {
      throw new Error(
        `FencedBatch[${this.label}] derived('${name}') binds a queue, and '${spec.relation}' is not queue-scoped`,
      )
    }
    const fencedSource = () => {
      let rows = generatedBuilder.selectFrom(`${from} as f`)
      if (spec.where) {
        rows = rows.where(rawSql<boolean>(sqlFragment(spec.where, whereArgs), 'predicate'))
      }
      if (boundQueue !== undefined) rows = rows.where('f.queue', '=', boundQueue)
      else if (relation.queueScoped) rows = rows.whereRef('f.queue', '=', `${target}.queue`)
      return rows.where((eb) => eb(eb.ref('f.fence_stamp'), '=', fenceValue(spec.fence)))
    }
    // A self relation reads its own target. MySQL refuses that directly, so the keys go
    // through a derived table, which every dialect accepts.
    const sourceKeys =
      target === from
        ? generatedBuilder
            .selectFrom(
              fencedSource()
                .select((eb) => eb.ref(`f.${column}`).as('source_key'))
                .distinct()
                .as('fenced_source'),
            )
            .select('source_key')
        : fencedSource().select(`f.${column}`)
    const rows: RowBound = spec.rows === 'one' ? 'one' : { many: 'generated source-key bound' }
    const narrow = spec.narrow
      ? rawSql<boolean>(sqlFragment(spec.narrow, spec.narrowArgs ?? []), 'predicate')
      : null

    if (spec.set === undefined) {
      const selected = generatedBuilder
        .deleteFrom(target)
        .where((eb) => eb(eb.ref(key), 'in', sourceKeys))
      return this.addGenerated(name, narrow === null ? selected : selected.where(narrow), rows)
    }
    if (assignments.length === 0) {
      throw new Error(`FencedBatch[${this.label}] derived('${name}') UPDATE set cannot be empty`)
    }
    // Text values bind the caller's arguments in order, each taking as many as it holds.
    const setArgs = spec.setArgs ?? []
    const values: Record<string, Expression<unknown>> = {}
    let bound = 0
    for (const [assigned, expression] of assignments) {
      if (typeof expression !== 'string') {
        values[assigned] = expression
        continue
      }
      const binds = fragmentBinds(expression)
      values[assigned] = rawSql(
        sqlFragment(expression, setArgs.slice(bound, bound + binds)),
        'value',
      )
      bound += binds
    }
    if (bound !== setArgs.length) {
      throw new Error(
        `FencedBatch[${this.label}] derived('${name}') set binds ${bound} of its ${setArgs.length} arguments`,
      )
    }
    // A many-row source still carries one statement instant. Reduce it to one
    // SQL scalar explicitly: SQLite otherwise picks an arbitrary row while
    // PostgreSQL and MySQL reject the same subquery for returning several.
    const sourceInstant =
      target === from
        ? generatedBuilder
            .selectFrom(
              fencedSource()
                .select((eb) => eb.ref('f.fence_at_ms').as('source_fence_at_ms'))
                .distinct()
                .as('fenced_source_instant'),
            )
            .select((eb) => eb.fn.min('source_fence_at_ms').as('source_instant'))
        : fencedSource().select((eb) => eb.fn.min('f.fence_at_ms').as('source_instant'))
    // UPDATE always emits provenance: this statement's stamp, at the instant of the rows
    // it follows. The correlation therefore occurs once in the instant subquery and once
    // in the row selection, and the caller supplies its arguments once.
    let updated = generatedBuilder
      .updateTable(target)
      .set({ ...values, fence_stamp: stampValue, fence_at_ms: sourceInstant })
      .where((eb) => eb(eb.ref(key), 'in', sourceKeys))
    if (boundQueue !== undefined) updated = updated.where(`${target}.queue`, '=', boundQueue)
    return this.addGenerated(name, narrow === null ? updated : updated.where(narrow), rows)
  }

  /** A generated statement takes the tree path, so every tree rule reads what was generated. */
  private addGenerated(
    name: string,
    query: { toOperationNode(): StatementTree },
    rows: RowBound,
  ): this {
    const statement = defineStatement(`${this.label} ${name}`, () => query)({})
    return this.addTree('followOn', name, statement, atMostRows(rows))
  }

  private relation(name: FenceRelation, at: string): (typeof FENCE_RELATIONS)[FenceRelation] {
    if (!Object.prototype.hasOwnProperty.call(FENCE_RELATIONS, name)) {
      throw new Error(`FencedBatch[${this.label}] ${at} names unknown fence relation '${name}'`)
    }
    return FENCE_RELATIONS[name]
  }

  /**
   * Consume an intermediate fence after its last dependent statement.
   *
   * Exact replay can otherwise mistake a surviving source stamp for work this
   * execution just performed. The generated no-op UPDATE changes only
   * provenance, at the source's original instant, so later delivery of the
   * same compiled batch cannot re-run dependents keyed on the old statement.
   */
  seal(
    name: string,
    spec: Omit<DerivedSelection<SelfFenceRelation>, 'relation'> & {
      relation: SelfFenceRelation
    },
  ): this {
    const source = this.requireFenceSource(spec.fence, `seal('${name}')`)
    const relation = this.relation(spec.relation, `seal('${name}')`)
    if (relation.from !== relation.target || relation.key !== relation.column) {
      throw new Error(
        `FencedBatch[${this.label}] seal('${name}') relation '${spec.relation}' does not target its own source key`,
      )
    }
    this.derivedInternal(
      name,
      {
        ...spec,
        set: { [relation.key]: columnValue(relation.key) },
      },
      relation.key,
    )
    source.sealedBy = name
    return this
  }

  /**
   * Exactly-one-row compare-and-set. Wins iff it affected one row. It must write a
   * provenance-carrying table and stamp it from the clock.
   */
  casTree(name: string, statement: DefinedStatement): this {
    return this.addTree('cas', name, statement, 1)
  }

  /**
   * Up-to-`max`-row compare-and-set (the claim). Wins iff it affected at least one row;
   * `max` is asserted after the batch commits. Every row it touches carries this
   * statement's stamp, so per-row provenance is unaffected by the relaxed win rule.
   */
  casManyTree(name: string, statement: DefinedStatement, max: number): this {
    this.requireCasManyMax(name, max)
    return this.addTree('casMany', name, statement, max)
  }

  private requireCasManyMax(name: string, max: number): void {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(`FencedBatch[${this.label}] casMany '${name}' max must be a positive integer`)
    }
  }

  /**
   * A statement that runs meaningfully only when a CAS of this batch won. A fence must
   * gate it, and a write to a provenance-carrying table must stamp the rows it writes.
   */
  followOnTree(name: string, statement: DefinedStatement, rows: RowBound): this {
    return this.addTree('followOn', name, statement, atMostRows(rows))
  }

  /** A trailing SELECT that may only see rows this batch stamped: a fence gates it. */
  tailTree(name: string, statement: DefinedStatement): this {
    return this.addTree('tail', name, statement, null)
  }

  /**
   * A trailing SELECT of rows this batch did NOT write, so no fence gates it. Every
   * other tree rule still reads it. Legal, but rare and always deliberate: an unfenced
   * read is how a caller learns about state some other actor produced, and every one of
   * them is a judgement call.
   *
   * `reason` is a COMPILE-TIME forcing function, not runtime data. Nothing reads it back.
   * Its whole job is to make the author write the justification down, in the source,
   * beside the statement, where the next reader is looking. The emptiness check exists so
   * it cannot be satisfied with `''`.
   */
  openTailTree(name: string, reason: string, statement: DefinedStatement): this {
    if (reason.trim() === '') {
      throw new Error(`FencedBatch[${this.label}] openTail '${name}' needs a reason`)
    }
    return this.addTree('openTail', name, statement, null)
  }

  /** The batch-shape rules every statement passes. Returns the error prefix. */
  private admit(kind: Kind, name: string): string {
    const at = `FencedBatch[${this.label}] ${kind} '${name}'`
    if (
      this.transactionLocks.length !== 0 &&
      this.statements.length === 0 &&
      kind !== 'cas' &&
      kind !== 'casMany'
    ) {
      throw new Error(
        `FencedBatch[${this.label}] transaction lock must be followed immediately by a CAS`,
      )
    }
    if (!isFenceStatementName(name)) {
      throw new Error(`${at}: name must match ^${FENCE_STATEMENT_NAME_SOURCE}$`)
    }
    if (this.statements.some((x) => x.name === name)) {
      throw new Error(`FencedBatch[${this.label}] duplicate statement name '${name}'`)
    }
    return at
  }

  /**
   * Add a tree statement. Every rule reads the tree, inside a closed statement grammar:
   * the table it writes and whether it stamps that table, where each raw fragment
   * stands, the fences that gate it and the table each one stamps, the clock, and
   * assignments that count. It compiles once, here, so what was checked is what runs.
   *
   * Raw fragment text is the one thing a tree cannot read. Every raw node must come
   * from `rawSql`, which turns its binds and clock into nodes, and its text is scanned
   * for the batch clock's exact text and for clock spellings, as `scripts/clock-lint.py`
   * scans store sources.
   */
  private addTree(
    asked: Kind | 'openTail',
    name: string,
    statement: DefinedStatement,
    atMost: number | null,
  ): this {
    // An open tail is a tail in every way but one: no fence has to gate it.
    const open = asked === 'openTail'
    const kind: Kind = open ? 'tail' : asked
    const at = this.admit(kind, name)
    if (!isDefinedStatement(statement)) {
      throw new Error(`${at} must come from defineStatement, which refuses undefined binds`)
    }
    const { tree } = statement
    const grammar = statementGrammarProblem(tree)
    if (grammar !== null) {
      throw new Error(`${at} is outside the statement grammar: it holds ${grammar}`)
    }
    const isCas = kind === 'cas' || kind === 'casMany'
    if (kind === 'tail') {
      if (tree.kind !== 'SelectQueryNode') throw new Error(`${at} must be a SELECT`)
    } else if (
      tree.kind !== 'UpdateQueryNode' &&
      tree.kind !== 'InsertQueryNode' &&
      (isCas || tree.kind !== 'DeleteQueryNode')
    ) {
      throw new Error(
        `${at} must be an UPDATE${isCas ? ' or an INSERT' : ', a DELETE, or an INSERT … SELECT'}`,
      )
    }

    const written = statementTable(tree)
    const stamped = FENCED_TABLES.find((table) => table === written) ?? null
    if (isCas && stamped === null) {
      throw new Error(`${at} must write a provenance-carrying table`)
    }
    const inserted = insertProvenance(tree)
    const following = isCas ? null : followOnInsertProvenance(tree)
    if (following !== null) {
      // Only a SELECT can be gated, so only a SELECT can prove the batch won.
      if (!following.selects) {
        throw new Error(
          `${at} must select what it inserts from the fenced row: a follow-on INSERT takes a SELECT, never VALUES`,
        )
      }
      if (!following.plain) {
        throw new Error(
          `${at} must select plain columns and values built from nodes: an aggregate, a function call, or a HAVING can return a row the fence did not match, a SQL fragment can hide one, and the insert would write it`,
        )
      }
      if (!following.alone) {
        throw new Error(
          `${at} must select from the fenced row alone: one FROM item, the source whose fence_stamp the SELECT compares, with any join explicit and carrying its ON. A second FROM item inserts a row for every row of it, and a row bound is audited only after the batch has run`,
        )
      }
      if (
        stamped !== null &&
        (!following.stamp || !following.fencedInstants.includes('fence_at_ms'))
      ) {
        throw new Error(
          `${at} must insert fence_stamp as the stamp and fence_at_ms as the fenced row's own fence_at_ms into ${stamped}, once each (§3.4 rule 8)`,
        )
      }
      // A preserved first instant is engine time. A compare-and-set takes it from the
      // clock. A follow-on reads no clock, so it takes the fenced row's own instant, and
      // never a bind, another column, or a default.
      const preservedInstants: Partial<Record<FenceTable, string>> = PRESERVED_FENCE_INSTANTS
      const preservedInstant = stamped === null ? undefined : preservedInstants[stamped]
      if (preservedInstant !== undefined && !following.fencedInstants.includes(preservedInstant)) {
        throw new Error(
          `${at} must insert ${stamped}.${preservedInstant} as the fenced row's own fence_at_ms (§3.4 rule 3)`,
        )
      }
      // A conflict clause would let a collision with a foreign row pass in silence,
      // and later statements would then fence on a stamp this insert never wrote.
      if (stamped !== null && following.conflict) {
        throw new Error(
          `${at} may carry no conflict clause: a follow-on that inserts into ${stamped} inserts its row or fails`,
        )
      }
    }
    if (isCas && stamped !== null && inserted !== null) {
      if (!inserted.stamp || !inserted.clockInstant) {
        throw new Error(
          `${at} must insert fence_stamp as the stamp and fence_at_ms as the clock into ${stamped}, once each (§3.4 rule 8)`,
        )
      }
      // A fact with a preserved first instant takes that instant from the clock, like
      // every engine time, and a conflict leaves the fact alone.
      const preserved: Partial<Record<FenceTable, string>> = PRESERVED_FENCE_INSTANTS
      const column = preserved[stamped]
      if (column !== undefined && !inserted.clockColumns.includes(column)) {
        throw new Error(`${at} must insert ${stamped}.${column} as the clock (§3.4 rule 3)`)
      }
      // An upsert that leaves the conflicting row's provenance alone would let a later
      // statement fence on a stamp this batch never wrote there. A fact with a preserved
      // instant keeps it while taking the new stamp.
      if (inserted.conflict !== null) {
        const copied = inserted.conflict.copiedInstant
        const instant =
          column === undefined
            ? inserted.conflict.clockInstant
            : copied?.table === stamped && copied.column === column
        if (!inserted.conflict.stamp || !instant) {
          throw new Error(
            column === undefined
              ? `${at} does not re-stamp the row and its instant`
              : `${at} must preserve ${stamped}.${column} while re-stamping`,
          )
        }
        const provenance = ['fence_stamp', 'fence_at_ms']
        if (
          column !== undefined &&
          inserted.conflict.columns.some((name) => name === null || !provenance.includes(name))
        ) {
          throw new Error(
            `${at} may assign only fence_stamp and fence_at_ms on conflict, because a ${stamped} row is a preserved fact`,
          )
        }
      }
    }
    const stamps = stamped !== null && (tree.kind === 'UpdateQueryNode' || inserted !== null)
    if (stamps && inserted === null) {
      const stamp = writesStampAssignments(tree)
      if (!stamp.stamp || (isCas ? !stamp.clockInstant : !stamp.instant)) {
        throw new Error(
          isCas
            ? `${at} must assign fence_stamp the stamp and fence_at_ms the clock on ${stamped}, once each (§3.4 rule 8)`
            : `${at} writes ${stamped} but does not stamp it: assign fence_stamp the stamp and derive fence_at_ms from the fenced row, once each`,
        )
      }
    }

    const rawProblem = rawFragmentProblem(tree)
    if (rawProblem !== null) throw new Error(`${at} holds ${rawProblem}`)

    const compiled = this.tree.compile(tree, {
      now: this.now,
      stamp: `${this.seed}:${name}`,
      fence: (fence) => `${this.seed}:${fence}`,
    })
    for (const fence of compiled.fences) {
      this.requireFenceSource(fence, `the fence token for '${fence}'`)
    }
    // The statement whose stamp gates this one, for an executor that can skip a
    // statement that cannot match (`SqlStatement.skipUnlessWrote`). Only a tied gate of
    // a statement that must be gated counts: every top-level conjunct is ANDed, so one
    // gate that no row can satisfy is enough.
    let gatedBy: number | undefined
    if (!isCas) {
      const positional = gatingFences(tree)
      const gates = positional.filter((gate) => gate.tied)
      const gateName = open ? undefined : gates[0]?.fence
      const gateIndex = this.statements.findIndex((earlier) => earlier.name === gateName)
      // A skipped statement answers with no rows, which is also what it answers unmatched,
      // unless it answers with a row whatever it matched. That one is always sent.
      const alwaysAnswers = SelectQueryNode.is(tree) && !mayReturnNoRow(tree)
      if (gateIndex >= 0 && !alwaysAnswers) gatedBy = gateIndex
      if (!open && gates.length === 0 && positional.length !== 0) {
        throw new Error(
          `${at} is gated only by a subquery that is not tied to the rows it reads or writes: the subquery must read the fenced source alone, and either IN selects one plain column of it against a column of the outer row, or EXISTS equates a column of it with a column of the outer row (§3.4 rule 1)`,
        )
      }
      if (!open && gates.length === 0) {
        throw new Error(
          `${at} has no fence gating every row it reads or writes: a top-level WHERE conjunct must be fence_stamp = <a fence of this batch>, or require a row from a subquery gated that way (§3.4 rule 1)`,
        )
      }
      // Asked of every fence in a gating position, of an open tail's too: a fence
      // compared on a table its compare-and-set does not stamp never matches.
      for (const gate of positional) {
        const source = this.requireFenceSource(gate.fence, `the fence token for '${gate.fence}'`)
        if (source.target !== gate.table) {
          throw new Error(
            `${at}: fence '${gate.fence}' stamps '${source.target}', but the statement compares ${gate.table}.fence_stamp, which never matches`,
          )
        }
      }
    }

    const rawTexts = rawFragmentTexts(tree)
    // A compare-and-set may carry the batch clock's own text inside a fragment. Any
    // other spelling is a second clock.
    const spelledClock = rawTexts.some((text) =>
      CLOCK_SPELLING.test(isCas ? text.split(this.now).join(' ') : text),
    )
    // The clock token compiles to the batch clock's own text, so one comparison finds
    // the token and that text written into a fragment alike.
    if (!isCas && (spelledClock || compiled.sql.includes(this.now))) {
      throw new Error(clockReadRule(at))
    }
    if (spelledClock) {
      throw new Error(
        `${at} spells out a database clock: the only clock a statement may hold is the clock token, so a batch reads one clock expression`,
      )
    }
    // A fragment's binds equal its placeholders by construction. An operator or an
    // identifier built from nodes can still add a `?` that no argument binds.
    if (compiled.placeholders !== compiled.parameters.length) {
      throw bindCompilationError(
        `${at} compiles to ${compiled.placeholders} placeholders for ${compiled.parameters.length} arguments: an operator or identifier added a '?' that no argument binds`,
      )
    }
    if (kind === 'followOn') {
      const [counting] = selfCountingAssignments(tree)
      if (counting?.how === 'arithmetic') throw new Error(blindCounterRule(at))
      if (counting !== undefined) {
        throw new Error(
          `${at} assigns '${counting.column}' from a raw fragment that mentions '${counting.column}': the tree cannot see whether that counts, so build the self-reference from nodes`,
        )
      }
    }
    const args = compiled.parameters.map((value, index) => {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        value instanceof Uint8Array
      ) {
        return value
      }
      throw bindCompilationError(
        `${at} argument ${index} is ${value === undefined ? 'undefined' : typeof value}: bind a string, number, bigint, bytes, or null`,
      )
    })
    this.statements.push({
      name,
      kind,
      fence: stamps ? { target: stamped, sealedBy: null } : null,
      atMost,
      compiled: { sql: compiled.sql, args },
    })
    return this
  }

  async run(db: SqlExecutor, mode: SqlBatchMode = 'write'): Promise<FencedResult> {
    if (!this.statements.some((s) => s.kind === 'cas' || s.kind === 'casMany')) {
      throw new Error(`FencedBatch[${this.label}] has no CAS`)
    }
    const compiled = this.statements.map((s) => s.compiled)
    const transactionLock = this.transactionLocks[0]
    if (transactionLock !== undefined && mode !== 'write') {
      throw new Error(`FencedBatch[${this.label}] transaction lock requires a write batch`)
    }
    // Preserve the string control used by every existing libSQL transition.
    // Only a batch that explicitly declared a lock exercises the structured
    // control variant.
    const raw =
      transactionLock === undefined
        ? await db.batch(this.label, compiled, mode)
        : await db.batch(this.label, compiled, Object.freeze({ mode: 'write', transactionLock }))
    if (raw.length !== compiled.length) {
      throw new Error(
        `FencedBatch[${this.label}] executor returned ${raw.length} results for ${compiled.length} statements — the batch audit cannot run`,
      )
    }

    const results: Record<string, SqlResult> = {}
    let won: string | null = null
    let count = 0
    this.statements.forEach((s, i) => {
      const result = raw[i] as SqlResult
      results[s.name] = result
      const affected = result.rowsAffected
      if (s.kind === 'cas' || s.kind === 'casMany') {
        if (s.atMost !== null && affected > s.atMost) {
          throw new Error(
            `FencedBatch[${this.label}] ${s.kind} '${s.name}' affected ${affected} rows, at most ${s.atMost} allowed`,
          )
        }
        if (affected >= 1) {
          if (won !== null) {
            throw new Error(
              `FencedBatch[${this.label}]: CASes '${won}' and '${s.name}' both won — guards must be mutually exclusive`,
            )
          }
          won = s.name
          count = affected
        }
      } else if (s.atMost !== null && affected > s.atMost) {
        throw new Error(
          `FencedBatch[${this.label}] followOn '${s.name}' wrote ${affected} rows but declared 'one' — its target set is wider than the transition it follows`,
        )
      }
    })
    return { won, count, results }
  }
}

// An immutable instance still inherits its executor method. Seal that shared
// identity as well so mutating the prototype cannot rewrite every previously
// authenticated batch at once.
Object.freeze(FencedBatch.prototype)

/**
 * A caller supplies one scalar RHS; assignment structure stays generated. The tree
 * module reads the literals, so there is one reading of where a string ends.
 */
function assertSetExpression(at: string, column: string, expression: string): void {
  const structural = fragmentOutsideLiterals(expression)
  if (/--|\/\*|#/.test(structural)) {
    throw new Error(`${at} set expression for '${column}' contains a SQL comment`)
  }
  let depth = 0
  for (const ch of structural) {
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) {
        throw new Error(`${at} set expression for '${column}' has an unmatched ')'`)
      }
    } else if ((ch === ',' && depth === 0) || ch === ';') {
      throw new Error(`${at} set expression for '${column}' escapes its generated assignment`)
    }
  }
  // A literal takes two quotes and each quote escaped inside one takes two more, so an
  // odd count leaves a literal open, and everything after it was read as its contents.
  if ((expression.split("'").length - 1) % 2 !== 0) {
    throw new Error(`${at} set expression for '${column}' has an unterminated string`)
  }
  if (depth !== 0) {
    throw new Error(`${at} set expression for '${column}' has unbalanced parentheses`)
  }
}
