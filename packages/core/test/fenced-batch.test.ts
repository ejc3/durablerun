import { describe, expect, it } from 'vitest'
import {
  FENCE_COLS,
  FENCE_SET,
  FENCE_VALS,
  FencedBatch,
  NOW,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
  STAMP,
} from '../src/index.js'

/**
 * The primitive that makes two whole bug classes unwritable had no test of
 * its own: every check in it was believed because the engine on top of it
 * passed. That is the wrong direction of evidence — the engine passing shows
 * the checks accept correct SQL, and says nothing about whether they REJECT
 * the shapes they exist to reject. Each check below is paired: a shape it
 * must refuse, and the nearest legitimate shape it must still allow.
 */

const CLOCK = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`

function batch(label = 'b'): FencedBatch {
  return new FencedBatch(label, 'seed', { now: CLOCK })
}

/** A CAS that satisfies every check, so tests can isolate one at a time. */
function withCas(b: FencedBatch = batch()): FencedBatch {
  return b.cas('win', 'runs', `UPDATE runs SET state = 'x', ${FENCE_SET} WHERE run_id = ?`, ['r'])
}

class FakeDb implements SqlExecutor {
  calls: { label: string; statements: SqlStatement[]; mode: SqlBatchMode }[] = []
  constructor(private readonly counts: number[] = []) {}
  batch(
    label: string,
    statements: readonly SqlStatement[],
    mode: SqlBatchMode = 'write',
  ): Promise<SqlResult[]> {
    this.calls.push({ label, statements: [...statements], mode })
    return Promise.resolve(
      statements.map((_, i) => ({ rows: [], rowsAffected: this.counts[i] ?? 0 })),
    )
  }
}

describe('a CAS must write its own provenance', () => {
  it('rejects an UPDATE that does not set the fence columns', () => {
    expect(() =>
      batch().cas('win', 'runs', `UPDATE runs SET state = 'x' WHERE run_id = ?`, ['r']),
    ).toThrow(/must set/)
  })

  it('rejects a CAS that only READS the stamp', () => {
    // The check this replaced was `sql.includes(STAMP)`, which this satisfies
    // while writing no provenance at all.
    expect(() =>
      batch().cas('win', 'runs', `UPDATE runs SET state = 'x' WHERE fence_stamp = ${STAMP}`),
    ).toThrow(/must set/)
  })

  it('rejects a CAS whose fence write is inside the WHERE clause', () => {
    expect(() =>
      batch().cas(
        'win',
        'runs',
        `UPDATE runs SET state = 'x' WHERE run_id = ? AND (SELECT 1 WHERE ${FENCE_SET})`,
        ['r'],
      ),
    ).toThrow(/must set/)
  })

  it('rejects a CAS that stamps a table other than the one it declared', () => {
    expect(() =>
      batch().cas('win', 'tasks', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, ['r']),
    ).toThrow(/does not write to it/)
  })

  it('accepts the UPDATE form', () => {
    expect(() => withCas()).not.toThrow()
  })

  it('accepts the INSERT form and requires both halves', () => {
    const insert = (cols: string, vals: string) =>
      batch().cas('win', 'runs', `INSERT INTO runs (run_id, ${cols}) VALUES (?, ${vals})`, ['r'])
    expect(() => insert(FENCE_COLS, FENCE_VALS)).not.toThrow()
    expect(() => insert(FENCE_COLS, `NULL, NULL`)).toThrow(/must insert/)
    expect(() => insert(`a, b`, FENCE_VALS)).toThrow(/must insert/)
  })

  it('rejects a follow-on that writes a fenced table without stamping it', () => {
    // The CAS side of this check had tests; the follow-on side had none, and
    // deleting it broke nothing — found by mutation probe, not by review.
    // A follow-on that writes a provenance-carrying table and leaves the
    // provenance alone produces rows whose fence_stamp still names whatever
    // batch touched them last, so the next batch to fence on that value acts
    // on rows it did not write.
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        'tasks',
        `UPDATE tasks SET state = 'pending'
         WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
        [],
        'one',
      ),
    ).toThrow(/does not stamp it/)
  })

  it('rejects a follow-on INSERT into a fenced table that omits the columns', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        'runs',
        `INSERT INTO runs (run_id, task_id)
         SELECT ?, f.task_id FROM runs f WHERE f.fence_stamp = ${b.fence('win')}`,
        ['r'],
        'one',
      ),
    ).toThrow(/must insert/)
  })

  it('rejects an upsert whose DO UPDATE branch leaves provenance stale', () => {
    const upsert = (doUpdate: string) =>
      batch().cas(
        'win',
        'events',
        `INSERT INTO events (queue, ${FENCE_COLS}) VALUES (?, ${FENCE_VALS})
         ON CONFLICT (queue) DO UPDATE SET ${doUpdate}`,
        ['q'],
      )
    expect(() => upsert(`emitted_at_ms = 1`)).toThrow(/re-stamp/)
    expect(() => upsert(FENCE_SET)).not.toThrow()
  })
})

describe('fence() names a statement, and the primitive supplies the value', () => {
  it('refuses a name that is not in this batch', () => {
    expect(() => withCas().fence('typo')).toThrow(/names no statement/)
  })

  it('refuses a statement added LATER — its provenance cannot exist yet', () => {
    const b = withCas()
    expect(() => b.fence('later')).toThrow(/names no statement/)
    b.followOn('later', `DELETE FROM waits WHERE fence_stamp = ${b.fence('win')}`, [], 'one')
    expect(() => b.fence('later')).toThrow(/writes no stamp/)
  })

  it('refuses a statement that writes no stamp', () => {
    const b = withCas()
    b.followOn('unstamped', `DELETE FROM waits WHERE fence_stamp = ${b.fence('win')}`, [], 'one')
    expect(() => b.fence('unstamped')).toThrow(/writes no stamp/)
  })

  it('applies the same rules to a fence token written by hand', () => {
    // fence() is a convenience, not the enforcement point: the token it
    // returns is ordinary text, so anyone can type `$FENCE:whatever$` into
    // the SQL and skip every check. All three shapes below compile to a bind
    // of a value NOTHING in the batch ever writes, so the statement matches
    // no rows — silently, forever, with the batch reporting success. That is
    // worse than the bug the fence exists to prevent, because a follow-on
    // that never runs looks exactly like a follow-on that had nothing to do.
    const cases: [string, RegExp][] = [
      ['$FENCE:typo$', /names no statement/],
      ['$FENCE:later$', /names no statement/],
      ['$FENCE:plain$', /writes no stamp/],
    ]
    for (const [token, message] of cases) {
      const b = withCas()
      b.followOn('plain', `DELETE FROM waits WHERE fence_stamp = ${b.fence('win')}`, [], 'one')
      expect(
        () => b.followOn('x', `DELETE FROM waits WHERE fence_stamp = ${token}`, [], 'one'),
        token,
      ).toThrow(message)
    }
  })

  it('accepts a stamping follow-on as a fence source', () => {
    const b = withCas()
    b.followOn(
      'mirror',
      'tasks',
      `UPDATE tasks SET fence_stamp = ${STAMP},
         fence_at_ms = (SELECT r.fence_at_ms FROM runs r WHERE r.fence_stamp = ${b.fence('win')})
       WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
      [],
      'one',
    )
    expect(() => b.fence('mirror')).not.toThrow()
  })
})

describe('a follow-on must filter on a fence, positively, in the WHERE side', () => {
  it('rejects a follow-on with no fence at all', () => {
    expect(() =>
      withCas().followOn('x', `DELETE FROM waits WHERE run_id = ?`, ['r'], 'one'),
    ).toThrow(/no positive fence/)
  })

  it('rejects a fence that appears ONLY in the SET clause', () => {
    // The self-defeat: the statement still matches every row and merely
    // writes a value derived from a fence into all of them.
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        'tasks',
        `UPDATE tasks SET fence_stamp = ${STAMP},
           fence_at_ms = (SELECT r.fence_at_ms FROM runs r WHERE r.fence_stamp = ${b.fence('win')})
         WHERE state = 'pending'`,
        [],
        'one',
      ),
    ).toThrow(/no positive fence/)
  })

  it('rejects a fence that appears ONLY under NOT', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        `DELETE FROM waits
         WHERE run_id = ? AND NOT EXISTS (SELECT 1 FROM runs WHERE fence_stamp = ${b.fence('win')})`,
        ['r'],
        'one',
      ),
    ).toThrow(/no positive fence/)
  })

  it('accepts a statement carrying both a positive and a negative fence', () => {
    // `fail`'s terminal arm: fires when the successor was NOT written, but
    // still keyed to the run this batch actually failed.
    const b = withCas()
    expect(() =>
      b.followOn(
        'terminal',
        `UPDATE tasks SET state = 'failed'
         WHERE task_id = (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})
           AND NOT EXISTS (SELECT 1 FROM runs s WHERE s.run_id = ? AND s.fence_stamp = ${b.fence('win')})`,
        ['s'],
        'one',
      ),
    ).not.toThrow()
  })

  it('does not mistake a WHERE inside a subquery for the top-level one', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        `UPDATE tasks SET state = (SELECT state FROM runs WHERE fence_stamp = ${b.fence('win')})
         WHERE task_id = ?`,
        ['t'],
        'one',
      ),
    ).toThrow(/no positive fence/)
  })

  it('is not fooled by the word WHERE inside a string literal', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        `UPDATE tasks SET failure_reason = '{"msg":"WHERE fence_stamp = x"}'
         WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
        [],
        'one',
      ),
    ).not.toThrow()
  })
})

describe('only a CAS may read the clock', () => {
  it('rejects $NOW$ in a follow-on', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        `UPDATE runs SET available_at_ms = ${NOW} WHERE fence_stamp = ${b.fence('win')}`,
        [],
        'one',
      ),
    ).toThrow(/reads the clock/)
  })

  it('rejects $NOW$ in a comparison, not just an assignment', () => {
    // A re-evaluated deadline in a follow-on is the same bug wearing a
    // different hat: the CAS can pass the comparison and the follow-on fail
    // it a millisecond later.
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        `UPDATE tasks SET state = 'running'
         WHERE cancel_at_ms > ${NOW} AND task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
        [],
        'one',
      ),
    ).toThrow(/reads the clock/)
  })

  it('rejects $NOW$ in a tail', () => {
    const b = withCas()
    expect(() =>
      b.tail('t', `SELECT ${NOW} AS n FROM runs WHERE fence_stamp = ${b.fence('win')}`),
    ).toThrow(/reads the clock/)
  })

  it('rejects a clock expression containing a bind parameter', () => {
    expect(() => new FencedBatch('b', 's', { now: `? + 1` })).toThrow(/spliced as SQL/)
  })
})

describe('bookkeeping checks', () => {
  it('rejects duplicate statement names', () => {
    const b = withCas()
    expect(() =>
      b.cas('win', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, ['r']),
    ).toThrow(/duplicate statement name/)
  })

  it('rejects a blind counter bump in a follow-on', () => {
    const b = withCas()
    expect(() =>
      b.followOn(
        'x',
        'tasks',
        `UPDATE tasks SET attempts = attempts + 1, fence_stamp = ${STAMP}, fence_at_ms = 1
         WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
        [],
        'one',
      ),
    ).toThrow(/blindly/)
  })

  it('catches the counter bump however it is spelled', () => {
    // The first version of this check only matched `x = x + <digit>`. Every
    // shape below is the same non-idempotent write and slipped past it; each
    // double-counts one user failure on an exact replay, so the retry budget
    // is spent twice and the task can fail permanently an attempt early.
    const shapes = [
      `attempts = attempts + ?`,
      `attempts = tasks.attempts + 1`,
      `attempts = (attempts + 1)`,
      `attempts = 1 + attempts`,
      `attempts = attempts - 1`,
      `"attempts" = "attempts" + 1`,
    ]
    for (const set of shapes) {
      const b = withCas()
      expect(
        () =>
          b.followOn(
            'x',
            'tasks',
            `UPDATE tasks SET ${set}, fence_stamp = ${STAMP}, fence_at_ms = 1
             WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
            [],
            'one',
          ),
        set,
      ).toThrow(/blindly/)
    }
  })

  it('does not mistake a derived value for a counter bump', () => {
    // Every one of these is idempotent: the value comes from somewhere other
    // than the column being written.
    const shapes = [
      `available_at_ms = f.fence_at_ms + 5000`,
      `attempts = (SELECT f.attempt - tasks.infra_retries FROM runs f WHERE f.run_id = 'r')`,
      `state = 'pending'`,
      `failure_reason = '{"note":"attempts = attempts + 1"}'`,
    ]
    for (const set of shapes) {
      const b = withCas()
      expect(
        () =>
          b.followOn(
            'x',
            'tasks',
            `UPDATE tasks SET ${set}, fence_stamp = ${STAMP}, fence_at_ms = 1
             WHERE task_id IN (SELECT task_id FROM runs WHERE fence_stamp = ${b.fence('win')})`,
            [],
            'one',
          ),
        set,
      ).not.toThrow()
    }
  })

  it('allows a CAS to bump a counter, because its guard consumes the pre-state', () => {
    // claim really does `claim_gen = claim_gen + 1`. Replaying it is safe: the
    // CAS's own guard no longer matches, so the bump cannot happen twice. A
    // follow-on has no such guard — it keys on the post-state, which a replay
    // reproduces exactly — which is why the check applies only there.
    expect(() =>
      batch().casMany(
        'c',
        'runs',
        5,
        `UPDATE runs SET claim_gen = claim_gen + 1, ${FENCE_SET}
         WHERE queue = ? AND NOT EXISTS (SELECT 1 FROM runs h WHERE h.claimed_by = ?)`,
        ['q', 'tok'],
      ),
    ).not.toThrow()
  })

  it('rejects a tail that is not a SELECT', () => {
    const b = withCas()
    expect(() => b.tail('t', `DELETE FROM runs WHERE fence_stamp = ${b.fence('win')}`)).toThrow(
      /must be a SELECT/,
    )
  })

  it('requires a reason on an open tail', () => {
    expect(() => withCas().openTail('t', '   ', `SELECT 1`)).toThrow(/needs a reason/)
  })

  it('lets an open tail skip the fence — that is what it is for', () => {
    expect(() =>
      withCas().openTail('t', 'the winner is a row some other batch wrote', `SELECT 1`),
    ).not.toThrow()
  })

  it('rejects a batch with no CAS', async () => {
    // Only reachable through an open tail: a fenced statement cannot even be
    // BUILT without a CAS, because fence() has nothing to name.
    const b = batch().openTail('t', 'no transition here', `SELECT 1`)
    await expect(b.run(new FakeDb())).rejects.toThrow(/has no CAS/)
  })

  it('rejects a name that cannot be spliced into a fence token', () => {
    expect(() =>
      batch().cas('a:b', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE id = ?`, ['x']),
    ).toThrow(/name must match/)
  })

  it('rejects a fence token hidden inside a string literal', () => {
    // Substitution is positional and does not parse SQL, so a token in a
    // literal would quietly become a bind parameter. The engine writes JSON
    // constants into failure_reason, which is where such a thing would live.
    expect(() =>
      batch().cas(
        'win',
        'tasks',
        `UPDATE tasks SET failure_reason = '{"name":"$NOW$"}', ${FENCE_SET} WHERE task_id = ?`,
        ['t'],
      ),
    ).toThrow(/inside the string literal/)
  })

  it('rejects a casMany with a nonsense bound', () => {
    expect(() =>
      batch().casMany('c', 'runs', 0, `UPDATE runs SET ${FENCE_SET} WHERE queue = ?`, ['q']),
    ).toThrow(/positive integer/)
  })
})

describe('compilation binds tokens left to right', () => {
  it('interleaves ?, $STAMP$ and $FENCE:x$ in source order and splices $NOW$', async () => {
    const db = new FakeDb([1, 1])
    const b = withCas()
    b.followOn(
      'after',
      'tasks',
      `UPDATE tasks SET fence_stamp = ${STAMP}, fence_at_ms = ?
       WHERE task_id = ? AND EXISTS (SELECT 1 FROM runs WHERE fence_stamp = ${b.fence('win')})`,
      [7, 't'],
      'one',
    )
    await b.run(db)

    const [cas, after] = db.calls[0]?.statements ?? []
    // The CAS: `?` for the stamp, the clock spliced as SQL, then run_id.
    expect(cas?.sql).toContain(CLOCK)
    expect(cas?.sql).not.toContain('$')
    expect(cas?.args).toEqual(['seed:win', 'r'])
    // The follow-on: its OWN stamp, then 7, then 't', then the fence value.
    expect(after?.args).toEqual(['seed:after', 7, 't', 'seed:win'])
  })

  it('refuses an undefined bind instead of quietly making it null', async () => {
    // The executor rejects undefined binds so that a typo cannot be laundered
    // into an infrastructure outage and retried until the run's budget is
    // gone. This compiler used to coerce undefined to null first — and every
    // protocol operation goes through it, so that coercion covered the entire
    // surface the executor's check was added to protect, and sent a valid
    // statement carrying a value the caller never meant.
    const b = batch().cas(
      'win',
      'runs',
      `UPDATE runs SET ${FENCE_SET} WHERE run_id = ? AND queue = ?`,
      ['r', undefined as unknown as string],
    )
    await expect(b.run(new FakeDb([1]))).rejects.toThrow(/is undefined/)
  })

  it('fails when a statement binds a different number of args than it has', async () => {
    const b = batch().cas(
      'win',
      'runs',
      `UPDATE runs SET ${FENCE_SET} WHERE run_id = ? AND queue = ?`,
      ['only-one'],
    )
    await expect(b.run(new FakeDb())).rejects.toThrow(/binds 2 of 1/)
  })
})

describe('run() reports the outcome', () => {
  it('names the CAS that won and how many rows it took', async () => {
    const b = batch().casMany('c', 'runs', 5, `UPDATE runs SET ${FENCE_SET} WHERE queue = ?`, ['q'])
    expect(await b.run(new FakeDb([3]))).toMatchObject({ won: 'c', count: 3 })
  })

  it('reports no winner when the CAS matched nothing', async () => {
    expect(await withCas().run(new FakeDb([0]))).toMatchObject({ won: null, count: 0 })
  })

  it('throws when two mutually exclusive CASes both won', async () => {
    const b = batch()
      .cas('a', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, ['r'])
      .cas('b', 'runs', `UPDATE runs SET ${FENCE_SET} WHERE run_id = ?`, ['r'])
    await expect(b.run(new FakeDb([1, 1]))).rejects.toThrow(/both won/)
  })

  it('throws when a casMany exceeded its bound', async () => {
    const b = batch().casMany('c', 'runs', 2, `UPDATE runs SET ${FENCE_SET} WHERE queue = ?`, ['q'])
    await expect(b.run(new FakeDb([3]))).rejects.toThrow(/at most 2 allowed/)
  })

  it('throws when a follow-on declared one row and wrote more', async () => {
    const b = withCas()
    b.followOn('x', `DELETE FROM waits WHERE fence_stamp = ${b.fence('win')}`, [], 'one')
    await expect(b.run(new FakeDb([1, 2]))).rejects.toThrow(/declared 'one'/)
  })

  it('allows a declared many-row follow-on to write many', async () => {
    const b = withCas()
    b.followOn('x', `DELETE FROM waits WHERE fence_stamp = ${b.fence('win')}`, [], {
      many: 'a run may hold several waits',
    })
    await expect(b.run(new FakeDb([1, 9]))).resolves.toMatchObject({ won: 'win' })
  })
})
