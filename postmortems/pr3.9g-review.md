# Postmortem: PR3.9g tree-rule residuals review

PR3.9g closes three residuals of the SQL tree rules. PostgreSQL's `age` joins
the clock spellings, and the two lists of spellings, one in core and one in
`scripts/clock-lint.py`, become one list that the lint reads. A batch of reads
refuses a state or status column compared with a bound value wherever the
value stands, where it had read only a bare value on the right of a test. The
registry self-test holds each spelling of a list written on one line to a
mutation of its own. The pull request passed every local gate on the head that
was reviewed, the unfiltered mutation audit of 958 mutations and the base gate
among them. One review then confirmed, with probes and with main as the
control, the claims that carry the change: no shipped read and no shipped text
is refused, the clock pattern the lint derives equals main's hand-kept one
byte for byte with `age` added, and the per-entry coverage rule is the
property and not a picture of it. It also raised one MEDIUM point and six LOW
ones. Five count as findings under the rule this project counts by: a product
or tooling defect counts, a hold that could not fail counts, and a false claim
counts. None of the five touched what a store sends.

## Severity

Nothing here would have reached a user. Every one of the five is a place where
the pull request SAID something its code, its registry or its tests did not
hold, and that is why it is a SEV: a gate that says it fails closed and does
not is worth less than no gate, because it is believed.

1. `clock-lint` failed open. It wrote out the one interpolation it knew, the
   join of the list of functions, and left any other in the arm, where Python
   reads `${` as a dollar sign and literal braces, which match nothing. An arm
   written through a second interpolated list would never have reached the
   lint, and a join hoisted into a constant made the lint exit 0 on a store
   that calls `now()`. DESIGN.md, the lint's own comment and the pull
   request's body all said the lint refuses to run on a list it cannot read.
   After this pull request a new spelling is held by its mutation in the
   tree's list and nobody adds a lint input for it, so nothing would have
   shown the gap until a store called such a spelling.
2. BUILD.md said that of two shapes that passed the read rule one was now
   closed and "the other still passes". That claimed the rule complete, and
   it was not: `? = r.state`, which the builder writes, bound a state past
   it, and so did a subquery that selects a bound value.
3. Four sentences about mutations were false as worded. The body said no
   listed line sits inside a spelling block, and six do. DESIGN.md, the
   lint's comment and the body said each entry of the clock list has a
   registered mutation, and six function names have none: they are listed
   with a reason. The substance held, and a reader who trusted the words
   would have looked for mutations that do not exist.
4. One mutation's find ran onto the line below the one it changed. That line
   then counted four mutations for three conditions, the coverage check was
   satisfied, and the first operand of the line, the bare bound value, had no
   mutation at all. BUILD.md said four mutations held the predicate's
   conditions.
5. One row of a verdict case could not fail for the reason it gave. Its CASE
   bound a number in its WHEN, so the row was refused whether or not the rule
   read the values of THEN and ELSE, which is what the row was there to show.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `clock-lint` left an interpolation it could not write out in the arm, where it matches nothing | An arm added through a second interpolated list never reaches the lint, against a promise made in three places | The lint self-test | Its inputs varied the list between present and absent. None varied the SHAPE of an arm | The reader refuses an arm that still holds an interpolation (rung 2, a refusal inside the lint), held by one bad input of the self-test |
| 2 | BUILD.md claimed the read rule complete but for one shape | A reader takes `? = r.state` and a selected bind for refused, and both passed | Nothing reads a sentence against the code | A claim of completeness has no executable twin | The rule reads both sides of a test and a subquery's selections, each red first with a mutation (rung 3). DESIGN.md's list of what still passes, and of what is refused beyond the property, runs as one case (rung 3) |
| 3 | Four sentences said what the registry does not hold | A reader looks for six mutations that do not exist, and trusts a reason that was false | Nothing reads a sentence against the registry | The same | The sentences are corrected. No mechanism: see the residual |
| 4 | A find ran onto a line it left unchanged, so the line's count was met while one operand had no mutation | The coverage check was green over an unheld operand, and the plan's count was overstated | The coverage check | It counts a mutation for every line its find SPANS, and the property is the lines it CHANGES | The find quotes the one line it removes, and the operand has a mutation and a case of its own (rung 3, a point fix). Counting by change is measured and recorded as an option |
| 5 | A row of a loop was refused for a second reason, so it could not fail for the reason it gave | The row would stay green if the rule stopped reading THEN and ELSE | The mutation audit | The row is an unmarked expectation inside a loop, so no mutation owns it and the audit never ran against it | The WHEN is inline and a control beside it is admitted with every value inline (rung 3, a point fix) |

## Detection ledger

All five were found by the one review: a subagent that ran the built-in code
review skill at high effort, with the coordinator's own probes beside it. None
was found by this project's machinery, which had run in full on the reviewed
head: the unfiltered audit caught 958 of 958 mutants, both self-tests passed,
and conformance and the fuzz were green on three dialects.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The review (the built-in code review skill, with the coordinator's probes) | 5 | No |
| Red tests, the mutation audit, the lints, the fuzz, TLC | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round on main, PR4.4e's: 0 of 5. The previous round on this work, PR3.9f part 2's: 0 of 4).

The rate has been zero in every round since PR4.4c's 1 of 11, and the template
is right about what that means: the mechanisms being added are not the ones
that matter. What the machinery did catch in this pull request, before the
review, is worth setting beside that number without counting it. The cases
written for the per-entry coverage rule found a defect in that rule's first
draft before it was committed: an arm whose group a mutant leaves with one
alternative was read as an arm with no group. The simplify pass, which is a
review and not machinery, found that the read rule spelled out shapes where
its sibling walks a subtree, so `state = cast(? as text)` passed. Neither
changes the ledger: every defect that survived to the review was a statement
that nothing compares with the thing it states, and the machinery here
compares code with code.

## Recurrence

**A sentence that says what the code does not do** (findings 1 in its claim, 2
and 3, and the count in finding 4). This class has recurred in every round of
the PR3.9 work. The residual sections of PR3.9e parts 3a, 3b and 3c and of
both parts of PR3.9f each end by saying that a sentence in BUILD.md or
DESIGN.md that is false would ship, because nothing reads prose against the
code. No mechanism was ever instituted against it, because none is known that
reads prose, and each round answered it with corrected sentences, which is no
mechanism. This round takes one narrow step that is one: the passage of
DESIGN.md that names what the read rule refuses beyond its property, and what
it lets pass, is run shape by shape as a case. I had written that passage from
the review's report without running it. The case passed on its first run, and
the passage can no longer drift in silence. It holds five named shapes and
nothing else.

**A hold that could not fail** (findings 4 and 5). PR3.9f part 1 met it as a
verdict test that failed ahead of its own marker, PR4.4c as a hold that could
not fail, and the mechanism against it is the mutation audit, which holds a
MARKED expectation to failing under its registered mutant. It did not reach
either finding, and saying why is the point. Finding 5's row is unmarked and
stands in a loop, so no mutation owns it. Finding 4 is not an expectation at
all: it is the coverage check's count, which the audit does not run against.
That check counts the mutations whose find spans a line. What it is supposed
to count is the mutations that change the line. A span is a picture of a
change, and one find that ran a few characters onto the next line satisfied
it.

**A reader that fails open on a shape nobody fed it** (finding 1). PR3.9f
part 2 narrowed two lints to a shape, and the narrowing passed every small
fixture because no fixture had the shape it lost. The mechanism instituted
then plants text in every real store file. It could not reach this finding:
the lint's new input is the SHAPE of a source file of core, and the self-test
varied that input between present and absent only.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The lint refuses an arm that still holds an interpolation | 2, syntactic: it reads the text for `${` | The list is one text read by two regular expression dialects. The arm ``String.raw`\btick\Z\(` `` compiles in both. JavaScript reads `\Z` as the letter Z, so the tree refuses a fragment that calls `tickZ()`. Python reads it as the end of the text, so the lint exits 0 on a store that calls `tickZ()`. Written and run: the lint answered "database time confined to NOW_MS", and the same arm tested in JavaScript against the same SQL matched |
| The read rule reads both sides of a test and a subquery's selections | 3, and syntactic: it reads names and node shapes where the property is whether a partial index can match | `CASE r.state WHEN ? THEN 1 END = 1`, a subquery that selects the state compared with a bound value, and `r.state = ?` written whole inside a fragment. Each binds a state beside a test and each answers null. Written and run as the committed case "refuses more than its property and reads less, in the shapes DESIGN.md names" |
| The find quotes one whole line, and the bare-value operand has a mutation | 3, a point fix | The coverage check still counts by span. Read by import from the merged registry's predecessor: seven condition lines of `sql-tree.ts` are spanned today by a find that leaves them unchanged, all of them main's, and the next find that runs onto a condition line will satisfy the count the same way |
| The CASE row's WHEN is inline, with a control | 3, a point fix | `r.state = CASE WHEN r.state = ? THEN 'a' ELSE 'b' END`. The row is refused by the test inside its WHEN. Written and run in a scratch copy: refused as the code stands, and still refused with the walk below an operand removed by hand, while the committed case fails under that same mutant. An unmarked row of a loop is held by no mutation, so a second such row would pass again |
| DESIGN.md's named shapes run as a case | 3 | The case does not read the document. A sixth shape added to the passage as a sentence, true or false, passes every gate: nothing ties a sentence to a row of the case |

## Fix-induced defects

None of the five was caused by a fix for another of the five. Two of the five
were caused by an earlier fold in the same pull request: the fold of the
simplify pass, which ran before the review. The find that ran onto the next
line came with the rewrite of the read rule into one predicate, and the CASE
row came with the case that was committed failing for that rewrite. Both were
tested when they were written, and the audit ran over them, and neither was
read by a reviewer until this round. The fold of this review was re-tested
and not re-reviewed: each of its two rule changes is one condition with a
failing case first and one mutation, every shipped read was run against each,
and the unfiltered audit ran on the merged head.

## Evidence

- Red test: commit `d464399`, one bad input of the lint self-test, run in full and seen failing (1 input, by name, and no other): "clock-lint.py ACCEPTED a bad input", the input whose list holds an arm written through a second interpolated list, beside a store that calls a name only that arm would spell. Fix: commit `c70cf0d`, which turns `d464399` green: the self-test exits 0 with 288 bad inputs, and the same line stops a join hoisted into a constant.
- Red test: commit `6bc536b`, probe `packages/core/test/sql-tree-verdicts.test.ts` `is refused with the bound value on the left of the test`, run and seen failing (1 test), answering null where a refusal was expected. Fix: commit `03be898`, which turns `6bc536b` green and reads a test from both sides.
- Red test: commit `f1b6932`, probe `packages/core/test/sql-tree-verdicts.test.ts` `is refused when a subquery on the right selects a bound value`, run and seen failing (1 test), answering null. Fix: commit `99ff7f8`, which turns `f1b6932` green, reads a subquery's selections, and makes the find of finding 4 quote the one line it removes.
- Fixes with no red test of their own, because each corrects a statement and not a behaviour: commit `853efaf` registers the mutation of the bare bound value with a case that owns it, and makes the CASE row's WHEN inline with a control beside it (findings 4 and 5). Commit `5ab72d6` corrects the lint's comment (finding 3). Commit `ebc7d1c` corrects DESIGN.md and BUILD.md (findings 1, 2, 3 and 4). Commit `ed3246c` runs DESIGN.md's named shapes as a case.
- Gate after the fixes, on the head that holds main's tip by a merge: the short list from one driver, every one of 28 gate lines at exit 0 on `4940183`: typecheck, lint and the format check, the ten source checkers, core at 630 tests in 24 files, the SDK, the three stores' suites and the corpus with the text statements test on three dialects with no corpus file changed, the registry at 1007 by import, both long self-tests (288 bad inputs of the lints' own), the UNFILTERED mutation audit (1007 caught by their own verdicts alone), and the base gate against main by commit id with the arm live. The full list, conformance on three dialects and the fuzz among it, ran before the review on the head that was reviewed.
- Finder: the pull request's one review, a subagent running the built-in code review skill at high effort with the coordinator's probes beside it, quoted verdict: "no HIGH, one MEDIUM, six LOW, and one LOW item the author already dispositioned. No shipped read is refused and no shipped text is refused by the `age` entry."
- The review's own words for finding 1: "The reader substitutes only the exact text `${CLOCK_FUNCTIONS.join('|')}`. Any other `${...}` survives and Python compiles it as `$` followed by literal braces, which matches nothing." For finding 4: "The find of `tree-read-state-stops-at-a-subquery` runs onto the return line and leaves it unchanged. That line's count reads four mutations for three conditions." For finding 5: "Its WHEN binds `1`, so the row is refused whether or not the rule reads THEN values."
- Claims that did not reproduce. The skill reported that the registry self-test exited nonzero under its own harness. The reviewer ran it detached in a clean scratch worktree: exit 0 on the reviewed head. The skill's first item said the branch did not hold main's tip, which was the coordinator's order at the time and no finding. One instrument of the reviewer lied and was caught: a pathspec matched nothing in `git grep`, three scans came back empty, and they were redone with a glob pathspec and a positive control. One sentence of my own was measured and not only believed: the message of `03be898` says that without the first side of the two-sided test every case that writes the column first fails. Dropped by hand, seven cases fail, the seven that expect a refusal.
- Three points of the review are not counted, and the coordinator agreed. The stop at a subquery was stated in DESIGN.md and held by a control, so its behaviour matched its contract, and widening it is a correction of design. The rule's refusal of two shapes beyond its property fails closed on shapes no read ships, and is documented and run. The sentence about `age` on a refusal that spelled another clock was dispositioned before the review.

## Root cause

Each of the five is a statement that no machine compares with the thing it
states: a promise in a comment and a design document, a sentence of
completeness in a plan, four sentences about a registry, the number a counter
reports for a line, and the reason a test row gives for itself. The gates of
this repository compare code with code, and they did that fully: every
registered mutant was caught on the reviewed head. They compare nothing that
is SAID about the code with the code. A pull request whose work is to tighten
what rules refuse produces many such statements, because every rule comes
with a sentence about what it holds and what it lets pass, and this one wrote
them faster than it ran them. Where a statement was cheap to make executable
it now is: the lint's promise is a refusal with an input, and the passage of
DESIGN.md is a case. Where it was not, the sentence was corrected, and that
is the part of this round that will recur.

## Mechanisms

Built in this PR:

- `clock-lint` refuses an arm that still holds an interpolation after the one it knows is written out. Rung 2: a refusal inside the lint, in `scripts/clock-lint.py`, held by one bad input of `scripts/lint-selftest.py`.
- The read rule reads a test from both sides and reads a subquery's selections. The rule is a build-time refusal, and each change is a case committed failing and one registered mutation. Rung 3, in `packages/core/src/sql-tree.ts` and `packages/core/test/sql-tree-verdicts.test.ts`.
- The bare bound value, the one operand of the predicate that had no mutation, has one, with a case that owns it, and no find of this pull request runs onto a line it leaves unchanged. Rung 3, a point fix.
- The CASE row can fail for the reason it gives, and a control beside it shows a CASE with every value inline is admitted. Rung 3, a point fix.
- DESIGN.md's passage on what the read rule refuses beyond its property, and on what passes it, is run shape by shape as one case. Rung 3.

Deferred (recorded in BUILD.md):

- Counting a mutation only for the lines it changes, which is the property the coverage check's span stands in for. It is measured and not built, because it is not contained: read by import, six lines of main's `sql-tree.ts` pass by span and would be short by change, and each needs a mutation of its own or a measured reason. BUILD.md records it under PR3.9 as an option that is not scheduled, with the six lines.

## What this round still would not catch

A sentence in BUILD.md, DESIGN.md, a comment or a pull request's body that
says what the code does not do would ship today, unless it happens to be one
of the five shapes the new case runs. This is the residual of every round of
this work, and this round did not close it.

An arm of the clock list that JavaScript and Python both compile and read
differently would reach the tree and miss the lint, as `\Z` does.

A find that runs onto a condition line and leaves it unchanged would satisfy
the coverage check's count for that line, as seven of main's do today.

A row of a loop in a verdict case that is refused for a second reason would
stay green if the rule stopped doing what the row is there to show, because
an unmarked row is owned by no mutation.

A state compared with a bound value through a simple CASE with a bound WHEN,
through a subquery that selects the state, or inside the text of a fragment
would pass the read rule, as DESIGN.md says and the case shows. So would any
shape nobody has named.
