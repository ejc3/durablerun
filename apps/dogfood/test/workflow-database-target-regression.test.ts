import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

interface WorkflowStep {
  name?: string
  run?: string
  env?: Record<string, unknown>
}

function runDatabaseGate(run: string, expectedDatabaseUrl?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TURSO_DATABASE_URL: 'libsql://other-application.example',
    TURSO_AUTH_TOKEN: 'test-token',
  }
  if (expectedDatabaseUrl !== undefined) {
    env.DURABLERUN_DOGFOOD_EXPECTED_DATABASE_URL = expectedDatabaseUrl
  }
  return spawnSync('bash', ['-c', run], { encoding: 'utf8', env })
}

it('refuses database-secret drift before the dogfood migrator can run', () => {
  const workflow = parse(
    readFileSync(join(import.meta.dirname, '../../..', '.github/workflows/dogfood.yml'), 'utf8'),
  ) as { jobs?: { 'ref-journal'?: { steps?: WorkflowStep[] } } }
  const gate = workflow.jobs?.['ref-journal']?.steps?.find((step) =>
    step.name?.includes('dedicated Turso database'),
  )
  const run = gate?.run ?? ''
  const mismatch = runDatabaseGate(run, 'libsql://durablerun-dogfood.example')
  const missingPin = runDatabaseGate(run)
  const exact = runDatabaseGate(run, 'libsql://other-application.example')

  expect({
    expectedDatabaseBinding: gate?.env?.DURABLERUN_DOGFOOD_EXPECTED_DATABASE_URL,
    mismatchStatus: mismatch.status,
    mismatchStderr: mismatch.stderr,
    missingPinStatus: missingPin.status,
    exactStatus: exact.status,
  }).toMatchObject({
    expectedDatabaseBinding: '${{ vars.DURABLERUN_DOGFOOD_DATABASE_URL }}',
    mismatchStatus: 1,
    mismatchStderr: expect.stringContaining('does not match the pinned dogfood database'),
    missingPinStatus: 1,
    exactStatus: 0,
  })
})
