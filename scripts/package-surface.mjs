// Fail when a packed package no longer exports a name its last release exported, or
// declares one differently without saying so.
//
// Usage: node scripts/package-surface.mjs <unpacked-root> <snapshot.json>
//        node scripts/package-surface.mjs --packed <unpacked-root> <snapshot.json>
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
// consumer cannot construct the class. A value that is exported as a type only says so in one
// line, because a consumer can no longer use it as a value. That is asked of a consumer's
// compiler, through a module for each entry point that exists only in the check and uses
// every exported name as a value. A whole module exported as a namespace has no shape here
// and is refused by name, so that no release records one the check cannot hold. The check does
// not judge whether a difference breaks a consumer. Any difference is refused until the
// snapshot says why it is there.
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
// --packed prints, as JSON, the shape of every packed name as the check reads it against that
// snapshot. The smoke's controls use it to say, in a copy of the snapshot, how a name they
// borrow is declared now.
//
// --write replaces the snapshot from a directory of release tarballs: it records each
// tarball's sha256, unpacks it, and prints the shapes. It refuses a directory with no tarball.
// Written over a snapshot of the same release, it also refuses a tarball whose sha256 differs
// from the one recorded, a tarball the snapshot does not record, and a directory that lacks a
// recorded one, and it keeps the two tables; a new release starts with both empty. Every such
// refusal comes before a tarball is unpacked. The repository's formatter lays the file out, in
// whatever directory the command is given. Compare the recorded sha256 of each tarball with
// the release receipt before committing a new snapshot.
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
const pinOf = (shape) => sha256(shape.join('\n'))
const same = (was, now) => was.join('\n') === now.join('\n')
const by = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const find = (table, { packageName, subpath, name }) => table?.[packageName]?.[subpath]?.[name]
const TYPE_ONLY = '(a value exported as a type only)'
const NAMESPACE =
  'exports a whole module as a namespace, which has no shape here: export its names one by one, or teach this check the shape of a namespace before a release records one'
// TS1362: a name cannot be used as a value because it was exported using `export type`.
const EXPORTED_AS_A_TYPE = 1362

// A private constructor is not hidden: it says that a consumer cannot construct the class.
const isPrivate = (member) =>
  !ts.isConstructorDeclaration(member) &&
  ((member.name !== undefined && ts.isPrivateIdentifier(member.name)) ||
    (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0)

const HOW_EXPORTED = [
  ts.SyntaxKind.ExportKeyword,
  ts.SyntaxKind.DefaultKeyword,
  ts.SyntaxKind.DeclareKeyword,
]
const unexported = (node) => node.modifiers?.filter(({ kind }) => !HOW_EXPORTED.includes(kind))

// One declaration as lines, without the modifiers that say how it is exported.
function declared(node) {
  const print = (shown) => printer.printNode(ts.EmitHint.Unspecified, shown, node.getSourceFile())
  if (ts.isVariableDeclaration(node)) {
    const flags = node.parent.flags
    const keyword = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
    return `${keyword} ${print(node)};`.split('\n')
  }
  if (!ts.isClassDeclaration(node))
    return print(ts.factory.replaceModifiers(node, unexported(node))).split('\n')
  const members = node.members.filter((member) => !isPrivate(member))
  const lines = print(
    ts.factory.updateClassDeclaration(
      node,
      unexported(node),
      node.name,
      node.typeParameters,
      node.heritageClauses,
      members,
    ),
  ).split('\n')
  if (members.length < node.members.length) lines.splice(-1, 0, '    (private members)')
  return lines
}

// Every identifier of a declaration is asked what it names, so a name is reached however the
// declaration refers to it: a type reference, a heritage clause, a `typeof` query, a computed
// key, an `import()` type. One that names no top-level declaration of the packed packages,
// a member, a parameter, a type parameter, a library type, is dropped by the caller.
function identifiers(node, visit) {
  if (ts.isIdentifier(node)) visit(node)
  ts.forEachChild(node, (child) => identifiers(child, visit))
}

function exportsOf(program, { packageName, subpath, file }) {
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)
  const symbol = source && checker.getSymbolAtLocation(source)
  if (!symbol) throw new Error(`package-surface: cannot read ${packageName} ${subpath} (${file})`)
  return checker.getExportsOfModule(symbol)
}

// released({ packageName, subpath, name }) says whether the release exported the name. A
// released name is compared under its own entry, so no other name's shape reaches into it.
function packedSurface(unpackedRoot, released = () => true) {
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
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    // No printed line comes from the compiler's own library, so it is not parsed.
    noLib: true,
    skipLibCheck: true,
    baseUrl: '/',
    paths,
    types: [],
  }
  // How a name is exported is asked of a consumer's compiler. For each entry point a module
  // that exists only here imports every exported name and uses each as a value, one to a line,
  // and the compiler says which of them were exported as a type only. The names come from a
  // first program, and the two programs parse each file once.
  const host = ts.createCompilerHost(options)
  const consumers = new Map()
  const parsed = new Map()
  const fromDisk = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, how, ...rest) => {
    if (!parsed.has(fileName)) {
      const text = consumers.get(fileName)
      parsed.set(
        fileName,
        text === undefined
          ? fromDisk(fileName, how, ...rest)
          : ts.createSourceFile(fileName, text, how),
      )
    }
    return parsed.get(fileName)
  }
  const named = ts.createProgram(roots, options, host)
  for (const [index, entry] of entries.entries()) {
    const { packageName, subpath } = entry
    entry.names = exportsOf(named, entry).map((symbol) => symbol.getName())
    entry.consumer = join(resolve(unpackedRoot), `package-surface-consumer-${index}.mts`)
    const imports = entry.names.map((name, at) => `${name} as v${at}`).join(', ')
    const from = subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`
    consumers.set(
      entry.consumer,
      [`import { ${imports} } from '${from}'`, ...entry.names.map((_, at) => `v${at}`)].join('\n'),
    )
  }
  const program = ts.createProgram([...roots, ...consumers.keys()], options, host)
  const checker = program.getTypeChecker()
  const typeOnly = ({ packageName, subpath, names, consumer }) => {
    const source = program.getSourceFile(consumer)
    if (program.getSyntacticDiagnostics(source).length > 0)
      throw new Error(
        `package-surface: cannot import every name of ${packageName} ${subpath} to ask how it is exported`,
      )
    return new Set(
      program
        .getSemanticDiagnostics(source)
        .filter(({ code }) => code === EXPORTED_AS_A_TYPE)
        .map(({ start }) => names[ts.getLineAndCharacterOfPosition(source, start).line - 1]),
    )
  }
  // Where a declaration sits in the packed packages, or undefined for the compiler's own
  // library and for a dependency, whose declarations are not this repository's to hold.
  const place = (node) => {
    const file = node.getSourceFile().fileName
    const home = packages.find(({ dir }) => file.startsWith(dir + sep))
    return home && `${home.name}/${relative(home.dir, file)}`
  }
  // A module is no declaration of its own: what a namespace import names is not reached, and
  // the names read through it are.
  const topLevel = (node) => {
    if (ts.isSourceFile(node)) return false
    const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node
    return ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent)
  }
  const resolved = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  const declarationsOf = (symbol) =>
    (symbol.declarations ?? [])
      .filter((node) => place(node) !== undefined && topLevel(node))
      .sort((a, b) => by(place)(a, b) || a.pos - b.pos)
  const exported = entries.map((entry) => ({ ...entry, symbols: exportsOf(program, entry) }))
  const compared = new Set()
  for (const { packageName, subpath, symbols } of exported)
    for (const symbol of symbols)
      if (released({ packageName, subpath, name: symbol.getName() })) compared.add(resolved(symbol))
  const reach = (symbol, reached) => {
    for (const declaration of declarationsOf(symbol))
      identifiers(declaration, (identifier) => {
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
  const namespaces = []
  for (const entry of exported) {
    const { packageName, subpath, symbols } = entry
    const asTypes = typeOnly(entry)
    const shapes = {}
    for (const symbol of symbols.sort(by((each) => each.getName()))) {
      const own = resolved(symbol)
      if (own.declarations?.some(ts.isSourceFile)) {
        namespaces.push(`${packageName} ${subpath}: ${symbol.getName()}`)
        continue
      }
      const reached = new Set([own])
      reach(own, reached)
      reached.delete(own)
      const beside = [...reached].sort(by(label))
      shapes[symbol.getName()] = [
        ...(asTypes.has(symbol.getName()) ? [TYPE_ONLY] : []),
        ...[own, ...beside].flatMap((each) => declarationsOf(each).flatMap(declared)),
      ]
    }
    surface[packageName] ??= {}
    surface[packageName][subpath] = shapes
  }
  return { surface, namespaces }
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

// The packed packages, read against a snapshot: the names it lists are the released ones.
const packedAgainst = (unpackedRoot, snapshot) =>
  packedSurface(unpackedRoot, (at) => find(snapshot.surface, at) !== undefined)

function check(unpackedRoot, snapshotPath) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  const { release } = snapshot
  const { surface: current, namespaces } = packedAgainst(unpackedRoot, snapshot)
  const refusals = []
  const blank = (reason) => typeof reason !== 'string' || reason.trim() === ''
  const withdrawn = entriesOf(snapshot.withdrawn)
  for (const listed of withdrawn) {
    const { entry, at } = listed
    if (find(snapshot.surface, listed) === undefined)
      refusals.push([`${at} is withdrawn, but ${release} never exported it`])
    if (blank(entry)) refusals.push([`${at} is withdrawn with no reason`])
    if (find(current, listed) !== undefined)
      refusals.push([`${at} is withdrawn, but it is still exported`])
  }
  const changed = entriesOf(snapshot.changed)
  for (const listed of changed) {
    const { entry, at } = listed
    const was = find(snapshot.surface, listed)
    const now = find(current, listed)
    if (blank(entry?.reason)) refusals.push([`${at} is listed as changed with no reason`])
    if (was === undefined)
      refusals.push([`${at} is listed as changed, but ${release} never exported it`])
    else if (find(snapshot.withdrawn, listed) !== undefined)
      refusals.push([`${at} is both withdrawn and listed as changed`])
    else if (now === undefined) continue
    else if (same(was, now))
      refusals.push([`${at} is listed as changed, but it is declared as ${release} declared it`])
    else if (entry?.declarationSha256 !== pinOf(now))
      refusals.push([
        `${at} is listed as changed, but the sha256 recorded is not the packed declaration's, which is ${pinOf(now)}; against ${release} it differs by:`,
        ...difference(was, now),
      ])
  }
  for (const [packageName, subpaths] of Object.entries(snapshot.surface))
    for (const subpath of Object.keys(subpaths))
      if (current[packageName]?.[subpath] === undefined)
        refusals.push([`${packageName} ${subpath}: the entry point itself is gone`])
  for (const at of namespaces) refusals.push([`${at} ${NAMESPACE}`])
  const released = entriesOf(snapshot.surface)
  for (const exported of released) {
    const { packageName, subpath, entry: was, at } = exported
    if (current[packageName]?.[subpath] === undefined) continue
    const now = find(current, exported)
    if (now === undefined) {
      if (find(snapshot.withdrawn, exported) === undefined)
        refusals.push([`${at} is gone, and the withdrawn table does not list it`])
    } else if (!same(was, now) && find(snapshot.changed, exported) === undefined)
      refusals.push([
        `${at} is declared differently, and the changed table does not list it with a reason and "declarationSha256": "${pinOf(now)}"; it differs by:`,
        ...difference(was, now),
      ])
  }
  if (refusals.length > 0) {
    console.error(`package-surface: ${refusals.length} refusal(s) against ${release}:`)
    for (const [first, ...rest] of refusals) {
      console.error(`  ${first}`)
      for (const line of rest) console.error(`      ${line}`)
    }
    process.exit(1)
  }
  console.log(
    `package-surface: every name ${release} exported is still exported and declared as it was, or is withdrawn or changed with a reason (${released.length} names, ${withdrawn.length} withdrawn, ${changed.length} changed)`,
  )
}

function write(release, tarballDir, snapshotPath) {
  const refuse = (what) => {
    throw new Error(`package-surface: ${what}`)
  }
  const before = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : {}
  const recorded = before.release === release ? (before.assets ?? {}) : undefined
  const assets = {}
  for (const file of readdirSync(tarballDir).sort())
    if (file.endsWith('.tgz')) assets[file] = sha256(readFileSync(join(tarballDir, file)))
  if (Object.keys(assets).length === 0) refuse(`found no tarball in ${tarballDir}`)
  for (const [file, digest] of Object.entries(recorded === undefined ? {} : assets)) {
    if (recorded[file] === undefined)
      refuse(`${file} is not a tarball the snapshot of ${release} records`)
    if (recorded[file] !== digest)
      refuse(
        `${file} has sha256 ${digest}, and the snapshot of ${release} records ${recorded[file]}`,
      )
  }
  const absent = Object.keys(recorded ?? {}).filter((file) => !(file in assets))
  if (absent.length > 0)
    refuse(`${tarballDir} lacks ${absent.join(', ')}, which the snapshot of ${release} records`)
  const unpacked = mkdtempSync(join(tmpdir(), 'durablerun-published-surface.'))
  try {
    for (const file of Object.keys(assets)) {
      mkdirSync(join(unpacked, file))
      execFileSync('tar', ['-xzf', join(tarballDir, file), '-C', join(unpacked, file)])
    }
    const { surface, namespaces } = packedSurface(unpacked)
    if (namespaces.length > 0) refuse(`${namespaces[0]} ${NAMESPACE}`)
    const snapshot = {
      release,
      source:
        'declarations of the published release assets, read and printed with the TypeScript compiler API by scripts/package-surface.mjs --write',
      assets,
      withdrawn: recorded === undefined ? {} : (before.withdrawn ?? {}),
      changed: recorded === undefined ? {} : (before.changed ?? {}),
      surface,
    }
    // The repository's formatter decides the layout, so the written file passes its check. It
    // runs in the repository, where its configuration is, and is told a path there, so the
    // layout does not depend on where the command was given or where the snapshot is written.
    const repository = fileURLToPath(new URL('..', import.meta.url))
    const formatted = execFileSync(
      join(repository, 'node_modules/.bin/biome'),
      ['format', '--stdin-file-path=scripts/published-surface.json'],
      { cwd: repository, input: JSON.stringify(snapshot), encoding: 'utf8' },
    )
    writeFileSync(snapshotPath, formatted)
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--write' && args.length === 4) write(args[1], args[2], args[3])
else if (args[0] === '--packed' && args.length === 3)
  console.log(
    JSON.stringify(packedAgainst(args[1], JSON.parse(readFileSync(args[2], 'utf8'))).surface),
  )
else if (args.length === 2 && !args[0].startsWith('--')) check(args[0], args[1])
else
  throw new Error(
    'usage: package-surface <unpacked-root> <snapshot.json> | --packed <unpacked-root> <snapshot.json> | --write <release> <tarball-dir> <snapshot.json>',
  )
