import { STORE_TABLE_COLUMNS } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  type PersistedNumericTable,
  executeStorageCorruption,
  nullEventPayload,
} from '../src/index.js'
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
      let heldByRefusal: { events?: { payload: { kind: string; nullable: boolean } } } = {}
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
        // for nothing else, so any other such column fails the comparison below.
        if (observed.events?.payload?.nullable && !STORE_TABLE_COLUMNS.events.payload.nullable) {
          await fixture.store.emitEvent('q', 'held', '{"kept":1}')
          expect(
            await executeStorageCorruption(fixture, nullEventPayload('q', 'held')),
            'the catalog calls events.payload nullable, so the schema has to refuse the write',
          ).toBe('structurally-rejected')
          heldByRefusal = { events: { payload: { kind: 'text', nullable: true } } }
        }
      })
      // What the catalog said stands as it was read. Where a refusal was seen in place of a
      // declaration, that one column is expected to read as the catalog reads it.
      expect(observed).toEqual({
        ...STORE_TABLE_COLUMNS,
        events: { ...STORE_TABLE_COLUMNS.events, ...heldByRefusal.events },
      })
    })
  }
})
