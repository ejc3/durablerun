import { describe, expect, it } from 'vitest'
import {
  EventName,
  RunTaskMemo,
  materializeTaskDoneCas,
  sqlFragment,
  type TaskOutcome,
  childSpawnKey,
  decodeTaskOutcome,
  encodeTaskOutcome,
  refuseReservedEventName,
  taskDoneEventName,
} from '../src/index.js'

function refusal(run: () => unknown): string {
  try {
    run()
    return 'accepted'
  } catch (error) {
    return error instanceof Error ? error.name : String(error)
  }
}

describe('the completion event contract', () => {
  const outcomes: TaskOutcome[] = [
    { state: 'completed', completedPayloadJson: '{"out":1}' },
    { state: 'completed', completedPayloadJson: 'null' },
    { state: 'failed', failureReasonJson: '{"name":"Boom"}' },
    { state: 'cancelled', failureReasonJson: '{"name":"$Cancelled"}' },
  ]

  it('names a completion event under the reserved prefix', () => {
    expect(taskDoneEventName('t1')).toBe('$task-done:t1')
  })

  it('refuses every reserved event name and admits every other', () => {
    expect(
      {
        done: refusal(() => refuseReservedEventName('emitEvent', taskDoneEventName('t1'))),
        bare: refusal(() => refuseReservedEventName('emitEvent', '$')),
        user: refusal(() => refuseReservedEventName('emitEvent', 'order-paid')),
        inner: refusal(() => refuseReservedEventName('emitEvent', 'a$b')),
        empty: refusal(() => refuseReservedEventName('emitEvent', '')),
      },
      'mutation-verdict:behavior:reserved-event-name-prefix',
    ).toEqual({
      done: 'PortRefusalError',
      bare: 'PortRefusalError',
      user: 'accepted',
      inner: 'accepted',
      empty: 'accepted',
    })
  })

  it('carries the task of a completion event, and shows a person the task and never the reserved name', () => {
    const shown = (name: EventName) => ({
      value: name.value,
      taskId: name.taskId,
      display: name.display,
    })
    expect({
      named: shown(EventName.fromPort('emitEvent', 'order-paid')),
      done: shown(EventName.taskDone('t1')),
      awaited: shown(EventName.awaitedTaskDone('t1')),
    }).toEqual({
      named: { value: 'order-paid', taskId: null, display: 'order-paid' },
      done: { value: '$task-done:t1', taskId: 't1', display: 'task t1' },
      awaited: { value: '$task-done:t1', taskId: 't1', display: 'task t1' },
    })
  })

  it('records a completion event only: the recording statement takes no other name, by type and when built', () => {
    const binds = {
      queue: 'q',
      taskId: 'parent',
      runId: 'r1',
      claimToken: 'tok',
      taskOwnsRun: sqlFragment('t.task_id = r.task_id'),
      payloadJson: '{"state":"completed","completedPayloadJson":"1"}',
      childStamp: null,
      liveTask: sqlFragment("t.state IN ('pending')"),
    }
    expect(
      {
        aCallersEvent: refusal(() =>
          // @ts-expect-error a caller's event carries no task, so it is not a completion event's name
          materializeTaskDoneCas({ ...binds, eventName: EventName.fromPort('emitEvent', 'paid') }),
        ),
        aCompletionEvent: refusal(() =>
          materializeTaskDoneCas({ ...binds, eventName: EventName.taskDone('child') }),
        ),
      },
      'mutation-verdict:behavior:recording-statement-takes-a-completion-event-only',
    ).toEqual({ aCallersEvent: 'Error', aCompletionEvent: 'accepted' })
  })

  it('refuses an event name that is not a string as invalid input, not as a crash', () => {
    const names: unknown[] = [7, null, undefined, { startsWith: () => false }]
    expect(
      names.map((name) => refusal(() => refuseReservedEventName('emitEvent', name as string))),
      'mutation-verdict:behavior:reserved-event-name-type',
    ).toEqual(names.map(() => 'PortRefusalError'))
  })

  it('round-trips every outcome through its payload', () => {
    expect(outcomes.map((outcome) => decodeTaskOutcome('t1', encodeTaskOutcome(outcome)))).toEqual(
      outcomes,
    )
  })

  // A rolling deploy: a newer build may add a field, and a build that predates it reads the
  // state and the fields it knows.
  it('ignores a payload field it does not know, in every outcome', () => {
    const widened = (outcome: TaskOutcome) =>
      JSON.stringify({ ...outcome, rollback: { outcome: 'failed' }, later: 1 })
    expect(outcomes.map((outcome) => decodeTaskOutcome('t1', widened(outcome)))).toEqual(outcomes)
  })

  it('refuses a payload that is not JSON', () => {
    expect(
      refusal(() => decodeTaskOutcome('t1', '{"state":')),
      'mutation-verdict:behavior:task-outcome-refuses-non-json',
    ).toBe('RangeError')
  })

  it('refuses a payload that is not an object', () => {
    expect(
      ['null', '"completed"', '7', '[]'].map((payload) =>
        refusal(() => decodeTaskOutcome('t1', payload)),
      ),
      'mutation-verdict:behavior:task-outcome-refuses-non-object',
    ).toEqual(['RangeError', 'RangeError', 'RangeError', 'RangeError'])
  })

  it('refuses a payload whose state is not terminal', () => {
    expect(
      [
        // Nothing but the state, so that no other rule refuses these.
        '{"state":"running"}',
        '{}',
        '{"state":7}',
      ].map((payload) => refusal(() => decodeTaskOutcome('t1', payload))),
      'mutation-verdict:behavior:task-outcome-refuses-live-state',
    ).toEqual(['RangeError', 'RangeError', 'RangeError'])
  })

  it('refuses a payload whose outcome contradicts its state', () => {
    expect(
      [
        '{"state":"completed"}',
        '{"state":"completed","completedPayloadJson":"1","failureReasonJson":"{}"}',
        '{"state":"completed","completedPayloadJson":1}',
        '{"state":"failed"}',
        '{"state":"failed","completedPayloadJson":"1","failureReasonJson":"{}"}',
        '{"state":"cancelled","completedPayloadJson":"1"}',
      ].map((payload) => refusal(() => decodeTaskOutcome('t1', payload))),
      'mutation-verdict:behavior:task-outcome-refuses-contradiction',
    ).toEqual(Array.from({ length: 6 }, () => 'RangeError'))
  })

  it('reads the outcome from own properties only', () => {
    const polluted = Object.prototype as Record<string, unknown>
    polluted.state = 'completed'
    polluted.completedPayloadJson = '"forged"'
    try {
      expect(refusal(() => decodeTaskOutcome('t1', '{}'))).toBe('RangeError')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'state')
      Reflect.deleteProperty(Object.prototype, 'completedPayloadJson')
    }
  })
})

describe("a child's spawn key", () => {
  // Both strings are a caller's at the port. Joined by a delimiter that either may
  // contain, two pairs spell one key, and the second spawn adopts the first one's task.
  it('is a different key for every pair of parent and call site', () => {
    expect(
      [
        childSpawnKey('a', 'b:c') === childSpawnKey('a:b', 'c'),
        childSpawnKey('1', ':x') === childSpawnKey('1:', 'x'),
      ],
      'mutation-verdict:behavior:child-spawn-key-is-unambiguous',
    ).toEqual([false, false])
  })
})

describe('the run-to-task memo', () => {
  it('recalls what it was told, and nothing else', () => {
    const memo = new RunTaskMemo()
    memo.remember('r1', 't1')
    expect({ known: memo.recall('r1'), unknown: memo.recall('r2') }).toEqual({
      known: 't1',
      unknown: undefined,
    })
  })

  it('lets its oldest entry go once it is full', () => {
    const memo = new RunTaskMemo(2)
    memo.remember('r1', 't1')
    memo.remember('r2', 't2')
    memo.remember('r1', 't1') // told again: r1 is now the newest
    memo.remember('r3', 't3')
    expect(
      { r1: memo.recall('r1'), r2: memo.recall('r2'), r3: memo.recall('r3') },
      'mutation-verdict:behavior:run-task-memo-is-bounded',
    ).toEqual({ r1: 't1', r2: undefined, r3: 't3' })
  })

  it('lets a run go when told it has ended, which leaves its room to the others', () => {
    const memo = new RunTaskMemo(2)
    memo.remember('r1', 't1')
    memo.remember('r2', 't2')
    memo.forget('r2')
    memo.remember('r3', 't3')
    expect({ r1: memo.recall('r1'), r2: memo.recall('r2'), r3: memo.recall('r3') }).toEqual({
      r1: 't1',
      r2: undefined,
      r3: 't3',
    })
  })
})
