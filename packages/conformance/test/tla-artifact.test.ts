import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

describe('TLA tool artifact', () => {
  it('runs from the repository without downloading a mutable release asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-artifact-'))
    scratch.push(root)
    const bin = join(root, 'bin')
    const curlLog = join(root, 'curl.log')
    const javaLog = join(root, 'java.log')
    await mkdir(bin)

    const curl = join(bin, 'curl')
    await writeFile(
      curl,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nexit 55\n`,
    )
    await chmod(curl, 0o755)

    const java = join(bin, 'java')
    await writeFile(
      java,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$JAVA_LOG"\nif [[ "\${1:-}" == '-version' ]]; then\n  printf '%s\\n' 'openjdk version "25-test"' >&2\n  exit 0\nfi\nprintf '%s\\n' 'Model checking completed. No error has been found.'\n`,
    )
    await chmod(java, 0o755)

    const result = spawnSync('bash', ['scripts/tla.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        JAVA_LOG: javaLog,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TLA_CACHE_DIR: join(root, 'empty-cache'),
        TLA_HEAP_MB: '2048',
        TLA_JAVA: java,
        TLA_ONLY: 'liveness1',
      },
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(await readIfPresent(curlLog)).toBe('')
    expect(await readIfPresent(javaLog)).toContain('tools/tla/tla2tools.jar')
    expect(await readIfPresent(javaLog)).toContain('SchedulerLiveness1.cfg')
  })
})
