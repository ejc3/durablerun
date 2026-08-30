import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('does not grant the dogfood job a repository token capability', () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'),
    'utf8',
  )
  const workflow = parse(source) as { permissions?: Record<string, unknown> }

  expect({
    permissions: workflow.permissions,
    passesBuiltInToken: source.includes('github.token'),
  }).toEqual({ permissions: {}, passesBuiltInToken: false })
})
