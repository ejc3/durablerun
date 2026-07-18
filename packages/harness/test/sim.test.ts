import { LibsqlExecutor } from '@absurd-lite/store-libsql'
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
