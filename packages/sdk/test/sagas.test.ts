import {
  childTaskViolations,
  engineInvariantViolations,
  sagaViolations,
} from '@durablerun/conformance'
import {
  FatalTaskError,
  MAX_COUNT,
  type SchedulerStore,
  StoreUnavailableError,
  decodeRollbackTry,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { ChildTask, TaskContext } from '../src/index.js'
import { SAGA_DIALECTS, type SagaFixture, checkpointNames, drive, runNext } from './saga-harness.js'
import { Q, registry } from './worker-harness.js'

const NO_DELAY = { kind: 'fixed', baseSeconds: 0 } as const

async function expectCleanRows(f: SagaFixture): Promise<void> {
  expect({
    engine: await engineInvariantViolations(f.raw),
    childTasks: await childTaskViolations(f.raw),
    saga: await sagaViolations(f.raw),
  }).toEqual({ engine: [], childTasks: [], saga: [] })
}

/** A step whose body and rollback each leave a line in `effects`. */
function effectfulStep(ctx: TaskContext, effects: string[], name: string, value: unknown = name) {
  return ctx.step(
    name,
    () => {
      effects.push(`do:${name}`)
      return value
    },
    {
      rollback: () => {
        effects.push(`undo:${name}`)
      },
    },
  )
}

/**
 * ctx.step's rollbacks (DESIGN.md §3.10, specs/Sagas.tla), on every dialect: BUILD.md's
 * PR3.4 cases that only the SDK can show, because the order of rollbacks, their budgets,
 * and what a handler is handed are the SDK's. What the store owes is held by the `sagas`
 * conformance surface.
 */
for (const { dialect, open } of SAGA_DIALECTS) {
  describe(`step rollbacks through the SDK [${dialect}]`, () => {
    it('runs every rollback once, in reverse order of step start, and ends failed with a complete outcome', async () => {
      const f = await open('saga-order')
      const effects: string[] = []
      const handed: unknown[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a', { n: 1 })
          await ctx.step(
            'b',
            () => {
              effects.push('do:b')
              return 'two'
            },
            {
              rollback: (input) => {
                effects.push('undo:b')
                handed.push({ output: input.output, error: input.error })
              },
            },
          )
          await ctx.step('unregistered', () => effects.push('do:unregistered'))
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        { outcomes, effects, state: result?.state, rollback: result?.rollback },
        'mutation-verdict:behavior:saga-sdk-order',
      ).toEqual({
        outcomes: ['rolling-back', 'rolled-back'],
        effects: ['do:a', 'do:b', 'do:unregistered', 'undo:b', 'undo:a'],
        state: 'failed',
        rollback: { outcome: 'complete' },
      })
      // The handler is handed the step's output as every pass reads it, and the failure
      // that decided the task's end, as the task result reports it.
      expect(handed).toEqual([
        { output: 'two', error: JSON.parse(result?.failureReasonJson ?? 'null') },
      ])
      await expectCleanRows(f)
      await f.close()
    })

    it('commits the start marker before the body runs', async () => {
      const f = await open('saga-marker-first')
      let insideTheBody: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step(
            'a',
            async () => {
              insideTheBody = await checkpointNames(f, task.taskId)
              return 1
            },
            { rollback: () => {} },
          )
          return 'done'
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      expect(await drive(f, reg, task.taskId)).toEqual(['completed'])
      expect(
        { insideTheBody, after: await checkpointNames(f, task.taskId) },
        'mutation-verdict:behavior:saga-sdk-marker-first',
      ).toEqual({
        insideTheBody: ['$started:a'],
        after: ['$started:a', 'a'],
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('hands a rollback no output when its step started and never persisted', async () => {
      const f = await open('saga-no-output')
      const outputs: unknown[] = []
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step(
            'a',
            () => {
              throw new FatalTaskError('the body failed')
            },
            {
              rollback: (input) => {
                outputs.push(input.output)
              },
            },
          )
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      expect(
        await drive(f, reg, task.taskId),
        'mutation-verdict:behavior:saga-sdk-unpersisted-step',
      ).toEqual(['rolling-back', 'rolled-back'])
      expect({
        outputs,
        rollback: (await f.store.getTaskResult(Q, task.taskId))?.rollback,
      }).toEqual({
        outputs: [undefined],
        rollback: { outcome: 'complete' },
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('never rolls back for an error the task catches and survives', async () => {
      const f = await open('saga-caught')
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          try {
            await ctx.step('b', () => {
              throw new Error('caught')
            })
          } catch {
            effects.push('survived')
          }
          return 'done'
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      expect(await drive(f, reg, task.taskId)).toEqual(['completed'])
      expect({
        effects,
        result: await f.store.getTaskResult(Q, task.taskId),
        checkpoints: await checkpointNames(f, task.taskId),
      }).toEqual({
        effects: ['do:a', 'survived'],
        result: { state: 'completed', completedPayloadJson: '"done"' },
        checkpoints: ['$started:a', 'a'],
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('counts each failed rollback attempt and retries it under its own budget, past the spent task budget', async () => {
      const f = await open('saga-retried')
      let failuresLeft = 2
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step('a', () => 1, {
            rollback: () => {
              if (failuresLeft > 0) {
                failuresLeft--
                throw new Error('not yet')
              }
              effects.push('undo:a')
            },
            rollbackConfig: { maxAttempts: 3, retryStrategy: NO_DELAY },
          })
          throw new Error('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 1 })
      const outcomes = await drive(f, reg, task.taskId)
      const [tries] = await f.raw.batch(
        'tries',
        [
          {
            sql: 'SELECT state FROM checkpoints WHERE task_id = ? AND checkpoint_name = ?',
            args: [task.taskId, '$rollback-tries:a'],
          },
        ],
        'read',
      )
      expect(
        {
          outcomes,
          effects,
          recorded: decodeRollbackTry(String(tries?.rows[0]?.state))?.tries,
          rollback: (await f.store.getTaskResult(Q, task.taskId))?.rollback,
        },
        'mutation-verdict:behavior:saga-sdk-attempts-counted',
      ).toEqual({
        outcomes: ['rolling-back', 'rolling-back', 'rolling-back', 'rolled-back'],
        effects: ['undo:a'],
        recorded: 2,
        rollback: { outcome: 'complete' },
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('halts the saga when a rollback spends its budget, and the result says what was left', async () => {
      const f = await open('saga-halted')
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          await ctx.step('b', () => 2, {
            rollback: () => {
              effects.push('try:b')
              // A fourth attempt would succeed, and a budget of two never reaches it. A worker
              // that lost count of its attempts would reach it, and this case would see `a`
              // undone and the saga complete.
              if (effects.filter((effect) => effect === 'try:b').length < 4) {
                throw new Error('b cannot be undone')
              }
            },
            rollbackConfig: { maxAttempts: 2, retryStrategy: NO_DELAY },
          })
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          outcomes,
          effects,
          state: result?.state,
          outcome: result?.rollback?.outcome,
          error: (JSON.parse(result?.rollback?.errorJson ?? 'null') as { message?: string } | null)
            ?.message,
        },
        'mutation-verdict:behavior:saga-sdk-budget-is-counted',
      ).toEqual({
        outcomes: ['rolling-back', 'rolling-back', 'rollback-failed'],
        // The step that started first is left uncompensated: a halt runs nothing after it.
        effects: ['do:a', 'try:b', 'try:b'],
        state: 'failed',
        outcome: 'failed',
        error: 'b cannot be undone',
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('fails a rollback for good at once on a fatal error, whatever budget is left', async () => {
      const f = await open('saga-fatal-rollback')
      let attempts = 0
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step('a', () => 1, {
            rollback: () => {
              attempts++
              throw new FatalTaskError('never')
            },
            rollbackConfig: { maxAttempts: 5, retryStrategy: NO_DELAY },
          })
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      expect(
        await drive(f, reg, task.taskId),
        'mutation-verdict:behavior:saga-sdk-fatal-rollback',
      ).toEqual(['rolling-back', 'rollback-failed'])
      expect({
        attempts,
        outcome: (await f.store.getTaskResult(Q, task.taskId))?.rollback?.outcome,
      }).toEqual({
        attempts: 1,
        outcome: 'failed',
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('refuses a registration that cannot be kept, for good, before the body runs', async () => {
      const bad: Record<string, unknown> = {
        'a rollback that is no function': { rollback: 'undo' },
        'a budget of no attempts': { rollback: () => {}, rollbackConfig: { maxAttempts: 0 } },
        'a strategy that is none': {
          rollback: () => {},
          rollbackConfig: { retryStrategy: { kind: 'sometimes' } },
        },
        'a budget with no rollback': { rollbackConfig: { maxAttempts: 2 } },
        // The retry decision refuses a budget above the count ceiling, so registration does.
        'a budget above the count ceiling': {
          rollback: () => {},
          rollbackConfig: { maxAttempts: MAX_COUNT + 1 },
        },
      }
      const observed: Record<string, unknown> = {}
      for (const [what, opts] of Object.entries(bad)) {
        const f = await open(`saga-bad-${Object.keys(observed).length}`)
        let bodyRan = false
        const reg = registry({
          saga: async (ctx) => {
            await ctx.step(
              'a',
              () => {
                bodyRan = true
              },
              opts as never,
            )
          },
        })
        // Three attempts are open to it, and a permanent failure takes none of them.
        const task = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 3 })
        const outcomes = await drive(f, reg, task.taskId)
        const result = await f.store.getTaskResult(Q, task.taskId)
        observed[what] = {
          outcomes,
          bodyRan,
          failure: (JSON.parse(result?.failureReasonJson ?? 'null') as { name?: string } | null)
            ?.name,
        }
        await f.close()
      }
      const permanent = { outcomes: ['failed'], bodyRan: false, failure: 'FatalTaskError' }
      expect(observed, 'mutation-verdict:behavior:saga-sdk-bad-registration').toEqual(
        Object.fromEntries(Object.keys(bad).map((what) => [what, permanent])),
      )
    })

    it('halts for good on a saga checkpoint it cannot read, and spends no rollback budget on it', async () => {
      const f = await open('saga-corrupt')
      let rollbacks = 0
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step('a', () => 1, {
            rollback: () => {
              rollbacks++
            },
            rollbackConfig: { maxAttempts: 5, retryStrategy: NO_DELAY },
          })
          throw new Error('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 2, retryStrategy: NO_DELAY })
      expect(await runNext(f, reg, 'w-first')).toBe('retry-scheduled')
      await f.raw.batch('corrupt-the-start-marker', [
        {
          sql: `UPDATE checkpoints SET state = '"not an index"' WHERE task_id = ? AND checkpoint_name = ?`,
          args: [task.taskId, '$started:a'],
        },
      ])
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          outcomes,
          rollbacks,
          failure: (JSON.parse(result?.failureReasonJson ?? 'null') as { name?: string } | null)
            ?.name,
          outcome: result?.rollback?.outcome,
          error: (JSON.parse(result?.rollback?.errorJson ?? 'null') as { name?: string } | null)
            ?.name,
        },
        'mutation-verdict:behavior:saga-sdk-corrupt-state',
      ).toEqual({
        // The registration is refused for good, which decides the failure. The step did
        // start, so the phase is entered, and the pass halts on the same checkpoint.
        outcomes: ['rolling-back', 'rollback-failed'],
        rollbacks: 0,
        failure: 'FatalTaskError',
        outcome: 'failed',
        error: '$SagaStateCorrupt',
      })
      await f.close()
    })

    it('halts the saga when the task is cancelled mid-rollback', async () => {
      const f = await open('saga-cancelled')
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          await ctx.step('b', () => 2, {
            rollback: async () => {
              effects.push('undo:b')
              await f.store.cancelTask(Q, task.taskId)
            },
          })
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect({ outcomes, effects, state: result?.state, rollback: result?.rollback }).toEqual({
        outcomes: ['rolling-back', 'cancelled'],
        effects: ['do:a', 'undo:b'],
        state: 'cancelled',
        // A rollback is recorded as done only when its checkpoint commits, and a cancelled
        // task commits nothing, so both steps read as left uncompensated.
        rollback: { outcome: 'failed' },
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('resumes a pass that crashed mid-rollback exactly where it died', async () => {
      const f = await open('saga-crash')
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          await effectfulStep(ctx, effects, 'b')
          await effectfulStep(ctx, effects, 'c')
          throw new FatalTaskError('boom')
        },
      })
      // The store goes away once, as the checkpoint that records b's rollback is written.
      let outages = 1
      const flaky = new Proxy(f.store, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop !== 'setCheckpoint')
            return typeof value === 'function' ? value.bind(target) : value
          return (...args: Parameters<SchedulerStore['setCheckpoint']>) => {
            if (args[4] === '$rollback:b' && outages > 0) {
              outages--
              return Promise.reject(new StoreUnavailableError('injected outage'))
            }
            return target.setCheckpoint(...args)
          }
        },
      }) as SchedulerStore
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId, flaky)
      expect({
        outcomes,
        effects,
        rollback: (await f.store.getTaskResult(Q, task.taskId))?.rollback,
      }).toEqual({
        outcomes: ['rolling-back', 'aborted', 'rolled-back'],
        // c's rollback is memoized and does not run again. b's ran and was not recorded,
        // so it runs again: a rollback runs at least once for each time it commits.
        effects: ['do:a', 'do:b', 'do:c', 'undo:c', 'undo:b', 'undo:b', 'undo:a'],
        rollback: { outcome: 'complete' },
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('replays past memoized sleeps without parking the pass, and freezes the forward phase', async () => {
      const f = await open('saga-frozen')
      const effects: string[] = []
      let passes = 0
      const reg = registry({
        saga: async (ctx) => {
          passes++
          await effectfulStep(ctx, effects, 'a')
          await ctx.sleepFor(5)
          await effectfulStep(ctx, effects, 'b')
          // A task function that is not deterministic reaches a new durable call in the phase.
          if (passes > 2) await ctx.sleepFor(1_000)
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      expect({
        outcomes,
        effects,
        rollback: (await f.store.getTaskResult(Q, task.taskId))?.rollback,
        sleeps: (await checkpointNames(f, task.taskId)).filter((name) => name.startsWith('$sleep')),
      }).toEqual({
        outcomes: ['suspended', 'rolling-back', 'rolled-back'],
        effects: ['do:a', 'do:b', 'undo:b', 'undo:a'],
        rollback: { outcome: 'complete' },
        // The second sleep was never written: the frozen phase ended the replay there.
        sleeps: ['$sleep'],
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('halts when the replay does not register a rollback that is owed', async () => {
      const f = await open('saga-unregistered')
      const effects: string[] = []
      let registers = true
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          // A task function that is not deterministic: a later pass registers nothing for b.
          await ctx.step(
            'b',
            () => 2,
            registers ? { rollback: () => void effects.push('undo:b') } : undefined,
          )
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      expect(await runNext(f, reg, 'w-forward')).toBe('rolling-back')
      registers = false
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          outcomes,
          effects,
          outcome: result?.rollback?.outcome,
          error: (JSON.parse(result?.rollback?.errorJson ?? 'null') as { name?: string } | null)
            ?.name,
        },
        'mutation-verdict:behavior:saga-sdk-unregistered',
      ).toEqual({
        outcomes: ['rollback-failed'],
        // b started last and cannot be compensated, and a is not compensated ahead of it.
        effects: ['do:a'],
        outcome: 'failed',
        error: '$RollbackNotRegistered',
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('does not roll back a step that committed before it registered a rollback', async () => {
      const f = await open('saga-older-step')
      const effects: string[] = []
      let registersA = false
      const reg = registry({
        saga: async (ctx) => {
          // The first attempt runs as an older build does: step a registers nothing.
          await ctx.step(
            'a',
            () => 1,
            registersA ? { rollback: () => void effects.push('undo:a') } : undefined,
          )
          await effectfulStep(ctx, effects, 'b')
          throw new Error('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 2, retryStrategy: NO_DELAY })
      expect(await runNext(f, reg, 'w-older')).toBe('retry-scheduled')
      registersA = true
      const outcomes = await drive(f, reg, task.taskId)
      expect({
        outcomes,
        effects,
        rollback: (await f.store.getTaskResult(Q, task.taskId))?.rollback,
      }).toEqual({
        outcomes: ['rolling-back', 'rolled-back'],
        // a has no start marker, so no saga knows it started. A rolling deploy's limit.
        effects: ['do:b', 'undo:b'],
        rollback: { outcome: 'complete' },
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('refuses a second registered step while the first writes its start marker, as it refuses any nested step', async () => {
      const f = await open('saga-concurrent-start')
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await Promise.all([effectfulStep(ctx, effects, 'a'), effectfulStep(ctx, effects, 'b')])
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      await drive(f, reg, task.taskId)
      const [rows] = await f.raw.batch(
        'saga-start-markers',
        [
          {
            sql: 'SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ? ORDER BY checkpoint_name',
            args: [task.taskId],
          },
        ],
        'read',
      )
      const markers = (rows?.rows ?? [])
        .map((row) => ({ name: String(row.checkpoint_name), index: String(row.state) }))
        .filter((row) => row.name.startsWith('$started:'))
      // The refusal ends the pass while the first step's marker write is in flight, so that
      // marker may or may not land. What cannot happen is a second start beside it.
      expect(
        {
          secondStepRan: effects.includes('do:b'),
          secondStepStarted: markers.some((row) => row.name === '$started:b'),
          indexesShared: new Set(markers.map((row) => row.index)).size !== markers.length,
          state: (await f.store.getTaskResult(Q, task.taskId))?.state,
        },
        'mutation-verdict:behavior:saga-sdk-concurrent-start',
      ).toEqual({
        secondStepRan: false,
        secondStepStarted: false,
        indexesShared: false,
        state: 'failed',
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('says where the replay ended when a handler rethrows past a step that never persisted', async () => {
      const f = await open('saga-selective-catch')
      class PaymentDeclined extends Error {}
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          try {
            await ctx.step(
              'b',
              () => {
                effects.push('do:b')
                throw new PaymentDeclined('declined')
              },
              { rollback: () => void effects.push('undo:b') },
            )
          } catch (error) {
            // A catch that lets only its own error class through. On a rollback pass the
            // step's body does not run again, so what `b` throws there is the engine's.
            if (!(error instanceof PaymentDeclined)) throw error
          }
          await effectfulStep(ctx, effects, 'c')
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      const error = JSON.parse(result?.rollback?.errorJson ?? 'null') as {
        name?: string
        message?: string
      } | null
      expect(
        {
          outcomes,
          effects,
          outcome: result?.rollback?.outcome,
          error: error?.name,
          namesTheStepLeftUnregistered: error?.message?.includes("'c'"),
          namesWhereTheReplayEnded: error?.message?.includes("'b'"),
        },
        'mutation-verdict:behavior:saga-sdk-replay-cut',
      ).toEqual({
        outcomes: ['rolling-back', 'rollback-failed'],
        // c started last and its rollback was never registered, so nothing runs ahead of it.
        effects: ['do:a', 'do:b', 'do:c'],
        outcome: 'failed',
        error: '$RollbackNotRegistered',
        namesTheStepLeftUnregistered: true,
        namesWhereTheReplayEnded: true,
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('says where the replay ended when the step that cut it registered no rollback', async () => {
      const f = await open('saga-selective-catch-unregistered')
      class PaymentDeclined extends Error {}
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await effectfulStep(ctx, effects, 'a')
          try {
            // No rollback is registered for b, so nothing durable says it ever started.
            await ctx.step('b', () => {
              effects.push('do:b')
              throw new PaymentDeclined('declined')
            })
          } catch (error) {
            if (!(error instanceof PaymentDeclined)) throw error
          }
          await effectfulStep(ctx, effects, 'c')
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      const error = JSON.parse(result?.rollback?.errorJson ?? 'null') as {
        name?: string
        message?: string
      } | null
      expect({
        outcomes,
        effects,
        error: error?.name,
        namesTheStepLeftUnregistered: error?.message?.includes("'c'"),
        namesWhereTheReplayEnded: error?.message?.includes("'b'"),
      }).toEqual({
        outcomes: ['rolling-back', 'rollback-failed'],
        effects: ['do:a', 'do:b', 'do:c'],
        error: '$RollbackNotRegistered',
        namesTheStepLeftUnregistered: true,
        namesWhereTheReplayEnded: true,
      })
      await expectCleanRows(f)
      await f.close()
    })

    // Every durable call with no memo ends a pass's replay with the engine's phase signal
    // (DESIGN.md §3.10). Each call freezes with a line of its own, so each is held here. A
    // task function that is not deterministic reaches the call for the first time on a
    // rollback pass: the call throws the signal, nothing is written for it, and the pass
    // goes on to roll back what it owes. An emit is the one call that is skipped and not
    // refused, and the case below holds it.
    it('throws the phase signal from every durable call that has no memo, and writes nothing for it', async () => {
      const KIDS = 'kids'
      const calls: Record<string, (ctx: TaskContext, child: ChildTask) => Promise<unknown>> = {
        step: (ctx) => ctx.step('late', () => 'ran inside the phase'),
        sleepFor: (ctx) => ctx.sleepFor(5),
        sleepUntil: (ctx) => ctx.sleepUntil(4_102_444_800_000),
        awaitEvent: (ctx) => ctx.awaitEvent('never'),
        awaitTask: (ctx, child) => ctx.awaitTask(child),
        spawn: (ctx) => ctx.spawn('child', {}, { queue: KIDS }),
      }
      const answers: Record<string, unknown> = {}
      for (const [call, make] of Object.entries(calls)) {
        const f = await open(`saga-frozen-${call}`)
        let forward = true
        let thrown: string | undefined
        const reg = registry({
          saga: async (ctx) => {
            await ctx.step('a', () => 'a', { rollback: () => {} })
            // Memoized by the forward pass, so the replay passes it and hands the child on.
            const child = await ctx.spawn('child', {}, { queue: KIDS })
            if (forward) {
              forward = false
              throw new FatalTaskError('boom')
            }
            try {
              await make(ctx, child)
            } catch (error) {
              thrown = (error as Error).name
              throw error
            }
          },
        })
        const task = await f.store.spawn(Q, 'saga', '{}')
        const entered = await runNext(f, reg, 'w-forward')
        const before = await checkpointNames(f, task.taskId)
        const pass = await runNext(f, reg, 'w-pass')
        const [children, waits] = await f.raw.batch(
          'saga-frozen-rows',
          [
            { sql: 'SELECT COUNT(*) AS n FROM tasks WHERE queue = ?', args: [KIDS] },
            { sql: 'SELECT COUNT(*) AS n FROM waits', args: [] },
          ],
          'read',
        )
        answers[call] = {
          entered,
          pass,
          thrown,
          wrote: (await checkpointNames(f, task.taskId)).filter((name) => !before.includes(name)),
          children: Number(children?.rows[0]?.n),
          waits: Number(waits?.rows[0]?.n),
        }
        await expectCleanRows(f)
        await f.close()
      }
      const frozen = {
        entered: 'rolling-back',
        pass: 'rolled-back',
        thrown: 'RollbackPhaseSignal',
        wrote: ['$rollback:a'],
        children: 1,
        waits: 0,
      }
      expect(answers, 'mutation-verdict:behavior:saga-sdk-every-call-is-frozen').toEqual(
        Object.fromEntries(Object.keys(calls).map((call) => [call, frozen])),
      )
    })

    it('emits nothing from a rollback pass that the forward pass never reached', async () => {
      const f = await open('saga-frozen-emit')
      const effects: string[] = []
      let forward = true
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step(
            'a',
            () => {
              effects.push('do:a')
              return 'a'
            },
            {
              // A rollback is a step of its own, and a step may emit.
              rollback: async ({ ctx: inRollback }) => {
                effects.push('undo:a')
                await inRollback.emitEvent('undone', JSON.stringify({ step: 'a' }))
              },
            },
          )
          if (forward) {
            forward = false
            throw new FatalTaskError('died before the emit')
          }
          await ctx.emitEvent('late', JSON.stringify({ announced: 'a' }))
          effects.push('replayed-past-the-emit')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const [rows] = await f.raw.batch(
        'saga-events',
        [{ sql: 'SELECT event_name FROM events ORDER BY event_name', args: [] }],
        'read',
      )
      const emitted = (rows?.rows ?? [])
        .map((row) => String(row.event_name))
        .filter((name) => name === 'late' || name === 'undone')
      expect(
        { outcomes, effects, emitted },
        'mutation-verdict:behavior:saga-sdk-frozen-emit',
      ).toEqual({
        outcomes: ['rolling-back', 'rolled-back'],
        effects: ['do:a', 'replayed-past-the-emit', 'undo:a'],
        emitted: ['undone'],
      })
      await expectCleanRows(f)
      await f.close()
    })

    it('replays a rollback pass with the attempt of the run that failed, on every pass', async () => {
      const f = await open('saga-attempt')
      const effects: string[] = []
      const attempts: number[] = []
      let undoFails = true
      const reg = registry({
        saga: async (ctx) => {
          attempts.push(ctx.attempt)
          const name = `charge-${ctx.attempt}`
          await ctx.step(
            name,
            () => {
              effects.push(`do:${name}`)
              return name
            },
            {
              rollback: () => {
                effects.push(`undo:${name}`)
                if (undoFails) {
                  undoFails = false
                  throw new Error('the refund did not go through')
                }
              },
              rollbackConfig: { maxAttempts: 2, retryStrategy: NO_DELAY },
            },
          )
          throw new Error('again')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}', { maxAttempts: 2, retryStrategy: NO_DELAY })
      await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      const error = JSON.parse(result?.rollback?.errorJson ?? 'null') as {
        name?: string
        message?: string
      } | null
      expect(
        {
          attempts,
          effects,
          outcome: result?.rollback?.outcome,
          error: error?.name,
          left: error?.message?.includes('charge-1'),
        },
        'mutation-verdict:behavior:saga-sdk-pass-attempt',
      ).toEqual({
        // Two forward attempts, then two rollback passes, which both replay as attempt 2.
        attempts: [1, 2, 2, 2],
        effects: ['do:charge-1', 'do:charge-2', 'undo:charge-2', 'undo:charge-2'],
        // The handler names its step after the attempt, so no pass can register the first
        // attempt's rollback. The saga says so, after compensating what it could in order.
        outcome: 'failed',
        error: '$RollbackNotRegistered',
        left: true,
      })
      await expectCleanRows(f)
      await f.close()
    })
  })
}
