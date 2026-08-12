import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/fixture.js'
import * as conformance from '../src/index.js'
import * as storeConformanceModule from '../src/store-conformance.js'

type SurfaceRunner = (dialect: string, makeFixture: StoreFixtureFactory) => void
type RegisteredSurface = Readonly<{ id: string; run: SurfaceRunner }>
type BoundSurfaceRegistry = SurfaceRunner & {
  readonly surfaces: readonly RegisteredSurface[]
}
type SurfaceRegistryBinder = (surfaces: readonly RegisteredSurface[]) => BoundSurfaceRegistry

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

  it('owns five surfaces and executable dispatch through one callable registry', () => {
    const directModule = storeConformanceModule as Record<string, unknown>
    const binderCandidate = directModule.bindStoreConformanceSurfaces
    const binder =
      typeof binderCandidate === 'function' ? (binderCandidate as SurfaceRegistryBinder) : undefined
    const probeCalls: { id: string; dialect: string; sameFixture: boolean }[] = []
    const probeFixture = (() => {
      throw new Error('the registry probe must not construct a fixture')
    }) as StoreFixtureFactory
    const probe = binder?.(
      EXPECTED_SURFACE_IDS.map((id) => ({
        id,
        run: (dialect, makeFixture) => {
          probeCalls.push({ id, dialect, sameFixture: makeFixture === probeFixture })
        },
      })),
    )
    probe?.('probe-dialect', probeFixture)

    const umbrella = directModule.storeConformance
    const umbrellaSurfaceIds =
      typeof umbrella === 'function' && 'surfaces' in umbrella && Array.isArray(umbrella.surfaces)
        ? umbrella.surfaces.map((surface) =>
            typeof surface === 'object' && surface !== null && 'id' in surface
              ? surface.id
              : undefined,
          )
        : undefined

    expect(
      {
        registryBinder: typeof binder,
        probeIsCallable: typeof probe === 'function',
        probeCalls,
        umbrellaIsCallable: typeof umbrella === 'function',
        umbrellaSurfaceIds,
      },
      'regression:shared-conformance-bound-registry',
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
