/**
 * The local-time boundary. Engine TIME is database time (§3.4 rule 3) — this
 * port exists only for driver-side MECHANICS: how long a loop sleeps, when a
 * hanging launcher call is abandoned. Both are advisory ("wake and look",
 * "give up waiting") so local clock skew can never corrupt anything; the
 * store's fences remain the only truth.
 *
 * Engine code never touches ambient timer or wall-clock APIs directly (the
 * determinism lint enforces it): production uses systemClock (allowlisted,
 * like systemIdSource); tests inject a hand-cranked fake.
 */
export interface Clock {
  /** Local wall-clock ms — for DURATION math only, never engine decisions. */
  nowEpochMs(): number
  /**
   * Resolve after `ms`, or EARLIER when `interrupt` fires (wake pings,
   * shutdown). Never rejects.
   */
  sleep(ms: number, interrupt?: AbortSignal): Promise<void>
}
