import { STORE_TABLE_COLUMNS, type SqlExecutor } from '@durablerun/core'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresStoreAdmin } from '../src/admin.js'
import { openPostgresTestDb } from '../src/testing.js'

/**
 * Every text column of the schema compares and orders by its bytes, as the other two
 * dialects do (DESIGN.md §3.4 rule 11). A PostgreSQL text column that declares nothing
 * takes the collation of its database, and under a linguistic one a caller's names come
 * back in an order no other dialect returns. The catalog is the witness here, and not the
 * migration's text: a column that a later migration adds without the declaration is
 * reported by name, whatever collation the server under test has. This needs a server.
 */
describe('PostgreSQL text collation', () => {
  it('declares the byte collation on every text column and every index key', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'text-collation' })
    const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
    await client.connect()
    try {
      // A column has a collation exactly when its type can be collated, so the join
      // keeps text of every spelling and drops the integers.
      const columns = await client.query<{ name: string; collation: string }>(
        `SELECT c.relname || '.' || a.attname AS name, co.collname AS collation
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_collation co ON co.oid = a.attcollation
          WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY 1`,
        [db.schemaName],
      )
      expect(
        columns.rows.filter(({ collation }) => collation !== 'C').map(({ name }) => name),
        'mutation-verdict:behavior:postgres-text-column-keeps-database-collation',
      ).toEqual([])
      // The read cannot pass by finding nothing: every text column core names is in it.
      const found = new Set(columns.rows.map(({ name }) => name))
      const named = Object.entries(STORE_TABLE_COLUMNS).flatMap(([table, specs]) =>
        Object.entries(specs)
          .filter(([, spec]) => spec.kind === 'text')
          .map(([column]) => `${table}.${column}`),
      )
      expect(named.filter((name) => !found.has(name))).toEqual([])
      expect(named.length).toBeGreaterThan(30)

      // An index orders by its own collation, which it took from its column when it was
      // built. Changing a column's collation rebuilds its indexes, and this holds that.
      const keys = await client.query<{ name: string; collation: string }>(
        `SELECT i.relname || ' key ' || k.ordinal AS name, co.collname AS collation
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid
           CROSS JOIN LATERAL unnest(x.indcollation::oid[]) WITH ORDINALITY AS k(collation_oid, ordinal)
           JOIN pg_collation co ON co.oid = k.collation_oid
          WHERE t.relnamespace = $1::regnamespace
          ORDER BY 1`,
        [db.schemaName],
      )
      expect(
        keys.rows.filter(({ collation }) => collation !== 'C').map(({ name }) => name),
      ).toEqual([])
      expect(keys.rows.length).toBeGreaterThan(10)
    } finally {
      await client.end()
      await db.close()
    }
  })

  // A read batch holds a snapshot taken before it resolves names, and PostgreSQL shows a
  // rewritten table as empty to a snapshot older than the rewrite (schema.ts). Changing a
  // text column's collation changes no stored byte, so it rebuilds indexes and keeps the
  // table's file, and that holds for every version: a table that exists before a
  // migration's batch has the same file after it.
  it('migrates without rewriting a table', async () => {
    const db = await openPostgresTestDb({ idNamespace: 'text-collation-heaps', migrate: false })
    const client = new Client({ connectionString: process.env.DURABLERUN_POSTGRES_URL })
    await client.connect()
    try {
      const files = async (): Promise<Map<string, string>> => {
        const tables = await client.query<{ name: string; file: string }>(
          `SELECT c.relname AS name, c.relfilenode::text AS file
             FROM pg_class c
            WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'`,
          [db.schemaName],
        )
        return new Map(tables.rows.map(({ name, file }) => [name, file]))
      }
      const rewritten: string[] = []
      const tablesBefore = new Map<string, number>()
      const recorder: SqlExecutor = {
        batch: async (label, statements, control) => {
          if (!/^migrate:v[0-9]+$/.test(label)) return db.raw.batch(label, statements, control)
          const before = await files()
          const results = await db.raw.batch(label, statements, control)
          const after = await files()
          tablesBefore.set(label, before.size)
          for (const [table, file] of before) {
            if (after.get(table) !== file) rewritten.push(`${label} rewrote ${table}`)
          }
          return results
        },
      }
      await new PostgresStoreAdmin(recorder).migrate()
      expect(
        rewritten,
        'mutation-verdict:behavior:postgres-collation-migration-rewrites-a-table',
      ).toEqual([])
      // The version that changes every collation ran here, over every table.
      expect(tablesBefore.get('migrate:v7')).toBe(8)
    } finally {
      await client.end()
      await db.close()
    }
  })
})
