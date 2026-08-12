import {
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
  type PersistedCounterFieldDescriptor,
  type PersistedTemporalFieldDescriptor,
  type SqlExecutor,
} from '@durablerun/core'
import { attributeExpectedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { executeStorageCorruption } from '../src/fixture.js'
import { type EngineInvariantFinding, engineInvariantFindings } from '../src/invariants.js'
import {
  POISON_TARGET_CASES,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  type PoisonCounterTargetabilityRecord,
  type PoisonCounterTargetabilityVector,
  type PoisonTargetProfileSeedRecord,
  type ProtocolSnapshot,
  findingSeverity,
  runPoisonMatrixCase,
  runPoisonTargetCase,
} from '../src/poison-matrix.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

function witness(id: string) {
  const found = POISON_WITNESSES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing poison witness ${id}`)
  return found
}

function temporalWitness(boundsField: string) {
  const field = PERSISTED_TEMPORAL_FIELDS.find(
    (candidate) => candidate.bounds.field === boundsField,
  )
  if (!field) throw new Error(`missing temporal field ${boundsField}`)
  return witness(`temporal/${field.id}`)
}

function target(id: string) {
  const found = POISON_TARGET_CASES.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing poison target ${id}`)
  return found
}

function protocolSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    tasks: [],
    runs: [],
    checkpoints: [],
    events: [],
    waits: [],
    drivers: [],
    ...overrides,
  }
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

  it('credits structural rejection only after an observed storage write attempt', async () => {
    const strictError = new Error('strict temporal column rejected invalid storage')
    const runAvailableWitness = temporalWitness('runs.available_at_ms')
    let attempts = 0
    await expect(
      runPoisonMatrixCase(
        async (seed) => {
          const f = await makeLibsqlFixture(seed)
          const raw: SqlExecutor = {
            batch: async (label, statements, mode) => {
              if (label === 'fixture:storage-corrupt') {
                attempts += 1
                throw strictError
              }
              return f.raw.batch(label, statements, mode)
            },
          }
          return {
            ...f,
            raw,
            storageCorruptionAttempt: () => ({
              statements: [
                {
                  sql: `UPDATE runs SET available_at_ms = ? WHERE run_id = 'poison-run'`,
                  args: ['bad-time'],
                },
              ],
              verify: () => {
                throw new Error('strict rejection unexpectedly returned results')
              },
              isStructuralRejection: (error) => error === strictError,
            }),
          }
        },
        'driver-heartbeat',
        runAvailableWitness,
      ),
    ).resolves.toMatchObject({
      label: 'driver-heartbeat',
      witness: runAvailableWitness.id,
      corruptionDisposition: 'structurally-rejected',
    })
    expect(
      attempts,
      'mutation-verdict:construction:storage-corruption-rejection-requires-observed-attempt',
    ).toBe(1)
  })

  it('rejects a zero-statement structural-rejection claim', async () => {
    const f = await makeLibsqlFixture('zero-statement-corruption')
    try {
      await requireExpectedFailure(
        { kind: 'construction', mutation: 'storage-corruption-requires-statement' },
        /storage corruption attempt must contain at least one SQL statement/,
        () =>
          executeStorageCorruption(
            {
              ...f,
              storageCorruptionAttempt: () => ({
                statements: [],
                verify: () => undefined,
                isStructuralRejection: () => true,
              }),
            },
            {
              table: 'runs',
              runId: 'unused',
              column: 'available_at_ms',
              invalidRepresentation: 'non-integer',
            },
          ),
      )
    } finally {
      f.close()
    }
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

  it('computes exact lower-bound counter severity', async () => {
    const field = PERSISTED_COUNTER_FIELDS.find((candidate) => candidate.id === 'task-max-attempts')
    if (!field) throw new Error('missing task-max-attempts field')
    const finding: EngineInvariantFinding = {
      conditionId: 'counter-bound/task-max-attempts',
      name: 'counter-out-of-range',
      subject: 'tasks/poison-task',
      subjectIdentity: ['tasks', 'poison-task'],
      message: 'counter-out-of-range: tasks/poison-task',
    }
    const severity = (offset: number): bigint =>
      findingSeverity(
        finding,
        protocolSnapshot({
          tasks: [{ task_id: 'poison-task', max_attempts: field.bounds.min - offset }],
        }),
      )

    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-severity-lower-bound' },
      /unexpected lower-bound severities/,
      async () => {
        const actual = [severity(1), severity(2)]
        if (actual[0] !== 1n || actual[1] !== 2n) {
          throw new Error(`unexpected lower-bound severities: ${actual.join(', ')}`)
        }
      },
    )
  })

  it('resolves checkpoint severity by composite identity', async () => {
    const field = PERSISTED_COUNTER_FIELDS.find(
      (candidate) => candidate.id === 'checkpoint-owner-attempt',
    )
    if (!field) throw new Error('missing checkpoint-owner-attempt field')
    const finding: EngineInvariantFinding = {
      conditionId: 'counter-bound/checkpoint-owner-attempt',
      name: 'counter-out-of-range',
      subject: 'checkpoints/poison-task/poison-checkpoint',
      subjectIdentity: ['checkpoints', 'poison-task', 'poison-checkpoint'],
      message: 'counter-out-of-range: checkpoints/poison-task/poison-checkpoint',
    }
    const severity = (offset: number): bigint =>
      findingSeverity(
        finding,
        protocolSnapshot({
          checkpoints: [
            {
              task_id: 'poison-task',
              checkpoint_name: 'poison-checkpoint',
              owner_attempt: field.bounds.max + offset,
            },
          ],
        }),
      )

    await attributeExpectedFailure(
      { kind: 'behavior', mutation: 'poison-severity-checkpoint' },
      /unexpected checkpoint severities/,
      async () => {
        const actual = [severity(1), severity(2)]
        if (actual[0] !== 1n || actual[1] !== 2n) {
          throw new Error(`unexpected checkpoint severities: ${actual.join(', ')}`)
        }
      },
    )
  })

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
        await expect(run()).rejects.toThrow(/worsened/)
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

  it('owns the exact upper relaunch boundary across all four lifecycle profiles', async () => {
    const observations: unknown[] = []
    const targets = POISON_TARGET_CASES.filter(
      (candidate) => candidate.witness.id === 'counter-bound/run-relaunch-count',
    )

    for (const candidate of targets) {
      observations.push(
        await runPoisonTargetCase(makeLibsqlFixture, candidate).then(
          (result) => ({
            profile: candidate.profile,
            kind: 'resolved',
            result: {
              label: result.label,
              witness: result.witness,
              profile: result.profile,
            },
          }),
          (error: unknown) => ({
            profile: candidate.profile,
            kind: 'rejected',
            error: String(error),
          }),
        ),
      )
    }

    expect(observations, 'mutation-verdict:behavior:poison-targetability-inventory').toEqual([
      {
        profile: 'claim-pending',
        kind: 'resolved',
        result: {
          label: 'claim',
          witness: 'counter-bound/run-relaunch-count',
          profile: 'claim-pending',
        },
      },
      {
        profile: 'claim-sleeping',
        kind: 'resolved',
        result: {
          label: 'claim',
          witness: 'counter-bound/run-relaunch-count',
          profile: 'claim-sleeping',
        },
      },
      {
        profile: 'sweep-lost-launch',
        kind: 'resolved',
        result: {
          label: 'sweep:lost-launch',
          witness: 'counter-bound/run-relaunch-count',
          profile: 'sweep-lost-launch',
        },
      },
      {
        profile: 'sweep-claim-timeout',
        kind: 'resolved',
        result: {
          label: 'sweep:claim-timeout',
          witness: 'counter-bound/run-relaunch-count',
          profile: 'sweep-claim-timeout',
        },
      },
    ])
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

  it('executes every target lifecycle profile from its exact seeded state', async () => {
    const cases = [
      {
        profile: 'claim-pending',
        targetId: 'counter-bound/task-max-attempts/claim-pending',
      },
      {
        profile: 'claim-sleeping',
        targetId: 'counter-bound/task-max-attempts/claim-sleeping',
      },
      {
        profile: 'sweep-lost-launch',
        targetId: 'counter-bound/task-max-attempts/sweep-lost-launch',
      },
      {
        profile: 'sweep-claim-timeout',
        targetId: 'counter-bound/task-max-attempts/sweep-claim-timeout',
      },
    ] as const
    const observations: unknown[] = []

    for (const { profile, targetId } of cases) {
      let seededState: unknown
      const outcome = await runPoisonTargetCase(makeLibsqlFixture, target(targetId), {
        beforeSnapshot: async (raw) => {
          const [tasks, runs] = await raw.batch(
            'oracle-meta',
            [
              {
                sql: `SELECT state FROM tasks WHERE task_id = 'poison-task'`,
                args: [],
              },
              {
                sql: `SELECT state, claimed_by, claim_gen, activated_gen, lease_ms,
                             claim_expires_at_ms, heartbeat_at_ms, available_at_ms
                      FROM runs WHERE run_id = 'poison-run'`,
                args: [],
              },
            ],
            'read',
          )
          seededState = { task: tasks?.rows[0], run: runs?.rows[0] }
        },
      }).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      observations.push({ profile, seededState, outcome })
    }

    expect(observations, 'mutation-verdict:behavior:poison-target-profile-seeding').toEqual([
      {
        profile: 'claim-pending',
        seededState: {
          task: { state: 'pending' },
          run: {
            state: 'pending',
            claimed_by: null,
            claim_gen: 0,
            activated_gen: 0,
            lease_ms: null,
            claim_expires_at_ms: null,
            heartbeat_at_ms: null,
            available_at_ms: 999_998,
          },
        },
        outcome: 'resolved',
      },
      {
        profile: 'claim-sleeping',
        seededState: {
          task: { state: 'sleeping' },
          run: {
            state: 'sleeping',
            claimed_by: null,
            claim_gen: 1,
            activated_gen: 1,
            lease_ms: null,
            claim_expires_at_ms: null,
            heartbeat_at_ms: null,
            available_at_ms: 999_998,
          },
        },
        outcome: 'resolved',
      },
      {
        profile: 'sweep-lost-launch',
        seededState: {
          task: { state: 'running' },
          run: {
            state: 'running',
            claimed_by: 'poison-worker',
            claim_gen: 1,
            activated_gen: 0,
            lease_ms: 60_000,
            claim_expires_at_ms: 999_998,
            heartbeat_at_ms: 940_000,
            available_at_ms: null,
          },
        },
        outcome: 'resolved',
      },
      {
        profile: 'sweep-claim-timeout',
        seededState: {
          task: { state: 'running' },
          run: {
            state: 'running',
            claimed_by: 'poison-worker',
            claim_gen: 1,
            activated_gen: 1,
            lease_ms: 60_000,
            claim_expires_at_ms: 999_998,
            heartbeat_at_ms: 940_000,
            available_at_ms: null,
          },
        },
        outcome: 'resolved',
      },
    ])
  })

  it('requires every exact target lifecycle profile seed at construction', () => {
    const compileOnly = (): void => {
      type ReplaceProfileSeed<
        Profile extends keyof PoisonTargetProfileSeedRecord,
        Field extends keyof PoisonTargetProfileSeedRecord[Profile],
        Value,
      > = Omit<PoisonTargetProfileSeedRecord, Profile> & {
        readonly [Key in Profile]: Omit<PoisonTargetProfileSeedRecord[Profile], Field> & {
          readonly [Changed in Field]: Value
        }
      }

      const claimPendingAsSleeping = {} as ReplaceProfileSeed<'claim-pending', 'state', 'sleeping'>
      // @ts-expect-error claim-pending must remain pending — mutation-verdict:construction:poison-profile-claim-pending
      const claimPending: PoisonTargetProfileSeedRecord = claimPendingAsSleeping

      const claimSleepingAsPending = {} as ReplaceProfileSeed<'claim-sleeping', 'state', 'pending'>
      // @ts-expect-error claim-sleeping must remain sleeping — mutation-verdict:construction:poison-profile-claim-sleeping
      const claimSleeping: PoisonTargetProfileSeedRecord = claimSleepingAsPending

      const lostLaunchAsActivated = {} as ReplaceProfileSeed<'sweep-lost-launch', 'activatedGen', 1>
      // @ts-expect-error lost-launch must remain pre-activation — mutation-verdict:construction:poison-profile-sweep-lost-launch
      const sweepLostLaunch: PoisonTargetProfileSeedRecord = lostLaunchAsActivated

      const claimTimeoutAsUnactivated = {} as ReplaceProfileSeed<
        'sweep-claim-timeout',
        'activatedGen',
        0
      >
      // @ts-expect-error claim-timeout must remain post-activation — mutation-verdict:construction:poison-profile-sweep-claim-timeout
      const sweepClaimTimeout: PoisonTargetProfileSeedRecord = claimTimeoutAsUnactivated

      void [claimPending, claimSleeping, sweepLostLaunch, sweepClaimTimeout]
    }
    expect(compileOnly).toBeTypeOf('function')
  })

  it('requires every exact counter targetability vector at construction', () => {
    const compileOnly = (): void => {
      type Targetable = Readonly<{ kind: 'targetable' }>
      type CounterRelation = Readonly<{
        kind: 'unreachable'
        reason: 'counter-relation-needs-another-invalid-field'
      }>
      type Generation = Readonly<{
        kind: 'unreachable'
        reason: 'generation-classification-needs-another-invalid-field'
      }>
      type TargetableVector = PoisonCounterTargetabilityVector<Targetable, Targetable, Targetable>
      type CounterRelationVector = PoisonCounterTargetabilityVector<
        CounterRelation,
        CounterRelation,
        CounterRelation
      >
      type GenerationGenerationTargetableVector = PoisonCounterTargetabilityVector<
        Generation,
        Generation,
        Targetable
      >
      type ReplaceTargetabilityVector<
        Key extends keyof PoisonCounterTargetabilityRecord,
        Vector,
      > = Omit<PoisonCounterTargetabilityRecord, Key> & {
        readonly [Changed in Key]: Vector
      }

      const taskAttemptsUpperAsTargetable = {} as ReplaceTargetabilityVector<
        'task-attempts/upper',
        TargetableVector
      >
      // @ts-expect-error upper task attempts must remain unreachable — mutation-verdict:construction:poison-targetability-vector-task-attempts-upper
      const taskAttemptsUpper: PoisonCounterTargetabilityRecord = taskAttemptsUpperAsTargetable

      const taskAttemptsLowerAsUnreachable = {} as ReplaceTargetabilityVector<
        'task-attempts/lower',
        CounterRelationVector
      >
      // @ts-expect-error lower task attempts must remain targetable — mutation-verdict:construction:poison-targetability-vector-task-attempts-lower
      const taskAttemptsLower: PoisonCounterTargetabilityRecord = taskAttemptsLowerAsUnreachable

      const taskMaxAttemptsUpperAsUnreachable = {} as ReplaceTargetabilityVector<
        'task-max-attempts/upper',
        CounterRelationVector
      >
      // @ts-expect-error upper task max attempts must remain targetable — mutation-verdict:construction:poison-targetability-vector-task-max-attempts-upper
      const taskMaxAttemptsUpper: PoisonCounterTargetabilityRecord =
        taskMaxAttemptsUpperAsUnreachable

      const taskMaxAttemptsLowerAsTargetable = {} as ReplaceTargetabilityVector<
        'task-max-attempts/lower',
        TargetableVector
      >
      // @ts-expect-error lower task max attempts must remain unreachable — mutation-verdict:construction:poison-targetability-vector-task-max-attempts-lower
      const taskMaxAttemptsLower: PoisonCounterTargetabilityRecord =
        taskMaxAttemptsLowerAsTargetable

      const taskInfraRetriesUpperAsUnreachable = {} as ReplaceTargetabilityVector<
        'task-infra-retries/upper',
        CounterRelationVector
      >
      // @ts-expect-error upper task infra retries must remain targetable — mutation-verdict:construction:poison-targetability-vector-task-infra-retries-upper
      const taskInfraRetriesUpper: PoisonCounterTargetabilityRecord =
        taskInfraRetriesUpperAsUnreachable

      const taskInfraRetriesLowerAsUnreachable = {} as ReplaceTargetabilityVector<
        'task-infra-retries/lower',
        CounterRelationVector
      >
      // @ts-expect-error lower task infra retries must remain targetable — mutation-verdict:construction:poison-targetability-vector-task-infra-retries-lower
      const taskInfraRetriesLower: PoisonCounterTargetabilityRecord =
        taskInfraRetriesLowerAsUnreachable

      const runAttemptUpperAsTargetable = {} as ReplaceTargetabilityVector<
        'run-attempt/upper',
        TargetableVector
      >
      // @ts-expect-error upper run attempt must remain unreachable — mutation-verdict:construction:poison-targetability-vector-run-attempt-upper
      const runAttemptUpper: PoisonCounterTargetabilityRecord = runAttemptUpperAsTargetable

      const runAttemptLowerAsTargetable = {} as ReplaceTargetabilityVector<
        'run-attempt/lower',
        TargetableVector
      >
      // @ts-expect-error lower run attempt must remain unreachable — mutation-verdict:construction:poison-targetability-vector-run-attempt-lower
      const runAttemptLower: PoisonCounterTargetabilityRecord = runAttemptLowerAsTargetable

      const runClaimGenUpperAsGenerationGenerationTargetable = {} as ReplaceTargetabilityVector<
        'run-claim-gen/upper',
        GenerationGenerationTargetableVector
      >
      // @ts-expect-error upper claim generation must remain targetable/targetable/unreachable — mutation-verdict:construction:poison-targetability-vector-run-claim-gen-upper
      const runClaimGenUpper: PoisonCounterTargetabilityRecord =
        runClaimGenUpperAsGenerationGenerationTargetable

      const runClaimGenLowerAsTargetable = {} as ReplaceTargetabilityVector<
        'run-claim-gen/lower',
        TargetableVector
      >
      // @ts-expect-error lower claim generation must remain unreachable — mutation-verdict:construction:poison-targetability-vector-run-claim-gen-lower
      const runClaimGenLower: PoisonCounterTargetabilityRecord = runClaimGenLowerAsTargetable

      const runActivatedGenUpperAsTargetable = {} as ReplaceTargetabilityVector<
        'run-activated-gen/upper',
        TargetableVector
      >
      // @ts-expect-error upper activated generation must remain unreachable — mutation-verdict:construction:poison-targetability-vector-run-activated-gen-upper
      const runActivatedGenUpper: PoisonCounterTargetabilityRecord =
        runActivatedGenUpperAsTargetable

      const runActivatedGenLowerAsGenerationGenerationTargetable = {} as ReplaceTargetabilityVector<
        'run-activated-gen/lower',
        GenerationGenerationTargetableVector
      >
      // @ts-expect-error lower activated generation must remain targetable/targetable/unreachable — mutation-verdict:construction:poison-targetability-vector-run-activated-gen-lower
      const runActivatedGenLower: PoisonCounterTargetabilityRecord =
        runActivatedGenLowerAsGenerationGenerationTargetable

      const runRelaunchCountUpperAsUnreachable = {} as ReplaceTargetabilityVector<
        'run-relaunch-count/upper',
        CounterRelationVector
      >
      // @ts-expect-error upper relaunch count must remain targetable — mutation-verdict:construction:poison-targetability-vector-run-relaunch-count-upper
      const runRelaunchCountUpper: PoisonCounterTargetabilityRecord =
        runRelaunchCountUpperAsUnreachable

      const runRelaunchCountLowerAsUnreachable = {} as ReplaceTargetabilityVector<
        'run-relaunch-count/lower',
        CounterRelationVector
      >
      // @ts-expect-error lower relaunch count must remain targetable — mutation-verdict:construction:poison-targetability-vector-run-relaunch-count-lower
      const runRelaunchCountLower: PoisonCounterTargetabilityRecord =
        runRelaunchCountLowerAsUnreachable

      const checkpointOwnerAttemptUpperAsTargetable = {} as ReplaceTargetabilityVector<
        'checkpoint-owner-attempt/upper',
        TargetableVector
      >
      // @ts-expect-error upper checkpoint owner attempt must remain unread — mutation-verdict:construction:poison-targetability-vector-checkpoint-owner-attempt-upper
      const checkpointOwnerAttemptUpper: PoisonCounterTargetabilityRecord =
        checkpointOwnerAttemptUpperAsTargetable

      const checkpointOwnerAttemptLowerAsTargetable = {} as ReplaceTargetabilityVector<
        'checkpoint-owner-attempt/lower',
        TargetableVector
      >
      // @ts-expect-error lower checkpoint owner attempt must remain unread — mutation-verdict:construction:poison-targetability-vector-checkpoint-owner-attempt-lower
      const checkpointOwnerAttemptLower: PoisonCounterTargetabilityRecord =
        checkpointOwnerAttemptLowerAsTargetable

      void [
        taskAttemptsUpper,
        taskAttemptsLower,
        taskMaxAttemptsUpper,
        taskMaxAttemptsLower,
        taskInfraRetriesUpper,
        taskInfraRetriesLower,
        runAttemptUpper,
        runAttemptLower,
        runClaimGenUpper,
        runClaimGenLower,
        runActivatedGenUpper,
        runActivatedGenLower,
        runRelaunchCountUpper,
        runRelaunchCountLower,
        checkpointOwnerAttemptUpper,
        checkpointOwnerAttemptLower,
      ]
    }
    expect(compileOnly).toBeTypeOf('function')
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
