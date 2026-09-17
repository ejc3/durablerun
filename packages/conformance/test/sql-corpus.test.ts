import { readFileSync, writeFileSync } from 'node:fs'
import type { SqlBatchControl, SqlExecutor, SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  awaitOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  withFixture,
} from '../src/scenario.js'
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
  spawn: ['spawned'],
  claim: ['claimed'],
  activate: ['activated'],
  complete: ['completed'],
  'defer-launch': ['deferred'],
  reschedule: ['rescheduled'],
  suspend: ['suspended'],
  'await-event': ['registered'],
  'emit-event': ['emitted'],
  'set-checkpoint': ['written'],
  // A retrying failure carries the retry deadline's headroom guard, and a final one does not.
  fail: ['retrying', 'final'],
  'retry-task': ['revived'],
  'cancel-task': ['cancelled'],
  'sweep:cancel': ['cancelled'],
  // One batch carries both compare-and-sets, the reopen and the cap.
  'sweep:lost-launch': ['swept'],
  'sweep:claim-timeout': ['swept'],
}

type Signature = readonly { sql: string; bindArity: number }[]

/**
 * A label with more than one variant names each signature by what it holds, never by
 * the order the scenario happened to reach it in.
 */
const VARIANT_OF: Readonly<Record<string, (signature: Signature) => string>> = {
  // Only a retrying failure inserts a successor run.
  fail: (signature) =>
    signature.some(({ sql }) => /insert into runs/i.test(sql)) ? 'retrying' : 'final',
}

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
      const recorded = new Map<string, Signature[]>()
      await withFixture(makeFixture, `sql-corpus-${dialect}`, async (fixture) => {
        const store = fixture.storeOver(recordingExecutor(fixture.raw, recorded))
        await store.spawn('q', 'job', '{}')
        const run = await claimActivated(store, 'q', 'w1')
        await store.complete('q', run.runId, run.claimToken, '"done"')
        await store.spawn('q', 'job', '{}')
        const unlaunched = await claimOne(store, 'q', 'w2')
        await store.deferLaunch(
          'q',
          unlaunched.runId,
          unlaunched.claimToken,
          unlaunched.claimGen,
          5,
        )
        await store.spawn('q', 'job', '{}')
        const rescheduled = await claimActivated(store, 'q', 'w3')
        await store.reschedule('q', rescheduled.runId, rescheduled.claimToken, { inSeconds: 5 })
        await store.spawn('q', 'job', '{}')
        const suspended = await claimActivated(store, 'q', 'w4')
        await store.suspendRun(
          'q',
          suspended.runId,
          suspended.claimToken,
          { inSeconds: 5 },
          { key: 'marker', stateJson: '{}' },
        )
        await store.spawn('q', 'job', '{}')
        const waiting = await claimActivated(store, 'q', 'w5')
        await awaitOwned(store, 'q', waiting, 'step', 'ready', 5)
        await store.emitEvent('q', 'ready', '{}')
        // The emit made the waiter due. Finish it, or the next claim takes it instead
        // of the task the scenario means to fail.
        const woken = await claimActivated(store, 'q', 'w5b')
        expect(woken.taskId).toBe(waiting.taskId)
        await store.complete('q', woken.runId, woken.claimToken, '"woken"')
        const flaky = await store.spawn('q', 'job', '{}', { maxAttempts: 2 })
        const failing = await claimActivated(store, 'q', 'w6')
        // The scenario means to fail this task twice. A claim that picked up another
        // run would record the right labels for the wrong reasons.
        expect(failing.taskId).toBe(flaky.taskId)
        await checkpointOwned(store, 'q', failing, 'step', '{}', 30)
        await store.fail('q', failing.runId, failing.claimToken, '{"name":"E"}', {
          delaySeconds: 0,
        })
        const retried = await claimActivated(store, 'q', 'w7')
        expect(retried.taskId).toBe(flaky.taskId)
        expect(retried.attempt).toBe(failing.attempt + 1)
        await store.fail('q', retried.runId, retried.claimToken, '{"name":"E"}', null)
        // A compare-and-set that matches nothing still compiles, so each step says it won.
        expect(await store.retryTask('q', retried.taskId)).not.toBeNull()
        expect(await store.cancelTask('q', retried.taskId)).toBe(true)
        // Last, because it moves the clock. Under the early fake clock only these three
        // tasks are due: a launch that never activates, a worker that dies after
        // activating, and a task never started by its deadline.
        await fixture.admin.setFakeNowEpochMs(1_000_000)
        const unlaunchedTask = await store.spawn('q', 'job', '{}')
        expect((await claimOne(store, 'q', 'w8')).taskId).toBe(unlaunchedTask.taskId)
        const abandoned = await store.spawn('q', 'job', '{}')
        expect((await claimActivated(store, 'q', 'w9')).taskId).toBe(abandoned.taskId)
        const late = await store.spawn('q', 'job', '{}', { cancellation: { maxDelaySeconds: 30 } })
        await fixture.admin.setFakeNowEpochMs(1_061_000)
        const swept = await store.sweep('q', 10)
        expect(swept).toContainEqual(
          expect.objectContaining({ kind: 'lost-launch', taskId: unlaunchedTask.taskId }),
        )
        expect(swept).toContainEqual(
          expect.objectContaining({ kind: 'claim-timeout', taskId: abandoned.taskId }),
        )
        expect(swept).toContainEqual(
          expect.objectContaining({ kind: 'cancelled', taskId: late.taskId }),
        )
      })
      const corpus = Object.fromEntries(
        Object.entries(TREE_LABELS).map(([label, variants]) => {
          const signatures = recorded.get(label) ?? []
          if (signatures.length === 0) throw new Error(`${dialect}: no ${label} batch ran`)
          if (signatures.length > variants.length) {
            throw new Error(
              `${dialect}: ${label} compiled to ${signatures.length} signatures but declares ${variants.length} variants`,
            )
          }
          const named = signatures.map((signature, i): [string, Signature] => {
            const variant = VARIANT_OF[label]?.(signature) ?? variants[i]
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
      const path = new URL(`../corpus/${dialect}.json`, import.meta.url)
      const text = `${JSON.stringify(corpus, null, 2)}\n`
      if (process.env.DURABLERUN_UPDATE_CORPUS === '1') writeFileSync(path, text)
      expect(text).toBe(readFileSync(path, 'utf8'))
    })
  }
})
