import { engineHistoryViolations } from '@durablerun/conformance'
import type { SqlExecutor } from '@durablerun/core'
import { expect } from 'vitest'

/** The rows a test leaves satisfy everything a history that the engine wrote must. */
export async function expectCleanRows(f: { readonly raw: SqlExecutor }): Promise<void> {
  expect(await engineHistoryViolations(f.raw)).toEqual([])
}
