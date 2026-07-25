import type { SqlBatchMode, SqlExecutor, SqlResult, SqlStatement } from './primitives.js'

/**
 * Structural enforcement of §3.4 rule 1 (prevention, per the standing rule:
 * three hand-written batches violated the "plus the batch's own stamp" rule
 * in one PR — rules held by discipline decay at generation speed).
 *
 * A FencedBatch is a single-item engine transition: one or more mutually
 * exclusive CAS statements that WRITE the batch's stamp into the row they
 * win, followed by follow-on statements that may only key on that stamp.
 * The builder throws at construction time unless every CAS and every
 * follow-on references the STAMP placeholder — "loser executes a follow-on"
 * becomes inexpressible, which is exactly the atomic-action semantics the
 * TLA+ model assumes of each labeled batch. Results come back by NAME
 * (positional blank-slot destructuring was the other reviewed hazard).
 */

export const STAMP = '$STAMP$'

interface Named {
  name: string
  sql: string
  args: SqlStatement['args']
  kind: 'cas' | 'followOn' | 'fanOut' | 'tail'
}

/**
 * A blind counter bump in a follow-on (`attempts = attempts + 1`) is not
 * idempotent: an exact re-execution of the same compiled batch — same bound
 * stamp — re-matches its own stamped row and counts twice. Follow-ons must
 * derive a counter from the winning row's post-state instead (e.g.
 * `attempts = (SELECT r.attempt - t.infra_retries FROM ...)`), so applying
 * the statement twice is the same as applying it once.
 */
const BLIND_COUNTER = /\b(\w+)\s*=\s*\1\s*\+\s*\d/i

export class FencedBatch {
  private readonly statements: Named[] = []

  constructor(
    readonly label: string,
    readonly stamp: string,
  ) {}

  /** A guarded CAS that stamps the row it transitions. Multiple CASes are
   * allowed when their guards are mutually exclusive (e.g. under-cap vs
   * at-cap); exactly one may win. */
  cas(name: string, sql: string, args: SqlStatement['args'] = []): this {
    this.push(name, sql, args, 'cas')
    return this
  }

  /** Executes meaningfully only when a CAS of THIS batch won — enforced by
   * requiring the stamp in the statement text. */
  followOn(name: string, sql: string, args: SqlStatement['args'] = []): this {
    this.push(name, sql, args, 'followOn')
    return this
  }

  /**
   * A follow-on that writes MANY rows discovered through the CAS's own
   * post-state (emitEvent waking every registered waiter): there is no single
   * stamped row to key on, so the gate is the CAS having won plus a join that
   * derives the targets from rows this batch just transitioned. The statement
   * must therefore reference the stamp (like any follow-on) OR name the
   * provenance table in `via` — the rows whose existence this batch caused.
   * Never a bare id list supplied by the caller: that is the "keyed on a
   * pre-existing post-state" hazard this class exists to forbid.
   */
  fanOut(name: string, via: string, sql: string, args: SqlStatement['args'] = []): this {
    if (!sql.includes(STAMP) && !sql.includes(via)) {
      throw new Error(
        `FencedBatch[${this.label}] fanOut '${name}' references neither ${STAMP} nor its provenance table '${via}' — a fan-out must derive its targets from this batch's own post-state (§3.4 rule 1)`,
      )
    }
    if (this.statements.some((s) => s.name === name)) {
      throw new Error(`FencedBatch[${this.label}] duplicate statement name '${name}'`)
    }
    this.statements.push({ name, sql, args, kind: 'fanOut' })
    return this
  }

  /** Unfenced trailing read (classification only — never a write). */
  tail(name: string, sql: string, args: SqlStatement['args'] = []): this {
    if (!/^\s*SELECT/i.test(sql)) {
      throw new Error(`FencedBatch[${this.label}] tail '${name}' must be a SELECT`)
    }
    this.statements.push({ name, sql, args, kind: 'tail' })
    return this
  }

  private push(name: string, sql: string, args: SqlStatement['args'], kind: 'cas' | 'followOn') {
    if (!sql.includes(STAMP)) {
      throw new Error(
        `FencedBatch[${this.label}] ${kind} '${name}' does not reference ${STAMP} — every CAS must write the stamp and every follow-on must key on it (§3.4 rule 1)`,
      )
    }
    if (kind === 'followOn' && BLIND_COUNTER.test(sql)) {
      throw new Error(
        `FencedBatch[${this.label}] followOn '${name}' bumps a counter blindly (x = x + n) — an exact replay of this batch re-matches its own stamped row and counts twice; derive the value from the winning row's post-state instead`,
      )
    }
    if (this.statements.some((s) => s.name === name)) {
      throw new Error(`FencedBatch[${this.label}] duplicate statement name '${name}'`)
    }
    this.statements.push({ name, sql, args, kind })
  }

  async run(
    db: SqlExecutor,
    mode: SqlBatchMode = 'write',
  ): Promise<{ won: string | null; results: Record<string, SqlResult> }> {
    const casCount = this.statements.filter((s) => s.kind === 'cas').length
    if (casCount === 0) throw new Error(`FencedBatch[${this.label}] has no CAS`)
    const compiled: SqlStatement[] = this.statements.map((s) => compile(s, this))
    const raw = await db.batch(this.label, compiled, mode)
    const results: Record<string, SqlResult> = {}
    let won: string | null = null
    this.statements.forEach((s, i) => {
      const result = raw[i]
      if (!result) return
      results[s.name] = result
      if (s.kind === 'cas' && result.rowsAffected === 1) {
        if (won !== null) {
          throw new Error(
            `FencedBatch[${this.label}]: CASes '${won}' and '${s.name}' both won — guards must be mutually exclusive`,
          )
        }
        won = s.name
      }
    })
    return { won, results }
  }
}

/**
 * Interleaved compilation: `?` and STAMP occurrences are consumed
 * left-to-right, so stamps may appear anywhere relative to explicit binds.
 */
function compile(s: { sql: string; args: SqlStatement['args'] }, batch: FencedBatch): SqlStatement {
  const tokenRe = /\?|\$STAMP\$/g
  let out = ''
  let last = 0
  let argIndex = 0
  const args: (string | number | bigint | Uint8Array | null)[] = []
  for (const match of s.sql.matchAll(tokenRe)) {
    out += `${s.sql.slice(last, match.index)}?`
    last = (match.index ?? 0) + match[0].length
    if (match[0] === '?') {
      const value = s.args[argIndex++]
      args.push(value === undefined ? null : value)
    } else {
      args.push(batch.stamp)
    }
  }
  out += s.sql.slice(last)
  if (argIndex !== s.args.length) {
    throw new Error(
      `FencedBatch[${batch.label}]: statement binds ${argIndex} of ${s.args.length} explicit args`,
    )
  }
  return { sql: out, args }
}
