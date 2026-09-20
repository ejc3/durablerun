/**
 * The loop nests of one statement's plan, read from `EXPLAIN QUERY PLAN`.
 *
 * The property: no step reads a table once for each row of a backlog, and no step reads a
 * backlog once for each row of anything. A statement that breaks it costs what the queue
 * holds, not what the statement was handed: a task update that scans `tasks` and probes its
 * source run once for each task, a wake that walks the pending runs of a queue and reads
 * `tasks` once for each of them.
 *
 * A plan is a tree. Under one select, the `SCAN` and `SEARCH` lines are its nested loops,
 * outermost first, and a `CORRELATED` subquery runs once for each row of the loops listed
 * before it. A subquery that is not correlated runs once for the statement, so it starts a
 * nest of its own, but the rows of a `LIST SUBQUERY` are what an `IN` seeks with, so they
 * drive the loops of the select that holds it. A `CO-ROUTINE` or `MATERIALIZE` body runs
 * once for each run of the select that reads it, and the step that reads its rows is as
 * bounded as the loops that made them.
 *
 * A plan carries no row counts, so a step's bound is what its constrained columns mean,
 * which the two lists below declare, whatever table or alias the step names. A step is
 * keyed, or it is a due range, or it is a walk: a SCAN line, with an index or without one,
 * a SEARCH through an automatic index, and a SEARCH whose constraint list holds no
 * equality on a column of the first list and no range on a column of the second.
 *
 * The rule is three lines. Over every step that reads a table: a walk is refused where it
 * stands, in a statement of any kind, whether or not anything drives it or it drives
 * anything, because a walk that stands alone joins no nest and costs what the table holds
 * all the same. Over every nest: a step that runs once for each row of another must be
 * keyed, and the step it runs once for each row of must be keyed or due.
 *
 * An UPDATE or a DELETE is held to two lines more, over the table it writes, which its
 * text names. Its plan must have a step over that table: a DELETE with no WHERE takes
 * SQLite's truncate path and plans as no rows at all, so no line above has a step to judge.
 * And that step may not be a due range, because a write carries no LIMIT, so a range over
 * what is due takes all of it at once. An INSERT of values also plans as no rows, which is
 * why the two lines go by the statement's kind. Its first word says the kind, and a
 * statement whose first word does not, or a write whose table cannot be named, is refused.
 *
 * No table is excused, so there is no list of tables to keep. `meta`, which holds the
 * clock, is read by its key, and `key` stands in the first list. A step that reads no
 * table is not a walk of one: `json_each` reads a value of the row that drives it, and a
 * step that reads the rows of a body is as bounded as the steps that made them, each of
 * which is judged where it stands. The fault names the table by what the statement's own
 * text calls it, because a plan names a step by the table's alias.
 *
 * A due range is bounded by the statement's LIMIT, which a plan never prints, and a plan
 * prints a range the same way whichever way it points: the leases that have expired and
 * the leases that have not are both `claim_expires_at_ms>? AND claim_expires_at_ms<?`. So
 * the reading also reports each due range that drives another step, and the test holds
 * those to a list of the statements where one may, each with the limit that bounds it.
 */
export interface PlanRow {
  readonly id: number
  readonly parent: number
  readonly detail: string
}

/**
 * A column that names one entity: a task, a run, an event, an idempotency key, a driver, a
 * claim, a row of `meta`. A step with an equality on one reads that entity's own rows,
 * however large the queue is. A claim token names one claim, and one claim holds at most
 * its limit of runs, because `claim` takes nothing under a token that already holds a run.
 * `key` is the primary key of `meta`, whose rows are the clock and the schema's versions.
 */
const ENTITY_COLUMNS = [
  'task_id',
  'run_id',
  'event_name',
  'wake_event',
  'idempotency_key',
  'driver_id',
  'claimed_by',
  'key',
]

/**
 * A column an index hands work out in the order of: what is due to run, whose lease has
 * expired, whose start deadline has passed. A range on one reads what is due, in order,
 * and the statement's limit says how much of it. The plan does not show the limit.
 */
const DUE_COLUMNS = ['available_at_ms', 'claim_expires_at_ms', 'cancel_at_ms']

/** `keyed` reads one entity's rows, `due` reads what is due in index order, `walk` a backlog. */
const REACHES = ['keyed', 'due', 'walk'] as const
type Reach = (typeof REACHES)[number]
/** The widest reach among loops. Of no loops at all it is a walk: nothing read bounds them. */
const worst = (loops: readonly Loop[]): Reach =>
  REACHES.findLast((reach) => loops.some((loop) => loop.reach === reach)) ?? 'walk'

/** One loop of a nest: a plan step, with how it bounds its rows. */
interface Loop {
  readonly detail: string
  readonly reach: Reach
}

interface Node {
  readonly detail: string
  readonly children: Node[]
}

const STEP = /^(SCAN|SEARCH) (\S+)(?: (.*))?$/
const SUBQUERY = /^(CORRELATED )?(?:SCALAR|LIST) SUBQUERY \d+$/
/** The list an `IN` seeks with, when nothing outside it changes what it holds. */
const UNCORRELATED_LIST = /^LIST SUBQUERY \d+$/
const BODY = /^(?:CO-ROUTINE|MATERIALIZE) (\S+)$/
const SELECTS =
  /^(?:COMPOUND QUERY|LEFT-MOST SUBQUERY|(?:UNION|INTERSECT|EXCEPT)(?: ALL| USING TEMP B-TREE)?)$/
const SORTS = /^USE TEMP B-TREE FOR /
/** The rows of a VALUES, one or several: no table is read, and their count is in the text. */
const CONSTANT_ROWS = /^SCAN (?:CONSTANT ROW|\d+ CONSTANT ROWS)$/
/** A statement's first word, which says what kind it is. */
const KIND = /^\s*(select|insert|replace|update|delete|with)\b/i
/** An UPDATE or a DELETE, by its first words: the table it writes, and its alias there. */
const WRITE = /^\s*(?:update|delete\s+from)\s+(?:"?\w+"?\.)?"?(\w+)"?(?:\s+as\s+"?(\w+)"?)?/i
const EQUALITY = /^([a-z_]+)=\?$/
const RANGE = /^([a-z_]+)[<>]\?$/

/** How a SEARCH's constraint list bounds it: `(queue=? AND state=? AND available_at_ms<?)`. */
function reachOf(access: string): Reach {
  if (access.includes('AUTOMATIC')) return 'walk'
  // The list is not always the end of its line: a left join's step ends in `LEFT-JOIN`.
  const constraints = /\(([^()]*)\)/.exec(access)?.[1]?.split(' AND ') ?? []
  const columns = (shape: RegExp) => constraints.map((c) => shape.exec(c)?.[1] ?? '')
  if (columns(EQUALITY).some((column) => ENTITY_COLUMNS.includes(column))) return 'keyed'
  if (columns(RANGE).some((column) => DUE_COLUMNS.includes(column))) return 'due'
  return 'walk'
}

export interface NestReading {
  /**
   * What is wrong with the nests, as sentences. A plan line that cannot be read is a fault
   * too: a plan this does not understand is not a plan it has passed.
   */
  readonly faults: string[]
  /** Each due range that another step runs once for each row of. */
  readonly dueDrivers: string[]
}

/**
 * The table a step reads, for the wording of a fault and for nothing else. A plan names a
 * step by the alias its statement gave the table, so the name is looked up in the text:
 * the table that a FROM, a JOIN, an UPDATE or the comma of a join introduces, under a
 * schema's name or not, and calls by it. An INTO is not read, because a plan has no step
 * for the table an INSERT writes. A name the text gives to no table is the table's own.
 * The name is a best effort, because the text is read with no scope: an alias inside a
 * subquery that is another table's own name words that table's step with the subquery's
 * table. A wrong name sends its reader to the wrong table, and it passes nothing.
 */
function tableCalled(name: string, sql: string): string {
  const called = new RegExp(
    `(?:\\b(?:from|join|update)\\s+|,\\s*)(?:"?\\w+"?\\.)?"?(\\w+)"?\\s+(?:as\\s+)?"?${name.replace(/\W/g, '\\$&')}"?(?![\\w"])`,
    'gi',
  )
  const tables = new Set([...sql.matchAll(called)].map((match) => (match[1] ?? name).toLowerCase()))
  return tables.size > 0 ? [...tables].join(' or ') : name
}

/** The steps of a statement's own select: the lines under no subquery, an OR's legs too. */
function ownSteps(children: readonly Node[]): RegExpExecArray[] {
  return children.flatMap((node) => {
    if (node.detail === 'MULTI-INDEX OR') {
      return node.children.flatMap((leg) => ownSteps(leg.children))
    }
    const step = STEP.exec(node.detail)
    return step ? [step] : []
  })
}

/** What is wrong with how a write reaches the table it writes, which no step or nest shows. */
function writeFaults(own: readonly Node[], sql: string): string[] {
  // The two lines go by the statement's kind, so a statement whose first word does not say
  // its kind is refused, as a plan line that cannot be read is.
  const kind = KIND.exec(sql)?.[1]?.toLowerCase()
  if (kind === undefined) return ['cannot tell what kind of statement this is from its first word']
  // A write under a WITH names its table after bodies this does not read.
  if (kind === 'with' && /\b(?:update|delete)\b/i.test(sql)) {
    return ['cannot tell which table a write that begins with WITH writes']
  }
  if (kind !== 'update' && kind !== 'delete') return []
  const write = WRITE.exec(sql)
  if (!write) return ['cannot name the table this write writes']
  const [, table = '', alias = table] = write
  const names = [table.toLowerCase(), alias.toLowerCase()]
  const over = ownSteps(own).filter((step) => names.includes((step[2] ?? '').toLowerCase()))
  if (over.length === 0) {
    return [`no step of the plan is over ${table}, the table the statement writes`]
  }
  const written = 'the table the statement writes, and a write carries no LIMIT'
  return over
    .filter(([, kind, , access = '']) => kind === 'SEARCH' && reachOf(access) === 'due')
    .map(([line]) => `${line} :: is a due range over ${table}, ${written}`)
}

/**
 * The steps and the nests of one statement's plan, judged, and a write's reach of its table.
 * The text says what kind of statement it is and words a fault.
 */
export function readNests(rows: readonly PlanRow[], sql: string): NestReading {
  const nodes = new Map<number, Node>([[0, { detail: '', children: [] }]])
  for (const row of rows) nodes.set(row.id, { detail: row.detail, children: [] })
  const faults: string[] = []
  for (const row of rows) {
    const parent = nodes.get(row.parent)
    if (parent) parent.children.push(nodes.get(row.id) as Node)
    else faults.push(`cannot place the plan line: ${row.detail}`)
  }
  const dueDrivers = new Set<string>()

  /** The loop one SCAN or SEARCH line is, judged against the loops that drive it. */
  function stepLoop(
    node: Node,
    step: RegExpExecArray,
    drivers: readonly Loop[],
    made: Reach | undefined,
  ): Loop {
    const [, kind, name = '', access = ''] = step
    if (node.children.length > 0) faults.push(`cannot read what is under: ${node.detail}`)
    // A table-valued function over one value of the row that drives it, such as `json_each`:
    // no table is read, and as a driver its rows are bounded by no key.
    if (access.startsWith('VIRTUAL TABLE')) return { detail: node.detail, reach: 'walk' }
    // A read of the rows a body made is as bounded as the loops that made them, and it is
    // judged against what drives it as any other step is.
    const reach = made ?? (kind === 'SCAN' ? 'walk' : reachOf(access))
    const loop: Loop = { detail: node.detail, reach }
    // A walk of a table is refused where it stands, whatever drives it and whatever it
    // drives. The rows of a body are no table's, and the steps that made them are judged.
    if (made === undefined && reach === 'walk') {
      const table = tableCalled(name, sql)
      faults.push(`${loop.detail} :: is a walk of ${table}: neither keyed nor a due range`)
    }
    if (drivers.length > 0 && loop.reach !== 'keyed') {
      const each = drivers.map((driver) => driver.detail).join(' and of ')
      faults.push(`${loop.detail} :: is not keyed, and runs once for each row of ${each}`)
    }
    for (const driver of drivers) {
      if (driver.reach === 'due') dueDrivers.add(driver.detail)
      if (driver.reach === 'walk') {
        faults.push(`${loop.detail} :: runs once for each row of a walk: ${driver.detail}`)
      }
    }
    return loop
  }

  /** The loops that make the rows of one select, each step judged against what drives it. */
  function loopsOf(children: readonly Node[], outer: readonly Loop[]): Loop[] {
    // The rows of an IN list are sought with one at a time, and the plan lists the list
    // after the step that seeks with it, so the lists are read first.
    const lists = children
      .filter((node) => UNCORRELATED_LIST.test(node.detail))
      .flatMap((node) => loopsOf(node.children, []))
    // A body is known by its name to the select that holds its line, and to no other: a
    // table elsewhere in the plan may carry the same name, and is judged as the table it is.
    const bodies = new Map<string, Reach>()
    const loops: Loop[] = []
    for (const node of children) {
      const drivers = [...outer, ...lists, ...loops]
      const step = STEP.exec(node.detail)
      const subquery = SUBQUERY.exec(node.detail)
      const body = BODY.exec(node.detail)
      if (CONSTANT_ROWS.test(node.detail)) {
        loops.push({ detail: node.detail, reach: 'keyed' })
      } else if (step) {
        loops.push(stepLoop(node, step, drivers, bodies.get(step[2] ?? '')))
      } else if (node.detail === 'MULTI-INDEX OR') {
        // One loop over the rows any of its indexes finds. The legs are alternatives, so
        // none drives another, and the loop is as bounded as its widest leg.
        const legs = node.children.flatMap((index) => {
          if (!/^INDEX \d+$/.test(index.detail)) {
            faults.push(`cannot read the plan line: ${index.detail}`)
            return []
          }
          const leg = loopsOf(index.children, drivers)
          if (leg.length === 0) faults.push(`cannot read the rows of: ${index.detail}`)
          return leg
        })
        if (node.children.length === 0) faults.push(`cannot read the rows of: ${node.detail}`)
        loops.push({ detail: legs.map((leg) => leg.detail).join(' OR '), reach: worst(legs) })
      } else if (UNCORRELATED_LIST.test(node.detail)) {
        // Read above, before the steps it drives.
      } else if (subquery) {
        loopsOf(node.children, subquery[1] ? drivers : [])
      } else if (body?.[1]) {
        const made = loopsOf(node.children, outer)
        if (made.length === 0) faults.push(`cannot read the rows of: ${node.detail}`)
        bodies.set(body[1], worst(made))
      } else if (SELECTS.test(node.detail)) {
        loops.push(...loopsOf(node.children, outer))
      } else if (SORTS.test(node.detail)) {
        if (node.children.length > 0) faults.push(`cannot read what is under: ${node.detail}`)
      } else {
        faults.push(`cannot read the plan line: ${node.detail}`)
      }
    }
    return loops
  }
  const own = nodes.get(0)?.children ?? []
  loopsOf(own, [])
  faults.push(...writeFaults(own, sql))
  return { faults, dueDrivers: [...dueDrivers] }
}
