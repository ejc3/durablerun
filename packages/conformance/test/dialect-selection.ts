/**
 * The dialects enrolled in conformance, in enrollment order, and the one parser of
 * `DURABLERUN_CONFORMANCE_DIALECTS`, a comma list that narrows a run to the servers it
 * has so CI can give each server its own parallel job. A name that is not enrolled, a
 * repeated name, or an empty list fails the run: a narrowed gate must never be an empty
 * one. This file imports nothing, because the root vitest configuration loads it too.
 */
export const ENROLLED_DIALECTS = ['libsql', 'postgres', 'mysql'] as const
export type EnrolledDialect = (typeof ENROLLED_DIALECTS)[number]

export function parseDialectSelection(selection: string | undefined): readonly EnrolledDialect[] {
  if (selection === undefined) return ENROLLED_DIALECTS
  const names = selection.split(',').map((name) => name.trim())
  const enrolled: readonly string[] = ENROLLED_DIALECTS
  const unknown = names.filter((name) => !enrolled.includes(name))
  if (unknown.length > 0 || new Set(names).size !== names.length) {
    throw new Error(
      `DURABLERUN_CONFORMANCE_DIALECTS must list distinct enrolled dialects (${ENROLLED_DIALECTS.join(', ')}), got '${selection}'`,
    )
  }
  return ENROLLED_DIALECTS.filter((dialect) => names.includes(dialect))
}
