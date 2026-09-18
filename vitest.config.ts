import { configDefaults, defineConfig } from 'vitest/config'

// Test files that need one dialect's server, outside the conformance package, whose own
// dialect loop reads the same selection. A run told which dialects it has
// (DURABLERUN_CONFORMANCE_DIALECTS, a comma list) leaves out the files of the others.
// Unset, every file runs.
const SERVER_TEST_FILES: Readonly<Record<string, readonly string[]>> = {
  mysql: ['packages/store-mysql/test/real-server.test.ts'],
}
const selection = process.env.DURABLERUN_CONFORMANCE_DIALECTS
const selected = selection === undefined ? null : selection.split(',').map((name) => name.trim())
const withoutAServer =
  selected === null
    ? []
    : Object.entries(SERVER_TEST_FILES)
        .filter(([dialect]) => !selected.includes(dialect))
        .flatMap(([, files]) => files)

// Both limits move together. The default, 5000 ms, left PostgreSQL conformance tests that
// take 3.5 to 5 s on a CI runner no room, and the PostgreSQL fixture is created and
// dropped in hooks under the same load. 15 s is three times the slowest seen. A test with
// no timeout of its own that blocks past the limit fails once it finishes. A test that
// declares a larger timeout, as the long libSQL ones do, is not bound by it.
const LIMIT_MS = 15_000

// One vitest configuration for every run in this repository. tsconfig.vitest.json
// puts this file under tsc, because vitest loads a misspelled key without a word and
// falls back to its default. root-vitest-config.test.ts reads the limit back.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...withoutAServer],
    testTimeout: LIMIT_MS,
    hookTimeout: LIMIT_MS,
  },
})
