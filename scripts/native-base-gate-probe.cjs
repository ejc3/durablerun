// Exercise a base-owned analyzer with the compiler installed for the candidate.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const analyzer = process.argv[2] ?? path.join(__dirname, 'typescript-verdict-analyzer.cjs')
const run = spawnSync(process.execPath, [analyzer], {
  encoding: 'utf8',
  timeout: 30_000,
  input: JSON.stringify({ sources: { 'fixture.ts': 'export const value = 1\n' } }),
})
assert.equal(run.status, 0, run.stderr)
assert.deepEqual(JSON.parse(run.stdout).files['fixture.ts'].diagnostics, [])
const surface = path.join(path.dirname(analyzer), 'package-surface.mjs')
const surfaceRun = spawnSync(process.execPath, [surface], { encoding: 'utf8', timeout: 30_000 })
assert.equal(surfaceRun.status, 1, surfaceRun.stderr)
assert.match(surfaceRun.stderr, /usage: package-surface/, surfaceRun.stderr)
assert.doesNotMatch(surfaceRun.stderr, /TypeError/, surfaceRun.stderr)
console.log('base compiler probe: both checkers load with the candidate compiler')
