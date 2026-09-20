// Fail when a packed package no longer exports a name its last release exported, or
// declares one differently without saying so.
//
// Usage: node scripts/package-surface.mjs <unpacked-root> <snapshot.json>
//        node scripts/package-surface.mjs --write <release> <tarball-dir> <snapshot.json>
// <unpacked-root>/<name>/package is one unpacked @durablerun/<name> tarball.
//
// Type-only exports have no runtime presence, and no repository code imports
// most of what a published package exports, so neither tests nor typecheck see
// an export disappear or a declaration change. The compiler API reads the
// declaration files a consumer installs, lists every name each published entry
// point exports, and prints each name's declarations without their comments.
// Additions are allowed; the snapshot is replaced when a new release ships.
//
// A name's shape is the printed lines of its own declarations, then those of every name they
// reach inside the packed packages that the release did not export, because a consumer's
// compiler reads through such a name and cannot import it. A name the release exported is
// compared under its own entry. A class's private members are left out, because a consumer
// cannot use them; one line says that the class has some, because the first one stops a plain
// object from standing in for the class. A private constructor stays, because it says that a
// consumer cannot construct the class. The check does not judge whether a difference breaks a
// consumer. Any difference is refused until the snapshot says why it is there.
//
// A name leaves on purpose through the snapshot's `withdrawn` table, which gives the
// reason beside the name. A withdrawn name must be one the release exported, and it
// must be gone: a withdrawal of a name still exported is refused, so the table
// cannot become a list of names nobody checks.
//
// A declaration changes on purpose through the `changed` table, which gives the reason, what
// a consumer does about it, and the sha256 of the shape as it is now. A listed name must be
// one the release exported, must not also be withdrawn, and must differ from the release. The
// recorded sha256 must be the packed shape's, so a second change to a listed name is refused
// until its entry says what changed again.
//
// --write replaces the snapshot from a directory of release tarballs: it records each
// tarball's sha256, unpacks it, and prints the shapes. Written over a snapshot of the same
// release, it refuses a tarball whose sha256 differs from the one recorded, and a directory
// that lacks a recorded tarball, and keeps the two tables; a new release starts with both
// empty. Compare the recorded sha256 of each tarball with the release receipt before
// committing a new snapshot.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ts = createRequire(import.meta.url)('typescript')
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// A private constructor is not hidden: it says that a consumer cannot construct the class.
const isPrivate = (member) =>
  !ts.isConstructorDeclaration(member) &&
  ((member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
    (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0)

// One declaration as lines, without the modifiers that say how it is exported.
function declared(node) {
  const print = (shown) => printer.printNode(ts.EmitHint.Unspecified, shown, node.getSourceFile())
  let text
  let hides = false
  if (ts.isVariableDeclaration(node)) {
    const flags = node.parent.flags
    const keyword = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
    text = `${keyword} ${print(node)};`
  } else if (ts.isClassDeclaration(node)) {
    const members = node.members.filter((member) => !isPrivate(member))
    hides = members.length < node.members.length
    text = print(
      ts.factory.updateClassDeclaration(
        node,
        node.modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        members,
      ),
    )
  } else text = print(node)
  const lines = text.replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, '').split('\n')
  if (hides) lines.splice(-1, 0, '    (private members)')
  return lines
}

// The identifiers a declaration refers to other declarations by: a type reference, a heritage
// clause, a `typeof` query, and an `import()` type. Both ends of a dotted name are read,
// because `typeof a.b` reaches `a` and `ns.T` reaches `T`.
function references(node, visit) {
  const name = ts.isTypeReferenceNode(node)
    ? node.typeName
    : ts.isExpressionWithTypeArguments(node)
      ? node.expression
      : ts.isTypeQueryNode(node)
        ? node.exprName
        : ts.isImportTypeNode(node)
          ? node.qualifier
          : undefined
  if (name !== undefined) {
    let first = name
    while (ts.isQualifiedName(first) || ts.isPropertyAccessExpression(first))
      first = ts.isQualifiedName(first) ? first.left : first.expression
    visit(first)
    if (ts.isQualifiedName(name)) visit(name.right)
    if (ts.isPropertyAccessExpression(name)) visit(name.name)
  }
  ts.forEachChild(node, (child) => references(child, visit))
}

// released(packageName, subpath, name) says whether the release exported the name. A released
// name is compared under its own entry, so no other name's shape reaches into it.
export function packedSurface(unpackedRoot, released = () => true) {
  const roots = []
  const entries = []
  const paths = {}
  const packages = []
  for (const name of readdirSync(unpackedRoot).sort()) {
    const dir = resolve(unpackedRoot, name, 'package')
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    packages.push({ name: manifest.name, dir })
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
  // Where a declaration sits in the packed packages, or undefined for the compiler's own
  // library and for a dependency, whose declarations are not this repository's to hold.
  const place = (node) => {
    const file = node.getSourceFile().fileName
    const home = packages.find(({ dir }) => file.startsWith(dir + sep))
    return home && `${home.name}/${relative(home.dir, file)}`
  }
  const topLevel = (node) => {
    const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node
    return ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)
  }
  const resolved = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const declarationsOf = (symbol) =>
    (symbol.declarations ?? [])
      .filter((node) => place(node) !== undefined && topLevel(node))
      .sort((a, b) => (place(a) < place(b) ? -1 : place(a) > place(b) ? 1 : a.pos - b.pos))
  const exported = entries.map(({ packageName, subpath, file }) => {
    const source = program.getSourceFile(file)
    const symbol = source && checker.getSymbolAtLocation(source)
    if (!symbol) throw new Error(`package-surface: cannot read ${packageName} ${subpath} (${file})`)
    return { packageName, subpath, symbols: checker.getExportsOfModule(symbol) }
  })
  const compared = new Set()
  for (const { packageName, subpath, symbols } of exported)
    for (const symbol of symbols)
      if (released(packageName, subpath, symbol.getName())) compared.add(resolved(symbol))
  const reach = (symbol, reached) => {
    for (const declaration of declarationsOf(symbol))
      references(declaration, (identifier) => {
        const found = checker.getSymbolAtLocation(identifier)
        const target = found && resolved(found)
        if (!target || compared.has(target) || reached.has(target)) return
        if (declarationsOf(target).length === 0) return
        reached.add(target)
        reach(target, reached)
      })
  }
  const label = (symbol) => `${symbol.getName()} ${place(declarationsOf(symbol)[0])}`
  const surface = {}
  for (const { packageName, subpath, symbols } of exported) {
    const shapes = {}
    for (const symbol of symbols.sort((a, b) => (a.getName() < b.getName() ? -1 : 1))) {
      const own = resolved(symbol)
      const reached = new Set([own])
      reach(own, reached)
      reached.delete(own)
      const beside = [...reached].sort((a, b) => (label(a) < label(b) ? -1 : 1))
      shapes[symbol.getName()] = [own, ...beside].flatMap((each) =>
        declarationsOf(each).flatMap(declared),
      )
    }
    surface[packageName] ??= {}
    surface[packageName][subpath] = shapes
  }
  return surface
}

// What differs, for a reader: the lines only the release has, then the lines only the packed
// declaration has. The comparison itself is of the whole shape, in order.
function difference(was, now) {
  const added = [...now]
  const removed = was.filter((line) => {
    const at = added.indexOf(line)
    if (at >= 0) added.splice(at, 1)
    return at < 0
  })
  const lines = [...removed.map((l) => `- ${l.trim()}`), ...added.map((l) => `+ ${l.trim()}`)]
  return lines.length > 0 ? lines : ['the same lines in another order']
}

const entriesOf = (table) =>
  Object.entries(table ?? {}).flatMap(([packageName, subpaths]) =>
    Object.entries(subpaths).flatMap(([subpath, names]) =>
      Object.entries(names).map(([name, entry]) => ({
        packageName,
        subpath,
        name,
        entry,
        at: `${packageName} ${subpath}: ${name}`,
      })),
    ),
  )

function check(unpackedRoot, snapshotPath) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  const { release } = snapshot
  const releasedShape = (packageName, subpath, name) =>
    snapshot.surface[packageName]?.[subpath]?.[name]
  const current = packedSurface(unpackedRoot, (...at) => releasedShape(...at) !== undefined)
  const refusals = []
  const blank = (reason) => typeof reason !== 'string' || reason.trim() === ''
  const withdrawn = entriesOf(snapshot.withdrawn)
  for (const { packageName, subpath, name, entry, at } of withdrawn) {
    if (releasedShape(packageName, subpath, name) === undefined)
      refusals.push([`${at} is withdrawn, but ${release} never exported it`])
    if (blank(entry)) refusals.push([`${at} is withdrawn with no reason`])
    if (current[packageName]?.[subpath]?.[name] !== undefined)
      refusals.push([`${at} is withdrawn, but it is still exported`])
  }
  const changed = entriesOf(snapshot.changed)
  for (const { packageName, subpath, name, entry, at } of changed) {
    const was = releasedShape(packageName, subpath, name)
    const now = current[packageName]?.[subpath]?.[name]
    if (blank(entry?.reason)) refusals.push([`${at} is listed as changed with no reason`])
    if (was === undefined)
      refusals.push([`${at} is listed as changed, but ${release} never exported it`])
    else if (snapshot.withdrawn?.[packageName]?.[subpath]?.[name] !== undefined)
      refusals.push([`${at} is both withdrawn and listed as changed`])
    else if (now === undefined) continue
    else if (was.join('\n') === now.join('\n'))
      refusals.push([`${at} is listed as changed, but it is declared as ${release} declared it`])
    else if (entry?.declarationSha256 !== sha256(now.join('\n')))
      refusals.push([
        `${at} is listed as changed, but the sha256 recorded is not the packed declaration's, which is ${sha256(now.join('\n'))}; against ${release} it differs by:`,
        ...difference(was, now),
      ])
  }
  for (const [packageName, subpaths] of Object.entries(snapshot.surface)) {
    for (const [subpath, shapes] of Object.entries(subpaths)) {
      if (current[packageName]?.[subpath] === undefined) {
        refusals.push([`${packageName} ${subpath}: the entry point itself is gone`])
        continue
      }
      for (const [name, was] of Object.entries(shapes)) {
        const at = `${packageName} ${subpath}: ${name}`
        const now = current[packageName][subpath][name]
        if (now === undefined) {
          if (snapshot.withdrawn?.[packageName]?.[subpath]?.[name] === undefined)
            refusals.push([`${at} is gone, and the withdrawn table does not list it`])
        } else if (
          was.join('\n') !== now.join('\n') &&
          snapshot.changed?.[packageName]?.[subpath]?.[name] === undefined
        )
          refusals.push([
            `${at} is declared differently, and the changed table does not list it with a reason and "declarationSha256": "${sha256(now.join('\n'))}"; it differs by:`,
            ...difference(was, now),
          ])
      }
    }
  }
  if (refusals.length > 0) {
    console.error(`package-surface: ${refusals.length} refusal(s) against ${release}:`)
    for (const [first, ...rest] of refusals) {
      console.error(`  ${first}`)
      for (const line of rest) console.error(`      ${line}`)
    }
    process.exit(1)
  }
  const counted = Object.values(snapshot.surface).flatMap((s) =>
    Object.values(s).flatMap(Object.keys),
  )
  console.log(
    `package-surface: every name ${release} exported is still exported and declared as it was, or is withdrawn or changed with a reason (${counted.length} names, ${withdrawn.length} withdrawn, ${changed.length} changed)`,
  )
}

function write(release, tarballDir, snapshotPath) {
  const before = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : {}
  const same = before.release === release
  const unpacked = mkdtempSync(join(tmpdir(), 'durablerun-published-surface.'))
  try {
    const assets = {}
    for (const file of readdirSync(tarballDir).sort()) {
      if (!file.endsWith('.tgz')) continue
      assets[file] = sha256(readFileSync(join(tarballDir, file)))
      if (same && before.assets?.[file] !== assets[file])
        throw new Error(
          `package-surface: ${file} has sha256 ${assets[file]}, and the snapshot of ${release} records ${before.assets?.[file]}`,
        )
      mkdirSync(join(unpacked, file))
      execFileSync('tar', ['-xzf', join(tarballDir, file), '-C', join(unpacked, file)])
    }
    if (Object.keys(assets).length === 0)
      throw new Error(`package-surface: found no tarball in ${tarballDir}`)
    const absent = Object.keys(same ? (before.assets ?? {}) : {}).filter(
      (file) => !(file in assets),
    )
    if (absent.length > 0)
      throw new Error(
        `package-surface: ${tarballDir} lacks ${absent.join(', ')}, which the snapshot of ${release} records`,
      )
    const snapshot = {
      release,
      source:
        'declarations of the published release assets, read and printed with the TypeScript compiler API by scripts/package-surface.mjs --write',
      assets,
      withdrawn: same ? (before.withdrawn ?? {}) : {},
      changed: same ? (before.changed ?? {}) : {},
      surface: packedSurface(unpacked),
    }
    // The repository's formatter decides the layout, so the written file passes its check.
    const formatted = execFileSync(
      fileURLToPath(new URL('../node_modules/.bin/biome', import.meta.url)),
      ['format', `--stdin-file-path=${snapshotPath}`],
      { input: JSON.stringify(snapshot), encoding: 'utf8' },
    )
    writeFileSync(snapshotPath, formatted)
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--write' && args.length === 4) write(args[1], args[2], args[3])
else if (args.length === 2 && args[0] !== '--write') check(args[0], args[1])
else
  throw new Error(
    'usage: package-surface <unpacked-root> <snapshot.json> | --write <release> <tarball-dir> <snapshot.json>',
  )
