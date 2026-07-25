import { describe, expect, it } from 'vitest'
import { engineInvariantViolations } from '../src/invariants.js'
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
