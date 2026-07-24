import { type Client, createClient } from '@libsql/client'
import {
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  StoreUnavailableError,
} from '@durablerun/core'

/**
 * SqlExecutor over @libsql/client. `batch(…, 'write')` is atomic — implicit
 * BEGIN IMMEDIATE, full rollback on any failure — which is the entire
 * transactional model this engine is allowed to use on Turso (no interactive
 * transactions; DESIGN.md §1.3). 'read' batches never take the writer lock.
 * The label is a tracing/crash-injection address for harness wrappers; the
 * real executor ignores it.
 *
 * Normalizations (backend contract tests pin these, per the standing rule —
 * backend divergence gets caught at the primitive, not in engine logic):
 * - rowsAffected: the local client hardcodes 0 for DML…RETURNING while the
 *   remote hrana path reports the real count — normalized to rows.length for
 *   any row-returning statement, so fence checks read one consistent value.
 * - Blobs arrive as ArrayBuffer (local wraps Buffer.buffer) — normalized to
 *   the Uint8Array the SqlRow contract promises.
 */
export class LibsqlExecutor implements SqlExecutor {
  private pragmas: Promise<void> | null = null

  constructor(
    private readonly client: Client,
    private readonly fileBacked = false,
  ) {}

  static open(url: string, authToken?: string): LibsqlExecutor {
    const fileBacked = url.startsWith('file:') && !url.includes(':memory:')
    return new LibsqlExecutor(createClient(authToken ? { url, authToken } : { url }), fileBacked)
  }

  /**
   * Multi-PROCESS operation on one database file needs write-ahead logging
   * (readers stop blocking the writer) and a busy timeout (a locked write
   * waits instead of failing) — per connection. PRAGMAs cannot run inside
   * a transaction, so this happens once, outside batch(), lazily before
   * the first one.
   */
  private applyConnectionPragmas(): Promise<void> {
    this.pragmas ??= (async () => {
      await this.client.execute('PRAGMA journal_mode=WAL')
      await this.client.execute('PRAGMA busy_timeout=5000')
    })()
    return this.pragmas
  }

  async batch(
    _label: string,
    statements: readonly SqlStatement[],
    mode: SqlBatchMode = 'write',
  ): Promise<SqlResult[]> {
    let results: Awaited<ReturnType<Client['batch']>>
    try {
      if (this.fileBacked) await this.applyConnectionPragmas()
      results = await this.client.batch(
        statements.map((s) => ({ sql: s.sql, args: [...s.args] })),
        mode,
      )
    } catch (error) {
      // Typed so consumers can classify INFRASTRUCTURE failure by type —
      // a store outage must never be mistaken for a user failure.
      throw new StoreUnavailableError(`batch(${_label}) failed: ${String(error)}`, {
        cause: error,
      })
    }
    return results.map((r) => ({
      rows: r.rows.map((row) => {
        const out: Record<string, string | number | bigint | Uint8Array | null> = {}
        for (const col of r.columns) {
          const v = row[col]
          out[col] =
            v instanceof ArrayBuffer
              ? new Uint8Array(v)
              : v === undefined
                ? null
                : (v as string | number | bigint | Uint8Array | null)
        }
        return out
      }),
      rowsAffected: r.columns.length > 0 ? r.rows.length : r.rowsAffected,
    }))
  }

  close(): void {
    this.client.close()
  }
}
