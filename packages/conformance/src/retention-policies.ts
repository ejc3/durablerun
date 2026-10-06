import { MIN_RETENTION_SECONDS, type RetentionPolicy } from '@durablerun/core'

/**
 * The policies the conformance surfaces purge under (DESIGN.md §3.12), each at the
 * shortest window core takes, so a surface waits no longer than it must and a window
 * core shortened or lengthened moves every one of them.
 */

/** The shortest window a policy may name, in milliseconds. */
export const SHORTEST_WINDOW_MS = MIN_RETENTION_SECONDS * 1000

/** Completed and cancelled tasks at the shortest window, and failed tasks kept. */
export const KEEPING_FAILED: RetentionPolicy = Object.freeze({
  completedSeconds: MIN_RETENTION_SECONDS,
  cancelledSeconds: MIN_RETENTION_SECONDS,
})

/** Every ended state named, at the shortest window. */
export const NAMING_FAILED: RetentionPolicy = Object.freeze({
  ...KEEPING_FAILED,
  failedSeconds: MIN_RETENTION_SECONDS,
})
