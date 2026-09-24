# Postmortem: DESIGN.md counts held to the code (item 13)

The change marks each count DESIGN.md states for a property the code pins with an HTML comment after the number, and adds `packages/conformance/test/design-counts.test.ts`, which compares every marked number with the value the code exports. Its one review found no HIGH or MEDIUM finding and five LOW. One is counted here: a marker written with a space before it was not read at all, so a wrong number beside it passed on a property with more than one marked site. The other four were scope statements in the records (which prose the test does not hold, and which derivable counts were left unmarked) and one shape that already failed loudly; they are corrected or answered without a defect in the mechanism.

**This document is adversarial toward the MACHINERY and blameless toward people.** The question below is what would have made the shape unreadable, or caught it without a reviewer.

## Severity

Nothing a user runs was wrong. What would have shipped is a hold that could not fail in one shape: an edit of a marked sentence that put a space between the number and its marker, or a wrong number written there, left the test green on any key with two or more sites, and the sentence would have gone stale again unnoticed. It is the class the test exists to close.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The reader's pattern needed the number to touch the marker, so `99 <!-- count: temporal-fields -->` matched nothing and was skipped, where a marker that names a key and follows no readable number should fail | A wrong number written with a space before its marker passed whenever the key had another correctly marked site, and the deleted-marker test caught it only on a one-site key | The test's own cases | They covered a deleted marker, a wrong number and a word, and read a text with no space; none wrote a marker the pattern skips | The reader reports every marker, with no number for one that no number touches, and the test refuses it (rung 2, machine-caught at test) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The review of the branch head | 1 | No |
| The test's own cases, the gates and the simplify pass | 0 | Yes |

Self-catch rate: 0 percent (previous round: 0 percent, the last documentation pull request's findings were all found by review). The count is one, so the rate says little; the one finding is a shape of input the author did not write.

## Recurrence

Not another instance of a class an earlier round instituted a mechanism against: the count test is new in this pull request. It belongs to the family of a check that skips what it cannot read and reports green, which the mutation verdict and the label recorder reviews met in other forms. This mechanism had no earlier round to fail in.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The reader and its refusal of an unreadable marker | 2, syntactic: it reads the text before a marker | A sentence that states 99 of a property and carries no marker at all, or carries the marker of another key, passes: the marker is a claim by the author, and no check finds a number that should have one. The last review's list of unmarked derivable counts is this false negative, written down. Run: the test over `the 99 fields` with no marker returns no site and stays green |
| The comparison with an exported value | 1 for a length or a constant the code exports; 2 for four keys computed here as a product or a multiple | If the code changes the factor's meaning while the arithmetic stays true, for example utf8 units moving from four bytes to three, the computed key matches the prose and both are wrong together |

## Fix-induced defects

None. The fix changed one pattern and one return shape, and was re-tested with the same red and with an edit of DESIGN.md (`99 <!-- ... -->` fails by name), not re-reviewed, because the review's cap of one pass applies.

## Evidence

- Red tests: commit `66eea5d`, probe `packages/conformance/test/design-counts.test.ts` `reports a marker that no number touches, so a space before it cannot hide a wrong count` (run and seen failing, 1 test of 4, against `63a71a9`).
- Fixes: commit `6adcf81`; gate after the fix: the counts test 4 of 4, and the short list of the final head.
- Finder: the one review of this pull request, run as a Fable subagent invoking the built-in review skill. Quoted verdict: "No HIGH, no MEDIUM, five LOW; the marker with a space before it reproduces."
- Claims that did not reproduce: the review's second finding, that a marker after a backtick or a punctuation mark is skipped, is refuted, because that shape already reports a non-number and fails loudly.

## Root cause

The reader was written to find numbers and compared what it found. A shape it could not match was outside the loop and looked the same as a shape that was never written. The property is that every marker is held, and the reader checked that every match is held.

## Mechanisms

Built in this PR:

- The reader reports every `<!-- count:` marker, and a marker with no touching number fails the test (rung 2), in `packages/conformance/test/design-counts.test.ts`.

Deferred (recorded in BUILD.md):

- A scan for a literal equal to a pinned value that carries no marker. It would match measurements, and the PR3.10b entry records what stays open.

## What this round still would not catch

A sentence that states a pinned count with no marker beside it, or with the marker of another key, ships today. So does a change of what a factor means that leaves an arithmetic key true.
