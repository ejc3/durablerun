import type { OperationNode } from 'kysely'
import { describe, expect, it } from 'vitest'
import { treeBuilder as db } from '../src/index.js'
import { children, readingOnce, someNode } from '../src/tree-walk.js'

/** The reading the walk replaced: every field of every node, read again on every pass. */
function freshChildren(node: OperationNode): OperationNode[] {
  if (node.kind === 'ValueNode') return []
  const isNode = (value: unknown): value is OperationNode =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  )
}
function freshOrder(node: OperationNode): OperationNode[] {
  return [node, ...freshChildren(node).flatMap(freshOrder)]
}
function walkOrder(node: OperationNode): OperationNode[] {
  const seen: OperationNode[] = []
  someNode(node, (each) => {
    seen.push(each)
    return false
  })
  return seen
}

const statement = () =>
  db
    .updateTable('runs')
    .set({ state: 'pending', attempt: 2 })
    .where('state', 'in', ['running', 'sleeping'])
    .where((eb) =>
      eb.exists(
        eb.selectFrom('tasks as t').select('t.task_id').whereRef('t.task_id', '=', 'runs.task_id'),
      ),
    )
    .toOperationNode()

describe('the one walk of a tree', () => {
  it('meets the nodes a fresh depth-first reading meets, in its order', () => {
    const tree = statement()
    const fresh = freshOrder(tree)
    expect(fresh.length).toBeGreaterThan(20)
    expect(walkOrder(tree), 'mutation-verdict:construction:tree-walk-reads-below-the-root').toEqual(
      fresh,
    )
    readingOnce(() => expect(walkOrder(tree)).toEqual(fresh))
  })

  it('gives every node the children a fresh reading gives it', () => {
    const tree = statement()
    readingOnce(() => {
      for (const node of freshOrder(tree)) expect(children(node)).toEqual(freshChildren(node))
    })
  })

  it('reads the subtree of a node below the root, and nothing beside it', () => {
    const tree = statement()
    readingOnce(() => {
      walkOrder(tree)
      for (const node of freshOrder(tree)) expect(walkOrder(node)).toEqual(freshOrder(node))
    })
  })

  it('stops at the first node that passes, as a depth-first search does', () => {
    const tree = statement()
    const fresh = freshOrder(tree)
    const third = fresh[2]
    const asked: OperationNode[] = []
    expect(
      someNode(tree, (each) => {
        asked.push(each)
        return each === third
      }),
    ).toBe(true)
    expect(asked).toEqual(fresh.slice(0, 3))
  })

  it('reads a node placed twice in both places', () => {
    const shared = db.selectFrom('tasks').select('task_id').toOperationNode()
    const twice = { kind: 'ParensNode', node: { kind: 'AndNode', left: shared, right: shared } }
    const order = walkOrder(twice as OperationNode)
    expect(order).toEqual(freshOrder(twice as OperationNode))
    expect(order.filter((each) => each === shared)).toHaveLength(2)
  })

  it('reads a tree again once the checks that read it have returned', () => {
    const list: OperationNode[] = [{ kind: 'IdentifierNode' } as OperationNode]
    const tree = { kind: 'ValueListNode', values: list } as OperationNode
    readingOnce(() => {
      expect(walkOrder(tree)).toHaveLength(2)
      // Inside one run of checks the first reading stands.
      list.push({ kind: 'IdentifierNode' } as OperationNode)
      expect(walkOrder(tree)).toHaveLength(2)
    })
    expect(walkOrder(tree)).toHaveLength(3)
  })

  it('keeps one record for checks that run inside other checks', () => {
    const tree = statement()
    readingOnce(() => {
      const first = children(tree)
      readingOnce(() => expect(children(tree)).toBe(first))
      expect(children(tree)).toBe(first)
    })
  })
})
