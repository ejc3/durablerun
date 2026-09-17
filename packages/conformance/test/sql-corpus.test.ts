import { readFileSync, writeFileSync } from 'node:fs'
import type { SqlBatchControl, SqlExecutor, SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { DIALECT_FIXTURES } from './dialect-fixtures.js'

/**
 * The generated SQL corpus: every statement a tree-built label compiles to, per
 * dialect, as ordered SQL plus bind arity. The corpus is derived, never hand-kept.
 * Regenerate with `DURABLERUN_UPDATE_CORPUS=1`.
 *
 * Each enrolled label declares its variants, the distinct statement lists it may
 * compile to. A label that compiles to a signature outside the corpus, or to more
 * signatures than it declares, fails: a new branch must be declared, not discovered.
 */
const TREE_LABELS: Readonly<Record<string, readonly string[]>> = {
  complete: ['completed'],
}

type Signature = readonly { sql: string; bindArity: number }[]

function recordingExecutor(raw: SqlExecutor, recorded: Map<string, Signature[]>): SqlExecutor {
  return {
    batch: (label: string, statements: readonly SqlStatement[], control?: SqlBatchControl) => {
      if (label in TREE_LABELS) {
        const signature = statements.map(({ sql, args }) => ({ sql, bindArity: args.length }))
        const seen = recorded.get(label) ?? []
        if (!seen.some((known) => JSON.stringify(known) === JSON.stringify(signature))) {
          seen.push(signature)
        }
        recorded.set(label, seen)
      }
      return raw.batch(label, statements, control)
    },
  }
}

describe('generated SQL corpus', () => {
  for (const { dialect, makeFixture } of DIALECT_FIXTURES) {
    it(`${dialect}: every tree-built label compiles to its declared corpus`, async () => {
      const fixture = await makeFixture(`sql-corpus-${dialect}`)
      const recorded = new Map<string, Signature[]>()
      try {
        const store = fixture.storeOver(recordingExecutor(fixture.raw, recorded))
        await store.spawn('q', 'job', '{}')
        const [run] = await store.claim('q', 'w1', { leaseSeconds: 60, limit: 1 })
        if (run === undefined) throw new Error('expected a claimable run')
        const activated = await store.activate('q', run.runId, run.claimToken, run.claimGen)
        if (activated === null) throw new Error('expected activation')
        await store.complete('q', run.runId, run.claimToken, '"done"')
      } finally {
        await fixture.close()
      }
      const corpus = Object.fromEntries(
        Object.entries(TREE_LABELS).map(([label, variants]) => {
          const signatures = recorded.get(label) ?? []
          if (signatures.length === 0) throw new Error(`${dialect}: no ${label} batch ran`)
          if (signatures.length > variants.length) {
            throw new Error(
              `${dialect}: ${label} compiled to ${signatures.length} signatures but declares ${variants.length} variants`,
            )
          }
          return [
            label,
            Object.fromEntries(signatures.map((signature, i) => [variants[i], signature])),
          ]
        }),
      )
      const path = new URL(`../corpus/${dialect}.json`, import.meta.url)
      const text = `${JSON.stringify(corpus, null, 2)}\n`
      if (process.env.DURABLERUN_UPDATE_CORPUS === '1') writeFileSync(path, text)
      expect(text).toBe(readFileSync(path, 'utf8'))
    })
  }
})
