import type { SqlExecutor, SqlStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { LibsqlSchedulerStore } from '../src/index.js'
import { testIdSource } from '../src/testing.js'

/**
 * A prepared read is kept at module scope, shared by every store in the process. So the
 * first call it ever sees must be checked as every call is: a malformed one is refused
 * and sends nothing, and it leaves nothing behind for the calls after it. This file is its
 * own, so that its first call really is the first call these reads see.
 */
describe('a prepared read checks its first call as it checks every call', () => {
  const sent: SqlStatement[] = []
  const executor: SqlExecutor = {
    batch: async (_label, statements) => {
      sent.push(...statements)
      return statements.map(() => ({ rows: [], rowsAffected: 0 }))
    },
  }

  it('refuses a malformed first call, and sends nothing', async () => {
    const store = new LibsqlSchedulerStore(executor, testIdSource('first-call-a'))
    // Through the port a task id that is not a string is refused before the entry runs, so
    // no malformed bind reaches a prepared read that way. The entry is called from the
    // prototype, which is the entry with nothing in front of it.
    const getTaskResult = LibsqlSchedulerStore.prototype.getTaskResult
    await expect(getTaskResult.call(store, 'q', undefined as never)).rejects.toThrow(
      /bind 'taskId' is undefined/,
    )
    expect(sent).toEqual([])
  })

  it('answers the next well-formed call, on a second store instance', async () => {
    const other = new LibsqlSchedulerStore(executor, testIdSource('first-call-b'))
    await expect(other.getTaskResult('q', 't1')).resolves.toBeNull()
    expect(sent.at(-1)?.args).toEqual(['t1', 'q'])
  })

  it('throws a refusal-state read the builder refuses as itself, never as a lost lease', async () => {
    // The batch is built before the read is handed to the caller that reads a failed read
    // as a lost lease. A heartbeat that matched no row asks for that read.
    const store = new LibsqlSchedulerStore(executor, testIdSource('first-call-c'))
    // From the prototype, for the reason the first case gives.
    const heartbeat = LibsqlSchedulerStore.prototype.heartbeat
    await expect(heartbeat.call(store, 'q', undefined as never, 'token', 30)).rejects.toThrow(
      /bind 'runId' is undefined/,
    )
  })
})
