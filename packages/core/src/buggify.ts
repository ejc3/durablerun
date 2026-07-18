/**
 * Buggification (FDB adoption): engine code carries named sites where it may
 * deliberately take a LEGAL-BUT-RARE path — a spuriously lost lease, a short
 * claim batch, an activation reported lost. Production uses neverBuggify;
 * simulations inject a seeded implementation so every rare path gets
 * exercised under every schedule.
 *
 * The iron rule: a buggify site may only FORCE behavior the system already
 * permits (and must survive) — never corrupt state, never break an
 * invariant. If forcing a site fails a test, the engine had a real bug.
 */
export type Buggify = (site: string) => boolean

export const neverBuggify: Buggify = () => false
