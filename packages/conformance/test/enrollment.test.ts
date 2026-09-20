import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/fixture.js'
import * as conformance from '../src/index.js'
import { bindStoreConformanceSurfaces, storeConformance } from '../src/store-conformance.js'
import { DIALECT_FIXTURES } from './dialect-fixtures.js'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const REGISTRY = `${ROOT}/packages/conformance/test/dialect-fixtures.ts`
const EXPECTED_SURFACE_IDS = [
  'scheduler',
  'fault-matrix',
  'poison-matrix',
  'timestamp-boundaries',
  'wake-witness',
  'child-tasks',
  'sagas',
  'identifier-bound',
  'schema-admin',
  'self-concurrency',
  'stale-token',
] as const
const EXPECTED_DIALECTS = ['libsql', 'postgres', 'mysql'] as const

describe('shared conformance enrollment is one indivisible door', () => {
  it('exports one umbrella instead of asking dialects to select sub-suites', () => {
    expect(conformance, 'regression:shared-conformance-umbrella').toHaveProperty('storeConformance')
  })

  it('enrolls every promised dialect through the complete callable conformance door', () => {
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
        registeredDialects: DIALECT_FIXTURES.map(({ dialect }) => dialect),
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
      registeredDialects: EXPECTED_DIALECTS,
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

describe('every checkpoint write in a store is a door the saga surface knows', () => {
  // A saga's durable state is checkpoints under reserved names. Each site that writes a
  // checkpoint writes the engine's name or takes its caller's: set-checkpoint, the marker
  // of suspend, and the attempt record of fail-rollback take a caller's, and the phase
  // marker is the engine's. The saga surface's table case holds every caller-named one
  // against every reserved name in both phases. A fifth site is a new door or a new
  // engine name: give it its row in that table first, then raise this count.
  it.each(EXPECTED_DIALECTS)(
    'the %s store has the four checkpoint writes the saga table covers',
    (dialect) => {
      const source = readFileSync(`${ROOT}/packages/store-${dialect}/src/store.ts`, 'utf8')
      expect(source.match(/\bcheckpointWrite\(/g)?.length).toBe(4)
    },
  )
})
