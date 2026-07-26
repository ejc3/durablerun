import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as conformance from '../src/index.js'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SURFACES = ['scheduler', 'fault-matrix', 'poison-matrix', 'wake-witness']
const REGISTRY = `${ROOT}/packages/conformance/test/dialect-fixtures.ts`

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
