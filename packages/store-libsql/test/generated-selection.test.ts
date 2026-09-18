import {
  FencedBatch,
  type SqlExecutor,
  defineStatement,
  nowValue,
  stampValue,
  treeBuilder,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import type { LibsqlExecutor } from '../src/index.js'
import { openTestDb } from '../src/testing.js'
import { NOW_MS } from '../src/time.js'
import { TREE_DIALECT } from '../src/tree.js'

const NOW = 1_000_000

/** The compare-and-set every batch here opens with: it stamps one run, from one state if given. */
function stampRun(runId: string, state?: string, from?: string) {
  return defineStatement('stamp-run', () => {
    const update = treeBuilder
      .updateTable('runs')
      .set({
        ...(state === undefined ? {} : { state }),
        fence_stamp: stampValue,
        fence_at_ms: nowValue,
      })
      .where('run_id', '=', runId)
    return from === undefined ? update : update.where('state', '=', from)
  })({})
}

/**
 * `derived()` exists so that no caller writes the clause that decides which
 * rows a follow-on may touch — the primitive generates it, and the caller can
 * only ever shrink the result. These tests run the generated SQL against a
 * real dialect and ask the semantic question directly: did a row this batch
 * never stamped get written? Asserting on the generated TEXT would be the
 * same syntactic proxy that let this class through twice already.
 */
async function fixture() {
  const { raw } = await openTestDb({ nowMs: NOW })
  return { raw, close: () => raw.close() }
}

async function insert(raw: LibsqlExecutor, taskId: string, runId: string, queue: string) {
  await raw.batch(
    'setup',
    [
      {
        sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy,
                max_attempts, cancellation, state, enqueue_at_ms, created_at_ms)
              VALUES (?, ?, 'job', '{}', '{"kind":"none"}', 3,
                '{"maxDurationSeconds":1}', 'running', ?, ?)`,
        args: [taskId, queue, NOW, NOW],
      },
      {
        sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claim_gen,
                activated_gen, created_at_ms)
              VALUES (?, ?, ?, 1, 'running', 1, 1, ?)`,
        args: [runId, queue, taskId, NOW],
      },
    ],
    'write',
  )
}

async function stateOf(raw: LibsqlExecutor, taskId: string): Promise<string> {
  const [row] = (
    await raw.batch(
      'read',
      [{ sql: `SELECT state FROM tasks WHERE task_id = ?`, args: [taskId] }],
      'read',
    )
  )[0]?.rows as { state: string }[]
  return row?.state ?? '(missing)'
}

/**
 * One stamped run in queue 'b', and a follow-on whose correlation is the
 * natural spelling of "either of these two queues". The disjunction is the
 * whole point: it lands in a boolean position, and unbracketed it binds as
 * `a OR (b AND fence)`.
 */
async function spread(raw: LibsqlExecutor, label = 'probe'): Promise<void> {
  const b = new FencedBatch(label, 'seed', { now: NOW_MS, tree: TREE_DIALECT })
  b.casTree('win', stampRun('run-stamped', 'running'))
  b.derived('spread', {
    relation: 'runs-to-tasks',
    fence: 'win',
    where: `f.queue = ? OR f.queue = ?`,
    whereArgs: ['a', 'b'],
    set: { state: `'cancelled'` },
    rows: 'source-keys',
  })
  await b.run(raw)
}

describe('a generated selection restricts to rows this batch stamped', () => {
  it('holds when the caller correlation is a disjunction', async () => {
    // `where` was interpolated into the fence subquery unparenthesised:
    //
    //   WHERE <corr> AND f.fence_stamp = ?
    //
    // AND binds tighter than OR, so a caller writing `a OR b` — the natural
    // spelling for "either of these two queues" — got
    //
    //   WHERE a OR (b AND f.fence_stamp = ?)
    //
    // and every row matching `a` entered the selection carrying no stamp at
    // all. That is the exact class the primitive was built to make
    // unwritable, reintroduced inside the thing that was supposed to prevent
    // it. The generator now brackets caller text before placing it in a
    // boolean position, and generated SQL passes the same construction checks
    // as every other statement.
    const f = await fixture()
    // Stamped: queue 'b'. Never stamped: queue 'a' — it can only be selected
    // through a disjunct that escaped the fence.
    await insert(f.raw, 'stamped', 'run-stamped', 'b')
    await insert(f.raw, 'untouched', 'run-untouched', 'a')

    // The generated statement is a tree, and the batch reads its gate from the tree. A
    // generator whose fence did not gate would be refused here, before it could run.
    const refusal = await spread(f.raw, 'mutation:generated-selection-fence').then(
      () => null,
      (error: Error) => error.message,
    )
    expect(refusal, 'mutation-verdict:behavior:generated-selection-scope').toBeNull()

    expect(await stateOf(f.raw, 'stamped')).toBe('cancelled')
    expect(
      await stateOf(f.raw, 'untouched'),
      'mutation-verdict:behavior:generated-selection-scope',
    ).toBe('running')
    f.close()
  })

  it('never lets narrow widen the target set', async () => {
    const f = await fixture()
    await insert(f.raw, 'stamped', 'run-stamped', 'b')
    await insert(f.raw, 'untouched', 'run-untouched', 'a')

    const b = new FencedBatch('narrow', 'narrow-seed', { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree('win', stampRun('run-stamped', 'running'))
    b.derived('spread', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: `'cancelled'` },
      // Without the generated parentheses this becomes
      // `(fenced selection AND stamped) OR untouched`, so the second arm can
      // escape the fence and widen the write to a row this batch never owned.
      narrow: `task_id = ? OR task_id = ?`,
      narrowArgs: ['stamped', 'untouched'],
      rows: 'source-keys',
    })

    await b.run(f.raw)
    expect(await stateOf(f.raw, 'stamped')).toBe('cancelled')
    expect(
      await stateOf(f.raw, 'untouched'),
      'mutation-verdict:behavior:generated-narrow-widens',
    ).toBe('running')
    f.close()
  })

  it('never lets narrow silently drop every matching row', async () => {
    const f = await fixture()
    await insert(f.raw, 'stamped', 'run-stamped', 'b')

    const matching = new FencedBatch('narrow-positive', 'narrow-positive-seed', {
      now: NOW_MS,
      tree: TREE_DIALECT,
    })
    matching.casTree('win', stampRun('run-stamped', 'running'))
    matching.derived('spread', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: `'cancelled'` },
      narrow: `task_id = ?`,
      narrowArgs: ['stamped'],
      rows: 'source-keys',
    })
    await matching.run(f.raw)

    expect(
      await stateOf(f.raw, 'stamped'),
      'mutation-verdict:behavior:generated-narrow-progress',
    ).toBe('cancelled')
    f.close()
  })

  it('still writes provenance derived from the stamped source', async () => {
    // UPDATE is the discriminator: derived() must generate provenance with no
    // caller opt-out. The provenance subquery interpolates the same
    // correlation, so it also has to agree with the selection about scope.
    const f = await fixture()
    await insert(f.raw, 'stamped', 'run-stamped', 'b')

    // A generated UPDATE that left the stamp out is refused by the stamping rule, so the
    // row below would carry no stamp of this statement either way.
    const refusal = await spread(f.raw, 'mutation:generated-update-provenance-assignment').then(
      () => null,
      (error: Error) => error.message,
    )

    const [row] = (
      await f.raw.batch(
        'read',
        [
          {
            sql: `SELECT t.fence_stamp AS s, t.fence_at_ms AS a, r.fence_at_ms AS ra
                  FROM tasks t JOIN runs r ON r.task_id = t.task_id
                  WHERE t.task_id = 'stamped'`,
            args: [],
          },
        ],
        'read',
      )
    )[0]?.rows as { s: string; a: number; ra: number }[]
    expect(row?.s, 'mutation-verdict:behavior:generated-update-provenance-assignment').toBe(
      'seed:spread',
    )
    // One instant for the whole batch: the follow-on copies the CAS's, it
    // does not read the clock again (§3.4 rule 3).
    expect({ followOn: row?.a, cas: row?.ra }).toEqual({ followOn: NOW, cas: NOW })
    expect(refusal).toBeNull()
    f.close()
  })

  it('bounds distinct relation keys without rejecting several rows under one key', async () => {
    const f = await fixture()
    await insert(f.raw, 'task', 'run', 'q')
    await f.raw.batch(
      'setup:waits',
      [
        {
          sql: `INSERT INTO waits
                  (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
                VALUES (?, ?, 'q', 'task', 'event', 'waiting', ?)`,
          args: ['run', 'step-1', NOW],
        },
        {
          sql: `INSERT INTO waits
                  (run_id, step_name, queue, task_id, event_name, status, created_at_ms)
                VALUES (?, ?, 'q', 'task', 'event', 'waiting', ?)`,
          args: ['run', 'step-2', NOW],
        },
      ],
      'write',
    )

    const b = new FencedBatch('delete-waits', 'bound', { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree('win', stampRun('run'))
    b.derived('waits', {
      relation: 'runs-to-waits',
      fence: 'win',
      where: 'f.run_id = ?',
      whereArgs: ['run'],
      rows: 'source-keys',
    })
    await b.run(f.raw)

    const [left] = await f.raw.batch(
      'read:waits',
      [{ sql: `SELECT COUNT(*) AS n FROM waits WHERE run_id = ?`, args: ['run'] }],
      'read',
    )
    expect(Number(left?.rows[0]?.n)).toBe(0)
    f.close()
  })

  it('keeps a source-key bound valid when the executor exactly replays the batch', async () => {
    const f = await fixture()
    await insert(f.raw, 'task', 'run', 'q')
    const replaying: SqlExecutor = {
      batch: async (label, statements, mode) => {
        await f.raw.batch(label, statements, mode)
        return f.raw.batch(label, statements, mode)
      },
    }

    const b = new FencedBatch('replayed', 'same-seed', { now: NOW_MS, tree: TREE_DIALECT })
    b.casTree('win', stampRun('run', 'sleeping', 'running'))
    b.derived('task', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: `'cancelled'` },
      rows: 'source-keys',
    })

    await expect(b.run(replaying)).resolves.toMatchObject({ won: null })
    expect(await stateOf(f.raw, 'task')).toBe('cancelled')
    f.close()
  })
})
