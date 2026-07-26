import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as conformance from '../src/index.js'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SURFACES = ['scheduler', 'fault-matrix', 'poison-matrix', 'wake-witness']
const REGISTRY = `${ROOT}/packages/conformance/test/dialect-fixtures.ts`
const UMBRELLA = `${ROOT}/packages/conformance/src/store-conformance.ts`
const SURFACE_BINDINGS = [
  ['scheduler', 'schedulerConformance'],
  ['fault-matrix', 'faultMatrixConformance'],
  ['poison-matrix', 'poisonMatrixConformance'],
  ['wake-witness', 'wakeWitnessConformance'],
]

describe('shared conformance enrollment is one indivisible door', () => {
  it('exports one umbrella instead of asking dialects to select sub-suites', () => {
    expect(conformance, 'mutation-verdict:construction:shared-conformance-umbrella').toHaveProperty(
      'storeConformance',
    )
  })

  it('pins the complete shared behavior surface behind that umbrella', () => {
    expect(
      (conformance as Record<string, unknown>).STORE_CONFORMANCE_SURFACE_IDS,
      'mutation-verdict:construction:shared-conformance-surface-inventory',
    ).toEqual(SURFACES)
  })

  it('couples the surface inventory and umbrella dispatch in one registry', () => {
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

    expect
      .soft(bindings, 'mutation-verdict:construction:shared-conformance-runner-registry')
      .toEqual(SURFACE_BINDINGS)
    expect.soft(inventory).toContain('STORE_CONFORMANCE_SURFACES')
    expect.soft(dispatch).toContain('STORE_CONFORMANCE_SURFACES')
    expect
      .soft(dispatch, 'mutation-verdict:construction:shared-conformance-registry-dispatch')
      .toMatch(/(?:\brun|\.run)\(\s*dialect\s*,\s*makeFixture\s*\)/)
    for (const runner of runnerNames) {
      expect.soft(dispatch).not.toContain(`${runner}(`)
    }
  })

  it('enrolls every store package through one central fixture registry', () => {
    expect(existsSync(REGISTRY), 'mutation-verdict:construction:dialect-fixture-registry').toBe(
      true,
    )
    if (!existsSync(REGISTRY)) return

    const registered = readFileSync(REGISTRY, 'utf8')
    const stores = readdirSync(`${ROOT}/packages`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('store-'))
      .map((entry) => entry.name.slice('store-'.length))
      .sort()
    for (const dialect of stores) {
      expect(
        registered,
        `mutation-verdict:construction:dialect-fixture-registry:${dialect}`,
      ).toMatch(new RegExp(`dialect:\\s*['"]${dialect}['"]`))
    }
  })
})
