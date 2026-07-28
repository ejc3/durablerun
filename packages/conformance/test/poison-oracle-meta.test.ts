import {
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
  type PersistedCounterFieldDescriptor,
  type PersistedTemporalFieldDescriptor,
  type SqlExecutor,
} from '@durablerun/core'
import { attributeExpectedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { engineInvariantFindings } from '../src/invariants.js'
import {
  POISON_TARGET_CASES,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  runPoisonMatrixCase,
  runPoisonTargetCase,
} from '../src/poison-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

function witness(id: string) {
  const found = POISON_WITNESSES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing poison witness ${id}`)
  return found
}

function target(id: string) {
  const found = POISON_TARGET_CASES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing poison target ${id}`)
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
    ).rejects.toThrow(/runs\/foreign-run was outside frozen pre-state authority/)
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
    ).rejects.toThrow(/checkpoints\/\["collision","a\/b"\] was outside frozen pre-state authority/)
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

  const fieldPredicate = (field: PersistedCounterFieldDescriptor): string => {
    if (field.table === 'tasks') return `task_id = 'poison-task'`
    if (field.table === 'runs') return `run_id = 'poison-run'`
    return `task_id = 'poison-task' AND checkpoint_name = 'poison-checkpoint'`
  }

  const temporalFieldPredicate = (field: PersistedTemporalFieldDescriptor): string => {
    switch (field.table) {
      case 'tasks':
        return `task_id = 'poison-task'`
      case 'runs':
        return `run_id = 'poison-run'`
      case 'checkpoints':
        return `task_id = 'poison-task' AND checkpoint_name = 'poison-checkpoint'`
      case 'events':
        return `queue = 'q' AND event_name = 'protected-fired-event'`
      case 'waits':
        return `run_id = 'protected-run' AND step_name = '$await:protected'`
      case 'drivers':
        return `queue = 'q' AND driver_id = 'protected-driver'`
    }
  }

  for (const side of ['upper', 'lower'] as const) {
    for (const field of PERSISTED_COUNTER_FIELDS) {
      it(`catches ${side} ${field.id} worsening on the same subject`, async () => {
        const run = () =>
          runPoisonMatrixCase(
            makeLibsqlFixture,
            'driver-heartbeat',
            witness(
              side === 'upper' ? `counter-bound/${field.id}` : `counter-bound-lower/${field.id}`,
            ),
            {
              afterInvoke: (raw) =>
                write(raw, [
                  {
                    sql: `UPDATE ${field.table}
                          SET ${field.column} = ${field.column} ${side === 'upper' ? '+' : '-'} 1
                          WHERE ${fieldPredicate(field)}`,
                    args: [],
                  },
                ]),
            },
          )
        if (side === 'lower' && field.id === 'task-attempts') {
          await requireExpectedFailure(
            { kind: 'behavior', mutation: 'poison-severity-lower-bound' },
            /worsened/,
            run,
          )
        } else if (side === 'upper' && field.id === 'checkpoint-owner-attempt') {
          await requireExpectedFailure(
            { kind: 'behavior', mutation: 'poison-severity-checkpoint' },
            /worsened/,
            run,
          )
        } else {
          await expect(run()).rejects.toThrow(/worsened/)
        }
      })
    }
  }

  it('owns both boundary witnesses for every persisted counter bound', () => {
    const ids = new Set(POISON_WITNESSES.map((candidate) => candidate.id))
    for (const field of PERSISTED_COUNTER_FIELDS) {
      expect(ids).toContain(`counter-bound/${field.id}`)
      expect(ids).toContain(`counter-bound-lower/${field.id}`)
    }
  })

  it('owns storage and both boundary witnesses for every persisted temporal field', () => {
    const ids = new Set(POISON_WITNESSES.map((candidate) => candidate.id))
    for (const field of PERSISTED_TEMPORAL_FIELDS) {
      expect(ids).toContain(`temporal/${field.id}`)
      expect(ids).toContain(`temporal-bound-lower/${field.id}`)
      expect(ids).toContain(`temporal-bound/${field.id}`)
    }
    const temporalWitnesses = POISON_WITNESSES.filter(
      ({ id }) =>
        id.startsWith('temporal/') ||
        id.startsWith('temporal-bound-lower/') ||
        id.startsWith('temporal-bound/'),
    )
    expect(temporalWitnesses).toHaveLength(69)
    expect(
      [
        ...new Set(
          temporalWitnesses.flatMap((candidate) =>
            candidate.storageCorruption === undefined ? [] : [candidate.storageCorruption.table],
          ),
        ),
      ].sort(),
    ).toEqual(['checkpoints', 'drivers', 'events', 'runs', 'tasks', 'waits'])
  })

  for (const side of ['upper', 'lower'] as const) {
    for (const field of PERSISTED_TEMPORAL_FIELDS) {
      it(`catches ${side} ${field.id} temporal-bound worsening on the same subject`, async () => {
        await expect(
          runPoisonMatrixCase(
            makeLibsqlFixture,
            'emit-event',
            witness(
              side === 'upper' ? `temporal-bound/${field.id}` : `temporal-bound-lower/${field.id}`,
            ),
            {
              afterInvoke: (raw) =>
                write(raw, [
                  {
                    sql: `UPDATE ${field.table}
                          SET ${field.column} = ${field.column} ${side === 'upper' ? '+' : '-'} 1
                          WHERE ${temporalFieldPredicate(field)}`,
                    args: [],
                  },
                ]),
            },
          ),
        ).rejects.toThrow(/worsened/)
      })
    }
  }

  it('classifies every counter boundary against every target arm', () => {
    const boundaries = POISON_WITNESSES.filter(
      (candidate) => candidate.counterBoundary !== undefined,
    )
    expect(boundaries).toHaveLength(PERSISTED_COUNTER_FIELDS.length * 2)
    expect(
      boundaries.flatMap((candidate) =>
        Object.entries(candidate.counterBoundary?.arms ?? {}).map(([arm, classification]) => ({
          id: candidate.id,
          arm,
          kind: classification.kind,
        })),
      ),
    ).toHaveLength(PERSISTED_COUNTER_FIELDS.length * 2 * 3)
    expect(
      POISON_TARGET_CASES,
      'mutation-verdict:behavior:poison-targetability-inventory',
    ).toHaveLength(50)
    expect(POISON_UNREACHABLE_TARGETS).toHaveLength(26)
  })

  it('pins every unreachable counter target and its reason', () => {
    expect(POISON_UNREACHABLE_TARGETS.map((target) => `${target.id}=${target.reason}`)).toEqual([
      'counter-bound/task-attempts/claim=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/claim=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound/run-claim-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/claim=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/sweep:lost-launch=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound/checkpoint-owner-attempt/claim=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/sweep:lost-launch=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/sweep:claim-timeout=transition-does-not-read-field',
      'counter-bound-lower/task-max-attempts/claim=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/claim=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/claim=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/sweep:lost-launch=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-activated-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/checkpoint-owner-attempt/claim=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/sweep:lost-launch=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/sweep:claim-timeout=transition-does-not-read-field',
    ])
  })

  it('generates both ordered claim legs for a targetable boundary', () => {
    expect(
      POISON_TARGET_CASES.filter(
        (candidate) => candidate.witness.id === 'counter-bound/task-infra-retries',
      )
        .map((candidate) => candidate.profile)
        .filter((profile) => profile.startsWith('claim-'))
        .sort(),
    ).toEqual(['claim-pending', 'claim-sleeping'])
  })

  it('owns an executable case for every declared lifecycle profile', () => {
    expect(new Set(POISON_TARGET_CASES.map((candidate) => candidate.profile))).toEqual(
      new Set(['claim-pending', 'claim-sleeping', 'sweep-lost-launch', 'sweep-claim-timeout']),
    )
  })

  it('enrolls every relational and fractional target in every lifecycle arm', () => {
    const profiles = [
      'claim-pending',
      'claim-sleeping',
      'sweep-lost-launch',
      'sweep-claim-timeout',
    ] as const
    const witnesses = [
      'attempts/at-max-with-live-run',
      'accounting/below-top-minus-one',
      'accounting/live-run-not-next',
      'counter-fractional/task-max-attempts',
      'counter-fractional/run-relaunch-count',
    ] as const
    const expected = witnesses.flatMap((witnessId) =>
      profiles.map((profile) => `${witnessId}/${profile}`),
    )
    const actual = POISON_TARGET_CASES.map((candidate) => candidate.id).filter((id) =>
      witnesses.some((witnessId) => id.startsWith(`${witnessId}/`)),
    )

    expect(actual, 'mutation-verdict:behavior:poison-relational-target-inventory').toEqual(expected)
  })

  it('rejects a claim target that no longer sorts before its healthy trigger', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/claim-pending'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET available_at_ms = 999997
                      WHERE run_id = 'label-trigger-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/poison does not sort before the healthy trigger/)
  })

  it('rejects a sweep target that no longer expires before its healthy trigger', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/sweep-lost-launch'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET claim_expires_at_ms = 999997
                      WHERE run_id = 'label-trigger-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/poison does not sort before the healthy trigger/)
  })

  it('rejects a target with an unrelated eligibility refusal', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/claim-pending'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET activated_gen = claim_gen + 1
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/generation tuple has an unrelated claim refusal/)
  })

  it('seeds a sleeping claim target from a prior activated generation', async () => {
    let generation: unknown
    await runPoisonTargetCase(
      makeLibsqlFixture,
      target('counter-bound/task-max-attempts/claim-sleeping'),
      {
        beforeSnapshot: async (raw) => {
          const [rows] = await raw.batch(
            'oracle-meta',
            [
              {
                sql: `SELECT claim_gen, activated_gen FROM runs
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
            ],
            'read',
          )
          generation = rows?.rows[0]
        },
      },
    )
    expect(generation).toMatchObject({ claim_gen: 1, activated_gen: 1 })
  })

  it('executes the claim-pending target profile', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-profile-claim-pending' },
      /declared claim-pending/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/claim-pending'),
        ),
    )
  })

  it('executes the claim-sleeping target profile', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-profile-claim-sleeping' },
      /declared claim-sleeping/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/claim-sleeping'),
        ),
    )
  })

  it('executes the sweep-lost-launch target profile', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-profile-sweep-lost-launch' },
      /declared sweep-lost-launch/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/sweep-lost-launch'),
        ),
    )
  })

  it('executes the sweep-claim-timeout target profile', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-profile-sweep-claim-timeout' },
      /declared sweep-claim-timeout/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/sweep-claim-timeout'),
        ),
    )
  })

  it('applies sweep target eligibility before the scan limit', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-sweep-scan-prelimit' },
      /made no durable state change/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/sweep-lost-launch'),
        ),
    )
  })

  it('contains upper relaunch_count at the claim door', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-claim-relaunch-upper' },
      /targeted poison-owned closure changed|returned the poison task or run/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/run-relaunch-count/claim-pending'),
        ),
    )
  })

  it('contains lower relaunch_count at the claim door', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-claim-relaunch-lower' },
      /targeted poison-owned closure changed|returned the poison task or run/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound-lower/run-relaunch-count/claim-pending'),
        ),
    )
  })

  it('contains an in-range fractional counter at the claim door', async () => {
    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-fractional-storage-guard' },
      /targeted poison-owned closure changed|returned the poison task or run/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-fractional/task-max-attempts/claim-pending'),
        ),
    )
  })

  it('rejects any targeted change to the poison-owned closure', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'poison-target-closure-comparison' },
      /targeted poison-owned closure changed/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/claim-pending'),
          {
            afterInvoke: (raw) =>
              write(raw, [
                {
                  sql: `UPDATE runs SET heartbeat_at_ms = 1000001
                      WHERE run_id = 'poison-run'`,
                  args: [],
                },
              ]),
          },
        ),
    )
  })

  it('rejects laundering the poison into a clean successor', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/sweep-claim-timeout'),
        {
          afterInvoke: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs
                      SET state = 'failed', claimed_by = NULL, claim_expires_at_ms = NULL
                      WHERE run_id = 'poison-run'`,
                args: [],
              },
              {
                sql: `INSERT INTO runs
                        (run_id, queue, task_id, attempt, state, available_at_ms, created_at_ms)
                      VALUES ('laundered-successor', 'q', 'poison-task', 2,
                              'pending', 1000000, 1000000)`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/targeted poison-owned closure changed/)
  })

  it('rejects returning the poison target even when storage stayed unchanged', async () => {
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'poison-returned-target-comparison' },
      /returned the poison task or run/,
      () =>
        runPoisonTargetCase(
          makeLibsqlFixture,
          target('counter-bound/task-max-attempts/claim-pending'),
          {
            afterOutcomes: (outcomes) => {
              outcomes.push({
                target: 'poison',
                result: [{ taskId: 'poison-task', runId: 'poison-run' }],
              })
            },
          },
        ),
    )
  })

  it('keeps the durable progress floor independent of targeted refusal', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/claim-pending'),
        { healthyTrigger: false },
      ),
    ).rejects.toThrow(/made no durable state change/)
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
