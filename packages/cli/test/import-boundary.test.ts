import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BIOME = join(ROOT, 'node_modules', '.bin', 'biome')

/** Lint files planted in a copy of the repository's biome configuration, and say what failed. */
function lintPlanted(files: Readonly<Record<string, string>>): { exit: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-imports-'))
  try {
    copyFileSync(join(ROOT, 'biome.json'), join(dir, 'biome.json'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    const run = spawnSync(BIOME, ['lint', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' })
    return { exit: run.status ?? -1, output: `${run.stdout}${run.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const STORE_IMPORT =
  "import { LibsqlExecutor } from '@durablerun/store-libsql'\nexport const x = LibsqlExecutor\n"

/**
 * Only open-store.ts under packages/cli/src may import a store package, so the CLI reaches
 * a store through the ports the opener narrows. `pnpm lint` holds it with biome's
 * noRestrictedImports and an override that turns the rule off for that one file.
 */
describe('the CLI reaches a store only through its opener', () => {
  it('a store package imported by any other file of packages/cli/src fails the lint', () => {
    for (const [path, text] of [
      ['packages/cli/src/planted.ts', STORE_IMPORT],
      [
        'packages/cli/src/planted.ts',
        "export const load = () => import('@durablerun/store-postgres')\n",
      ],
      ['packages/cli/src/planted.ts', "export { MysqlExecutor } from '@durablerun/store-mysql'\n"],
      [
        'packages/cli/src/nested/planted.ts',
        "import { openMysqlTestDb } from '@durablerun/store-mysql/testing'\nexport const x = openMysqlTestDb\n",
      ],
    ] as const) {
      const run = lintPlanted({ [path]: text })
      expect(run.exit, run.output).not.toBe(0)
      expect(run.output).toContain('lint/nursery/noRestrictedImports')
    }
  })

  it('open-store.ts and the tests may import a store package', () => {
    const run = lintPlanted({
      'packages/cli/src/open-store.ts': STORE_IMPORT,
      'packages/cli/test/planted.ts': STORE_IMPORT,
    })
    expect(run.output).not.toContain('noRestrictedImports')
    expect(run.exit, run.output).toBe(0)
  })
})

const RESOLUTION: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
}

/**
 * The specifiers a source file names that resolve into a store package's directory: every
 * import, import type, re-export, import() call and `typeof import(...)` TypeScript's own
 * scanner finds, each resolved as the compiler resolves it, through the workspace's links,
 * and a relative one that resolves to nothing by its path. biome's rule matches a
 * specifier's spelling, so a relative path into packages/store-* passes it; this reads
 * where each one goes.
 */
function storeSpecifiers(file: string, text: string): string[] {
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => {
      const found = ts.resolveModuleName(specifier, file, RESOLUTION, ts.sys).resolvedModule
      const path =
        found !== undefined
          ? realpathSync(found.resolvedFileName)
          : specifier.startsWith('.')
            ? resolve(dirname(file), specifier)
            : undefined
      return path !== undefined && relative(ROOT, path).startsWith(`packages${sep}store-`)
    })
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesUnder(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )
}

describe('the CLI reaches a store only through its opener, by where its imports resolve', () => {
  const OPENER = join(ROOT, 'packages', 'cli', 'src', 'open-store.ts')

  it('no file of packages/cli/src or bin but open-store.ts names a module inside a store package', () => {
    const files = [
      ...sourcesUnder(join(ROOT, 'packages', 'cli', 'src')),
      ...sourcesUnder(join(ROOT, 'packages', 'cli', 'bin')),
    ]
    expect(files).toContain(OPENER)
    const reached = files
      .filter((file) => file !== OPENER)
      .map((file) => ({
        file: relative(ROOT, file),
        stores: storeSpecifiers(file, readFileSync(file, 'utf8')),
      }))
      .filter((found) => found.stores.length > 0)
    expect(reached, 'mutation-verdict:behavior:cli-imports-resolve-outside-the-stores').toEqual([])
    expect(storeSpecifiers(OPENER, readFileSync(OPENER, 'utf8')).length).toBeGreaterThan(0)
  })

  it('finds a store reached by a relative path, a type, typeof import, import() and a re-export', () => {
    const planted = join(ROOT, 'packages', 'cli', 'src', 'nested', 'planted.ts')
    for (const text of [
      "import { LibsqlExecutor } from '../../../store-libsql/src/index.js'\n",
      "import { MIGRATIONS } from '../../../store-mysql/src/schema.js'\n",
      "import type { PgExecutor } from '@durablerun/store-postgres'\n",
      "export type Store = typeof import('@durablerun/store-libsql')\n",
      "export const load = () => import('@durablerun/store-mysql/testing')\n",
      "export { LibsqlExecutor } from '@durablerun/store-libsql'\n",
    ]) {
      expect({ text, stores: storeSpecifiers(planted, text).length }).toEqual({ text, stores: 1 })
    }
    expect(storeSpecifiers(planted, "import { main } from '../main.js'\n")).toEqual([])
  })
})
