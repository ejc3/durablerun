# Postmortem: <round name> (PR #NN)

<One paragraph: what the change was, what the review round found, and the
verdict in plain language. Written for a reader outside these sessions.>

## Severity

<Why this is a SEV: what would have shipped without the review, and the
user-visible impact of each escaped bug. State the worst finding first.>

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|

## Evidence

- Red tests: commit `<hash>` — run and seen failing (<n> tests) against `<buggy commit>`.
- Fixes: commit `<hash>`; gate after fix: <verify / fuzz / TLC results>.
- Finder: <which review round / tool>, quoted verdict: "<...>".
- <Links or quoted excerpts sufficient for an outside reader to audit the
  round. Never cite session-local or machine-local paths — quote the
  content itself. The attestation script machine-rejects a postmortem that
  still contains template placeholders or an empty findings table.>

## Root cause

<The machinery failure, from first principles: why did every existing layer
miss these — not per-defect (the table has that), but the common cause.>

## Mechanisms

Built in this PR:

- <mechanism, its ladder rung, and where it lives>

Deferred (recorded in BUILD.md):

- <mechanism and why deferral is acceptable>
