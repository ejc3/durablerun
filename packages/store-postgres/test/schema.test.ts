import { createHash } from 'node:crypto'
import { PERSISTED_COUNTER_FIELDS, PERSISTED_TEMPORAL_FIELDS } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../src/schema.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function columnDeclaration(table: string, column: string): string | undefined {
  const tableName = escapeRegExp(table)
  const columnName = escapeRegExp(column)
  for (const statement of MIGRATIONS.flatMap(({ statements }) => statements)) {
    if (new RegExp(`^CREATE TABLE ${tableName} \\(`).test(statement)) {
      const line = statement
        .split('\n')
        .map((candidate) => candidate.trim().replace(/,$/, ''))
        .find((candidate) => new RegExp(`^${columnName}\\s+`).test(candidate))
      if (line !== undefined) return line.slice(column.length).trim()
    }
    const altered = statement.match(
      new RegExp(`^ALTER TABLE ${tableName} ADD COLUMN ${columnName}\\s+(.+)$`),
    )
    if (altered?.[1] !== undefined) return altered[1]
  }
  return undefined
}

describe('PostgreSQL schema', () => {
  it('tracks every logical migration version without rewriting history', () => {
    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(CURRENT_SCHEMA_VERSION).toBe(9)
  })

  it('stores every durable numeric contract field as BIGINT with exact nullability', () => {
    const expected = [
      ...PERSISTED_COUNTER_FIELDS.map(({ table, column }) => ({
        table,
        column,
        nullable: false,
      })),
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
        declaration,
        bigint: declaration?.startsWith('BIGINT') ?? false,
        nullable: declaration === undefined ? undefined : !/\bNOT NULL\b/.test(declaration),
        expectedNullable: nullable,
      }
    })

    expect(observed).toEqual(
      expected.map(({ table, column, nullable }) => ({
        field: `${table}.${column}`,
        declaration: expect.any(String),
        bigint: true,
        nullable,
        expectedNullable: nullable,
      })),
    )
    expect(observed).toHaveLength(31)
  })

  it('keeps wire JSON and ids as TEXT and provides the event lock sentinel', () => {
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
      expect(columnDeclaration(table ?? '', column ?? ''), field).toMatch(/^TEXT\b/)
    }
    expect(ddl).not.toMatch(/\bJSONB?\b|\bUUID\b|\bTIMESTAMP(?:TZ)?\b|\bINTEGER\b/)
    expect(ddl).toContain(`CREATE TABLE event_locks (
        queue TEXT NOT NULL,
        event_name TEXT NOT NULL,
        PRIMARY KEY (queue, event_name)
      )`)
    expect(ddl).not.toContain('claim_locks')
  })
})

describe('PostgreSQL migrations are append-only', () => {
  const FROZEN: Record<number, string> = {
    1: 'b63246f941c492fad05ec1dd586214d80d29a1208235ca0c4b6ab16384907cb9',
    2: '74b6c407aff872af263b439a96147a7a542931434b381f8950058ea77770f183',
    3: '2d990218bab811ebf1a8ebecc5d4da1370bfd2e61eba077ba6cca68a9bfe4eee',
    4: '69daf94f2004f75f5f8c03f93261fec5a61e7f98a22a07b718bac4163beb8c92',
    5: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    6: '885b036a4dd411a373539f7945fa2cfcd57f4dba7e0ac9a3d2d5edba8d969b3e',
    7: 'a9b6b06e608a16b77893027f3b47dc7eb2f20ceaedf5467aa6736cc5973b474e',
    8: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    9: '7ce46ae684da2e4f59662a04a7d9092194bfb03fe3f66fa79c1d99388dba3233',
  }

  it('matches every migration to an independently frozen content hash', () => {
    for (const migration of MIGRATIONS) {
      const hash = createHash('sha256').update(migration.statements.join('\n')).digest('hex')
      expect(FROZEN[migration.version], `migration v${migration.version} is not frozen`).toBe(hash)
    }
    expect(Object.keys(FROZEN)).toHaveLength(MIGRATIONS.length)
  })
})
