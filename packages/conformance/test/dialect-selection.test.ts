import { describe, expect, it } from 'vitest'
import { DIALECT_FIXTURES } from './dialect-fixtures.js'
import { ENROLLED_DIALECTS, parseDialectSelection } from './dialect-selection.js'

describe('the dialect selection', () => {
  it('runs every enrolled dialect when nothing is selected', () => {
    expect(parseDialectSelection(undefined)).toEqual(ENROLLED_DIALECTS)
  })

  it('narrows to the named dialects, in enrollment order', () => {
    expect(parseDialectSelection('postgres, libsql')).toEqual(['libsql', 'postgres'])
    expect(parseDialectSelection('mysql')).toEqual(['mysql'])
  })

  it('refuses a list that is empty, misspelled, or repeats a name', () => {
    for (const selection of [
      '',
      ' ',
      'mysq',
      'libsql,',
      'libsql,libsql',
      'libsql,postgres,sqlite',
    ]) {
      expect(() => parseDialectSelection(selection), `'${selection}'`).toThrow(
        /must list distinct enrolled dialects/,
      )
    }
  })

  it('names exactly the dialects that have a fixture', () => {
    expect(DIALECT_FIXTURES.map(({ dialect }) => dialect)).toEqual(ENROLLED_DIALECTS)
  })
})
