# Postmortem: PR4.4d third copies review

PR4.4d hoisted four kinds of code that the three store packages each held a
copy of into core and the conformance package, and carried seventeen
registered mutations along with the lines they find. Its one review found no
HIGH or MEDIUM defect and no behaviour change. It found three things that
were false: a re-aimed mutant that was wider than the one it replaced under a
description that no longer described it, four entries on one shared line of
which two had become one mutant and one had grown wider, and three wrong
statements in the pull request's body, two of them echoed in BUILD.md. All
three were found by the review and none by this project's machinery.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

No product defect would have shipped, and no user would have seen a
difference: the hoist changed no statement and no behaviour, and the review
measured that. What would have shipped is a mutation registry that says
things that are not so. The registry is what a reader trusts when a mutant
survives: its description is the sentence they read first, and the number of
entries on a guard is how well held they take the guard to be.

1. Worst: four entries guard the line that decides whether a failed migration
   write is forgiven. Two of them were one mutant, so the line had three
   holds where the registry showed four, and one had grown wider than its
   description, so a survivor there would have been read as a bootstrap
   defect when it could be a defect of any version's write.
2. One mutant of `spawn` skipped the validation its description said it
   reserialized, so its survivor line would have misdirected the reader.
3. The body told a reviewer that two executors match the version read's label
   where three do, that a block was identical in three with its comments
   where libSQL alone carried a nine-line comment above it, and that a review
   had named the four kinds of copy where BUILD.md's own bullet had. A body
   is what a reviewer and a later reader trust in place of the diff.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `spawn-headers-captured-serializer` was re-aimed to `JSON.stringify(headersInput)`, which leaves out `serializeTaskValue` altogether: wider than main's mutant, under the description "spawn reserializes validated headers" | A survivor would be described as something the mutant does not do | The registry's self-test and the audit | Both hold a mutant to two things: it binds and parses, and its owner catches it. Neither compares a re-aimed mutant with the entry it replaces | None for the class. The replacement now keeps main's shape with the ambient parser in place of core's captured one, and its description is true again. The differential check below is deferred |
| 2 | Four bootstrap entries of three files were re-aimed onto the one shared recovery line. Two became one mutant (never forgive, spelled two ways), one grew wider (it also swallowed a failed version write), and all four descriptions named one dialect for a line that decides three | Three holds shown as four, and a survivor read as one dialect's bootstrap defect | The audit | The audit runs each entry against its own owner only. Two entries that are one mutant both pass, and a widened mutant is still caught by its owner | None for the class. Each entry is now its own defect of the line and each arm of the shared case is isolated once. A check that the four texts differ is a proxy, shown below. The differential check is deferred |
| 3 | Three wrong statements in the body, two echoed in this pull request's BUILD.md bullet | A reader who trusts the body over the diff is misinformed | Nothing: prose has no checker here. The author's own read-back stood in for one | A single-line search cannot see a phrase that wraps, and one echo was hidden that way. Reading one's own sentence against one's own memory of the source is not a check | None. The statements are corrected. This class is caught only by review |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The pull request's one review (the built-in code review, with each item reproduced by hand) | 3 | No |
| This project's machinery | 0 | Yes |

Self-catch rate: 0% (previous round: none, this is the pull request's only review round).

The machinery did catch defects before the review, which are not findings by
this project's rule and are recorded here so the rate is read with them. The
registry's self-test refused by name a mutant whose replacement named an
import that the hoist had removed, in the first full gate run. In the fold it
refused by name a replacement that changed the count of question tokens. A
guarded commit script turned each refusal into no commit at all. None of that
bears on the three findings: every one of them is a statement that was false
while every check was green.

## Recurrence

**A registry entry whose mutant is not what the entry says: recurred.** The
nightly mutation closeout found a mutant that changed two independent
conditions at once (postmortems/pr3.7-nightly-mutation-closeout.md, finding
238), and the first tree-path review found three mutants that each removed or
reached more than their entry claimed
(postmortems/pr3.9e-part3a-review.md, findings 2, 3 and 6). The mechanism
instituted there is one mutation for each condition of a tree rule, with a
derived check that lists conditions that have none. It checks that a
condition HAS a mutation. It was supposed to stand for "each entry is the
defect it names", and it is a proxy for that: it says nothing about whether
an entry's mutant is wider than its description, or whether two entries are
one mutant, and it reads one file's rules, not an entry that moves. This
round is that class arriving by a new road, a re-aim: the text of a
replacement stayed the same or nearly so while the line it lands on gained
callers and lost the files that had told two entries apart.

**A false statement in a pull request's body or in BUILD.md: recurred, and no
mechanism has ever been instituted against it.** Earlier rounds counted false
claims too (postmortems/pr4.4c-self-concurrency-review.md and
postmortems/pr2.5b-transport-lifecycle-review.md among them). Each was
corrected where it stood. There is no checker for prose, so the class is held
by review alone, and this document does not claim otherwise.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A check, in the fold's own edit script, that the four bootstrap entries have pairwise different replacement texts. Syntactic: it compares text, and the property is behaviour | 3, a proxy | Run on the registry as it stood before the fold, it passes: the four texts were `if (false) return`, `if (version === null \|\| version >= minimumVersion) return`, `if (version !== null && version > minimumVersion) return` and `if (version !== null && version > Number.MAX_SAFE_INTEGER) return`. Four texts, and the first and the last decide alike for every version the read can return, because the read refuses an unsafe integer. That registry is the one the review found the duplicate in |
| Each of the four entries is now a different defect, and each arm of the shared case (lost to a winner, lost only its answer, nothing committed) is isolated by one of them | 3 | A fifth entry re-aimed onto the same line tomorrow with a replacement such as `if (version !== null && version >= minimumVersion + 0) return` would be a no-op mutant caught by nothing, or with `version === minimumVersion + 0` a second copy of libSQL's. Nothing compares a new entry's behaviour with its neighbours' |
| The question-token rule of the registry's self-test, which refused `(version ?? 0)` by name | 2, syntactic | It counts a character. `(version \|\| 0)` is the same function for a number or null and passes, which is what the fold uses. The rule guards bind counts in SQL text and says nothing about what a TypeScript mutant does |

## Fix-induced defects

One of three. Finding 1 is a defect of a repair: the wider headers mutant was
written to repair the mutant that the hoist had stranded without its import.
That repair was re-tested, by a probe of the entry by name and by the
unfiltered audit, and both were green, because a wider mutant is still caught
by its owner. It was not re-reviewed as new code until this review read it.
Findings 2 and 3 were written with the hoist itself. The fold's own first
attempt at finding 2 was refused by the self-test before it could be
committed, so it is not a defect of this round.

## Evidence

- Red tests: none of this round's own. The three findings are registry data and sentences, not behaviour, so no test of the product could be red for them. In their place each of the five changed registry entries was probed by name on the folded head and caught by its exact registered owner with no collateral failure: the headers mutant by the aggregate case of the SDK's run-worker test, and each bootstrap entry by its own dialect's copy of the shared schema and admin case.
- Fixes: commit `882e0ab` gives each bootstrap entry its own defect and the headers mutant main's shape, and commit `1391d17` corrects the two statements in BUILD.md and records the deferred check; gate after fix: the registry's self-test, the unfiltered mutation audit (every registered mutation caught by its exact owner, the five changed entries by name), the base gate with the bridge's arm live, typecheck, lint and the source checkers, first on the branch's own base and again after main was merged in.
- Finder: the pull request's one review, the built-in code review at medium effort with each item reproduced by hand, quoted verdict: "I found no HIGH or MEDIUM finding, and I could not find any behaviour change. There are four LOW items and a few wording nits."
- What the review measured, which an outside reader can repeat. A recording executor ran libSQL's `migrate()` at the base and at the head through ten scenarios with identical batch sequences, outcomes and final versions. Core's entry points, computed with the compiler API, gain exactly the thirteen names and the one that the body lists. Ten of the seventeen re-aimed mutants, applied by hand, each went red at its owner's marked assertion with a green control. Each of the four bootstrap mutants turned the libSQL, PostgreSQL and MySQL cases red, three of three, which is how the duplicate and the wider entry were seen. The bridge step, run on the base registry, left a registry equal to the head's byte for byte.
- Claims that did not reproduce. The review's third item, a count in a merge script that is not part of the pull request, was "not reproduced as a failure"; the count could only print zero, and it was corrected without being counted. A mutant of the shared line that only one dialect's case kills was looked for and does not exist: the line is dialect-free and the shared case runs the same three arms on each dialect. The review's fourth item is a note for another pull request (two released declarations of store-libsql change in form and not in type) and is not a defect here.

## Root cause

Moving a registered mutation was treated as moving text. The checks that a
re-aim passed were that its find occurs exactly once, that its replacement
binds and parses, and that its owner catches it. All three are about one
entry and its own test. None says what the mutant IS after the move, and a
move onto shared code changes that without changing a character: the same
replacement reaches every caller of the line, so it is wider, and two
replacements that were told apart by the files they lived in are one mutant
once they share a line. The body's wrong statements have the plainer form of
the same cause: a sentence was checked against the author's memory of the
source and not against the source.

## Mechanisms

Built in this PR:

- Nothing at rung 1 or 2 against either class. The four bootstrap entries are now four defects that isolate the three arms of the shared case (rung 3, and a fix, not a mechanism against the class).
- The fold's edit script held the changed entries to a question-token delta of zero and to pairwise different texts. Both are one-off checks in a private script and both are proxies, as the audit above shows. They are recorded here so that nobody takes them for a mechanism.

Deferred (recorded in BUILD.md):

- A differential check for a re-aim: apply the base's entry at the base and the re-aimed entry at the head, run both against one recorded set of scenarios, and require the same scenarios to break, and different ones for entries that share a find. It is the property and not a proxy for it, it is what the review did by hand, and it is a runner-wide change that needs its own audit. Its trigger is the next hoist that moves registered lines of several files onto one line. Deferral is acceptable because the defect it prevents misleads a reader of the registry and cannot change what the product does.

## What this round still would not catch

- A re-aim that widens a mutant on a shared line would ship today: its owner still catches it, and nothing compares it with the entry it replaces.
- Two entries with different text and one behaviour would ship today, as `if (false) return` and `version > Number.MAX_SAFE_INTEGER` did until the review.
- A no-op mutant whose owner happens to fail for another reason would be credited, which is older than this round and is what the verdict markers narrow but do not close.
- A false sentence in a pull request's body or in BUILD.md would ship today unless a reviewer reads it against the source. A search for such a sentence has to collapse whitespace first, because a phrase that wraps is invisible to a single-line search.
