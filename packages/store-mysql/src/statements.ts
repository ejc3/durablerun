import { type SqlFragment, aliasedAs, defineStatement, rawSql, treeBuilder } from '@durablerun/core'

/**
 * `next-wake` on MySQL: the earliest instant anything in a queue comes due, or NULL. The
 * other stores take the minimum of each source, which MySQL does not answer from an index.
 * Here each leg is the store's own scalar subquery, the first row of its source in index order,
 * with the index hint inside it: the grammar lists no hint, so a hint stays in a fragment,
 * as the claim's does. A source with no row reads NULL, which MIN passes over.
 */
export const nextWakeRead = defineStatement(
  'next-wake',
  (binds: { legs: readonly SqlFragment[] }) => {
    const [first, ...rest] = binds.legs.map((leg) =>
      treeBuilder.selectNoFrom(aliasedAs(rawSql<number | null>(leg, 'value'), 'v')),
    )
    if (first === undefined) throw new Error('next-wake reads at least one wake source')
    const legs = rest.reduce((all, leg) => all.unionAll(leg), first)
    return treeBuilder
      .selectFrom(legs.as('wakes'))
      .select((eb) => eb.fn.min('wakes.v').as('wake_ms'))
  },
)
