import { expect, it } from 'vitest'

// Vitest loads a misspelled key in silence and falls back to 5000 ms. tsc refuses the
// misspelling through tsconfig.vitest.json, and this fails if that leg or the root
// configuration itself goes away.
it('runs under the root vitest configuration', ({ task }) => {
  expect(task.timeout).toBe(15_000)
})
