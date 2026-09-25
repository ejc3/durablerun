import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testIdSource } from '@durablerun/core/testing'
import { describe, expect, it } from 'vitest'
import {
  STORE_SCHEMES,
  StoreUrlError,
  openStore,
  storeScheme,
  storeTarget,
} from '../src/open-store.js'

describe('the store opener', () => {
  it('returns ports narrowed to the calls a command may make, and no executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-opener-'))
    try {
      const store = await openStore(
        `file:${join(dir, 'db.sqlite')}`,
        undefined,
        testIdSource('o'),
        {
          mayCreate: true,
        },
      )
      try {
        expect(Object.keys(store).sort()).toEqual([
          'admin',
          'close',
          'scheduler',
          'scheme',
          'window',
        ])
        expect(Object.keys(store.admin).sort()).toEqual(['migrate', 'nowEpochMs', 'schemaVersion'])
        expect(Object.keys(store.scheduler).sort()).toEqual(['getCheckpoints', 'getTaskResult'])
        // @ts-expect-error the fake clock's setter cannot be written through the CLI's admin
        expect(store.admin.setFakeNowEpochMs).toBeUndefined()
        // @ts-expect-error a claim cannot be written through the CLI's scheduler
        expect(store.scheduler.claim).toBeUndefined()
        expect(store.window).toEqual({ oldest: 5, newest: expect.any(Number) })
      } finally {
        await store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('picks a store by scheme and names what --target must equal', () => {
    expect(STORE_SCHEMES).toEqual([
      ':memory:',
      'file:',
      'libsql:',
      'https:',
      'wss:',
      'postgres:',
      'postgresql:',
      'mysql:',
    ])
    expect(storeTarget('file:/var/data/db.sqlite')).toBe('/var/data/db.sqlite')
    expect(storeTarget('file:///var/data/db.sqlite?mode=rw')).toBe('/var/data/db.sqlite')
    expect(storeTarget('file:local.db')).toBe('local.db')
    expect(storeTarget(':memory:')).toBe(':memory:')
    expect(storeTarget('libsql://db-name.example.io')).toBe('db-name.example.io')
    expect(storeTarget('postgresql://user:secret@db.example.io:5433/app')).toBe(
      'db.example.io:5433',
    )
    expect(storeTarget('mysql://root:secret@127.0.0.1:3306/app')).toBe('127.0.0.1:3306')
    expect(storeScheme('sqlite:data/x.db')).toBeUndefined()
    expect(() => storeTarget('/var/data/db.sqlite')).toThrow(StoreUrlError)
  })

  it('refuses a token beside a URL that carries its own credentials, and opens nothing', async () => {
    for (const url of ['postgresql://user@127.0.0.1:1/app', 'mysql://root@127.0.0.1:1/app']) {
      await expect(openStore(url, 'a-token', testIdSource('o'))).rejects.toBeInstanceOf(
        StoreUrlError,
      )
    }
  })
})
