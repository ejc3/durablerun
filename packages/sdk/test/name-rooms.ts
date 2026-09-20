import { IDENTIFIER_CHARACTERS, SAGA_TRIES_PREFIX, childSpawnKey } from '@durablerun/core'

/**
 * The longest durable name the engine builds from each name a task passes (DESIGN.md §3.4
 * rule 10). A name's room is what that leaves of the width. This is the one place the SDK's
 * tests state it: the replay-equivalence harness's name-length axis and the focused width
 * cases both take their lengths from here, so they cannot hold two tables that drift.
 */
export const LONGEST_NAME_BUILT = {
  step: (name: string) => name,
  /** The second use of a name is stored under a counter, which the name's own length hides. */
  stepUsedTwice: (name: string) => `${name}#2`,
  /** A registered step's key must leave room for the longest of its saga names. */
  registeredStep: (name: string) => `${SAGA_TRIES_PREFIX}${name}`,
  awaitEvent: (name: string) => `$await:${name}`,
  /** An emit has no key. The name itself is what is stored. */
  emitEvent: (name: string) => name,
  /** The name here is the child's id, which is the engine's. */
  awaitTask: (childTaskId: string) => `$await-task:${childTaskId}`,
  /** A child's task name, under the parent whose id the stored child key holds. */
  spawnUnder: (parentTaskId: string) => (name: string) =>
    childSpawnKey(parentTaskId, `$spawn:${name}`),
} as const

/** The room a name has: the width, less what the engine adds to the name. */
export function roomOf(longest: (name: string) => string): number {
  return IDENTIFIER_CHARACTERS - [...longest('')].length
}
