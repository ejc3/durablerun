import { describe, expect, it } from 'vitest'
import { COMMANDS, type CommandSpec, UsageError, VERBS, parseInvocation } from '../src/commands.js'
import { exitCode } from '../src/exit.js'
import type { StoreOpener } from '../src/open-store.js'
import {
  type JsonAnswer,
  PURGE_WINDOWS,
  changedBy,
  onDb,
  runCli,
  seedTasks,
  writeFlags,
} from './support.js'

/**
 * A flag given twice is refused, for every command. The parser would otherwise keep the
 * last value, and a command line that names `--completed-after` as a hundred years and
 * then as an hour would purge under the hour: the windows a purge requires are one of the
 * things that stop a run that was not meant, and a line that contradicts itself is not a
 * line anybody meant. The refusal is the parser's, before anything opens, and it names
 * the flag. The cases are generated from the command table, strings and booleans alike.
 */

const VALUE = 'a-value'

/** A command line of `spec` with every argument and every required flag given once. */
function once(spec: CommandSpec): string[] {
  const line: string[] = [spec.verb, ...spec.positionals.map(() => VALUE)]
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.required === true) line.push(`--${name}`, VALUE)
  }
  return line
}

/** What the parser refuses a command line with, or null when it takes it. */
function refusal(argv: readonly string[]): string | null {
  try {
    parseInvocation(argv)
    return null
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    return error.message
  }
}

describe('a flag given twice', () => {
  it('is refused by name for every flag of every command, in every spelling, and a flag given once is not', () => {
    const notRefused: string[] = []
    const refusedOnce: string[] = []
    let flags = 0
    for (const verb of VERBS) {
      const spec = COMMANDS[verb]
      const base = once(spec)
      for (const [name, flag] of Object.entries(spec.flags)) {
        flags += 1
        const given = flag.required === true
        const twice: Record<string, string[]> =
          flag.type === 'boolean'
            ? { twice: [...base, `--${name}`, `--${name}`] }
            : {
                'with two values': [
                  ...base,
                  ...(given ? [] : [`--${name}`, VALUE]),
                  `--${name}`,
                  'another',
                ],
                'with one value': [
                  ...base,
                  ...(given ? [] : [`--${name}`, VALUE]),
                  `--${name}`,
                  VALUE,
                ],
                'joined to its value': [
                  ...base,
                  ...(given ? [] : [`--${name}=${VALUE}`]),
                  `--${name}=another`,
                ],
                'in both spellings': [
                  ...base,
                  ...(given ? [] : [`--${name}`, VALUE]),
                  `--${name}=${VALUE}`,
                ],
              }
        for (const [spelling, argv] of Object.entries(twice)) {
          const said = refusal(argv)
          if (said === null || !said.startsWith(`--${name} is given twice`)) {
            notRefused.push(
              `${verb} --${name} ${spelling}: ${said === null ? 'taken' : said.split('\n')[0]}`,
            )
          }
        }
        // The neighbour: the same flag once. It may be refused for another reason, as a
        // flag that stands in for an argument is beside that argument, and never for this.
        const single = given
          ? base
          : flag.type === 'boolean'
            ? [...base, `--${name}`]
            : [...base, `--${name}=${VALUE}`]
        if (refusal(single)?.includes('is given twice') === true) {
          refusedOnce.push(`${verb} --${name}`)
        }
      }
    }
    expect({ notRefused, refusedOnce }).toEqual({ notRefused: [], refusedOnce: [] })
    expect(flags).toBeGreaterThan(VERBS.length)
  })

  it('exits 2 before anything opens, and a purge whose window is named twice changes nothing', () =>
    onDb('flag-twice-purge', async (db) => {
      await seedTasks(db)
      await db.admin.setFakeNowEpochMs(null)
      const opened: string[] = []
      const opener: StoreOpener = async (url) => {
        opened.push(url)
        throw new Error('a store was opened')
      }
      // A hundred years, and then an hour: the last value would purge the completed task.
      const line = [
        'purge',
        '--completed-after',
        '36500d',
        '--cancelled-after',
        '36500d',
        '--completed-after',
        '1h',
        '--execute',
        ...writeFlags(db),
        '--json',
      ]
      const run = await changedBy(db, () => runCli(line, db.env, opener))
      const answer = JSON.parse(run.out.stdout) as JsonAnswer
      // The same line with the window named once is taken, and purges under it.
      const single = await changedBy(db, () =>
        runCli(['purge', ...PURGE_WINDOWS, '--execute', ...writeFlags(db), '--json'], db.env),
      )
      expect({
        exit: run.out.exit,
        kind: answer.error?.kind,
        names: answer.error?.message?.startsWith('--completed-after is given twice'),
        opened,
        unchanged: run.unchanged,
        once: [single.out.exit, single.unchanged],
      }).toEqual({
        exit: exitCode('usage'),
        kind: 'usage',
        names: true,
        opened: [],
        unchanged: true,
        once: [0, false],
      })
    }))
})
