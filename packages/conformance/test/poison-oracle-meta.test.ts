import {
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
  type PersistedCounterFieldDescriptor,
  type PersistedTemporalFieldDescriptor,
  type SqlExecutor,
} from '@durablerun/core'
import { attributeReplacedFailure, requireExpectedFailure } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import { executeStorageCorruption } from '../src/fixture.js'
import { type EngineInvariantFinding, engineInvariantFindings } from '../src/invariants.js'
import {
  POISON_RELATIONAL_TARGETS,
  POISON_TARGET_CASES,
  POISON_TARGET_PROFILE_SEEDS,
  POISON_UNREACHABLE_TARGETS,
  POISON_WITNESSES,
  type PoisonCounterTargetabilityRecord,
  type PoisonCounterTargetabilityVector,
  type PoisonInvocationOutcome,
  type PoisonRelationalTargetRecord,
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
      await f.close()
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
      await f.close()
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
      await f.close()
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

  it('rejects a healthy call that commits and then rejects with undefined', async () => {
    let outcomes: readonly PoisonInvocationOutcome[] = []
    await requireExpectedFailure(
      { kind: 'behavior', mutation: 'poison-healthy-settlement' },
      /healthy trigger did not win: invocation rejected/,
      () =>
        runPoisonMatrixCase(
          async (seed) => {
            const f = await makeLibsqlFixture(seed)
            let calls = 0
            return {
              ...f,
              storeOver: (db, buggify) => {
                const store = f.storeOver(db, buggify)
                return new Proxy(store, {
                  get(target, property, receiver) {
                    if (property !== 'driverHeartbeat') {
                      return Reflect.get(target, property, receiver)
                    }
                    return async (...args: Parameters<typeof target.driverHeartbeat>) => {
                      await target.driverHeartbeat(...args)
                      calls += 1
                      if (calls === 2) return Promise.reject(undefined)
                    }
                  },
                })
              },
            }
          },
          'driver-heartbeat',
          witness('terminal-task/live-running-run'),
          {
            afterOutcomes: (recorded) => {
              outcomes = [...recorded]
            },
          },
        ),
    )
    expect(outcomes).toEqual([
      { target: 'poison', status: 'fulfilled', result: undefined },
      { target: 'healthy', status: 'rejected', reason: undefined },
    ])
    expect(outcomes.every((outcome) => Object.isFrozen(outcome))).toBe(true)
  })

  it('rejects a targeted call that commits healthy progress and then rejects with undefined', async () => {
    let outcomes: readonly PoisonInvocationOutcome[] = []
    await attributeReplacedFailure(
      { kind: 'behavior', mutation: 'poison-targeted-settlement-owner' },
      {
        expectedError: /healthy trigger did not win: invocation rejected/,
        replacementError: /healthy trigger did not win: due trigger run was not claimed/,
      },
      () =>
        runPoisonTargetCase(
          async (seed) => {
            const f = await makeLibsqlFixture(seed)
            return {
              ...f,
              storeOver: (db, buggify) => {
                const store = f.storeOver(db, buggify)
                return new Proxy(store, {
                  get(storeTarget, property, receiver) {
                    if (property !== 'claim') {
                      return Reflect.get(storeTarget, property, receiver)
                    }
                    return async (...args: Parameters<typeof storeTarget.claim>) => {
                      await storeTarget.claim(...args)
                      return Promise.reject(undefined)
                    }
                  },
                })
              },
            }
          },
          target('attempts/at-max-with-live-run/claim-pending'),
          {
            afterOutcomes: (recorded) => {
              outcomes = [...recorded]
            },
          },
        ),
    )
    expect(outcomes).toEqual([{ target: 'poison', status: 'rejected', reason: undefined }])
    expect(outcomes.every((outcome) => Object.isFrozen(outcome))).toBe(true)
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

  it('owns lower-bound and checkpoint severity across every persisted integer field', async () => {
    const normalizeSeverity = (probe: () => readonly bigint[]) => {
      try {
        return { kind: 'values' as const, values: probe() }
      } catch (error) {
        return { kind: 'error' as const, error: String(error) }
      }
    }
    type NormalizedSeverity = ReturnType<typeof normalizeSeverity>
    const hasSeverityValues = (
      severity: NormalizedSeverity,
      expected: readonly bigint[],
    ): boolean =>
      severity.kind === 'values' &&
      severity.values.length === expected.length &&
      severity.values.every((value, index) => value === expected[index])
    const sameSeverity = (left: NormalizedSeverity, right: NormalizedSeverity): boolean => {
      if (left.kind === 'error') return right.kind === 'error' && left.error === right.error
      return right.kind === 'values' && hasSeverityValues(left, right.values)
    }
    const normalizePoisonCase = async (run: () => ReturnType<typeof runPoisonMatrixCase>) => {
      try {
        const result = await run()
        return {
          kind: 'resolved' as const,
          result: {
            label: result.label,
            witness: result.witness,
            corruptionDisposition: result.corruptionDisposition,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const detailStart = message.indexOf(': ')
        return {
          kind: 'rejected' as const,
          error: detailStart === -1 ? message : message.slice(detailStart + 2),
        }
      }
    }
    type NormalizedPoisonCase = Awaited<ReturnType<typeof normalizePoisonCase>>
    const persistedSubject = (
      table: PersistedCounterFieldDescriptor['table'] | PersistedTemporalFieldDescriptor['table'],
    ): string => {
      switch (table) {
        case 'tasks':
          return 'tasks/poison-task'
        case 'runs':
          return 'runs/poison-run'
        case 'checkpoints':
          return 'checkpoints/poison-task/poison-checkpoint'
        case 'events':
          return 'events/q/protected-fired-event'
        case 'waits':
          return 'waits/protected-run/$await:protected'
        case 'drivers':
          return 'drivers/q/protected-driver'
      }
    }
    const worseningError = (conditionId: string, subject: string): string =>
      `${conditionId} on ${subject} worsened from 1 to 2`
    const counterLowerError = (field: PersistedCounterFieldDescriptor): string => {
      const primary = worseningError(`counter-bound/${field.id}`, persistedSubject(field.table))
      switch (field.id) {
        case 'task-attempts':
          return `${primary}; generation/negative-attempts on poison-task worsened from 1 to 2`
        case 'task-infra-retries':
          return `${primary}; generation/negative-infra-retries on poison-task worsened from 1 to 2`
        case 'run-attempt':
          return `write escaped authority: runs/poison-run changed relationship attempt; ${primary}`
        case 'run-claim-gen':
          return `${primary}; generation/negative-claim on poison-run worsened from 1 to 2`
        case 'run-relaunch-count':
          return `${primary}; generation/negative-relaunch on poison-run worsened from 1 to 2`
        default:
          return primary
      }
    }
    const temporalLowerError = (field: PersistedTemporalFieldDescriptor): string => {
      const primary = worseningError(`temporal-bound/${field.id}`, persistedSubject(field.table))
      switch (field.table) {
        case 'events':
          return `write escaped authority: events/["q","protected-fired-event"] was outside frozen pre-state authority; ${primary}`
        case 'waits':
          return `write escaped authority: waits/["protected-run","$await:protected"] was outside frozen pre-state authority; ${primary}`
        case 'drivers':
          return `write escaped authority: drivers/["q","protected-driver"] was outside frozen pre-state authority; ${primary}`
        default:
          return primary
      }
    }

    const directLowerField = PERSISTED_COUNTER_FIELDS.find(
      (candidate) => candidate.id === 'task-max-attempts',
    )
    if (!directLowerField) throw new Error('missing task-max-attempts field')
    const directLowerFinding: EngineInvariantFinding = {
      conditionId: 'counter-bound/task-max-attempts',
      name: 'counter-out-of-range',
      subject: 'tasks/poison-task',
      subjectIdentity: ['tasks', 'poison-task'],
      message: 'counter-out-of-range: tasks/poison-task',
    }
    const lowerDirect = normalizeSeverity(() =>
      [1, 2].map((offset) =>
        findingSeverity(
          directLowerFinding,
          protocolSnapshot({
            tasks: [
              {
                task_id: 'poison-task',
                max_attempts: directLowerField.bounds.min - offset,
              },
            ],
          }),
        ),
      ),
    )

    const lowerWorsening: unknown[] = []
    for (const field of PERSISTED_COUNTER_FIELDS) {
      if (field.table === 'checkpoints') continue
      lowerWorsening.push({
        field: `counter/${field.id}`,
        outcome: await normalizePoisonCase(() =>
          runPoisonMatrixCase(
            makeLibsqlFixture,
            'driver-heartbeat',
            witness(`counter-bound-lower/${field.id}`),
            {
              afterInvoke: (raw) =>
                write(raw, [
                  {
                    sql: `UPDATE ${field.table}
                          SET ${field.column} = ${field.column} - 1
                          WHERE ${fieldPredicate(field)}`,
                    args: [],
                  },
                ]),
            },
          ),
        ),
      })
    }
    for (const field of PERSISTED_TEMPORAL_FIELDS) {
      lowerWorsening.push({
        field: `temporal/${field.id}`,
        outcome: await normalizePoisonCase(() =>
          runPoisonMatrixCase(
            makeLibsqlFixture,
            'emit-event',
            witness(`temporal-bound-lower/${field.id}`),
            {
              afterInvoke: (raw) =>
                write(raw, [
                  {
                    sql: `UPDATE ${field.table}
                          SET ${field.column} = ${field.column} - 1
                          WHERE ${temporalFieldPredicate(field)}`,
                    args: [],
                  },
                ]),
            },
          ),
        ),
      })
    }

    const checkpointField = PERSISTED_COUNTER_FIELDS.find(
      (candidate) => candidate.id === 'checkpoint-owner-attempt',
    )
    if (!checkpointField) throw new Error('missing checkpoint-owner-attempt field')
    const checkpointFinding: EngineInvariantFinding = {
      conditionId: 'counter-bound/checkpoint-owner-attempt',
      name: 'counter-out-of-range',
      subject: 'checkpoints/poison-task/poison-checkpoint',
      subjectIdentity: ['checkpoints', 'poison-task', 'poison-checkpoint'],
      message: 'counter-out-of-range: checkpoints/poison-task/poison-checkpoint',
    }
    const checkpointUpperDirect = normalizeSeverity(() =>
      [1, 2].map((offset) =>
        findingSeverity(
          checkpointFinding,
          protocolSnapshot({
            checkpoints: [
              {
                task_id: 'poison-task',
                checkpoint_name: 'poison-checkpoint',
                owner_attempt: checkpointField.bounds.max + offset,
              },
            ],
          }),
        ),
      ),
    )
    const checkpointLowerDirect = normalizeSeverity(() =>
      [1, 2].map((offset) =>
        findingSeverity(
          checkpointFinding,
          protocolSnapshot({
            checkpoints: [
              {
                task_id: 'poison-task',
                checkpoint_name: 'poison-checkpoint',
                owner_attempt: checkpointField.bounds.min - offset,
              },
            ],
          }),
        ),
      ),
    )
    const checkpointWorsening: Array<{
      side: 'upper' | 'lower'
      outcome: NormalizedPoisonCase
    }> = []
    const checkpointWorseningError = `write escaped authority: checkpoints/["poison-task","poison-checkpoint"] changed relationship owner_attempt; ${worseningError(
      'counter-bound/checkpoint-owner-attempt',
      'checkpoints/poison-task/poison-checkpoint',
    )}`
    for (const side of ['upper', 'lower'] as const) {
      checkpointWorsening.push({
        side,
        outcome: await normalizePoisonCase(() =>
          runPoisonMatrixCase(
            makeLibsqlFixture,
            'driver-heartbeat',
            witness(
              side === 'upper'
                ? `counter-bound/${checkpointField.id}`
                : `counter-bound-lower/${checkpointField.id}`,
            ),
            {
              afterInvoke: (raw) =>
                write(raw, [
                  {
                    sql: `UPDATE ${checkpointField.table}
                          SET ${checkpointField.column} = ${checkpointField.column} ${side === 'upper' ? '+' : '-'} 1
                          WHERE ${fieldPredicate(checkpointField)}`,
                    args: [],
                  },
                ]),
            },
          ),
        ),
      })
    }
    const checkpointUpperWorsening = checkpointWorsening.find(
      (observation) => observation.side === 'upper',
    )
    const checkpointLowerWorsening = checkpointWorsening.find(
      (observation) => observation.side === 'lower',
    )
    const checkpointCounterWorsening = worseningError(
      'counter-bound/checkpoint-owner-attempt',
      'checkpoints/poison-task/poison-checkpoint',
    )
    const checkpointLowerHasCounterWorsening =
      checkpointLowerWorsening?.outcome.kind === 'rejected' &&
      checkpointLowerWorsening.outcome.error
        .split('; ')
        .some((component) => component === checkpointCounterWorsening)
    const checkpointLowerRetainsAuthorityFailure =
      checkpointLowerWorsening?.outcome.kind === 'rejected' &&
      checkpointLowerWorsening.outcome.error.startsWith(
        'write escaped authority: checkpoints/["poison-task","poison-checkpoint"] changed relationship owner_attempt',
      )
    const lowerDirectIsExact = hasSeverityValues(lowerDirect, [1n, 2n])

    expect(
      { direct: lowerDirect, worsening: lowerWorsening },
      'mutation-verdict:behavior:poison-severity-lower-bound',
    ).toEqual({
      direct: { kind: 'values', values: [1n, 2n] },
      worsening: [
        ...PERSISTED_COUNTER_FIELDS.filter((field) => field.table !== 'checkpoints').map(
          (field) => ({
            field: `counter/${field.id}`,
            outcome: {
              kind: 'rejected',
              error: counterLowerError(field),
            },
          }),
        ),
        ...PERSISTED_TEMPORAL_FIELDS.map((field) => ({
          field: `temporal/${field.id}`,
          outcome: {
            kind: 'rejected',
            error: temporalLowerError(field),
          },
        })),
      ],
    })
    expect(
      {
        upperDirect: checkpointUpperDirect,
        lowerDirectMatchesCommon: sameSeverity(checkpointLowerDirect, lowerDirect),
        upperWorsening: checkpointUpperWorsening,
        lowerWorsening: {
          side: checkpointLowerWorsening?.side,
          counterComponentTracksCommon: checkpointLowerHasCounterWorsening === lowerDirectIsExact,
          retainsAuthorityFailure: checkpointLowerRetainsAuthorityFailure,
        },
      },
      'mutation-verdict:behavior:poison-severity-checkpoint',
    ).toEqual({
      upperDirect: { kind: 'values', values: [1n, 2n] },
      lowerDirectMatchesCommon: true,
      upperWorsening: {
        side: 'upper',
        outcome: {
          kind: 'rejected',
          error: checkpointWorseningError,
        },
      },
      lowerWorsening: {
        side: 'lower',
        counterComponentTracksCommon: true,
        retainsAuthorityFailure: true,
      },
    })
  })

  for (const field of PERSISTED_COUNTER_FIELDS.filter(
    (candidate) => candidate.table !== 'checkpoints',
  )) {
    it(`catches upper ${field.id} worsening on the same subject`, async () => {
      const run = () =>
        runPoisonMatrixCase(
          makeLibsqlFixture,
          'driver-heartbeat',
          witness(`counter-bound/${field.id}`),
          {
            afterInvoke: (raw) =>
              write(raw, [
                {
                  sql: `UPDATE ${field.table}
                        SET ${field.column} = ${field.column} + 1
                        WHERE ${fieldPredicate(field)}`,
                  args: [],
                },
              ]),
          },
        )
      await expect(run()).rejects.toThrow(/worsened/)
    })
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

  for (const field of PERSISTED_TEMPORAL_FIELDS) {
    it(`catches upper ${field.id} temporal-bound worsening on the same subject`, async () => {
      await expect(
        runPoisonMatrixCase(
          makeLibsqlFixture,
          'emit-event',
          witness(`temporal-bound/${field.id}`),
          {
            afterInvoke: (raw) =>
              write(raw, [
                {
                  sql: `UPDATE ${field.table}
                        SET ${field.column} = ${field.column} + 1
                        WHERE ${temporalFieldPredicate(field)}`,
                  args: [],
                },
              ]),
          },
        ),
      ).rejects.toThrow(/worsened/)
    })
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
    ).toHaveLength(PERSISTED_COUNTER_FIELDS.length * 2 * 5)
    expect(
      POISON_TARGET_CASES,
      'mutation-verdict:behavior:poison-targetability-inventory',
    ).toHaveLength(74)
    expect(POISON_UNREACHABLE_TARGETS).toHaveLength(44)
  })

  it('pins every unreachable counter target and its reason', () => {
    expect(POISON_UNREACHABLE_TARGETS.map((target) => `${target.id}=${target.reason}`)).toEqual([
      'counter-bound/task-attempts/claim=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/activate=counter-relation-needs-another-invalid-field',
      'counter-bound/task-attempts/defer-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/claim=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/activate=counter-relation-needs-another-invalid-field',
      'counter-bound/run-attempt/defer-launch=counter-relation-needs-another-invalid-field',
      'counter-bound/run-claim-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound/run-claim-gen/activate=receipt-cannot-name-the-generation',
      'counter-bound/run-claim-gen/defer-launch=receipt-cannot-name-the-generation',
      'counter-bound/run-activated-gen/claim=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/sweep:lost-launch=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/activate=generation-classification-needs-another-invalid-field',
      'counter-bound/run-activated-gen/defer-launch=generation-classification-needs-another-invalid-field',
      'counter-bound/checkpoint-owner-attempt/claim=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/sweep:lost-launch=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/sweep:claim-timeout=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/activate=transition-does-not-read-field',
      'counter-bound/checkpoint-owner-attempt/defer-launch=transition-does-not-read-field',
      'counter-bound-lower/task-max-attempts/claim=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/activate=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/task-max-attempts/defer-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/claim=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/sweep:lost-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/sweep:claim-timeout=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/activate=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-attempt/defer-launch=counter-relation-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/claim=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/sweep:lost-launch=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/run-claim-gen/activate=receipt-cannot-name-the-generation',
      'counter-bound-lower/run-claim-gen/defer-launch=receipt-cannot-name-the-generation',
      'counter-bound-lower/run-activated-gen/sweep:claim-timeout=generation-classification-needs-another-invalid-field',
      'counter-bound-lower/checkpoint-owner-attempt/claim=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/sweep:lost-launch=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/sweep:claim-timeout=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/activate=transition-does-not-read-field',
      'counter-bound-lower/checkpoint-owner-attempt/defer-launch=transition-does-not-read-field',
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
      new Set([
        'claim-pending',
        'claim-sleeping',
        'sweep-lost-launch',
        'sweep-claim-timeout',
        'activate-unactivated',
        'defer-launch-unactivated',
      ]),
    )
  })

  it('enrolls every relational and fractional target in every lifecycle profile', () => {
    const witnessIds = Object.keys(POISON_RELATIONAL_TARGETS)
    const profileIds = Object.keys(POISON_TARGET_PROFILE_SEEDS)
    const relationalWitnessIds = new Set(witnessIds)
    const actual = POISON_TARGET_CASES.filter(({ witness }) =>
      relationalWitnessIds.has(witness.id),
    ).map(({ id }) => id)
    const expected = witnessIds.flatMap((witnessId) =>
      profileIds.map((profileId) => `${witnessId}/${profileId}`),
    )

    expect(actual, 'mutation-verdict:behavior:poison-relational-target-inventory').toEqual(expected)
  })

  it('requires every relational and fractional target at construction', () => {
    const compileOnly = (): void => {
      const withoutAttemptsAtMax = {} as Omit<
        PoisonRelationalTargetRecord,
        'attempts/at-max-with-live-run'
      >
      // @ts-expect-error attempts-at-max target is required — mutation-verdict:construction:poison-relational-target-attempts-at-max-with-live-run
      const attemptsAtMax: PoisonRelationalTargetRecord = withoutAttemptsAtMax

      const withoutAccountingBelowTop = {} as Omit<
        PoisonRelationalTargetRecord,
        'accounting/below-top-minus-one'
      >
      // @ts-expect-error accounting-below-top target is required — mutation-verdict:construction:poison-relational-target-accounting-below-top-minus-one
      const accountingBelowTop: PoisonRelationalTargetRecord = withoutAccountingBelowTop

      const withoutAccountingLiveRun = {} as Omit<
        PoisonRelationalTargetRecord,
        'accounting/live-run-not-next'
      >
      // @ts-expect-error accounting-live-run target is required — mutation-verdict:construction:poison-relational-target-accounting-live-run-not-next
      const accountingLiveRun: PoisonRelationalTargetRecord = withoutAccountingLiveRun

      const withoutFractionalTaskMaxAttempts = {} as Omit<
        PoisonRelationalTargetRecord,
        'counter-fractional/task-max-attempts'
      >
      // @ts-expect-error fractional task-max-attempts target is required — mutation-verdict:construction:poison-relational-target-counter-fractional-task-max-attempts
      const fractionalTaskMaxAttempts: PoisonRelationalTargetRecord =
        withoutFractionalTaskMaxAttempts

      const withoutFractionalRunRelaunchCount = {} as Omit<
        PoisonRelationalTargetRecord,
        'counter-fractional/run-relaunch-count'
      >
      // @ts-expect-error fractional run-relaunch-count target is required — mutation-verdict:construction:poison-relational-target-counter-fractional-run-relaunch-count
      const fractionalRunRelaunchCount: PoisonRelationalTargetRecord =
        withoutFractionalRunRelaunchCount

      void [
        attemptsAtMax,
        accountingBelowTop,
        accountingLiveRun,
        fractionalTaskMaxAttempts,
        fractionalRunRelaunchCount,
      ]
    }
    expect(compileOnly).toBeTypeOf('function')
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

  it('rejects a receipt target whose claim was already activated', async () => {
    await expect(
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/activate-unactivated'),
        {
          beforeSnapshot: (raw) =>
            write(raw, [
              {
                sql: `UPDATE runs SET activated_gen = claim_gen WHERE run_id = 'poison-run'`,
                args: [],
              },
            ]),
        },
      ),
    ).rejects.toThrow(/claim is not the unactivated one its receipt names/)
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
      {
        profile: 'activate-unactivated',
        targetId: 'counter-bound/task-max-attempts/activate-unactivated',
      },
      {
        profile: 'defer-launch-unactivated',
        targetId: 'counter-bound/task-max-attempts/defer-launch-unactivated',
      },
    ] as const
    const observations: unknown[] = []

    for (const { profile, targetId } of cases) {
      const candidate = target(targetId)
      let seededState: unknown
      const outcome = await runPoisonMatrixCase(
        makeLibsqlFixture,
        'driver-heartbeat',
        candidate.witness,
        {
          targetProfile: candidate.profile,
          targetCompanions: candidate.companions,
          healthyTrigger: false,
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
        },
      ).then(
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
      {
        profile: 'activate-unactivated',
        seededState: {
          task: { state: 'running' },
          run: {
            state: 'running',
            claimed_by: 'poison-worker',
            claim_gen: 1,
            activated_gen: 0,
            lease_ms: 60_000,
            claim_expires_at_ms: 1_060_000,
            heartbeat_at_ms: 1_000_000,
            available_at_ms: null,
          },
        },
        outcome: 'resolved',
      },
      {
        profile: 'defer-launch-unactivated',
        seededState: {
          task: { state: 'running' },
          run: {
            state: 'running',
            claimed_by: 'poison-worker',
            claim_gen: 1,
            activated_gen: 0,
            lease_ms: 60_000,
            claim_expires_at_ms: 1_060_000,
            heartbeat_at_ms: 1_000_000,
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

  it('rejects every targeted rewrite of the poison-owned closure', async () => {
    const closureChange = 'targeted poison-owned closure changed'
    const capture = async (run: () => ReturnType<typeof runPoisonTargetCase>) => {
      try {
        await run()
        return { kind: 'resolved' as const }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          kind: 'rejected' as const,
          reason: message.includes(closureChange) ? closureChange : message,
        }
      }
    }

    const heartbeatRewrite = await capture(() =>
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
    const launderingSuccessor = await capture(() =>
      runPoisonTargetCase(
        makeLibsqlFixture,
        target('counter-bound/task-max-attempts/claim-pending'),
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
    )

    expect(
      { heartbeatRewrite, launderingSuccessor },
      'mutation-verdict:behavior:poison-target-closure-comparison',
    ).toEqual({
      heartbeatRewrite: { kind: 'rejected', reason: closureChange },
      launderingSuccessor: { kind: 'rejected', reason: closureChange },
    })
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
              outcomes.push(
                Object.freeze({
                  target: 'poison',
                  status: 'fulfilled',
                  result: [{ taskId: 'poison-task', runId: 'poison-run' }],
                }),
              )
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
