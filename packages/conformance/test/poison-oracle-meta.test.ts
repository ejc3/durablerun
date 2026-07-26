import type { SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { engineInvariantFindings } from '../src/invariants.js'
import { POISON_WITNESSES, runPoisonMatrixCase } from '../src/poison-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

function witness(id: string) {
  const found = POISON_WITNESSES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing poison witness ${id}`)
  return found
}

async function write(raw: SqlExecutor, statements: Parameters<SqlExecutor['batch']>[1]) {
  await raw.batch('oracle-meta', statements, 'write')
}

describe('poison/invariant mechanism self-tests', () => {
  it('rejects a truncated invariant result vector', async () => {
    const f = await makeLibsqlFixture('truncated-invariants')
    try {
      const truncated: SqlExecutor = {
        batch: async (label, statements, mode) => {
          const results = await f.raw.batch(label, statements, mode)
          return label === 'invariants' ? results.slice(0, -1) : results
        },
      }
      await expect(engineInvariantFindings(truncated)).rejects.toThrow(/result count/)
    } finally {
      f.close()
    }
  })

  it('rejects a same-length malformed invariant result vector', async () => {
    const f = await makeLibsqlFixture('malformed-invariants')
    try {
      const malformed: SqlExecutor = {
        batch: async (label, statements, mode) => {
          const results = await f.raw.batch(label, statements, mode)
          if (label !== 'invariants') return results
          const copy: Array<(typeof results)[number] | undefined> = [...results]
          copy[2] = undefined
          return copy as typeof results
        },
      }
      await expect(engineInvariantFindings(malformed)).rejects.toThrow(/no rows array/)
    } finally {
      f.close()
    }
  })

  it('rejects a truncated poison snapshot result vector', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            raw: {
              batch: async (label, statements, mode) => {
                const results = await f.raw.batch(label, statements, mode)
                return label === 'poison:snapshot' ? results.slice(0, -1) : results
              },
            },
          }
        },
        'activate',
        witness('terminal-task/live-running-run'),
      ),
    ).rejects.toThrow(/poison snapshot result count/)
  })

  it('rejects poison snapshot rows missing authority columns', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            raw: {
              batch: async (label, statements, mode) => {
                const results = await f.raw.batch(label, statements, mode)
                if (label !== 'poison:snapshot') return results
                return results.map((result, index) =>
                  index === 0
                    ? {
                        ...result,
                        rows: result.rows.map((row) =>
                          Object.fromEntries(
                            Object.entries(row).filter(([column]) => column !== 'task_id'),
                          ),
                        ),
                      }
                    : result,
                )
              },
            },
          }
        },
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
      ),
    ).rejects.toThrow(/poison snapshot tasks row 0 is missing required column task_id/)
  })

  it('accepts a dialect adapter that returns exact integers as bigint', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            raw: {
              batch: async (label, statements, mode) =>
                (await f.raw.batch(label, statements, mode)).map((result) => ({
                  ...result,
                  rows: result.rows.map((row) =>
                    Object.fromEntries(
                      Object.entries(row).map(([column, value]) => [
                        column,
                        typeof value === 'number' && Number.isSafeInteger(value)
                          ? BigInt(value)
                          : value,
                      ]),
                    ),
                  ),
                })),
            },
          }
        },
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
      ),
    ).resolves.toMatchObject({
      label: 'driver-heartbeat',
      witness: 'provenance/stamp-without-instant',
    })
  })

  it('accepts a strict dialect structurally rejecting an invalid storage representation', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            injectStorageCorruption: async () => 'structurally-rejected' as const,
          }
        },
        'driver-heartbeat',
        witness('temporal/run-available'),
      ),
    ).resolves.toMatchObject({
      label: 'driver-heartbeat',
      witness: 'temporal/run-available',
      corruptionDisposition: 'structurally-rejected',
    })
  })

  it('credits a write statement whose dialect SQL begins with a CTE', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            storeOver: (db, buggify) =>
              f.storeOver(
                {
                  batch: (label, statements, mode) =>
                    db.batch(
                      label,
                      statements.map((statement, index) =>
                        label === 'driver-heartbeat' && index === 0
                          ? {
                              ...statement,
                              sql: `WITH marker AS (SELECT 1)\n${statement.sql}`,
                            }
                          : statement,
                      ),
                      mode,
                    ),
                },
                buggify,
              ),
          }
        },
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
      ),
    ).resolves.toMatchObject({
      label: 'driver-heartbeat',
      witness: 'provenance/stamp-without-instant',
    })
  })

  it('rejects a label that crossed the executor but made no durable state change', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'activate',
        witness('terminal-task/live-running-run'),
        { healthyTrigger: false },
      ),
    ).rejects.toThrow(/no durable state change/)
  })

  it('does not count SELECT result rows as a write in a write-mode batch', async () => {
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          return {
            ...f,
            storeOver: (db, buggify) =>
              f.storeOver(
                {
                  batch: (label, statements, mode) =>
                    db.batch(
                      label,
                      statements.map((statement) => ({
                        ...statement,
                        sql: 'SELECT 1 AS value',
                        args: [],
                      })),
                      mode,
                    ),
                },
                buggify,
              ),
          }
        },
        'activate',
        witness('terminal-task/live-running-run'),
        { healthyTrigger: false },
      ),
    ).rejects.toThrow(/no durable state change/)
  })

  it('catches an existing foreign run laundering its owner into the allowed task', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `INSERT INTO tasks
                        (task_id, queue, task_name, params, retry_strategy, max_attempts,
                         state, enqueue_at_ms, created_at_ms)
                      VALUES ('foreign-task', 'q', 'foreign', '{}', '{}', 1,
                              'sleeping', 1000000, 1000000)`,
                args: [],
              },
              {
                sql: `INSERT INTO runs
                        (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
                      VALUES ('foreign-run', 'q', 'foreign-task', 1, 'sleeping', NULL, 1000000)`,
                args: [],
              },
            ]),
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET task_id = 'owner-swap-temporary'
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
              {
                sql: `UPDATE runs SET task_id = 'poison-task', state = 'running',
                        claimed_by = 'poison-worker', claim_expires_at_ms = 1060000
                      WHERE run_id = 'foreign-run'`,
                args: [],
              },
              {
                sql: `UPDATE runs SET task_id = 'foreign-task', state = 'sleeping',
                        claimed_by = NULL, claim_expires_at_ms = NULL
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/authority/)
  })

  it('distinguishes composite row keys that contain separators', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `INSERT INTO checkpoints
                        (task_id, checkpoint_name, queue, state, status,
                         owner_run_id, owner_attempt, updated_at_ms)
                      VALUES ('collision/a', 'b', 'q', '{}', 'committed',
                              'poison-run', 1, 1000000)`,
                args: [],
              },
              {
                sql: `INSERT INTO checkpoints
                        (task_id, checkpoint_name, queue, state, status,
                         owner_run_id, owner_attempt, updated_at_ms)
                      VALUES ('collision', 'a/b', 'q', '{}', 'committed',
                              'protected-run', 1, 1000000)`,
                args: [],
              },
            ]),
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE checkpoints SET state = '{"escaped":true}'
                      WHERE task_id = 'collision' AND checkpoint_name = 'a/b'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/authority/)
  })

  it('uses structured finding identity when a rendered violation moves between rows', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        witness('provenance/stamp-without-instant'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `INSERT INTO runs
                        (run_id, queue, task_id, attempt, state, created_at_ms)
                      VALUES ('collision/a', 'q', 'poison-task', 2, 'completed', 1000000),
                             ('collision', 'q', 'poison-task', 3, 'completed', 1000000)`,
                args: [],
              },
              {
                sql: `INSERT INTO waits
                        (run_id, step_name, queue, task_id, event_name, status,
                         created_at_ms, fence_stamp, fence_at_ms)
                      VALUES ('collision/a', 'b', 'q', 'poison-task', 'event-a',
                              'delivered', 1000000, 'collision:source', NULL),
                             ('collision', 'a/b', 'q', 'poison-task', 'event-b',
                              'delivered', 1000000, NULL, NULL)`,
                args: [],
              },
            ]),
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE waits SET fence_stamp = NULL, fence_at_ms = NULL
                      WHERE run_id = 'collision/a' AND step_name = 'b'`,
                args: [],
              },
              {
                sql: `UPDATE waits SET fence_stamp = 'collision:target', fence_at_ms = NULL
                      WHERE run_id = 'collision' AND step_name = 'a/b'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/new invariant violation/)
  })

  it('catches attempts worsening on the same invariant subject', async () => {
    await expect(
      runPoisonMatrixCase(makeLibsqlFixture, 'driver-heartbeat', witness('accounting/above-top'), {
        afterInvoke: (raw) =>
          write(raw, [
            {
              sql: `UPDATE tasks SET attempts = 100, max_attempts = 1000
                      WHERE task_id = 'poison-task'`,
              args: [],
            },
          ]),
      }),
    ).rejects.toThrow(/worsened/)
  })

  it('catches a negative counter worsening on the same invariant subject', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        witness('generation/negative-attempts'),
        {
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE tasks SET attempts = -100, infra_retries = 100
                      WHERE task_id = 'poison-task'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/worsened/)
  })

  it('catches a larger deadline divergence on the same wait', async () => {
    await expect(
      runPoisonMatrixCase(makeLibsqlFixture, 'driver-heartbeat', witness('wait/deadlines-differ'), {
        afterInvoke: (raw) =>
          write(raw, [
            {
              sql: `UPDATE waits SET timeout_at_ms = 1099999
                      WHERE run_id = 'poison-run' AND step_name = '$await:poison'`,
              args: [],
            },
          ]),
      }),
    ).rejects.toThrow(/worsened/)
  })

  it('catches a wider instant span for the same provenance seed', async () => {
    await expect(
      runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        witness('provenance/one-seed-two-instants'),
        {
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET fence_at_ms = 1000100
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/worsened/)
  })
})
