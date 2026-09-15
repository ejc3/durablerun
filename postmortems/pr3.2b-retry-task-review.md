# Postmortem: PR3.2b retryTask review round (PR #29)

PR3.2b adds `retryTask`, Absurd's `retry_task`: an operator revives a failed task in place with a new pending run. The model came first and TLC caught the first accounting defect before any SQL existed. An outside Fable `/code-review` round then found three correctness defects in the revival itself. A revival could write a budget past its persisted bound. It derived attempts from counters it never checked, so a corrupt row became a negative attempt count. And its run dropped the parked wake every other successor carries. The same round found a poison-matrix barrier that skipped a revived task outright. All four were committed red and fixed, the dead budget branch is gone, and each mechanism below has its false negative measured.

## Severity

The worst escape was the dropped wake. A task that registered on an event, received it, and then failed would be revived with a run that has no `wake_event`, no `event_payload`, and no `run_db`. The replay re-registers a wait for an event that was already delivered and emitted before the failure, so the revived workflow waits for a delivery that never comes, and it cannot find its earlier run database. The second escape wrote `max_attempts = MAX_COUNT + 1` for a task spawned at the maximum budget, a value the engine's own invariant checker reports as corruption. The third turned drifted counters into a pending task with negative attempts and a live run, whose activation the accounting guards then refuse, so the revived task never runs.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The revival insert copied none of `SUCCESSOR_CARRIED_RUN_COLUMNS` | A revived task parked on a delivered event waits forever and loses its run database | The carry conformance case and the `successor-carries-every-column` mutation | The case lists each successor path by hand, and the mutation targets the shared helper the revival did not use | TLA `SuccessorCarriesWake` over every action that brings a run into use (2); one `successorCarriedValues` definition for all three inserts (1 within the stores); the revival family in the carry case (3) |
| 2 | The revive CAS raised `max_attempts` and the run ordinal without bound guards | A task at `MAX_COUNT` is revived into a budget the invariants flag as corrupt | The poison matrix's counter witnesses and the counter-bound invariants | The poison target is seeded live, so `retry-task` refuses on its state condition before any counter guard runs, and no case revived a task at the maximum budget | Revival guards with a conformance case per guard and a registered mutation per guard class (3) |
| 3 | The revive CAS derived the charge from unchecked counters | Drifted `infra_retries` produce negative attempts on a pending task that never runs | The same poison witnesses, and `AccountingBand` in TLC | The poison reason above, and TLC ran `AccountingBand` only at `InfraRetryCap = 0` | Accounting-band and charge-within-budget guards with corruption cases and mutations (3); the accounting invariants in the safety scope at `InfraRetryCap = 1` (2); an infrastructure-cap revival case (3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review`, round 1 | 3 | no |
| This project's own machinery | 0 | yes |

Self-catch rate: 0% (previous round: 0%, `pr3.2a-lifecycle-review.md`). Our machinery did catch two defects before review, and neither is counted here. TLC on `SchedulerRetry.cfg` found a revival that left the top run unaccounted before any SQL existed. The fault matrix's strict specs caught `retry-task` enrolled but never invoked. Both are the machinery working. The three escapes are the correctness core of the feature, and none of the existing layers could see them.

## Recurrence

**The carried columns recur as a class.** SUCCESSOR_CARRIED_RUN_COLUMNS became a contract precisely so that every successor path carries the same columns, and DESIGN.md says "on every path that creates one". The mechanism behind that sentence was a conformance case that enumerates the paths as families, plus a mutation on the helper those paths share. Both check the paths that existed when they were written. A new successor path that spells its own insert is invisible to both, and that is exactly what the revival did. The mechanism was a proxy for "every insert that creates a successor carries the columns". The model property now states that property over every action, but the SQL side is still a list.

**The unguarded counter write recurs as a class.** The stored-bound fragments, the counter-bound invariants, and the poison matrix's counter witnesses exist because earlier rounds found counter writes without guards. The poison matrix claims to cross every write label with every witness. It does cross them, but its poisoned target is always a live task, and a label whose precondition is a terminal state refuses on that state before it reads a counter. So the matrix reports the label contained while its counter guards never ran. The mechanism checks "every label meets every witness", not "every counter a label writes is guarded".

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| `SuccessorCarriesWake` | 2 | TLC reads only `specs/`. The store at `a254259`, whose revival carries nothing, passes the same run that turned green at `1cc5d87`: 1,579,633 distinct states, no error. Its first two scopes also never reached the claim-timeout sweep, which needs a nonzero infrastructure-retry cap. Round 2 of `/simplify` found that gap, and `SchedulerLiveness2.cfg` now checks the sweep path. |
| Carry conformance case with a revival family | 3 | A fourth successor insert that spells its columns without `successorCarriedValues` passes, because the case lists families. At `a254259` the case passed on both dialects with the non-carrying revival in the tree (full verify, 6,744 tests). |
| Revival counter guards, corruption cases, and mutations | 3 | A revive CAS without the owned-run ordinal guard fails the corruption case on libSQL and passes it on PostgreSQL, because PostgreSQL's INTEGER column rejects the fractional witness at storage, so that dialect has no witness for the guard. Measured: 1 failed (libSQL), 15 passed. |
| Invariant-library twin `accounting/failed-charge-past-budget` | 3 | The checker reads stored counters only. A revival that charges within the budget but writes the wrong ordinal onto the revival run passes it; `accounting/live-run-not-next` is what reports that shape. |
| Accounting invariants in `Scheduler.cfg`, and `SchedulerRetryInfra.cfg` | 2 | `RetryTask` first ran only in `SchedulerRetry.cfg`, where `InfraRetryCap = 0`, so a model charging `TopOrdinal(t)` without subtracting `infraRetries[t]` completed with no error over 1,579,633 distinct states. Round 2 of `/code-review` found the same gap. `SchedulerRetryInfra.cfg` now revives at `InfraRetryCap = 1`, where that model fails `LiveRunIsNextAccounted` at `RetryTask(t1)` after 24,189 distinct states. That scope has no hops and no relaunches, so a charge mistake that needs a relaunch-capped run and an infrastructure retry in the same task still passes. |
| Poison barrier column allowlist | 3 | A revival that sets `last_attempt_run = NULL`, an allowlisted column, passed all 16 retryTask cases and all 288 retry-task poison cells on both dialects. The revival case now pins `last_attempt_run`, but the barrier still allows any value in the columns a revival writes. |

## Fix-induced defects

Four defects came from the round's own repairs. The fixes were re-reviewed as new code: round 2 ran the built-in `/code-review` and `/simplify` over the fix range `fa63b74...4ffe9c2`, and each defect below was found there.

- **The fault matrix's revival step, added to fix the unfired `retry-task` faults, reordered the workload.** Its revival run was due now with an early id, so the park, launch-deferral, and claim-timeout steps claimed different rows than their comments name. The step now runs after the workload's other claims, only on the doomed task's run.
- **The carry case's revival family, added red for the dropped wake, skipped the created-at check.** It never pinned the revival run's own instant. The case now pins every successor's instant.
- **`SuccessorCarriesWake`, added for the same finding, was listed only in scopes whose infrastructure-retry cap is 0.** So it never reached the claim-timeout sweep, and its red commit message said it held for every other successor path. It now also runs in `SchedulerLiveness2.cfg`, and the message was corrected.
- **Two of the fix commits' messages claimed results that were never measured.** One said the CI scope runs infrastructure retries. Another said deleting the infra term "still passed TLC", which reads no SQL. Both messages were reworded to measured results before push.

Round 2 also found a defect older than this round. The "refuses a replay" case, from the original implementation, never attempted a replay, because its completed task's claim took the revival run. It was committed red and fixed.

## Evidence

- Red tests:
  - `753deaa`, run and seen failing (4 tests) against `a254259`. A task at `MAX_COUNT` and a task with `infra_retries = 3` over one run are both revived on libSQL and PostgreSQL.
  - `b0e5163`, 2 tests. The carry case fails on both dialects once the revival family is listed.
  - `f37aadd`, TLC. `SchedulerRetry.cfg` gives a ten-step counterexample ending in `RetryTask(t1)`, with run 1 holding `e1` and payload 1 and revival run 2 holding neither. The same property completes on `SchedulerCI.cfg` over 568,401 distinct states, which covers the user-retry successor. The claim-timeout sweep's successor needs a nonzero infrastructure-retry cap, so that path was checked later in `SchedulerLiveness2.cfg`: no error over 13,097,995 distinct states, and a model whose sweep drops the wake is caught at `SweepClaimTimeout(1)`.
  - `0794f62`, 2 tests. libSQL revives all four corrupt tasks, and PostgreSQL revives three, because it rejects the fractional ordinal at storage.
- Fixes: `1cc5d87` turned all 16 named retryTask and carry cases green. TLC completes on `SchedulerRetry.cfg` (1,579,633 distinct states) and `SchedulerCI.cfg` (568,401). `82f7065` puts the accounting invariants in the safety scope, which completes with every vacuity probe witnessed. At `4ffe9c2`, which has the tree the fixes were verified on: `pnpm verify` passes 109 test files and 6,752 tests, and `TLA_SCOPE=ci` witnesses every probe and completes `SchedulerCI.cfg` (568,401 distinct states) and `SchedulerRetry.cfg` (1,579,633) with no error.
- Finder: Fable `/code-review`, round 1. Quoted verdicts:
  - "revival can raise `max_attempts` past `PERSISTED_INTEGER_BOUNDS.tasks.max_attempts` (confirmed from source)";
  - "the revival run doesn't copy the carried run columns (plausible)";
  - "the revive CAS checks no stored counters (plausible)".
- Claims that did not reproduce, or were corrected:
  - The simplify reviewers disagreed on whether the two store files are byte-identical. They are not: only the `retryTask` blocks match.
  - My first commit message for the safety scope claimed a store-side deletion of the infra term "still passed TLC". TLC reads no SQL, so the claim was reworded to the measured model result.
  - Finding 2's PostgreSQL overflow worry does not apply at `MAX_COUNT + 1`, which fits an INTEGER. The defect is the invariant violation.

## Root cause

A revival is the first transition out of a terminal state, and every generated surface enumerated the world as it was before that transition. The poison matrix seeds only live targets. The carry case lists the successor paths that existed. TLC enables the new action only in a scope whose infrastructure cap is 0. None of those layers derives its inventory from the transitions themselves, so a new transition inherits no coverage, and the round's defects all live in exactly the state the new transition starts from.

## Mechanisms

Built in this PR:

- `SuccessorCarriesWake`, a TLA action property over every action that brings a run into use (rung 2, `specs/Scheduler.tla`, checked by the CI and retry scopes).
- `FailedChargeWithinBudget`, plus the accounting invariants in the safety scope at `InfraRetryCap = 1` (rung 2, `specs/Scheduler.cfg`), and `SuccessorCarriesWake` in `SchedulerLiveness2.cfg`, where the claim-timeout sweep creates successors (rung 2).
- `SchedulerRetryInfra.cfg`, a safety-only revival scope at `InfraRetryCap = 1`, run by the PR gate and the full scope (rung 2). It completes with no error over 253,717 distinct states.
- `accounting/failed-charge-past-budget`, the executable twin of `FailedChargeWithinBudget` in the invariant library, checked by every simulation, scenario, fuzz walk, and poison cell, with a poison witness that reaches the revive CAS's charge-within-budget guard (rung 3, `packages/conformance/src/invariants.ts`, `packages/conformance/src/poison-matrix.ts`).
- `successorCarriedValues`, one definition of the carried values spliced by all three successor inserts (rung 1 within the stores, `packages/core/src/contract.ts`).
- Revival guards on counters, run ordinals, the budget, and the accounting band, each with a conformance case and a registered mutation (rung 3, the stores, `packages/conformance/src/suite.ts`, `scripts/mutation-probe.py`).
- An infrastructure-cap revival case and its mutation (rung 3).
- A column allowlist for a revived task in the poison barrier (rung 3, `packages/conformance/src/poison-matrix.ts`).

Deferred (recorded in BUILD.md):

- **A poison target profile for a failed task.** It would let `retry-task` cells reach the counter guards behind its state condition. The conformance cases pin each guard today, and the profile is poison-matrix machinery beyond this milestone's exit test.
- **A successor-carry case generated from every batch that inserts a run.** It would replace the hand-listed families. The model property covers the protocol today, and generating the SQL-side enumeration belongs with PR3.9's SQL-tree work.

## What this round still would not catch

- A fourth successor insert that spells its carried columns by hand and is not listed in the carry case would ship. The model property does not read SQL.
- A revival that stops checking run ordinals' representation would ship if it were exercised only on PostgreSQL, where the storage type rejects the witness.
- A model `RetryTask` whose mistake needs a relaunch-capped run and an infrastructure retry in the same task would ship past TLC. The retry scope has no infrastructure retries, and the infrastructure revival scope has no relaunches.
- A revival that writes a wrong value into a column it owns and no case reads back would pass the poison matrix. The barrier checks which columns change, not their values.
- A label whose precondition is terminal, other than `retry-task`, still meets poison witnesses only through live targets, so its counter guards are unexercised by the matrix.
