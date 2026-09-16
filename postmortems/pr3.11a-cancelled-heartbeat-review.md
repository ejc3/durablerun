# Postmortem: cancellation on a refused heartbeat, PR3.11a (PR #32)

PR #32 makes a refused heartbeat name why it was refused. A heartbeat on a cancelled task used to report only a lost lease, so a handler that made a context call after that beat ended as lease-lost instead of cancelled. The change gave `LeaseState` a `reason` and taught the worker's heartbeat pump to stop the handler with the matching error. The first Fable `/code-review` round found one release-safety defect in that change. The worker trusted every store to name a reason, and a store package built against the earlier contract names none, so the handler kept running after a refused beat. The fix treats any refusal that does not name the cancellation as a lost lease.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

The escaped defect would have shipped with the new SDK package. A deployment that upgrades `@durablerun/sdk` while it keeps an older store package, or that implements `SchedulerStore` itself, reports a refused heartbeat as `{ held: false, remainingMs: 0 }`. The pump then recorded no reason, so the handler kept running user side effects after its lease was gone, until a fenced write was refused. Before this PR the same store stopped the handler at its next context call. The fences still protected durable state, so no state was lost, duplicated, or misattributed. The user-visible impact is side effects and worker time spent by a zombie handler.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The heartbeat pump recorded `lease.reason` verbatim, so a refusal with no reason recorded nothing and the handler kept running (round 1, finding 7) | A zombie handler keeps running side effects after a refused beat, with a store built against the earlier contract | The SDK heartbeat pump tests | Every test store is the current libSQL store or a proxy over it, so every refusal names a reason and no test answers with an earlier contract's shape | The pump records `cancelled` only when the answer names it and `lease-lost` otherwise, so a missing or unknown reason stops the handler (rung 1 at the pump). Red case `d4c4177`, and registered mutation `sdk-reasonless-refusal-is-lease-lost` (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review` round 1 over `f3f8392...272c19c` | 1 | no |
| Fable `/code-review` round 2 over `272c19c...6263223` | 0 product defects; 2 registry gaps in the fold | no |
| Fable `/code-review` round 3 over `6263223...f43bffa` | 0 product defects; 1 registry gap and postmortem errata | no |
| Existing conformance, SDK, fault matrix, mutation, and lint gates before review | 0 | yes |

Self-catch rate: 0 of 1, or 0% (previous round: 0%, `pr3.2b-retry-task-review.md`).

Our machinery did catch one defect of this PR before review, and it is not counted above. The milestone heading was written `## Current milestone:`, and `tla-artifact.test.ts` requires exactly one `## Current milestone — ` heading. The remote affected-closure baselines all went red on that test before any mutation ran. That is the machinery working. The escape is the one defect that crosses a package-version boundary, which no layer exercises.

## Recurrence

Yes. This is the class PR3.2a's finding 1 instituted a mechanism against: an interface answer shaped by an earlier contract version. There, an older driver's launch lacked `taskName` and every launch failed. The mechanism was rung 1 for that one payload, since the launch carries only ids, plus a single red test that sends an older driver's launch. It checks that one boundary. The property is that every cross-package boundary tolerates the earlier contract's shape. The store port's answers are a second boundary of the same class, and nothing enumerated them, so the class recurred. PR3.2a already deferred the generated form for the launch payload. That generated case is the property, and this round extends its scope to the store port's answers.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The pump records `lease-lost` for any refusal that does not name the cancellation | 1 at the pump | A store whose `heartbeat` throws instead of refusing. The pump treats a heartbeat error as advisory upkeep and returns without recording a reason, so the handler runs to completion. Run against `6263223` with a proxy whose `heartbeat` throws `new Error('store connection dropped during heartbeat')`: `-     "kind": "lease-lost",` `+     "kind": "completed",` `-   "stepRan": false,` `+   "stepRan": true,`. This is the designed advisory behavior; the fences refuse the zombie's writes. |
| Red case `a refused heartbeat that names no reason still stops the handler as a lost lease` | 3 | A store that answers `{ held: true, remainingMs: 60000 }` for an extension it did not make. The pump keeps the handler running, and the case never builds that answer. |
| Registered mutation `sdk-reasonless-refusal-is-lease-lost` | 3 | The mutation replaces the normalization with `leaseEnd.reason = lease.reason === 'cancelled' ? 'cancelled' : lease.reason`. A different regression, such as recording `lease.reason ?? 'cancelled'`, is caught by the same case, but no registered mutation names it. The mutation is a proxy for its one spelling. |
| Registered mutations `sdk-heartbeat-cancellation-outcome`, `task-control-runtime-cancellation-auth`, and `task-control-cancellation-error-class` | 3 | Each names one spelling. A regression that drops the reason on the latch before the context reads it, such as a pump that sets `leaseEnd.reason` only on its second refused beat, matches none of their anchors. The SDK cancellation case still catches it, but the registry records no owner for it. |

## Fix-induced defects

No correctness defect was introduced by the fixes. The folds did leave registry gaps, and each later round reviewed the previous fold as new code. Round 2 found that the new pump guard had no registered mutation, and that re-aiming `sdk-heartbeat-cancellation-outcome` into the issuer left the context's hand-off unrecorded. Round 3 found that moving it back left the issuer's error-class swap unrecorded. All three are fixed in this PR with registered mutations owned by attributable verdicts.

## Evidence

- Red test: commit `d4c4177`, whose parent is the unfixed `272c19c`, run and seen failing (1 test): `-     "kind": "lease-lost",` `+     "kind": "completed",` `-   "stepRan": false,` `+   "stepRan": true,`.
- Fix: commit `6263223`; after the fix the SDK, provenance, and TLA artifact tests pass (117), and the heartbeat, cancellation, and refusal conformance cases pass on libSQL and PostgreSQL (822). Remote `pnpm verify` at `6263223` passed with 109 test files and 6794 tests.
- Finder: Fable `/code-review` round 1, quoted: "In plain JS, a store that still returns `{held:false, remainingMs:0}` leaves `leaseEnd = undefined`. The pump then returns without stopping the handler, which keeps running side effects until a fenced write is refused."
- Did not reproduce as a reachable defect: round 1's finding that the refusal read ignores queue and claim token. A run with a live pump is activated, an activated run is never reopened under its run id, and a caller passing another queue is outside the worker contract. It is rejected with that reason in the PR body.

## Root cause

The contract between the SDK and a store lives in TypeScript types, and every test in the repository builds both sides from the same commit. A type change is therefore invisible to the test suite as a compatibility change: the compiler forces every in-repository store to produce the new shape, so no test ever sees the old one. The only cross-version test in the repository covers the launch payload, and it was written by hand for that payload after an earlier review found it.

## Mechanisms

Built in this PR:

- The pump stops the handler on any refusal that does not name the cancellation (rung 1 at the pump), in `packages/sdk/src/run-worker.ts`.
- Red case and registered mutation `sdk-reasonless-refusal-is-lease-lost` (rung 3), in `packages/sdk/test/run-worker.test.ts` and `scripts/mutation-probe.py`.
- Registered mutations for each step the reason crosses on its way to the handler (rung 3): `heartbeat-names-cancellation` in the store, `sdk-heartbeat-cancellation-outcome` in the context, and `task-control-runtime-cancellation-auth` and `task-control-cancellation-error-class` in the issuer.

Deferred (recorded in BUILD.md):

- A cross-version answer case generated from the `SchedulerStore` port's result types, crossing an older store with a newer worker and the reverse (rung 3), under PR3.11 with the launch payload case it extends. Deferral is acceptable because the fences refuse a zombie's writes, so no durable state is at risk while it is open.

## What this round still would not catch

- A store whose `heartbeat` throws instead of refusing leaves the handler running until a fenced write is refused.
- A store that reports a held lease for an extension it did not make keeps the handler running.
- Any other port answer whose shape changes in a later contract, such as a new `SweptRun` kind reaching an older driver, ships without a test that crosses the versions.
