import {
  childTaskViolations,
  engineInvariantViolations,
  sagaViolations,
} from '@durablerun/conformance'
import {
  FatalTaskError,
  type SchedulerStore,
  StoreUnavailableError,
  decodeRollbackTry,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { TaskContext } from '../src/index.js'
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
              throw new Error('b cannot be undone')
            },
            rollbackConfig: { maxAttempts: 2, retryStrategy: NO_DELAY },
          })
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect({
        outcomes,
        effects,
        state: result?.state,
        outcome: result?.rollback?.outcome,
        error: (JSON.parse(result?.rollback?.errorJson ?? 'null') as { message?: string } | null)
          ?.message,
      }).toEqual({
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
  })
}
