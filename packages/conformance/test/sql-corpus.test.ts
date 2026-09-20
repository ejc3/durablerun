import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { SAGA_STARTED_PREFIX, isTreeBuiltStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import {
  awaitOwned,
  awaitTaskOwned,
  checkpointOwned,
  claimActivated,
  claimOne,
  withFixture,
} from '../src/scenario.js'
import {
  type CorpusDescriptor,
  type CorpusSignature,
  type VariantNamers,
  enrolCorpus,
  recordingTreeBatches,
} from '../src/sql-corpus.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

/**
 * The generated SQL corpus: every statement a tree-built label compiles to, per
 * dialect, as ordered SQL plus bind arity. The corpus is derived, never hand-kept.
 * Regenerate with `DURABLERUN_UPDATE_CORPUS=1`.
 *
 * `corpus/labels.json` enrols each label with its variants, the distinct statement lists
 * it may compile to. What is recorded is every batch a `FencedBatch` compiled, so a
 * tree-built label the descriptor does not name fails, and so does a label that compiles
 * to a signature outside the corpus or to more signatures than it declares: a new label or
 * branch must be declared, not discovered.
 */
const DESCRIPTOR: CorpusDescriptor = JSON.parse(
  readFileSync(new URL('../corpus/labels.json', import.meta.url), 'utf8'),
)

/**
 * A label with more than one variant names each signature by what it holds, never by
 * the order the scenario happened to reach it in.
 */
const VARIANT_OF: VariantNamers = {
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

describe('generated SQL corpus', () => {
  for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
    it(`${dialect}: every tree-built label compiles to its declared corpus`, async () => {
      const recorded = new Map<string, CorpusSignature[]>()
      await withFixture(makeFixture, `sql-corpus-${dialect}`, async (fixture) => {
        const store = fixture.storeOver(
          recordingTreeBatches(fixture.raw, recorded, isTreeBuiltStatement),
        )
        await store.spawn('q', 'job', '{}')
        const run = await claimActivated(store, 'q', 'w1')
        expect((await store.heartbeat('q', run.runId, run.claimToken, 30)).held).toBe(true)
        // The reads, beside a live run. A read changes nothing, so where it stands is free.
        // An activated claim has no name left to learn, and the statement is sent all the same.
        expect(await store.claimedTaskName('q', run.runId, run.claimToken, run.claimGen)).toBeNull()
        expect(await store.getCheckpoints('q', run.taskId, 1)).toEqual([])
        expect(await store.getTaskResult('q', run.taskId)).not.toBeNull()
        expect(await store.nextWakeAtEpochMs('q')).not.toBeNull()
        // A run this store never heard of: the terminal batch reads its task, finds none,
        // and reads its state to say why it refuses.
        await expect(store.complete('q', 'no-such-run', 'no-token', '"x"')).rejects.toThrow()
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
        // A parent awaits a live child, the child ends and wakes it, and both finish, so
        // that no later claim of this scenario takes either.
        await store.spawn('q', 'parent', '{}')
        const parent = await claimActivated(store, 'q', 'w5c')
        const child = await store.spawn('q', 'child', '{}', {
          childOf: {
            parentQueue: 'q',
            parentTaskId: parent.taskId,
            runId: parent.runId,
            claimToken: parent.claimToken,
            replayKey: 'site',
          },
        })
        const awaitChild = (run: typeof parent, childTaskId: string) =>
          awaitTaskOwned(store, 'q', run, 'step', childTaskId, null)
        expect(await awaitChild(parent, child.taskId)).toEqual({ emitted: false })
        const childRun = await claimActivated(store, 'q', 'w5d')
        expect(childRun.taskId).toBe(child.taskId)
        await store.complete('q', childRun.runId, childRun.claimToken, '"child"')
        const wokenParent = await claimActivated(store, 'q', 'w5e')
        expect(wokenParent.taskId).toBe(parent.taskId)
        // An older build ended this child and wrote no event, so the await records it.
        await fixture.raw.batch('an-older-build-wrote-no-event', [
          {
            sql: 'DELETE FROM events WHERE queue = ? AND event_name LIKE ?',
            args: ['q', '$task-done:%'],
          },
        ])
        expect((await awaitChild(wokenParent, child.taskId)).emitted).toBe(true)
        await store.complete('q', wokenParent.runId, wokenParent.claimToken, '"parent"')
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
        // A saga: a registered step starts, the task fails for good, and that batch
        // enters the rolling-back phase. The rollback fails twice, once with budget left.
        const saga = await store.spawn('q', 'saga', '{}')
        const forward = await claimActivated(store, 'q', 'w7b')
        expect(forward.taskId).toBe(saga.taskId)
        await checkpointOwned(store, 'q', forward, `${SAGA_STARTED_PREFIX}a`, '1', 30)
        await store.fail('q', forward.runId, forward.claimToken, '{"name":"E"}', null)
        const tried = { stepKey: 'a', errorJson: '{"name":"R"}' }
        const pass = await claimActivated(store, 'q', 'w7c')
        expect(pass.taskId).toBe(saga.taskId)
        await store.failRollback(
          'q',
          pass.runId,
          pass.claimToken,
          '{"name":"E"}',
          { delaySeconds: 0 },
          tried,
        )
        const lastPass = await claimActivated(store, 'q', 'w7d')
        expect(lastPass.taskId).toBe(saga.taskId)
        await store.failRollback(
          'q',
          lastPass.runId,
          lastPass.claimToken,
          '{"name":"E"}',
          null,
          tried,
        )
        expect((await store.getTaskResult('q', saga.taskId))?.rollback?.outcome).toBe('failed')
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
      const corpus = enrolCorpus(dialect, DESCRIPTOR, recorded, VARIANT_OF)
      const path = new URL(`../corpus/${dialect}.json`, import.meta.url)
      const text = `${JSON.stringify(corpus, null, 2)}\n`
      if (process.env.DURABLERUN_UPDATE_CORPUS === '1') writeFileSync(path, text)
      expect(text).toBe(readFileSync(path, 'utf8'))
    })
  }
})

describe('corpus enrolment', () => {
  const one: CorpusSignature = [{ sql: 'update "runs" set "state" = ?', bindArity: 1 }]
  const other: CorpusSignature = [{ sql: 'insert into "runs" default values', bindArity: 0 }]
  const ran = (entries: [string, CorpusSignature[]][]) => new Map(entries)

  it('fails for a tree-built label the descriptor does not enrol', () => {
    expect(() =>
      enrolCorpus(
        'control',
        { spawn: ['spawned'] },
        ran([
          ['spawn', [one]],
          ['spawn-child', [one]],
        ]),
      ),
    ).toThrow(
      /spawn-child ran as tree-built batches and corpus\/labels\.json does not enrol them for control/,
    )
  })

  it('fails for an enrolled label that never ran', () => {
    expect(() => enrolCorpus('control', { spawn: ['spawned'] }, ran([]))).toThrow(
      /no spawn batch ran/,
    )
  })

  it('fails for a signature beyond the declared variants, and for a variant nobody declared', () => {
    expect(() =>
      enrolCorpus('control', { spawn: ['spawned'] }, ran([['spawn', [one, other]]])),
    ).toThrow(/compiled to 2 signatures but declares 1 variants/)
    expect(() =>
      enrolCorpus('control', { spawn: ['spawned'] }, ran([['spawn', [one]]]), {
        spawn: () => 'respawned',
      }),
    ).toThrow(/undeclared variant 'respawned'/)
    expect(() =>
      enrolCorpus('control', { fail: ['retrying', 'final'] }, ran([['fail', [one, other]]]), {
        fail: () => 'final',
      }),
    ).toThrow(/two fail signatures claim one variant/)
  })

  it('records a batch because a FencedBatch compiled it, whatever its label', async () => {
    const recorded = new Map<string, CorpusSignature[]>()
    const built = { sql: 'select 1', args: [] }
    const text = { sql: 'select 2', args: [] }
    const recorder = recordingTreeBatches(
      {
        batch: async (_label, statements) => statements.map(() => ({ rows: [], rowsAffected: 0 })),
      },
      recorded,
      (statement) => statement === built,
    )
    await recorder.batch('a-label-nobody-listed', [built])
    await recorder.batch('next-wake', [text])
    expect([...recorded.keys()]).toEqual(['a-label-nobody-listed'])
  })

  it('enrols every label a store builds as a FencedBatch, read from the store sources', () => {
    // The scenario records what it drives, and a batch it never drives would have no golden
    // copy and fail nothing. This reads the constructions themselves.
    const packages = new URL('../../', import.meta.url)
    const stores = readdirSync(packages).filter((name) => name.startsWith('store-'))
    expect(stores.length).toBeGreaterThanOrEqual(3)
    for (const store of stores) {
      const sources = new URL(`${store}/src/`, packages)
      // Every source file, in subdirectories too. This is a read of text: a store that
      // aliases the class (`const B = FencedBatch`), renames it on import, or extends it and
      // constructs the subclass escapes the pattern, and no store does any of the three.
      const text = readdirSync(sources, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(new URL(file, sources), 'utf8'))
        .join('\n')
      const constructions = text.match(/new FencedBatch\(/g) ?? []
      const labels = [...text.matchAll(/new FencedBatch\(\s*'([^']+)'/g)].map((found) => found[1])
      // A label that is not a literal could not be read here, so it is refused.
      expect(labels.length, `${store} constructs a FencedBatch whose label is not a literal`).toBe(
        constructions.length,
      )
      expect(labels.length).toBeGreaterThan(0)
      expect([...new Set(labels)].sort(), `${store}'s FencedBatch labels`).toEqual(
        Object.keys(DESCRIPTOR).sort(),
      )
    }
  })

  it('enrols every label the descriptor names in the corpus of every dialect', () => {
    for (const { dialect } of SELECTED_DIALECT_FIXTURES) {
      const corpus = JSON.parse(
        readFileSync(new URL(`../corpus/${dialect}.json`, import.meta.url), 'utf8'),
      )
      const enrolled = DESCRIPTOR
      expect(Object.keys(corpus)).toEqual(Object.keys(enrolled))
      for (const [label, variants] of Object.entries(enrolled)) {
        for (const variant of Object.keys(corpus[label])) expect(variants).toContain(variant)
      }
    }
  })
})
