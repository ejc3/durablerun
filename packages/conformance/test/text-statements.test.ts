import { readFileSync, readdirSync } from 'node:fs'
import { type SqlExecutor, isTreeBuiltStatement } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { claimActivated, withFixture } from '../src/scenario.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

/**
 * A store sends a statement as a tree, which the tree rules read, or as SQL text, which
 * two source lints still scan. The text is one list, `scripts/text-statements.json`, and
 * each entry says why it cannot be a tree. These cases hold every store to the list from
 * both sides: a store may send no text that is not on it, and nothing may stay on it that
 * a store no longer sends.
 */
const LIST = JSON.parse(
  readFileSync(new URL('../../../scripts/text-statements.json', import.meta.url), 'utf8'),
) as { statements: Record<string, { shape: string; why: string }> }
const LISTED = Object.keys(LIST.statements).sort()

/** Sent only to a database with no schema yet, which no fixture hands out. The source case holds them. */
const UNMIGRATED_ONLY = ['migrate:bootstrap', 'migrate:v*']

describe('the statements a store sends as text', () => {
  it('each says why it cannot be a tree', () => {
    expect(LISTED.length).toBeGreaterThan(0)
    for (const label of LISTED) expect(LIST.statements[label]?.why.trim(), label).not.toBe('')
  })

  it('are the raw batches of every store, read from its sources, and no others', () => {
    // A raw batch is the only door for SQL text: the source analyzer lets a store's
    // executor reach a FencedBatch or this call and nothing else. A label that is a
    // template is listed by its prefix and a star.
    const packages = new URL('../../', import.meta.url)
    const stores = readdirSync(packages).filter((name) => name.startsWith('store-'))
    expect(stores.length).toBeGreaterThanOrEqual(3)
    for (const store of stores) {
      const sources = new URL(`${store}/src/`, packages)
      const text = readdirSync(sources, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(new URL(file, sources), 'utf8'))
        .join('\n')
      // A label that is not a literal cannot be read here. batch-lint refuses one, through
      // the source analyzer, which also tells a store's batch from its driver's own.
      const labels = [...text.matchAll(/\.batch\(\s*[`']([^`'$]+)(\$?)/g)].map(
        (found) => `${found[1]}${found[2] === '$' ? '*' : ''}`,
      )
      expect([...new Set(labels)].sort(), `${store}'s text statements`).toEqual(LISTED)
    }
  })

  for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
    it(`${dialect}: sends every listed statement as text, and everything else as trees`, async () => {
      const text = new Set<string>()
      const trees = new Set<string>()
      const mixed: string[] = []
      await withFixture(makeFixture, `text-statements-${dialect}`, async (fixture) => {
        const recorder: SqlExecutor = {
          batch: (label, statements, control) => {
            const built = statements.filter((statement) => isTreeBuiltStatement(statement)).length
            if (built !== 0 && built !== statements.length) mixed.push(label)
            ;(built === 0 ? text : trees).add(label.replace(/^migrate:v\d+$/, 'migrate:v*'))
            return fixture.raw.batch(label, statements, control)
          },
        }
        const store = fixture.storeOver(recorder)
        const admin = fixture.adminOver(recorder)
        await store.spawn('q', 'job', '{}')
        const run = await claimActivated(store, 'q', 'w1')
        expect((await store.heartbeat('q', run.runId, run.claimToken, 30)).held).toBe(true)
        await store.driverHeartbeat('q', 'driver-1', 30)
        expect(await store.nextWakeAtEpochMs('q')).not.toBeNull()
        await store.sweep('q', 10)
        expect(await store.expireLeaseNow('q', run.runId, run.claimToken)).toBe(true)
        await admin.migrate()
        expect(await admin.schemaVersion()).toBeGreaterThan(0)
        await admin.setFakeNowEpochMs(1_000_000)
        expect(await admin.nowEpochMs()).toBe(1_000_000)
        await admin.setFakeNowEpochMs(null)
      })
      expect(mixed, 'a batch that mixes trees and text').toEqual([])
      expect(
        [...text].filter((label) => !LISTED.includes(label)),
        'text that is not listed',
      ).toEqual([])
      expect(
        LISTED.filter((label) => !text.has(label) && !UNMIGRATED_ONLY.includes(label)),
      ).toEqual([])
      expect([...trees].filter((label) => LISTED.includes(label))).toEqual([])
      expect([...trees]).toEqual(expect.arrayContaining(['heartbeat', 'next-wake', 'sweep:scan']))
    })
  }
})
