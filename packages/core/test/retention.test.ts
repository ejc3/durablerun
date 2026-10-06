import { describe, expect, it } from 'vitest'
import {
  EventName,
  MAX_DURATION_MS,
  MIN_RETENTION_SECONDS,
  PortRefusalError,
  type RetentionPolicy,
  addUnitPurge,
  childSpawnKey,
  treeBuilder as db,
  defineStatement,
  fenceValue,
  nowValue,
  retentionWindowsMs,
  spawningParent,
  sqlFragment,
  stampValue,
} from '../src/index.js'
import { batch, capturingExecutor, statement, withCas } from './tree-fixtures.js'

const HOUR: RetentionPolicy = { completedSeconds: 3_600, cancelledSeconds: 3_600 }

describe('a retention policy', () => {
  it('names a window of at least an hour for completed and for cancelled tasks, and may name one for failed tasks', () => {
    expect(MIN_RETENTION_SECONDS).toBe(3_600)
    expect(retentionWindowsMs(HOUR)).toEqual({
      completed: 3_600_000,
      failed: null,
      cancelled: 3_600_000,
    })
    expect(retentionWindowsMs({ ...HOUR, failedSeconds: 7_200 })).toEqual({
      completed: 3_600_000,
      failed: 7_200_000,
      cancelled: 3_600_000,
    })
    // The longest window is the longest duration the engine takes.
    const longest = MAX_DURATION_MS / 1_000
    expect(retentionWindowsMs({ ...HOUR, completedSeconds: longest }).completed).toBe(
      MAX_DURATION_MS,
    )
  })

  it('is refused when a window is under an hour, is no whole number of seconds, or is missing', () => {
    const refused: Readonly<Record<string, unknown>> = {
      'a completed window one second under an hour': { ...HOUR, completedSeconds: 3_599 },
      'a cancelled window one second under an hour': { ...HOUR, cancelledSeconds: 3_599 },
      'a failed window one second under an hour': { ...HOUR, failedSeconds: 3_599 },
      'a failed window of nothing': { ...HOUR, failedSeconds: 0 },
      'a negative window': { ...HOUR, completedSeconds: -3_600 },
      'a window that is no whole number': { ...HOUR, completedSeconds: 3_600.5 },
      'a window that is not a number': { ...HOUR, completedSeconds: Number.NaN },
      'an endless window': { ...HOUR, cancelledSeconds: Number.POSITIVE_INFINITY },
      'a window past the longest duration': {
        ...HOUR,
        completedSeconds: MAX_DURATION_MS / 1_000 + 1,
      },
      'a window written as text': { ...HOUR, cancelledSeconds: '3600' },
      'a failed window that is null': { ...HOUR, failedSeconds: null },
      'no completed window': { cancelledSeconds: 3_600 },
      'no cancelled window': { completedSeconds: 3_600 },
      'no policy': null,
      'a policy that is no object': 3_600,
    }
    const accepted = Object.entries(refused).flatMap(([what, policy]) => {
      try {
        retentionWindowsMs(policy as RetentionPolicy)
        return [what]
      } catch (error) {
        return error instanceof PortRefusalError ? [] : [`${what}: ${String(error)}`]
      }
    })
    expect(accepted).toEqual([])
  })
})

describe('the task that spawned a task, read from its key', () => {
  it('is nobody for a task with no key or a key of its caller, and the parent a child key names', () => {
    expect(spawningParent(null)).toEqual({ known: true, taskId: null })
    expect(spawningParent('order-7')).toEqual({ known: true, taskId: null })
    expect(spawningParent(childSpawnKey('parent-1', 'site#1'))).toEqual({
      known: true,
      taskId: 'parent-1',
    })
    // A parent's id and a call site may each hold the delimiter.
    expect(spawningParent(childSpawnKey('a:b', 'c:d'))).toEqual({ known: true, taskId: 'a:b' })
  })

  it('is not known for a key in the reserved namespace that the builder could not have built', () => {
    for (const key of ['$spawn:', '$spawn:nonsense', '$spawn:9:short:site', '$spawn:1:']) {
      expect(spawningParent(key), key).toEqual({ known: false })
    }
  })
})

/** A compare-and-set that stamps a task and is no purge. */
const stampedTask = () =>
  db
    .updateTable('tasks')
    .set({ fence_stamp: stampValue, fence_at_ms: nowValue })
    .where('task_id', '=', 't1')

/** The rows of `table` that `key` ties to the run an ordinary compare-and-set stamped. */
const deleteUnder = (table: 'tasks' | 'runs' | 'checkpoints' | 'events' | 'waits') => {
  const fenced = (column: 'task_id' | 'run_id' | 'queue') =>
    db
      .selectFrom('runs as f')
      .select(`f.${column}`)
      .where('f.run_id', '=', 'r1')
      .where('f.fence_stamp', '=', fenceValue('win'))
  switch (table) {
    case 'tasks':
      return db.deleteFrom('tasks').where('task_id', 'in', fenced('task_id'))
    case 'checkpoints':
      return db.deleteFrom('checkpoints').where('task_id', 'in', fenced('task_id'))
    case 'runs':
      return db.deleteFrom('runs').where('fence_stamp', '=', fenceValue('win'))
    case 'events':
      return db.deleteFrom('events').where('queue', 'in', fenced('queue'))
    case 'waits':
      return db.deleteFrom('waits').where('run_id', 'in', fenced('run_id'))
  }
}

describe("the rule that only a purge deletes a row of a task's unit", () => {
  for (const table of ['tasks', 'runs', 'checkpoints', 'events'] as const) {
    it(`refuses a delete of ${table} under the stamp of a compare-and-set that is no purge`, () => {
      expect(() =>
        withCas().followOnTree('gone', statement(deleteUnder(table)), { many: 'a test' }),
      ).toThrow(
        new RegExp(
          `deletes from ${table}, and the stamp that gates it is not the purge of a task's unit`,
        ),
      )
    })
  }

  it('takes a delete of waits under any stamp, as every batch that ends or parks a run sends one', () => {
    expect(() =>
      withCas().followOnTree('gone', statement(deleteUnder('waits')), { many: 'a test' }),
    ).not.toThrow()
  })

  it('takes every delete of a unit under the stamp of the purge, in the order the batch sends them', async () => {
    const b = batch('purge-unit')
    addUnitPurge(b, {
      queue: 'q',
      taskId: 't1',
      idempotencyKey: 'order-7',
      parentTaskId: null,
      windowsMs: { completed: 3_600_000, failed: null, cancelled: 3_600_000 },
      stampStored: sqlFragment("typeof(fence_at_ms) = 'integer'"),
    })
    const { captured, executor } = capturingExecutor(1)
    await b.run(executor).catch(() => undefined)
    // Each statement by its verb and the table it writes, or by its verb alone for a read.
    const shape = ({ sql }: { sql: string }) => {
      const written = /^(update|delete from) "(\w+)"/.exec(sql)
      return written === null ? sql.slice(0, sql.indexOf(' ')) : `${written[1]} ${written[2]}`
    }
    expect(captured.map(shape)).toEqual([
      'update tasks',
      'select',
      'delete from checkpoints',
      'update runs',
      'delete from waits',
      'delete from runs',
      'delete from events',
      'delete from tasks',
    ])
  })
})

describe('a generated delete of an event', () => {
  const ofTheTask = {
    relation: 'tasks-to-events',
    fence: 'win',
    where: 'f.task_id = ?',
    whereArgs: ['t1'],
    rows: 'one',
  } as const

  it('is refused in a batch that holds no lock of an event', () => {
    expect(() =>
      batch().casTree('win', statement(stampedTask())).derived('event', ofTheTask),
    ).toThrow(/deletes an event, and the batch holds no completion event's lock/)
  })

  it("is refused in a batch that holds the lock of a caller's event", () => {
    const locked = defineStatement(
      'test',
      () => stampedTask(),
      () => ({ queue: 'q', eventName: EventName.fromPort('test', 'approval') }),
    )({})
    expect(() => batch().casTree('win', locked).derived('event', ofTheTask)).toThrow(
      /deletes an event, and the batch holds no completion event's lock/,
    )
  })
})
