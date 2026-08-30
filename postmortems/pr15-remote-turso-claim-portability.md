# Postmortem: remote Turso claim portability (PR #15)

PR #14 delivered the first useful hosted dogfood slice. Its first real tick
found that the merged claim batch used a scalar aggregate spelling accepted by
local libSQL but rejected by remote Turso. The batch failed atomically, so no
durable state was lost or duplicated, but the Turso-first scheduler could not
claim any work. PR #15 replaces all current instances of that spelling and
records why local conformance was not evidence about the hosted parser.

**This document is adversarial toward the machinery and blameless toward
people.** The defect is smaller than the assurance failure: the milestone
pulled one remote implementation forward, while its release gate continued to
exercise only the local implementation used as its proxy.

## Severity

This is a post-merge live-deployment SEV. A developer could create and inspect
the hosted task, but every due remote run failed in `claim` with
`SQL_PARSE_ERROR`; the advertised Turso-first scheduler was therefore inert.
Turso rejected the atomic batch before its first claim mutation, so the impact
was total loss of progress rather than lost, duplicated, or misattributed
durable state.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The claim batch emitted aggregate `HAVING` without `GROUP BY` for the wait-step singleton, wait ambiguity, and task-book singleton | Every hosted Turso claim raised before mutation; spawned work never ran | The selected remote implementation's pre-merge outcome check | Shared conformance used local `:memory:` libSQL, whose parser accepts the spelling; hosted credentials and the database were provisioned only after merge | One `singletonAggregate` owns all current singleton projections (rung 1 within that shape), the exact emitted claim inventory rejects the measured spelling (rung 2), and the hosted tick exercises the deployed parser (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| First live remote-Turso dogfood tick after PR #14 merged | 1 | Yes, but after release |
| External/adversarial reviewer | 0 | No |

Self-catch rate: 100% (previous round: 0%). That number needs the hostile
qualification: the pre-merge self-catch rate was 0%. The dogfood machinery
found the defect on its first outcome-bearing execution, but only after the
buggy tree was on `main`; it diagnosed the release rather than protecting it.

## Recurrence

The exact grammar defect is new. The mechanism failure is not: it is another
proxy standing where the property fits. The repository's libSQL fixture proved
behavior against an embedded local parser and was treated as evidence for the
hosted Turso parser. `packages/store-libsql/test/executor.test.ts` even recorded
remote reruns as later Phase C work. When BUILD pulled one thin remote slice
into the current milestone, the outcome moved but that assurance boundary did
not. The existing pluggability rule enrolled store packages, not materially
different realizations hidden behind one package.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Shared `singletonAggregate` builder | 1 for enrolled call sites | A future operation can hand-write `(SELECT COUNT(*) FROM x HAVING COUNT(*) = 1)` without calling the builder; current structure does not make arbitrary store SQL use it |
| Exact emitted-claim ungrouped-`HAVING` regression | 2, syntactic | Executed controls `SELECT COUNT(*) FROM (SELECT key FROM t GROUP BY key) s HAVING COUNT(*) = 1` and `SELECT COUNT(*) FROM t WHERE 'GROUP BY' = 'GROUP BY' HAVING COUNT(*) = 1` both returned zero findings because the scanner sees an earlier `GROUP BY`; remote would still reject the ungrouped outer `HAVING` |
| Hosted normal tick plus both actor-death probes | 3, real implementation | A remote-only syntax defect in an operation those three paths do not reach remains invisible until that operation is exercised |
| Re-aimed legacy-wait mutations | 3, semantic attacks | A new raw singleton projection outside `registeredWait` can be nonportable while both wait mutations still reach their exact expected verdicts |

The syntactic regression is deliberately not called a general SQL parser. It
pins the measured current failure on the exact production claim statements;
the hosted execution is the property check.

## Fix-induced defects

Zero findings were caused by repairs in this round. The conditional aggregate
was compared with the old expression at zero, one, and two source rows before
the hosted rerun, and the existing generated conformance and mutation surfaces
were rerun after the change.

## Evidence

- Red test: commit `ef6148bf0b64034f509806997a5f704373f923b4` was run against buggy `0c91786d90271b7fe43274b009eb314590175251`. One test failed and reported all four incompatible clauses from the exact emitted claim batch; its grouped-`HAVING` control passed.
- Fix: commit `1814b5023872e46306c0e7b13c4d592d105e9c6e`. The focused SQL, legacy-row, and shared conformance run passed 2,601 tests; confined `pnpm verify` passed 93 files and 3,250 tests. All three `legacy-wait` mutations were caught by their exact attributable verdicts.
- Finder: hosted run [33332639022](https://github.com/ejc3/durablerun/actions/runs/33332639022) on the merged head failed with: `batch(claim) failed: ... SQL_PARSE_ERROR: SQL string could not be parsed: near HAVING`. The independent driver probe [33332639190](https://github.com/ejc3/durablerun/actions/runs/33332639190) reached the same error.
- Real-implementation green proof on `1814b50`: normal tick [33333407198](https://github.com/ejc3/durablerun/actions/runs/33333407198) retained one contiguous checkpoint; driver probe [33333437968](https://github.com/ejc3/durablerun/actions/runs/33333437968) completed with one relaunch and zero infrastructure retries; worker probe [33333476630](https://github.com/ejc3/durablerun/actions/runs/33333476630) completed with zero relaunches and one infrastructure retry.
- Data loss did not reproduce. The failed batch left both normal and probe tasks pending with zero attempts and zero checkpoints; the same normal task produced checkpoint one after the repaired claim ran.
- A semantic regression did not reproduce: local zero/one/two-row comparisons produced `NULL/value/NULL` for the old and new singleton projections and `true/true/false` for both ambiguity predicates. Grouped `HAVING` used for JSON duplicate detection also remained accepted by the successful hosted claim.

## Root cause

The root cause was an assurance boundary drawn around a package name instead of
the implementations it actually reached. Local libSQL and hosted Turso share a
client and store package, so the fixture registry had no visible missing
dialect. They do not share every parser behavior. The plan correctly demanded
a real Turso outcome, but provisioning that outcome remained a post-merge step;
therefore the first test of the product thesis was also the first test of the
claim grammar on the product implementation.

## Mechanisms

Built in this PR:

- `singletonAggregate` is the one constructor for the wait and task-book
  singleton projections. It expresses exact-one ownership with portable
  `CASE`, `COUNT`, and `MIN` and exposes the at-most-one predicate from the same
  source description (rung 1 for the observed shape).
- The query-plan suite records every exact emitted claim statement and rejects
  the measured ungrouped aggregate-`HAVING` form, with a grouped negative
  control (rung 2, honestly syntactic).
- Existing mutations now attack the centralized step and ambiguity
  representations rather than obsolete SQL text (rung 3).
- The provisioned hosted workflow is now the selected implementation check:
  normal progress and both actor-death recoveries must produce verified retained
  receipts before the schedule is enabled (rung 3).

Deferred (recorded in BUILD.md):

- Full shared-conformance enrollment against an isolated hosted Turso database
  remains PRC.1. It requires safe ephemeral database lifecycle and credential
  handling; the production dogfood database is not a disposable destructive
  conformance fixture. That broader work is not required to start the selected
  seven-day workload.

## What this round still would not catch

A remote-only grammar or execution difference in a batch the normal tick and
two recovery probes do not reach can still ship. A hand-written singleton
outside the shared builder can also use the rejected spelling, and the narrow
claim scanner has the demonstrated nested-query and string-literal false
negatives. The seven-day dogfood run validates the selected workload, not every
store operation; only the trigger-gated hosted conformance enrollment closes
that wider boundary.
