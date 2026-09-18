import { defineConfig } from 'vitest/config'

// One vitest configuration for every run in this repository. tsconfig.vitest.json
// puts this file under tsc, because vitest loads a misspelled key without a word and
// falls back to its default.
export default defineConfig({
  test: {
    // The default, 5000 ms, left PostgreSQL conformance tests that take 3.5 to 5 s on a
    // CI runner no room. The limit also caps a test that never yields, which vitest
    // fails once it finishes late: 15 s keeps such a test under vitest's 60 s worker
    // deadline even on a runner two and a half times slower.
    testTimeout: 15_000,
    // The PostgreSQL fixture is created and dropped in hooks, under the same load.
    hookTimeout: 15_000,
  },
})
