import { type OperationNode, ValueNode } from 'kysely'
import { TASK_INTRINSICS } from './intrinsics.js'

// Task code shares this process, so what is kept across calls lives in a collection
// captured at module load, and node fields are read through captured operations.
const {
  ArrayIsArray: arrayIsArray,
  ObjectFreeze: objectFreeze,
  ObjectKeys: objectKeys,
  ReflectGet: reflectGet,
  WeakMap: TrustedWeakMap,
  WeakMapGet: weakMapGet,
  WeakMapSet: weakMapSet,
} = TASK_INTRINSICS

function isNode(value: unknown): value is OperationNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}

/**
 * One walk of a node's object graph: the node and everything below it, in the order a
 * depth-first reader meets them. `ends[i]` is one past the last node below `nodes[i]`, and
 * `kids[i]` is the children of `nodes[i]`. Kysely has no read-only walker, so a walk reads
 * node fields generically, and each check of a statement used to pay for that reading again.
 */
interface Walk {
  readonly nodes: OperationNode[]
  readonly ends: number[]
  readonly kids: (readonly OperationNode[])[]
}
type Place = { readonly walk: Walk; readonly at: number }

/** Where each node stands in the walk that read it, while `readingOnce` runs. */
let walked: WeakMap<object, Place> | null = null
const NO_CHILDREN: readonly OperationNode[] = objectFreeze([])

/**
 * Run a statement's checks with its object graph read once. The checks run in one
 * synchronous turn and nothing else can touch the tree meanwhile, so what the first pass
 * read holds for the rest. The record is dropped when the checks return, so a tree that
 * changes between two statements is read again. A pass asked for outside any such run
 * opens one for itself, so there is one way to read a tree and not two.
 */
export function readingOnce<T>(checks: () => T): T {
  if (walked !== null) return checks()
  walked = new TrustedWeakMap()
  try {
    return checks()
  } finally {
    walked = null
  }
}

/** A node's children, read from its fields. A value node holds a value, which is no node to read. */
function readChildren(node: OperationNode): readonly OperationNode[] {
  if (ValueNode.is(node)) return NO_CHILDREN
  const out: OperationNode[] = []
  for (const key of objectKeys(node)) {
    const value: unknown = reflectGet(node, key)
    if (arrayIsArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item)
    } else if (isNode(value)) {
      out.push(value)
    }
  }
  return out
}

/** Where a node stands, reading its subtree the first time any node of it is asked for. */
function placeOf(record: WeakMap<object, Place>, node: OperationNode): Place {
  const known = weakMapGet(record, node)
  if (known !== undefined) return known
  const walk: Walk = { nodes: [], ends: [], kids: [] }
  const visit = (current: OperationNode): void => {
    const at = walk.nodes.length
    const kids = readChildren(current)
    walk.nodes.push(current)
    walk.ends.push(at)
    walk.kids.push(kids)
    // A node placed twice keeps its first place: both places hold the same subtree.
    if (weakMapGet(record, current) === undefined) weakMapSet(record, current, { walk, at })
    for (const child of kids) visit(child)
    walk.ends[at] = walk.nodes.length
  }
  visit(node)
  return weakMapGet(record, node) ?? { walk, at: 0 }
}

/** Every child node. */
export function children(node: OperationNode): readonly OperationNode[] {
  if (walked === null) return readingOnce(() => children(node))
  const { walk, at } = placeOf(walked, node)
  return walk.kids[at] ?? NO_CHILDREN
}

/** Whether the node or anything below it passes the test, asked in depth-first order. */
export function someNode(node: OperationNode, test: (node: OperationNode) => boolean): boolean {
  if (walked === null) return readingOnce(() => someNode(node, test))
  const { walk, at } = placeOf(walked, node)
  const end = walk.ends[at] ?? at
  for (let index = at; index < end; index++) {
    const each = walk.nodes[index]
    if (each !== undefined && test(each)) return true
  }
  return false
}
