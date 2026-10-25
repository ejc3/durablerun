import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
it('assigns a multiline expect-error marker to its effective directive line', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/typescript-verdict-analyzer.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    input: JSON.stringify({
      sources: {
        'fixture.ts':
          "/* documentation @ts-expect-error mutation-verdict:construction:wrong\n * @ts-expect-error mutation-verdict:construction:right */\nconst value: number = 'bad'\n",
      },
    }),
  })
  expect(run.status, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout).files['fixture.ts'].expectErrorVerdictMarkers).toEqual([
    ['mutation-verdict:construction:right', 2],
  ])
})
