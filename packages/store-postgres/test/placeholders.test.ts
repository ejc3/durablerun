import { describe, expect, it } from 'vitest'
import { compilePostgresPlaceholders } from '../src/placeholders.js'

describe('PostgreSQL placeholder compiler', () => {
  it('numbers ordinary placeholders in encounter order', () => {
    expect(compilePostgresPlaceholders('SELECT ?, ?, ?')).toEqual({
      sql: 'SELECT $1, $2, $3',
      parameterCount: 3,
    })
  })

  it('does not rewrite quoted data or identifiers', () => {
    const source = String.raw`SELECT '?', 'it''s ?', E'escaped \' ? text', "?", ?`
    expect(compilePostgresPlaceholders(source)).toEqual({
      sql: String.raw`SELECT '?', 'it''s ?', E'escaped \' ? text', "?", $1`,
      parameterCount: 1,
    })
  })

  it('treats backslashes as escapes only in E-prefixed strings', () => {
    const source = String.raw`SELECT '\' AS slash, ?, E'it\'s ?' AS escaped, ?`
    expect(compilePostgresPlaceholders(source)).toEqual({
      sql: String.raw`SELECT '\' AS slash, $1, E'it\'s ?' AS escaped, $2`,
      parameterCount: 2,
    })
  })

  it('does not rewrite line comments or nested block comments', () => {
    const source = `SELECT ? -- ?\r\n, /* outer ? /* inner ? */ still ? */ ?`
    expect(compilePostgresPlaceholders(source)).toEqual({
      sql: `SELECT $1 -- ?\r\n, /* outer ? /* inner ? */ still ? */ $2`,
      parameterCount: 2,
    })
  })

  it('does not rewrite dollar-quoted bodies', () => {
    const source = `SELECT $$?$$, $body$begin ?; end$body$, ?`
    expect(compilePostgresPlaceholders(source)).toEqual({
      sql: `SELECT $$?$$, $body$begin ?; end$body$, $1`,
      parameterCount: 1,
    })
  })

  it('does not mistake a dollar-bearing identifier for a dollar quote', () => {
    expect(compilePostgresPlaceholders(`SELECT foo$tag$, ?`)).toEqual({
      sql: `SELECT foo$tag$, $1`,
      parameterCount: 1,
    })
  })

  it('leaves unterminated quoted regions unchanged for PostgreSQL to reject', () => {
    expect(compilePostgresPlaceholders(`SELECT ?, 'unterminated ?`)).toEqual({
      sql: `SELECT $1, 'unterminated ?`,
      parameterCount: 1,
    })
    expect(compilePostgresPlaceholders(`SELECT ? /* unterminated ?`)).toEqual({
      sql: `SELECT $1 /* unterminated ?`,
      parameterCount: 1,
    })
  })
})
