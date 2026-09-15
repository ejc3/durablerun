// Fail when a packed package no longer exports a name its last release exported.
//
// Usage: node scripts/package-surface.mjs <unpacked-root> <snapshot.json>
// <unpacked-root>/<name>/package is one unpacked @durablerun/<name> tarball.
//
// Type-only exports have no runtime presence, and no repository code imports
// most of what a published package exports, so neither tests nor typecheck see
// an export disappear. The compiler API reads the declaration files a consumer
// installs and lists every name each published entry point exports. Additions
// are allowed; the snapshot is replaced when a new release ships.
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ts = createRequire(import.meta.url)('typescript')
const [root, snapshotPath] = process.argv.slice(2)
if (!root || !snapshotPath) {
  throw new Error('usage: package-surface <unpacked-root> <snapshot.json>')
}

export function packedSurface(unpackedRoot) {
  const roots = []
  const entries = []
  const paths = {}
  for (const name of readdirSync(unpackedRoot).sort()) {
    const dir = resolve(unpackedRoot, name, 'package')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    paths[manifest.name] = [join(dir, manifest.types)]
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const types = typeof target === 'object' && target !== null ? target.types : undefined
      if (typeof types !== 'string') continue
      const file = join(dir, types)
      if (subpath !== '.') paths[`${manifest.name}/${subpath.slice(2)}`] = [file]
      roots.push(file)
      entries.push({ packageName: manifest.name, subpath, file })
    }
  }
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: '/',
    paths,
    types: [],
  })
  const checker = program.getTypeChecker()
  const surface = {}
  for (const { packageName, subpath, file } of entries) {
    const source = program.getSourceFile(file)
    const symbol = source && checker.getSymbolAtLocation(source)
    if (!symbol) throw new Error(`package-surface: cannot read ${packageName} ${subpath} (${file})`)
    surface[packageName] ??= {}
    surface[packageName][subpath] = checker
      .getExportsOfModule(symbol)
      .map((s) => s.getName())
      .sort()
  }
  return surface
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const current = packedSurface(root)
const removed = []
for (const [packageName, subpaths] of Object.entries(snapshot.surface)) {
  for (const [subpath, names] of Object.entries(subpaths)) {
    const now = current[packageName]?.[subpath]
    if (now === undefined) {
      removed.push(`${packageName} ${subpath}: the entry point itself`)
      continue
    }
    const have = new Set(now)
    for (const name of names)
      if (!have.has(name)) removed.push(`${packageName} ${subpath}: ${name}`)
  }
}
if (removed.length > 0) {
  console.error(
    `package-surface: ${removed.length} name(s) exported by ${snapshot.release} are gone:`,
  )
  for (const line of removed) console.error(`  ${line}`)
  process.exit(1)
}
const counted = Object.values(snapshot.surface)
  .flatMap((s) => Object.values(s))
  .flat().length
console.log(
  `package-surface: every name ${snapshot.release} exported is still exported (${counted} names)`,
)
