import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEEK_REFUSALS, sealOf } from '../../../apps/dogfood/src/week-receipt.js'
import { parseInvocation } from '../src/commands.js'
import { CAUSES } from '../src/explain.js'
import { ROOT } from './support.js'

/**
 * The README's "Operating a deployment" gives an operator command lines to copy, and
 * DESIGN.md names the causes the week receipt's checker refuses for. These hold both to the
 * code: a flag the CLI renames, or a cause the checker gains, fails here until the document
 * says the same.
 */

const read = (name: string): string => readFileSync(join(ROOT, name), 'utf8')

/** A command line's words, as a shell splits them: by spaces, with single quotes kept whole. */
function words(line: string): string[] {
  return [...line.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '')
}

/** The lines of a document's `sh` blocks. */
function shellLines(document: string): string[] {
  return [...document.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((block) =>
    (block[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  )
}

describe('the documents of operating a deployment', () => {
  it('gives only command lines the CLI takes', () => {
    const lines = shellLines(read('README.md')).filter((line) => line.startsWith('pnpm cli '))
    const verbs = lines.map((line) => parseInvocation(words(line).slice(2)).spec.verb)
    // The order's commands, the three that find and act, and the week's enqueue.
    expect([...new Set(verbs)].sort()).toEqual([
      'cancel',
      'enqueue',
      'explain',
      'inspect',
      'migrate',
      'purge',
      'selftest',
      'stuck',
    ])
    // A line that drops a required flag is one the CLI refuses, so this reads a refusal.
    expect(() => parseInvocation(words('pnpm cli purge --queue example-queue').slice(2))).toThrow(
      /requires --target/,
    )
  })

  it("seals what the README's hash line seals", () => {
    const line = shellLines(read('README.md')).find((found) => found.includes('sha256sum'))
    expect(line).toBeDefined()
    const injection = { taskId: 'task-1', cause: 'awaiting-an-untimed-event', nonce: 'nonce-1' }
    const printed = execFileSync('bash', ['-c', line ?? ''], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TASK_ID: injection.taskId,
        CAUSE: injection.cause,
        NONCE: injection.nonce,
      },
    })
    expect(printed.split(' ')[0]).toBe(sealOf(injection))
  })

  it('names, in the steps of the sealed injection, only causes explain can name and refusals the checker makes, and BUILD.md names the same ones', () => {
    const readme = read('README.md')
    const steps = readme.slice(readme.indexOf('**The sealed injection.**'))
    // Every name of the steps that is written as a cause or a refusal is: lower case words
    // joined by hyphens, in backticks.
    const named = [...steps.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map(
      (match) => match[1] ?? '',
    )
    const refusals: readonly string[] = WEEK_REFUSALS
    const causes = named.filter((name) => !refusals.includes(name))
    expect(causes.filter((name) => !Object.hasOwn(CAUSES, name))).toEqual([])
    // The cause right after the enqueue, and the one each kind of injected task holds once
    // the deployment has taken it, which the week on the release alpha.1 also requires.
    expect([...new Set(causes)].sort()).toEqual([
      'awaiting-an-untimed-event',
      'never-started-alpha1-form',
      'pending-due-unclaimed',
    ])
    expect(named.filter((name) => refusals.includes(name))).toEqual([
      'explanation-differs-from-the-seal',
    ])
    const build = read('BUILD.md')
    const receipt = build.slice(build.indexOf('**Receipt M1'))
    const paragraph = receipt.slice(0, receipt.indexOf('NOT MET'))
    for (const name of new Set(named)) expect(paragraph).toContain(`\`${name}\``)
  })

  it("names in DESIGN.md every cause the week receipt's checker refuses for", () => {
    const design = read('DESIGN.md')
    const table = design.slice(design.indexOf('| Cause | Refused when |'))
    const rows = table.slice(0, table.indexOf('\n\n')).split('\n').slice(2)
    expect(rows.map((row) => row.split('|')[1]?.trim())).toEqual([...WEEK_REFUSALS])
  })
})
