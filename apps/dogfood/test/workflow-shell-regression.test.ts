import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('runs workflow pipelines with fail-closed bash semantics', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'), 'utf8'),
  ) as { defaults?: { run?: { shell?: string } } }

  expect(workflow.defaults?.run?.shell).toBe('bash')
})
