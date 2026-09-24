# Postmortem: the closing docs pull request of round two

The pull request marks the follow-ups milestone complete in BUILD.md, records the five approved changes and the Dependabot alerts, rewrites the paragraph of what is held for the maintainer, corrects the entries that still called the same-name swap a limitation, and says in DESIGN.md that Deliverable A was never built. It also loosens one test, which required exactly one current milestone heading, to allow none. Its one review found no HIGH finding, one MEDIUM and three LOW, and two are counted: a false claim about the releases and two sentences that named a current milestone after the change made it complete. No code changed, so no behaviour was wrong.

**This document is adversarial toward the MACHINERY and blameless toward people.** The question in each section is what would have made the sentence unwritable, or caught it without a person reading.

## Severity

Nothing a user runs was wrong. The worst finding is the MEDIUM: the release paragraph said both releases so far had a mutation audit, where BUILD.md's own entry says v0.1.0-alpha.0 was published without the full pre-release sweep and only alpha.1 had it. A maintainer cutting the next release would have read a false account of what the earlier releases proved, in the paragraph written to tell them what a release needs. The second finding would have left two entries telling a reader that a milestone which is now complete is current.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The release paragraph said the two releases had a full set of inputs including a mutation audit. alpha.0 did not: it is the disclosed exception (the review's finding 1, MEDIUM) | The maintainer is given a false account of what a release carried | Reading the sentence against the entries that record each release | The author wrote the paragraph from the brief's summary and from alpha.1's receipt, and did not search BUILD.md for the word audit next to alpha.0 | None. The paragraph says which release had the audit |
| 2 | Two sentences named the current milestone, one saying an item is outside it and one that Absurd oracle parity remains deferred by it, and this change made that milestone complete (the review's finding 2, LOW) | A reader is pointed at a milestone that no longer is current, and one of the two never said which milestone deferred the item | The author's search for words the change makes stale | The brief listed the words to search and the phrase current milestone was not among them | None. The sentences say this plan does not schedule the items |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: the built-in code review skill, run by a subagent at medium effort, beside the reviewer's own checks on a scratch install of the head | 2 | No |
| This project's machinery: the deferral lint, the gate lint, the review-bot lint, the counts test and the test that reads BUILD.md, all green on the reviewed head | 0 | Yes |

Self-catch rate: 0 of 2, or 0% (previous round on main, the last docs pull request: 0 of 9, or 0%).

Not counted, because they are findings the reviewer marked LOW and that hold no false claim: the loosened heading check can pass with no heading (the body now says so), and the Dependabot figures cannot be checked from the repository (the status now says what the Dependabot page listed).

## Recurrence

One class, and it recurs in every closing docs round: a sentence that is false or stale after a change, in prose that no check reads. The previous closing docs pull request's postmortem (`postmortems/followups-last-docs-review.md`) records it nine times, and `postmortems/design-counts-held-to-code-review.md` records that the counts test holds numbers and not sentences. Nothing has been built against the prose, so no earlier mechanism failed here; the class recurs because nothing compares a sentence with what it describes. Finding 1 is a claim written from a summary and not from the entries it summarises. Finding 2 is a change making other sentences stale, which the previous round also recorded as its findings 6 and 8.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The counts test, `packages/conformance/test/design-counts.test.ts`, and the test that reads BUILD.md, `packages/conformance/test/tla-artifact.test.ts` | 2, syntactic: the first holds marked numbers in DESIGN.md to the code, the second pins the milestone heading and two phrases | The head that held both findings passed the two files, 21 tests in 2 files, with the release paragraph saying both releases had an audit and with the two current-milestone sentences in place |
| The deferral lint | 2, syntactic: it reads the first line of an entry for DONE and of a bullet for a word of deferral | The same head passed it. Neither sentence is a bullet's first line |
| A person's search for the words a change makes stale | none | The fold's search on the reviewed head for the words held, not posted and documented limitation found nothing about the phrase current milestone, which the change had made false |

## Fix-induced defects

None. The fold changed three sentences and the body, and no finding of the review came from a repair of an earlier finding. The fold is not re-read, as the plan says.

## Evidence

- Red tests: none. This round has no red test of its own: both findings are sentences of BUILD.md, and no test reads one.
- Fixes: commit `dd6fa8e` for findings 1 and 2, and for the two LOW changes to the status paragraph.
- Finder: the one review of this pull request, run as described in the ledger. Quoted verdict: "One MEDIUM, three LOW."
- The reviewer's evidence for finding 1, quoted: BUILD.md says "`v0.1.0-alpha.0` was published without the full pre-release mutation sweep", while the release paragraph said both releases had a mutation audit.
- Claims that did not reproduce: none. Every factual sentence of the first version that the review checked against main held, among them the five approved changes and their pull request numbers, the twenty-two changed names, and that no code uses the WDK.

## Root cause

The change is prose about the state of the whole repository, and every layer that reads BUILD.md reads a heading, a first line or a number. A sentence about what a release carried, or about which milestone is current, is checked by nothing except the person who wrote it and the reviewer, and the author wrote both from a brief that summarised the entries, and searched for the words the brief named.

## Mechanisms

Built in this PR:

- None. The two sentences are corrected and the test's bound is loosened to at most one heading, which is a relaxation and not a mechanism.

Deferred (recorded in BUILD.md):

- A check that compares a sentence with what it describes has no owner and no trigger beyond the option recorded under the counts test's entry: a class of prose that recurs, which every closing docs round has met.

## What this round still would not catch

A sentence of BUILD.md or DESIGN.md that states what a release, a milestone or a pull request carried, and that differs from the entry that records it, would ship today: no check reads prose, and a search finds only the words its author thought of. The loosened heading test also passes a BUILD.md with no milestone section at all, so a plan that forgot to name the next milestone would ship.
