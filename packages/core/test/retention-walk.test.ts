import { describe, expect, it } from 'vitest'
import {
  PURGE_BARRIER_CONDITIONS,
  PURGE_WALK_EXAMINED,
  PURGE_WALK_PAGE,
  type PurgeAdmission,
  type PurgeBarrierCondition,
  type PurgeCandidate,
  type PurgeCursor,
  type PurgeWalkReport,
  type Retention,
  type RetentionPolicy,
  childSpawnKey,
  purgeWalk,
} from '../src/index.js'

/**
 * The walk of a purge (DESIGN.md §3.12), over a queue held in memory behind the port's
 * three methods. The stores hold what the port answers. What is held here is what the
 * walk does with those answers: which unit it looks at and how often, when it stops, what
 * it says of where it stopped, and what it reports of a call that failed.
 */

const Q = 'q'
const POLICY: RetentionPolicy = { completedSeconds: 3_600, cancelledSeconds: 3_600 }
const ROWS = { tasks: 1, runs: 1, checkpoints: 0, waits: 0, events: 1 }

/** An ended unit, and the conditions of the barrier that are false of it while other units stand. */
interface Unit {
  readonly taskId: string
  readonly endedAtMs: number
  readonly idempotencyKey?: string
  readonly keptBy?: (there: ReadonlyMap<string, Unit>) => readonly PurgeBarrierCondition[]
}

/** A call of the port that fails, and whether a purge it ends had committed. */
interface Lost {
  readonly call: keyof Retention
  readonly occurrence: number
  readonly committed?: boolean
}

function queueOf(units: readonly Unit[], lost?: Lost) {
  const there = new Map(units.map((unit) => [unit.taskId, unit]))
  const calls: Record<keyof Retention, number> = {
    purgeCandidates: 0,
    purgeUnit: 0,
    purgeAdmission: 0,
  }
  /** How often each unit's purge was sent. */
  const tried = new Map<string, number>()
  const count = (call: keyof Retention): boolean => {
    calls[call] += 1
    return lost?.call === call && lost.occurrence === calls[call]
  }
  const notHeld = (unit: Unit) => unit.keptBy?.(there) ?? []
  const port: Retention = {
    purgeCandidates: async (_queue, _policy, { limit, after }) => {
      if (count('purgeCandidates')) throw new Error('the listing was lost')
      const behind = [...there.values()]
        .sort(
          (left, right) =>
            left.endedAtMs - right.endedAtMs || (left.taskId < right.taskId ? -1 : 1),
        )
        .filter(
          (unit) =>
            after === undefined ||
            unit.endedAtMs > after.endedAtMs ||
            (unit.endedAtMs === after.endedAtMs && unit.taskId > after.taskId),
        )
      const page = behind.slice(0, limit)
      const last = page[page.length - 1]
      return {
        candidates: page.map(
          ({ taskId, endedAtMs, idempotencyKey }): PurgeCandidate => ({
            taskId,
            taskName: 'job',
            state: 'completed',
            endedAtMs,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          }),
        ),
        next:
          behind.length > limit && last !== undefined
            ? { endedAtMs: last.endedAtMs, taskId: last.taskId }
            : null,
      }
    },
    purgeUnit: async (_queue, { taskId }) => {
      tried.set(taskId, (tried.get(taskId) ?? 0) + 1)
      const fails = count('purgeUnit')
      const unit = there.get(taskId)
      const goes = unit !== undefined && notHeld(unit).length === 0
      if (fails) {
        if (goes && lost?.committed === true) there.delete(taskId)
        throw new Error('the answer of a purge was lost')
      }
      if (!goes) return null
      there.delete(taskId)
      return { taskId, rows: ROWS }
    },
    purgeAdmission: async (_queue, { taskId }) => {
      if (count('purgeAdmission')) throw new Error('the read of the barrier was lost')
      const unit = there.get(taskId)
      if (unit === undefined) return null
      const off = notHeld(unit)
      return {
        holds: Object.fromEntries(
          PURGE_BARRIER_CONDITIONS.map((condition) => [condition, !off.includes(condition)]),
        ) as PurgeAdmission['holds'],
      }
    },
  }
  return { port, there, calls, tried }
}

/** A unit nothing keeps. */
const free = (taskId: string, endedAtMs: number): Unit => ({ taskId, endedAtMs })
/** A unit a condition no purge frees keeps for ever. */
const stuck = (taskId: string, endedAtMs: number): Unit => ({
  taskId,
  endedAtMs,
  keptBy: () => ['noLiveRun'],
})
/** A child its parent keeps while the parent stands. */
const childOf = (parent: string, taskId: string, endedAtMs: number): Unit => ({
  taskId,
  endedAtMs,
  idempotencyKey: childSpawnKey(parent, 'step'),
  keptBy: (there) => (there.has(parent) ? ['parentCannotRunAgain'] : []),
})

const said = (report: PurgeWalkReport) => ({
  taken: report.taken.map(({ candidate }) => candidate.taskId),
  kept: report.kept.map(({ candidate, admission }) => [
    candidate.taskId,
    PURGE_BARRIER_CONDITIONS.filter((condition) => !admission.holds[condition]),
  ]),
  gone: report.gone.map(({ taskId }) => taskId),
  examined: report.examined,
  more: report.more,
  resumeAfter: report.resumeAfter,
})
const ids = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, '0')}`)

describe('one walk is one pass', () => {
  it('takes a unit that a unit it took had kept, and a unit that one had kept, and a repeat does nothing', async () => {
    const queue = queueOf([
      childOf('child', 'grandchild', 1),
      childOf('parent', 'child', 2),
      free('parent', 3),
      stuck('stuck', 4),
    ])
    const first = await purgeWalk(queue.port, Q, POLICY, { limit: 10, execute: true })
    const calls = { ...queue.calls }
    const again = await purgeWalk(queue.port, Q, POLICY, { limit: 10, execute: true })
    expect({ first: said(first), calls, again: said(again) }).toEqual({
      // Four first looks, then the child, then the grandchild. The unit a purge cannot
      // free is looked at once.
      first: {
        taken: ['parent', 'child', 'grandchild'],
        kept: [['stuck', ['noLiveRun']]],
        gone: [],
        examined: 6,
        more: false,
        resumeAfter: null,
      },
      calls: { purgeCandidates: 1, purgeUnit: 6, purgeAdmission: 3 },
      again: {
        taken: [],
        kept: [['stuck', ['noLiveRun']]],
        gone: [],
        examined: 1,
        more: false,
        resumeAfter: null,
      },
    })
  })

  it('without execute reads each unit once as the queue stands, and deletes nothing', async () => {
    const queue = queueOf([childOf('parent', 'child', 1), free('parent', 2)])
    const dry = await purgeWalk(queue.port, Q, POLICY, { limit: 10 })
    expect({
      dry: said(dry),
      rows: dry.taken.map(({ rows }) => rows),
      calls: { ...queue.calls },
      there: [...queue.there.keys()],
    }).toEqual({
      dry: {
        taken: ['parent'],
        kept: [['child', ['parentCannotRunAgain']]],
        gone: [],
        examined: 2,
        more: false,
        resumeAfter: null,
      },
      rows: [null],
      calls: { purgeCandidates: 1, purgeUnit: 0, purgeAdmission: 2 },
      there: ['child', 'parent'],
    })
  })

  it('tries a unit again only when a unit taken since could be what kept it', async () => {
    const held: Unit = {
      taskId: 'held',
      endedAtMs: 1,
      keptBy: (there) => (there.has('holder') ? ['noRunHoldsTheOutcome'] : []),
    }
    const young: Unit = {
      taskId: 'young-child',
      endedAtMs: 2,
      idempotencyKey: childSpawnKey('parent', 'step'),
      keptBy: () => ['endedAWindowAgo', 'parentCannotRunAgain'],
    }
    // A child whose parent stands, and is no candidate of this walk.
    const underALiveParent: Unit = {
      taskId: 'under-a-live-parent',
      endedAtMs: 3,
      idempotencyKey: childSpawnKey('a-live-parent', 'step'),
      keptBy: () => ['parentCannotRunAgain'],
    }
    const queue = queueOf([held, young, underALiveParent, free('holder', 4), free('parent', 5)])
    const walked = await purgeWalk(queue.port, Q, POLICY, { limit: 10, execute: true })
    expect({ ...said(walked), tried: Object.fromEntries(queue.tried) }).toEqual({
      taken: ['holder', 'parent', 'held'],
      kept: [
        ['young-child', ['endedAWindowAgo', 'parentCannotRunAgain']],
        ['under-a-live-parent', ['parentCannotRunAgain']],
      ],
      gone: [],
      examined: 6,
      more: false,
      resumeAfter: null,
      // What an outcome's holder kept is tried again after a take. What its age keeps is
      // not, though its parent went, and neither is the child of a parent that stands.
      tried: { held: 2, 'young-child': 1, 'under-a-live-parent': 1, holder: 1, parent: 1 },
    })
  })

  it('lists a unit that is not there when it looks as gone', async () => {
    const queue = queueOf([free('a', 1), free('b', 2)])
    const port: Retention = {
      ...queue.port,
      purgeUnit: async (name, unit, policy) => {
        // Another purger takes `a` first.
        if (unit.taskId === 'a') queue.there.delete('a')
        return queue.port.purgeUnit(name, unit, policy)
      },
    }
    expect(said(await purgeWalk(port, Q, POLICY, { limit: 10, execute: true }))).toEqual({
      taken: ['b'],
      kept: [],
      gone: ['a'],
      examined: 2,
      more: false,
      resumeAfter: null,
    })
  })
})

describe('what bounds a walk', () => {
  it('stops at the candidates it may examine, says where, and walks resumed there reach what stands behind with one look at each unit', async () => {
    const kept = ids(250, 'kept')
    const behind = ids(3, 'zfree')
    const queue = queueOf([
      ...kept.map((taskId, index) => stuck(taskId, index)),
      ...behind.map((taskId, index) => free(taskId, 1_000 + index)),
    ])
    const walks: unknown[] = []
    let after: PurgeCursor | undefined
    for (let walk = 0; walk < 5; walk++) {
      const walked = await purgeWalk(queue.port, Q, POLICY, {
        limit: 10,
        examine: 120,
        execute: true,
        ...(after === undefined ? {} : { after }),
      })
      walks.push([walked.examined, walked.kept.length, walked.taken.length, walked.more])
      if (walked.resumeAfter === null) break
      after = walked.resumeAfter
    }
    expect({
      walks,
      listings: queue.calls.purgeCandidates,
      mostLooksAtOneUnit: Math.max(...queue.tried.values()),
      left: queue.there.size,
    }).toEqual({
      walks: [
        [120, 120, 0, true],
        [120, 120, 0, true],
        [13, 10, 3, false],
      ],
      // Two pages for each walk that read 120 candidates, and one for the last.
      listings: 5,
      mostLooksAtOneUnit: 1,
      left: 250,
    })
  })

  it('examines no more than its cap when no bound is named, and a page is not the limit', async () => {
    const queue = queueOf([
      ...ids(PURGE_WALK_EXAMINED + 1, 'kept').map((taskId, index) => stuck(taskId, index)),
      free('zfree', 5_000),
    ])
    const first = await purgeWalk(queue.port, Q, POLICY, { limit: 1, execute: true })
    const listings = queue.calls.purgeCandidates
    const next = await purgeWalk(queue.port, Q, POLICY, {
      limit: 1,
      execute: true,
      ...(first.resumeAfter === null ? {} : { after: first.resumeAfter }),
    })
    expect({
      first: [first.examined, first.taken.length, first.more, first.resumeAfter?.taskId],
      listings,
      next: [next.examined, said(next).taken, next.more, next.resumeAfter],
    }).toEqual({
      first: [
        PURGE_WALK_EXAMINED,
        0,
        true,
        `kept-${String(PURGE_WALK_EXAMINED - 1).padStart(4, '0')}`,
      ],
      listings: PURGE_WALK_EXAMINED / PURGE_WALK_PAGE,
      next: [2, ['zfree'], false, null],
    })
  })

  it('stops inside a page when its limit is met, and sends no listing to learn whether more remain', async () => {
    const exact = queueOf(ids(PURGE_WALK_PAGE, 'free').map((taskId, index) => free(taskId, index)))
    const over = queueOf(
      ids(PURGE_WALK_PAGE + 1, 'free').map((taskId, index) => free(taskId, index)),
    )
    const inside = queueOf(ids(5, 'free').map((taskId, index) => free(taskId, index)))
    const all = await purgeWalk(exact.port, Q, POLICY, { limit: PURGE_WALK_PAGE, execute: true })
    const page = await purgeWalk(over.port, Q, POLICY, { limit: PURGE_WALK_PAGE, execute: true })
    const two = await purgeWalk(inside.port, Q, POLICY, { limit: 2, execute: true })
    expect({
      all: [all.taken.length, all.more, all.resumeAfter, exact.calls.purgeCandidates],
      page: [page.taken.length, page.more, page.resumeAfter?.taskId, over.calls.purgeCandidates],
      two: [said(two).taken, two.more, two.resumeAfter?.taskId, inside.calls.purgeCandidates],
    }).toEqual({
      // The limit is exactly what there was: nothing follows the page, so no more remain.
      all: [PURGE_WALK_PAGE, false, null, 1],
      // One unit follows the page, which the page itself says.
      page: [PURGE_WALK_PAGE, true, 'free-0099', 1],
      two: [['free-0000', 'free-0001'], true, 'free-0001', 1],
    })
  })

  it('says more when a kept unit is owed a try that its limit left no room for', async () => {
    const queue = queueOf([childOf('parent', 'child', 1), free('parent', 2)])
    const walked = await purgeWalk(queue.port, Q, POLICY, { limit: 1, execute: true })
    const again = await purgeWalk(queue.port, Q, POLICY, { limit: 1, execute: true })
    expect([said(walked), said(again)]).toEqual([
      {
        taken: ['parent'],
        kept: [['child', ['parentCannotRunAgain']]],
        gone: [],
        examined: 2,
        more: true,
        resumeAfter: null,
      },
      { taken: ['child'], kept: [], gone: [], examined: 1, more: false, resumeAfter: null },
    ])
  })

  it('refuses a limit or a number to examine that is no positive whole number, and one over the cap', async () => {
    const { port, calls } = queueOf([free('a', 1)])
    const refused: string[] = []
    for (const bounds of [
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1, examine: 0 },
      { limit: 1, examine: PURGE_WALK_EXAMINED + 1 },
    ]) {
      await purgeWalk(port, Q, POLICY, bounds).then(
        () => refused.push(`taken: ${JSON.stringify(bounds)}`),
        () => undefined,
      )
    }
    expect({ refused, calls }).toEqual({
      refused: [],
      calls: { purgeCandidates: 0, purgeUnit: 0, purgeAdmission: 0 },
    })
  })
})

describe('a call of the port that fails', () => {
  it('ends the walk, which answers what it had reached and the call it stopped at, and throws nothing', async () => {
    const units = () => [free('a', 1), stuck('b', 2), free('c', 3)]
    const shown = async (lost: Lost) => {
      const queue = queueOf(units(), lost)
      const walked = await purgeWalk(queue.port, Q, POLICY, { limit: 10, execute: true })
      return {
        ...said(walked),
        notKnown: walked.outcomeNotKnown.map(({ taskId }) => taskId),
        failed: [walked.failed?.call, walked.failed?.taskId],
        left: [...queue.there.keys()],
      }
    }
    const stopped = { gone: [], more: true, resumeAfter: null }
    expect({
      listing: await shown({ call: 'purgeCandidates', occurrence: 1 }),
      purgeNotCommitted: await shown({ call: 'purgeUnit', occurrence: 3 }),
      purgeCommitted: await shown({ call: 'purgeUnit', occurrence: 3, committed: true }),
      barrier: await shown({ call: 'purgeAdmission', occurrence: 1 }),
    }).toEqual({
      listing: {
        ...stopped,
        taken: [],
        kept: [],
        examined: 0,
        notKnown: [],
        failed: ['purgeCandidates', undefined],
        left: ['a', 'b', 'c'],
      },
      // The purge of `c` was sent and not answered. It is in doubt whether it went or not.
      purgeNotCommitted: {
        ...stopped,
        taken: ['a'],
        kept: [['b', ['noLiveRun']]],
        examined: 3,
        notKnown: ['c'],
        failed: ['purgeUnit', 'c'],
        left: ['b', 'c'],
      },
      purgeCommitted: {
        ...stopped,
        taken: ['a'],
        kept: [['b', ['noLiveRun']]],
        examined: 3,
        notKnown: ['c'],
        failed: ['purgeUnit', 'c'],
        left: ['b'],
      },
      // The purge kept `b`, and the read of why was lost: `b` is in no list.
      barrier: {
        ...stopped,
        taken: ['a'],
        kept: [],
        examined: 2,
        notKnown: [],
        failed: ['purgeAdmission', 'b'],
        left: ['b', 'c'],
      },
    })
  })
})
