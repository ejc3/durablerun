import { engineInvariantViolations } from '@durablerun/conformance'
import { operatorReads } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import { runFuzzScenario } from '../../conformance/src/fuzz.js'
import { makeLibsqlFixture } from '../../conformance/test/fixture-libsql.js'
import { explained } from '../src/main.js'

/**
 * The seeds of `explain` are one for each cause of its table, which holds that every cause
 * has a state. This case holds the other direction, which is the property: every state the
 * engine leaves a task in has a cause. It runs the conformance package's fuzz walk on
 * libSQL, a seeded random walk over the store's whole transition surface, and when a walk
 * ends it diagnoses every task the walk left, as the command does, through the same reads
 * and the same evidence. The walk holds the engine's invariants at every tenth step and at
 * its end, so each task it leaves is in a state the engine may leave it in.
 */

/** The walks: these seeds, each this many steps. A failing seed replays exactly. */
const SEEDS = Array.from({ length: 24 }, (_, seed) => `explain-${seed}`)
const STEPS = 100

/**
 * How many distinct causes the walks must reach, so a walk that reaches nothing fails.
 * Measured when the case was written: these walks left 395 tasks under 17 causes. The
 * floor sits below that, so a change to the walk that moves a seed does not fail the case
 * for a cause or two, and a walk that stops reaching most states does.
 */
const CAUSES_FLOOR = 14

describe('explain over a walk of the engine', () => {
  it('names a cause for every task a walk leaves, and none is unexplained or inconsistent', async () => {
    const seen = new Map<string, number>()
    const unnamed: string[] = []
    let tasks = 0
    for (const seed of SEEDS) {
      await runFuzzScenario(makeLibsqlFixture, seed, STEPS, async (fixture) => {
        expect(await engineInvariantViolations(fixture.raw)).toEqual([])
        const store = { operator: operatorReads(fixture.raw), scheduler: fixture.store }
        const [listed] = await fixture.raw.batch(
          'fixture:walk-tasks',
          [{ sql: 'SELECT queue, task_id FROM tasks ORDER BY task_id', args: [] }],
          'read',
        )
        for (const row of listed?.rows ?? []) {
          const taskId = String(row.task_id)
          const found = await explained(store, String(row.queue), taskId, 0)
          if (found === null) throw new Error(`walk ${seed}: task ${taskId} is listed and not read`)
          tasks++
          const { cause, verdict } = found.diagnosis
          seen.set(cause, (seen.get(cause) ?? 0) + 1)
          if (verdict === 'unexplained' || verdict === 'inconsistent') {
            const state = found.facts.task.state
            unnamed.push(`walk ${seed}: a ${state} task read as ${cause}, ${verdict}`)
          }
        }
      })
    }
    expect(
      unnamed,
      'mutation-verdict:behavior:cli-explain-names-every-state-a-walk-leaves',
    ).toEqual([])
    // The floor: the walks reached this many causes, the backoff of a retry among them.
    const reached = [...seen.keys()].sort()
    expect({ tasks: tasks > 0, enough: reached.length >= CAUSES_FLOOR, reached }).toEqual({
      tasks: true,
      enough: true,
      reached,
    })
    expect(reached).toContain('backing-off')
  }, 300_000)
})
