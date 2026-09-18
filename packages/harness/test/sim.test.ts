import {
  EventName,
  FENCE_ASSIGNMENTS,
  FencedBatch,
  type SqlExecutor,
  type SqlTransactionLock,
  defineStatement,
  sqlTransactionLock,
  treeBuilder,
} from '@durablerun/core'
import { LibsqlExecutor, TREE_DIALECT } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { SimWorld, type TraceEntry } from '../src/index.js'

/**
 * The harness is tested against a deliberately racy toy: a counter updated by
 * read-then-write in TWO separate batches, so interleavings can lose updates.
 * The engine proper never does this (single fenced batches) — the toy exists
 * to prove the scheduler actually explores interleavings and replays by seed.
 */

async function counterWorld(
  seed: number | string,
): Promise<{ world: SimWorld; db: LibsqlExecutor }> {
  const db = LibsqlExecutor.open(':memory:')
  await db.batch('setup', [
    { sql: `CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`, args: [] },
    { sql: `INSERT INTO counter (id, value) VALUES (1, 0)`, args: [] },
  ])
  return { world: new SimWorld(db, seed), db }
}

function racyIncrement(world: SimWorld, name: string): void {
  world.actor(name, async (db) => {
    const [read] = await db.batch('read', [
      { sql: `SELECT value FROM counter WHERE id = 1`, args: [] },
    ])
    const value = Number(read?.rows[0]?.value)
    await db.batch('write', [
      { sql: `UPDATE counter SET value = ? WHERE id = 1`, args: [value + 1] },
    ])
  })
}

async function counterValue(db: LibsqlExecutor): Promise<number> {
  const [r] = await db.batch('check', [{ sql: `SELECT value FROM counter WHERE id = 1`, args: [] }])
  return Number(r?.rows[0]?.value)
}

async function runCounterScenario(
  seed: number | string,
): Promise<{ trace: TraceEntry[]; value: number }> {
  const { world, db } = await counterWorld(seed)
  racyIncrement(world, 'a')
  racyIncrement(world, 'b')
  await world.run()
  const value = await counterValue(db)
  db.close()
  return { trace: world.trace, value }
}

describe('deterministic scheduling', () => {
  it('replays the identical trace and outcome for the same seed', async () => {
    const first = await runCounterScenario('seed-1')
    const second = await runCounterScenario('seed-1')
    expect(second.trace).toEqual(first.trace)
    expect(second.value).toBe(first.value)
  })

  it('explores different interleavings across seeds (finds the lost update)', async () => {
    const values = new Set<number>()
    for (let seed = 0; seed < 30; seed++) {
      values.add((await runCounterScenario(seed)).value)
    }
    // Some schedules serialize the increments (2), some interleave the racy
    // read-modify-write and lose one (1). Both MUST occur across 30 seeds.
    expect(values).toEqual(new Set([1, 2]))
  })
})

describe('batch control forwarding', () => {
  it('keeps an event transaction lock attached through the simulated port', async () => {
    let observed: SqlTransactionLock | undefined
    const real: SqlExecutor = {
      batch: async (_label, statements, control) => {
        observed = sqlTransactionLock(control)
        return statements.map(() => ({ rows: [], rowsAffected: 1 }))
      },
    }
    const world = new SimWorld(real, 'locked-batch')
    world.actor('a', async (db) => {
      const stampEvents = defineStatement('stamp-events', () =>
        treeBuilder.updateTable('events').set(FENCE_ASSIGNMENTS).where('queue', '=', 'q'),
      )({})
      const batch = new FencedBatch('emit-event', 'seed', { now: '1', tree: TREE_DIALECT })
        .lockEvent({ queue: 'q', eventName: EventName.fromPort('test', 'e') })
        .casTree('event', stampEvents)
      await batch.run(db)
    })

    await world.run()
    expect(observed).toEqual({ kind: 'event', queue: 'q', eventName: 'e' })
  })
})

describe('crash injection', () => {
  it('crash-before prevents the write and marks the actor crashed', async () => {
    const { world, db } = await counterWorld(1)
    racyIncrement(world, 'a')
    world.injectCrash({ actor: 'a', label: 'write', when: 'before' })
    const results = await world.run()
    expect(results.get('a')).toMatchObject({ status: 'crashed' })
    expect(await counterValue(db)).toBe(0)
    db.close()
  })

  it('crash-after applies the write, then kills the actor', async () => {
    const { world, db } = await counterWorld(1)
    racyIncrement(world, 'a')
    world.injectCrash({ actor: 'a', label: 'write', when: 'after' })
    const results = await world.run()
    expect(results.get('a')).toMatchObject({ status: 'crashed' })
    expect(await counterValue(db)).toBe(1)
    db.close()
  })

  it('a crashed actor cannot issue further calls', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      await adb.batch('read', [{ sql: `SELECT value FROM counter WHERE id = 1`, args: [] }])
      await adb.batch('write', [{ sql: `UPDATE counter SET value = 99 WHERE id = 1`, args: [] }])
    })
    world.injectCrash({ actor: 'a', label: 'read', when: 'after' })
    const results = await world.run()
    expect(results.get('a')).toMatchObject({ status: 'crashed' })
    expect(await counterValue(db)).toBe(0)
    db.close()
  })

  it('occurrence targets the nth matching batch', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      for (let i = 0; i < 3; i++) {
        await adb.batch('bump', [
          { sql: `UPDATE counter SET value = value + 1 WHERE id = 1`, args: [] },
        ])
      }
    })
    world.injectCrash({ actor: 'a', label: 'bump', occurrence: 3, when: 'before' })
    await world.run()
    expect(await counterValue(db)).toBe(2)
    db.close()
  })
})

describe('failure propagation', () => {
  it('surfaces non-crash actor errors as sim failures', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      await adb.batch('boom', [{ sql: `SELECT * FROM missing_table`, args: [] }])
    })
    await expect(world.run()).rejects.toThrow(/actor 'a' failed/)
    db.close()
  })
})

describe('process-death semantics', () => {
  it("a crash purges the actor's other in-flight calls — a dead process has no effects", async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      // Concurrent heartbeat+step shape: both batches in flight at once.
      await Promise.all([
        adb.batch('step', [{ sql: `UPDATE counter SET value = value + 1 WHERE id = 1`, args: [] }]),
        adb.batch('heartbeat', [
          { sql: `UPDATE counter SET value = value + 100 WHERE id = 1`, args: [] },
        ]),
      ])
    })
    world.injectCrash({ actor: 'a', label: 'step', when: 'before' })
    const results = await world.run()
    expect(results.get('a')).toMatchObject({ status: 'crashed' })
    // Effects BEFORE death are real; the invariant is no effects AFTER it:
    // nothing of actor 'a' executes past the crash, and a heartbeat still
    // pending at crash time is purged as an orphan, never executed.
    const crashSeq = world.trace.findIndex((t) => t.outcome === 'crash-before')
    expect(crashSeq).toBeGreaterThanOrEqual(0)
    for (const entry of world.trace.slice(crashSeq + 1)) {
      expect(entry.outcome).not.toBe('ok')
    }
    const heartbeatRanBeforeCrash = world.trace.some(
      (t, i) => i < crashSeq && t.label === 'heartbeat' && t.outcome === 'ok',
    )
    expect(await counterValue(db)).toBe(heartbeatRanBeforeCrash ? 100 : 0)
    if (!heartbeatRanBeforeCrash) {
      expect(world.trace.some((t) => t.outcome === 'crash-orphan')).toBe(true)
    }
    db.close()
  })
})

describe('duplicate injection (at-least-once channel)', () => {
  it('executes the batch twice — the retry-after-lost-response shape', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      await adb.batch('bump', [
        { sql: `UPDATE counter SET value = value + 1 WHERE id = 1`, args: [] },
      ])
    })
    world.injectDuplicate({ label: 'bump' })
    const results = await world.run()
    expect(results.get('a')).toMatchObject({ status: 'done' })
    // A non-idempotent batch is visibly wrong under duplication — the exact
    // fault the engine's fenced batches must absorb invisibly.
    expect(await counterValue(db)).toBe(2)
    expect(world.trace.filter((t) => t.label === 'bump').map((t) => t.outcome)).toEqual([
      'dup',
      'ok',
    ])
    db.close()
  })
})

describe('injection-spec hygiene', () => {
  it('neutralizes stateful regex flags — /g must not alternate matches', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      for (let i = 0; i < 3; i++) {
        await adb.batch('bump', [
          { sql: `UPDATE counter SET value = value + 1 WHERE id = 1`, args: [] },
        ])
      }
    })
    world.injectCrash({ actor: 'a', label: /bump/g, occurrence: 2, when: 'before' })
    await world.run()
    // Crash lands before the SECOND bump, same as the string-label spec.
    expect(await counterValue(db)).toBe(1)
    db.close()
  })

  it('throws on ambiguous specs firing on the same call', async () => {
    const { world, db } = await counterWorld(1)
    racyIncrement(world, 'a')
    world.injectCrash({ label: 'write', when: 'before' })
    world.injectCrash({ actor: 'a', label: /wr.te/, when: 'after' })
    await expect(world.run()).rejects.toThrow(/ambiguous injection/)
    db.close()
  })

  it('throws when an injected spec never fires (vacuous-green prevention)', async () => {
    const { world, db } = await counterWorld(1)
    racyIncrement(world, 'a')
    world.injectCrash({ label: 'wr1te-typo', when: 'before' })
    await expect(world.run()).rejects.toThrow(/never fired/)
    db.close()
  })
})

describe('determinism-contract enforcement', () => {
  it('rejects re-entrant run()', async () => {
    const { world, db } = await counterWorld(1)
    racyIncrement(world, 'a')
    const first = world.run()
    await expect(world.run()).rejects.toThrow(/already active/)
    await first
    db.close()
  })

  it('detects an actor awaiting a non-port promise instead of hanging', async () => {
    const { world, db } = await counterWorld(1)
    world.actor('a', async (adb) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await adb.batch('late', [{ sql: `UPDATE counter SET value = 1 WHERE id = 1`, args: [] }])
    })
    await expect(world.run()).rejects.toThrow(/determinism contract violation/)
    db.close()
    // Let the actor's timer fire and its condemned batch reject (handled).
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
})
