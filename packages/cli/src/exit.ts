/**
 * The CLI's exit codes, one table. DESIGN.md section 3.11 holds the same table, and a
 * test parses both and requires them equal. A command declares which of these it can
 * give by name, in the command table.
 */
export const EXITS = Object.freeze([
  { code: 0, name: 'done', meaning: 'the command did what it says' },
  {
    code: 1,
    name: 'internal',
    meaning: 'an error the CLI does not expect, a defect; its message prints only with --reveal',
  },
  {
    code: 2,
    name: 'usage',
    meaning: 'usage, confirmation-required or target-mismatch; nothing was changed',
  },
  { code: 3, name: 'refused', meaning: 'the engine refused the call, and says why' },
  { code: 4, name: 'unauthorized', meaning: 'unauthenticated or forbidden' },
  {
    code: 5,
    name: 'schema',
    meaning:
      "the database's schema version is outside the store's readable window, or the database is not initialized",
  },
  { code: 6, name: 'unavailable', meaning: 'the store is unavailable; safe to repeat' },
  { code: 7, name: 'permanent', meaning: 'the store answered with a permanent error' },
  { code: 8, name: 'not-found', meaning: 'no such task in the queue' },
  { code: 9, name: 'found', meaning: 'stuck --fail-if-any found rows' },
] as const)

export type ExitName = (typeof EXITS)[number]['name']

export function exitCode(name: ExitName): number {
  const found = EXITS.find((exit) => exit.name === name)
  if (found === undefined) throw new Error(`no exit code is named ${name}`)
  return found.code
}
