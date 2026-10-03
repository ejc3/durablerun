import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMANDS, VERBS, usage } from '../src/commands.js'
import { EXITS } from '../src/exit.js'
import { runCli } from './support.js'

const DESIGN = fileURLToPath(new URL('../../../DESIGN.md', import.meta.url))

/** The rows of the exit-code table in DESIGN.md section 3.11. */
function designExitTable(): { code: number; name: string; meaning: string }[] {
  const text = readFileSync(DESIGN, 'utf8')
  const start = text.indexOf('### 3.11 The operator CLI')
  const end = text.indexOf('\n## ', start)
  expect(start, 'DESIGN.md has section 3.11').toBeGreaterThan(0)
  return text
    .slice(start, end)
    .split('\n')
    .map((line) => /^\| (\d+) \| ([a-z-]+) \| (.+) \|$/.exec(line))
    .filter((match) => match !== null)
    .map(([, code, name, meaning]) => ({
      code: Number(code),
      name: name ?? '',
      meaning: meaning ?? '',
    }))
}

describe('the exit-code table', () => {
  it("DESIGN.md's table is the one in the code", () => {
    expect(designExitTable()).toEqual(
      EXITS.map(({ code, name, meaning }) => ({ code, name, meaning })),
    )
  })

  it('help --json lists every command of the table, and every exit code', async () => {
    const run = await runCli(['help', '--json'], {})
    expect(run.exit).toBe(0)
    const help = JSON.parse(run.stdout) as {
      commands: { name: string; usage: string; exits: string[] }[]
      exits: { code: number; name: string }[]
    }
    expect(help.commands.map((command) => command.name)).toEqual([...VERBS])
    for (const command of help.commands) {
      const spec = COMMANDS[command.name as (typeof VERBS)[number]]
      expect(command.usage).toBe(usage(spec))
      for (const exit of command.exits) expect(EXITS.map((e) => e.name)).toContain(exit)
    }
    expect(help.exits.map((exit) => exit.code)).toEqual(EXITS.map((exit) => exit.code))
  })

  it('an unknown command, flag or missing argument exits 2 and opens nothing', async () => {
    const env = { DURABLERUN_STORE_URL: 'mysql://root@127.0.0.1:1/never' }
    for (const argv of [
      [],
      ['nope'],
      ['result', '--queue', 'q'],
      ['doctor', '--queue', 'q', '--nope'],
    ]) {
      const run = await runCli(argv, env)
      expect({ argv: argv.join(' '), exit: run.exit }).toEqual({ argv: argv.join(' '), exit: 2 })
    }
    const unset = await runCli(['doctor', '--queue', 'q', '--json'], {})
    expect(unset.exit).toBe(2)
    expect(JSON.parse(unset.stdout)).toMatchObject({ error: { kind: 'usage' } })
  })
})
