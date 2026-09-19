# Postmortem: <round name> (PR #NN)

<One paragraph: what the change was, what the review round found, and the
verdict in plain language. Written for a reader outside these sessions.>

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

<Why this is a SEV: what would have shipped without the review, and the
user-visible impact of each escaped bug. State the worst finding first.>

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|

## Detection ledger

<Who found each finding: this project's own machinery (a red test, the fuzz,
TLC, an invariant, a lint, the mutation probe) versus an outside reviewer.
Then the ratio.

The ratio is the headline number of the whole document. A round where outside
review found most of the defects is a round where the machinery did not work,
however good the fixes are — fixes are the cheap part, and a review round is
not a repeatable process. State the rate plainly and compare it to the
previous round's; a rate that is not improving means the mechanisms being
added are not the ones that matter.>

| Detector | Findings | Ours? |
|----------|----------|-------|

Self-catch rate: <n>% (previous round: <n>%).

## Recurrence

<For each finding, is it another instance of a class an EARLIER round already
instituted a mechanism against? Answer per class, not per finding.

If yes, that earlier mechanism did not work, and saying exactly why is the
most valuable paragraph in this document — more valuable than every fix in it.
A class that recurs after a mechanism is evidence the mechanism is a proxy for
the property, not the property. Name what the mechanism actually checks and
what it was supposed to check.

If a class recurred in EVERY round so far, say so in those words.>

## Mechanism audit — the false negative of each

<For every mechanism claimed in Findings or Mechanisms, EXHIBIT the code that
still contains the bug and still passes it. Write the code, run it, paste it.

This is the section that stops a point fix from wearing the word "mechanism".
A mechanism whose false negative cannot be written has not had its boundary
understood; a mechanism with genuinely no false negative is rung 1, and saying
which of those two applies is the entire point.

Label every syntactic check as such — "the text contains a fence token" is a
proxy for "the fence gates the write", and proxies leak forever. A syntactic
mechanism against a semantic property is a known future recurrence, and
recording it here is how the next round knows where to look first.>

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|

## Fix-induced defects

<How many findings in this round were introduced by the FIXES for earlier
findings in the same round, and which ones.

A repair is a change, and a change made immediately after understanding
something is not safer than any other change — the understanding is about the
shape the code had before. If this count is above zero, say whether the fixes
were re-reviewed as new code or merely re-tested.>

## Evidence

- Red tests: commit `<hash>`, probe `<test file>` `<test name>` — run and seen failing (<n> tests) against `<buggy commit>`.
- Fixes: commit `<hash>`; gate after fix: <verify / fuzz / TLC results>.
- <The attestation script reads the commits cited here. Any backticked commit
  id in this document that the repository holds must be on the pull request's
  branch; write one that is rightly elsewhere without backticks. A label is
  the first word of either line above, whole or cut short to three letters or
  more: at the start of a line, or inside one at the start of a clause,
  before a colon or straight before an id. An id belongs to the nearest label
  before it, so give each
  round's red tests and fixes a label, on lines of their own or sharing one.
  Under a label every id must resolve and be the pull request's own, made
  after it left its base, and some cited fix must descend from each red test;
  a commit of an earlier pull request goes in prose on another line. A line
  may also name a commit of the other kind, the fix that answers a red test
  or the red test a fix turns green: a commit under both labels counts where
  it comes first after its label, and first under both it is refused, because
  a red test and its fix are two commits. An id that
  follows the word that stands before the buggy commit above, in the same
  clause, is the code a red test ran against, and is neither. A red test that
  names a probe as the first line above does, the test file and then a test
  name if the file holds more, is run by `--prove-reds`: it must fail at the
  red commit and pass at the head. A rebase gives every commit a new id, so
  cite them last, and again whenever the branch moves. Delete this bullet.>
- Finder: <which review round / tool>, quoted verdict: "<...>".
- <Links or quoted excerpts sufficient for an outside reader to audit the
  round. Never cite session-local or machine-local paths — quote the
  content itself. The attestation script machine-rejects a postmortem that
  still contains template placeholders or an empty findings table.>
- <Claims that did NOT reproduce, and the probe that settled each. A round
  that reports only confirmed findings is one where the disconfirmations were
  not written down.>

## Root cause

<The machinery failure, from first principles: why did every existing layer
miss these — not per-defect (the table has that), but the common cause.>

## Mechanisms

Built in this PR:

- <mechanism, its ladder rung, and where it lives>

Deferred (recorded in BUILD.md):

- <mechanism and why deferral is acceptable>

## What this round still would not catch

<The honest residual, in the form "a defect of shape X would ship today".
Derive it from the Mechanism audit above: every false negative recorded there
is a defect shape that survives this round.

A postmortem that ends without this section is claiming completeness it has
not earned, and the next round will find exactly what was left out of it.>
