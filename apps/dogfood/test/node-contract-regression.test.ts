import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('declares the Node floor required by the dogfood command line', () => {
  const root = join(import.meta.dirname, '../../..')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string }
    scripts?: Record<string, string>
  }
  const dogfoodCommands = Object.entries(manifest.scripts ?? {}).filter(([name]) =>
    name.startsWith('dogfood:'),
  )

  expect(dogfoodCommands).not.toEqual([])
  expect(dogfoodCommands.every(([, command]) => command.includes('--env-file-if-exists'))).toBe(
    true,
  )
  expect(manifest.engines?.node).toBe('>=22.9')
})
