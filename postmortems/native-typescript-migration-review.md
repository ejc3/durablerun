# Postmortem: Native TypeScript migration review

The compiler and package-manager migration changes build and assurance tooling, not protocol transitions. Independent review found three defects that the candidate's local checks missed. All three were reproduced before repair; none was merged. The verdict was changes requested.

## Severity

The P1 prevents the required base-owned gate from running. Two P2s weaken assurance: a relative store import written as a static template can evade the CLI boundary check, and a multiline directive can assign a diagnostic to the wrong mutation owner. No production protocol failure was established.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Base checkers use the removed JavaScript compiler API with the candidate compiler | Required base gate fails before grading | Base-gate integration | Local checks exercised only candidate checkers | Exact-byte native adapter bridge and executable startup probe (rung 3) |
| 2 | Static template imports were omitted | Relative store import can escape the opener boundary | Import-boundary controls | Controls sampled quoted imports | Extract templates without expressions; relative-template regression (rung 3) |
| 3 | A directive returned the whole comment range | Earlier documentation mention steals the effective marker and line | Verifier controls | No preceding documentation mention in controls | Restrict range to effective final line; owner-and-line regression (rung 3) |

## Detection ledger

The independent whole-system review found findings 1 and 2. The separate native-verifier review found finding 3. Before this candidate, the project's package smoke test caught copying installed pnpm links into an external npm consumer; that development failure is separate from the escaped findings.

| Detector | Findings | Ours? |
|----------|----------|-------|
| Whole-system independent review | 2 | No |
| Independent native-verifier review | 1 | No |
| Candidate checks | 0 | Yes |

Self-catch rate: 0 of 3, or 0%. The previous recorded purge-port review also reported 0 of 3, or 0%. The escaped-defect detection rate has not improved. Passing existing tests did not establish parser equivalence.

## Recurrence

Finding 1 repeats the established base-gate integration class: the checker and its execution environment must advance together. The existing pinned-file mechanism was appropriate, but this migration initially did not exercise the older checker.

Findings 2 and 3 repeat the broader ownership problem in the verdict-classifier work: a syntactic proxy is not the semantic property. The replacement sampled some representations and missed two behaviors formerly supplied by the compiler. No earlier mechanism promised exhaustive equivalence between these parser APIs.

## Mechanism audit — the false negative of each

These defective substitutes were written and run after the fixes, in isolated probes removed afterward.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Compiler startup probe | 3 | Always print a fixture with empty diagnostics without analysis |
| Static-template regression | 3 | Return templates only when their string contains store-libsql; miss store-mysql |
| Effective-directive regression | 3 | Always return marker right on line 2; misattribute every other directive |

The counterfeit analyzer printed this constant:

~~~js
process.stdout.write(JSON.stringify({
  files: { 'fixture.ts': {
    diagnostics: [],
    expectErrorVerdictMarkers: [['mutation-verdict:construction:right', 2]]
  }}
}))
~~~

It passed the actual compiler probe and copied effective-directive regression. The defective template branch was:

~~~ts
return value.expressions.length === 0 &&
  value.quasis[0]?.value.cooked?.includes('store-libsql')
  ? value.quasis[0].value.cooked
  : undefined
~~~

A copy of the actual import-boundary suite with this branch passed its four controls and a fifth control exhibiting its missed MySQL template. The copied suites reported six passing tests. This is evidence of the local regressions' limits, not a full mutation audit. Exact-byte pins prevent silent adapter changes; they do not prove the pinned implementation correct.

## Fix-induced defects

Three repair integration defects were caught by local checks before merge. First, literal synthetic verdict identifiers were mistaken for unenrolled production guards. The full base-owned mutation checker caught this before push. The fixture now constructs its synthetic identifiers at runtime; actual enrolled guards and their registry are unchanged. Second, the expanded compiler probe exposed that ESM imports ignore NODE_PATH outside the staged tree; the base checkout now links the candidate modules before probing. The second review also found that the initial bridge omitted package-surface.mjs; both compiler clients are now pinned and probed. Third, the older consumer fixture config lacked the explicit Node type inclusion required by native TypeScript; its exact config pair now preserves the same Node consumer under the stricter compiler. Both initial reviews finished before the repairs were batched. Repairs receive independent review as new code and the final gates; testing is not counted as review.

## Evidence

- Red tests: commit `dcd707ee`, probes packages/cli/test/import-boundary.test.ts and packages/conformance/test/native-compiler-verifier.test.ts. Two tests failed and three passed: the relative-template store count was zero, and the owner was wrong on line 1 instead of right on line 2.
- Red tests: commit `dcd707ee`, probe scripts/native-base-gate-probe.cjs against the base analyzer with the candidate compiler. It failed on the missing ScriptTarget.Latest API.
- Red tests: commit `6b57e13f`. The expanded compiler probe failed on the older package-surface checker with a missing NewLineKind.LineFeed API. The compiler bridge is extended to both clients.
- Fixes: commit `a9fb0306` extends the pinned bridge to the package-surface checker.
- Fixes: commit `9b52730c`. Five focused tests and the compiler probe passed after the workflow's pinned bridge installed the native adapter over the older base file.
- Finder: whole-system review, quoted verdicts: "The compiler upgrade breaks the required base gate" and "The import-boundary parser loses static template imports."
- Finder: native-verifier review, quoted verdict: "Multiline directives can acquire the wrong diagnostic owner."
- Pinned-pair controls exercised a different base, unchanged head, unpinned-head refusal and exact replacement. Published-surface snapshots and hashes were not changed.
- Packaging review found no introduced P1/P2. Suggested synthetic filesystem overlays were not accepted: the package smoke proof intentionally exercises real external consumer files and resolution. Existing bounded snapshot cleanup uses finally; replacing its ownership model during this repair enlarges the assurance change.
- Initial TLA proof completed without errors, including exhaustive safety and five liveness groups. Final verify, fuzz, base-owned checks and full CI mutation results belong in the PR validation record.

## Root cause

The migration exercised common candidate paths but omitted a caller environment and two representations. Replacing a compiler API moved compiler-owned behavior into local assumptions. Existing green tests did not identify that change in ownership.

## Mechanisms

Built in this PR:

- Exact-byte native adapter bridge using the existing reviewed bridge mechanism.
- Executable compiler probe in the base-gate job.
- Relative static-template control.
- Effective multiline directive owner-and-line control.
- Existing full mutation audit remains mandatory because the shared verifier changed.

Deferred (recorded in BUILD.md):

- None. The bounded proof's residuals below are not promised implementation work.

## What this round still would not catch

An analyzer preserving every enrolled example can pass these local regressions while being wrong elsewhere. Computed imports remain outside the static inventory. A future parser representation absent from controls may be misclassified. Full mutation attribution and independent review reduce risk without proving exhaustive equivalence. The startup probe alone accepts a checker that performs no analysis.
