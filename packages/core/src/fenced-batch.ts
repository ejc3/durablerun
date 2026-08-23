import {
  DERIVED_WRITABLE_COLUMNS,
  type DerivedWritableColumn,
  FENCE_RELATIONS,
  FENCE_STATEMENT_NAME_SOURCE,
  type FenceRelation,
  type FenceTable,
  PRESERVED_FENCE_INSTANTS,
  type PreservedFenceTable,
  type SelfFenceRelation,
  isFenceStatementName,
} from './contract.js'
import { TASK_INTRINSICS } from './intrinsics.js'
import type { SqlBatchMode, SqlExecutor, SqlResult, SqlStatement } from './primitives.js'

/**
 * Structural enforcement of DESIGN.md §3.4 rules 1 and 8.
 *
 * A FencedBatch is one engine transition: one or more mutually exclusive
 * compare-and-set statements, each of which WRITES its own provenance into
 * the row it transitions, followed by statements that may only touch rows
 * carrying that provenance. The builder throws at construction time when a
 * statement does not have that shape, so "a losing batch still writes" and
 * "two clock reads in one batch" stop being mistakes to avoid and become
 * sentences you cannot say.
 *
 * Three things make it work, and each replaced a bug that shipped:
 *
 * 1. THE STAMP NAMES A STATEMENT, NOT A BATCH. `cas('a', …)` writes
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
 * 3. A FOLLOW-ON CANNOT READ THE CLOCK. `$NOW$` is rejected outside a CAS.
 *    Follow-ons derive instants from `fence_at_ms`, the one value the CAS
 *    recorded. Real libSQL and MySQL re-read the wall clock per statement —
 *    measured at ~2% divergence between two statements of one local batch —
 *    so any pair of statements that must agree on "now" eventually will not.
 *
 * Results come back by NAME; positional destructuring of batch results was
 * its own reviewed hazard.
 */

/** This statement's own provenance value: `<seed>:<statement name>`. */
export const STAMP = '$STAMP$'

/** The batch's clock expression, spliced as SQL. Legal only in a CAS. */
export const NOW = '$NOW$'

/** The single definition of the provenance write. Shared by every dialect. */
export const FENCE_SET = `fence_stamp = ${STAMP}, fence_at_ms = ${NOW}`
export const FENCE_COLS = `fence_stamp, fence_at_ms`
export const FENCE_VALS = `${STAMP}, ${NOW}`

const {
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
 * Re-stamp an immutable fact without moving the instant at which it became
 * true. The target selects a contract-owned stored instant; accepting an
 * arbitrary column here would let a caller give provenance a second meaning.
 */
export function fenceSetAt(target: PreservedFenceTable): string {
  const column = PRESERVED_FENCE_INSTANTS[target]
  if (column === undefined) {
    throw new Error(`${target} has no contract-preserved fence instant`)
  }
  return preservedFenceSet(target, column)
}

function preservedFenceSet(target: FenceTable, column: string): string {
  return `fence_stamp = ${STAMP}, fence_at_ms = ${target}.${column}`
}

/**
 * How many rows a statement may write. `'one'` is checked after the batch
 * commits; `{ many: reason }` costs a written justification, because
 * "this one really can touch many rows" is exactly the judgement that should
 * not be made silently.
 */
export type RowBound = 'one' | { many: string }

interface DerivedSelection<R extends FenceRelation = FenceRelation> {
  relation: R
  fence: string
  where?: string
  whereArgs?: SqlStatement['args']
  narrow?: string
  narrowArgs?: SqlStatement['args']
  rows: 'one' | 'source-keys'
}

type RelationTarget<R extends FenceRelation> = (typeof FENCE_RELATIONS)[R]['target']

/**
 * The non-null target carried by the generated-UPDATE construction path.
 *
 * Raw follow-ons and generated DELETEs may deliberately carry no stamped
 * target. Keeping the generated UPDATE's target in its own type prevents
 * that broader representation from making `null` an expressible UPDATE.
 */
export type GeneratedUpdateTarget = RelationTarget<FenceRelation>

type DerivedSet<R extends FenceRelation> = Partial<
  Record<DerivedWritableColumn<RelationTarget<R>>, string>
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
      set: Readonly<Partial<Record<string, string>>>
      setArgs?: SqlStatement['args']
    })

type Kind = 'cas' | 'casMany' | 'followOn' | 'tail'

interface Named {
  name: string
  sql: string
  args: SqlStatement['args']
  kind: Kind
  /** Present while this statement's stamp may still be consumed. */
  fence: { target: FenceTable; sealedBy: string | null } | null
  rows: RowBound | null
  max: number | null
}

interface GeneratedUpdate {
  name: string
  target: GeneratedUpdateTarget
  setSql: string
  sourceInstant: string
  selection: string
  narrow: string
  args: SqlStatement['args']
  rows: RowBound
}

/**
 * Closed builders receive the batch label as their stable executable mutation
 * address. Live output never branches on it; the mutation probe may inject a
 * label-scoped semantic defect without poisoning every generated transition.
 */
function generatedFencePredicate(prefix: string, fence: string, _batchLabel: string): string {
  return `${prefix}f.fence_stamp = ${fence}`
}

function generatedUpdateSql(update: GeneratedUpdate, _batchLabel: string): string {
  const provenance = `,\n         fence_stamp = ${STAMP},
         fence_at_ms = (${update.sourceInstant})`
  return `UPDATE ${update.target} SET ${update.setSql}${provenance}\n       WHERE (${update.selection}${update.narrow})`
}

/**
 * A blind counter bump (`attempts = attempts + 1`) is not idempotent: an
 * exact re-execution of the same compiled batch — same bound stamps —
 * re-matches its own stamped row and counts twice. Derive the value from the
 * winning row's post-state instead, so applying the statement twice is the
 * same as applying it once.
 *
 * Written out rather than as one dense expression because the first version
 * caught only `x = x + <digit>`, and `x = x + ?`, `x = t.x + 1`, `x = (x+1)`,
 * `x = 1 + x` and `x = x - 1` are all the same non-idempotent write. Anything
 * whose value comes from a DIFFERENT column, a subquery, or a literal is
 * idempotent and must still be allowed.
 */
const COLUMN = String.raw`(?:\w+\.)?"?(\w+)"?`
const SAME_COLUMN = String.raw`(?:\w+\.)?"?\1"?`
const BLIND_COUNTER = new RegExp(
  [
    String.raw`\b${COLUMN}\s*=\s*\(?\s*(?:`,
    String.raw`${SAME_COLUMN}\s*[-+]`, // x = x + n, x = x - n
    '|',
    String.raw`[\w?]+\s*\+\s*${SAME_COLUMN}\b`, // x = n + x
    ')',
  ].join(''),
  'i',
)

export interface FencedResult {
  /** The name of the CAS that won, or null if none did. */
  won: string | null
  /** Rows the winning CAS affected (1 for `cas`, up to `max` for `casMany`). */
  count: number
  results: Record<string, SqlResult>
}

export class FencedBatch {
  private readonly statements: Named[] = []
  private readonly now: string

  /**
   * @param label the batch's tracing and fault-injection address
   * @param seed  unique per invocation; every stamp this batch writes is
   *              `<seed>:<statement name>`
   */
  constructor(
    readonly label: string,
    readonly seed: string,
    opts: { now: string },
  ) {
    // $NOW$ is spliced as raw SQL, so a bind inside it would desynchronize
    // every arg list in the batch.
    if (opts.now.includes('?')) {
      throw new Error(
        `FencedBatch[${label}] clock expression contains '?' — it is spliced as SQL, not bound`,
      )
    }
    this.now = opts.now
    // The source audit proves that callers constructed this exact class, but
    // JavaScript reflection could otherwise replace run() after construction
    // and turn an already-authorized binding into an arbitrary executor door.
    // The statements array remains mutable, so the builder API still works;
    // only the instance's identity and own properties are sealed.
    Object.freeze(this)
  }

  /**
   * Exactly-one-row compare-and-set. Wins iff it affected one row. Must write
   * `FENCE_SET` (or, for an INSERT, `FENCE_COLS`/`FENCE_VALS`) into `target`.
   */
  cas(name: string, target: FenceTable, sql: string, args: SqlStatement['args'] = []): this {
    return this.add({ name, sql, args, kind: 'cas', target, rows: 'one', max: 1 })
  }

  /**
   * Up-to-`max`-row compare-and-set (the claim). Wins iff it affected at
   * least one row; `max` is asserted after the batch commits. Every row it
   * touches carries this statement's stamp, so per-row provenance is
   * unaffected by the relaxed win rule.
   */
  casMany(
    name: string,
    target: FenceTable,
    max: number,
    sql: string,
    args: SqlStatement['args'] = [],
  ): this {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(`FencedBatch[${this.label}] casMany '${name}' max must be a positive integer`)
    }
    return this.add({ name, sql, args, kind: 'casMany', target, rows: { many: 'CAS' }, max })
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
   * A statement that runs meaningfully only when a CAS of this batch won.
   * Pass `target` when it writes to a provenance-carrying table: it must then
   * stamp the rows it writes, so the audit and the builder agree about who
   * wrote them.
   */
  followOn(name: string, sql: string, args: SqlStatement['args'], rows: RowBound): this
  followOn(
    name: string,
    target: FenceTable,
    sql: string,
    args: SqlStatement['args'],
    rows: RowBound,
  ): this
  followOn(
    name: string,
    a: string | FenceTable,
    b: string | SqlStatement['args'],
    c: SqlStatement['args'] | RowBound,
    d?: RowBound,
  ): this {
    const targeted = d !== undefined
    return this.add({
      name,
      kind: 'followOn',
      target: targeted ? (a as FenceTable) : null,
      sql: targeted ? (b as string) : (a as string),
      args: (targeted ? c : b) as SqlStatement['args'],
      rows: (targeted ? d : c) as RowBound,
      max: null,
    })
  }

  /**
   * A follow-on whose row set is GENERATED from the fence.
   *
   * This is the shape every UPDATE and DELETE follow-on should have, and the
   * reason is not tidiness. When the caller writes the WHERE clause, the
   * primitive can only inspect the resulting text, and 126 lines of hand-rolled
   * SQL scanning here try to decide whether the fence actually reaches the rows
   * being written. Every false negative this primitive has ever had was in that
   * scanning: a fence joined by OR, a fence under `NOT (…)`, a WHERE inside a
   * comment. Generating the selection removes the thing being inspected.
   *
   *   UPDATE <target> SET <set>, <provenance>
   *   WHERE <key> IN (SELECT f.<column> FROM <from> f WHERE <where> AND f.fence_stamp = …)
   *     AND (<narrow>)
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
   * scalar right-hand sides. Every UPDATE target is a FenceTable and the
   * primitive always generates its provenance.
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
    const { target, key, from, column } = relation
    const source = this.requireFenceSource(spec.fence, `derived('${name}')`)
    if (source.target !== from) {
      throw new Error(
        `FencedBatch[${this.label}] derived('${name}') relation '${spec.relation}' reads '${from}', but fence '${spec.fence}' stamps '${source.target}'`,
      )
    }
    const assignments =
      spec.set === undefined ? [] : (Object.entries(spec.set) as Array<[string, string]>)
    const allowedColumns = new Set<string>(DERIVED_WRITABLE_COLUMNS[target])
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
      assertSetExpression(`FencedBatch[${this.label}] derived('${name}')`, column, expression)
    }
    // Parenthesised for the same reason `narrow` is: AND binds tighter than
    // OR, so an unbracketed `a OR b` would compile to `a OR (b AND fence)`
    // and let every row matching `a` into the selection unstamped. The
    // caller's text lands in a boolean position, so the primitive brackets
    // it rather than trusting it to be conjunctive.
    // The closed relation contract owns queue correlation. Task/run ownership
    // is queue-scoped, while runs-to-waits deliberately follows authoritative
    // run_id through a corrupt denormalized wait queue so terminal cleanup can
    // remove the bad witness rather than strand it.
    const queueOwnership = relation.queueScoped ? `f.queue = ${target}.queue AND ` : ''
    const src = `${spec.where ? `(${spec.where}) AND ` : ''}${queueOwnership}`
    const fence = `$FENCE:${spec.fence}$`
    const fencedSource = generatedFencePredicate(src, fence, this.label)
    const sourceKeys =
      target === from
        ? `SELECT source_key FROM (
                         SELECT DISTINCT f.${column} AS source_key FROM ${from} f
                          WHERE ${fencedSource}
                       ) AS fenced_source`
        : `SELECT f.${column} FROM ${from} f
                       WHERE ${fencedSource}`
    const selection = `${key} IN (${sourceKeys})`
    const narrow = spec.narrow ? `\n         AND (${spec.narrow})` : ''
    const w = spec.whereArgs ?? []

    if (spec.set === undefined) {
      return this.add({
        name,
        kind: 'followOn',
        target: null,
        sql: `DELETE FROM ${target}\n       WHERE (${selection}${narrow})`,
        args: [...w, ...(spec.narrowArgs ?? [])],
        rows: spec.rows === 'one' ? 'one' : { many: 'generated source-key bound' },
        max: null,
      })
    }
    if (assignments.length === 0) {
      throw new Error(`FencedBatch[${this.label}] derived('${name}') UPDATE set cannot be empty`)
    }
    const setSql = assignments
      .map(([column, expression]) => `${column} = ${expression}`)
      .join(',\n         ')
    // A many-row source still carries one statement instant. Reduce it to one
    // SQL scalar explicitly: SQLite otherwise picks an arbitrary row while
    // PostgreSQL and MySQL reject the same subquery for returning several.
    const sourceInstant =
      target === from
        ? `SELECT MIN(source_fence_at_ms) FROM (
                          SELECT DISTINCT f.fence_at_ms AS source_fence_at_ms FROM ${from} f
                           WHERE ${fencedSource}
                        ) AS fenced_source_instant`
        : `SELECT MIN(f.fence_at_ms) FROM ${from} f
                        WHERE ${fencedSource}`
    return this.addGeneratedUpdate({
      name,
      target,
      setSql,
      sourceInstant,
      selection,
      narrow,
      // UPDATE always emits provenance, so the correlation occurs once in its
      // instant subquery and once in its row selection. DELETE has no stamp to
      // write and returned through the branch above.
      args: [...(spec.setArgs ?? []), ...w, ...w, ...(spec.narrowArgs ?? [])],
      rows: spec.rows === 'one' ? 'one' : { many: 'generated source-key bound' },
    })
  }

  private addGeneratedUpdate(update: GeneratedUpdate): this {
    return this.add({
      name: update.name,
      target: update.target,
      sql: generatedUpdateSql(update, this.label),
      args: update.args,
      rows: update.rows,
      kind: 'followOn',
      max: null,
    })
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
        set: { [relation.key]: relation.key },
      },
      relation.key,
    )
    source.sealedBy = name
    return this
  }

  /** A trailing SELECT that may only see rows this batch stamped. */
  tail(name: string, sql: string, args: SqlStatement['args'] = []): this {
    return this.add({ name, sql, args, kind: 'tail', target: null, rows: null, max: null })
  }

  /**
   * A trailing SELECT of rows this batch did NOT write. Legal, but rare and
   * always deliberate: an unfenced read is how a caller learns about state
   * some other actor produced, and every one of them is a judgement call.
   *
   * `reason` is a COMPILE-TIME forcing function, not runtime data. Nothing
   * reads it back — its whole job is to make the author write the
   * justification down, in the source, beside the statement, where the next
   * reader is looking. The emptiness check exists so it cannot be satisfied
   * with `''`. An earlier version of this comment claimed the reason was
   * printed in the batch trace, which was never true; a comment describing a
   * mechanism that does not exist is worse than no comment, because it stops
   * the reader looking.
   */
  openTail(name: string, reason: string, sql: string, args: SqlStatement['args'] = []): this {
    if (reason.trim() === '') {
      throw new Error(`FencedBatch[${this.label}] openTail '${name}' needs a reason`)
    }
    return this.add({
      name,
      sql,
      args,
      kind: 'tail',
      target: null,
      rows: null,
      max: null,
      open: reason,
    })
  }

  private add(s: {
    name: string
    sql: string
    args: SqlStatement['args']
    kind: Kind
    target: FenceTable | null
    rows: RowBound | null
    max: number | null
    open?: string
  }): this {
    const { name, sql, kind, target } = s
    const at = `FencedBatch[${this.label}] ${kind} '${name}'`
    if (!isFenceStatementName(name)) {
      throw new Error(`${at}: name must match ^${FENCE_STATEMENT_NAME_SOURCE}$`)
    }
    if (this.statements.some((x) => x.name === name)) {
      throw new Error(`FencedBatch[${this.label}] duplicate statement name '${name}'`)
    }

    // Every fence token in the text, however it got there.
    for (const match of sql.matchAll(
      new RegExp(`\\$FENCE:(${FENCE_STATEMENT_NAME_SOURCE})\\$`, 'g'),
    )) {
      this.requireFenceSource(match[1] as string, `the fence token ${match[0]}`)
    }

    const isCas = kind === 'cas' || kind === 'casMany'
    const fence = target === null ? null : { target, sealedBy: null }
    const bare = blankComments(sql)
    const head = beforeTopLevelWhere(bare)

    if (isCas) {
      assertWritesStamp(at, bare, head, target as FenceTable, true)
    } else if (target !== null) {
      assertWritesStamp(at, bare, head, target, false)
    }

    if (kind === 'tail') {
      if (!/^\s*SELECT/i.test(sql)) throw new Error(`${at} must be a SELECT`)
    } else if (s.rows === null) {
      throw new Error(`${at} must declare how many rows it may write`)
    }

    // A follow-on or tail proves it is downstream of a win by FILTERING on a
    // fence, positively, in the WHERE side. A fence inside a SET-clause
    // subquery does not count: the statement would still match every row and
    // merely write a NULL into them. Neither does a fence that appears only
    // under NOT — that is a statement asserting the fence is ABSENT.
    if (!isCas && s.open === undefined && !hasPositiveFence(bare)) {
      throw new Error(
        `${at} has no positive fence in its WHERE clause — a follow-on must filter on fence('<a cas of this batch>') so a losing invocation matches nothing (§3.4 rule 1)`,
      )
    }

    // A fence joined by OR reaches nothing. Requiring the top-level WHERE to
    // be a pure AND-chain is what turns "the statement mentions a fence" into
    // "every row it writes satisfies the fence".
    if (!isCas && s.open === undefined && hasTopLevelOr(bare)) {
      throw new Error(
        `${at} has an OR at the top level of its WHERE clause — then the fence can be false while the row is still written. Narrow with AND, or move the alternation inside a subquery.`,
      )
    }

    // Class A dies here, with no exemptions: a follow-on has fence_at_ms to
    // derive from, so it never needs to ask the database what time it is.
    // The TOKEN and the expression it splices. Checking only the token left
    // the rule defeatable by interpolating the dialect's clock expression
    // directly — the same text, arrived at without saying `$NOW$`.
    if (!isCas && (sql.includes(NOW) || sql.includes(this.now))) {
      throw new Error(
        `${at} reads the clock — only a CAS may, and every later statement derives its instants from the fence_at_ms the CAS recorded (§3.4 rule 8)`,
      )
    }

    // Compilation replaces tokens by position and knows nothing about SQL
    // syntax, so a token sitting inside a string literal would be silently
    // turned into a bind parameter and change what the statement means. The
    // engine writes JSON constants into failure_reason, which is exactly the
    // place such a thing would appear.
    const quoted = literals(sql).find((text) => /\$STAMP\$|\$NOW\$|\$FENCE:/.test(text))
    if (quoted !== undefined) {
      throw new Error(
        `${at} has a fence token inside the string literal ${quoted} — tokens are substituted without parsing SQL, so it would become a bind parameter`,
      )
    }

    // Follow-ons only. A CAS is guarded on the pre-state it consumes, so a
    // replay of it matches nothing and its bump cannot run twice — claim
    // legitimately does `claim_gen = claim_gen + 1`. A follow-on has no such
    // guard: it keys on the post-state, which a replay reproduces exactly.
    // Checked against the WRITE clause with string literals blanked, so a
    // message that merely quotes the shape is not mistaken for the shape.
    if (kind === 'followOn' && BLIND_COUNTER.test(blankLiterals(head))) {
      throw new Error(
        `${at} bumps a counter blindly (x = x + n) — an exact replay of this batch re-matches its own stamped rows and counts twice; derive the value from the winning row's post-state instead`,
      )
    }

    this.statements.push({
      name,
      sql,
      args: s.args,
      kind,
      fence,
      rows: s.rows,
      max: s.max,
    })
    return this
  }

  async run(db: SqlExecutor, mode: SqlBatchMode = 'write'): Promise<FencedResult> {
    if (!this.statements.some((s) => s.kind === 'cas' || s.kind === 'casMany')) {
      throw new Error(`FencedBatch[${this.label}] has no CAS`)
    }
    const compiled = this.statements.map((s) => this.compile(s))
    const raw = await db.batch(this.label, compiled, mode)
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
        if (s.max !== null && affected > s.max) {
          throw new Error(
            `FencedBatch[${this.label}] ${s.kind} '${s.name}' affected ${affected} rows, at most ${s.max} allowed`,
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
      } else if (s.rows === 'one' && affected > 1) {
        throw new Error(
          `FencedBatch[${this.label}] followOn '${s.name}' wrote ${affected} rows but declared 'one' — its target set is wider than the transition it follows`,
        )
      }
    })
    return { won, count, results }
  }

  /**
   * `?`, `$STAMP$`, `$FENCE:x$` and `$NOW$` are consumed left to right, so
   * they may appear in any order relative to one another. `$NOW$` splices SQL
   * and consumes no argument slot; the other three each bind one value.
   */
  private compile(s: Named): SqlStatement {
    const tokens = new RegExp(
      `\\?|\\$STAMP\\$|\\$NOW\\$|\\$FENCE:${FENCE_STATEMENT_NAME_SOURCE}\\$`,
      'g',
    )
    let out = ''
    let last = 0
    let argIndex = 0
    const args: (string | number | bigint | Uint8Array | null)[] = []
    for (const match of s.sql.matchAll(tokens)) {
      const token = match[0]
      const start = match.index ?? 0
      out += s.sql.slice(last, start)
      last = start + token.length
      if (token === NOW) {
        out += this.now
        continue
      }
      out += '?'
      if (token === '?') {
        const index = argIndex++
        const value = s.args[index]
        // NOT coerced to null. The executor rejects an undefined bind because
        // an undefined reaching the driver becomes a driver throw, which the
        // store wraps as an outage, which the worker retries until the run's
        // infrastructure budget is gone — a typo reported as exhausted
        // infrastructure. Quietly substituting null here would instead send a
        // perfectly valid statement carrying a value the caller never meant,
        // and the executor's check would never see it: every protocol
        // operation goes through this compiler, so the coercion covered the
        // entire surface that check exists to protect.
        //
        // Only when the slot EXISTS: running off the end of a short argument
        // list also reads undefined, and the count mismatch below says
        // something far more useful about that.
        if (index < s.args.length && value === undefined) {
          throw bindCompilationError(
            `FencedBatch[${this.label}] '${s.name}' argument ${index} is undefined — bind null explicitly if that is what you mean`,
          )
        }
        args.push(value as string | number | bigint | Uint8Array | null)
      } else if (token === STAMP) {
        args.push(`${this.seed}:${s.name}`)
      } else {
        args.push(`${this.seed}:${token.slice('$FENCE:'.length, -1)}`)
      }
    }
    out += s.sql.slice(last)
    if (argIndex !== s.args.length) {
      throw bindCompilationError(
        `FencedBatch[${this.label}] '${s.name}' binds ${argIndex} of ${s.args.length} explicit args`,
      )
    }
    return { sql: out, args }
  }
}

// An immutable instance still inherits its executor method. Seal that shared
// identity as well so mutating the prototype cannot rewrite every previously
// authenticated batch at once.
Object.freeze(FencedBatch.prototype)

function assertWritesStamp(
  at: string,
  sql: string,
  head: string,
  target: FenceTable,
  isCas: boolean,
): void {
  if (!new RegExp(`\\b(?:UPDATE|INTO)\\s+${target}\\b`, 'i').test(sql)) {
    throw new Error(`${at} declares target '${target}' but does not write to it`)
  }
  if (/^\s*INSERT/i.test(sql)) {
    // A CAS supplies the clock; a follow-on may not read it, so it supplies
    // its own stamp and an instant derived from the row it follows.
    const values = isCas ? FENCE_VALS : `${STAMP},`
    if (!head.includes(FENCE_COLS) || !head.includes(values)) {
      throw new Error(
        `${at} must insert '${FENCE_COLS}' with values '${values} …' into ${target} (§3.4 rule 8)`,
      )
    }
    // An upsert that leaves the conflicting row's provenance alone would let
    // a later statement fence on a stamp this batch never wrote there.
    const conflictUpdate = conflictUpdateTail(sql)
    if (conflictUpdate !== null) {
      const preserved: Partial<Record<FenceTable, string>> = PRESERVED_FENCE_INSTANTS
      const column = preserved[target]
      const required = column === undefined ? FENCE_SET : preservedFenceSet(target, column)
      const stampWrites = conflictUpdate.match(/\bfence_stamp\s*=/gi)?.length ?? 0
      const instantWrites = conflictUpdate.match(/\bfence_at_ms\s*=/gi)?.length ?? 0
      if (
        stampWrites !== 1 ||
        instantWrites !== 1 ||
        !containsCompleteSet(conflictUpdate, required)
      ) {
        const requirement =
          column === undefined
            ? 'does not re-stamp the row and its instant'
            : `must preserve ${target}.${column} while re-stamping`
        throw new Error(`${at} ${requirement}`)
      }
    }
    return
  }
  if (isCas) {
    if (!head.includes(FENCE_SET)) {
      throw new Error(`${at} must set '${FENCE_SET}' on ${target} before its WHERE (§3.4 rule 8)`)
    }
    return
  }
  // A follow-on cannot read the clock, so it stamps with its own name and
  // derives the instant from the earlier fenced source row.
  if (!head.includes(`fence_stamp = ${STAMP}`) || !/\bfence_at_ms\s*=/.test(head)) {
    throw new Error(
      `${at} writes ${target} but does not stamp it — set 'fence_stamp = ${STAMP}' and derive fence_at_ms from the fenced row`,
    )
  }
}

/**
 * The assignment tail of either supported upsert spelling.
 *
 * PostgreSQL/SQLite say `ON CONFLICT … DO UPDATE SET`; MySQL says
 * `ON DUPLICATE KEY UPDATE`. Both are a second write door and therefore owe
 * the same complete provenance write as the insert arm.
 */
function conflictUpdateTail(sql: string): string | null {
  const structural = blankLiterals(sql)
  const match = /\b(?:DO\s+UPDATE\s+SET|ON\s+DUPLICATE\s+KEY\s+UPDATE)\s+([\s\S]*)$/i.exec(
    structural,
  )
  return match?.[1] ?? null
}

function containsCompleteSet(sql: string, set: string): boolean {
  const escaped = set.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`${escaped}\\s*(?=,|\\bWHERE\\b|$)`).test(sql)
}

/**
 * The SQL before the first WHERE at paren depth zero — i.e. what the
 * statement WRITES, as opposed to which rows it writes to. A WHERE inside a
 * subquery belongs to that subquery and does not end the write clause.
 * Returns the whole statement when there is no top-level WHERE.
 */
function beforeTopLevelWhere(sql: string): string {
  const at = topLevelWhere(sql)
  return at < 0 ? sql : sql.slice(0, at)
}

/** A caller supplies one scalar RHS; assignment structure stays generated. */
function assertSetExpression(at: string, column: string, expression: string): void {
  const structural = blankLiterals(expression)
  if (/--|\/\*|#/.test(structural)) {
    throw new Error(`${at} set expression for '${column}' contains a SQL comment`)
  }
  let depth = 0
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]
    if (ch === "'") {
      const end = skipString(expression, i)
      if (end >= expression.length) {
        throw new Error(`${at} set expression for '${column}' has an unterminated string`)
      }
      i = end
      continue
    }
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
  if (depth !== 0) {
    throw new Error(`${at} set expression for '${column}' has unbalanced parentheses`)
  }
}

function topLevelWhere(sql: string): number {
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i = skipString(sql, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (ch === 'W' || ch === 'w') && matchesWord(sql, i, 'WHERE')) return i
  }
  return -1
}

/**
 * This syntactic screen rejects common spellings where a fence cannot gate the
 * write: it must be in the WHERE side, outside negation, and not joined by a
 * top-level OR. `WHERE run_id = ? OR EXISTS (… fence …)` passed earlier
 * versions while a losing batch still deleted the named row.
 *
 * It does not prove semantic dominance. For example, a CASE can contain the
 * positive equality while returning true through another arm, and this
 * restricted scanner accepts it. Generated `derived()` selections close that
 * boundary structurally; raw `followOn()` SQL retains this documented
 * syntactic residual until SQL is represented as an AST.
 */
function hasPositiveFence(sql: string): boolean {
  const start = topLevelWhere(sql)
  if (start < 0) return false
  const negated = negatedSpans(sql)
  for (const match of sql.matchAll(
    new RegExp(`fence_stamp\\s*=\\s*\\$FENCE:${FENCE_STATEMENT_NAME_SOURCE}\\$`, 'g'),
  )) {
    const at = match.index ?? 0
    if (at < start) continue
    if (negated.some(([from, to]) => at >= from && at < to)) continue
    return true
  }
  return false
}

/**
 * A top-level OR in the WHERE clause: any conjunct — including the fence —
 * can then be false while the statement still writes the row.
 */
function hasTopLevelOr(sql: string): boolean {
  const start = topLevelWhere(sql)
  if (start < 0) return false
  let depth = 0
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i = skipString(sql, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (ch === 'O' || ch === 'o') && matchesWord(sql, i, 'OR')) return true
  }
  return false
}

/**
 * `[from, to)` ranges whose truth is inverted by NOT. Covers parenthesized
 * operands with or without separating whitespace (`NOT (…)`, `NOT(…)`,
 * `NOT EXISTS (…)`), bare predicates (`NOT fence_stamp = …`), and the
 * right-hand side of `IS NOT`. In `IS NOT NULL AND fence = …`, the span ends
 * before the peer AND, so the positive fence remains usable. A fence equality
 * inside one of these ranges does not prove authority and cannot gate a write.
 */
function negatedSpans(sql: string): [number, number][] {
  const spans: [number, number][] = []
  const where = topLevelWhere(sql)
  if (where < 0) return spans
  for (let i = where; i < sql.length; i++) {
    if (sql[i] === "'") {
      i = skipString(sql, i)
      continue
    }
    if (!matchesWord(sql, i, 'NOT')) continue
    let operand = skipWhitespace(sql, i + 3)
    if (matchesWord(sql, operand, 'EXISTS')) {
      operand = skipWhitespace(sql, operand + 'EXISTS'.length)
    } else if (matchesWord(sql, operand, 'IN')) {
      operand = skipWhitespace(sql, operand + 'IN'.length)
    }

    if (sql[operand] === '(') {
      spans.push([operand, matchingParen(sql, operand)])
    } else {
      spans.push([operand, unaryOperandEnd(sql, operand)])
    }
  }
  return spans
}

function skipWhitespace(sql: string, at: number): number {
  let i = at
  while (i < sql.length && /\s/.test(sql[i] ?? '')) i++
  return i
}

/** End of a bare unary predicate: the next peer AND/OR or enclosing `)`. */
function unaryOperandEnd(sql: string, start: number): number {
  let depth = 0
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i = skipString(sql, i)
      continue
    }
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      if (depth === 0) return i
      depth--
      continue
    }
    if (
      depth === 0 &&
      (((ch === 'A' || ch === 'a') && matchesWord(sql, i, 'AND')) ||
        ((ch === 'O' || ch === 'o') && matchesWord(sql, i, 'OR')))
    ) {
      return i
    }
  }
  return sql.length
}

/** The statement with every `--` and block comment replaced by spaces. */
function blankComments(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "'") {
      const end = skipString(sql, i)
      out += sql.slice(i, end + 1)
      i = end
      continue
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? sql.length : end
      out += ' '.repeat(stop - i)
      i = stop - 1
      continue
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i)
      const stop = end < 0 ? sql.length : end + 2
      out += ' '.repeat(stop - i)
      i = stop - 1
      continue
    }
    out += sql[i]
  }
  return out
}

function matchingParen(sql: string, open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i = skipString(sql, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i + 1
  }
  return sql.length
}

/** The statement with every string literal's contents replaced by spaces. */
function blankLiterals(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") {
      out += sql[i]
      continue
    }
    const end = skipString(sql, i)
    out += `'${' '.repeat(Math.max(0, end - i - 1))}'`
    i = end
  }
  return out
}

/** Every single-quoted string literal in the statement, quotes included. */
function literals(sql: string): string[] {
  const out: string[] = []
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") continue
    const end = skipString(sql, i)
    out.push(sql.slice(i, end + 1))
    i = end
  }
  return out
}

/** Index of the closing quote of the string literal starting at `i`. */
function skipString(sql: string, i: number): number {
  for (let j = i + 1; j < sql.length; j++) {
    if (sql[j] !== "'") continue
    if (sql[j + 1] === "'") {
      j++
      continue
    }
    return j
  }
  return sql.length
}

function matchesWord(sql: string, at: number, word: string): boolean {
  if (sql.slice(at, at + word.length).toUpperCase() !== word) return false
  const before = at === 0 ? ' ' : (sql[at - 1] ?? ' ')
  const after = sql[at + word.length] ?? ' '
  return !/[\w$]/.test(before) && !/[\w$]/.test(after)
}
