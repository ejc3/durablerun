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
 * which the two lists below declare, whatever table or alias the step names. The rule is
 * then two lines over every nest: a step that runs once for each row of another must be
 * keyed, and the step it runs once for each row of must be keyed or due. `meta`, which
 * holds the clock, is read by its key in a subquery of its own, so it joins no nest.
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
 * A column that names one entity: a task, a run, an event, an idempotency key, a driver.
 * A step with an equality on one reads that entity's own rows, however large the queue is.
 */
const ENTITY_COLUMNS = [
  'task_id',
  'run_id',
  'event_name',
  'wake_event',
  'idempotency_key',
  'driver_id',
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
/** The widest reach among loops. No loop at all returns no more than one row. */
const worst = (loops: readonly Loop[]): Reach =>
  REACHES.findLast((reach) => loops.some((loop) => loop.reach === reach)) ?? 'keyed'

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
const EQUALITY = /^([a-z_]+)=\?$/
const RANGE = /^([a-z_]+)[<>]\?$/

/** How a SEARCH's constraint list bounds it: `(queue=? AND state=? AND available_at_ms<?)`. */
function reachOf(access: string): Reach {
  if (access.includes('AUTOMATIC')) return 'walk'
  const constraints = /\(([^()]*)\)$/.exec(access)?.[1]?.split(' AND ') ?? []
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

/** The nests of one statement's plan, judged. */
export function readNests(rows: readonly PlanRow[]): NestReading {
  const nodes = new Map<number, Node>([[0, { detail: '', children: [] }]])
  for (const row of rows) nodes.set(row.id, { detail: row.detail, children: [] })
  for (const row of rows) nodes.get(row.parent)?.children.push(nodes.get(row.id) as Node)
  const faults: string[] = []
  const dueDrivers = new Set<string>()

  /** The loop one SCAN or SEARCH line is, judged against the loops that drive it. */
  function stepLoop(
    node: Node,
    step: RegExpExecArray,
    drivers: readonly Loop[],
    made: Reach | undefined,
  ): Loop {
    const [, kind, , access = ''] = step
    if (node.children.length > 0) faults.push(`cannot read what is under: ${node.detail}`)
    // A table-valued function over one value of the row that drives it, such as `json_each`:
    // no table is read, and as a driver its rows are bounded by no key.
    if (access.startsWith('VIRTUAL TABLE')) return { detail: node.detail, reach: 'walk' }
    // A read of the rows a body made is as bounded as the loops that made them, and it is
    // judged against what drives it as any other step is.
    const reach = made ?? (kind === 'SCAN' ? 'walk' : reachOf(access))
    const loop: Loop = { detail: node.detail, reach }
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
      if (node.detail === 'SCAN CONSTANT ROW') {
        loops.push({ detail: node.detail, reach: 'keyed' })
      } else if (step) {
        loops.push(stepLoop(node, step, drivers, bodies.get(step[2] ?? '')))
      } else if (node.detail === 'MULTI-INDEX OR') {
        // One loop over the rows any of its indexes finds. The legs are alternatives, so
        // none drives another, and the loop is as bounded as its widest leg.
        const legs = node.children.flatMap((index) => {
          if (/^INDEX \d+$/.test(index.detail)) return loopsOf(index.children, drivers)
          faults.push(`cannot read the plan line: ${index.detail}`)
          return []
        })
        loops.push({ detail: legs.map((leg) => leg.detail).join(' OR '), reach: worst(legs) })
      } else if (UNCORRELATED_LIST.test(node.detail)) {
        // Read above, before the steps it drives.
      } else if (subquery) {
        loopsOf(node.children, subquery[1] ? drivers : [])
      } else if (body?.[1]) {
        bodies.set(body[1], worst(loopsOf(node.children, outer)))
      } else if (SELECTS.test(node.detail)) {
        loops.push(...loopsOf(node.children, outer))
      } else if (!SORTS.test(node.detail)) {
        faults.push(`cannot read the plan line: ${node.detail}`)
      }
    }
    return loops
  }
  loopsOf(nodes.get(0)?.children ?? [], [])
  return { faults, dueDrivers: [...dueDrivers] }
}
