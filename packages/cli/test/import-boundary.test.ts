import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
