import { STORE_TABLE_COLUMNS } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { type PersistedNumericTable, executeStorageCorruption } from '../src/index.js'
import { withFixture } from '../src/scenario.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

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
        // One rule for every dialect: a column the builder declares NOT NULL is NOT NULL in
        // the catalog, or the schema is seen to refuse a raw write of NULL to it. SQLite
        // cannot add NOT NULL to a column that exists, so a dialect may hold a column with
        // triggers, which no catalog read of the column shows. The write goes through the
        // fixture's storage-corruption door, which has a kind for an event's payload and
        // for nothing else, so any other such column fails here until it has one.
        for (const [table, columns] of Object.entries(STORE_TABLE_COLUMNS)) {
          for (const [column, declared] of Object.entries(columns)) {
            const seen = observed[table]?.[column]
            if (declared.nullable || seen === undefined || !seen.nullable) continue
            if (table !== 'events' || column !== 'payload') continue
            await fixture.store.emitEvent('q', 'held', '{"kept":1}')
            const disposition = await executeStorageCorruption(fixture, {
              table: 'events',
              queue: 'q',
              eventName: 'held',
              column: 'payload',
              invalidRepresentation: 'null',
            })
            if (disposition === 'structurally-rejected') seen.nullable = false
          }
        }
      })
      expect(observed).toEqual(STORE_TABLE_COLUMNS)
    })
  }
})
