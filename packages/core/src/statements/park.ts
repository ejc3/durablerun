import type { ExpressionBuilder } from 'kysely'
import { type SqlFragment, nowValue, rawSql, stampValue } from '../sql-tree.js'
import type { StoreTables } from '../store-tables.js'

/** The claim columns a parked run clears, so it carries no live token, lease deadline, or heartbeat. */
const PARKED_CLAIM_COLUMNS = {
  claimed_by: null,
  claim_expires_at_ms: null,
  heartbeat_at_ms: null,
} as const

/**
 * The same columns as text assignments, for a follow-on that parks a run and is still
 * text. The type holds the two lists to the same columns.
 */
export const PARKED_CLAIM_CLEARED_TEXT = {
  claimed_by: 'NULL',
  claim_expires_at_ms: 'NULL',
  heartbeat_at_ms: 'NULL',
} as const satisfies Record<keyof typeof PARKED_CLAIM_COLUMNS, 'NULL'>

/**
 * What parking a claimed run assigns, for every transition that parks one: the run is
 * due now or sleeps until `wakeAt`, it gives up its claim, and it takes this statement's
 * stamp. `wakeAt` is the store's wake instant, database time plus a relative wake or a
 * validated absolute one.
 */
export function parkAssignments(eb: ExpressionBuilder<StoreTables, 'runs'>, wakeAt: SqlFragment) {
  return {
    state: eb
      .case()
      .when(rawSql<number>(wakeAt, 'value'), '<=', nowValue)
      .then('pending')
      .else('sleeping')
      .end(),
    available_at_ms: rawSql<number>(wakeAt, 'value'),
    ...PARKED_CLAIM_COLUMNS,
    fence_stamp: stampValue,
    fence_at_ms: nowValue,
  }
}
