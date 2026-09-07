import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [packageDir, expectedName] = process.argv.slice(2)
if (!packageDir || !expectedName) {
  throw new Error('usage: package-smoke-manifest package-dir package-name')
}

const expectedDirectories = new Map([
  ['@durablerun/core', 'packages/core'],
  ['@durablerun/sdk', 'packages/sdk'],
  ['@durablerun/driver', 'packages/driver'],
  ['@durablerun/store-libsql', 'packages/store-libsql'],
])
const expectedInternalDependencies = new Map([
  ['@durablerun/core', []],
  ['@durablerun/sdk', ['@durablerun/core']],
  ['@durablerun/driver', ['@durablerun/core', '@durablerun/sdk']],
  ['@durablerun/store-libsql', ['@durablerun/core']],
])

const repositoryDirectory = expectedDirectories.get(expectedName)
const expectedDependencies = expectedInternalDependencies.get(expectedName)
if (!repositoryDirectory || !expectedDependencies) {
  throw new Error(`package-smoke: unknown package ${expectedName}`)
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const fail = (message) => {
  throw new Error(`package-smoke: ${expectedName}: ${message}`)
}

if (manifest.name !== expectedName) fail(`name is ${String(manifest.name)}`)
if (manifest.version !== '0.1.0-alpha.0') fail(`version is ${String(manifest.version)}`)
if (manifest.private !== undefined) fail('packed manifest is private')
if (manifest.license !== 'MIT') fail(`license is ${String(manifest.license)}`)
if (manifest.type !== 'module') fail(`module type is ${String(manifest.type)}`)
if (manifest.engines?.node !== '>=22.12.0') fail('Node engine floor drifted')
if (manifest.repository?.url !== 'git+https://github.com/ejc3/durablerun.git') {
  fail('repository URL is missing or incorrect')
}
if (manifest.repository?.directory !== repositoryDirectory)
  fail('repository directory is incorrect')
if (typeof manifest.description !== 'string' || manifest.description.length === 0) {
  fail('description is missing')
}
if (manifest.homepage !== 'https://github.com/ejc3/durablerun#readme') fail('homepage is incorrect')
if (manifest.bugs?.url !== 'https://github.com/ejc3/durablerun/issues')
  fail('bugs URL is incorrect')
if (manifest.main !== './dist/index.js') fail('main does not address the production build')
if (manifest.types !== './dist/index.d.ts') fail('types do not address the production declarations')
if (JSON.stringify(manifest.files) !== JSON.stringify(['dist'])) fail('files allowlist drifted')
if (manifest.publishConfig?.access !== 'public') fail('npm access is not public')
if (manifest.publishConfig?.tag !== 'alpha') fail('npm dist-tag is not alpha')

const requiredSubpaths =
  expectedName === '@durablerun/core' || expectedName === '@durablerun/store-libsql'
    ? ['.', './testing']
    : ['.']
for (const subpath of requiredSubpaths) {
  const target = manifest.exports?.[subpath]
  if (target?.import !== `./dist/${subpath === '.' ? 'index' : 'testing'}.js`) {
    fail(`${subpath} import target is incorrect`)
  }
  if (target?.types !== `./dist/${subpath === '.' ? 'index' : 'testing'}.d.ts`) {
    fail(`${subpath} types target is incorrect`)
  }
  for (const path of [target.import, target.types]) {
    if (!existsSync(join(packageDir, path.slice(2)))) fail(`${subpath} target ${path} is absent`)
  }
}
if (Object.keys(manifest.exports ?? {}).length !== requiredSubpaths.length) {
  fail('packed exports contain an unexpected subpath')
}

const dependencies = manifest.dependencies ?? {}
for (const dependency of expectedDependencies) {
  if (dependencies[dependency] !== '0.1.0-alpha.0') {
    fail(`${dependency} is not pinned to the matching alpha`)
  }
}
for (const [dependency, range] of Object.entries(dependencies)) {
  if (dependency.startsWith('@durablerun/') && !expectedDependencies.includes(dependency)) {
    fail(`unexpected internal dependency ${dependency}`)
  }
  if (typeof range !== 'string' || range.startsWith('workspace:')) {
    fail(`${dependency} retained a workspace-only range`)
  }
}
if (expectedName === '@durablerun/store-libsql' && dependencies['@libsql/client'] !== '^0.15.0') {
  fail('@libsql/client runtime dependency drifted')
}
if (
  expectedName === '@durablerun/driver' &&
  manifest.peerDependencies?.['@types/node'] !== '>=22.12.0'
) {
  fail('@types/node peer dependency is missing or incorrect')
}

const walk = (directory, prefix = '') =>
  readdirSync(directory).flatMap((entry) => {
    const relative = join(prefix, entry)
    const absolute = join(directory, entry)
    return statSync(absolute).isDirectory() ? walk(absolute, relative) : [relative]
  })
const files = walk(packageDir)
if (!files.includes('LICENSE')) fail('LICENSE is absent')
if (!files.some((path) => path.endsWith('.js'))) fail('compiled JavaScript is absent')
if (!files.some((path) => path.endsWith('.d.ts'))) fail('declarations are absent')
for (const path of files) {
  if (path !== 'LICENSE' && path !== 'package.json' && !path.startsWith('dist/')) {
    fail(`unexpected packed file ${path}`)
  }
}
