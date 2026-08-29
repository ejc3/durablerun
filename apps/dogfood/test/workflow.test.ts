import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, unknown>
}

it('scopes dogfood credentials and executes the receipt verifier', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'), 'utf8'),
  ) as {
    jobs?: { 'ref-journal'?: { env?: Record<string, unknown>; steps?: WorkflowStep[] } }
  }
  const job = workflow.jobs?.['ref-journal']
  const jobEnvironment = job?.env ?? {}

  expect(jobEnvironment).not.toHaveProperty('TURSO_DATABASE_URL')
  expect(jobEnvironment).not.toHaveProperty('TURSO_AUTH_TOKEN')
  expect(jobEnvironment).not.toHaveProperty('GITHUB_TOKEN')

  const steps = job?.steps ?? []
  for (const step of steps.filter((candidate) => candidate.uses !== undefined)) {
    expect(step.env ?? {}).not.toHaveProperty('TURSO_DATABASE_URL')
    expect(step.env ?? {}).not.toHaveProperty('TURSO_AUTH_TOKEN')
    expect(step.env ?? {}).not.toHaveProperty('GITHUB_TOKEN')
  }

  const verifier = steps.find((step) => step.name === 'Write and verify final status receipt')
  expect(verifier?.run).toContain('pnpm --silent dogfood:verify | tee dogfood-after.json')
  expect(verifier?.env).toMatchObject({
    TURSO_DATABASE_URL: '${{ secrets.TURSO_DATABASE_URL }}',
    TURSO_AUTH_TOKEN: '${{ secrets.TURSO_AUTH_TOKEN }}',
  })
})
