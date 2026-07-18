import { type Client, createClient } from '@libsql/client'
import type { SqlExecutor, SqlResult, SqlStatement } from '@absurd-lite/core'

/**
 * SqlExecutor over @libsql/client. `batch(…, 'write')` is atomic — implicit
 * BEGIN IMMEDIATE, full rollback on any failure — which is the entire
 * transactional model this engine is allowed to use on Turso (no interactive
 * transactions; DESIGN.md §1.3). The label is a tracing/crash-injection
 * address for harness wrappers; the real executor ignores it.
 */
export class LibsqlExecutor implements SqlExecutor {
  constructor(private readonly client: Client) {}

  static open(url: string, authToken?: string): LibsqlExecutor {
    return new LibsqlExecutor(createClient(authToken ? { url, authToken } : { url }))
  }

  async batch(_label: string, statements: readonly SqlStatement[]): Promise<SqlResult[]> {
    const results = await this.client.batch(
      statements.map((s) => ({ sql: s.sql, args: [...s.args] })),
      'write',
    )
    return results.map((r) => ({
      rows: r.rows.map((row) => {
        const out: Record<string, string | number | bigint | Uint8Array | null> = {}
        for (const col of r.columns) {
          const v = row[col]
          out[col] = v === undefined ? null : (v as string | number | bigint | Uint8Array | null)
        }
        return out
      }),
      rowsAffected: r.rowsAffected,
    }))
  }

  close(): void {
    this.client.close()
  }
}
