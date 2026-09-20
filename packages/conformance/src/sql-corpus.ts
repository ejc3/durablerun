import { readFileSync } from 'node:fs'
import type { SqlBatchControl, SqlExecutor, SqlStatement } from '@durablerun/core'

/**
 * The generated SQL corpus's enrolment. `corpus/labels.json` is the descriptor: each label
 * a store builds as trees, with the variants it may compile to, the distinct statement
 * lists its branches produce. It is data, so a runner in another language reads the same
 * file. Enrolment is decided by what ran, never by a list kept beside the stores: a batch
 * whose statements a `FencedBatch` compiled is tree-built, and a tree-built label the
 * descriptor does not name fails.
 */
/** Each label every dialect builds as trees, with its variants. */
export type CorpusDescriptor = Readonly<Record<string, readonly string[]>>
export type CorpusSignature = readonly { sql: string; bindArity: number }[]
export type Corpus = Record<string, Record<string, CorpusSignature>>

/** Names a signature by what it holds, for a label with more than one variant. */
export type VariantNamers = Readonly<Record<string, (signature: CorpusSignature) => string>>

/**
 * A label with more than one variant names each signature by what it holds, never by
 * the order a scenario happened to reach it in.
 */
export const CORPUS_VARIANT_NAMERS: VariantNamers = {
  spawn: (signature) =>
    signature.some(({ sql }) => /^insert into ["`]tasks["`].*["`]claimed_by["`]/s.test(sql))
      ? 'spawned-child'
      : 'spawned',
  // Every failure carries the rollback pass, and only a retrying one a successor run too.
  fail: (signature) =>
    signature.filter(({ sql }) => /insert into ["`]runs["`]/.test(sql)).length > 1
      ? 'retrying'
      : 'final',
  // Only a failed rollback with budget left inserts a run, the pass that retries it.
  'fail-rollback': (signature) =>
    signature.some(({ sql }) => /insert into ["`]runs["`]/.test(sql)) ? 'retrying' : 'final',
  'await-event': (signature) =>
    signature.some(({ sql }) => /["`]tasks["`] as ["`]c["`]/.test(sql))
      ? 'registered-child'
      : 'registered',
}

/** The descriptor, `corpus/labels.json`. */
export const readCorpusDescriptor = (): CorpusDescriptor =>
  JSON.parse(readFileSync(new URL('../corpus/labels.json', import.meta.url), 'utf8'))

/** The committed corpus of one dialect, `corpus/<dialect>.json`. */
export const readCorpus = (dialect: string): Corpus =>
  JSON.parse(readFileSync(new URL(`../corpus/${dialect}.json`, import.meta.url), 'utf8'))

/**
 * Record the distinct signatures of every tree-built batch that passes through. `isTreeBuilt`
 * is asked of the statements themselves, so a label is recorded because of how it was built
 * and whether or not anything enrols it.
 */
export function recordingTreeBatches(
  raw: SqlExecutor,
  recorded: Map<string, CorpusSignature[]>,
  isTreeBuilt: (statement: SqlStatement) => boolean,
): SqlExecutor {
  return {
    batch: (label: string, statements: readonly SqlStatement[], control?: SqlBatchControl) => {
      if (statements.some(isTreeBuilt)) {
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

/**
 * The corpus of one dialect, from what was recorded. It fails when a tree-built label ran
 * that the descriptor does not enrol, when an enrolled label never ran, when a label
 * compiled to more signatures than it declares variants, or to a variant it does not
 * declare, and when two signatures claim one variant. A new branch is declared, never
 * discovered.
 */
export function enrolCorpus(
  dialect: string,
  descriptor: CorpusDescriptor,
  recorded: ReadonlyMap<string, readonly CorpusSignature[]>,
  variantOf: VariantNamers = {},
): Corpus {
  const enrolled = descriptor
  const unenrolled = [...recorded.keys()].filter((label) => !Object.hasOwn(enrolled, label))
  if (unenrolled.length > 0) {
    throw new Error(
      `${dialect}: ${unenrolled.join(', ')} ran as tree-built batches and corpus/labels.json does not enrol them for ${dialect}`,
    )
  }
  return Object.fromEntries(
    Object.entries(enrolled).map(([label, variants]) => {
      const signatures = recorded.get(label) ?? []
      if (signatures.length === 0) throw new Error(`${dialect}: no ${label} batch ran`)
      if (signatures.length > variants.length) {
        throw new Error(
          `${dialect}: ${label} compiled to ${signatures.length} signatures but declares ${variants.length} variants`,
        )
      }
      const named = signatures.map((signature, i): [string, CorpusSignature] => {
        const variant = variantOf[label]?.(signature) ?? variants[i]
        if (variant === undefined || !variants.includes(variant)) {
          throw new Error(`${dialect}: ${label} compiled to an undeclared variant '${variant}'`)
        }
        return [variant, signature]
      })
      if (new Set(named.map(([variant]) => variant)).size !== named.length) {
        throw new Error(`${dialect}: two ${label} signatures claim one variant`)
      }
      // Declared order, so the corpus file does not depend on the scenario's order.
      named.sort(([a], [b]) => variants.indexOf(a) - variants.indexOf(b))
      return [label, Object.fromEntries(named)]
    }),
  )
}
