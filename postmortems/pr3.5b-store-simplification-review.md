# Postmortem: PR3.5b store simplification review (PR #26)

PR3.5b is the store slice of the PR3.5 simplification sweep. It names the successor columns once, binds the spawn cancellation deadline once, hoists `mapLimit` and `clampLimit` into core, and makes every reader of a task's outcome refuse a row that contradicts its state. Fable `/code-review` rounds ran over the branch and over each round's fixes, and a Fable `/simplify` pass ran over the whole branch. Round one reported eight findings, two of them correctness findings in this repository's sense, meaning a reachable contract or release-safety violation. Round two judged the round-one fixes as new code and reported nine findings, one a correctness finding that a round-one fix introduced. Round three judged the round-two fixes as new code and reported ten findings, none a correctness finding and every one introduced by a round-two fix. Round four judged the round-three fixes and reported six findings, none a correctness finding and all introduced by round-three fixes. Round five judged the round-four fixes and reported five findings, none a correctness finding and all introduced by round-four fixes. Review rounds stopped there. Every finding is resolved on the branch.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

- **A second outcome reader: dogfood status.** This PR taught `getTaskResult` to refuse contradictory task rows, while `DogfoodRuntime.status()` decoded the same columns itself. `pnpm dogfood:status` printed a completed task without its payload, or a cancelled task without its reason, as a normal status, while the store refused the same row. The engine writes no such row, so no user saw it. The impact is an operator view that disagrees with the store on exactly the rows the refusal exists to reject.
- **A published helper with an unchecked width: `mapLimit`.** Exporting `mapLimit` from `@durablerun/core` made it public API. `mapLimit(items, 0, fn)` resolved to an array of empty slots typed `R[]` without calling `fn`. After one call rejected, the other workers kept starting items the caller could no longer observe. Both stores pass a constant width of 8, so no engine path was affected.
- **Work continuing after `mapLimit` rejected.** The round-one fix stopped new items after a rejection, but `mapLimit` still rejected at once while calls it had started kept running, and its docblock declared that intended. The sweep runs per-item batches through `mapLimit`. When one batch threw a store outage, the sweep rejected and its caller could close the executor while other batches still committed successors or cancellations, or failed unobserved.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `DogfoodRuntime.status()` decoded a task's outcome columns itself, so it reported rows `getTaskResult` refuses | `pnpm dogfood:status` printed contradictory rows as normal outcomes | The conformance refusal case and the dogfood runtime suite | The refusal lived inside each store's `getTaskResult`, and the dogfood suite read only rows the engine wrote, so no test crossed a contradictory row through the second reader | Core `decodeTaskResult` with `TASK_RESULT_COLUMNS` is the one decode for both stores and dogfood (rung 1 for those readers); `scripts/outcome-lint.py` refuses any other production spelling of the columns (rung 2); a dogfood red test and the per-rule `task-outcome/*` engine invariants (rung 3) |
| 2 | Published `mapLimit` accepted width 0, negative, or NaN, and kept starting items after a rejection | A consumer with a computed width got empty slots with no call made, or unobserved work after a failure | The export decision, `verify:packages`, and a unit test of the helper | `mapLimit` was private with one constant caller and no tests, and `verify:packages` compares export names, not behavior | `mapLimit` refuses a width that is not a positive safe integer and stops starting items after a rejection, owned by `packages/core/test/limits.test.ts` (rung 3) |
| 3 | `mapLimit` rejected while calls it had started kept running | The sweep's per-item batches could commit or fail after the sweep had rejected and its caller had closed the executor | The round-one `limits.test.ts` cases | They asserted which items started, never which had finished when the rejection was observed, and the fix's docblock declared the behavior intended | Workers record the first rejection and stop, and `mapLimit` waits for every worker before rejecting, owned by `settles every started call before it rejects` (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review` round one over `45992fb...32cbeed` (8 findings reported; 2 correctness findings) | 2 | No |
| Fable `/code-review` round two over the round-one fix commits (9 findings reported; 1 correctness finding, introduced by a round-one fix) | 1 | No |
| Fable `/code-review` round three over the round-two fix commits (10 findings reported; none a correctness finding; all introduced by round-two fixes) | 0 | No |
| Fable `/code-review` round four over the round-three fix commits (6 findings reported; none a correctness finding; all introduced by round-three fixes) | 0 | No |
| Fable `/code-review` round five over the round-four fix commits (5 findings reported; none a correctness finding; all introduced by round-four fixes) | 0 | No |

Self-catch rate: 0 of 3, or 0% (previous round: 0%, `pr3.5a-simplification-review.md`).

## Recurrence

- **The second outcome reader recurs.** `hosted-alpha-cancelled-inspection.md` found the hosted inspector projecting a task outcome differently from `getTaskResult`: it re-listed which states may carry a failure and dropped `$Cancelled`. Its mechanism projected the failure by presence inside that adapter and added a cancel-to-inspect test. Both checked that one projection matched the store, not that every outcome reader shares the store's decode, so the dogfood reader was outside them. AGENTS.md's single-representation law names this class, "two read paths for one value is where divergence lives", and this round is its second instance. The build-time lint is the first mechanism aimed at the class rather than an instance.
- **Work outliving its bound recurs.** `hosted-alpha-release-boundary-review.md` found an async launcher observer that outlived its bounded slot, and fixed it by awaiting the observer inside `inlineLauncher`. That mechanism was local to one call site, so `mapLimit`'s started calls outliving its rejection were outside it. This round's fix is local to `mapLimit` too.
- **The unchecked width is the PR3.5a mechanism's recorded residual.** `package-surface.mjs` stops a published name from disappearing, and its postmortem recorded that it compares names, not declarations. A new export's contract is outside it by construction.

Two of the three findings recur classes whose earlier mechanisms were each local to one adapter.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Core `decodeTaskResult` with `TASK_RESULT_COLUMNS` | 1 for the stores and dogfood status | A new reader that never calls it; the lint row below exhibits one that also passes the lint |
| `scripts/outcome-lint.py` | 2, syntactic | A column name computed at runtime. An app source with `const outcome = ['completed', 'payload'].join('_')` and `row[outcome]` passes with `outcome-lint: task outcome columns confined to the stores and decodeTaskResult` and exit 0, while `row.completed_payload` in the same fixture tree is flagged with exit 1. The lint checks spelling, not reads |
| Engine invariants `task-outcome/*`, one condition per rule a task row breaks | 3 | A shape-valid but wrong outcome. `decodeTaskResult('t', { state: 'completed', completed_payload: 'not json', failure_reason: null })` returns `{"state":"completed","completedPayloadJson":"not json"}`, so the invariant accepts that row. It checks which columns are present for a state, not their content |
| `mapLimit` width refusal, stop flag, and settle-before-reject, owned by `limits.test.ts` | 3 | A call that never settles. `mapLimit([0, 1], 2, fn)`, where item 0 rejects and item 1 returns a promise that never resolves, is still pending after 200 ms and never rejects, while `limits.test.ts` passes 4 of 4. Waiting for started calls turns a hung call into a hung caller |
| The successor case that classifies every runs column | 3 | A column misclassified by the author. A scratch libSQL `runs` column the stores never carry, added to the case's successor-owned list, passes the case (`Tests  1 passed`). The case forces a decision for each new column, but it cannot tell a wrong decision from a right one |
| Dogfood refusal red test | 3 | It exercises `status()` only. A scratch second dogfood reader with its own SELECT printed `{"state":"completed","completedResult":null}` for a row `status()` refuses, while every existing lint and the dogfood suite, 5 of 5, passed. The outcome lint now flags that reader |

## Fix-induced defects

Round two judged the round-one fix commits as new code and reported nine findings. Seven were introduced by those fixes:

- `decodeTaskResult` treated a missing column as present and never validated `state`.
- Finding 3 above: `mapLimit` rejected before its started calls settled, which the round-one fix documented as intended.
- DESIGN.md claimed every reader decodes through core, while the conformance harness reads raw state.
- Dogfood status repeated the file's `optionalJson` helper.
- The successor case's failure message dropped the task id.
- The columns a successor sets for itself lived only in a test.
- `created_at_ms` was typed out at four insert sites.

The other two predate the fixes: the live-task reason allowance, first written before round one, and a mutation count in BUILD.md that was already one behind.

The branch's own machinery caught two more fix-induced defects before any review saw them. The new positive-control case read a retried task as `{ state: 'sleeping' }`, refuting a docblock and DESIGN.md sentence that said a user retry keeps the failed attempt's reason. The remote `pnpm verify` then failed the outcome lint's selftest, because the selftest runner copied the shared lexer only for four named checkers; an isolated replay of those cases had copied the lexer itself and passed.

Round three judged the round-two fix commits as new code and reported ten findings. All ten were introduced by those fixes:

- The lint selftest did not copy the shared lexer for the new lint, which the remote `pnpm verify` had already caught.
- The simplified successor case compared successors only with their parents, so a transition that cleared the parked wake on the parent would pass.
- DESIGN.md and BUILD.md kept the old invariant counts.
- The new lint harvested only `.ts` files and skipped the SQL of `contract.ts`.
- `created_at_ms` was described as taken from the parent and listed as successor-owned.
- Two poison-matrix cases completed a task without a payload, so they fired the new outcome condition beyond their covers.
- One invariant condition covered every decoder refusal, with one witness.
- A red commit message claimed dogfood coverage the commit did not contain.
- The outcome column names were defined twice in the decoder.
- The decoder checked states and columns through `Set.prototype.has` and the array iterator instead of captured intrinsics.

The fixes were re-reviewed as new code in each round. The rate of fix-induced findings stayed at or near all of a round's findings, which says the fixes kept introducing new representations faster than the machinery could see them.

Round four judged the round-three fix commits and reported six findings, all introduced by those fixes:

- The contradiction classifier returned only the first broken rule, while DESIGN.md said each broken rule is reported.
- Core published an unchecked outcome reader that the lint could not see.
- The lint refused any `.tsx` source whose JSX text its lexer could not parse.
- Removing a catch made an unknown task state abort invariant evaluation. Both schemas refuse such a state, so this stays a deliberate throw with a comment.
- The strengthened successor check credited a parent's lost value to the successor mutation.
- The four outcome condition ids were written out twice.

Round five judged the round-four fix commits and reported five findings, all introduced by those fixes: the lint's `.tsx` fallback that a URL in JSX text could evade, a verdict for comments that depended on unrelated JSX, no test that the invariants report more than one rule, an export test that checked one name, and a message split without a red commit. The fixes were not re-reviewed; their tests and the final gates are the evidence.

Across rounds two through five, every finding was introduced by the previous round's fixes. The correctness findings stopped after round two, while each tooling fix, most of all the lint's text matching, kept exposing its next boundary. That pattern is the mechanism audit's syntactic-lint row in action.

## Evidence

- Red tests, each run and seen failing: `fe5fa2f` fails with `completed without payload must be refused: expected 'reported' to be 'refused'`. `6d5dbec` fails 2 of 3 with `width 0 must be refused: expected [ undefined, undefined, undefined ] to be an instance of RangeError` and `expected [ +0, 1, 2, 3, 4 ] to deeply equal [ +0, 1 ]`. `9c1b105` fails with `expected [] to deeply equal [ 1, 2, 3 ]`.
- Fixes: `3e7aed8` (decoder and dogfood), `cbd2fc6` (width and stop flag), and `3c2a0cd` (settle before reject). At the final head `b28334e`, the confined `pnpm verify` exits 0 with 6,127 tests passing, all seven affected mutations are caught by their attributable verdicts, and `pnpm verify:fuzz` (2,000 seeds of 100 steps) exits 0 with 46 test files and 5,604 tests passing.
- Finder, round one: "dogfood status() reads tasks.completed_payload and failure_reason with raw SQL, a second read path for the task outcome that bypasses requireTaskResultShape." And: "mapLimit is now a published @durablerun/core export but accepts any width: 0, negative or NaN creates no workers, never calls fn, and returns a sparse array typed R[]."
- Finder, round two: "Item 0's batch throws StoreUnavailableError, Promise.all rejects, and tick/sweep throws to the dogfood runtime, which may call close(). Items 1 to 7 are still running fenced batches."
- Claims that did not reproduce: round one's verifier refuted a redundant `completedPayloadJson !== undefined` check in `hosted.ts`, which `exactOptionalPropertyTypes` needs for narrowing. Round one also said no test read an engine-written cancelled task through `getTaskResult`. The mutation audit refuted that: under `task-result-refuses-engine-reasons`, the hosted router's "returns the stored failure reason when inspecting a cancelled task" failed alongside the new case. Relaunch-capped and infra-capped tasks really were unread. Round two dropped four candidates of its own, including a second rejection going unhandled.
- The non-correctness findings are listed with their dispositions in the PR body.

## Root cause

Each hardening in this PR first landed at its first user instead of at its definition. The refusal went into the stores' `getTaskResult`, which left the other decoder of the same columns outside it. The helper hoist moved `mapLimit` into a published barrel without moving the assumptions its single caller had supplied, a constant width and a caller that never saw the rejection before the batches finished. When review showed the gap, the round-one fixes documented the remaining behavior as intended instead of testing it, which is how finding 3 and the live-reason sentence survived one more round.

## Mechanisms

Built in this PR:

- Core `decodeTaskResult` and `TASK_RESULT_COLUMNS`, used by both stores and dogfood status (rung 1 for those readers).
- `scripts/outcome-lint.py` in `pnpm verify`, with 15 refusals and 8 accepted near misses in the lint selftest (rung 2).
- The engine invariants `task-outcome/completed-without-payload`, `payload-on-other-state`, `failure-without-reason`, and `reason-on-other-state`, each with its own poison-matrix case, so every scenario, fuzz, and sim run checks the outcome contract on every task row (rung 3).
- `mapLimit`'s width refusal, stop flag, and settle-before-reject, owned by `limits.test.ts` (rung 3).
- The refusal case, the positive-control case with the registered mutation `task-result-refuses-engine-reasons`, and the successor case that classifies every runs column (rung 3).

Deferred (recorded in BUILD.md):

- None. PR3.2's `retryTask` must relax the live-reason refusal together with a case that writes such a row, and BUILD.md records that obligation under PR3.2. No repository-wide mechanism for async work outliving its caller is justified by two instances with different shapes, and the residual below names the shape that survives.

## What this round still would not catch

- A production reader that builds an outcome column name at runtime would pass the lint and bypass the decoder.
- A task row with a well-shaped but wrong outcome, such as a payload that is not JSON or belongs to another task, would pass the decoder and the invariant.
- A `mapLimit` call that never settles would hang its caller, and the sweep with it, after another call rejected.
- Async work that outlives its caller outside `inlineLauncher` and `mapLimit` would ship today; no mechanism covers the class.
