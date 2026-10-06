import * as entry from '@durablerun/core'
import { FencedBatch, childSpawnKey, sqlFragment } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore, NOW_MS, TREE_DIALECT, retention } from '../src/index.js'
import { openTestDb } from '../src/testing.js'

/**
 * A purge decides inside its compare-and-set whether a unit may go (DESIGN.md §3.12): the
 * policy's windows, the parent the unit's key names, and the proof that the stamp is a
 * stored instant. Those are the barrier's inputs. Whoever can hand a purge's builder
 * inputs of their own choosing has no barrier in front of them, so the package's entry
 * hands out nothing that builds a purge from them. The port is the one way in.
 */
describe('the entry of core, asked for a purge the port refuses', () => {
  it('builds no batch that deletes a child that completed a moment ago under a parent that is still running', async () => {
    const { raw, ids, close } = await openTestDb({ nowMs: 1_000_000 })
    try {
      const store = new LibsqlSchedulerStore(raw, ids)
      const claimed = async (worker: string) => {
        const [run] = await store.claim('q', worker, { leaseSeconds: 60, limit: 1 })
        if (run === undefined) throw new Error(`${worker} claimed nothing`)
        await store.activate('q', run.runId, run.claimToken, run.claimGen)
        return run
      }
      const parent = await store.spawn('q', 'parent', '{}')
      const parentRun = await claimed('w-parent')
      const childOf = {
        parentQueue: 'q',
        parentTaskId: parent.taskId,
        runId: parentRun.runId,
        claimToken: parentRun.claimToken,
        replayKey: 'child#1',
      }
      const child = await store.spawn('q', 'child', '{}', { childOf })
      const childRun = await claimed('w-child')
      await store.complete('q', childRun.runId, childRun.claimToken, '"done"')
      const key = childSpawnKey(parent.taskId, 'child#1')
      const everyState = { completedSeconds: 3_600, cancelledSeconds: 3_600, failedSeconds: 3_600 }

      // The port keeps the unit: no window has passed, and its parent can still run.
      const throughThePort = await retention(raw, ids).purgeUnit(
        'q',
        { taskId: child.taskId, idempotencyKey: key },
        everyState,
      )

      // The same purge asked of whatever the entry exports, with a barrier of the caller's
      // own: no window, no parent, and a stamp proof that proves nothing.
      const exported: Readonly<Record<string, unknown>> = entry
      const builders = [
        'addUnitPurge',
        'purgeUnitCas',
        'purgedUnitRowsRead',
        'purgedTaskDelete',
        'purgeCandidatesRead',
      ].filter((name) => typeof exported[name] === 'function')
      let won: unknown = 'the entry exports no builder of a purge'
      const addUnitPurge = exported.addUnitPurge
      if (typeof addUnitPurge === 'function') {
        const batch = new FencedBatch('not-the-port', 'a-caller', {
          now: NOW_MS,
          tree: TREE_DIALECT,
        })
        addUnitPurge(batch, {
          queue: 'q',
          taskId: child.taskId,
          idempotencyKey: key,
          parentTaskId: null,
          windowsMs: { completed: 0, failed: 0, cancelled: 0 },
          stampStored: sqlFragment('1 = 1'),
        })
        won = (await batch.run(raw)).won
      }

      const one = async (sql: string, args: string[]) =>
        (await raw.batch('what-is-left', [{ sql, args }], 'read'))[0]?.rows[0]
      const replayed = await store.spawn('q', 'child', '{}', { childOf })
      expect({
        throughThePort,
        builders,
        won,
        childRows: Number(
          (await one('SELECT COUNT(*) AS n FROM tasks WHERE task_id = ?', [child.taskId]))?.n,
        ),
        parentState: (await one('SELECT state FROM tasks WHERE task_id = ?', [parent.taskId]))
          ?.state,
        replayedSpawn: { created: replayed.created, sameChild: replayed.taskId === child.taskId },
      }).toEqual({
        throughThePort: null,
        builders: [],
        won: 'the entry exports no builder of a purge',
        childRows: 1,
        parentState: 'running',
        replayedSpawn: { created: false, sameChild: true },
      })
    } finally {
      close()
    }
  })
})
