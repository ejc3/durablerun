import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PgExecutor } from '../src/executor.js'

const EMPTY_RESULT = { command: '', rowCount: 0, oid: 0, fields: [], rows: [] }

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class EmittingClient extends EventEmitter {
  readonly releases: (Error | boolean | undefined)[] = []
  readonly beginStarted = deferred()
  readonly allowBegin = deferred()

  async query(text: string) {
    if (text === 'BEGIN') {
      this.beginStarted.resolve()
      await this.allowBegin.promise
    }
    return EMPTY_RESULT
  }

  release(error?: Error | boolean): void {
    this.releases.push(error)
  }
}

class EmittingPool {
  constructor(readonly client: EmittingClient) {}

  async connect(): Promise<EmittingClient> {
    return this.client
  }

  async end(): Promise<void> {}
}

describe('PgExecutor owned-pool lifecycle', () => {
  it('contains an idle-client error after the pool has already evicted that client', async () => {
    const db = PgExecutor.open({ connectionString: 'postgresql://localhost/unused' })
    const pool = (db as unknown as { readonly pool: Pool }).pool
    try {
      expect(() => pool.emit('error', new Error('simulated idle disconnect'))).not.toThrow()
    } finally {
      await db.close()
    }
  })

  it('contains and discards an errored client while it is checked out', async () => {
    const client = new EmittingClient()
    const db = PgExecutor.fromPool(new EmittingPool(client) as unknown as Pool)
    const outcome = db.batch('active-error', [{ sql: 'SELECT 1', args: [] }])
    await client.beginStarted.promise

    const error = new Error('simulated active disconnect')
    try {
      expect(() => client.emit('error', error)).not.toThrow()
    } finally {
      client.allowBegin.resolve()
      await outcome
    }

    expect(client.releases).toEqual([error])
    expect(client.listenerCount('error')).toBe(0)
  })
})
