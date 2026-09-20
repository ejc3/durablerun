import { createHash } from 'node:crypto'
import { PERSISTED_COUNTER_FIELDS, PERSISTED_TEMPORAL_FIELDS } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  META_TABLE_SQL,
  MIGRATIONS,
  createIndexIfMissing,
} from '../src/schema.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function columnDeclaration(table: string, column: string): string | undefined {
  const tableName = escapeRegExp(table)
  const columnName = escapeRegExp(column)
  for (const statement of MIGRATIONS.flatMap(({ statements }) => statements)) {
    if (!new RegExp(`^CREATE TABLE IF NOT EXISTS ${tableName} \\(`).test(statement)) continue
    const line = statement
      .split('\n')
      .map((candidate) => candidate.trim().replace(/,$/, ''))
      .find((candidate) => new RegExp(`^${columnName}\\s+`).test(candidate))
    if (line !== undefined) return line.slice(column.length).trim()
  }
  return undefined
}

describe('MySQL schema', () => {
  it('keeps the logical version numbers of the other dialects', () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(CURRENT_SCHEMA_VERSION).toBe(7)
  })

  it('writes only statements that are safe to repeat', () => {
    // MySQL commits each DDL statement on its own, so a migrator that dies inside a
    // version leaves part of it behind, and a rerun has to be able to finish the rest.
    // An index has no IF NOT EXISTS form, so it goes through the one guarded form. For
    // such a version the comparison below is with that form's own output and cannot fail:
    // it only keeps the version out of the table check. That the form is safe to repeat
    // is carried by the real-server test, which runs it again over an index that exists
    // and twice over one that was dropped, and by the frozen hashes of versions 6 and 7.
    // Every other statement creates a table if missing.
    const guardedIndexes = [
      createIndexIfMissing('runs', 'runs_woken', '(queue, wake_event, state)'),
      createIndexIfMissing('runs', 'runs_stamp', '(fence_stamp(64))'),
    ]
    const statements = [
      META_TABLE_SQL,
      ...MIGRATIONS.flatMap((migration) =>
        guardedIndexes.some((guarded) => guarded.join('\n') === migration.statements.join('\n'))
          ? []
          : migration.statements,
      ),
    ]
    expect(statements.length).toBeGreaterThan(1)
    expect(
      MIGRATIONS.filter(({ statements: s }) => /^SET @durablerun_ddl/.test(s[0] ?? '')),
    ).toHaveLength(guardedIndexes.length)
    for (const statement of statements) {
      expect(statement, 'mutation-verdict:construction:mysql-migration-statements-repeat').toMatch(
        /^CREATE TABLE IF NOT EXISTS /,
      )
    }
  })

  it('stores every durable numeric contract field as BIGINT with exact nullability', () => {
    const expected = [
      ...PERSISTED_COUNTER_FIELDS.map(({ table, column }) => ({ table, column, nullable: false })),
      ...PERSISTED_TEMPORAL_FIELDS.map(({ table, column, nullable }) => ({
        table,
        column,
        nullable,
      })),
    ]
    const observed = expected.map(({ table, column, nullable }) => {
      const declaration = columnDeclaration(table, column)
      return {
        field: `${table}.${column}`,
        bigint: declaration?.startsWith('BIGINT') ?? false,
        nullable: declaration === undefined ? undefined : !/\bNOT NULL\b/.test(declaration),
        expectedNullable: nullable,
      }
    })
    expect(observed).toEqual(
      expected.map(({ table, column, nullable }) => ({
        field: `${table}.${column}`,
        bigint: true,
        nullable,
        expectedNullable: nullable,
      })),
    )
    expect(observed).toHaveLength(31)
  })

  it('keeps wire JSON as text that does not end at 64 KiB, and every key case and pad exact', () => {
    const ddl = MIGRATIONS.flatMap(({ statements }) => statements).join('\n')
    for (const field of [
      'tasks.params',
      'tasks.headers',
      'tasks.retry_strategy',
      'tasks.cancellation',
      'tasks.completed_payload',
      'tasks.failure_reason',
      'runs.event_payload',
      'runs.result',
      'runs.failure_reason',
      'checkpoints.state',
      'events.payload',
    ]) {
      const [table, column] = field.split('.')
      expect(columnDeclaration(table ?? '', column ?? ''), field).toMatch(/^LONGTEXT\b/)
    }
    expect(ddl).not.toMatch(/\bJSON\b|\bTIMESTAMP\b|\bDATETIME\b|\bINT\b|\bINTEGER\b/)
    // Every string column names its collation: the server default ignores case and accents.
    const strings = ddl.match(/\b(?:VARCHAR\(\d+\)|LONGTEXT)[^,\n]*/g) ?? []
    expect(strings.length).toBeGreaterThan(30)
    for (const declaration of strings) expect(declaration).toContain('COLLATE utf8mb4_0900_bin')
  })
})

describe('MySQL migrations are append-only', () => {
  const FROZEN: Record<number, string> = {
    1: '187df34faca4f9fa45abee9fefb18c11227bd536cc3d81ea7073f055b5c63551',
    2: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    3: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    4: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    5: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    6: '282e8754775295bf61972db61c285b7e3ffd92726bd38dbb6c2b60fdf7250ee9',
    7: 'a62f49a184939000c4f82f1b421b5b30ce1bca5800c0b2be6ee0afbf614ab26d',
  }

  it('matches every migration to an independently frozen content hash', () => {
    for (const migration of MIGRATIONS) {
      const hash = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
      expect(FROZEN[migration.version], `migration v${migration.version} is not frozen`).toBe(hash)
    }
    expect(Object.keys(FROZEN)).toHaveLength(MIGRATIONS.length)
  })
})
