import { defineConfig } from 'vitest/config'

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
    testTimeout: LIMIT_MS,
    hookTimeout: LIMIT_MS,
  },
})
