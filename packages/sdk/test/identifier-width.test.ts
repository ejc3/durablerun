import { FatalTaskError } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LONGEST_NAME_BUILT, roomOf } from './name-rooms.js'
import { SAGA_DIALECTS, drive, runNext } from './saga-harness.js'
import { Q, registry } from './worker-harness.js'

/**
 * A durable identifier holds 255 characters (DESIGN.md §3.4 rule 10), and the SDK stores a
 * task's names under keys that are longer than the names: `name#2` for a repeated step,
 * `$await:` and an event name, `$started:` and a registered step's key. A name that fits
 * can therefore have a key that does not. The store refuses that key the same way on every
 * pass, so the SDK has to refuse it first, for good, before the step's body runs. And the
 * rule is held on the way in: a key that is already stored still replays.
 */
const NO_DELAY = { kind: 'fixed', baseSeconds: 0 } as const
const THREE_TRIES = { maxAttempts: 3, retryStrategy: NO_DELAY }

const failureOf = (result: { failureReasonJson?: string } | null): string =>
  String(result?.failureReasonJson ?? '')

for (const { dialect, open } of SAGA_DIALECTS) {
  describe(`the width of a durable identifier, through the SDK [${dialect}]`, () => {
    it('fails a task for good on its first pass when a repeated step name leaves its second key past the width, and never runs the second body', async () => {
      const f = await open('width-repeated-step')
      const name = 'n'.repeat(254)
      const ran: string[] = []
      const reg = registry({
        job: async (ctx) => {
          await ctx.step(name, () => ran.push('first'))
          await ctx.step(name, () => ran.push('second'))
        },
      })
      const task = await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          outcomes,
          ran,
          state: result?.state,
          namesWhatTheTaskPassed: failureOf(result).includes('step name'),
        },
        'mutation-verdict:behavior:sdk-holds-the-durable-key-before-the-body-runs',
      ).toEqual({
        outcomes: ['failed'],
        ran: ['first'],
        state: 'failed',
        namesWhatTheTaskPassed: true,
      })
      await f.close()
    })

    it('fails a task for good on its first pass when an event name leaves its await key past the width', async () => {
      const f = await open('width-await-key')
      const reg = registry({
        job: async (ctx) => {
          await ctx.awaitEvent('e'.repeat(250), { timeoutSeconds: 5 })
        },
      })
      const task = await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect({
        outcomes,
        state: result?.state,
        namesWhatTheTaskPassed: failureOf(result).includes('event name'),
      }).toEqual({ outcomes: ['failed'], state: 'failed', namesWhatTheTaskPassed: true })
      await f.close()
    })

    it('fails a task for good before the body runs when a step that registers a rollback has a key past 239 characters', async () => {
      const f = await open('width-saga-step')
      const ran: string[] = []
      const reg = registry({
        job: async (ctx) => {
          await ctx.step('k'.repeat(245), () => ran.push('body'), { rollback: () => {} })
        },
      })
      const task = await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect({
        outcomes,
        ran,
        state: result?.state,
        namesWhatTheTaskPassed: failureOf(result).includes('step name'),
      }).toEqual({ outcomes: ['failed'], ran: [], state: 'failed', namesWhatTheTaskPassed: true })
      await f.close()
    })

    it('fails a task for good on its first pass when it emits an event name past the width', async () => {
      const f = await open('width-emitted-name')
      const reg = registry({
        job: async (ctx) => {
          await ctx.emitEvent('e'.repeat(256), '{}')
        },
      })
      const task = await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
      const outcomes = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          outcomes,
          state: result?.state,
          namesWhatTheTaskPassed: failureOf(result).includes('event name'),
        },
        'mutation-verdict:behavior:sdk-holds-an-emitted-event-name',
      ).toEqual({ outcomes: ['failed'], state: 'failed', namesWhatTheTaskPassed: true })
      await f.close()
    })

    it('holds each key at its last fitting length, and refuses it one character past', async () => {
      // Every length here is computed in name-rooms.ts, which the replay-equivalence
      // harness's name-length axis also computes from, so the two cannot drift apart. The
      // numbers DESIGN.md gives for the SDK's keys are stated once, in the expectation.
      // One past its room, a key fails the task on that first pass: nothing is retried.
      const ROOM = {
        awaitEvent: roomOf(LONGEST_NAME_BUILT.awaitEvent),
        awaitTask: roomOf(LONGEST_NAME_BUILT.awaitTask),
        registeredStep: roomOf(LONGEST_NAME_BUILT.registeredStep),
        stepUsedTwice: roomOf(LONGEST_NAME_BUILT.stepUsedTwice),
      }
      const firstPass = async (seed: string, job: Parameters<typeof registry>[0][string]) => {
        const f = await open(seed)
        await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
        const outcome = await runNext(f, registry({ job }), 'w-first')
        const parent = await f.raw.batch(
          'parent',
          [{ sql: "SELECT task_id FROM tasks WHERE task_name = 'job'", args: [] }],
          'read',
        )
        const parentTaskId = String(parent[0]?.rows[0]?.task_id)
        const result = await f.store.getTaskResult(Q, parentTaskId)
        await f.close()
        return { outcome, parentTaskId, failure: failureOf(result) }
      }
      const awaiting = (length: number) =>
        firstPass(`width-await-${length}`, async (ctx) => {
          await ctx.awaitEvent('e'.repeat(length), { timeoutSeconds: 5 })
        })
      const registered = (length: number) =>
        firstPass(`width-registered-${length}`, async (ctx) => {
          await ctx.step('k'.repeat(length), () => 1, { rollback: () => {} })
        })
      const twice = (length: number) =>
        firstPass(`width-twice-${length}`, async (ctx) => {
          await ctx.step('n'.repeat(length), () => 1)
          await ctx.step('n'.repeat(length), () => 2)
        })
      // A child's id is the engine's, so the key of its await is reached only through a
      // forged handle. At its room the key fits and the store is asked, which knows no such
      // task. One past it the SDK refuses first, in the task's own terms.
      const awaitingTask = async (length: number) => {
        const pass = await firstPass(`width-await-task-${length}`, async (ctx) => {
          await ctx.awaitTask({ taskId: 'x'.repeat(length), queue: Q } as never, {
            timeoutSeconds: 1,
          })
        })
        return {
          outcome: pass.outcome,
          refusedByTheSdk: pass.failure.includes('child task id is too long'),
        }
      }
      // The room a child task name has under this harness's parent id, by the same sum
      // DESIGN.md does for a 36 character id.
      const roomUnder = (parentTaskId: string) =>
        roomOf(LONGEST_NAME_BUILT.spawnUnder(parentTaskId))
      const probe = await firstPass('width-parent-id', async () => {})
      const room = roomUnder(probe.parentTaskId)
      const spawning = (length: number) =>
        firstPass(`width-spawn-${length}`, async (ctx) => {
          await ctx.spawn('c'.repeat(length), {})
        })
      expect({
        rooms: { ...ROOM, childTaskNameUnderA36CharacterParentId: roomUnder('x'.repeat(36)) },
        awaitAtItsRoom: (await awaiting(ROOM.awaitEvent)).outcome,
        awaitOnePast: (await awaiting(ROOM.awaitEvent + 1)).outcome,
        awaitTaskAtItsRoom: await awaitingTask(ROOM.awaitTask),
        awaitTaskOnePast: await awaitingTask(ROOM.awaitTask + 1),
        registeredAtItsRoom: (await registered(ROOM.registeredStep)).outcome,
        registeredOnePast: (await registered(ROOM.registeredStep + 1)).outcome,
        twiceAtItsRoom: (await twice(ROOM.stepUsedTwice)).outcome,
        twiceOnePast: (await twice(ROOM.stepUsedTwice + 1)).outcome,
        spawnAtItsRoom: (await spawning(room)).outcome,
        spawnOnePast: (await spawning(room + 1)).outcome,
      }).toEqual({
        rooms: {
          awaitEvent: 248,
          awaitTask: 243,
          registeredStep: 239,
          stepUsedTwice: 253,
          childTaskNameUnderA36CharacterParentId: 201,
        },
        awaitAtItsRoom: 'suspended',
        awaitOnePast: 'failed',
        awaitTaskAtItsRoom: { outcome: 'failed', refusedByTheSdk: false },
        awaitTaskOnePast: { outcome: 'failed', refusedByTheSdk: true },
        registeredAtItsRoom: 'completed',
        registeredOnePast: 'failed',
        twiceAtItsRoom: 'completed',
        twiceOnePast: 'failed',
        spawnAtItsRoom: 'completed',
        spawnOnePast: 'failed',
      })
    })

    it('still finishes a task in flight whose step name was stored before the rule and is longer than the width', async () => {
      const f = await open('width-in-flight-step')
      const longName = 'p'.repeat(300)
      let stepName = 'short'
      const ran: string[] = []
      const reg = registry({
        job: async (ctx) => {
          const kept = await ctx.step(stepName, () => {
            ran.push('body')
            return 'kept'
          })
          await ctx.sleepFor(1)
          return kept
        },
      })
      const task = await f.store.spawn(Q, 'job', '{}', THREE_TRIES)
      const first = await runNext(f, reg, 'w-first')
      // What an older build would have stored: the same memo, under a name past the width.
      await f.raw.batch('older-build-step-name', [
        {
          sql: 'UPDATE checkpoints SET checkpoint_name = ? WHERE task_id = ? AND checkpoint_name = ?',
          args: [longName, task.taskId, 'short'],
        },
      ])
      stepName = longName
      await f.advance(2_000)
      const rest = await drive(f, reg, task.taskId)
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect(
        {
          first,
          rest,
          ran,
          state: result?.state,
          payload: result?.completedPayloadJson,
        },
        'mutation-verdict:behavior:sdk-replays-a-key-already-stored',
      ).toEqual({
        first: 'suspended',
        rest: ['completed'],
        ran: ['body'],
        state: 'completed',
        payload: '"kept"',
      })
      await f.close()
    })

    it('rolls a saga in flight back and keeps its cause when its step key was stored before the rule and is past 239 characters', async () => {
      const f = await open('width-in-flight-saga')
      const longKey = 'k'.repeat(240)
      let stepName = 's'
      const effects: string[] = []
      const reg = registry({
        saga: async (ctx) => {
          await ctx.step(stepName, () => effects.push('do'), {
            rollback: () => {
              effects.push('undo')
            },
          })
          throw new FatalTaskError('boom')
        },
      })
      const task = await f.store.spawn(Q, 'saga', '{}')
      const first = await runNext(f, reg, 'w-first')
      // What an older build would have stored: the step and its start marker under a key
      // that fit the start marker then, and that the rule would not admit now.
      await f.raw.batch(
        'older-build-saga-key',
        [
          ['s', longKey],
          ['$started:s', `$started:${longKey}`],
        ].map(([from, to]) => ({
          sql: 'UPDATE checkpoints SET checkpoint_name = ? WHERE task_id = ? AND checkpoint_name = ?',
          args: [to as string, task.taskId, from as string],
        })),
      )
      stepName = longKey
      const rest = await drive(f, reg, task.taskId).catch((error: unknown) => [
        `the pass threw: ${String(error).slice(0, 80)}`,
      ])
      const result = await f.store.getTaskResult(Q, task.taskId)
      expect({
        first,
        rest,
        effects,
        state: result?.state,
        keepsItsCause: failureOf(result).includes('boom'),
        rollback: result?.rollback,
      }).toEqual({
        first: 'rolling-back',
        rest: ['rolled-back'],
        effects: ['do', 'undo'],
        state: 'failed',
        keepsItsCause: true,
        rollback: { outcome: 'complete' },
      })
      await f.close()
    })

    it('does not run the body again when a step that started before the rule and never persisted has a stored key past the width, and still completes one whose stored key fits', async () => {
      // A step that registers a rollback stores its start marker before its body runs. If
      // the body then throws, the step has started and has no memo, so a later pass runs
      // the body again and must write its result under the same key. Under a stored key
      // past the width that write can never succeed, so running the body first only
      // repeats its side effect on every remaining attempt.
      const startedAndNeverPersisted = async (length: number) => {
        const f = await open(`width-started-never-persisted-${length}`)
        const longKey = 'k'.repeat(length)
        let stepName = 's'
        const ran: string[] = []
        const reg = registry({
          job: async (ctx) => {
            await ctx.step(
              stepName,
              () => {
                ran.push('body')
                if (ran.length === 1) throw new Error('the first body throws')
                return 'ok'
              },
              {
                rollback: () => {
                  ran.push('undo')
                },
              },
            )
          },
        })
        const task = await f.store.spawn(Q, 'job', '{}', {
          maxAttempts: 4,
          retryStrategy: NO_DELAY,
        })
        const first = await runNext(f, reg, 'w-first')
        // What an older build would have stored: the start marker, under a longer key.
        await f.raw.batch('older-build-start-marker', [
          {
            sql: 'UPDATE checkpoints SET checkpoint_name = ? WHERE task_id = ? AND checkpoint_name = ?',
            args: [`$started:${longKey}`, task.taskId, '$started:s'],
          },
        ])
        stepName = longKey
        const rest = await drive(f, reg, task.taskId).catch((error: unknown) => [
          `the pass threw: ${String(error).slice(0, 80)}`,
        ])
        const result = await f.store.getTaskResult(Q, task.taskId)
        await f.close()
        return { first, rest, ran, state: result?.state }
      }
      expect(
        {
          storedKeyOf300: await startedAndNeverPersisted(300),
          storedKeyOf250: await startedAndNeverPersisted(250),
        },
        'mutation-verdict:behavior:sdk-started-key-held-to-the-width',
      ).toEqual({
        // The body is not run again. The task fails for good, and the pass that follows
        // runs the rollback the first body is owed, once. It cannot be recorded.
        storedKeyOf300: {
          first: 'retry-scheduled',
          rest: ['rolling-back', 'failed'],
          ran: ['body', 'undo'],
          state: 'failed',
        },
        // A key that fits can still be written, so the step runs again and completes.
        storedKeyOf250: {
          first: 'retry-scheduled',
          rest: ['completed'],
          ran: ['body', 'body'],
          state: 'completed',
        },
      })
    })
  })
}
