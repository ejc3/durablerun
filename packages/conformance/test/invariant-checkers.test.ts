import {
  INFRA_RETRY_CAP,
  MAX_COUNT,
  MAX_EPOCH_MS,
  MAX_RUN_ORDINAL,
  RELAUNCH_CAP,
  type SqlExecutor,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { engineInvariantFindings, engineInvariantViolations } from '../src/invariants.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
  })

  it('flags attempt accounting above the run-derived band', async () => {
    const f = await seeded('attempt-accounting-above')
    await f.raw.batch('corrupt', [
      { sql: `UPDATE tasks SET attempts = 2 WHERE task_id = 't1'`, args: [] },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('attempt-accounting-drift: t1')
    f.close()
  })

  it('flags attempt accounting below the run-derived band', async () => {
    const f = await seeded('attempt-accounting-below')
    await f.raw.batch('corrupt', [
      { sql: `UPDATE runs SET attempt = 3 WHERE run_id = 'r1'`, args: [] },
    ])
    expect(await engineInvariantViolations(f.raw)).toContain('attempt-accounting-drift: t1')
    f.close()
  })

  it('flags a live run whose ordinal is not the next accounted attempt', async () => {
    const f = await seeded('live-run-not-next-accounted-attempt')
    await f.raw.batch('corrupt', [
      { sql: `UPDATE tasks SET attempts = 1 WHERE task_id = 't1'`, args: [] },
    ])

    expect(
      (await engineInvariantFindings(f.raw)).map((finding) => finding.conditionId as string),
      'mutation-verdict:behavior:accounting-live-run-next-invariant',
    ).toContain('accounting/live-run-not-next')
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
      f.close()
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
    f.close()
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
      f.close()
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
      f.close()
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
    ).toContain('temporal-bound/run-lease')
    f.close()
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
    f.close()
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
    f.close()
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
        f.close()
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
      f.close()
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
    f.close()
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
    f.close()
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
    f.close()
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
    f.close()
  })

  it('stays silent on the consistent seed world', async () => {
    const f = await seeded('clean')
    expect(await engineInvariantViolations(f.raw)).toEqual([])
    f.close()
  })
})
