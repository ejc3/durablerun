import type { Client } from '@libsql/client'
import type { Shipped } from './plan-history.js'
import type { PlanRow } from './plan-nests.js'

/**
 * A measurement that says whether a statement reads a backlog, for the plan reader to be
 * held to. The reader (`plan-nests.ts`) judges the TEXT of `EXPLAIN QUERY PLAN`. This asks
 * the database instead: run the statement beside a backlog of one size and beside one four
 * times as large, and see whether the work it did grew. It reads no plan text, so a plan
 * shape the reader misreads is a shape this measures right.
 *
 * A backlog is many entities alike in everything but their identity: every row of every
 * table is copied again and again with fresh identifying columns and every other column
 * kept, so a statement that finds rows by anything but an identity finds each copy, and a
 * statement that finds them by an identity finds the rows it names and no copy. Which
 * columns identify is declared once below, and the reader declares the same fact for its
 * own reading; what the two do not share is any reading of a plan.
 *
 * Work is counted two ways. `steps` is the virtual machine's step count, read from
 * `sqlite_stmt`, which grows with every row a loop visits. `changed` is the rows the
 * statement wrote, which a step count cannot show for a DELETE that takes SQLite's
 * truncate path: it is one step, whatever the table holds.
 */

/** A column that names one entity, or refers to a row that does. */
export const IDENTITY_COLUMNS = [
  'task_id',
  'run_id',
  'event_name',
  'wake_event',
  'idempotency_key',
  'driver_id',
  'claimed_by',
  'owner_run_id',
  'last_attempt_run',
  'step_name',
  'checkpoint_name',
]

/** The backlog's small size and its large one, in copies of every row. */
export const SCALES = { small: 4, large: 16 } as const

export type Statement = Pick<Shipped, 'sql' | 'args'>

/** The tree `EXPLAIN QUERY PLAN` returns for a statement, on a client or in a transaction. */
export async function planRows(
  from: { execute: (statement: { sql: string; args: number[] }) => Promise<{ rows: unknown[] }> },
  statement: Statement,
): Promise<PlanRow[]> {
  const plan = await from.execute({
    sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
    args: statement.args as number[],
  })
  return (plan.rows as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: String(row.detail),
  }))
}

export interface Measured {
  readonly steps: number
  readonly changed: number
  readonly plan: PlanRow[]
}

/** The tables that hold rows, each with its columns and the column that says a row is an original. */
export interface Backlog {
  readonly tables: ReadonlyMap<string, { columns: string[]; original: string }>
}

export async function backlogOf(client: Client): Promise<Backlog> {
  const names = await client.execute(
    `select name from sqlite_master where type = 'table' and name not in ('meta') and name not like 'sqlite_%'`,
  )
  const tables = new Map<string, { columns: string[]; original: string }>()
  for (const row of names.rows) {
    const name = String(row.name)
    const info = await client.execute(`pragma table_info(${name})`)
    const columns = info.rows.map((column) => String(column.name))
    const original = columns.find((column) => IDENTITY_COLUMNS.includes(column))
    if (original !== undefined) tables.set(name, { columns, original })
  }
  return { tables }
}

/**
 * `rounds` copies of every original row, each with fresh identifying columns. A table that
 * takes fewer copies than it should, because a column that identifies was not made fresh and
 * a unique index refused the row, is an error and not a backlog too small to show a scan.
 */
async function copies(
  tx: {
    execute: (sql: string) => Promise<{ rows: unknown[]; rowsAffected: number }>
  },
  backlog: Backlog,
  rounds: number,
): Promise<void> {
  for (const [table, { columns, original }] of backlog.tables) {
    const originals = Number(
      (
        (await tx.execute(`select count(*) as n from ${table} where ${original} not like '%~%'`))
          .rows[0] as { n: number }
      ).n,
    )
    const selected = columns
      .map((column) => (IDENTITY_COLUMNS.includes(column) ? `${column} || '~' || n.i` : column))
      .join(', ')
    const made = await tx.execute(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < ${rounds})
       insert or ignore into ${table} (${columns.join(', ')})
       select ${selected} from ${table}, n where ${original} not like '%~%'`,
    )
    if (made.rowsAffected !== originals * rounds) {
      throw new Error(
        `${table} took ${made.rowsAffected} copies of ${originals} rows for ${rounds} rounds`,
      )
    }
  }
}

/**
 * One statement's work beside a backlog of `rounds` copies, in a transaction that is rolled
 * back. `before` is what ran ahead of it in its batch, so a statement finds the rows its
 * batch left it, and `dropped` is an index the database is asked to do without. The plan is
 * read from the same database at the same moment, so the plan and the work are of one plan.
 */
async function measureAt(
  client: Client,
  backlog: Backlog,
  rounds: number,
  before: readonly Statement[],
  statement: Statement,
  dropped?: string,
): Promise<Measured> {
  const tx = await client.transaction('write')
  try {
    if (dropped !== undefined) await tx.execute(`drop index ${dropped}`)
    await copies(tx, backlog, rounds)
    for (const prior of before) await tx.execute({ sql: prior.sql, args: prior.args as number[] })
    const plan = await planRows(tx, statement)
    const steps = async () =>
      Number(
        (
          await tx.execute({
            sql: 'select nstep from sqlite_stmt where sql = ?',
            args: [statement.sql],
          })
        ).rows[0]?.nstep ?? 0,
      )
    const start = await steps()
    const ran = await tx.execute({ sql: statement.sql, args: statement.args as number[] })
    return { steps: (await steps()) - start, changed: ran.rowsAffected, plan }
  } finally {
    await tx.rollback()
  }
}

/** One statement's work beside the small backlog and beside the large one. */
export async function measure(
  client: Client,
  backlog: Backlog,
  before: readonly Statement[],
  statement: Statement,
  dropped?: string,
): Promise<{ small: Measured; large: Measured }> {
  return {
    small: await measureAt(client, backlog, SCALES.small, before, statement, dropped),
    large: await measureAt(client, backlog, SCALES.large, before, statement, dropped),
  }
}

/** Whether the work grew with the backlog: by steps for any statement, by rows for a write. */
export const grew = (small: Measured, large: Measured): boolean =>
  large.steps > small.steps * 1.5 + 5 || large.changed > small.changed * 1.5 + 2

const WHERE_WORD = /^where\b/i

/**
 * A statement's text without its WHERE, the one at the top level: an UPDATE or DELETE that
 * takes every row of its table. The text is read for quotes and parentheses only.
 */
export function withoutWhere(sql: string): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string
    if (quote !== undefined) {
      if (c === quote) quote = undefined
    } else if (c === "'" || c === '"') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && WHERE_WORD.test(sql.slice(i, i + 6)) && !/\w/.test(sql[i - 1] ?? ' ')) {
      return sql.slice(0, i).trimEnd()
    }
  }
  return undefined
}

/**
 * Spellings of one statement that mean what it means: a comment or blank space ahead of it,
 * and for a write the table under its schema's name, the write under a conflict clause, and
 * the table's name in quotes or out of them. Each is the same statement to the database, so
 * a reader that judges one differently from the statement it came from has misread a text.
 */
export function spellings(sql: string): Record<string, string> {
  const out: Record<string, string> = {
    'a block comment first': `/* the statement */ ${sql}`,
    'a line comment first': `-- the statement\n${sql}`,
    'blank space first': `\n   ${sql}`,
  }
  const write = /^(\s*)(update|delete\s+from)(\s+)("?)(\w+)("?)/i.exec(sql)
  if (write) {
    const [head = '', space = '', verb = '', gap = '', open = '', table = '', close = ''] = write
    const rest = sql.slice(head.length)
    out['the table under its schema'] = `${space}${verb}${gap}main.${open}${table}${close}${rest}`
    out['the table under a quoted schema'] =
      `${space}${verb}${gap}"main".${open}${table}${close}${rest}`
    out['the table quoted or bare'] =
      `${space}${verb}${gap}${open === '' ? `"${table}"` : table}${rest}`
    if (/^update$/i.test(verb)) {
      out['an update under a conflict clause'] =
        `${space}${verb} or ignore${gap}${open}${table}${close}${rest}`
    }
  }
  return out
}
