import { defineConfig } from 'vitest/config'

// One definition of the per-test timeout for every vitest run in this
// repository. The default, 5000 ms, left PostgreSQL conformance tests that take
// 3.5 s on a quiet CI runner no room on a loaded one.
export default defineConfig({
  test: { testTimeout: 30_000 },
})
