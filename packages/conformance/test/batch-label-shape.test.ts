import type { SqlExecutor } from '@durablerun/core'
import { expect, it } from 'vitest'
import type { StoreFixtureFactory } from '../src/index.js'
import { makeLibsqlFixture } from './fixture-libsql.js'

type Wake = { inSeconds: number } | { atEpochMs: number }
type CapturedBatch = { sql: string; bindArity: number }[]

async function captureWakeBatch(
  operation: 'reschedule' | 'suspend',
  wake: Wake,
  makeFixture: StoreFixtureFactory = makeLibsqlFixture,
): Promise<CapturedBatch> {
  const wakeKind = Object.hasOwn(wake, 'inSeconds') ? 'relative' : 'absolute'
  const fixture = await makeFixture(`batch-shape-${operation}-${wakeKind}`)
  try {
    await fixture.admin.setFakeNowEpochMs(1_000_000)
    await fixture.store.spawn('q', 'job', '{}')
    const [run] = await fixture.store.claim('q', 'worker', { leaseSeconds: 60, limit: 1 })
    if (!run) throw new Error('expected a claimed run')
    await fixture.store.activate('q', run.runId, run.claimToken, run.claimGen)

    let captured: CapturedBatch | undefined
    const recordingExecutor: SqlExecutor = {
      batch: (label, statements, mode) => {
        if (label === operation) {
          if (captured !== undefined) throw new Error(`recorded ${label} twice`)
          captured = statements.map((statement) => ({
            sql: statement.sql,
            bindArity: statement.args.length,
          }))
        }
        return fixture.raw.batch(label, statements, mode)
      },
    }
    const store = fixture.storeOver(recordingExecutor)
    if (operation === 'reschedule') {
      await store.reschedule('q', run.runId, run.claimToken, wake)
    } else {
      await store.suspendRun('q', run.runId, run.claimToken, wake, {
        key: '$shape',
        stateJson: '{}',
      })
    }
    if (captured === undefined) throw new Error(`no ${operation} batch was recorded`)
    return captured
  } finally {
    await fixture.close()
  }
}

function sameShape(relative: CapturedBatch, absolute: CapturedBatch) {
  return {
    sqlText:
      relative.length === absolute.length &&
      relative.every((statement, index) => statement.sql === absolute[index]?.sql),
    bindArity:
      relative.length === absolute.length &&
      relative.every((statement, index) => statement.bindArity === absolute[index]?.bindArity),
  }
}

it('one batch label has one SQL text and bind arity for relative and absolute wakes', async () => {
  const [relativeReschedule, absoluteReschedule, relativeSuspend, absoluteSuspend] =
    await Promise.all([
      captureWakeBatch('reschedule', { inSeconds: 30 }),
      captureWakeBatch('reschedule', { atEpochMs: 1_030_000 }),
      captureWakeBatch('suspend', { inSeconds: 30 }),
      captureWakeBatch('suspend', { atEpochMs: 1_030_000 }),
    ])

  expect({
    reschedule: sameShape(relativeReschedule, absoluteReschedule),
    suspend: sameShape(relativeSuspend, absoluteSuspend),
  }).toEqual({
    reschedule: { sqlText: true, bindArity: true },
    suspend: { sqlText: true, bindArity: true },
  })
})

it('does not finish a fixture scope before asynchronous cleanup settles', async () => {
  let markCloseStarted!: () => void
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve
  })
  let releaseClose!: () => void
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  let captureSettled = false
  const capture = captureWakeBatch('reschedule', { inSeconds: 30 }, async (seed) => {
    const fixture = await makeLibsqlFixture(seed)
    return {
      ...fixture,
      close: async () => {
        markCloseStarted()
        await closeGate
        await fixture.close()
      },
    }
  }).then(() => {
    captureSettled = true
  })

  try {
    await closeStarted
    await Promise.resolve()
    expect(captureSettled).toBe(false)
  } finally {
    releaseClose()
    await capture
  }
})
