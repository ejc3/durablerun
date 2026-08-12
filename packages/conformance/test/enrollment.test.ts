import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as conformance from '../src/index.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REGISTRY = `${ROOT}/packages/conformance/test/dialect-fixtures.ts`
const UMBRELLA = `${ROOT}/packages/conformance/src/store-conformance.ts`
const SURFACE_BINDINGS = [
  ['scheduler', 'schedulerConformance'],
  ['fault-matrix', 'faultMatrixConformance'],
  ['poison-matrix', 'poisonMatrixConformance'],
  ['timestamp-boundaries', 'timestampBoundaryConformance'],
  ['wake-witness', 'wakeWitnessConformance'],
] as const

describe('shared conformance enrollment is one indivisible door', () => {
  it('exports one umbrella instead of asking dialects to select sub-suites', () => {
    expect(conformance, 'regression:shared-conformance-umbrella').toHaveProperty('storeConformance')
  })

  it('owns exported surface IDs and umbrella dispatch through one executable registry', () => {
    const source = readFileSync(UMBRELLA, 'utf8')
    const registry =
      source.match(
        /const\s+STORE_CONFORMANCE_SURFACES\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]\s*(?:as const)?\s*\)?/,
      )?.[1] ?? ''
    const bindings = [...registry.matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*run:\s*(\w+)/g)].map(
      ([, id, runner]) => [id, runner],
    )
    const inventory =
      source.match(
        /export const STORE_CONFORMANCE_SURFACE_IDS\s*=([\s\S]*?)(?=\n(?:const|function|export|async function)\s)/,
      )?.[1] ?? ''
    const dispatch = source.slice(source.indexOf('export function storeConformance'))
    const runnerNames = SURFACE_BINDINGS.map(([, runner]) => runner)

    expect(
      {
        bindings,
        surfaceIds: (conformance as Record<string, unknown>).STORE_CONFORMANCE_SURFACE_IDS,
        inventoryUsesRegistry: inventory.includes('STORE_CONFORMANCE_SURFACES'),
        dispatchUsesRegistry: dispatch.includes('STORE_CONFORMANCE_SURFACES'),
        invokesRegisteredRunner: /(?:\brun|\.run)\(\s*dialect\s*,\s*makeFixture\s*\)/.test(
          dispatch,
        ),
        directRunnerCalls: runnerNames.filter((runner) => dispatch.includes(`${runner}(`)),
      },
      'mutation-verdict:construction:shared-conformance-runner-registry',
    ).toEqual({
      bindings: SURFACE_BINDINGS,
      surfaceIds: SURFACE_BINDINGS.map(([id]) => id),
      inventoryUsesRegistry: true,
      dispatchUsesRegistry: true,
      invokesRegisteredRunner: true,
      directRunnerCalls: [],
    })
  })

  it('enrolls every store package through one central fixture registry', () => {
    expect(existsSync(REGISTRY), 'regression:dialect-fixture-registry').toBe(true)
    if (!existsSync(REGISTRY)) return

    const registered = readFileSync(REGISTRY, 'utf8')
    const stores = readdirSync(`${ROOT}/packages`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('store-'))
      .map((entry) => entry.name.slice('store-'.length))
      .sort()
    for (const dialect of stores) {
      expect(registered, `regression:dialect-fixture-registry:${dialect}`).toMatch(
        new RegExp(`dialect:\\s*['"]${dialect}['"]`),
      )
    }
  })
})
