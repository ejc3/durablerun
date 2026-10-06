import { TASK_INTRINSICS } from './intrinsics.js'

const { WeakSet: TrustedWeakSet, WeakSetAdd: weakSetAdd, WeakSetHas: weakSetHas } = TASK_INTRINSICS

/** The statements that are the compare-and-set of a purge, by identity. */
const unitPurges = new TrustedWeakSet<object>()

/**
 * Mark a statement as the compare-and-set that purges a task's unit (DESIGN.md §3.12). A
 * batch lets a row of a task's unit be deleted only under the stamp of a statement marked
 * here. This module is not part of the package's entry, and neither is the builder of the
 * one statement it marks (`purgeUnitCas`). So nothing outside core marks a statement, and
 * nothing outside core hands the marked statement a barrier of its own choosing. The mark
 * says which statement may gate a delete. What that statement requires is its builder's,
 * which takes the policy's windows from `retentionWindowsMs` alone and reads the unit's
 * parent from the unit's key itself.
 */
export function markUnitPurge<Statement extends object>(statement: Statement): Statement {
  weakSetAdd(unitPurges, statement)
  return statement
}

/** Whether `markUnitPurge` marked this statement. */
export function isUnitPurge(statement: unknown): boolean {
  return typeof statement === 'object' && statement !== null && weakSetHas(unitPurges, statement)
}
