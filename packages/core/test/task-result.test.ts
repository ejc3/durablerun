import { describe, expect, it } from 'vitest'
import { decodeTaskResult, taskResultContradictions } from '../src/task-result.js'
import * as taskResult from '../src/task-result.js'

describe('decodeTaskResult', () => {
  it('decodes each legitimate outcome shape', () => {
    expect(
      decodeTaskResult('t', {
        state: 'completed',
        completed_payload: '{"x":1}',
        failure_reason: null,
      }),
    ).toEqual({ state: 'completed', completedPayloadJson: '{"x":1}' })
    expect(
      decodeTaskResult('t', {
        state: 'failed',
        completed_payload: null,
        failure_reason: '{"name":"Boom"}',
      }),
    ).toEqual({ state: 'failed', failureReasonJson: '{"name":"Boom"}' })
    expect(
      decodeTaskResult('t', { state: 'sleeping', completed_payload: null, failure_reason: null }),
    ).toEqual({ state: 'sleeping' })
  })

  it('refuses a row with an unknown state or a missing outcome column', () => {
    const rows = [
      [
        'unknown state',
        { state: 'paused', completed_payload: null, failure_reason: null },
        /unknown state paused/,
      ],
      ['missing state', { completed_payload: null, failure_reason: null }, /has no state column/],
      [
        'missing payload column',
        { state: 'pending', failure_reason: null },
        /has no completed_payload column/,
      ],
      [
        'missing reason column',
        { state: 'pending', completed_payload: null },
        /has no failure_reason column/,
      ],
    ] as const
    for (const [shape, row, refusal] of rows) {
      expect(() => decodeTaskResult('t', row), `${shape} must be refused`).toThrow(refusal)
    }
  })

  it('reports every rule a task row breaks', () => {
    expect(
      taskResultContradictions('t', {
        state: 'failed',
        completed_payload: '{"x":1}',
        failure_reason: null,
      }),
    ).toEqual(['payload-on-other-state', 'failure-without-reason'])
    expect(
      taskResultContradictions('t', {
        state: 'completed',
        completed_payload: '{"x":1}',
        failure_reason: null,
      }),
    ).toEqual([])
  })

  it('publishes exactly the checked outcome readers and their column lists', () => {
    // A new export from this module is a new way to read an outcome, so it must be
    // added here deliberately, after checking that it refuses contradicting rows.
    expect(Object.keys(taskResult).sort()).toEqual([
      'TASK_OUTCOME_COLUMNS',
      'TASK_RESULT_COLUMNS',
      'decodeTaskResult',
      'taskResultContradictions',
    ])
  })
})
