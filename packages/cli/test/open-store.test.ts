import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testIdSource } from '@durablerun/core/testing'
import { LibsqlExecutor, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { describe, expect, it } from 'vitest'
import {
  STORE_SCHEMES,
  StoreUrlError,
  openStore,
  storeScheme,
  storeTarget,
} from '../src/open-store.js'
import { runCli } from './support.js'

/** A database initialized through the store itself, at a URL the libSQL client decodes. */
async function initialized(url: string): Promise<void> {
  const db = LibsqlExecutor.open(url)
  try {
    await new LibsqlStoreAdmin(db).migrate()
  } finally {
    db.close()
  }
}

/** The database files in a directory, without SQLite's journal files. */
function databaseFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sqlite'))
    .sort()
}

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

  it('picks a store by scheme and names what --target must equal', async () => {
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
    expect(await storeTarget('file:/var/data/db.sqlite')).toBe('/var/data/db.sqlite')
    expect(await storeTarget('file:///var/data/db.sqlite?mode=rw')).toBe('/var/data/db.sqlite')
    expect(await storeTarget('file:local.db')).toBe('local.db')
    expect(await storeTarget(':memory:')).toBe(':memory:')
    expect(await storeTarget('libsql://db-name.example.io')).toBe('db-name.example.io')
    expect(await storeTarget('postgresql://user:secret@db.example.io:5433/app')).toBe(
      'db.example.io:5433',
    )
    expect(await storeTarget('mysql://root:secret@127.0.0.1:3306/app')).toBe('127.0.0.1:3306')
    expect(storeScheme('sqlite:data/x.db')).toBeUndefined()
    await expect(storeTarget('/var/data/db.sqlite')).rejects.toThrow(StoreUrlError)
    await expect(storeTarget('file:/var/data/a%zz.sqlite')).rejects.toThrow(StoreUrlError)
    expect(await storeTarget('file:/var/data/a%20b.sqlite')).toBe('/var/data/a b.sqlite')
  })

  it("reads a file: URL's path as the libSQL client decodes it, for the read guard and for --target", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durablerun-cli-file-url-'))
    try {
      await initialized(`file:${join(dir, 'a%20b.sqlite')}`)
      await initialized(`file:${join(dir, 'a%3Fb.sqlite')}`)
      await initialized(`file:${join(dir, 'a%23b.sqlite')}`)
      expect(databaseFiles(dir)).toEqual(['a b.sqlite', 'a#b.sqlite', 'a?b.sqlite'])
      const doctor = async (url: string) =>
        (await runCli(['doctor', '--queue', 'q', '--json'], { DURABLERUN_STORE_URL: url })).exit
      expect(
        {
          space: await doctor(`file:${join(dir, 'a%20b.sqlite')}`),
          question: await doctor(`file:${join(dir, 'a%3Fb.sqlite')}`),
          hash: await doctor(`file:${join(dir, 'a%23b.sqlite')}`),
        },
        'mutation-verdict:behavior:cli-file-url-reads-the-client-path',
      ).toEqual({ space: 0, question: 0, hash: 0 })
      // An unencoded # starts a fragment, which the client refuses, so the URL is refused.
      expect(await doctor(`file:${join(dir, 'a')}#b.sqlite`)).toBe(2)

      // Only a file whose name holds the text %41 is there, so the database the client
      // would open, aA.sqlite, is missing, and a read refuses it without creating it.
      writeFileSync(join(dir, 'a%41.sqlite'), '')
      const encoded = await runCli(['doctor', '--queue', 'q', '--json'], {
        DURABLERUN_STORE_URL: `file:${join(dir, 'a%41.sqlite')}`,
      })
      expect({ exit: encoded.exit, files: databaseFiles(dir) }).toEqual({
        exit: 5,
        files: ['a b.sqlite', 'a#b.sqlite', 'a%41.sqlite', 'a?b.sqlite'],
      })

      // --target names the path the client opens, decoded.
      const created = await runCli(
        ['migrate', '--yes', '--target', join(dir, 'new db.sqlite'), '--json'],
        { DURABLERUN_STORE_URL: `file:${join(dir, 'new%20db.sqlite')}` },
      )
      expect(created.exit, created.stdout).toBe(0)
      expect(databaseFiles(dir)).toEqual([
        'a b.sqlite',
        'a#b.sqlite',
        'a%41.sqlite',
        'a?b.sqlite',
        'new db.sqlite',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a token beside a URL that carries its own credentials, and opens nothing', async () => {
    for (const url of ['postgresql://user@127.0.0.1:1/app', 'mysql://root@127.0.0.1:1/app']) {
      await expect(openStore(url, 'a-token', testIdSource('o'))).rejects.toBeInstanceOf(
        StoreUrlError,
      )
    }
  })
})
