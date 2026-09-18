import { describe, expect, it } from 'vitest'
import { countMysqlPlaceholders, writtenRows } from '../src/executor.js'

describe('MySQL placeholder count', () => {
  it('counts ordinary placeholders', () => {
    expect(countMysqlPlaceholders('SELECT ?, ?, ?')).toBe(3)
  })

  it('does not count quoted data, quoted identifiers, or comments', () => {
    // Two binds: the one after the quoted identifier, and the one after the block comment.
    const sql = [
      String.raw`SELECT '?', 'it''s ?', 'escaped \' ? text', "?", `,
      '`?`, ? -- ?',
      ', /* ? */ ? # ?',
    ].join('\n')
    expect(countMysqlPlaceholders(sql)).toBe(2)
  })
})

describe('rows a MySQL statement wrote, as the executor port means it', () => {
  it('reports the rows an UPDATE matched, where MySQL counts only the rows it changed', () => {
    expect(
      writtenRows({ affectedRows: 0, info: 'Rows matched: 1  Changed: 0  Warnings: 0' }),
      'mutation-verdict:construction:mysql-update-reports-matched-rows',
    ).toBe(1)
  })

  it('counts a selecting upsert that updated once, where MySQL counts it twice', () => {
    expect(
      writtenRows({ affectedRows: 2, info: 'Records: 1  Duplicates: 1  Warnings: 0' }),
      'mutation-verdict:construction:mysql-upsert-update-counts-once',
    ).toBe(1)
  })

  it('counts a single-row upsert that updated once, which MySQL reports as two with no record line', () => {
    expect(
      writtenRows({ affectedRows: 2, info: '' }),
      'mutation-verdict:construction:mysql-single-row-upsert-counts-once',
    ).toBe(1)
  })

  it('reports nothing written for an upsert whose conflict arm changed nothing', () => {
    expect(writtenRows({ affectedRows: 0, info: 'Records: 1  Duplicates: 0  Warnings: 0' })).toBe(0)
    expect(writtenRows({ affectedRows: 0, info: '' })).toBe(0)
  })

  it('reports inserts and deletes as MySQL does', () => {
    expect(writtenRows({ affectedRows: 1, info: '' })).toBe(1)
    expect(writtenRows({ affectedRows: 3, info: 'Records: 3  Duplicates: 0  Warnings: 0' })).toBe(3)
    expect(writtenRows({ affectedRows: 4, info: '' })).toBe(4)
  })
})
