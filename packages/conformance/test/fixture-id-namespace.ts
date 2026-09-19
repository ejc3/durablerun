import { createHash } from 'node:crypto'
import { IDENTIFIER_CHARACTERS } from '@durablerun/core'

/**
 * The longest namespace that is spelled out: the width, less the `-id-000001` the test id
 * source appends, less 64 characters of room for the names the engine derives from an id.
 * The longest of those is a stored child key: `$spawn:`, a length, the parent id, a colon,
 * and the replay key.
 */
const SPELLED_NAMESPACE_CAP = IDENTIFIER_CHARACTERS - '-id-000001'.length - 64

/**
 * The id namespace a conformance fixture gives its test id source, the same on every
 * dialect. An id is a durable identifier, which holds 255 characters everywhere
 * (DESIGN.md §3.4 rule 10), and a production id is 36. The seed is spelled out, one code
 * point at a time in hexadecimal, so an id read out of a failing test names the case that
 * minted it. The longest seeds of the shared suite, the poison target cases, spell out to
 * ids of up to 276 characters, which no dialect may hold, so a seed that would leave an
 * id too little room is hashed instead.
 */
export function conformanceIdNamespace(seed: number | string): string {
  const spelled = [...String(seed)]
    .map((character) => character.codePointAt(0)?.toString(16))
    .join('_')
  const namespace = `conformance-${spelled || 'empty'}`
  if (namespace.length <= SPELLED_NAMESPACE_CAP) return namespace
  const digest = createHash('sha256').update(String(seed)).digest('hex').slice(0, 24)
  return `conformance-h-${digest}`
}
