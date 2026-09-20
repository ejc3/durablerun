import { LeaseLostError, type SchedulerStore, type SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MATRIX_WRITE_LABELS } from './fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import {
  HEALTHY_INVOCATION,
  type InvocationTarget,
  POISON_INVOCATION,
  invoke,
  seedBase,
  seedHealthyTrigger,
  snapshot,
} from './poison-matrix.js'
import { describeFailure, withFixture } from './scenario.js'

/**
 * Generated stale-caller surface.
 *
 * A worker write is fenced on the claim its caller presents: the claim token, and for a
 * claim receipt the claim's generation too (DESIGN.md §3.4 rules 4 and 5). Each
 * compare-and-set composes that comparison by its own choice, and the rules that read a
 * batch read the fences between its statements, not which binds a statement compares.
 * A statement that leaves the token out passes all of them. Stale-caller tests were
 * written by hand, one operation at a time, and `failRollback` had none: with its token
 * comparison removed a stale caller ended a saga and every test stayed green.
 *
 * So the cases are generated. A write label is in the column exactly when the poison
 * matrix's `invoke` hands its port call the target's claim token or generation, which is
 * read by calling `invoke` over a store that records its arguments. A new label that
 * presents a claim gets its case without being listed, and a label that presents none
 * cannot be listed. Each case seeds the label's healthy target from the poison matrix's
 * own seeds, calls the label as a caller that does not hold the claim, and requires the
 * port's lost-lease answer and six unchanged tables. Then it makes the same call as the
 * claim's holder and requires it to win, so the claim presented is the only difference
 * between the call that was refused and the call that was not. A seed in which the label
 * is refused for some other reason fails there, and does not pass for a fence.
 *
 * The lease sweeps present no token. They act on the claim their scan read (§3.4), so
 * their stale caller is a scan that read another generation.
 */

type WriteLabel = (typeof MATRIX_WRITE_LABELS)[number]
type ClaimPart = 'token' | 'generation'

/** Values no seed and no invocation holds, so an argument equal to one was read from the target. */
const TOKEN_PROBE = 'stale-token-column:token-probe'
const GENERATION_PROBE = 1_234_567

interface Presented {
  readonly label: WriteLabel
  /** The port method the label's invocation calls. */
  readonly method: string
  /** The parts of its claim the invocation presents, in the order the case checks them. */
  readonly parts: readonly ClaimPart[]
}

const carries = (value: unknown, probe: string | number): boolean =>
  value === probe ||
  (typeof value === 'object' &&
    value !== null &&
    Object.values(value).some((inner) => carries(inner, probe)))

/** What `invoke` presents for `label`, read from the one port call it makes. */
function presentedBy(label: WriteLabel): Presented {
  const calls: { method: string; args: readonly unknown[] }[] = []
  const recorder = new Proxy({} as SchedulerStore, {
    get:
      (_store, method) =>
      (...args: unknown[]) => {
        calls.push({ method: String(method), args })
        return Promise.resolve(undefined)
      },
  })
  // `invoke` reaches its port call before its first await, so the call is on record by
  // the time `invoke` hands back its promise.
  invoke(label, recorder, {
    ...HEALTHY_INVOCATION,
    token: TOKEN_PROBE,
    claimGen: GENERATION_PROBE,
  }).catch(() => undefined)
  const [call, ...others] = calls
  if (call === undefined || others.length > 0) {
    throw new Error(`invoking '${label}' made ${calls.length} port calls, and the column reads one`)
  }
  const parts: ClaimPart[] = []
  if (carries(call.args, TOKEN_PROBE)) parts.push('token')
  if (carries(call.args, GENERATION_PROBE)) parts.push('generation')
  return { label, method: call.method, parts }
}

const PRESENTED = MATRIX_WRITE_LABELS.map(presentedBy)

/** The column: every write label whose invocation presents a part of its claim. */
export const STALE_CALLER_CASES: readonly Presented[] = PRESENTED.filter(
  ({ parts }) => parts.length > 0,
)

type Outcome = { kind: 'resolved'; value: unknown } | { kind: 'rejected'; error: string }

const outcomeOf = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (value) => ({ kind: 'resolved', value }),
    (error: unknown) => ({
      kind: 'rejected',
      error: error instanceof LeaseLostError ? 'LeaseLostError' : describeFailure(error),
    }),
  )

/**
 * The labels whose port method reports a lost lease in its answer, with that answer.
 * Every other label refuses by throwing LeaseLostError, and never RunCancelledError: no
 * task here is cancelled.
 */
const ANSWERED_REFUSALS: Partial<Record<WriteLabel, unknown>> = {
  activate: null,
  heartbeat: { held: false, remainingMs: 0, reason: 'lease-lost' },
  'expire-lease-now': false,
}

const refusalOf = (label: WriteLabel): Outcome =>
  label in ANSWERED_REFUSALS
    ? { kind: 'resolved', value: ANSWERED_REFUSALS[label] }
    : { kind: 'rejected', error: 'LeaseLostError' }

/** The callers that do not hold the claim, for each part of it, given the caller that does. */
const STALE_CALLERS: Record<
  ClaimPart,
  (holder: InvocationTarget) => Record<string, InvocationTarget>
> = {
  token: (holder) => ({
    'a token no claim holds': { ...holder, token: 'stale-token-column:never-issued' },
    // A comparison that asks whether any run is held under the token, and not whether
    // this run is, refuses the first caller and admits this one.
    'the token of another live claim': { ...holder, token: POISON_INVOCATION.token },
  }),
  generation: (holder) => ({
    'the generation of the claim before': { ...holder, claimGen: holder.claimGen - 1 },
  }),
}

/** Seeds the label's healthy target and answers with the caller that holds its claim. */
async function seedHolder(f: StoreFixture, presented: Presented): Promise<InvocationTarget> {
  await seedBase(f)
  await seedHealthyTrigger(f.raw, presented.label)
  if (!presented.parts.includes('generation')) return HEALTHY_INVOCATION
  // The stale caller of a claim receipt is the claim before it, so the run is one that
  // was claimed a second time.
  await f.raw.batch(
    'stale-token:claimed-again',
    [
      {
        sql: 'UPDATE runs SET claim_gen = claim_gen + 1 WHERE run_id = ?',
        args: [HEALTHY_INVOCATION.runId],
      },
    ],
    'write',
  )
  return { ...HEALTHY_INVOCATION, claimGen: HEALTHY_INVOCATION.claimGen + 1 }
}

type SweepLabel = Extract<WriteLabel, `sweep:${string}`>

/**
 * Whether a sweep's scan hands its write the generation of the claim it found. The type
 * asks every sweep label for an answer, and each case checks that answer against the
 * scan the store sends.
 */
const SCAN_READS_A_GENERATION = {
  'sweep:cancel': false,
  'sweep:lost-launch': true,
  'sweep:claim-timeout': true,
} as const satisfies Record<SweepLabel, boolean>

/** An executor whose sweep scan reports `runId` one claim later than the run stands. */
function scanOfALaterClaim(raw: SqlExecutor, runId: string) {
  let rewritten = 0
  const later = (value: unknown) => (typeof value === 'bigint' ? value + 1n : Number(value) + 1)
  const executor: SqlExecutor = {
    batch: async (label, statements, control) => {
      const results = await raw.batch(label, statements, control)
      if (label !== 'sweep:scan') return results
      return results.map((result) => ({
        ...result,
        rows: result.rows.map((row) => {
          if (row.run_id !== runId || row.claim_gen === undefined) return row
          rewritten += 1
          // Both counters move together, so the row stays in the arm its scan chose.
          return {
            ...row,
            claim_gen: later(row.claim_gen),
            activated_gen: later(row.activated_gen),
          }
        }),
      }))
    },
  }
  return { executor, rewritten: () => rewritten }
}

export function staleTokenConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`stale-token column [${dialect}] (write label x caller that does not hold the claim)`, () => {
    it('enrolls exactly the write labels whose invocation presents a claim', () => {
      expect(
        Object.fromEntries(STALE_CALLER_CASES.map(({ label, parts }) => [label, parts])),
      ).toEqual({
        activate: ['token', 'generation'],
        'defer-launch': ['token', 'generation'],
        heartbeat: ['token'],
        reschedule: ['token'],
        suspend: ['token'],
        'await-event': ['token'],
        'record-task-done': ['token'],
        complete: ['token'],
        fail: ['token'],
        'fail-rollback': ['token'],
        'expire-lease-now': ['token'],
        'set-checkpoint': ['token'],
      })
      expect(STALE_CALLER_CASES).toHaveLength(12)
      expect({
        answeredRefusalsOutsideTheColumn: Object.keys(ANSWERED_REFUSALS).filter(
          (label) => !STALE_CALLER_CASES.some((presented) => presented.label === label),
        ),
        sweeps: PRESENTED.filter(({ method }) => method === 'sweep')
          .map(({ label }) => label)
          .sort(),
      }).toEqual({
        answeredRefusalsOutsideTheColumn: [],
        sweeps: Object.keys(SCAN_READS_A_GENERATION).sort(),
      })
    })

    for (const presented of STALE_CALLER_CASES) {
      const { label } = presented
      it(`${label} refuses a caller that does not hold the claim`, () =>
        withFixture(makeFixture, `stale-token-${label}`, async (f) => {
          const holder = await seedHolder(f, presented)
          expect(await engineInvariantViolations(f.raw)).toEqual([])
          const before = await snapshot(f.raw)
          for (const part of presented.parts) {
            const answers: Record<string, Outcome> = {}
            for (const [who, caller] of Object.entries(STALE_CALLERS[part](holder))) {
              answers[who] = await outcomeOf(invoke(label, f.store, caller))
            }
            expect({ answers, rows: await snapshot(f.raw) }).toEqual({
              answers: Object.fromEntries(
                Object.keys(answers).map((who) => [who, refusalOf(label)]),
              ),
              rows: before,
            })
          }
          // The same call under the claim itself wins from the rows the refusals left. If
          // it did not, the seed would be one in which the label is refused whoever calls,
          // and the refusals above would hold with the comparison removed.
          const held = await outcomeOf(invoke(label, f.store, holder))
          expect(held.kind, `${label} under its own claim: ${JSON.stringify(held)}`).toBe(
            'resolved',
          )
          expect(held, `${label} under its own claim was refused`).not.toEqual(refusalOf(label))
          expect(await snapshot(f.raw), `${label} under its own claim wrote nothing`).not.toEqual(
            before,
          )
        }))
    }

    for (const [label, reads] of Object.entries(SCAN_READS_A_GENERATION) as [
      SweepLabel,
      boolean,
    ][]) {
      const title = reads
        ? `${label} acts on nothing when its scan read another generation`
        : `${label} is handed no generation by its scan`
      it(title, () =>
        withFixture(makeFixture, `stale-scan-${label}`, async (f) => {
          await seedBase(f)
          await seedHealthyTrigger(f.raw, label)
          expect(await engineInvariantViolations(f.raw)).toEqual([])
          const before = await snapshot(f.raw)
          const scan = scanOfALaterClaim(f.raw, HEALTHY_INVOCATION.runId)
          const swept = await outcomeOf(
            invoke(label, f.storeOver(scan.executor), HEALTHY_INVOCATION),
          )
          expect(scan.rewritten() > 0, 'whether the scan handed the write a generation').toBe(reads)
          if (!reads) return
          expect({ swept, rows: await snapshot(f.raw) }).toEqual({
            swept: { kind: 'resolved', value: [] },
            rows: before,
          })
          // The same sweep over the scan the store really sends acts, so the generation
          // was the only reason the first one did not.
          expect(await outcomeOf(invoke(label, f.store, HEALTHY_INVOCATION))).toMatchObject({
            kind: 'resolved',
            value: [{ kind: label.slice('sweep:'.length), runId: HEALTHY_INVOCATION.runId }],
          })
        }))
    }
  })
}
