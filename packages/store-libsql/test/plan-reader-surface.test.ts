import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Client, createClient } from '@libsql/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LibsqlExecutor, LibsqlStoreAdmin } from '../src/index.js'
import { type Shipped, keyOf, recordHistory } from './plan-history.js'
import { type NestReading, type PlanRow, readNests } from './plan-nests.js'
import {
  type Backlog,
  SCALES,
  type Statement,
  backlogOf,
  grew,
  measure,
  spellings,
  withoutWhere,
} from './plan-oracle.js'

/**
 * The plan reader (`plan-nests.ts`) judges the text of `EXPLAIN QUERY PLAN`, and it is
 * hand-written against the plan shapes its author had seen, which is where every finding
 * against it came from. This holds it to a measurement that reads no plan text
 * (`plan-oracle.ts`): the statement is run beside a backlog and beside one four times as
 * large, and it either did more work or it did not.
 *
 * The surface is every statement the store ships, each in the database as the batch that
 * sent it found it, and three families of variations of it: the same statement in a
 * database without one index it uses, which reshapes its plan into scans, automatic
 * indexes and other loops the shipped plans do not have; the same write without its WHERE,
 * which takes every row; and the same statement in other spellings that mean the same
 * thing, which the reader must judge alike.
 */

interface Context {
  readonly shipped: Shipped
  readonly database: string
  readonly before: Statement[]
}

/**
 * The kinds of line a plan has that the reader tells apart, each by the start of the line
 * that says it. A kind that no plan of the surface holds is a reading the surface never
 * asks of the reader, so which kinds it reaches is held below in both directions.
 */
const LINE_KINDS: readonly (readonly [string, RegExp])[] = [
  ['scan', /^SCAN (?!CONSTANT)/],
  ['seek', /^SEARCH /],
  ['seek through an automatic index', /^SEARCH .*AUTOMATIC/],
  ['constant rows', /^SCAN (?:CONSTANT ROW|\d+ CONSTANT ROWS)/],
  ['virtual table', /VIRTUAL TABLE/],
  ['scalar subquery', /^SCALAR SUBQUERY/],
  ['correlated subquery', /^CORRELATED (?:SCALAR|LIST) SUBQUERY/],
  ['list subquery', /^LIST SUBQUERY/],
  ['co-routine', /^CO-ROUTINE/],
  ['materialized body', /^MATERIALIZE/],
  ['compound query', /^(?:COMPOUND QUERY|LEFT-MOST SUBQUERY)/],
  ['union', /^UNION/],
  ['intersect or except', /^(?:INTERSECT|EXCEPT)/],
  ['multi-index or', /^MULTI-INDEX OR/],
  ['temp b-tree', /^USE TEMP B-TREE/],
]

/** One statement, in one variation, measured and read. */
interface Row {
  readonly name: string
  readonly kind: string
  readonly variation: 'shipped' | 'without an index' | 'without its WHERE'
  readonly dropped: string | undefined
  readonly grew: boolean
  readonly reading: NestReading
  readonly lines: ReadonlySet<string>
}

let dir: string
let contexts: Map<string, Context>
let indexes: { name: string; unique: boolean }[]
const clients = new Map<string, Client>()
const backlogs = new Map<string, Backlog>()
const rows: Row[] = []
/** A statement that would not run in a variation, with why: an index a statement needs. */
const skipped: { name: string; variation: string; dropped: string | undefined; error: string }[] =
  []
/** A spelling of a statement, and whether the reader judged it as it judged the statement. */
const spelled: { name: string; spelling: string; wasBad: boolean; isBad: boolean }[] = []
const spellingErrors: string[] = []

const nameOf = (st: Shipped) =>
  `${st.label}#${st.index} ${st.sql.slice(0, 48).replace(/\s+/g, ' ')}`
const kindOf = (sql: string) =>
  /^\s*(?:\/\*.*?\*\/\s*|--.*\n\s*)*(\w+)/i.exec(sql)?.[1]?.toLowerCase() ?? '?'
const isBad = (reading: NestReading) => reading.faults.length > 0

async function planOf(client: Client, sql: string, args: unknown[], dropped?: string) {
  const tx = await client.transaction('write')
  try {
    if (dropped !== undefined) await tx.execute(`drop index ${dropped}`)
    const plan = await tx.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args as number[] })
    return plan.rows.map(
      (row): PlanRow => ({
        id: Number(row.id),
        parent: Number(row.parent),
        detail: String(row.detail),
      }),
    )
  } finally {
    await tx.rollback()
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plan-reader-surface-'))
  const file = join(dir, 'history.db')
  const executor = LibsqlExecutor.open(`file:${file}`)
  await new LibsqlStoreAdmin(executor).migrate()
  const watcher = createClient({ url: `file:${file}` })
  // The database as each batch finds it: one snapshot ahead of every batch, and for each
  // statement the first time it is sent, the statements of its batch that run before it.
  contexts = new Map()
  let snapshots = 0
  const sent = await recordHistory(executor, async (label, statements) => {
    const database = join(dir, `snapshot-${snapshots++}.db`)
    await watcher.execute(`vacuum into '${database}'`)
    for (const [index, st] of statements.entries()) {
      const key = keyOf(label, st.sql)
      if (contexts.has(key)) continue
      const before = statements.slice(0, index).map((s) => ({ sql: s.sql, args: [...s.args] }))
      contexts.set(key, {
        shipped: { label, index, sql: st.sql, args: [...st.args] },
        database,
        before,
      })
    }
  })
  executor.close()
  const listed = await watcher.execute(
    `select name, sql like 'CREATE UNIQUE%' as u from sqlite_master where type = 'index' and sql is not null`,
  )
  indexes = listed.rows.map((row) => ({ name: String(row.name), unique: Number(row.u) === 1 }))
  watcher.close()
  if (contexts.size !== new Set(sent.map((st) => keyOf(st.label, st.sql))).size) {
    throw new Error('a statement was sent that no batch context holds')
  }
  for (const database of new Set([...contexts.values()].map((c) => c.database))) {
    const client = createClient({ url: `file:${database}` })
    clients.set(database, client)
    backlogs.set(database, await backlogOf(client))
  }

  for (const dropped of [undefined, ...indexes.map((i) => i.name)]) {
    for (const { shipped, database, before } of contexts.values()) {
      const client = clients.get(database) as Client
      const backlog = backlogs.get(database) as Backlog
      const name = nameOf(shipped)
      const statement = { sql: shipped.sql, args: shipped.args }
      const run = async (
        variation: Row['variation'],
        variant: Statement,
        beforeIt: readonly Statement[],
      ) => {
        try {
          const small = await measure(client, backlog, SCALES.small, beforeIt, variant, dropped)
          const large = await measure(client, backlog, SCALES.large, beforeIt, variant, dropped)
          rows.push({
            name,
            kind: kindOf(shipped.sql),
            variation,
            dropped,
            grew: grew(small, large),
            reading: readNests(large.plan, variant.sql),
            lines: new Set(
              large.plan.flatMap((line) =>
                LINE_KINDS.filter(([, shape]) => shape.test(line.detail)).map(([kind]) => kind),
              ),
            ),
          })
        } catch (error) {
          skipped.push({ name, variation, dropped, error: String(error).slice(0, 120) })
        }
      }
      await run(dropped === undefined ? 'shipped' : 'without an index', statement, before)
      const stripped = /^\s*(?:update|delete)\b/i.test(shipped.sql)
        ? withoutWhere(shipped.sql)
        : undefined
      if (dropped === undefined && stripped !== undefined) {
        // The same write with every row of its table in its reach. The statements ahead of it
        // in its batch bind the write's own arguments, so it runs with the same binds less the
        // ones its WHERE took: SQLite is handed exactly the placeholders that remain.
        const kept = (stripped.match(/\?/g) ?? []).length
        await run('without its WHERE', { sql: stripped, args: shipped.args.slice(0, kept) }, before)
      }
      // The reader's judgment of each spelling, against its judgment of the statement.
      // A statement that needs the dropped index has no plan, and was recorded as skipped.
      const plan = await planOf(client, shipped.sql, shipped.args, dropped).catch(() => undefined)
      if (plan === undefined) continue
      const was = isBad(readNests(plan, shipped.sql))
      for (const [spelling, text] of Object.entries(spellings(shipped.sql))) {
        try {
          const other = await planOf(client, text, shipped.args, dropped)
          spelled.push({ name, spelling, wasBad: was, isBad: isBad(readNests(other, text)) })
        } catch (error) {
          spellingErrors.push(`${name} :: ${spelling} :: ${String(error).slice(0, 100)}`)
        }
      }
    }
  }
}, 240_000)

afterAll(() => {
  for (const client of clients.values()) client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the plan reader against a measured backlog', () => {
  const nameOfRow = (r: Row) =>
    `${r.name} [${r.variation}${r.dropped === undefined ? '' : ` ${r.dropped}`}]`

  it('measures every statement the store ships, in every variation, and skips only what needs a dropped index', () => {
    const shipped = rows.filter((r) => r.variation === 'shipped')
    expect(shipped.length).toBe(contexts.size)
    // A statement that will not run without an index is one that names it: an upsert on a
    // unique index. A write that takes every row can break a constraint of the table, as an
    // UPDATE that sets a column from a subquery to NULL does. Anything else that fails to run
    // is a variation the surface never judged.
    const unique = new Set(indexes.filter((i) => i.unique).map((i) => i.name))
    expect(
      skipped
        .filter((s) =>
          s.variation === 'without its WHERE'
            ? !s.error.includes('SQLITE_CONSTRAINT')
            : s.dropped === undefined || !unique.has(s.dropped),
        )
        .map((s) => `${s.name} [${s.dropped}] ${s.error}`),
    ).toEqual([])
    expect(rows.length + skipped.length).toBeGreaterThan(contexts.size * indexes.length)
    expect(spellingErrors).toEqual([])
  }, 30_000)

  it('reaches every kind of statement with a variation that grows, so no kind is judged by silence', () => {
    // The set of kinds is read from the statements, and each must have a growing variation
    // and a flat one, or the comparison below has nothing to disagree about for that kind.
    const kinds = new Set(rows.map((r) => r.kind))
    expect([...kinds].sort()).toEqual(['delete', 'insert', 'select', 'update'])
    for (const kind of kinds) {
      const of = rows.filter((r) => r.kind === kind)
      expect(
        of.some((r) => r.grew),
        `${kind} has no growing variation`,
      ).toBe(true)
      expect(
        of.some((r) => !r.grew),
        `${kind} has no flat variation`,
      ).toBe(true)
    }
    expect(rows.some((r) => r.variation === 'without its WHERE' && r.grew)).toBe(true)
    expect(rows.some((r) => r.variation === 'without an index' && r.grew)).toBe(true)
  })

  it('reaches every kind of plan line the reader can be asked about, and names the ones no plan here holds', () => {
    const reached = new Set(rows.flatMap((r) => [...r.lines]))
    // Kinds no shipped statement produces, in this database or in one without an index it
    // uses. The reader's cases for them are written by hand in `query-plans.test.ts`, and a
    // kind that starts to be reached is removed from this list, so that its hand cases can be
    // weighed against the surface's.
    const unreached = [
      'intersect or except',
      'materialized body',
      'seek through an automatic index',
    ]
    expect(
      LINE_KINDS.map(([kind]) => kind)
        .filter((kind) => !reached.has(kind))
        .sort(),
    ).toEqual(unreached)
  })

  it('the measurement can tell a walk from a lookup', async () => {
    // In the database of a batch that finds runs there, and not the first, which is empty.
    let database = ''
    let most = -1
    for (const [path, client] of clients) {
      const runs = Number((await client.execute('select count(*) as n from runs')).rows[0]?.n)
      if (runs > most) [database, most] = [path, runs]
    }
    expect(most).toBeGreaterThan(0)
    const client = clients.get(database) as Client
    const backlog = backlogs.get(database) as Backlog
    const under = async (sql: string, args: unknown[]) =>
      grew(
        await measure(client, backlog, SCALES.small, [], { sql, args }),
        await measure(client, backlog, SCALES.large, [], { sql, args }),
      )
    expect(await under('select run_id from runs where queue = ?', ['q'])).toBe(true)
    expect(await under('select state from runs where run_id = ?', ['nobody'])).toBe(false)
    expect(await under('delete from runs', [])).toBe(true)
  })

  it('refuses no statement that the measurement shows reading a backlog, unless a due range drives it', () => {
    // A due range is bounded by a LIMIT that a plan never prints, so the reader reports each
    // one it sees and `query-plans.test.ts` names them line for line. What it must not do is
    // pass a statement that grew, and report no due range either.
    const passedAndGrew = rows
      .filter((r) => r.grew && !isBad(r.reading) && r.reading.dueDrivers.length === 0)
      .map(nameOfRow)
    expect(passedAndGrew, 'mutation-verdict:behavior:plan-nests').toEqual([])
  })

  it('refuses exactly the statements that grew, in the database as the store shipped it', () => {
    // With every index in place the reader passes every shipped statement, and none of them
    // grew but the ones a due range drives. Both directions are held: a statement the reader
    // refuses that does no more work beside a backlog is a reader that has misread a plan.
    const disagree = rows
      .filter((r) => r.variation === 'shipped')
      .filter((r) => isBad(r.reading) !== (r.grew && r.reading.dueDrivers.length === 0))
      .map(nameOfRow)
    expect(disagree, 'mutation-verdict:behavior:plan-nests').toEqual([])
  })

  it('judges every spelling of a statement as it judges the statement', () => {
    expect(spelled.length).toBeGreaterThan(contexts.size * 3)
    const kinds = new Set(spelled.map((s) => s.spelling))
    expect([...kinds].sort()).toEqual([
      'a block comment first',
      'a line comment first',
      'an update under a conflict clause',
      'blank space first',
      'the table quoted or bare',
      'the table under a quoted schema',
      'the table under its schema',
    ])
    expect(spelled.some((s) => s.wasBad)).toBe(true)
    // A comment ahead of a statement hides its first word, which is how the reader tells its
    // kind, so the reader refuses it whatever it is. That is strictness the measurement
    // cannot ask for, and it holds in one direction that matters: a comment never turns a
    // refusal into a pass.
    const commented = spelled.filter((s) => s.spelling.includes('comment first'))
    expect(commented.filter((s) => !s.isBad).map((s) => s.name)).toEqual([])
    // Every other spelling is the statement to the database, and to the reader.
    const differing = spelled
      .filter((s) => !s.spelling.includes('comment first') && s.wasBad !== s.isBad)
      .map((s) => `${s.name} :: ${s.spelling} :: ${s.wasBad ? 'refused' : 'passed'} as written`)
    expect(differing, 'mutation-verdict:behavior:plan-nests').toEqual([])
  })
})
