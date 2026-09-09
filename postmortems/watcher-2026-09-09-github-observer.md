# Postmortem: GitHub observer boundaries, 2026-09-09

**Pre-merge self-catch rate: 2 of 5, or 40%.** Implementation caught two adapter
defect classes; formal review found three more. Legitimate pagination could be
rejected, cleanup could replace retry guidance, and headerless throttling could
end a watch prematurely. None produced false `ready` results or changed the
engine protocol. The repairs passed the complete local gate before the branch
was pushed; hosted acceptance is recorded separately in BUILD.md.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The gap was which provider behaviors the fixtures represented, not
whether an individual inspected enough lines.

## Severity

R2 could ignore a 429 response's 900-second instruction and retry after 60
seconds. R3 could terminate on transient, headerless secondary throttling.
R1 could stop a legitimate paginated watch when GitHub used a canonical
repository-ID link. These are review-caught operability SEVs.
The observer still failed closed: none of the findings established successful CI,
misattributed another commit's checks, or lost durable task state.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 2 | Awaiting error-body cancellation before classification lets cleanup replace the received status and headers | Provider-directed backoff and HTTP error identity are lost | Observer's generated HTTP-status and body-fault surface | Status cases had clean bodies; body faults exercised successful responses only | Independent best-effort cleanup (rung 1); cross status with cleanup faults (rung 3) |
| 1 | Pagination validation accepts only the requested owner/name spelling, rejecting GitHub's canonical repository-ID URL | A valid paginated check/status read ends unavailable | Observer's generated pagination identity cases | The mock constructed every honest link from the request URL, excluding the provider's alternate identity representation | Bind canonical repository ID from the PR response and generate requests locally (rung 1 identity boundary); test both URL forms and mismatched IDs (rung 3) |
| 3 | A 403 without recognized rate-limit headers is classified as permanent | Headerless secondary throttling ends a recoverable watch | Observer's HTTP-status/rate-limit matrix | Its expected result assumed missing indicators proved permission denial | Retry ambiguous 403 within the existing bounded budget, without body/header guessing (rung 1); cover 403 with and without indicators (rung 3) |

## Detection ledger

The canonical ledger counts the three escaped findings in this postmortem.
Before formal review, author-run fixtures caught two other defect classes:
repeated/malformed pagination row IDs and transport failure while reading a
successful response body. Those pre-review catches are not escaped SEVs.

| Detector | Findings | Ours? |
|----------|----------|-------|
| Independent live-provider review (R1) | 1 | no |
| Independent workflow/adapter review (R2) | 1 | no |
| Completed independent CLI review (R3) | 1 | no |

Self-catch rate: **2 of 5, or 40%** (previous
[hosted function selection](hosted-2026-09-08-function-selection.md) round:
**0 of 1, or 0%**). The observed ratio improves, not provider completeness.
Post-review regressions do not retroactively count as author detection.
Counts describe defect classes, not generated cases or review comments.

## Recurrence

R1 repeats the earlier host-boundary class: checking a fixture's representation
rather than the provider's behavior. Matching one path spelling was a proxy for
matching the same repository. Negative URL cases rejected foreign identities
without representing GitHub's legitimate canonical spelling.

R2 is a residual of this round's response-body transport class. The earlier fix
distinguished successful-body transport rejection from malformed JSON, but
never crossed body failure with non-success HTTP. It protected parsing, not
the property that optional cleanup cannot change an already known outcome.

R3 repeats the same incomplete-boundary class: missing rate-limit indicators
were treated as proof of permanence. An expected 403 verdict encoded that
assumption, so additional executions of the same matrix could not expose it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Canonical repository binding with locally generated requests | 1, for outbound identity containment | Requests remain locally generated at the fixed origin; that shape does not prove the bound ID was parsed correctly. Specimen A corrupts the ID while retaining that shape. |
| Existing pagination matrix across both accepted URL forms | 3 | Specimen A truncates repository IDs to 16 bits; all 41 observer tests still pass, but the real repository ID fails the independent control. |
| Unconditional best-effort cleanup outside HTTP classification | 1, for cleanup affecting classification | Rejection or non-settlement cannot gate the unchanged control path. Specimen B deliberately breaks this shape for an untested status. |
| Existing HTTP-status matrix crossed with cancellation faults | 3 | Specimen B reintroduces awaited cleanup only for 404; all 41 observer tests still pass, but a native errored-body control exposes misclassification. |
| Bounded retry for ambiguous 403, plus indicated/unindicated cases | 1 for the ambiguity policy; 3 for fixtures | No response-message proxy decides whether an unclassified 403 may be temporary. The headerless-403 regression passes in the 59-test final focused run; this does not prove other status handling, as specimen B demonstrates. |

Both specimens ran separately against the R1/R2 repaired candidate, before R3.
They are test boundaries, not additional product findings or an engine audit:

```ts
// A: replace repository ID extraction.
const repositoryId = integer(record(record(row.base).repo).id) & 0xffff
// B: replace the unconditional cleanup statement.
if (response.status === 404) await response.body?.cancel()
else void response.body?.cancel().catch(() => {})
```

A passed **41/41** observer tests, then narrowed real ID `1304973709` to
`20877`. The independent canonical-link probe observed four requests and
`observed/passed` in the unchanged control, versus two requests and
`unavailable/malformed-github-pagination` in the specimen. B also passed
**41/41**; its native 404 cancellation-rejection probe changed the control's
`github-http-404`, `retryable:false` into `github-transport-error`,
`retryable:true`. That unchanged R1/R2 candidate passed all 12 controls:
403/404/429/503 crossed with resolving, rejecting, and unsettled cleanup;
every 429 retained its 900-second delay. R3 intentionally revises ambiguous
403 retryability; the 404 survivor remains a valid finite-coverage boundary.

> PASS: both synthetic defects survive all 41 observer tests; independent probes expose them; unchanged production controls pass all three native cleanup outcomes.

The retained probe transcript's SHA-256 is
`3f820e98806c2de5426e0a75c1afd41c6df2431c456a2f10ef6f7c71ef61813c`.

## Fix-induced defects

**Zero of three formal findings.** All three conditions predated the repairs.
R2 is an omitted boundary, not a defect introduced by successful-body handling.
R1/R2 finders reviewed those repairs and reported zero remaining findings;
the later completed CLI review found R3, not a fix-induced defect.

## Evidence

- Reviewed buggy tree: `3965f745a702e68d496055812694708c76f70064`, based on
  main `90b44b83e1967286b4baddc64126f053eec90221`.
- R1 finder: independent live-provider review. Its verdict was:

  > Real provider canonical repository pagination is rejected: observeGitHubChecks returns unavailable / malformed-github-pagination before page 2 for GitHub’s legitimate /repositories/{id}/… next URLs, so a multi-page observation cannot complete despite the documented five-page support.

  Public HTTP 200 at `2026-09-09T02:01:11Z` for
  `/repos/ejc3/durablerun/commits/90b44b83e1967286b4baddc64126f053eec90221/check-runs?per_page=1&filter=latest&page=1`
  advertised a next page under `/repositories/1304973709/commits/` for the same
  SHA and query, advancing to `page=2`; its last page was 13. A small page size
  exposed the provider's canonical spelling without manufacturing check runs.
- R2 finder: independent full-diff simplification review, subsequently
  corroborated by the completed independent CLI review. The CLI verdict was:

  > A known 429 with `Retry-After: 900`, for example, is converted into a generic transport error; `pr-watcher.ts:163-170` then retries after 60 seconds. Permanent 401/404 responses likewise consume the retry budget instead of terminating immediately.

  The native errored-stream probe reported
  `{"name":"TypeError","retainedRetryAfter":"900","reachesHeaderClassification":false}`.
- R3 finder: the completed independent CLI review, not an abandoned/quota-limited run:

  > The response is consequently marked non-retryable, and `pr-watcher.ts:138-140` immediately returns `unavailable` rather than backing off.

  GitHub's [rate-limit contract](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)
  includes secondary-limit 403 responses without guaranteed retry headers.
  The headerless-403 regression is committed in
  `59713a4ef64f6f5763e7bb953672d92dbe6ff03e`: a secondary-limit response with
  remaining primary quota `42` produced `retryable:false` instead of the
  required `true`, observed failing before commit. Its response text is only
  fixture evidence; the repair does not classify by that text.
- The expanded adapter run observed **25 passed and 14 failed, 39 total**:
  two canonical-URL positive cases and 12 HTTP-cleanup cases (403/429/503 at
  each of four request boundaries). Red commit
  `e0fec18490a14fe412983033f7e647be4ba52e5c` contains the initial feature and
  regressions against the unchanged buggy runtime, before the separate fix.
  Adding an unsettled-cleanup case produced one cancellation in isolation;
  the combined 40-test run reported **24 passed, 14 failed, 2 cancelled**
  (the unsettled case and the following test cancelled by the runner), not 40
  completed verdicts.
- R1/R2 fixes landed in `59713a4ef64f6f5763e7bb953672d92dbe6ff03e`, which
  also contains the deliberately red R3 regression. Before adding that case,
  repaired tree `f59dad02b6d73a5df06b28434d6db1135f2e787d` passed confined
  full verification: **5,937 workspace tests and 58 external tests**. That is
  not a claim that the combined R1/R2-fix-plus-R3-red commit was wholly green.
- Final green commit `f460c2d87c93190456e399a27fdc8a29d8e6b35c` passed confined
  `pnpm verify`: **104 workspace files, 5,937 tests, and all 59 external tests**.
  A clean external alpha.1 installation independently passed typecheck and the
  same 59 tests. Two independent reviewers checked the final R3 delta at tree
  `1f46fa196c6b44fc818a7c7ae2dbeca8be3151fb` and reported zero remaining findings.
  The earlier 41 passing external tests had not covered R1 or R2.
- The probes above disconfirm that fixture IDs cover numeric width or that
  the status matrix proves every cleanup path. Unchanged native controls
  also disconfirm that detached cleanup inherently loses received headers.
- Hosted acceptance was a separate exit test, not inferred from these tests.
  The subsequently completed [live receipt](../receipts/hosted-pr-watcher-2026-09-09.json)
  records the pending-to-ready watch and unattended interruption recovery;
  BUILD.md owns that milestone verdict.

## Root cause

Test generation began from an incomplete boundary model: honest pagination
came from the mock's URL constructor, while body faults were partitioned by
code path. This omitted a real identity alias and the interaction between a
received HTTP error and optional cleanup. More isolated cases would not fix
the gap; combinations and ambiguous-provider outcomes belong in the existing tests.

## Mechanisms

Built in this PR:

- Normalize admitted owner/name and canonical-ID pagination identities to the
  repository bound by the PR response; keep generated requests at the fixed
  GitHub origin. Extend the existing URL matrix, not a new global checker.
- Remove body cleanup from the HTTP control path; extend the existing status
  matrix with rejected and unsettled cancellation.
- Retry ambiguous 403 as `github-http-403` using existing bounded exponential
  backoff. Header-indicated limits retain their delay; 401/404 remain permanent.
  Permission-denied 403s now also consume the bounded polling budget: a deliberate
  availability tradeoff, without parsing error-message text as another proxy.

The fix also shares the consumer's 60/3600-second policy constants; this removes
duplicated values but is not additional provider-behavior coverage.

Deferred (recorded in BUILD.md):

- Broader numeric-ID and HTTP-status/body fixture coverage awaits an observed
  consumer failure; no new global assurance project is opened. Private-repository
  provisioning, mergeability, and an atomic GitHub snapshot remain non-goals.

## What this round still would not catch

An ID-width truncation or status-specific return to awaited cleanup could
still pass the checked-in matrices, as the specimens demonstrate. Unchanged
cleanup handles rejection/stalling, and generated requests retain identity
containment; neither proves GitHub-wide semantic completeness. The independent
hosted receipt proves one real recovery, not exhaustive provider behavior.
