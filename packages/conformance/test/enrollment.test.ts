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
  'executor-errors',
  'operator-reads',
  'retention',
  'retention-soak',
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

describe('a dialect with a CI job of its own runs every test file that runs once for each selected dialect', () => {
  // `pnpm verify` runs the dialects its job has servers for. A dialect with a job of its own
  // runs packages/conformance/bin/dialect-conformance.sh, which hands vitest a list of
  // paths. A test file that runs its cases once for each selected dialect and is not on
  // that list runs on that dialect in no job, while its record says "on each dialect". The
  // list is written by hand. So this case finds those files by what they import, and
  // requires each to be a path the script runs or to be named below with the reason it is
  // left out. It holds no file that reaches a dialect another way.
  const SCRIPT = `${ROOT}/packages/conformance/bin/dialect-conformance.sh`
  /** What a test file imports to run once for each selected dialect. */
  const SELECTS = [
    'SELECTED_DIALECT_FIXTURES',
    'selectedDialects',
    'SELECTED',
    'parseDialectSelection',
  ]
  /** The variable those read. A test file that reads it takes the selection itself. */
  const READS_THE_SELECTION = /process\.env\.DURABLERUN_CONFORMANCE_DIALECTS/
  /** The test files that select and that the script leaves out, each with its reason. */
  const LEFT_OUT: Readonly<Record<string, string>> = {
    'packages/conformance/test/dialect-selection.test.ts':
      'it calls the parser of the selection with lists of its own, and opens no store',
  }

  /** The paths the script hands vitest, with `$dialect` as the script writes it. */
  const listedPaths = (script: string): string[] => {
    const lines = script.split('\n')
    const run = lines.findIndex((line) => line.includes('pnpm exec vitest run'))
    const paths: string[] = []
    for (const line of run < 0 ? [] : lines.slice(run + 1)) {
      const path = line
        .trim()
        .replace(/\s*\\$/, '')
        .replace(/^"|"$/g, '')
      if (path.startsWith('--')) break
      paths.push(path)
    }
    return paths
  }
  /** The names a source imports, without `type` and without what each is renamed to. */
  const importedNames = (source: string): string[] =>
    [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)].flatMap(([, names = '']) =>
      names.split(',').map(
        (name) =>
          name
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0] ?? '',
      ),
    )
  /** Every test file under the `test` directory of a package or an app, as a repository path. */
  const testFiles = (): string[] =>
    ['packages', 'apps'].flatMap((top) =>
      readdirSync(`${ROOT}/${top}`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(`${ROOT}/${top}/${entry.name}/test`))
        .flatMap((entry) =>
          readdirSync(`${ROOT}/${top}/${entry.name}/test`, { recursive: true, encoding: 'utf8' })
            .filter((file) => file.endsWith('.test.ts'))
            .map((file) => `${top}/${entry.name}/test/${file}`),
        ),
    )

  it('finds them by what they import, and requires each to be a path the script runs or to be named with its reason', () => {
    const listed = listedPaths(readFileSync(SCRIPT, 'utf8'))
    const forEachDialect = [
      ...new Set(
        EXPECTED_DIALECTS.flatMap((dialect) =>
          listed.map((path) => path.replaceAll('$dialect', dialect)),
        ),
      ),
    ]
    const selecting = testFiles()
      .filter((file) => {
        const source = readFileSync(`${ROOT}/${file}`, 'utf8')
        return (
          importedNames(source).some((name) => SELECTS.includes(name)) ||
          READS_THE_SELECTION.test(source)
        )
      })
      .sort()
    const runs = (file: string) =>
      forEachDialect.some((path) => file === path || file.startsWith(`${path}/`))

    expect(
      {
        // The search and the script's list meet: when they share no file, nothing below can fail.
        found: selecting.some(runs),
        selectedAndNotRun: selecting.filter((file) => !runs(file) && !(file in LEFT_OUT)),
        listedAndNotThere: forEachDialect.filter((path) => !existsSync(`${ROOT}/${path}`)),
        leftOutAndNotSelecting: Object.keys(LEFT_OUT).filter((file) => !selecting.includes(file)),
        leftOutAndRun: Object.keys(LEFT_OUT).filter(runs),
      },
      'regression:one-dialect-script-runs-every-per-dialect-test-file',
    ).toEqual({
      found: true,
      selectedAndNotRun: [],
      listedAndNotThere: [],
      leftOutAndNotSelecting: [],
      leftOutAndRun: [],
    })
  })
})
