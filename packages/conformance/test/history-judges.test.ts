import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC = new URL('../src/', import.meta.url)

/**
 * The files of this package that call the invariant library directly, and why each may.
 * Every other judge of rows goes through `engineHistoryViolations`, which runs the
 * child-task checker and the saga checker beside the library. A generated surface or a
 * seeded race that calls the library alone leaves two checkers out without a word, and
 * it did: three did when the helper arrived. A file that starts to call the library has
 * to be written down here with its reason, which is where that choice gets made.
 */
const CALLS_THE_LIBRARY_DIRECTLY: Readonly<Record<string, string>> = {
  'invariants.ts': 'defines the library',
  'engine-history.ts': 'is the one helper, and runs the library beside the other two checkers',
  'suite.ts': 'holds scenario cases that name the library, some over a task ended by hand',
  'child-tasks.ts':
    'asserts the library inside a case and runs the child-task checker after each, so that a failure names one checker',
  'stale-token-column.ts':
    "judges the poison matrix's seeds, which end a task by hand and so carry no completion event",
}

describe('who judges rows by the invariant library alone', () => {
  it('is only a file that is listed here with its reason', () => {
    const callers = readdirSync(SRC)
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          readFileSync(new URL(file, SRC), 'utf8').includes('engineInvariantViolations('),
      )
      .sort()
    expect(callers).toEqual(Object.keys(CALLS_THE_LIBRARY_DIRECTLY).sort())
  })
})
