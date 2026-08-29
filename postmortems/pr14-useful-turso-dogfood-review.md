# Postmortem: useful Turso dogfood evidence review (PR #14)

PR #14 adds a scheduled repository-reference journal, retained status
receipts, and deliberate driver and worker death probes. Adversarial review
found that the workload was runnable but its green workflow did not yet prove
the milestone: normal receipts were not validated, credentials were scoped too
broadly, and fault evidence was not exact. Review of the first repair found a
fourth, fix-induced defect in which the retained receipt was not the receipt
the gate validated. All four defects are fixed before merge.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question is what would have made these defects unwritable or
caught them without a reviewer, not who should have noticed them.

## Severity

The worst finding exposed the dedicated Turso write credential and the
repository token to every action in the job, including checkout, tool setup,
and artifact upload. Compromise of an unnecessarily privileged action could
therefore disclose or mutate the remote dogfood evidence.

The scheduled seven-day workload could also remain green after its durable
task failed or was cancelled, after completion with incomplete evidence, or
while its partial journal was discontinuous. A later repair retained one
status read but validated another. Those defects could produce a green run and
an unvalidated artifact for the milestone's central no-lost-effects claim.

Finally, fault dispatches accepted lower-bound recovery counters and omitted
exact checkpoint attempt ownership. Extra or misclassified recovery
transitions, or a checkpoint rewritten on a later attempt, could look like the
promised single recovery.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Turso credentials and `GITHUB_TOKEN` were job-level environment variables | Checkout, setup, and upload actions inherited credentials they did not need | Workflow security topology | The existing workflow gate covered older checkout defaults; the new workflow had no least-privilege enrollment | Put credentials only on the steps that require them and parse the workflow in a focused regression (rung 2) |
| 2 | Normal scheduled receipts were not validated, including terminal, incomplete completed, and inconsistent partial-live states | Seven days of green jobs could coexist with a failed task or a journal that did not prove contiguous progress | Dogfood outcome gate and receipt contract | Artifact creation and command success stood in for semantic success; only deliberate faults had a verifier | One receipt-policy authority validates every normal state against durable count, span, continuity, attempts, result, and failure evidence (rung 1 authority with rung 2 cases) |
| 3 | Fault recovery accepted lower-bound counters and omitted exact `ownerAttempt` | Extra failures, wrong recovery classification, or checkpoint rewriting could satisfy a probe | Fault-edge progress oracle | Aggregate presence was treated as exact causal evidence, and the new dogfood layer was outside the generated store fault surface | Require exact complementary counters, zero user attempts, one exact checkpoint, ordinal one, and owner attempt one (rung 2) |
| 4 | The first receipt repair retained one status read and validated a second | The uploaded artifact could disagree with the value that made the job green | Single-representation receipt boundary | Write-receipt and verify-receipt steps independently queried the database | The verifier emits and validates the same value piped to `dogfood-after.json` (rung 1 current data flow with rung 2 topology test) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial operability and whole-system reviewers of `e4e45bb` | 3 | no |
| Adversarial mechanism review of the first receipt repair | 1 | no |
| Existing tests, lints, and workflow gates before review | 0 | yes |

Self-catch rate: **0 of 4, or 0%** (previous round: **103 of 151, or
68.2%**). This is a 68.2 percentage-point regression. The red tests reproduce
the findings but were written after reviewers named them, so they do not count
as self-catches.

## Recurrence

All four findings recur at class level.

Findings 2 and 4 repeat partial evidence standing in for successful outcome.
Earlier rounds rejected completion markers that survived later aborts and
durable writes standing in for successful returns. Those mechanisms enrolled
their existing engine and review-artifact layers; nothing enrolled a new
product receipt or required its retained representation to be the validated
representation.

Finding 1 repeats the credential-scope class from the final remote review. Its
mechanism pinned checkout behavior in existing workflows, not secret flow in
every new workflow. Finding 3 repeats the repository's lower-bound-as-proxy
class: earlier generated fault matrices required exact transition outcomes,
but the new dogfood receipt surface was not generated or enrolled at birth.
The recurring defect is therefore layer enrollment, not a failure of the
narrow checks to do what they claimed.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Step-scoped secret environments plus the parsed-workflow test | 2 | Put `${{ secrets.TURSO_AUTH_TOKEN }}` in an action's `with` map; the test checks job and action `env`, so its current assertions still pass |
| Shared normal receipt policy | 1 authority and 2 semantics | Give the checkpoint commit A and the completed-result observation commit B with matching counts and span; the policy returns no errors |
| Exact fault counters and checkpoint attempt | 2 | Give an otherwise exact driver receipt an empty `ownerRunId`; exact counters and `ownerAttempt` still pass |
| One validated-and-retained receipt plus topology test | 1 current flow and 2 future edits | Insert a step after verification that overwrites `dogfood-after.json`; the current producer assertions still pass |

The boundary probes were executed against `01e195d` and returned:

```json
{
  "scopedTestStillPasses": true,
  "contentMismatchErrors": [],
  "emptyOwnerErrors": [],
  "representationTestStillPasses": true
}
```

Before the green repair, the partial-live probe used a sleeping receipt with
seven user attempts, nine infrastructure retries, duplicate ordinal one, and
zero contiguous checkpoints. It returned no errors. The repair rejects that
probe; it is finding 2's concrete false negative, not a residual.

## Fix-induced defects

**One of four.** Finding 4 was introduced by the first fix for finding 2:
adding `dogfood:verify` after `dogfood:status` created two independently timed
representations. It was found by re-reviewing the repair as new code before
the green commit, rather than by merely rerunning the original regressions.
Findings 1 through 3 were already present at `e4e45bb`.

## Evidence

- Red tests: commit `1d26ef9` was run against the behavior in `e4e45bb` and
  produced exactly six failures: two terminal states, incomplete completion,
  two inexact fault receipts, and job-level secret scope.
- Expanded red tests: commit `7cb27ca` was run before its repair and produced
  exactly two failures: corrupt partial-live evidence and a retained receipt
  that was not the validated representation.
- Fixes: commit `01e195d`; the confined `pnpm verify` after the fix passed all
  89 test files and 3,234 tests, plus lint, format-check, and typecheck.
- Operability reviewer verdict: "scheduled normal seven-day job stays green
  after terminal task failure or bad completed evidence; only fault dispatch
  is validated" and "Turso credentials and GITHUB_TOKEN are job-level env,
  inherited by checkout, setup, and upload."
- Whole-system reviewer verdict: "the fault verifier uses lower-bound counters
  and does not assert ownerAttempt, so extra or reclassified failures or a
  checkpoint rewrite can pass."
- Repair-audit verdict: "dogfood-after.json comes from dogfood:status, then
  dogfood:verify opens the database and validates a second status read; the
  retained artifact is not the value the gate validated."
- The active-wait identity concern did not reproduce through any public API
  sequence; its exact stale row required raw corruption, partial restore, or a
  mixed-version writer, so BUILD.md keeps it trigger-gated. Resident HTTP
  lifecycle faults did reproduce, but the selected bounded inline tick never
  enters that transport path; BUILD.md retains them as Phase 2 options.

## Root cause

The new workflow treated successful command execution, artifact existence,
and plausible aggregate counters as interchangeable with the user outcome.
That created separate authorities for scheduled success, retained evidence,
fault recovery, and credential scope. Existing mechanisms belonged to older
engine, mutation, and workflow layers. Nothing required a new outcome-bearing
workflow to define one fail-closed receipt contract, retain exactly the value
it validated, enumerate exact fault outcomes, or declare least-privilege
secret flow.

## Mechanisms

Built in this PR:

- One receipt-policy module accepts untrusted status input and owns normal and
  fault verdicts; the CLI and workflow use it instead of shell predicates
  (rung 1 authority, rung 2 semantic coverage).
- Expected checkpoint count and span come from the durable task parameters,
  not current process configuration (rung 1).
- Live receipts validate bounded contiguous progress; completed receipts also
  require full count, minimum seven-day span, completed-result shape, zero user
  attempts, and no failure reason (rung 2).
- Fault receipts require exact driver or worker counter pairs, zero user
  attempts, ordinal one, and owner attempt one (rung 2).
- The validated value is the same value retained for upload, removing the
  second database read (rung 1 for the current flow).
- Turso credentials exist only on database steps and `GITHUB_TOKEN` only on
  ref-reading execution steps; parsed-workflow regressions pin this current
  topology (rung 2).

Deferred (recorded in BUILD.md):

- No finding-level repair is deferred. Resident HTTP launcher, wake, and
  host-shutdown hardening remains outside this milestone because the selected
  scheduled path uses bounded inline ticks. Active-wait identity remains
  trigger-gated absent an external writer, partial restore, mixed-version
  deployment, or public-API counterexample.

## What this round still would not catch

A secret added through an action's `with` expression or a new workflow outside
the focused dogfood test could still ship. A completed result whose observation
contents differ from checkpoint snapshots can pass when counts and span agree.
An exact fault receipt can carry an empty or foreign `ownerRunId`; fresh probe
keys and the current writer make that unreachable without corruption or an
alternate writer, but the verifier does not prove causal run identity. A
future step inserted after verification could overwrite the retained receipt
before upload. Finally, no local gate can establish seven consecutive days of
remote Turso execution; the retained remote receipts remain required elapsed
milestone evidence.
