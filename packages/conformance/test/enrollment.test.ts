import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/fixture.js'
import * as conformance from '../src/index.js'
import { bindStoreConformanceSurfaces, storeConformance } from '../src/store-conformance.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REGISTRY = `${ROOT}/packages/conformance/test/dialect-fixtures.ts`
const EXPECTED_SURFACE_IDS = [
  'scheduler',
  'fault-matrix',
  'poison-matrix',
  'timestamp-boundaries',
  'wake-witness',
] as const

describe('shared conformance enrollment is one indivisible door', () => {
  it('exports one umbrella instead of asking dialects to select sub-suites', () => {
    expect(conformance, 'regression:shared-conformance-umbrella').toHaveProperty('storeConformance')
  })

  it('owns five surfaces and executable dispatch through one callable registry', () => {
    const probeCalls: { id: string; dialect: string; sameFixture: boolean }[] = []
    const probeFixture = (() => {
      throw new Error('the registry probe must not construct a fixture')
    }) as StoreFixtureFactory
    const probe = bindStoreConformanceSurfaces(
      EXPECTED_SURFACE_IDS.map((id) => ({
        id,
        run: (dialect, makeFixture) => {
          probeCalls.push({ id, dialect, sameFixture: makeFixture === probeFixture })
        },
      })),
    )
    probe('probe-dialect', probeFixture)

    expect(
      {
        registryBinder: typeof bindStoreConformanceSurfaces,
        probeIsCallable: typeof probe === 'function',
        probeCalls,
        umbrellaIsCallable: typeof storeConformance === 'function',
        umbrellaSurfaceIds: storeConformance.surfaces.map(({ id }) => id),
      },
      'mutation-verdict:construction:shared-conformance-runner-registry',
    ).toEqual({
      registryBinder: 'function',
      probeIsCallable: true,
      probeCalls: EXPECTED_SURFACE_IDS.map((id) => ({
        id,
        dialect: 'probe-dialect',
        sameFixture: true,
      })),
      umbrellaIsCallable: true,
      umbrellaSurfaceIds: EXPECTED_SURFACE_IDS,
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
