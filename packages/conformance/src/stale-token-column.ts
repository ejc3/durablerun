import { LeaseLostError, type SchedulerStore, type SqlExecutor } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { MATRIX_WRITE_LABELS } from './fault-matrix.js'
import type { StoreFixture, StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import {
  HEALTHY_INVOCATION,
  INVOCATION_SHAPES,
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
 * So the cases are generated. The poison matrix's `invoke` is called for every write
 * label, over every shape of target it tells apart, on a store that records the call.
 * A call is in the column exactly when it carries the target's claim token or
 * generation. A new label that presents a claim gets its case without being listed, and
 * a label that presents none cannot be listed. Each case seeds the label's healthy
 * target from the poison matrix's own seeds, makes the call as a caller that does not
 * hold the claim, and requires the port's lost-lease answer and six unchanged tables.
 * Then it makes the same call as the claim's holder and requires it to win, so the claim
 * presented is the only difference between the call that was refused and the call that
 * was not. A seed in which the label is refused for some other reason fails there, and
 * does not pass for a fence.
 *
 * The lease sweeps present no token. They act on the claim their scan read (§3.4), so
 * their stale caller is a scan that read another generation.
 */

type WriteLabel = (typeof MATRIX_WRITE_LABELS)[number]
type ClaimPart = 'token' | 'generation'

/** Values no seed and no invocation holds, so an argument equal to one was read from the target. */
const TOKEN_PROBE = 'stale-token-column:token-probe'
const GENERATION_PROBE = 1_234_567

/** One call `invoke` makes: a write label, as one shape of target calls it. */
interface CallForm {
  /** The label, and what the target's shape adds to it: `complete`, `spawn of a child`. */
  readonly name: string
  readonly label: WriteLabel
  /** The caller that holds the claim, as the label's healthy seed leaves it. */
  readonly target: InvocationTarget
  /** The port method the call reaches. */
  readonly method: string
  /** The parts of its claim the call presents, in the order the case checks them. */
  readonly parts: readonly ClaimPart[]
}

const carries = (value: unknown, probe: string | number): boolean =>
  value === probe ||
  (typeof value === 'object' &&
    value !== null &&
    Object.values(value).some((inner) => carries(inner, probe)))

/** The one port call `invoke` makes for `label` on `target`. */
function recordedCall(label: WriteLabel, target: InvocationTarget) {
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
  invoke(label, recorder, target).catch(() => undefined)
  const [call, ...others] = calls
  if (call === undefined || others.length > 0) {
    throw new Error(`invoking '${label}' made ${calls.length} port calls, and the column reads one`)
  }
  return call
}

/** Every distinct call `invoke` makes for `label`, over every shape of target it tells apart. */
function callFormsOf(label: WriteLabel): CallForm[] {
  const forms: CallForm[] = []
  const spelled = new Set<string>()
  for (const shape of Object.values(INVOCATION_SHAPES)) {
    const target = { ...HEALTHY_INVOCATION, ...shape.set }
    const call = recordedCall(label, {
      ...target,
      token: TOKEN_PROBE,
      claimGen: GENERATION_PROBE,
    })
    // A shape that changes nothing about this label's call is the call already on record.
    const spelling = JSON.stringify(call)
    if (spelled.has(spelling)) continue
    spelled.add(spelling)
    const parts: ClaimPart[] = []
    if (carries(call.args, TOKEN_PROBE)) parts.push('token')
    if (carries(call.args, GENERATION_PROBE)) parts.push('generation')
    forms.push({ name: `${label}${shape.form}`, label, target, method: call.method, parts })
  }
  return forms
}

const CALL_FORMS = MATRIX_WRITE_LABELS.flatMap(callFormsOf)

/** The column: every call that presents a part of its claim. */
export const STALE_CALLER_CASES: readonly CallForm[] = CALL_FORMS.filter(
  ({ parts }) => parts.length > 0,
)

/**
 * The registered mutation that removes each comparison, by the call it removes it from.
 * A marker is a literal because the mutation audit reads it from this source. The
 * enrollment case holds both tables to the derived column, so a call that joins the
 * column fails there until the mutation that unfences it is registered.
 */
const VERDICTS: Record<ClaimPart, Readonly<Record<string, string>>> = {
  token: {
    'spawn of a child': 'mutation-verdict:behavior:stale-token-spawn-of-a-child',
    activate: 'mutation-verdict:behavior:stale-token-activate',
    'defer-launch': 'mutation-verdict:behavior:stale-token-defer-launch',
    heartbeat: 'mutation-verdict:behavior:stale-token-heartbeat',
    reschedule: 'mutation-verdict:behavior:stale-token-reschedule',
    suspend: 'mutation-verdict:behavior:stale-token-suspend',
    'await-event': 'mutation-verdict:behavior:stale-token-await-event',
    'record-task-done': 'mutation-verdict:behavior:stale-token-record-task-done',
    complete: 'mutation-verdict:behavior:stale-token-complete',
    fail: 'mutation-verdict:behavior:stale-token-fail',
    'fail-rollback': 'mutation-verdict:behavior:stale-token-fail-rollback',
    'expire-lease-now': 'mutation-verdict:behavior:stale-token-expire-lease-now',
    'set-checkpoint': 'mutation-verdict:behavior:stale-token-set-checkpoint',
  },
  generation: {
    activate: 'mutation-verdict:behavior:stale-generation-activate',
    'defer-launch': 'mutation-verdict:behavior:stale-generation-defer-launch',
  },
}

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
 * The calls whose port method reports a lost lease in its answer, with that answer.
 * Every other call refuses by throwing LeaseLostError, and never RunCancelledError: no
 * task here is cancelled.
 */
const ANSWERED_REFUSALS: Readonly<Record<string, unknown>> = {
  activate: null,
  heartbeat: { held: false, remainingMs: 0, reason: 'lease-lost' },
  'expire-lease-now': false,
}

const refusalOf = (form: CallForm): Outcome =>
  form.name in ANSWERED_REFUSALS
    ? { kind: 'resolved', value: ANSWERED_REFUSALS[form.name] }
    : { kind: 'rejected', error: 'LeaseLostError' }

/**
 * The callers that do not hold the claim, for each part of it, given the caller that does.
 * They are chosen against what a statement can spell. The statement grammar lists no
 * function, so a comparison that folds the token's case or reads part of it cannot be
 * written. An ordering comparison can, and it admits every value on one side of the
 * claim's, so each part is presented from both sides, as near as a value can stand.
 */
const STALE_CALLERS: Record<
  ClaimPart,
  (holder: InvocationTarget) => Record<string, InvocationTarget>
> = {
  token: (holder) => ({
    'the token of this claim with its last character dropped': {
      ...holder,
      token: holder.token.slice(0, -1),
    },
    'the token of this claim with a character added': { ...holder, token: `${holder.token}~` },
    // A comparison that asks whether any run is held under the token, and not whether
    // this run is, refuses the two callers above and admits this one.
    'the token of another live claim': { ...holder, token: POISON_INVOCATION.token },
  }),
  generation: (holder) => ({
    'the generation of the claim before': { ...holder, claimGen: holder.claimGen - 1 },
    'the generation of a claim not yet made': { ...holder, claimGen: holder.claimGen + 1 },
  }),
}

/** Seeds the call's healthy target and answers with the caller that holds its claim. */
async function seedHolder(f: StoreFixture, form: CallForm): Promise<InvocationTarget> {
  await seedBase(f)
  await seedHealthyTrigger(f.raw, form.label, form.target)
  if (!form.parts.includes('generation')) return form.target
  // The stale caller of a claim receipt is the claim before it, so the run is one that
  // was claimed a second time.
  await f.raw.batch(
    'stale-token:claimed-again',
    [
      {
        sql: 'UPDATE runs SET claim_gen = claim_gen + 1 WHERE run_id = ?',
        args: [form.target.runId],
      },
    ],
    'write',
  )
  return { ...form.target, claimGen: form.target.claimGen + 1 }
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

const SCAN_VERDICTS: Partial<Record<SweepLabel, string>> = {
  'sweep:lost-launch': 'mutation-verdict:behavior:stale-scan-sweep-lost-launch',
  'sweep:claim-timeout': 'mutation-verdict:behavior:stale-scan-sweep-claim-timeout',
}

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

const fixtureName = (kind: string, name: string) => `${kind}-${name.replaceAll(' ', '-')}`

export function staleTokenConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`stale-token column [${dialect}] (write label x caller that does not hold the claim)`, () => {
    it('enrolls exactly the calls that present a claim', () => {
      const presenting = (part: ClaimPart) =>
        STALE_CALLER_CASES.filter(({ parts }) => parts.includes(part))
          .map(({ name }) => name)
          .sort()
      expect(
        Object.fromEntries(STALE_CALLER_CASES.map(({ name, parts }) => [name, parts])),
      ).toEqual({
        'spawn of a child': ['token'],
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
      expect(STALE_CALLER_CASES).toHaveLength(13)
      expect({
        token: Object.keys(VERDICTS.token).sort(),
        generation: Object.keys(VERDICTS.generation).sort(),
        answeredRefusalsOutsideTheColumn: Object.keys(ANSWERED_REFUSALS).filter(
          (name) => !STALE_CALLER_CASES.some((form) => form.name === name),
        ),
        sweeps: CALL_FORMS.filter(({ method }) => method === 'sweep')
          .map(({ name }) => name)
          .sort(),
        scanVerdicts: Object.keys(SCAN_VERDICTS).sort(),
      }).toEqual({
        token: presenting('token'),
        generation: presenting('generation'),
        answeredRefusalsOutsideTheColumn: [],
        sweeps: Object.keys(SCAN_READS_A_GENERATION).sort(),
        scanVerdicts: Object.entries(SCAN_READS_A_GENERATION)
          .filter(([, reads]) => reads)
          .map(([label]) => label)
          .sort(),
      })
    })

    // fenceTwin('Heartbeat') fenceTwin('FailRun') fenceTwin('SleepSuspend'): these cases are
    // the executable twins of those modeled guards. Each refuses a caller whose token is
    // not the claim's, and leaves the rows as they were.
    for (const form of STALE_CALLER_CASES) {
      it(`${form.name} refuses a caller that does not hold the claim`, () =>
        withFixture(makeFixture, fixtureName('stale-token', form.name), async (f) => {
          const holder = await seedHolder(f, form)
          expect(await engineInvariantViolations(f.raw)).toEqual([])
          const before = await snapshot(f.raw)
          for (const part of form.parts) {
            const answers: Record<string, Outcome> = {}
            for (const [who, caller] of Object.entries(STALE_CALLERS[part](holder))) {
              answers[who] = await outcomeOf(invoke(form.label, f.store, caller))
            }
            expect({ answers, rows: await snapshot(f.raw) }, VERDICTS[part][form.name]).toEqual({
              answers: Object.fromEntries(
                Object.keys(answers).map((who) => [who, refusalOf(form)]),
              ),
              rows: before,
            })
          }
          // The same call under the claim itself wins from the rows the refusals left. If
          // it did not, the seed would be one in which the call is refused whoever makes
          // it, and the refusals above would hold with the comparison removed.
          const held = await outcomeOf(invoke(form.label, f.store, holder))
          expect(held.kind, `${form.name} under its own claim: ${JSON.stringify(held)}`).toBe(
            'resolved',
          )
          expect(held, `${form.name} under its own claim was refused`).not.toEqual(refusalOf(form))
          expect(
            await snapshot(f.raw),
            `${form.name} under its own claim wrote nothing`,
          ).not.toEqual(before)
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
        withFixture(makeFixture, fixtureName('stale-scan', label), async (f) => {
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
          expect({ swept, rows: await snapshot(f.raw) }, SCAN_VERDICTS[label]).toEqual({
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
