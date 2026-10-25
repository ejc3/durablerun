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
import { type Node, parseSync, visitorKeys } from 'oxc-parser'
import { ResolverFactory } from 'oxc-resolver'
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

const resolver = new ResolverFactory({ tsconfig: { configFile: join(ROOT, 'tsconfig.base.json') } })

/** Resolve every import spelling through workspace links, including relative store paths. */
function storeSpecifiers(file: string, text: string): string[] {
  const syntax = parseSync(file, text)
  if (syntax.errors.length) throw new Error(syntax.errors[0]?.message)
  const specifiers: string[] = []
  const literal = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') return undefined
    const value = node as Node & { value?: unknown; literal?: unknown }
    if (value.type === 'TemplateLiteral')
      return value.expressions.length === 0
        ? (value.quasis[0]?.value.cooked ?? undefined)
        : undefined
    return typeof value.value === 'string' ? value.value : literal(value.literal)
  }
  const visit = (node: Node) => {
    const record = node as unknown as Record<string, unknown>
    let source: unknown
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
      ].includes(node.type)
    )
      source = record.source
    else if (node.type === 'TSImportType') source = record.source
    else if (node.type === 'TSImportEqualsDeclaration')
      source = (record.moduleReference as { expression?: unknown })?.expression
    else if (node.type === 'CallExpression') {
      const callee = record.callee as { type?: string; name?: string }
      if (callee.type === 'Identifier' && callee.name === 'require')
        source = (record.arguments as unknown[])[0]
    }
    const specifier = literal(source)
    if (specifier !== undefined) specifiers.push(specifier)
    for (const key of visitorKeys[node.type] ?? []) {
      const child = record[key]
      if (Array.isArray(child)) {
        for (const each of child) if (each) visit(each as Node)
      } else if (child) visit(child as Node)
    }
  }
  visit(syntax.program)
  return specifiers.filter((specifier) => {
    const found = resolver.resolveDtsSync(file, specifier).path
    const path =
      found !== undefined
        ? realpathSync(found)
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
      'export const load = () => import(`../../../store-libsql/src/index.js`)\n',
      "export { LibsqlExecutor } from '@durablerun/store-libsql'\n",
    ]) {
      expect({ text, stores: storeSpecifiers(planted, text).length }).toEqual({ text, stores: 1 })
    }
    expect(storeSpecifiers(planted, "import { main } from '../main.js'\n")).toEqual([])
  })
})
