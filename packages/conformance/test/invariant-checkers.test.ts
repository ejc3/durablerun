import {
  IDENTIFIER_CHARACTERS,
  INFRA_RETRY_CAP,
  MAX_COUNT,
  MAX_EPOCH_MS,
  MAX_RUN_ORDINAL,
  RELAUNCH_CAP,
  type SqlExecutor,
  type SqlResult,
} from '@durablerun/core'
import { MIGRATIONS as MYSQL_MIGRATIONS } from '@durablerun/store-mysql'
import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../src/fuzz.js'
import {
  IDENTIFIER_COLUMNS,
  bindInvariantSnapshotRows,
  engineInvariantFindings,
  engineInvariantViolations,
} from '../src/invariants.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

/**
 * Every column a migration list types as VARCHAR, and its width. MySQL is the one dialect
 * whose schema bounds a durable identifier, so its migrations say which columns hold one.
 * Any `name VARCHAR(n)` in a CREATE TABLE or an ALTER TABLE is read, however it is laid out,
 * so a column cannot be missed, and text that is read and is no column fails the pin loudly.
 */
function boundedColumns(
  migrations: readonly { readonly statements: readonly string[] }[],
): { table: string; column: string; width: number }[] {
  return migrations
    .flatMap((migration) => migration.statements)
    .flatMap((sql) => {
      const table = /^\s*(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?(\w+)`?/i.exec(
        sql,
      )?.[1]
      if (table === undefined) return []
      return [...sql.matchAll(/`?(\w+)`?\s+VARCHAR\((\d+)\)/gi)].map((match) => ({
        table,
        column: String(match[1]),
        width: Number(match[2]),
      }))
    })
}

/**
 * Checkers must be checked: every invariant added to the library gets a
 * constructed corrupt state here proving the checker actually fires — a
 * checker nobody has seen fail is one grep-typo away from vacuous-green.
 * (These states are built with raw SQL because the store's fences exist
 * precisely to make them unreachable through the API.)
 */
describe('invariant checkers fire on constructed corruption', () => {
  const Q = 'q'
  const NOW = 1_000_000

  async function seeded(name: string) {
    const f = await makeLibsqlFixture(`checker-${name}`)
    // A minimal consistent world: one pending task with its one pending run.
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                  max_attempts, state, enqueue_at_ms, created_at_ms)
                VALUES ('t1', ?, 'noop', '{}', '{}', 3, 'sleeping', ?, ?)`,
          args: [Q, NOW, NOW],
        },
        {
          sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, created_at_ms)
                VALUES ('r1', ?, 't1', 1, 'sleeping', ?)`,
          args: [Q, NOW],
        },
      ],
      'write',
    )
    return f
  }

  it('flags a run whose owning task is missing', async () => {
    const f = await seeded('run-owner-missing')
    await f.raw.batch('corrupt', [
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, created_at_ms)
              VALUES ('orphan', ?, 'missing-task', 1, 'completed', ?)`,
        args: [Q, NOW],
      },
    ])

    expect(await engineInvariantViolations(f.raw)).toContain('run-owner-missing: orphan')
    await f.close()
  })

  it("flags a run whose queue disagrees with its owning task's queue", async () => {
    const f = await seeded('run-task-queue-mismatch')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE runs SET queue = 'other-q' WHERE run_id = 'r1'`,
        args: [],
      },
    ])

    expect(await engineInvariantViolations(f.raw)).toContain('run-task-queue-mismatch: r1')
    await f.close()
  })

  it('flags a wait row whose run belongs to a different task or queue', async () => {
    const f = await seeded('wait-cross-task')
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
                VALUES ('r1', '$await:go', ?, 'SOMEONE-ELSE', 'go', ?)`,
          args: [Q, NOW],
        },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wait-cross-task:'))).toBe(true)
    await f.close()
  })

  it('flags a waiting wait row on a run that is not sleeping (a wait implies a parked run)', async () => {
    // Codex PR#11 finding 6: WaitIntegrity requires a waiting wait to sit on
    // a SLEEPING run; an orphan wait on a running run (finding 2's corruption)
    // must be detectable, not invariant-clean.
    const f = await seeded('wait-on-running')
    await f.raw.batch(
      'setup',
      [
        { sql: `UPDATE runs SET state = 'running' WHERE run_id = 'r1'`, args: [] },
        { sql: `UPDATE tasks SET state = 'running' WHERE task_id = 't1'`, args: [] },
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
                VALUES ('r1', '$await:go', ?, 't1', 'go', ?)`,
          args: [Q, NOW],
        },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wait-on-non-sleeping-run:'))).toBe(true)
    await f.close()
  })

  it('flags a parked run whose carried wake name disagrees with its wait row', async () => {
    // Codex PR#11 finding 6: a run parked on await('go') must carry
    // wake_event='go'; a mismatch means the park and the wait disagree.
    const f = await seeded('wait-wake-mismatch')
    await f.raw.batch(
      'setup',
      [
        { sql: `UPDATE runs SET wake_event = 'other' WHERE run_id = 'r1'`, args: [] },
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
                VALUES ('r1', '$await:go', ?, 't1', 'go', ?)`,
          args: [Q, NOW],
        },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wait-wake-name-mismatch:'))).toBe(true)
    await f.close()
  })

  it("flags a timed wait whose deadline disagrees with its run's wake time", async () => {
    // Codex re-review finding 2: timeout_at_ms and available_at_ms are one
    // value; a mismatch (two independent NOW reads) would schedule the
    // timeout after its registered deadline.
    const f = await seeded('wait-timeout-drift')
    await f.raw.batch(
      'setup',
      [
        {
          sql: `UPDATE runs SET wake_event = 'go', available_at_ms = ? WHERE run_id = 'r1'`,
          args: [NOW + 30_000],
        },
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, timeout_at_ms, created_at_ms)
                VALUES ('r1', '$await:go', ?, 't1', 'go', ?, ?)`,
          args: [Q, NOW + 30_001, NOW], // 1ms off from available_at_ms
        },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wait-timeout-availability-mismatch:'))).toBe(true)
    await f.close()
  })

  it('flags a waiting wait row for an event that has already fired (a lost wakeup)', async () => {
    const f = await seeded('wait-fired-event')
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
                VALUES ('r1', '$await:go', ?, 't1', 'go', ?)`,
          args: [Q, NOW],
        },
        {
          sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                VALUES (?, 'go', '{"x":1}', ?)`,
          args: [Q, NOW],
        },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wait-for-fired-event:'))).toBe(true)
    await f.close()
  })

  it('flags a delivered wake payload that disagrees with the stored event', async () => {
    const f = await seeded('wake-payload-mismatch')
    await f.raw.batch(
      'setup',
      [
        {
          sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                VALUES (?, 'go', '{"x":1}', ?)`,
          args: [Q, NOW],
        },
        {
          sql: `UPDATE runs SET state = 'pending', wake_event = 'go',
                  event_payload = '{"x":2}', available_at_ms = ?
                WHERE run_id = 'r1'`,
          args: [NOW],
        },
        { sql: `UPDATE tasks SET state = 'pending' WHERE task_id = 't1'`, args: [] },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wake-payload-mismatch:'))).toBe(true)
    await f.close()
  })

  it('flags a wake payload carried for an event that does not exist', async () => {
    const f = await seeded('wake-payload-no-event')
    await f.raw.batch(
      'setup',
      [
        {
          sql: `UPDATE runs SET state = 'pending', wake_event = 'ghost',
                  event_payload = '{"x":1}', available_at_ms = ?
                WHERE run_id = 'r1'`,
          args: [NOW],
        },
        { sql: `UPDATE tasks SET state = 'pending' WHERE task_id = 't1'`, args: [] },
      ],
      'write',
    )
    const violations = await engineInvariantViolations(f.raw)
    expect(violations.some((v) => v.startsWith('wake-payload-mismatch:'))).toBe(true)
    await f.close()
  })

  it('flags attempt accounting above the run-derived band', async () => {
    const f = await seeded('attempt-accounting-above')
    await f.raw.batch('corrupt', [
      { sql: `UPDATE tasks SET attempts = 2 WHERE task_id = 't1'`, args: [] },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('attempt-accounting-drift: t1')
    await f.close()
  })

  it('flags attempt accounting below the run-derived band', async () => {
    const f = await seeded('attempt-accounting-below')
    await f.raw.batch('corrupt', [
      { sql: `UPDATE runs SET attempt = 3 WHERE run_id = 'r1'`, args: [] },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('attempt-accounting-drift: t1')
    await f.close()
  })

  it('flags a failed task whose charge exceeds its budget', async () => {
    const f = await seeded('failed-charge-past-budget')
    // Accounting sits in its band (3 attempts, top run 4), but the uncharged top run
    // would charge 4 attempts against a budget of 3: TLA FailedChargeWithinBudget.
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks SET state = 'failed', failure_reason = '{"name":"Boom"}',
                attempts = max_attempts WHERE task_id = 't1'`,
        args: [],
      },
      { sql: `UPDATE runs SET state = 'failed', attempt = 4 WHERE run_id = 'r1'`, args: [] },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('attempt-accounting-drift: t1')
    await f.close()
  })

  it('flags a live run after the user-attempt budget is exhausted', async () => {
    const f = await seeded('live-run-at-attempt-cap')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks SET attempts = max_attempts WHERE task_id = 't1'`,
        args: [],
      },
      {
        sql: `UPDATE runs SET attempt = 4 WHERE run_id = 'r1'`,
        args: [],
      },
    ])

    expect(
      (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
    ).toContain('attempts/at-max-with-live-run')
    await f.close()
  })

  it('keeps atomic condition IDs while deduplicating the legacy public violation', async () => {
    const f = await seeded('atomic-and-public')
    await f.raw.batch('corrupt', [
      {
        sql: `INSERT INTO checkpoints
                (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              VALUES ('other-task', 'both', 'other-q', '{}', 'r1', 1, ?)`,
        args: [NOW],
      },
    ])
    expect(
      (await engineInvariantFindings(f.raw))
        .filter((finding) => finding.name === 'checkpoint-cross-task')
        .map((finding) => finding.conditionId),
    ).toEqual(['checkpoint/queue-mismatch', 'checkpoint/task-mismatch'])
    expect(
      (await engineInvariantViolations(f.raw)).filter(
        (violation) => violation === 'checkpoint-cross-task: other-task/both',
      ),
    ).toHaveLength(1)
    await f.close()
  })

  it('keeps structured finding identities when rendered subjects collide', async () => {
    const f = await seeded('structured-subject')
    await f.raw.batch('corrupt', [
      {
        sql: `INSERT INTO checkpoints
                (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              VALUES ('a/b', 'c', 'q', '{}', 'r1', 1, ?)`,
        args: [NOW],
      },
      {
        sql: `INSERT INTO checkpoints
                (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              VALUES ('a', 'b/c', 'q', '{}', 'r1', 1, ?)`,
        args: [NOW],
      },
    ])
    const collisions = (await engineInvariantFindings(f.raw)).filter(
      (finding) =>
        finding.conditionId === 'checkpoint/task-mismatch' && finding.subject === 'a/b/c',
    )
    expect(collisions).toHaveLength(2)
    expect(new Set(collisions.map((finding) => JSON.stringify(finding.subjectIdentity))).size).toBe(
      2,
    )
    await f.close()
  })

  for (const [name, value, conditionId] of [
    ['storage class', 'not-an-integer', 'counter/checkpoint-owner-attempt'],
    ['upper bound', MAX_RUN_ORDINAL + 1, 'counter-bound/checkpoint-owner-attempt'],
  ] as const) {
    it(`flags checkpoint owner attempt ${name} corruption`, async () => {
      const f = await seeded(`checkpoint-owner-attempt-${name}`)
      await f.raw.batch('corrupt', [
        {
          sql: `INSERT INTO checkpoints
                  (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
                VALUES ('t1', 's', ?, '{}', 'r1', ?, ?)`,
          args: [Q, value, NOW],
        },
      ])

      expect(
        (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
      ).toContain(conditionId)
      await f.close()
    })
  }

  it("flags a checkpoint owner attempt that disagrees with its owner run's ordinal", async () => {
    const f = await seeded('checkpoint-owner-attempt-mismatch')
    await f.raw.batch('corrupt', [
      {
        sql: `INSERT INTO checkpoints
                (task_id, checkpoint_name, queue, state, owner_run_id, owner_attempt, updated_at_ms)
              VALUES ('t1', 's', ?, '{}', 'r1', 2, ?)`,
        args: [Q, NOW],
      },
    ])

    expect(
      (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
    ).toContain('checkpoint/owner-attempt-mismatch')
    await f.close()
  })

  for (const [name, table, column, value, conditionId] of [
    [
      'infrastructure retry',
      'tasks',
      'infra_retries',
      INFRA_RETRY_CAP + 1,
      'counter-bound/task-infra-retries',
    ],
    [
      'lost-launch relaunch',
      'runs',
      'relaunch_count',
      RELAUNCH_CAP + 1,
      'counter-bound/run-relaunch-count',
    ],
  ] as const) {
    it(`uses the protocol cap for the ${name} counter`, async () => {
      const f = await seeded(`${name.replaceAll(' ', '-')}-protocol-cap`)
      const key = table === 'tasks' ? 'task_id' : 'run_id'
      const id = table === 'tasks' ? 't1' : 'r1'
      await f.raw.batch('corrupt', [
        {
          sql: `UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
          args: [value, id],
        },
      ])

      expect(
        (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
      ).toContain(conditionId)
      await f.close()
    })
  }

  for (const column of ['available_at_ms', 'lease_ms'] as const) {
    it(`rejects an ISO datetime string in numeric ${column}`, async () => {
      const f = await seeded(`temporal-string-${column}`)
      await f.raw.batch('corrupt', [
        {
          sql: `UPDATE runs SET ${column} = '2026-07-26T12:34:56.789Z'
                WHERE run_id = 'r1'`,
          args: [],
        },
      ])
      expect(await engineInvariantViolations(f.raw)).toContain('temporal-storage-class: runs/r1')
      await f.close()
    })
  }

  it('flags a zero stored lease as below the positive duration bound', async () => {
    const f = await seeded('zero-lease-lower-bound')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE runs SET lease_ms = 0 WHERE run_id = 'r1'`,
        args: [],
      },
    ])

    expect(
      (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
    ).toContain('temporal-bound/runs.lease_ms')
    await f.close()
  })

  it('flags a dialect-exact bigint count above the public count contract', async () => {
    const f = await seeded('counter-upper-bound')
    const outOfRange: SqlExecutor = {
      batch: async (label, statements, mode) => {
        const results = await f.raw.batch(label, statements, mode)
        if (label !== 'invariants') return results
        return results.map((result, index) =>
          index === 0
            ? {
                ...result,
                rows: result.rows.map((row) =>
                  row.task_id === 't1' ? { ...row, max_attempts: BigInt(MAX_COUNT) + 1n } : row,
                ),
              }
            : result,
        )
      },
    }

    expect(await engineInvariantViolations(outOfRange)).toContain('counter-out-of-range: tasks/t1')
    await f.close()
  })

  it('flags a dialect-exact bigint instant beyond the epoch contract', async () => {
    const f = await seeded('temporal-upper-bound')
    const outOfRange: SqlExecutor = {
      batch: async (label, statements, mode) => {
        const results = await f.raw.batch(label, statements, mode)
        if (label !== 'invariants') return results
        return results.map((result, index) =>
          index === 1
            ? {
                ...result,
                rows: result.rows.map((row) =>
                  row.run_id === 'r1'
                    ? { ...row, available_at_ms: BigInt(MAX_EPOCH_MS) + 1n }
                    : row,
                ),
              }
            : result,
        )
      },
    }

    expect(await engineInvariantViolations(outOfRange)).toContain('temporal-out-of-range: runs/r1')
    await f.close()
  })

  for (const [table, column, identity] of [
    ['tasks', 'attempts', 'tasks/t1'],
    ['tasks', 'max_attempts', 'tasks/t1'],
    ['tasks', 'infra_retries', 'tasks/t1'],
    ['runs', 'attempt', 'runs/r1'],
    ['runs', 'claim_gen', 'runs/r1'],
    ['runs', 'activated_gen', 'runs/r1'],
    ['runs', 'relaunch_count', 'runs/r1'],
  ] as const) {
    it(`reports counter storage corruption for non-integer ${table}.${column}`, async () => {
      const f = await seeded(`counter-storage-${table}-${column}`)
      try {
        const key = table === 'tasks' ? 'task_id' : 'run_id'
        const id = table === 'tasks' ? 't1' : 'r1'
        await f.raw.batch('corrupt', [
          {
            sql: `UPDATE ${table} SET ${column} = 'not-an-integer' WHERE ${key} = ?`,
            args: [id],
          },
        ])

        expect(
          await engineInvariantViolations(f.raw),
          `mutation-verdict:behavior:counter-storage-${table}-${column}`,
        ).toContain(`counter-storage-class: ${identity}`)
      } finally {
        await f.close()
      }
    })
  }

  for (const [title, stamp, instant] of [
    ['a stamp without an instant', 'seed:statement', null],
    ['an instant without a stamp', null, NOW],
    ['a stamp without a separator', 'seed', NOW],
    ['a stamp with an empty seed', ':statement', NOW],
    ['a stamp with an empty statement name', 'seed:', NOW],
  ] as const) {
    it(`flags ${title}`, async () => {
      const f = await seeded(`provenance-${title.replaceAll(' ', '-')}`)
      await f.raw.batch('corrupt', [
        {
          sql: `UPDATE tasks SET fence_stamp = ?, fence_at_ms = ? WHERE task_id = 't1'`,
          args: [stamp, instant],
        },
      ])
      expect(await engineInvariantViolations(f.raw)).toContain('provenance-pair-broken: tasks/t1')
      await f.close()
    })
  }

  it('flags a provenance instant stored outside the integer epoch-ms representation', async () => {
    const f = await seeded('provenance-instant-type')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks
              SET fence_stamp = 'seed:statement', fence_at_ms = 'not-an-instant'
              WHERE task_id = 't1'`,
        args: [],
      },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('provenance-pair-broken: tasks/t1')
    await f.close()
  })

  it('flags a provenance statement name outside the builder grammar', async () => {
    const f = await seeded('provenance-statement-name')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks
              SET fence_stamp = 'seed:not a generated name', fence_at_ms = ?
              WHERE task_id = 't1'`,
        args: [NOW],
      },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('provenance-pair-broken: tasks/t1')
    await f.close()
  })

  it('treats the final stamp segment as the statement name', async () => {
    const f = await seeded('opaque-seed-same')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks SET fence_stamp = 'tenant:one:a', fence_at_ms = ?
              WHERE task_id = 't1'`,
        args: [NOW],
      },
      {
        sql: `UPDATE runs SET fence_stamp = 'tenant:one:b', fence_at_ms = ?
              WHERE run_id = 'r1'`,
        args: [NOW + 1],
      },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain(
      `one-batch-two-instants: tenant:one saw ${NOW} and ${NOW + 1}`,
    )
    await f.close()
  })

  it('does not merge independent opaque seeds that share a prefix', async () => {
    const f = await seeded('opaque-seed-different')
    await f.raw.batch('corrupt', [
      {
        sql: `UPDATE tasks SET fence_stamp = 'tenant:one:a', fence_at_ms = ?
              WHERE task_id = 't1'`,
        args: [NOW],
      },
      {
        sql: `UPDATE runs SET fence_stamp = 'tenant:two:b', fence_at_ms = ?
              WHERE run_id = 'r1'`,
        args: [NOW + 1],
      },
    ])
    expect(
      (await engineInvariantViolations(f.raw)).filter((v) =>
        v.startsWith('one-batch-two-instants:'),
      ),
    ).toEqual([])
    await f.close()
  })

  it('reports a name past the width in every identifier column, and none at the width, counted in code points', async () => {
    // 255 code points in 510 UTF-16 units: a count of units would call this name too long.
    const atTheWidth = '\u{1F600}'.repeat(IDENTIFIER_CHARACTERS)
    const observed: Record<string, { atTheWidth: string[]; pastTheWidth: string[] }> = {}
    const expected: typeof observed = {}
    for (const [table, columns] of Object.entries(IDENTIFIER_COLUMNS)) {
      for (const column of columns) {
        const f = await seeded(`width-${table}-${column}`)
        try {
          // One row in each of the four tables the seed world leaves empty.
          await f.raw.batch('every-table', [
            {
              sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, owner_run_id,
                      owner_attempt, updated_at_ms)
                    VALUES ('t1', 'cp', ?, '1', 'r1', 1, ?)`,
              args: [Q, NOW],
            },
            {
              sql: `INSERT INTO events (queue, event_name, payload, emitted_at_ms)
                    VALUES (?, 'go', '{"x":1}', ?)`,
              args: [Q, NOW],
            },
            {
              sql: `INSERT INTO waits (run_id, step_name, queue, task_id, event_name, created_at_ms)
                    VALUES ('r1', '$await:other', ?, 't1', 'other', ?)`,
              args: [Q, NOW],
            },
            {
              sql: `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)
                    VALUES (?, 'd1', ?, ?)`,
              args: [Q, NOW, NOW + 30_000],
            },
          ])
          const found = async (name: string): Promise<string[]> => {
            await f.raw.batch('name', [{ sql: `UPDATE ${table} SET ${column} = ?`, args: [name] }])
            return (await engineInvariantFindings(f.raw))
              .filter((finding) => finding.conditionId === 'identifier/over-width')
              .map((finding) => `${finding.subjectIdentity[0]}.${finding.subjectIdentity.at(-1)}`)
          }
          observed[`${table}.${column}`] = {
            atTheWidth: await found(atTheWidth),
            pastTheWidth: await found(`${atTheWidth}w`),
          }
          expected[`${table}.${column}`] = {
            atTheWidth: [],
            pastTheWidth: [`${table}.${column}`],
          }
        } finally {
          await f.close()
        }
      }
    }
    expect(
      observed,
      'mutation-verdict:behavior:identifier-over-width-read-in-every-column',
    ).toEqual(expected)
  })

  it('reads every column MySQL bounds at the width, and no other', () => {
    const tables = Object.keys(IDENTIFIER_COLUMNS)
    expect(
      boundedColumns(MYSQL_MIGRATIONS)
        .filter(({ table, width }) => tables.includes(table) && width === IDENTIFIER_CHARACTERS)
        .map(({ table, column }) => `${table}.${column}`)
        .sort(),
      'mutation-verdict:construction:identifier-columns-are-the-bounded-columns',
    ).toEqual(
      Object.entries(IDENTIFIER_COLUMNS)
        .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))
        .sort(),
    )
  })

  it('finds bounded columns in SQL formatting it did not anticipate', () => {
    expect(
      boundedColumns([
        {
          statements: [
            'create table if not exists `a` (`id` varchar(255) NOT NULL, name VARCHAR(16), n BIGINT,\n PRIMARY KEY (id, name)) ENGINE=InnoDB',
            'CREATE INDEX a_name ON a (name)',
            'ALTER TABLE a\n  ADD COLUMN later VARCHAR(255)',
          ],
        },
      ]),
    ).toEqual([
      { table: 'a', column: 'id', width: 255 },
      { table: 'a', column: 'name', width: 16 },
      { table: 'a', column: 'later', width: 255 },
    ])
  })

  it('refuses a migration statement that types a VARCHAR column it did not read', () => {
    // MySQL has no ADD COLUMN IF NOT EXISTS, so this schema writes DDL that is safe to repeat
    // as a statement inside a string, which it sets, prepares and executes. A column added
    // that way is in no statement the reader reads, so the reader must refuse the statement
    // and not skip it.
    expect(() =>
      boundedColumns([
        {
          statements: [
            "SET @durablerun_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'a' AND column_name = 'guarded') = 0, 'ALTER TABLE a ADD COLUMN guarded VARCHAR(255)', 'DO 0')",
            'PREPARE durablerun_ddl FROM @durablerun_ddl',
            'EXECUTE durablerun_ddl',
          ],
        },
      ]),
    ).toThrow(/VARCHAR/)
  })

  it('stays silent on the consistent seed world', async () => {
    const f = await seeded('clean')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    await f.close()
  })

  it('binds every snapshot result through its projection table identity', () => {
    const projections = [
      { table: 'runs', columns: ['snapshot_table'] },
      { table: 'checkpoints', columns: ['snapshot_table'] },
      { table: 'events', columns: ['snapshot_table'] },
      { table: 'waits', columns: ['snapshot_table'] },
      { table: 'drivers', columns: ['snapshot_table'] },
      { table: 'tasks', columns: ['snapshot_table'] },
    ] as const
    const results: readonly SqlResult[] = projections.map(({ table }) => ({
      rows: [{ snapshot_table: table }],
      rowsAffected: 1,
    }))
    const rowsByTable = bindInvariantSnapshotRows(projections, results)

    expect(
      {
        size: rowsByTable.size,
        bindings: projections.map(({ table }) => [
          table,
          rowsByTable.get(table)?.map((row) => row.snapshot_table),
        ]),
      },
      'mutation-verdict:construction:invariant-snapshot-table-identity',
    ).toEqual({
      size: projections.length,
      bindings: projections.map(({ table }) => [table, [table]]),
    })
  })
})

/**
 * The width condition can fail only when something stores a name past the width, and the
 * one op of the fuzz walk that passes such a name is refused by a store that holds the rule.
 * So these walks are green while every entry holds it, and a store entry that stops holding
 * it fails them by that condition. The case lives here and not beside the fuzz shards,
 * because the mutation audit leaves the fuzz files out of a mutation's run.
 */
describe('walks that pass the port names past the width', () => {
  it('uphold the invariants, and the port refuses every name', async () => {
    const failures: string[] = []
    let refusals = 0
    // Eight walks of fifty steps pass a few dozen names between them.
    for (let walk = 0; walk < 8; walk++) {
      await runFuzzScenario(makeLibsqlFixture, `past-the-width-${walk}`, 50).then(
        (stats) => {
          refusals += stats.overWidthRefusals
        },
        (error: unknown) => {
          failures.push(String(error).replace(/w{40,}/g, '<a name past the width>'))
        },
      )
    }
    expect(
      { failures, refusedSomething: refusals > 0 },
      'mutation-verdict:behavior:a-walk-fails-when-a-store-entry-lets-a-name-past-the-width',
    ).toEqual({ failures: [], refusedSomething: true })
  }, 120_000)
})
