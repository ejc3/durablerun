import { readFileSync, readdirSync } from 'node:fs'
import { type SqlExecutor, type SqlStatement, isTreeBuiltStatement } from '@durablerun/core'
import { describe, expect, it, vi } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { testIdSource } from '../src/testing.js'
import { TREE_DIALECT } from '../src/tree.js'

/**
 * A read outside a transition runs on every driver tick, so it is built, checked and
 * compiled once and sent many times. The property held here is the reuse itself and no
 * wall-clock figure: a second call of a read compiles nothing, and still sends its own
 * values in a statement object of its own.
 */
const READS: Readonly<
  Record<
    string,
    { labels: string[]; call: (s: LibsqlSchedulerStore, v: string) => Promise<unknown> }
  >
> = {
  'next-wake': { labels: ['next-wake'], call: (s, v) => s.nextWakeAtEpochMs(`q-${v}`) },
  'the sweep scans': {
    labels: ['sweep:scan', 'sweep:scan'],
    call: (s, v) => s.sweep(`q-${v}`, 10),
  },
  'task-result': { labels: ['task-result'], call: (s, v) => s.getTaskResult(`q-${v}`, 't') },
  'get-checkpoints': {
    labels: ['get-checkpoints'],
    call: (s, v) => s.getCheckpoints(`q-${v}`, 't', 1),
  },
  'claimed-task-name': {
    labels: ['claimed-task-name'],
    call: (s, v) => s.claimedTaskName(`q-${v}`, 'r', 'token', 1),
  },
  // A run this store never heard of: the terminal write reads its task, finds none, and
  // reads its state to say why it refuses.
  'run-task and refusal-state': {
    labels: ['run-task', 'refusal-state'],
    call: (s, v) => s.complete(`q-${v}`, `run-${v}`, 'token', '"x"'),
  },
}

describe('a read is built once and sent many times', () => {
  for (const [title, { labels, call }] of Object.entries(READS)) {
    it(`${title}: a second call compiles nothing and sends its own values`, async () => {
      const calls: { label: string; statement: SqlStatement }[][] = []
      const executor: SqlExecutor = {
        batch: async (label, statements) => {
          calls.at(-1)?.push(...statements.map((statement) => ({ label, statement })))
          return statements.map(() => ({ rows: [], rowsAffected: 0 }))
        },
      }
      const store = new LibsqlSchedulerStore(executor, testIdSource('read-reuse'))
      calls.push([])
      await call(store, 'first').catch(() => undefined)
      const compile = vi.spyOn(TREE_DIALECT.compiler, 'compileQuery')
      try {
        calls.push([])
        await call(store, 'second').catch(() => undefined)
        expect(compile, 'the second call compiled a statement again').not.toHaveBeenCalled()
      } finally {
        compile.mockRestore()
      }
      const [first, second] = calls
      if (first === undefined || second === undefined) throw new Error('unreachable')
      expect(first.map((sent) => sent.label)).toEqual(labels)
      expect(second.map((sent) => sent.label)).toEqual(labels)
      second.forEach((sent, index) => {
        const before = first[index]?.statement
        expect(sent.statement.sql).toBe(before?.sql)
        expect(sent.statement).not.toBe(before)
        expect(sent.statement.args).not.toBe(before?.args)
        expect(isTreeBuiltStatement(sent.statement)).toBe(true)
        expect(JSON.stringify(sent.statement.args)).toContain('second')
        expect(JSON.stringify(sent.statement.args)).not.toContain('first')
      })
    })
  }

  it('no store sends a read it builds on every call, and neither does the engine logic core runs for it', () => {
    // task-done-state is reached only through a transition, which compiles on every call,
    // so it is held here with every other read: readTree builds per call. It and run-task
    // are sent by core's side of a task's ending, for every store. Every file of core that
    // prepares or sends a read is found here and held to the same three things as a
    // store's sources, so the next one is held without being named.
    const packages = new URL('../../', import.meta.url)
    const sourcesOf = (directory: string) => {
      const sources = new URL(directory, packages)
      return readdirSync(sources, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => ({ file, text: readFileSync(new URL(file, sources), 'utf8') }))
    }
    const stores = readdirSync(packages).filter((name) => name.startsWith('store-'))
    expect(stores.length).toBeGreaterThanOrEqual(3)
    const core = sourcesOf('core/src/').filter(({ text }) =>
      /\.readPrepared\(|= prepareRead\(/.test(text),
    )
    // The scan found the file that sends both reads of a task's ending, so it can find one.
    expect(core.map(({ file }) => file)).toContain('task-done.ts')
    const held = [
      ...stores.map((store) => ({
        name: store,
        text: sourcesOf(`${store}/src/`)
          .map(({ text }) => text)
          .join('\n'),
        reads: 7,
      })),
      ...core.map(({ file, text }) => ({
        name: `core/src/${file}`,
        text,
        reads: file === 'task-done.ts' ? 2 : 1,
      })),
    ]
    for (const { name, text, reads } of held) {
      expect(text.match(/\.readTree\(/g) ?? [], `${name} builds a read on every call`).toEqual([])
      expect(text.match(/\.readPrepared\(/g)?.length ?? 0, name).toBeGreaterThanOrEqual(reads)
      // A read prepared inside a method would be prepared again on every call.
      expect(
        text.match(/prepareRead\(/g)?.length,
        `${name} prepares a read outside module scope`,
      ).toBe(text.match(/^const [A-Z_]+ = prepareRead\(/gm)?.length)
    }
  })
})
