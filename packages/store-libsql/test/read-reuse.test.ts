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

  it('no store sends a read it builds on every call', () => {
    // task-done-state is reached only through a transition, which compiles on every call,
    // so it is held here with every other read of every store: readTree builds per call.
    const packages = new URL('../../', import.meta.url)
    const stores = readdirSync(packages).filter((name) => name.startsWith('store-'))
    expect(stores.length).toBeGreaterThanOrEqual(3)
    for (const store of stores) {
      const sources = new URL(`${store}/src/`, packages)
      const text = readdirSync(sources, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(new URL(file, sources), 'utf8'))
        .join('\n')
      expect(text.match(/\.readTree\(/g) ?? [], `${store} builds a read on every call`).toEqual([])
      expect(text.match(/\.readPrepared\(/g)?.length ?? 0, store).toBeGreaterThanOrEqual(9)
      // A read prepared inside a method would be prepared again on every call.
      expect(
        text.match(/prepareRead\(/g)?.length,
        `${store} prepares a read outside module scope`,
      ).toBe(text.match(/^const [A-Z_]+ = prepareRead\(/gm)?.length)
    }
  })
})
