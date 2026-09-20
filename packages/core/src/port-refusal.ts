import { ChildAwaitRefusedError } from './child-tasks.js'
import { InvalidDurableStringError, PortRefusalError } from './errors.js'

/**
 * Whether a port refused the call for what its caller passed, so that a host answers the
 * caller's mistake as one and keeps every other error a fault of its own. This is the one
 * definition of that family, and it has three classes: `PortRefusalError`, for a reserved
 * name or key and for options that contradict each other, `InvalidDurableStringError`,
 * for a string no store can keep and for an identifier wider than one holds, and
 * `ChildAwaitRefusedError`, for a child that can never end the await. They share no
 * parent, because `InvalidDurableStringError` was released as a TypeError. A number, a
 * retry strategy, or a saga step name that a port refuses is still a bare RangeError,
 * which this does not admit: a bare RangeError is also what a stored row the engine
 * cannot read raises, and that is never the caller's mistake.
 */
export function isPortRefusal(
  error: unknown,
): error is PortRefusalError | InvalidDurableStringError | ChildAwaitRefusedError {
  return (
    error instanceof PortRefusalError ||
    error instanceof InvalidDurableStringError ||
    error instanceof ChildAwaitRefusedError
  )
}
