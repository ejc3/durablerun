import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function fakeCommands(root: string): Promise<{
  readonly bin: string
  readonly curlLog: string
  readonly java: string
  readonly javaLog: string
}> {
  const bin = join(root, 'bin')
  const curlLog = join(root, 'curl.log')
  const javaLog = join(root, 'java.log')
  await mkdir(bin)

  const curl = join(bin, 'curl')
  await writeFile(curl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nexit 55\n`)
  await chmod(curl, 0o755)

  const java = join(bin, 'java')
  await writeFile(
    java,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$JAVA_LOG"\nif [[ "\${1:-}" == '-version' ]]; then\n  printf '%s\\n' 'openjdk version "25-test"' >&2\n  exit 0\nfi\nprintf '%s\\n' 'Model checking completed. No error has been found.'\n`,
  )
  await chmod(java, 0o755)
  return { bin, curlLog, java, javaLog }
}

describe('TLA tool artifact', () => {
  it('runs from the repository without downloading a mutable release asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-artifact-'))
    scratch.push(root)
    const { bin, curlLog, java, javaLog } = await fakeCommands(root)

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

  it('rejects a corrupted repository checker before Java starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-corrupt-'))
    scratch.push(root)
    const fixture = join(root, 'repo')
    await mkdir(join(fixture, 'scripts'), { recursive: true })
    await mkdir(join(fixture, 'specs'), { recursive: true })
    await mkdir(join(fixture, 'tools', 'tla'), { recursive: true })
    await copyFile(join(repoRoot, 'scripts', 'tla.sh'), join(fixture, 'scripts', 'tla.sh'))
    const jar = join(fixture, 'tools', 'tla', 'tla2tools.jar')
    await copyFile(join(repoRoot, 'tools', 'tla', 'tla2tools.jar'), jar)
    const artifact = await readFile(jar)
    artifact[0] = (artifact[0] ?? 0) ^ 0xff
    await writeFile(jar, artifact)
    const { bin, curlLog, java, javaLog } = await fakeCommands(root)

    const result = spawnSync('bash', ['scripts/tla.sh'], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        JAVA_LOG: javaLog,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TLA_HEAP_MB: '2048',
        TLA_JAVA: java,
        TLA_ONLY: 'liveness1',
      },
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker failed integrity',
    )
    expect(await readIfPresent(curlLog)).toBe('')
    expect(await readIfPresent(javaLog)).toBe('')
  })

  it('rejects a missing repository checker without a network fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-missing-'))
    scratch.push(root)
    const fixture = join(root, 'repo')
    await mkdir(join(fixture, 'scripts'), { recursive: true })
    await mkdir(join(fixture, 'specs'), { recursive: true })
    await copyFile(join(repoRoot, 'scripts', 'tla.sh'), join(fixture, 'scripts', 'tla.sh'))
    const { bin, curlLog, java, javaLog } = await fakeCommands(root)

    const result = spawnSync('bash', ['scripts/tla.sh'], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        JAVA_LOG: javaLog,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TLA_HEAP_MB: '2048',
        TLA_JAVA: java,
        TLA_ONLY: 'liveness1',
      },
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker is missing',
    )
    expect(await readIfPresent(curlLog)).toBe('')
    expect(await readIfPresent(javaLog)).toBe('')
  })

  it('classifies an unreadable checker digest as infrastructure failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-unreadable-'))
    scratch.push(root)
    const fixture = join(root, 'repo')
    await mkdir(join(fixture, 'scripts'), { recursive: true })
    await mkdir(join(fixture, 'specs'), { recursive: true })
    await mkdir(join(fixture, 'tools', 'tla'), { recursive: true })
    await copyFile(join(repoRoot, 'scripts', 'tla.sh'), join(fixture, 'scripts', 'tla.sh'))
    await copyFile(
      join(repoRoot, 'tools', 'tla', 'tla2tools.jar'),
      join(fixture, 'tools', 'tla', 'tla2tools.jar'),
    )
    const { bin, curlLog, java, javaLog } = await fakeCommands(root)
    const sha256sum = join(bin, 'sha256sum')
    await writeFile(
      sha256sum,
      `#!/usr/bin/env bash\nprintf '%s\\n' 'sha256sum: checker: Permission denied' >&2\nexit 1\n`,
    )
    await chmod(sha256sum, 0o755)

    const result = spawnSync('bash', ['scripts/tla.sh'], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURL_LOG: curlLog,
        JAVA_LOG: javaLog,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TLA_HEAP_MB: '2048',
        TLA_JAVA: java,
        TLA_ONLY: 'liveness1',
      },
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker failed integrity',
    )
    expect(await readIfPresent(curlLog)).toBe('')
    expect(await readIfPresent(javaLog)).toBe('')
  })

  it('records the licenses and source for bundled third-party code', async () => {
    const readme = await readFile(join(repoRoot, 'tools', 'tla', 'README.md'), 'utf8')

    expect(readme).not.toContain('this distribution are MIT licensed')
    expect(readme).toContain('META-INF/LICENSE.md')
    expect(readme).toContain('CommonsMath-LICENSE.txt')
    expect(readme).toContain('jline-LICENSE.txt')
    expect(readme).toContain('mailapi-1.6.8-sources.jar')
    expect(readme).toContain('smtp-1.6.8-sources.jar')
  })
})
