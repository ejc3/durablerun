# Postmortem: the last docs pull request of the follow-ups milestone

The pull request gives a live owner to every open bullet of BUILD.md that the follow-ups milestone left, records what is held for the maintainer, and corrects sentences that main makes false. It changes BUILD.md and one sentence of DESIGN.md, and adds this document. Its one review found no HIGH finding, one MEDIUM and eight LOW, all in documents, and five are counted here. The worst is a plan entry that named evidence a reader of the public repository cannot find. No code changed, so no behaviour was wrong: every finding is a sentence or a count that told a reader something false.

## Severity

Nothing a user runs was wrong. What would have shipped without the review is a plan that misleads its reader. The worst finding: the PR3.4d entry named three flow programs "of the held branch" as the evidence for a defect main has, and the pushed branch of pull request #75 holds none of them, so a reader who looks finds nothing and may conclude the defect is not shown. The other four would have told a reader that line 16 of the exit test is recorded somewhere it is not, that a store still sends `heartbeat` as text, that PR3.9 landed in five PRs, that PostgreSQL's saga reads walk for a reason schema version 7 ended, that the driver loop always races a launch against its clock, and, in the pull request's body, a count of Trigger sentences that did not add up.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The PR3.4d entry named three flow programs "of the held branch", by title, as the evidence for defect (ii). They are in commits on top of pull request #75 that are not pushed, so the pushed branch holds none of them (the review's finding 1, MEDIUM) | A reader of the public repository cannot find the evidence the plan names for a defect on main | A check that every artifact a plan names is where a reader can see it | No such check exists. The titles were read from a local branch, and nothing asked where a reader would look | None. The entry says the programs are written and not pushed, and why |
| 2 | The status sentence said line 16's "pull request merges last" and named neither the pull request nor the entry that owns the line, and no other line of BUILD.md named either (the review's finding 2) | A reader cannot tell what line 16 is or who owns it | The deferral lint, which reads who owns a bullet | The sentence is prose in the milestone's status, which no check reads | None. The sentence names PR3.5d and pull request #71 |
| 3 | Bullets this pull request corrected kept a stale sentence beside the new one: PR3.9's bullet on the two lints still said a store sends `heartbeat` as text, PR3.9's first paragraph still said it lands in five PRs, and the option under PR3.4 said the range is sound once the column compares by byte, which schema version 7 did (the review's findings 3, 4 and 5). Reading each corrected bullet whole then found the same stale reason for the saga walk in a bullet of PR3.4b and in DESIGN.md section 3.10 | A reader meets two sentences that disagree, and one of them is false | Nothing reads a sentence against the code it describes | A fact is stated in several places, and a correction is made where the author is looking | None. Each sentence is corrected |
| 4 | The pull request's body said 24 orphans got a Trigger sentence in place, and its breakdown summed to 29 against 28 orphans (the review's finding 6) | A reader of the body is given a count that is not the diff's | Nothing holds a body's counts to the diff. The option under PR3.3d covers a body's registry count and arm key and no other count | No check reads a body's prose | None. The body is corrected |
| 5 | PR2.2's corrected sentence said the loop races every launch against its clock, and `launchTimeoutSeconds: null` turns the race off for a launcher that runs the worker inline (the review's finding 9) | A reader is told the watchdog holds where a configuration turns it off | The case that holds the watchdog, which holds the default | A case holds behaviour, and the sentence is compared with nothing | None. The sentence says "by default" and names the option |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: the built-in code review skill, run by a subagent at medium effort, beside the reviewer's own checks of main. It found all five | 5 | No |
| This project's machinery: the deferral lint, the gate lint, the review-bot lint and the test that reads BUILD.md, all green on the reviewed head | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round on main, PR3.14d's: 0 of 5, or 0%).

Not counted, because the author found them: inside the fold, the stale reason for the saga walk in PR3.4b and in DESIGN.md, which is part of finding 3; in the final pass after the merge of main, sentences that the four pull requests merged in between had made false, among them this pull request's own sentence that PR3.14b holds a claim token at `claim`, whose line PR3.3c deleted. Not counted either: the review's finding 7, that the body did not say what waited for the final pass, and its finding 8, a trigger approved at the checkpoint and now worded so that it says who sees the event.

## Recurrence

One class, and it has recurred in nearly every review of this milestone: a sentence or a count that was true when it was written and went stale as the work moved. The merged postmortems of this milestone that record it:

- `postmortems/pr3.3b-hoists-review.md`: an older BUILD.md entry still described `lockEvent`, which that pull request removed. It is that review's finding 4, not counted there.
- `postmortems/pr3.1c-stale-token-column-review.md`: a sentence of DESIGN.md put a measurement made before the column in the present tense. It is that review's finding 6, not counted there.
- `postmortems/pr3.4b-saga-reads-review.md`, finding 9: after the fold for its finding 3, two sentences of BUILD.md and a pin's doc block still said what the fold had changed. The same document says of the wider class, text stronger than what was run or read, that it "has recurred in every recent round".
- `postmortems/pr3.3d-smaller-list-review.md`, finding 2: two `gate-changes:` lines of the body named the arm's key and the registry count of an earlier main after the second merge of main.
- `postmortems/pr3.3c-port-durable-strings-review.md`, finding 4, a sentence of the body that the branch's own later change made false, and finding 5, five stale counts in DESIGN.md, BUILD.md, two comments and the body.
- `postmortems/pr3.1d-event-payload-not-null-review.md`, finding 6: DESIGN.md said 115 condition ids, 146 witnesses and 3,066 cells where the code pins 116, 147 and 3,087.
- `postmortems/pr3.14d-plan-check-refuses-walks-review.md`, finding 3: DESIGN.md still described two deleted tests in the present tense.

No mechanism holds the class. Most of those rounds corrected their sentences by hand and recorded no rung. The round of PR3.4b made the pin's limit part of that pin's own test, which holds that one claim and no sentence elsewhere. The one option recorded for part of the class, under PR3.3d, would hold a body's registry count and arm key and nothing else. So no earlier mechanism failed here, because none was built. This round is another instance twice over: the review found stale sentences in bullets this pull request had just corrected, and the final pass then found more that the pull requests merged under it had made false. The class recurs because nothing compares a sentence with what it describes.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The deferral lint, `scripts/deferral-lint.py` | 2, syntactic: it reads the first line of an entry for DONE and the first line of a bullet for a word of deferral | BUILD.md at `832ae8e`, which held all five findings, passed it: "deferral-lint: clean". A stale sentence carries no word of deferral |
| The test that reads BUILD.md, `packages/conformance/test/tla-artifact.test.ts` | 2, syntactic: it pins the milestone heading to one occurrence and holds two phrases | The same head passed its 17 tests |
| Searching for the words of a fact before correcting it, which the fold did to find the stale reason for the saga walk | none: a person's search | The fold searched for "not sound", "orders under", "order under" and "linguistic collation". The sentence "On PostgreSQL names sort by the locale, so a range of them misses rows." states the same stale reason, and that search counts 0 matches in it |

## Fix-induced defects

None of the five came from a fix of an earlier finding in this round: the review read the first commit, and the round had no earlier fixes. All five were written by this pull request, four in its first commit and one in its body. The fold was not re-read alone. One narrow re-read covers the fold and the final pass together.

## Evidence

- Red tests: none. This round has no red test of its own: every finding is a sentence of a document or of the pull request's body, and no test reads one.
- Fixes: commit `5f6e801` for findings 1, 2, 3 and 5 in BUILD.md, and commit `c15ef06` for the part of finding 3 in DESIGN.md. Finding 4 was in the pull request's body, which no commit holds, and the body is corrected. Gate after the fixes, on the second of those commits: `pnpm lint`, the format check, the deferral, gate and review-bot lints, the test that reads BUILD.md, the registry count by import, and the base composition and base gate against its base, each exit 0.
- Finder: the one review of this pull request, run as described in the ledger. Quoted verdict: "No HIGH findings. I count one MEDIUM and eight LOW, of which two are in the PR body only and two are nits. No bullet is marked done that main does not hold, no owner is dead, and no decision is presented as the maintainer's."
- The review's evidence for finding 1, quoted: "`git grep` for the titles at pull request #75's pushed head 667258d finds nothing", while the three titles are at lines 929, 947 and 966 of `packages/sdk/test/replay-equivalence.test.ts` at a commit that is not pushed.
- Claims that did not reproduce: the review asked whether two fake executors named `MigrationExecutor` are copies of the label recorder. They answer batches themselves, as a fake does, so they are not counted among the recorders. The author's own checkpoint said the recorders are four copies in three files, and they are in four files: the bullet says four.

## Root cause

A fact a document states is compared with nothing, and it is often stated in more than one place. A pull request that corrects one sentence finds the sentence it was looking at, and the same fact in another entry or in DESIGN.md stays as it was. A later pull request that changes the code does the same to every sentence it does not read. The machinery reads a plan's structure: who owns a bullet, the word DONE, the format of a heading. None of it reads what a sentence claims.

## Mechanisms

Built in this PR:

- None. The pull request changes documents only, and each finding was corrected by hand.

Deferred (recorded in BUILD.md):

- An option under PR3.10: a test that holds each count DESIGN.md states to the constant the code pins for it, with its trigger. It would hold the counts of the class. A count in BUILD.md or in a body stays outside it, and so does every sentence that is not a count.
- The option under PR3.3d that would hold a body's registry count and arm key to the head, now with a trigger.

## What this round still would not catch

A sentence of BUILD.md or DESIGN.md that a later pull request makes false ships today unless someone reads it. This pull request's final pass found such sentences after four pull requests merged under it, and one of them was its own sentence that PR3.14b holds a claim token at `claim`, whose line PR3.3c had deleted. A pointer to evidence that is not where a reader looks, such as a branch that is not pushed, ships as well. So does a count in prose, until the option under PR3.10 is built, and every count outside DESIGN.md after that.
