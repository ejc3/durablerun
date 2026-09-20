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
 * A statement that leaves the token out passes all of them, and a stale-caller test
 * written by hand holds one operation, so an operation nobody wrote one for is unheld.
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
  /** The caller that holds the claim. The label's healthy seed is laid down for it. */
  readonly holder: InvocationTarget
  /** The port method the call reaches. */
  readonly method: keyof SchedulerStore
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
  const calls: { method: keyof SchedulerStore; args: readonly unknown[] }[] = []
  const recorder = new Proxy({} as SchedulerStore, {
    get:
      (_store, method) =>
      (...args: unknown[]) => {
        calls.push({ method: String(method) as keyof SchedulerStore, args })
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
    // A claim receipt is also presented under the generation of the claim before it, and
    // a generation is at least one, so its holder is a run that was claimed a second time.
    const holder = parts.includes('generation')
      ? { ...target, claimGen: target.claimGen + 1 }
      : target
    forms.push({ name: `${label}${shape.form}`, label, holder, method: call.method, parts })
  }
  return forms
}

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
 * The port methods that report a lost lease in their answer, with that answer. Every
 * other method refuses by throwing LeaseLostError, and never RunCancelledError: no task
 * here is cancelled.
 */
const ANSWERED_REFUSALS: Partial<Record<keyof SchedulerStore, unknown>> = {
  activate: null,
  heartbeat: { held: false, remainingMs: 0, reason: 'lease-lost' },
  expireLeaseNow: false,
}

const refusalOf = (form: CallForm): Outcome =>
  form.method in ANSWERED_REFUSALS
    ? { kind: 'resolved', value: ANSWERED_REFUSALS[form.method] }
    : { kind: 'rejected', error: 'LeaseLostError' }

/**
 * The callers that do not hold the claim, for each part of it, given the caller that does.
 * Each names only what it presents in place of the holder's, so the claim presented is
 * the one difference between a stale call and the holder's. They are chosen against what
 * a statement can spell. The statement grammar is closed over node kinds and lists one
 * function, `coalesce`, so a comparison that folds the token's case or reads part of it
 * through a function cannot be written. It holds no list of operators, so an ordering
 * comparison and a pattern match both can. An ordering comparison admits every value on
 * one side of the claim's, so each part is presented from both sides, as near as a value
 * can stand. A pattern match reads the caller's token as a pattern, and SQLite's folds
 * ASCII case, so the token is also presented as the pattern that matches every token,
 * with its last character as the wildcard for one character, and in upper case.
 */
const STALE_CALLERS: Record<
  ClaimPart,
  (holder: InvocationTarget) => Record<string, Partial<InvocationTarget>>
> = {
  token: (holder) => ({
    'the token of this claim with its last character dropped': {
      token: holder.token.slice(0, -1),
    },
    'the token of this claim with a character added': { token: `${holder.token}~` },
    // A pattern match reads each of the next three as the claim's token. Equality reads none.
    'the pattern that matches every token': { token: '%' },
    'the token of this claim with its last character as a wildcard': {
      token: `${holder.token.slice(0, -1)}_`,
    },
    'the token of this claim in upper case': { token: holder.token.toUpperCase() },
    // A comparison that asks whether any run is held under the token, and not whether
    // this run is, refuses every caller above and admits this one.
    'the token of another live claim': { token: POISON_INVOCATION.token },
  }),
  generation: (holder) => ({
    'the generation of the claim before': { claimGen: holder.claimGen - 1 },
    'the generation of a claim not yet made': { claimGen: holder.claimGen + 1 },
  }),
}

type SweepLabel = Extract<WriteLabel, `sweep:${string}`>

/**
 * The registered mutation that removes the scanned generation from each sweep's write, or
 * null for a sweep whose scan hands its write no generation. The type asks every sweep
 * label for an answer, and each case checks that answer against the scan the store sends.
 */
const SCAN_VERDICTS = {
  'sweep:cancel': null,
  'sweep:lost-launch': 'mutation-verdict:behavior:stale-scan-sweep-lost-launch',
  'sweep:claim-timeout': 'mutation-verdict:behavior:stale-scan-sweep-claim-timeout',
} as const satisfies Record<SweepLabel, string | null>

/**
 * The caller the sweep cases seed for: a run at its second claim, so that a scan can have
 * read the claim before it.
 */
const SWEPT: InvocationTarget = {
  ...HEALTHY_INVOCATION,
  claimGen: HEALTHY_INVOCATION.claimGen + 1,
}

/**
 * The scans that read another claim of the run, by how many claims off they stand. The
 * claim before is what a real stale scan reads, because the run was claimed again after
 * the scan. A claim not yet made is the other side of the comparison.
 */
const STALE_SCANS = { 'the claim before': -1, 'a claim not yet made': 1 } as const

/** An executor whose sweep scan reports `runId` `claims` off from where the run stands. */
function scanOfAnotherClaim(raw: SqlExecutor, runId: string, claims: number) {
  let rewritten = 0
  const moved = (value: unknown) =>
    typeof value === 'bigint' ? value + BigInt(claims) : Number(value) + claims
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
            claim_gen: moved(row.claim_gen),
            activated_gen: moved(row.activated_gen),
          }
        }),
      }))
    },
  }
  return { executor, rewritten: () => rewritten }
}

/** Seeds `label`'s healthy run for the swept caller, and answers with the rows as they stand. */
async function seedSwept(f: StoreFixture, label: SweepLabel) {
  await seedBase(f)
  await seedHealthyTrigger(f.raw, label, SWEPT)
  expect(await engineInvariantViolations(f.raw)).toEqual([])
  return snapshot(f.raw)
}

/** Runs `label`'s sweep through a scan that stands `claims` off from the run. */
async function sweepOverAScanOf(f: StoreFixture, label: SweepLabel, claims: number) {
  const scan = scanOfAnotherClaim(f.raw, SWEPT.runId, claims)
  const swept = await outcomeOf(invoke(label, f.storeOver(scan.executor), SWEPT))
  return { swept, rewritten: scan.rewritten() }
}

export function staleTokenConformance(dialect: string, makeFixture: StoreFixtureFactory): void {
  describe(`stale-token column [${dialect}] (write label x caller that does not hold the claim)`, () => {
    const callForms = MATRIX_WRITE_LABELS.flatMap(callFormsOf)
    /** The column: every call that presents a part of its claim. */
    const cases = callForms.filter(({ parts }) => parts.length > 0)

    it('enrolls exactly the calls that present a claim', () => {
      const presenting = (part: ClaimPart) =>
        cases
          .filter(({ parts }) => parts.includes(part))
          .map(({ name }) => name)
          .sort()
      expect(Object.fromEntries(cases.map(({ name, parts }) => [name, parts]))).toEqual({
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
      expect(cases).toHaveLength(13)
      expect({
        token: Object.keys(VERDICTS.token).sort(),
        generation: Object.keys(VERDICTS.generation).sort(),
        answeredRefusalsOutsideTheColumn: Object.keys(ANSWERED_REFUSALS).filter(
          (method) => !cases.some((form) => form.method === method),
        ),
        sweeps: callForms
          .filter(({ method }) => method === 'sweep')
          .map(({ name }) => name)
          .sort(),
      }).toEqual({
        token: presenting('token'),
        generation: presenting('generation'),
        answeredRefusalsOutsideTheColumn: [],
        sweeps: Object.keys(SCAN_VERDICTS).sort(),
      })
    })

    // fenceTwin('Heartbeat') fenceTwin('FailRun') fenceTwin('SleepSuspend'): these cases are
    // the executable twins of those modeled guards. Each refuses a caller whose token is
    // not the claim's, and leaves the rows as they were.
    for (const form of cases) {
      it(`${form.name} refuses a caller that does not hold the claim`, () =>
        withFixture(makeFixture, `stale-token ${form.name}`, async (f) => {
          await seedBase(f)
          await seedHealthyTrigger(f.raw, form.label, form.holder)
          expect(await engineInvariantViolations(f.raw)).toEqual([])
          const before = await snapshot(f.raw)
          for (const part of form.parts) {
            const answers: Record<string, Outcome> = {}
            for (const [who, stale] of Object.entries(STALE_CALLERS[part](form.holder))) {
              answers[who] = await outcomeOf(
                invoke(form.label, f.store, { ...form.holder, ...stale }),
              )
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
          const held = await outcomeOf(invoke(form.label, f.store, form.holder))
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

    for (const [label, verdict] of Object.entries(SCAN_VERDICTS) as [SweepLabel, string | null][]) {
      if (verdict === null) {
        it(`${label} is handed no generation by its scan`, () =>
          withFixture(makeFixture, `stale-scan ${label}`, async (f) => {
            await seedSwept(f, label)
            const { swept, rewritten } = await sweepOverAScanOf(f, label, -1)
            // The sweep acted on the seeded task, so its scan returned that row, and no
            // row of the scan carried a generation to rewrite.
            expect({ swept, rewritten }).toMatchObject({
              swept: { kind: 'resolved', value: [{ kind: 'cancelled', taskId: SWEPT.taskId }] },
              rewritten: 0,
            })
          }))
        continue
      }
      it(`${label} acts on nothing when its scan read another generation`, () =>
        withFixture(makeFixture, `stale-scan ${label}`, async (f) => {
          const before = await seedSwept(f, label)
          const answers: Record<string, Outcome> = {}
          for (const [which, claims] of Object.entries(STALE_SCANS)) {
            const { swept, rewritten } = await sweepOverAScanOf(f, label, claims)
            expect(
              rewritten,
              `the scan of ${which} handed the write no generation`,
            ).toBeGreaterThan(0)
            answers[which] = swept
          }
          expect({ answers, rows: await snapshot(f.raw) }, verdict).toEqual({
            answers: Object.fromEntries(
              Object.keys(STALE_SCANS).map((which) => [which, { kind: 'resolved', value: [] }]),
            ),
            rows: before,
          })
          // The same sweep over the scan the store really sends acts, so the generation
          // was the only reason the others did not.
          expect(await outcomeOf(invoke(label, f.store, SWEPT))).toMatchObject({
            kind: 'resolved',
            value: [{ kind: label.slice('sweep:'.length), runId: SWEPT.runId }],
          })
        }))
    }
  })
}
