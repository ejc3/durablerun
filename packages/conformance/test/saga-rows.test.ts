import { encodeRollbackTry } from '@durablerun/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoreFixture } from '../src/index.js'
import { sagaViolations } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * `sagaViolations` runs behind every saga case, every fault matrix cell, and every fuzz
 * walk, and a checker nobody has seen fail holds nothing. Each case here is a finished
 * saga written by hand with exactly one defect, and the checker must name that defect and
 * no other. The rows are written directly because the engine refuses to produce them.
 */
const NOW = 1_000_000
const TASK = 'saga-task'

type Row = { name: string; state: string; ownerAttempt: number }

/** A saga that ended well: a and b started in that order, and were rolled back, b first. */
const HEALTHY: readonly Row[] = [
  { name: '$started:a', state: '1', ownerAttempt: 1 },
  { name: 'a', state: '"a"', ownerAttempt: 1 },
  { name: '$started:b', state: '2', ownerAttempt: 1 },
  { name: 'b', state: '"b"', ownerAttempt: 1 },
  { name: '$rolling-back', state: '{"name":"Boom"}', ownerAttempt: 2 },
  { name: '$rollback:b', state: 'null', ownerAttempt: 2 },
  {
    name: '$rollback-tries:a',
    state: encodeRollbackTry({ tries: 1, errorJson: '{"name":"R"}' }),
    ownerAttempt: 2,
  },
  { name: '$rollback:a', state: 'null', ownerAttempt: 3 },
]

const without = (...names: string[]) => HEALTHY.filter((row) => !names.includes(row.name))
const replaced = (name: string, state: string) =>
  HEALTHY.map((row) => (row.name === name ? { ...row, state } : row))

describe('the saga row checker', () => {
  let f: StoreFixture

  beforeEach(async () => {
    f = await makeLibsqlFixture('saga-rows')
  })

  afterEach(async () => {
    await f.close()
  })

  async function violationsOf(rows: readonly Row[], taskState = 'failed'): Promise<string[]> {
    await f.raw.batch('hand-written-saga', [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
                state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
              VALUES (?, 'q', 'saga', '{}', '{"kind":"none"}', 3, ?, 3, 0, ?, ?)`,
        args: [TASK, taskState, NOW, NOW],
      },
      ...rows.map((row) => ({
        sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
                owner_run_id, owner_attempt, updated_at_ms)
              VALUES (?, ?, 'q', ?, 'committed', ?, ?, ?)`,
        args: [TASK, row.name, row.state, `run-${row.ownerAttempt}`, row.ownerAttempt, NOW],
      })),
    ])
    // Only what the checker names, without the row it names it on.
    return (await sagaViolations(f.raw)).map((violation) => violation.split(':')[0] ?? violation)
  }

  it('finds nothing wrong with a saga that ended well', async () => {
    expect(await violationsOf(HEALTHY)).toEqual([])
  })

  const DEFECTS: Record<string, { rows: readonly Row[]; taskState?: string }> = {
    'saga/start-index-not-a-positive-integer': { rows: replaced('$started:b', '0') },
    'saga/start-index-shared': { rows: replaced('$started:b', '1') },
    'saga/rollback-of-a-step-that-never-started': {
      rows: [...HEALTHY, { name: '$rollback:c', state: 'null', ownerAttempt: 3 }],
    },
    // a was rolled back while b, which started after it, was not.
    'saga/rollback-out-of-order': { rows: without('$rollback:b') },
    'saga/attempt-record-undecodable': { rows: replaced('$rollback-tries:a', '{"tries":"one"}') },
    // The run that failed a's rollback owns a second attempt record, where a run fails once.
    'saga/attempt-records-share-a-run': {
      rows: [
        ...HEALTHY,
        {
          name: '$rollback-tries:b',
          state: encodeRollbackTry({ tries: 1, errorJson: '{"name":"R"}' }),
          ownerAttempt: 2,
        },
      ],
    },
    'saga/rollback-outside-the-phase': { rows: without('$rolling-back') },
    'saga/completed-in-the-phase': { rows: HEALTHY, taskState: 'completed' },
    // A forward step committed by the pass that holds the phase marker, or a later one.
    'saga/forward-checkpoint-in-the-phase': {
      rows: [...HEALTHY, { name: 'c', state: '"late"', ownerAttempt: 2 }],
    },
  }

  for (const [violation, defect] of Object.entries(DEFECTS)) {
    it(`names ${violation}, and nothing else`, async () => {
      expect(
        await violationsOf(defect.rows, defect.taskState),
        'mutation-verdict:behavior:saga-row-checker-names-the-defect',
      ).toEqual([violation])
    })
  }
})
