import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const checker = join(scriptDirectory, 'package-smoke-manifest.mjs')
const VERSION = '0.1.0-alpha.0'
const PACKAGE_CONTRACTS = {
  '@durablerun/core': { dependencies: [], subpaths: ['.', './testing'] },
  '@durablerun/sdk': { dependencies: ['@durablerun/core'], subpaths: ['.'] },
  '@durablerun/driver': {
    dependencies: ['@durablerun/core', '@durablerun/sdk'],
    subpaths: ['.'],
  },
  '@durablerun/store-libsql': {
    dependencies: ['@durablerun/core'],
    subpaths: ['.', './testing'],
  },
}

const clone = (value) => structuredClone(value)
const targetStem = (subpath) => (subpath === '.' ? 'index' : 'testing')
const set = (path, value) => (manifest) => {
  let target = manifest
  for (const key of path.slice(0, -1)) target = target[key]
  target[path.at(-1)] = value
}
const remove = (path) => (manifest) => {
  let target = manifest
  for (const key of path.slice(0, -1)) target = target[key]
  Reflect.deleteProperty(target, path.at(-1))
}

const canonicalManifest = (name) => {
  const contract = PACKAGE_CONTRACTS[name]
  const manifest = {
    name,
    version: VERSION,
    description: 'self-test package',
    license: 'MIT',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: Object.fromEntries(
      contract.subpaths.map((subpath) => {
        const stem = targetStem(subpath)
        return [subpath, { types: `./dist/${stem}.d.ts`, import: `./dist/${stem}.js` }]
      }),
    ),
    files: ['dist'],
    engines: { node: '>=22.12.0' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/ejc3/durablerun.git',
      directory: `packages/${name.slice('@durablerun/'.length)}`,
    },
    homepage: 'https://github.com/ejc3/durablerun#readme',
    bugs: { url: 'https://github.com/ejc3/durablerun/issues' },
    publishConfig: { access: 'public', tag: 'alpha' },
    dependencies: Object.fromEntries(
      contract.dependencies.map((dependency) => [dependency, VERSION]),
    ),
  }
  if (name === '@durablerun/store-libsql') manifest.dependencies['@libsql/client'] = '^0.15.0'
  if (name === '@durablerun/driver') manifest.peerDependencies = { '@types/node': '>=22.12.0' }
  return manifest
}

const materialize = (name) => {
  const directory = mkdtempSync(join(tmpdir(), 'durablerun-package-manifest-selftest.'))
  const manifest = canonicalManifest(name)
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(directory, 'LICENSE'), 'fixture license\n')
  mkdirSync(join(directory, 'dist'))
  for (const subpath of PACKAGE_CONTRACTS[name].subpaths) {
    const stem = targetStem(subpath)
    writeFileSync(join(directory, 'dist', `${stem}.js`), 'export {}\n')
    writeFileSync(join(directory, 'dist', `${stem}.d.ts`), 'export {}\n')
  }
  return { directory, manifest }
}

const execute = (directory, name, args = [directory, name]) =>
  spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' })

const writeManifest = (directory, manifest) =>
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const BAD_CASES = [
  ['wrong-name', '@durablerun/core', set(['name'], '@durablerun/not-core'), 'name is'],
  ['wrong-version', '@durablerun/core', set(['version'], '0.1.0'), 'version is'],
  ['private-field', '@durablerun/core', set(['private'], false), 'packed manifest is private'],
  ['wrong-license', '@durablerun/core', set(['license'], 'ISC'), 'license is'],
  ['wrong-module-type', '@durablerun/core', set(['type'], 'commonjs'), 'module type is'],
  [
    'wrong-node-floor',
    '@durablerun/core',
    set(['engines', 'node'], '>=20'),
    'Node engine floor drifted',
  ],
  [
    'missing-repository-url',
    '@durablerun/core',
    remove(['repository', 'url']),
    'repository URL is missing or incorrect',
  ],
  [
    'wrong-repository-url',
    '@durablerun/core',
    set(['repository', 'url'], 'https://example.invalid/repo.git'),
    'repository URL is missing or incorrect',
  ],
  ...Object.keys(PACKAGE_CONTRACTS).map((name) => [
    `wrong-repository-directory-${name}`,
    name,
    set(['repository', 'directory'], 'packages/wrong'),
    'repository directory is incorrect',
  ]),
  ['missing-description', '@durablerun/core', remove(['description']), 'description is missing'],
  ['empty-description', '@durablerun/core', set(['description'], ''), 'description is missing'],
  [
    'wrong-homepage',
    '@durablerun/core',
    set(['homepage'], 'https://example.invalid'),
    'homepage is incorrect',
  ],
  [
    'wrong-bugs-url',
    '@durablerun/core',
    set(['bugs', 'url'], 'https://example.invalid'),
    'bugs URL is incorrect',
  ],
  ['wrong-main', '@durablerun/core', set(['main'], './index.js'), 'main does not address'],
  ['wrong-types', '@durablerun/core', set(['types'], './index.d.ts'), 'types do not address'],
  ['wrong-files', '@durablerun/core', set(['files'], ['dist', 'src']), 'files allowlist drifted'],
  [
    'wrong-access',
    '@durablerun/core',
    set(['publishConfig', 'access'], 'restricted'),
    'npm access is not public',
  ],
  [
    'wrong-tag',
    '@durablerun/driver',
    set(['publishConfig', 'tag'], 'latest'),
    'npm dist-tag is not alpha',
  ],
  ...['.', './testing'].flatMap((subpath) => {
    const suffix = subpath === '.' ? 'root' : 'testing'
    return [
      [
        `wrong-${suffix}-import`,
        '@durablerun/core',
        set(['exports', subpath, 'import'], './dist/wrong.js'),
        `${subpath} import target is incorrect`,
      ],
      [
        `wrong-${suffix}-types`,
        '@durablerun/core',
        set(['exports', subpath, 'types'], './dist/wrong.d.ts'),
        `${subpath} types target is incorrect`,
      ],
      [
        `missing-${suffix}-import-file`,
        '@durablerun/core',
        (_m, directory) => rmSync(join(directory, 'dist', `${targetStem(subpath)}.js`)),
        `${subpath} target ./dist/${targetStem(subpath)}.js is absent`,
      ],
      [
        `missing-${suffix}-types-file`,
        '@durablerun/core',
        (_m, directory) => rmSync(join(directory, 'dist', `${targetStem(subpath)}.d.ts`)),
        `${subpath} target ./dist/${targetStem(subpath)}.d.ts is absent`,
      ],
    ]
  }),
  [
    'store-libsql-requires-testing-export',
    '@durablerun/store-libsql',
    remove(['exports', './testing']),
    './testing import target is incorrect',
  ],
  [
    'single-subpath-package-rejects-extra-export',
    '@durablerun/sdk',
    (m) => {
      m.exports['./extra'] = clone(m.exports['.'])
    },
    'packed exports contain an unexpected subpath',
  ],
  ...Object.entries(PACKAGE_CONTRACTS).flatMap(([name, contract]) =>
    contract.dependencies.map((dependency) => [
      `wrong-dependency-${name}-${dependency}`,
      name,
      set(['dependencies', dependency], '^0.1.0'),
      `${dependency} is not pinned to the matching alpha`,
    ]),
  ),
  [
    'unexpected-internal-dependency',
    '@durablerun/core',
    set(['dependencies', '@durablerun/unexpected'], VERSION),
    'unexpected internal dependency',
  ],
  [
    'workspace-range',
    '@durablerun/core',
    set(['dependencies', 'external'], 'workspace:*'),
    'retained a workspace-only range',
  ],
  [
    'non-string-range',
    '@durablerun/core',
    set(['dependencies', 'external'], 1),
    'retained a workspace-only range',
  ],
  [
    'wrong-libsql-runtime',
    '@durablerun/store-libsql',
    set(['dependencies', '@libsql/client'], '^1.0.0'),
    '@libsql/client runtime dependency drifted',
  ],
  [
    'wrong-driver-node-peer',
    '@durablerun/driver',
    set(['peerDependencies', '@types/node'], '>=20'),
    '@types/node peer dependency is missing or incorrect',
  ],
  [
    'missing-license-file',
    '@durablerun/core',
    (_m, directory) => rmSync(join(directory, 'LICENSE')),
    'LICENSE is absent',
  ],
  [
    'unexpected-root-file',
    '@durablerun/core',
    (_m, directory) => writeFileSync(join(directory, 'README.md'), 'unexpected\n'),
    'unexpected packed file README.md',
  ],
]

for (const name of Object.keys(PACKAGE_CONTRACTS)) {
  const { directory } = materialize(name)
  try {
    const result = execute(directory, name)
    assert.equal(
      result.status,
      0,
      `${name} canonical fixture failed:\n${result.stdout}${result.stderr}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const [id, name, mutate, marker] of BAD_CASES) {
  const { directory, manifest } = materialize(name)
  try {
    mutate(manifest, directory)
    writeManifest(directory, manifest)
    const result = execute(directory, name)
    const output = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `${id}: checker accepted the bad fixture`)
    assert.match(
      output,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${id}: wrong rejection:\n${output}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

{
  const { directory } = materialize('@durablerun/core')
  try {
    const unknown = execute(directory, '@durablerun/unknown')
    assert.notEqual(unknown.status, 0, 'unknown-package: checker accepted an unowned package')
    assert.match(unknown.stdout + unknown.stderr, /package-smoke: unknown package/)
    const usage = execute(directory, '@durablerun/core', [])
    assert.notEqual(usage.status, 0, 'missing-arguments: checker accepted an incomplete invocation')
    assert.match(usage.stdout + usage.stderr, /usage: package-smoke-manifest/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

console.log(
  `package-smoke-manifest-selftest: ${BAD_CASES.length + 2} bad inputs rejected and ${Object.keys(PACKAGE_CONTRACTS).length} good inputs accepted`,
)
