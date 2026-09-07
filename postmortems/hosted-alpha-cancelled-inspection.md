# Postmortem: hosted-alpha cancelled inspection (PR #20)

The hosted-alpha inspector decoded a stored failure only when a task's state
was `failed`. The scheduler's equally terminal `cancelled` state carries the
wire-visible `{"name":"$Cancelled"}` failure, so inspection silently omitted
data the store returned. Exact-head review caught the mismatch before release;
the adapter now projects every failure value by its presence rather than
maintaining a second list of states that may carry one.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The relevant question is why the store and its contract could agree
while their new public HTTP projection lost one field.

## Severity

This is a release-contract SEV because DESIGN.md promises that inspection
returns the canonically decoded result or failure when present. A host can
enqueue a task, cancel it through the same public `SchedulerStore` supplied to
the router, and then inspect it. The alpha would have returned only
`{"state":"cancelled"}`, discarding the engine's durable reason and making the
HTTP view disagree with `getTaskResult`. No durable state was corrupted, but a
documented operator view was incomplete at release.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `/api/inspect` projected `failureReasonJson` only for `state === 'failed'`, although cancellation stores the same field | A cancelled task's durable `$Cancelled` reason disappeared at the public HTTP boundary | Hosted-router terminal projection test and the projection shape itself | Store conformance covered cancellation and existing hosted tests covered completed and sleeping inspection, but no test crossed cancellation through the adapter; the adapter duplicated part of the terminal-state vocabulary | Project `failure` directly whenever `failureReasonJson` is present, without re-enumerating eligible states (rung 1 within the adapter), and retain a cancel-to-inspect regression (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Exact-head Codex adversarial review of PR #20 | 1 | No |

Self-catch rate: **0 of 1, or 0%** (previous hosted worker-route contract
review: **0 of 1, or 0%**). The rate did not improve: store conformance and the
hosted happy-path suite were green while their boundary composition was not.

## Recurrence

This is another instance of the repository's documented
single-representation class: a consumer copied a subset of the producer's
state vocabulary instead of following the value that was already the
authority. It is not a recurrence of the worker-route finding's prose/code
inventory mismatch, but both escaped because two independently maintained
descriptions agreed on the common path and diverged on a valid edge.

The existing `TaskResult` type exposed one optional failure field for all task
states, and store conformance proved that cancellation populated it. Neither
mechanism constrained the new HTTP adapter's state-specific branch. They were
therefore protections for the producer, not for preservation across this new
serialization boundary.

## Mechanism audit — the false negative of each

The presence projection is the exact property at this adapter: once
`failureReasonJson` is defined, the only response construction path assigns its
canonical parse to `failure`; it no longer asks a second state predicate. There
is no state-vocabulary false negative within that boundary. A store that omits
`failureReasonJson` has failed earlier than this adapter and remains owned by
the shared store conformance suite.

The finite regression is not that proof. The implementation was temporarily
narrowed to the following mutation and the complete hosted-router file still
passed **8 of 8** tests:

```ts
} else if (
  result.state === 'cancelled' &&
  result.failureReasonJson !== undefined
) {
  response.failure = parseTaskValueJson(result.failureReasonJson)
}
```

That code satisfies the new `$Cancelled` example while reintroducing the same
class for every `failed` task. The mutation was restored immediately, and
`git diff --exit-code` confirmed the committed projection was unchanged.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Presence-driven failure projection | 1 within the HTTP adapter | None for the declared projection property: the response assignment is guarded only by presence of the authoritative field, not by a copied state list. A producer that fails to supply the field is outside this mechanism's boundary. |
| Cancel-to-inspect regression | 3 | The state-specific mutation above passed 8 of 8 while dropping valid failed-task reasons; the test proves its concrete cancellation path, not the general projection implementation. |

## Fix-induced defects

**Zero.** The one finding reproduced at the reviewed parent before any repair.
The fix removes a condition and does not change cancellation, storage, or
authorization. The full focused file was rerun after the repair and after the
mechanism-audit mutation was restored.

## Evidence

- Red test: commit `97f2a47` against buggy commit `34421ed`. The focused
  hosted-router run failed **1 of 8** tests: expected
  `failure: {name: "$Cancelled"}` but received only `taskId` and
  `state: "cancelled"`; the other seven tests passed.
- Fix: commit `9781afc`. The same focused file passed **8 of 8** tests through
  the confined runner.
- Finder: exact-head Codex adversarial review of PR #20. Its executable probe
  printed the store result
  `{ state: 'cancelled', failureReasonJson: '{"name":"$Cancelled"}' }` and
  the HTTP result `{"taskId":"cancelprobe-id-000001","state":"cancelled"}`.
- The possibility that cancellation was merely an invalid fabricated store
  result did **not** reproduce: the probe used the production
  `LibsqlSchedulerStore.spawn`, its public `cancelTask`, and the same store
  injected into `createHostedRouter`.
- The possibility that the design intentionally suppresses cancellation
  reasons did **not** reproduce. DESIGN.md says inspection returns the decoded
  result or failure "when present," and the core contract names `$Cancelled`
  as a wire-visible terminal failure reason.

## Root cause

The new adapter treated terminal state and terminal payload as two facts that
had to agree locally, even though `failureReasonJson` already represented the
store's decision that a failure value exists. Repeating only the familiar
`failed` state converted a complete producer contract into an incomplete HTTP
projection. Tests followed the hosted milestone's completed workflow and did
not compose the existing cancellation transition with the new inspector.

## Mechanisms

Built in this PR:

- The hosted inspector now has independent result and failure projections.
  Failure availability is read from `failureReasonJson` itself, so adding or
  forgetting a terminal-state name cannot suppress a supplied failure at this
  boundary (rung 1 within the adapter).
- The hosted-router suite performs a real store spawn, public cancellation,
  and HTTP inspection and requires the canonical `$Cancelled` object (rung 3).

Deferred (recorded in BUILD.md):

- None. DESIGN.md already states the property, the fix is at the existing
  projection chokepoint, and no new assurance system or product surface is
  needed.

## What this round still would not catch

A store implementation could return a cancelled task without
`failureReasonJson`; the HTTP adapter cannot recover data its port did not
receive, so store conformance remains responsible for that case. The focused
regression also does not prove every future result field is projected: a new
field added to `TaskResult` without an adapter test could still be lost at this
boundary. Making `TaskResult` a broader generated wire schema is not justified
by this one-field alpha fix.
