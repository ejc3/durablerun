import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('retains the exact status read that the workflow verifies', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'), 'utf8'),
  ) as { jobs?: { 'ref-journal'?: { steps?: Array<{ run?: string }> } } }
  const commands = (workflow.jobs?.['ref-journal']?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => run !== undefined)
  const verifier = commands.filter((run) => run.includes('dogfood:verify'))

  expect(verifier).toHaveLength(1)
  expect(verifier[0]).toContain('tee dogfood-after.json')
  expect(commands.filter((run) => run.includes('dogfood:status'))).toEqual([])
})
