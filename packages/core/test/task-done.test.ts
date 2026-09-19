import { SqliteQueryCompiler } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  type AwaitAnswer,
  type ChildAwait,
  FencedBatch,
  READS_SEED,
  RunTaskMemo,
  type SqlExecutor,
  type SqlRow,
  type SqlStatement,
  type TaskDoneDialect,
  TreeDialect,
  awaitTaskDone,
  endingTask,
  sqlFragment,
  sqlTransactionLock,
} from '../src/index.js'
import { CLOCK } from './tree-fixtures.js'

/**
 * The engine's side of a child await and of a terminal batch's read of its task, which
 * every dialect inherits from core. A dialect supplies facts, and these cases supply
 * them by hand: what its `await-event` batch answered, and what its executor returned
 * for each batch by label. The protocol itself is held on real databases by the child
 * task conformance surface, on every dialect.
 */
const tree = new TreeDialect(new SqliteQueryCompiler())
const AWAITED: ChildAwait = {
  queue: 'q',
  taskId: 'parent',
  runId: 'r1',
  claimToken: 'token',
  stepName: 's',
  childTaskId: 'child',
  timeoutSeconds: null,
}
const ENDED: SqlRow = {
  queue: 'q',
  fence_stamp: 'seed:end',
  state: 'completed',
  completed_payload: '{"ok":1}',
  failure_reason: null,
}
const HIT: SqlRow = { payload: '{"state":"completed"}', payload_type: 'text' }

function dialectOf(script: {
  awaits?: (AwaitAnswer | null)[]
  rows?: Record<string, SqlRow[][]>
  liveTask?: string
}) {
  const sent: { label: string; statements: SqlStatement[]; lock: unknown }[] = []
  const awaits = [...(script.awaits ?? [])]
  const executor: SqlExecutor = {
    batch: async (label, statements, control) => {
      sent.push({ label, statements: [...statements], lock: sqlTransactionLock(control) })
      const rows = script.rows?.[label] ?? []
      return statements.map((_, index) => ({ rows: rows[index] ?? [], rowsAffected: 1 }))
    },
  }
  const open = (label: string, seed: string) => new FencedBatch(label, seed, { now: CLOCK, tree })
  const dialect: TaskDoneDialect = {
    run: (batch) => batch.run(executor),
    open: {
      runTask: () => open('run-task', READS_SEED),
      taskDoneState: () => open('task-done-state', READS_SEED),
      recordTaskDone: () => open('record-task-done', 'seed'),
    },
    awaitNamedEvent: async () => {
      if (awaits.length === 0) throw new Error('the await batch was asked once too often')
      return awaits.shift() as AwaitAnswer | null
    },
    refusal: async (operation, runId) => new Error(`refused ${operation} ${runId}`),
    taskOwnsRun: sqlFragment('t.task_id = r.task_id'),
    liveTask: sqlFragment(script.liveTask ?? `t.state IN ('pending', 'running', 'sleeping')`),
    storedPayloadType: sqlFragment('typeof(payload)'),
  }
  return { dialect, sent }
}

describe('a child await, as every dialect inherits it', () => {
  it("answers what the dialect's await batch answered, and reads nothing", async () => {
    const { dialect, sent } = dialectOf({ awaits: [{ emitted: false }] })
    expect(await awaitTaskDone(dialect, AWAITED)).toEqual({ emitted: false })
    expect(sent).toEqual([])
  })

  it('reads the child once to say why, and refuses another queue or no such task', async () => {
    const foreign = dialectOf({
      awaits: [null],
      rows: { 'task-done-state': [[{ ...ENDED, queue: 'other' }]] },
    })
    await expect(awaitTaskDone(foreign.dialect, AWAITED)).rejects.toMatchObject({
      name: 'ChildAwaitRefusedError',
      reason: 'other-queue',
    })
    expect(foreign.sent.map((batch) => batch.label)).toEqual(['task-done-state'])
    const missing = dialectOf({ awaits: [null], rows: { 'task-done-state': [[]] } })
    await expect(awaitTaskDone(missing.dialect, AWAITED)).rejects.toMatchObject({
      reason: 'no-such-task',
    })
  })

  it('asks the await batch again when the child it read is live', async () => {
    const { dialect, sent } = dialectOf({
      awaits: [null, { emitted: false }],
      rows: {
        'task-done-state': [
          [{ ...ENDED, state: 'pending', completed_payload: null, fence_stamp: null }],
        ],
      },
    })
    expect(await awaitTaskDone(dialect, AWAITED)).toEqual({ emitted: false })
    expect(sent.map((batch) => batch.label)).toEqual(['task-done-state'])
  })

  it("records an ended child's outcome under the completion event's lock, and answers with it", async () => {
    const { dialect, sent } = dialectOf({
      awaits: [null],
      rows: { 'task-done-state': [[ENDED]], 'record-task-done': [[], [HIT]] },
    })
    expect(await awaitTaskDone(dialect, AWAITED)).toEqual({
      emitted: true,
      payloadJson: '{"state":"completed"}',
    })
    expect(sent.map((batch) => [batch.label, batch.lock])).toEqual([
      ['task-done-state', undefined],
      ['record-task-done', { kind: 'event', queue: 'q', eventName: '$task-done:child' }],
    ])
    // The insert is fenced on the row that was read: it binds the stamp that row carried.
    expect(sent[1]?.statements[0]?.args).toContain('seed:end')
  })

  it('names the child task when the stored payload is not text', async () => {
    const { dialect } = dialectOf({
      awaits: [null],
      rows: {
        'task-done-state': [[ENDED]],
        'record-task-done': [[], [{ ...HIT, payload_type: 'blob' }]],
      },
    })
    await expect(awaitTaskDone(dialect, AWAITED)).rejects.toThrow(
      'awaitTaskDone q/task child found a non-TEXT stored payload',
    )
  })

  it("answers with the dialect's refusal when two rounds settle nothing", async () => {
    const { dialect, sent } = dialectOf({
      awaits: [null, null],
      rows: { 'task-done-state': [[ENDED]], 'record-task-done': [[], []] },
    })
    await expect(awaitTaskDone(dialect, AWAITED)).rejects.toThrow('refused awaitTaskDone r1')
    expect(sent.map((batch) => batch.label)).toEqual([
      'task-done-state',
      'record-task-done',
      'task-done-state',
      'record-task-done',
    ])
  })

  it('holds the child id to the width of an identifier before anything is sent', async () => {
    const { dialect, sent } = dialectOf({ awaits: [{ emitted: false }] })
    await expect(
      awaitTaskDone(dialect, { ...AWAITED, childTaskId: 'c'.repeat(300) }),
    ).rejects.toThrow(/childTaskId/)
    expect(sent).toEqual([])
  })
})

describe("a terminal batch's read of its task", () => {
  it('costs no read for a run this store handed out, and one read for any other', async () => {
    const remembered = new RunTaskMemo()
    remembered.remember('r1', 't1')
    const { dialect, sent } = dialectOf({ rows: { 'run-task': [[{ task_id: 't2' }]] } })
    expect(await endingTask(dialect, remembered, 'complete', 'q', 'r1')).toBe('t1')
    expect(sent).toEqual([])
    expect(await endingTask(dialect, remembered, 'complete', 'q', 'r2')).toBe('t2')
    expect(sent.map((batch) => [batch.label, batch.statements[0]?.args])).toEqual([
      ['run-task', ['r2', 'q']],
    ])
  })

  it('refuses a run this queue does not have, as the batch would', async () => {
    const { dialect } = dialectOf({ rows: { 'run-task': [[]] } })
    await expect(endingTask(dialect, new RunTaskMemo(), 'fail', 'q', 'r9')).rejects.toThrow(
      'refused fail r9',
    )
  })
})

describe('what core cannot check of a dialect', () => {
  // The exhibit is ACCEPTED and SENT. Core holds the protocol, and a dialect's facts are
  // text it cannot read: what holds them is the conformance suite on that dialect.
  it('accepts whatever a dialect calls a live task, so a wrong fact records an outcome under a claim no live task holds', async () => {
    const { dialect, sent } = dialectOf({
      awaits: [null],
      rows: { 'task-done-state': [[ENDED]], 'record-task-done': [[], [HIT]] },
      liveTask: '1 = 1',
    })
    expect(await awaitTaskDone(dialect, AWAITED)).toEqual({
      emitted: true,
      payloadJson: '{"state":"completed"}',
    })
    expect(sent[1]?.statements.map((statement) => statement.sql.includes('(1 = 1)'))).toEqual([
      true,
      true,
    ])
  })
})
