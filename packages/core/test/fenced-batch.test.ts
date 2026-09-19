import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type EventName,
  FENCE_ASSIGNMENTS,
  FencedBatch,
  type SqlBatchControl,
  type SqlBatchMode,
  type SqlExecutor,
  type SqlLockedBatch,
  type SqlResult,
  type SqlStatement,
  type SqlTransactionLock,
  defineStatement,
  fenceValue,
  sqlBatchMode,
  sqlTransactionLock,
  stampValue,
  taskStateValue,
} from '../src/index.js'
import {
  type Loose,
  accepts,
  batch,
  batchWithClock,
  fenced,
  loose,
  onEvent,
  refuses,
  statement,
  taskFollowOn,
  tiedKeys,
  value,
  winCas,
  withCas,
} from './tree-fixtures.js'

/**
 * What a batch is, apart from the rules that read one statement: its identity, its lock
 * prelude, the names `fence()` hands out, the statements it generates, and what `run()`
 * reports. The rules that read a statement tree are in `fenced-batch-tree.test.ts`, and
 * each of their conditions has a registered mutation in the two verdict files. Each check
 * here is paired the same way: a shape it must refuse, and the nearest legitimate shape it
 * must still allow.
 */

/** A compare-and-set of the one event of queue `q`. */
const eventCas = () => loose.updateTable('events').set(FENCE_ASSIGNMENTS).where('queue', '=', 'q')
/** A compare-and-set of every run of queue `q`, for the many-row form. */
const queueCas = () => loose.updateTable('runs').set(FENCE_ASSIGNMENTS).where('queue', '=', 'q')
const taskCas = () =>
  loose
    .updateTable('tasks')
    .set({ state: 'x', ...FENCE_ASSIGNMENTS })
    .where('task_id', '=', 't')
/** The waits of the run this batch stamped. A DELETE writes no stamp. */
const fencedWaits = () =>
  loose.deleteFrom('waits').where((eb: Loose) => eb('run_id', 'in', fenced(eb).select('f.run_id')))
const anyRun = () => loose.selectFrom('runs').select('run_id')
/** The event, and the run, that this batch's compare-and-set stamped, as a fenced tail reads each. */
const fencedEvent = () =>
  loose.selectFrom('events').select('payload').where('fence_stamp', '=', fenceValue('win'))
const fencedRun = () =>
  loose.selectFrom('runs').select('run_id').where('fence_stamp', '=', fenceValue('win'))

describe('execution identity', () => {
  it('cannot be replaced through instance or prototype reflection', () => {
    const b = batch()
    if (!Object.isFrozen(b) || !Object.isFrozen(FencedBatch.prototype)) {
      throw new Error('regression:fenced-batch-execution-identity-is-immutable')
    }

    const replacement = (): never => {
      throw new Error('forged FencedBatch.run')
    }
    expect(Reflect.set(b, 'run', replacement)).toBe(false)
    expect(Reflect.defineProperty(b, 'run', { value: replacement })).toBe(false)
    expect(Reflect.set(FencedBatch.prototype, 'run', replacement)).toBe(false)
    expect(Reflect.setPrototypeOf(b, { run: replacement })).toBe(false)
  })
})

class FakeDb implements SqlExecutor {
  calls: {
    label: string
    statements: SqlStatement[]
    mode: SqlBatchMode
    control: SqlBatchControl
    transactionLock: SqlTransactionLock | undefined
  }[] = []
  constructor(
    private readonly counts: number[] = [],
    private readonly resultLimit?: number,
  ) {}
  batch(
    label: string,
    statements: readonly SqlStatement[],
    control: SqlBatchControl = 'write',
  ): Promise<SqlResult[]> {
    this.calls.push({
      label,
      statements: [...statements],
      mode: sqlBatchMode(control),
      control,
      transactionLock: sqlTransactionLock(control),
    })
    return Promise.resolve(
      statements
        .slice(0, this.resultLimit)
        .map((_, i) => ({ rows: [], rowsAffected: this.counts[i] ?? 0 })),
    )
  }
}

describe('closed transaction lock prelude', () => {
  it('passes only inert event coordinates ahead of the fenced SQL', async () => {
    type EventLock = Extract<SqlTransactionLock, { kind: 'event' }>
    type ClaimLock = Extract<SqlTransactionLock, { kind: 'claim' }>
    expectTypeOf<keyof EventLock>().toEqualTypeOf<'kind' | 'queue' | 'eventName'>()
    expectTypeOf<keyof ClaimLock>().toEqualTypeOf<'kind' | 'queue' | 'claimToken'>()
    expectTypeOf<keyof SqlLockedBatch>().toEqualTypeOf<'mode' | 'transactionLock'>()

    const sqlShapedCoordinate = `q'; DELETE FROM events; --`
    const db = new FakeDb([1])
    const b = batch('emit-event').casTree(
      'win',
      onEvent(eventCas(), sqlShapedCoordinate, sqlShapedCoordinate),
    )
    await b.run(db)

    const call = db.calls[0]
    expect(call?.transactionLock).toEqual({
      kind: 'event',
      queue: sqlShapedCoordinate,
      eventName: sqlShapedCoordinate,
    })
    expect(call?.transactionLock).not.toHaveProperty('sql')
    expect(Object.isFrozen(call?.transactionLock)).toBe(true)
    expect(Reflect.set(call?.transactionLock ?? {}, 'sql', 'DELETE FROM events')).toBe(false)
    expect(call?.control).toEqual({ mode: 'write', transactionLock: call?.transactionLock })
    expect(Object.isFrozen(call?.control)).toBe(true)
    expect(call?.statements).toHaveLength(1)
    expect(call?.statements[0]?.sql).not.toContain(sqlShapedCoordinate)
    expect(call?.statements[0]?.args).not.toContain(sqlShapedCoordinate)
  })

  it('takes a claim lock declared once, before SQL, and followed immediately by a CAS', () => {
    expect(() => withCas().lockClaim({ queue: 'q', claimToken: 'token' })).toThrow(
      /before every SQL statement/,
    )
    const claimed = () => batch().lockClaim({ queue: 'q', claimToken: 'token' })
    expect(() => claimed().lockClaim({ queue: 'q', claimToken: 'token' })).toThrow(/already has/)
    expect(() => claimed().openTailTree('probe', 'diagnostic read', statement(anyRun()))).toThrow(
      /followed immediately by a CAS/,
    )
  })

  it('holds one lock, which a second statement may name again', () => {
    const held = () => batch().casTree('win', onEvent(eventCas()))
    accepts('mutation-verdict:construction:batch-lock-may-be-named-again', () =>
      held().tailTree('again', onEvent(fencedEvent())),
    )
    refuses('mutation-verdict:construction:batch-holds-one-lock', /already has/, () =>
      held().tailTree('other', onEvent(fencedEvent(), 'q', 'another')),
    )
    // The same name in another queue is another event, and a claim lock is another lock.
    expect(() => held().tailTree('other', onEvent(fencedEvent(), 'another', 'e'))).toThrow(
      /already has/,
    )
    const claimed = batch().lockClaim({ queue: 'q', claimToken: 'token' })
    expect(() => claimed.casTree('win', onEvent(eventCas()))).toThrow(/already has/)
  })

  it('takes the lock a statement names wherever in the batch the statement stands', async () => {
    const db = new FakeDb([1, 0])
    await withCas().tailTree('read', onEvent(fencedRun())).run(db)
    expect(
      db.calls[0]?.transactionLock,
      'mutation-verdict:construction:batch-holds-the-lock-its-statement-names',
    ).toEqual({ kind: 'event', queue: 'q', eventName: 'e' })
  })

  it('is available only to a write transaction', async () => {
    const b = batch().casTree('win', onEvent(eventCas()))
    await expect(b.run(new FakeDb([1]), 'read')).rejects.toThrow(/requires a write batch/)
  })

  it('rejects a non-string coordinate for either closed lock kind', () => {
    expect(() => batch().casTree('win', onEvent(eventCas(), null as unknown as string))).toThrow(
      /coordinates must be strings/,
    )
    const unminted = defineStatement(
      'test',
      () => eventCas() as never,
      () => ({ queue: 'q', eventName: 'e' as unknown as EventName }),
    )({})
    expect(() => batch().casTree('win', unminted)).toThrow(/coordinates must be strings/)
    expect(() =>
      batch().lockClaim({ queue: 'q', claimToken: undefined as unknown as string }),
    ).toThrow(/coordinates must be strings/)
  })

  it('passes only inert claim coordinates ahead of the fenced claim CAS', async () => {
    const db = new FakeDb([1])
    const b = batch('claim')
      .lockClaim({ queue: 'q', claimToken: `token'; DELETE FROM runs; --` })
      .casManyTree('claim', statement(queueCas()), 1)
    await b.run(db)

    expect(db.calls[0]?.transactionLock).toEqual({
      kind: 'claim',
      queue: 'q',
      claimToken: `token'; DELETE FROM runs; --`,
    })
    expect(db.calls[0]?.transactionLock).not.toHaveProperty('sql')
  })
})

describe('fence() names a statement, and the primitive supplies the value', () => {
  it('refuses a name that is not in this batch', () => {
    expect(() => withCas().fence('typo')).toThrow(/names no statement/)
  })

  it('refuses a statement added LATER, whose provenance cannot exist yet', () => {
    const b = withCas()
    expect(() => b.fence('later')).toThrow(/names no statement/)
    b.followOnTree('later', statement(fencedWaits()), 'one')
    expect(() => b.fence('later')).toThrow(/writes no stamp/)
  })

  it('refuses a statement that writes no stamp', () => {
    const b = withCas()
    b.followOnTree('unstamped', statement(fencedWaits()), 'one')
    expect(() => b.fence('unstamped')).toThrow(/writes no stamp/)
  })

  it('accepts a stamping follow-on as a fence source', () => {
    const b = withCas()
    b.followOnTree('mirror', statement(taskFollowOn()), 'one')
    expect(() => b.fence('mirror')).not.toThrow()
  })

  it('accepts a generated UPDATE as a fence source', () => {
    const b = withCas()
    b.derived('mirror', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: taskStateValue('pending') },
      rows: 'one',
    })
    expect(() => b.fence('mirror')).not.toThrow()
  })

  it('does not let a generated UPDATE caller overwrite generated provenance', () => {
    const b = withCas()
    refuses(
      'mutation-verdict:construction:generated-set-provenance',
      /caller set controls provenance/,
      () =>
        b.derived('mirror', {
          relation: 'runs-to-tasks',
          fence: 'win',
          set: { state: `'pending'`, '[fence_stamp]': `'forged'` } as never,
          rows: 'one',
        }),
    )

    expect(() =>
      withCas().derived('rhs-escape', {
        relation: 'runs-to-tasks',
        fence: 'win',
        set: { failure_reason: `'pending', [fence_stamp] = 'forged'` },
        rows: 'one',
      }),
    ).toThrow(/escapes its generated assignment/)

    // What a set value may not do to the assignment generated around it. A row that
    // holds two problems is refused for the one that comes first in its text.
    const escapes: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['open-literal', `'pending`, /has an unterminated string/],
      ['open-escaped-literal', `'it''s`, /has an unterminated string/],
      ['closes-early', `'pending')`, /has an unmatched '\)'/],
      ['never-closes', `('pending'`, /has unbalanced parentheses/],
      ['second-statement', `'pending'; DELETE FROM runs`, /escapes its generated assignment/],
      ['comma-before-open-literal', `1, 'pending`, /escapes its generated assignment/],
      ['comma-inside-open-literal', `'pending, 1`, /has an unterminated string/],
      ['comment-inside-open-literal', `'pending # open`, /has an unterminated string/],
    ]
    for (const [name, value, refusal] of escapes) {
      expect(
        () =>
          withCas().derived(name, {
            relation: 'runs-to-tasks',
            fence: 'win',
            set: { failure_reason: value },
            rows: 'one',
          }),
        name,
      ).toThrow(refusal)
    }
    // Text that only looks like an escape inside a literal, or inside parentheses, stands.
    for (const [name, value] of [
      ['quoted', `'a, b; c # d -- e'`],
      ['grouped', `coalesce(task_name, 'pending')`],
    ] as const) {
      expect(
        () =>
          withCas().derived(name, {
            relation: 'runs-to-tasks',
            fence: 'win',
            set: { failure_reason: value },
            rows: 'one',
          }),
        name,
      ).not.toThrow()
    }

    expect(() =>
      withCas().derived('mysql-comment-escape', {
        relation: 'runs-to-tasks',
        fence: 'win',
        set: { failure_reason: `'pending' # provenance would be commented out` },
        rows: 'one',
      }),
    ).toThrow(/contains a SQL comment/)
  })

  it('keeps primary identity out of the public generated assignment surface', () => {
    const withTaskCas = () => batch().casTree('win', statement(taskCas()))
    const typecheckPrimaryKey = () =>
      withTaskCas().derived('does-not-compile', {
        relation: 'tasks-to-runs',
        fence: 'win',
        set: {
          // @ts-expect-error identity is private to exact self-relation sealing
          run_id: `'replacement'`,
        },
        rows: 'one',
      })
    void typecheckPrimaryKey

    refuses(
      'mutation-verdict:construction:generated-set-column-guard',
      /column 'run_id' is not writable/,
      () =>
        withTaskCas().derived('forged-primary-key', {
          relation: 'tasks-to-runs',
          fence: 'win',
          set: { run_id: `'replacement'` } as never,
          rows: 'one',
        }),
    )
  })

  it('seals an intermediate fence with a fresh stamp at the source instant', async () => {
    const b = withCas()
    b.seal('finished', {
      relation: 'runs-to-runs',
      fence: 'win',
      where: 'f.run_id = ?',
      whereArgs: ['r'],
      rows: 'one',
    })
    expect(() => b.fence('finished')).not.toThrow()

    const db = new FakeDb()
    await b.run(db)
    const sealed = db.calls[0]?.statements[1]
    expect(sealed?.sql).toContain('"run_id" = "run_id", "fence_stamp" = ?')
    expect(sealed?.args).toEqual(['seed:finished', 'r', 'seed:win', 'r', 'seed:win'])
  })

  it('rejects a later consumer of a sealed intermediate fence', () => {
    const b = withCas()
    b.seal('finished', {
      relation: 'runs-to-runs',
      fence: 'win',
      rows: 'one',
    })

    refuses(
      'mutation-verdict:construction:sealed-source-reuse',
      /fence 'win' was already sealed/,
      () =>
        b.derived('too-late', {
          relation: 'runs-to-tasks',
          fence: 'win',
          set: { state: taskStateValue('pending') },
          rows: 'one',
        }),
    )
  })

  it('rejects a forged relation id at runtime and at the type boundary', () => {
    const b = withCas()
    expect(() =>
      b.derived('wrong-pair', {
        relation: 'runs.task_id-to-runs.run_id' as never,
        fence: 'win',
        set: { state: taskStateValue('pending') },
        rows: 'one',
      }),
    ).toThrow(/unknown fence relation/)

    const typecheckInvalidRelation = () =>
      b.derived('does-not-compile', {
        // @ts-expect-error source and target identifiers come from this closed union
        relation: 'runs.task_id-to-runs.run_id',
        fence: 'win',
        set: { state: `'pending'` },
        rows: 'one',
      })
    void typecheckInvalidRelation
  })

  it('rejects a relation that reads from a table other than the fence source', () => {
    const b = withCas()
    refuses(
      'mutation-verdict:construction:derived-source-table',
      /fence 'win' stamps 'runs', but the statement compares waits\.fence_stamp/,
      () =>
        b.derived('wrong-source', {
          relation: 'waits-to-runs',
          fence: 'win',
          set: { state: `'pending'` },
          rows: 'one',
        }),
    )

    b.derived('mirror', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: taskStateValue('pending') },
      rows: 'one',
    })
    expect(() =>
      b.derived('wrong-follow-on-source', {
        relation: 'runs-to-waits',
        fence: 'mirror',
        rows: 'one',
      }),
    ).toThrow(/fence 'mirror' stamps 'tasks', but the statement compares runs\.fence_stamp/)
  })

  it('restricts sealing to relations that preserve both source table and key', () => {
    const b = withCas()
    const typecheckNonSelfRelation = () =>
      b.seal('does-not-compile', {
        // @ts-expect-error a seal must overwrite the exact source relation
        relation: 'runs-to-tasks',
        fence: 'win',
        rows: 'one',
      })
    void typecheckNonSelfRelation

    const forged = withCas()
    const forgedRuntime = new Proxy(forged, {
      get(target, property, receiver) {
        if (property === 'relation') {
          return () => ({
            target: 'runs',
            key: 'task_id',
            from: 'runs',
            column: 'run_id',
          })
        }
        return Reflect.get(target, property, receiver)
      },
    })
    refuses(
      'mutation-verdict:construction:seal-source-key',
      /does not target its own source key/,
      () =>
        forgedRuntime.seal('wrong-key', {
          relation: 'runs-to-runs',
          fence: 'win',
          rows: 'one',
        }),
    )
  })

  it('materializes self-source reads so MySQL may update the source table', async () => {
    const b = withCas()
    b.seal('finished', {
      relation: 'runs-to-runs',
      fence: 'win',
      rows: 'one',
    })

    const db = new FakeDb()
    await b.run(db)
    const update = db.calls[0]?.statements[1]?.sql ?? ''
    expect(update, 'mutation-verdict:construction:self-source-selection').toMatch(
      /in \(select "source_key" from \(select distinct "f"\."run_id" as "source_key" from "runs" as "f"/,
    )
    expect(update, 'mutation-verdict:construction:self-source-instant').toMatch(
      /select min\("source_fence_at_ms"\) as "source_instant" from \(select distinct "f"\."fence_at_ms" as "source_fence_at_ms" from "runs" as "f"/,
    )
    expect(update).toContain(') as "fenced_source"')
    expect(update).toContain(') as "fenced_source_instant"')
  })

  it('reduces a many-row provenance source to one portable scalar', async () => {
    const b = withCas()
    b.derived('spread', {
      relation: 'runs-to-tasks',
      fence: 'win',
      set: { state: taskStateValue('pending') },
      rows: 'source-keys',
    })

    const db = new FakeDb([1, 2])
    await b.run(db)
    const update = db.calls[0]?.statements.find((statement) =>
      statement.sql.startsWith('update "tasks"'),
    )
    expect(update?.sql).toContain('select min("f"."fence_at_ms")')
  })
})

describe('a follow-on is gated by a fence, and the shapes beside the refused ones stay legal', () => {
  const stamped = { state: 'failed', fence_stamp: stampValue, fence_at_ms: 5 }

  it('accepts a statement carrying both a positive and a negative fence', () => {
    // The terminal arm of `fail`: it fires when the successor was NOT written, and is
    // still keyed to the run this batch failed.
    const terminal = loose
      .updateTable('tasks')
      .set(stamped)
      .where((eb: Loose) => eb('task_id', 'in', tiedKeys(eb)))
      .where((eb: Loose) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('runs as s')
              .select('s.run_id')
              .where('s.run_id', '=', 'successor')
              .where('s.fence_stamp', '=', fenceValue('win')),
          ),
        ),
      )
    expect(() => withCas().followOnTree('terminal', statement(terminal), 'one')).not.toThrow()
  })

  it('accepts alternation inside a conjunct beside the gate', () => {
    const either = loose
      .updateTable('tasks')
      .set(stamped)
      .where((eb: Loose) => eb.or([eb('task_name', '=', 'a'), eb('task_name', '=', 'b')]))
      .where((eb: Loose) => eb('task_id', 'in', tiedKeys(eb)))
    expect(() => withCas().followOnTree('either', statement(either), 'one')).not.toThrow()
  })
})

describe('bookkeeping checks', () => {
  it('rejects a clock expression containing a bind parameter', () => {
    expect(() => batchWithClock(`? + 1`)).toThrow(/spliced as SQL/)
  })

  it('rejects duplicate statement names', () => {
    expect(() => withCas().casTree('win', statement(winCas()))).toThrow(/duplicate statement name/)
  })

  it('allows a CAS to bump a counter, because its guard consumes the pre-state', () => {
    // claim really does `claim_gen = claim_gen + 1`. Replaying it is safe: the CAS's own
    // guard no longer matches, so the bump cannot happen twice. A follow-on has no such
    // guard, because it keys on the post-state, which a replay reproduces exactly. That
    // is why the counting rule reads follow-ons only.
    const claim = loose
      .updateTable('runs')
      .set((eb: Loose) => ({ claim_gen: eb('claim_gen', '+', 1), ...FENCE_ASSIGNMENTS }))
      .where('queue', '=', 'q')
    expect(() => batch().casManyTree('c', statement(claim), 5)).not.toThrow()
  })

  it('does not mistake a derived value for a counter bump', () => {
    // Each of these is idempotent: the value comes from somewhere other than the column
    // being written, or it is a bound string that only quotes the shape.
    const derived = [
      taskFollowOn().set((eb) => ({ attempts: eb('infra_retries', '+', 1) })),
      taskFollowOn().set({ attempts: value<number>('infra_retries + 1') }),
      taskFollowOn().set({ failure_reason: '{"note":"attempts = attempts + 1"}' }),
    ]
    for (const assignment of derived) {
      expect(() => withCas().followOnTree('task', statement(assignment), 'one')).not.toThrow()
    }
  })

  it('cannot be constructed without the dialect that compiles its trees', () => {
    const refusal = /FencedBatch\[b\] needs the dialect that compiles its trees/
    // The type is the first rule. This line stops compiling if the dialect becomes optional.
    // @ts-expect-error a batch takes the dialect that compiles its statements
    expect(() => new FencedBatch('b', 'seed', { now: '0' })).toThrow(refusal)
    // Untyped code gets the same answer, and so does something that is not a dialect.
    const untyped = FencedBatch as unknown as new (...args: unknown[]) => FencedBatch
    expect(() => new untyped('b', 'seed', { now: '0' })).toThrow(refusal)
    expect(() => new untyped('b', 'seed', { now: '0', tree: {} })).toThrow(refusal)
  })

  it('rejects a batch with no CAS', async () => {
    // Only reachable through an open tail: a fenced statement cannot even be BUILT
    // without a CAS, because a fence has nothing to name.
    const b = batch().openTailTree('t', 'no transition here', statement(anyRun()))
    await expect(b.run(new FakeDb())).rejects.toThrow(/has no CAS/)
  })

  it('rejects a name that cannot be spliced into a fence token', () => {
    expect(() => batch().casTree('a:b', statement(winCas()))).toThrow(/name must match/)
  })

  it('rejects a casMany with a nonsense bound', () => {
    expect(() => batch().casManyTree('c', statement(queueCas()), 0)).toThrow(/positive integer/)
  })
})

describe('run() reports the outcome', () => {
  it('names the CAS that won and how many rows it took', async () => {
    const b = batch().casManyTree('c', statement(queueCas()), 5)
    expect(await b.run(new FakeDb([3]))).toMatchObject({ won: 'c', count: 3 })
  })

  it('reports no winner when the CAS matched nothing', async () => {
    expect(await withCas().run(new FakeDb([0]))).toMatchObject({ won: null, count: 0 })
  })

  it('rejects an executor result array shorter than the statement array', async () => {
    await expect(withCas().run(new FakeDb([], 0))).rejects.toThrow(
      /returned 0 results for 1 statement/,
    )
  })

  it('throws when two mutually exclusive CASes both won', async () => {
    const b = batch().casTree('a', statement(winCas())).casTree('b', statement(winCas()))
    await expect(b.run(new FakeDb([1, 1]))).rejects.toThrow(/both won/)
  })

  it('throws when a casMany exceeded its bound', async () => {
    const b = batch().casManyTree('c', statement(queueCas()), 2)
    await expect(b.run(new FakeDb([3]))).rejects.toThrow(/at most 2 allowed/)
  })

  it('throws when a follow-on declared one row and wrote more', async () => {
    const b = withCas().followOnTree('x', statement(fencedWaits()), 'one')
    await expect(b.run(new FakeDb([1, 2]))).rejects.toThrow(/declared 'one'/)
  })

  it('allows a declared many-row follow-on to write many', async () => {
    const b = withCas().followOnTree('x', statement(fencedWaits()), {
      many: 'a run may hold several waits',
    })
    await expect(b.run(new FakeDb([1, 9]))).resolves.toMatchObject({ won: 'win' })
  })
})
