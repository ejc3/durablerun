/** This statement's own provenance value: `<seed>:<statement name>`. */
export const STAMP = '$STAMP$'

/** The batch's clock expression, spliced as SQL. Legal only in a CAS. */
export const NOW = '$NOW$'

/** The prefix of a fence token in statement text: `$FENCE:<statement name>$`. */
export const FENCE_PREFIX = '$FENCE:'
