import { describe, expect, it } from 'vitest'
import {
  FENCE_RELATIONS,
  LIVE_STATES,
  TERMINAL_STATES,
  isLiveState,
  isTerminalState,
  parseFenceStamp,
} from '../src/index.js'

describe('canonical state partitions', () => {
  it('classifies every state through one complete partition', () => {
    expect(LIVE_STATES).toEqual(['pending', 'running', 'sleeping'])
    expect(TERMINAL_STATES).toEqual(['completed', 'failed', 'cancelled'])
    for (const state of [...LIVE_STATES, ...TERMINAL_STATES]) {
      expect([isLiveState(state), isTerminalState(state)]).toEqual([
        LIVE_STATES.includes(state as never),
        TERMINAL_STATES.includes(state as never),
      ])
    }
    expect(isLiveState('unknown')).toBe(false)
    expect(isTerminalState(null)).toBe(false)
  })
})

describe("the relations the purge of a task's unit follows", () => {
  it('reach the checkpoints by the task and the completion event by the queue', () => {
    // A column of a task holds its id and its queue, and none holds the name of its
    // completion event, so the second relation reaches the queue and a generated delete
    // names the event itself.
    expect(FENCE_RELATIONS['tasks-to-checkpoints']).toEqual({
      target: 'checkpoints',
      key: 'task_id',
      from: 'tasks',
      column: 'task_id',
      queueScoped: false,
    })
    expect(FENCE_RELATIONS['tasks-to-events']).toEqual({
      target: 'events',
      key: 'queue',
      from: 'tasks',
      column: 'queue',
      queueScoped: false,
    })
  })
})

describe('fence stamp parser', () => {
  it('splits at the final separator and applies the shared name grammar', () => {
    expect(parseFenceStamp('seed:with:colons:statement-1')).toEqual({
      ok: true,
      seed: 'seed:with:colons',
      statement: 'statement-1',
    })
    expect(parseFenceStamp('seed')).toEqual({ ok: false, reason: 'no-separator' })
    expect(parseFenceStamp(':statement')).toEqual({ ok: false, reason: 'empty-seed' })
    expect(parseFenceStamp('seed:')).toEqual({ ok: false, reason: 'empty-statement' })
    expect(parseFenceStamp('seed:not valid')).toEqual({
      ok: false,
      reason: 'statement-name-invalid',
    })
  })
})
