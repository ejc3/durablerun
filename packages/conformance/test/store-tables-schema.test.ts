import { STORE_TABLE_COLUMNS } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { PersistedNumericTable } from '../src/index.js'
import { withFixture } from '../src/scenario.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

/** Catalog columns the statement builder leaves out on purpose: no tree statement names them yet. */
const OMITTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ['completed_payload'],
  checkpoints: ['status'],
}

function columnKind(nativeType: string): string {
  const type = nativeType.toLowerCase()
  if (type.includes('int')) return 'integer'
  return type.includes('text') || type.includes('char') ? 'text' : type
}

describe('statement builder tables', () => {
  for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
    it(`${dialect}: every builder column matches the catalog, and nothing else is missing`, async () => {
      const tables = Object.keys(STORE_TABLE_COLUMNS) as PersistedNumericTable[]
      const observed: Record<
        string,
        Record<string, { kind: string; nullable: boolean }>
      > = Object.fromEntries(tables.map((table) => [table, {}]))
      await withFixture(makeFixture, `store-tables-${dialect}`, async (fixture) => {
        const results = await fixture.raw.batch(
          't',
          fixture.persistedIntegerCatalogStatements(tables),
          'read',
        )
        for (const row of results.flatMap((result) => result.rows)) {
          const columns = observed[String(row.table_name)]
          if (columns === undefined) throw new Error(`unexpected table ${String(row.table_name)}`)
          columns[String(row.column_name)] = {
            kind: columnKind(String(row.native_type)),
            nullable: Number(row.nullable) === 1,
          }
        }
      })
      for (const table of tables) {
        const columns = observed[table] ?? {}
        for (const omitted of OMITTED_COLUMNS[table] ?? []) {
          expect(Object.keys(columns)).toContain(omitted)
          delete columns[omitted]
        }
      }
      expect(observed).toEqual(STORE_TABLE_COLUMNS)
    })
  }
})
