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
    meaning:
      "an error the CLI does not expect, a defect; its message prints only with --reveal, and never from the bin's last catch",
  },
  {
    code: 2,
    name: 'usage',
    meaning:
      'usage, confirmation-required, target-mismatch, origin-mismatch or fake-clock; nothing was changed, and no request went to a deployment',
  },
  { code: 3, name: 'refused', meaning: 'the engine refused the call, and says why' },
  {
    code: 4,
    name: 'unauthorized',
    meaning:
      'the deployment tick called refused the token it was sent; a wrong store credential exits 6',
  },
  {
    code: 5,
    name: 'schema',
    meaning:
      "the database's schema version is outside the store's readable window, the database is not initialized, or purge was asked of a database that is not at the build's version",
  },
  {
    code: 6,
    name: 'unavailable',
    meaning:
      'the store is unavailable, or the deployment tick called could not be reached, did not answer in time, or answered that it cannot now (408, 425, 429, or a 5xx that is not a 500 of a hosted route itself); safe to repeat, with retries capped, because a wrong store credential exits 6 too',
  },
  {
    code: 7,
    name: 'permanent',
    meaning:
      'the store answered with a permanent error, or the deployment answered tick with what the command takes for no outage: a status no tick route gives, a 500 of a hosted route itself, or a 200 that is no JSON object or is too long to read',
  },
  { code: 8, name: 'not-found', meaning: 'no such task in the queue' },
  {
    code: 9,
    name: 'found',
    meaning: 'stuck --fail-if-any listed at least one row',
  },
  {
    code: 10,
    name: 'unreadable',
    meaning:
      "a stored row the store's decoders refuse, a stored integer outside its bounds, or a stored state that is not the engine's own; what refused a row prints only with --reveal, because it can quote the row",
  },
] as const)

export type ExitName = (typeof EXITS)[number]['name']

export function exitCode(name: ExitName): number {
  const found = EXITS.find((exit) => exit.name === name)
  if (found === undefined) throw new Error(`no exit code is named ${name}`)
  return found.code
}
