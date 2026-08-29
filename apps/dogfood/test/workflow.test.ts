import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('does not expose dogfood credentials to every action in the job', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'), 'utf8'),
  ) as { jobs?: { 'ref-journal'?: { env?: Record<string, unknown> } } }
  const jobEnvironment = workflow.jobs?.['ref-journal']?.env ?? {}

  expect(jobEnvironment).not.toHaveProperty('TURSO_DATABASE_URL')
  expect(jobEnvironment).not.toHaveProperty('TURSO_AUTH_TOKEN')
  expect(jobEnvironment).not.toHaveProperty('GITHUB_TOKEN')
})
