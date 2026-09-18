import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$JAVA_LOG"
if [[ "\${1:-}" == '-version' ]]; then
  printf '%s\\n' 'openjdk version "25-test"' >&2
  exit 0
fi
# By default every model passes. A test may ask for witnessed probes, and for
# mutant runs that are caught or that violate some other property.
cfg=''; meta=''; prev=''
for arg in "$@"; do
  [[ "$prev" == '-config' ]] && cfg="$arg"
  [[ "$prev" == '-metadir' ]] && meta="$arg"
  prev="$arg"
done
probe="\${cfg%.cfg}"
if [[ "$probe" == *Probe* ]]; then
  # How many probes are alive at once, for the test that bounds it.
  if [[ -n "\${STUB_LIVE_DIR:-}" ]]; then
    : > "$STUB_LIVE_DIR/$$"
    ls "$STUB_LIVE_DIR" | wc -l >> "$STUB_LIVE_DIR.peaks"
    sleep 0.1
    rm -f "$STUB_LIVE_DIR/$$"
  fi
  case "\${STUB_PROBES_WITNESSED:-}" in
    action)
      printf '%s\\n' "Error: Action property $probe is violated."
      exit 13
      ;;
    ?*)
      printf '%s\\n' "Error: Invariant $probe is violated."
      exit 12
      ;;
  esac
fi
if [[ "$meta" == */mutants/* ]]; then
  # A caught mutant violates a property of ITS OWN model's list, so a runner that
  # hands one model's mutants to another model's run is not reported as a catch.
  model="\${meta#*/mutants/}"
  model="\${model%%/*}"
  case "\${STUB_MUTANTS:-}" in
    caught)
      grep -ohE '"caughtBy": "[A-Za-z]+"' "$STUB_MUTANTS_DIR/$model.mutants.json" | sort -u |
        sed -E 's/.*: "(.*)"/Error: Invariant \\1 is violated./'
      exit 12
      ;;
    wrong)
      printf '%s\\n' 'Error: Invariant SomethingElse is violated.'
      exit 12
      ;;
  esac
fi
printf '%s\\n' 'Model checking completed. No error has been found.'
`,
  )
  await chmod(java, 0o755)
  return { bin, curlLog, java, javaLog }
}

type FakeCommands = Awaited<ReturnType<typeof fakeCommands>>

function runTla(
  cwd: string,
  commands: FakeCommands,
  extraEnv: Readonly<Record<string, string>> = {},
) {
  return spawnSync('bash', ['scripts/tla.sh'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CURL_LOG: commands.curlLog,
      JAVA_LOG: commands.javaLog,
      PATH: `${commands.bin}:${process.env.PATH ?? ''}`,
      TLA_HEAP_MB: '2048',
      TLA_JAVA: commands.java,
      TLA_ONLY: 'liveness1',
      ...extraEnv,
    },
  })
}

async function copyFixtureRepository(
  root: string,
  includeArtifact: boolean,
): Promise<{ readonly fixture: string; readonly jar: string }> {
  const fixture = join(root, 'repo')
  const jar = join(fixture, 'tools', 'tla', 'tla2tools.jar')
  await mkdir(join(fixture, 'scripts'), { recursive: true })
  await mkdir(join(fixture, 'specs'), { recursive: true })
  await mkdir(join(fixture, 'tools', 'tla'), { recursive: true })
  await copyFile(join(repoRoot, 'scripts', 'tla.sh'), join(fixture, 'scripts', 'tla.sh'))
  if (includeArtifact) {
    await copyFile(join(repoRoot, 'tools', 'tla', 'tla2tools.jar'), jar)
  }
  return { fixture, jar }
}

describe('TLA tool artifact', () => {
  it('runs from the repository without downloading a mutable release asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-artifact-'))
    scratch.push(root)
    const commands = await fakeCommands(root)
    const result = runTla(repoRoot, commands, {
      TLA_CACHE_DIR: join(root, 'empty-cache'),
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(await readIfPresent(commands.curlLog)).toBe('')
    expect(await readIfPresent(commands.javaLog)).toContain('tools/tla/tla2tools.jar')
    expect(await readIfPresent(commands.javaLog)).toContain('SchedulerLiveness1.cfg')
    // A liveness job runs its own target. A side model that regresses must not stop it.
    expect(await readIfPresent(commands.javaLog)).not.toMatch(/ChildTasks|Sagas|mutants/)
  })

  describe('the side-model gate', () => {
    const CFG = 'CONSTANTS\n  X = 1\nSPECIFICATION Spec\nINVARIANT\n  Inv\n  Other\n'
    const mutant = (name: string, caughtBy: string, find: string) => ({
      name,
      guard: `the guard ${name} bends`,
      caughtBy,
      find,
      replace: 'TRUE',
    })
    // Two small side models. AlphaBeta's name begins with Alpha's, and it has one
    // configuration only, the two shapes a glob over file names gets wrong.
    const FILES: Readonly<Record<string, string>> = {
      'Scheduler.tla': 'placeholder',
      'Scheduler.cfg': 'placeholder',
      'Probes.tla': 'placeholder',
      'WakeDelivery.tla': 'placeholder',
      'WakeDelivery.cfg': 'placeholder',
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`ProbeNoThing${n}.cfg`, 'placeholder'])),
      'Alpha.tla': 'GUARD_ONE\nGUARD_TWO\n',
      'Alpha.cfg': CFG,
      'AlphaOther.cfg': CFG.replace('X = 1', 'X = 2'),
      'AlphaProbes.tla': 'placeholder',
      'AlphaProbeWitness.cfg': 'placeholder',
      'Alpha.mutants.json': JSON.stringify(
        [mutant('one', 'Inv', 'GUARD_ONE'), mutant('two', 'Other', 'GUARD_TWO')],
        null,
        2,
      ),
      'AlphaBeta.tla': 'GUARD_BETA\n',
      'AlphaBeta.cfg': CFG.replace('Other', 'BetaInv'),
      'AlphaBetaProbes.tla': 'placeholder',
      'AlphaBetaProbeSeen.cfg': 'placeholder',
      'AlphaBeta.mutants.json': JSON.stringify([mutant('three', 'BetaInv', 'GUARD_BETA')], null, 2),
    }

    async function runFixture(
      env: Readonly<Record<string, string>>,
      edit: (files: Readonly<Record<string, string>>) => Record<string, string> = (files) => ({
        ...files,
      }),
    ) {
      const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-gate-'))
      scratch.push(root)
      const { fixture } = await copyFixtureRepository(root, true)
      const files = edit(FILES)
      await Promise.all(
        Object.entries(files).map(([name, text]) => writeFile(join(fixture, 'specs', name), text)),
      )
      const commands = await fakeCommands(root)
      const live = join(root, 'live')
      await mkdir(live)
      const result = runTla(fixture, commands, {
        TLA_ONLY: 'safety',
        STUB_PROBES_WITNESSED: '1',
        STUB_MUTANTS: 'caught',
        STUB_MUTANTS_DIR: join(fixture, 'specs'),
        STUB_LIVE_DIR: live,
        ...env,
      })
      return {
        javaLog: await readIfPresent(commands.javaLog),
        output: `${result.stdout}\n${result.stderr}`,
        peaks: (await readIfPresent(`${live}.peaks`)).split('\n').filter(Boolean).map(Number),
        status: result.status,
      }
    }

    it('passes the real lists when every mutant violates the property its entry names', async () => {
      const specs = join(repoRoot, 'specs')
      const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-mutants-'))
      scratch.push(root)
      const commands = await fakeCommands(root)
      const result = runTla(repoRoot, commands, {
        TLA_ONLY: 'safety',
        STUB_PROBES_WITNESSED: '1',
        STUB_MUTANTS: 'caught',
        STUB_MUTANTS_DIR: specs,
      })
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.status, output).toBe(0)
      const lists = (await readdir(specs)).filter((file) => file.endsWith('.mutants.json'))
      expect(lists.sort()).toEqual(['ChildTasks.mutants.json', 'Sagas.mutants.json'])
      for (const list of lists) {
        const entries = JSON.parse(await readFile(join(specs, list), 'utf8')) as readonly unknown[]
        const model = list.slice(0, -'.mutants.json'.length)
        expect(entries.length).toBeGreaterThan(0)
        expect(output).toContain(`${model} mutants: ${entries.length} of ${entries.length} caught`)
      }
      // Every probe cfg beside the specs is run and witnessed, one line each.
      const probes = (await readdir(specs)).filter((file) => /Probe.*\.cfg$/.test(file))
      for (const probe of probes) {
        expect(output).toContain(`ok: ${probe.slice(0, -'.cfg'.length)} witnessed`)
      }
    })

    it('runs each model under its own configurations, probes, and mutants', async () => {
      const { javaLog, output, status } = await runFixture({})
      expect(status, output).toBe(0)
      expect(output).toContain('Alpha mutants: 2 of 2 caught')
      expect(output).toContain('AlphaBeta mutants: 1 of 1 caught')
      for (const run of [
        '-config Alpha.cfg Alpha.tla',
        '-config AlphaOther.cfg Alpha.tla',
        '-config AlphaBeta.cfg AlphaBeta.tla',
        '-config AlphaProbeWitness.cfg AlphaProbes.tla',
        '-config AlphaBetaProbeSeen.cfg AlphaBetaProbes.tla',
        '-config ProbeNoThing1.cfg Probes.tla',
      ]) {
        expect(javaLog, run).toContain(run)
      }
      expect(javaLog).not.toMatch(/-config AlphaBeta\S* Alpha(Probes)?\.tla/)
    })

    it('fails when the mutants survive', async () => {
      const { output, status } = await runFixture({ STUB_MUTANTS: 'survive' })
      expect(status, output).not.toBe(0)
      expect(output).not.toContain('VACUOUS')
      for (const name of ['Alpha/one', 'Alpha/two', 'AlphaBeta/three']) {
        expect(output).toContain(`SURVIVED: ${name}`)
      }
      expect(output).toContain('Alpha mutants: 0 of 2 caught')
    })

    it('fails when a mutant violates only some other property', async () => {
      const { output, status } = await runFixture({ STUB_MUTANTS: 'wrong' })
      expect(status, output).not.toBe(0)
      expect(output).not.toContain('VACUOUS')
      for (const name of ['Alpha/one', 'Alpha/two', 'AlphaBeta/three']) {
        expect(output).toContain(`WRONG-PROPERTY: ${name}`)
      }
    })

    it('fails when a model loses its mutant list', async () => {
      const { output, status } = await runFixture({}, (files) =>
        Object.fromEntries(
          Object.entries(files).filter(([name]) => name !== 'AlphaBeta.mutants.json'),
        ),
      )
      expect(status, output).not.toBe(0)
      expect(output).toContain('AlphaBeta.tla is checked by nothing')
    })

    it('fails when one configuration of a model checks less than the others', async () => {
      const { output, status } = await runFixture({}, (files) => ({
        ...files,
        'AlphaOther.cfg': (files['AlphaOther.cfg'] ?? '').replace('  Other\n', ''),
      }))
      expect(status, output).not.toBe(0)
      expect(output).toContain('AlphaOther.cfg does not check what Alpha.cfg checks')
    })

    it('takes a violated action property as a probe witness', async () => {
      const { output, status } = await runFixture({ STUB_PROBES_WITNESSED: 'action' })
      expect(status, output).toBe(0)
      expect(output).toContain('ok: AlphaProbeWitness witnessed')
    })

    it('runs no more probes at once than the heap budget holds', async () => {
      const { output, peaks, status } = await runFixture({})
      expect(status, output).toBe(0)
      // Eight probes at 512 MB each under a 2048 MB budget: four at a time.
      expect(peaks).toHaveLength(8)
      expect(Math.max(...peaks)).toBeGreaterThan(1)
      expect(Math.max(...peaks)).toBeLessThanOrEqual(4)
    })

    it('gives a side-model probe a small fixed heap, whatever the budget', async () => {
      const { javaLog, output, status } = await runFixture({ TLA_HEAP_MB: '8192' })
      expect(status, output).toBe(0)
      const line = (cfg: string) =>
        javaLog.split('\n').find((entry) => entry.includes(`-config ${cfg}`))
      expect(line('AlphaProbeWitness.cfg')).toContain('-Xmx256m')
      expect(line('ProbeNoThing1.cfg')).toContain('-Xmx512m')
    })
  })

  it('rejects a corrupted repository checker before Java starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-corrupt-'))
    scratch.push(root)
    const { fixture, jar } = await copyFixtureRepository(root, true)
    const artifact = await readFile(jar)
    artifact[0] = (artifact[0] ?? 0) ^ 0xff
    await writeFile(jar, artifact)
    const commands = await fakeCommands(root)
    const result = runTla(fixture, commands)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker failed integrity',
    )
    expect(await readIfPresent(commands.curlLog)).toBe('')
    expect(await readIfPresent(commands.javaLog)).toBe('')
  })

  it('rejects a missing repository checker without a network fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-missing-'))
    scratch.push(root)
    const { fixture } = await copyFixtureRepository(root, false)
    const commands = await fakeCommands(root)
    const result = runTla(fixture, commands)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker is missing',
    )
    expect(await readIfPresent(commands.curlLog)).toBe('')
    expect(await readIfPresent(commands.javaLog)).toBe('')
  })

  it('classifies an unreadable checker digest as infrastructure failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durablerun-tla-unreadable-'))
    scratch.push(root)
    const { fixture } = await copyFixtureRepository(root, true)
    const commands = await fakeCommands(root)
    const sha256sum = join(commands.bin, 'sha256sum')
    await writeFile(
      sha256sum,
      `#!/usr/bin/env bash\nprintf '%s\\n' 'sha256sum: checker: Permission denied' >&2\nexit 1\n`,
    )
    await chmod(sha256sum, 0o755)

    const result = runTla(fixture, commands)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'INFRA ERROR: vendored TLA checker failed integrity',
    )
    expect(await readIfPresent(commands.curlLog)).toBe('')
    expect(await readIfPresent(commands.javaLog)).toBe('')
  })

  it('records the licenses and source for bundled third-party code', async () => {
    const readme = await readFile(join(repoRoot, 'tools', 'tla', 'README.md'), 'utf8')

    const archive = spawnSync('unzip', ['-Z1', join(repoRoot, 'tools', 'tla', 'tla2tools.jar')], {
      encoding: 'utf8',
    })
    expect(archive.status, archive.stderr).toBe(0)
    const classEntries = archive.stdout.split('\n').filter((entry) => entry.endsWith('.class'))
    const projectOwnedPrefixes = [
      'model/',
      'org/apache/commons/math3/util/TLCFastMath.class',
      'org/eclipse/xtext/xbase/lib/Pure.class',
      'org/eclipse/xtext/xbase/lib/util/ToStringBuilder.class',
      'pcal/',
      'tla2sany/',
      'tla2tex/',
      'tlc2/',
      'util/',
    ]
    const bundledComponents = [
      {
        heading: 'TLA+ Formatter import 7aa6a56',
        prefixes: ['formatter/'],
        record: [
          'Apache-2.0',
          '7aa6a566138d7b17043cadb16a9d2af62ae4944a',
          'renamed to `formatter`',
        ],
      },
      {
        heading: 'Gson 2.14.0',
        prefixes: ['com/google/gson/', 'META-INF/versions/9/module-info.class'],
        record: ['Apache-2.0', 'gson-2.14.0-sources.jar'],
      },
      {
        heading: 'prettier4j 0.3.2',
        prefixes: ['com/opencastsoftware/prettier4j/'],
        record: ['Apache-2.0', 'prettier4j-0.3.2-sources.jar'],
      },
      {
        heading: 'Jakarta Mail 1.6.8',
        prefixes: ['com/sun/mail/', 'javax/mail/', 'module-info.class'],
        record: [
          'EPL-2.0 or GPL-2.0 with the Classpath Exception',
          'Jakarta-Mail-NOTICE.md',
          'mailapi-1.6.8-sources.jar',
          'smtp-1.6.8-sources.jar',
        ],
      },
      {
        heading: 'Activation 1.1',
        prefixes: ['javax/activation/'],
        record: [
          'Apache-2.0',
          'Activation-NOTICE.txt',
          'javax.activation.source_1.1.0.v201211130549.jar',
        ],
      },
      {
        heading: 'Apache Commons Math',
        prefixes: ['org/apache/commons/math3/'],
        record: ['Apache-2.0', 'CommonsMath-NOTICE.txt'],
      },
      {
        heading: 'Eclipse LSP4J 0.21.1',
        prefixes: ['org/eclipse/lsp4j/'],
        record: [
          'EPL-2.0 OR BSD-3-Clause',
          'LSP4J-NOTICE.md',
          'org.eclipse.lsp4j.jsonrpc-0.21.1-sources.jar',
        ],
      },
      {
        heading: 'JLine 3.25.0',
        prefixes: ['org/jline/'],
        record: ['BSD-3-Clause', 'JLine-LICENSE.txt'],
      },
    ] as const

    const coveredPrefixes = bundledComponents.flatMap(({ prefixes }) => prefixes)
    const ambiguouslyOwnedClasses = classEntries.filter((entry) => {
      const projectOwners = projectOwnedPrefixes.filter((prefix) => entry.startsWith(prefix))
      const componentOwners =
        projectOwners.length === 0
          ? coveredPrefixes.filter((prefix) => entry.startsWith(prefix))
          : []
      return projectOwners.length + componentOwners.length !== 1
    })
    expect(ambiguouslyOwnedClasses).toEqual([])
    for (const component of bundledComponents) {
      for (const prefix of component.prefixes) {
        expect(
          classEntries.some(
            (entry) =>
              entry.startsWith(prefix) &&
              !projectOwnedPrefixes.some((owned) => entry.startsWith(owned)),
          ),
          prefix,
        ).toBe(true)
      }
      const sectionStart = readme.indexOf(`### ${component.heading}`)
      expect(sectionStart, component.heading).toBeGreaterThanOrEqual(0)
      const nextSection = readme.indexOf('\n### ', sectionStart + 1)
      const section = readme.slice(sectionStart, nextSection === -1 ? undefined : nextSection)
      const normalizedSection = section.replace(/\s+/g, ' ')
      for (const expected of component.record) {
        expect(normalizedSection, `${component.heading}: ${expected}`).toContain(expected)
      }
    }

    const activationNotice = await readFile(
      join(repoRoot, 'tools', 'tla', 'Activation-NOTICE.txt'),
      'utf8',
    )
    expect(activationNotice).toContain('Activation 1.1')
    expect(activationNotice).toContain('Copyright 2003-2007 The Apache Software Foundation')
    const lsp4jNotice = await readFile(join(repoRoot, 'tools', 'tla', 'LSP4J-NOTICE.md'), 'utf8')
    expect(lsp4jNotice).toContain('Notices for Eclipse LSP4J')
    expect(lsp4jNotice).toContain('SPDX-License-Identifier: EPL-2.0 OR BSD-3-Clause')
    const mailNotice = await readFile(
      join(repoRoot, 'tools', 'tla', 'Jakarta-Mail-NOTICE.md'),
      'utf8',
    )
    expect(mailNotice).toContain('Notices for Jakarta Mail')
    expect(mailNotice).toContain(
      'SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0',
    )
    const jlineLicense = await readFile(join(repoRoot, 'tools', 'tla', 'JLine-LICENSE.txt'), 'utf8')
    expect(jlineLicense).toContain('Copyright (c) 2002-2023')

    expect(readme).not.toContain('this distribution are MIT licensed')
    expect(readme).toContain('META-INF/LICENSE.md')
    expect(readme).toContain('CommonsMath-LICENSE.txt')
    expect(readme).toContain('jline-LICENSE.txt')
    expect(readme).toContain('mailapi-1.6.8-sources.jar')
    expect(readme).toContain('smtp-1.6.8-sources.jar')
  })

  it('keeps one milestone owner and the actual historical dogfood cadence', async () => {
    const build = await readFile(join(repoRoot, 'BUILD.md'), 'utf8')
    const agents = await readFile(join(repoRoot, 'AGENTS.md'), 'utf8')

    const normalizedBuild = build.replace(/\s+/g, ' ')
    const normalizedAgents = agents.replace(/\s+/g, ' ')
    expect(normalizedBuild).toContain('15** 12-hour cycles')
    expect(normalizedBuild).toContain('Hourly ticks launched those cycles')
    expect(build.match(/^## Current milestone — /gm)).toHaveLength(1)
    expect(normalizedAgents).toContain(
      'BUILD.md alone names the current milestone and its exit test',
    )
  })
})
