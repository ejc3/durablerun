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
console.log('base compiler probe: the checker executes with the candidate compiler')
