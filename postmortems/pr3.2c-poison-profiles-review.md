# Postmortem: PR3.2c poison target profiles review

PR3.2c gives the poison matrix five target profiles for the labels that name their target, a control for each, five registered mutations, and a successor-carry case generated from every statement of the SQL corpus that inserts a run. Its one review found no product defect and nothing that made a new cell vacuous. It reproduced the measurement the design rests on, saw the named cells fail under each guard removed on three dialects, and saw every control fail under three kinds of break. It found one sentence in the spec that is false as a universal, three branches of the matrix's own seed check that nothing held, and two claims about the new test machinery that said more than is true. All are folded. Four are counted here.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

No engine behaviour was wrong and none would have shipped wrong. What would have shipped is a test surface that says more about itself than it holds, which is the defect this repository's reviews find most often, and the worst of it first:

1. Three of the four refusals that the profiles added to the matrix's seed check could be deleted with every test green. That check is what refuses a targeted case whose seed no longer stands as its profile says. Without it such a case runs green against a target its label refuses for another reason, and holds nothing. No cell was vacuous on the reviewed head, because the controls catch a break of a whole profile, so the exposure was a later change to a seed going unnoticed.
2. DESIGN.md, BUILD.md and the pull request body said an ambient cell cannot hold a guard however its poison is seeded. Five ambient cells do hold the failure batch's accounting guard, and the same BUILD.md entry recorded them failing. A reader who trusted the sentence would discount cells that hold something, or conclude that no ambient cell is worth keeping honest.
3. A comment and the body said every store batch is watched by the successor-carry cases. Only a scenario's batches are. With the revival's run insert unrecognised in a scratch corpus, that label's generated case disappeared and the other five passed.
4. A comment said an arm that scans for its target shows its control in the cell itself. Its cell shows the call acting on the healthy trigger, and not on the profile.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The spec, the plan and the body said an ambient cell cannot hold a guard however its poison is seeded | A false universal in the contract document. Five ambient cells of `fail` and `fail-rollback` hold the failure batch's accounting guard, and the plan's own entry recorded them failing | The author's own measurements, which held the counter-example | The measurement behind the sentence was taken on the claim receipt's admission alone, and the sentence generalised past it. The run that contradicted it was made for another part of the work, as a baseline, and was recorded without being read against the sentence. Nothing checks a sentence against a measurement | None on the ladder. The sentence now states the condition, an ambient cell holds a guard only where the unguarded write leaves something its oracle objects to, with both measurements beside it |
| 2 | Three of the four refusals added to the matrix's seed check were held by no test | A seed that stopped standing as its profile says could have run green against a target the label refuses for another reason | The oracle meta tests, which attack the matrix's own oracle | They are written one refusal at a time, and one was written for four new refusals. The mutation audit sees only registered mutations, and none names a branch of this check. Nothing enumerates the branches of a test-side checker | Three meta tests, eight writes, each requiring the check's own sentence, each seen failing by name with its refusal deleted or its condition weakened (rung 3) |
| 3 | The executor's comment and the body said every store batch is watched, so a run inserted by a statement the corpus does not hold fails | True only for a batch some scenario sends. A label whose run insert the corpus stopped recognising lost its generated case and failed nothing | The generated successor-carry cases themselves | They take their labels from the corpus, so a label missing from the corpus is a case that does not exist, and a case that does not exist cannot fail | A case that holds the labels the scenarios drive to the labels the corpus gives a run insert, seen failing by name on that scratch corpus (rung 3). The comment, the spec and the plan now say the cases are closed only together with the corpus test |
| 4 | A comment said an arm that scans shows its control in the cell itself | It claimed a control that does not exist. A scanning cell shows the call acting on the healthy trigger, not on the profile | Nothing reads a comment | The sentence was written beside the new controls to explain why only some arms got one, and was never measured | None on the ladder. The comment now says such an arm has no control, and the plan records a control for the four scanning profiles as an option with its trigger |

## Detection ledger

Every counted finding was found by the outside reviewer, by reading and by deleting code in a scratch copy. This project's own machinery found none of the four.

Before the review, the author's own probes did find what shaped the change, and those are not counted because nothing of them reached the review: that the ambient oracle cannot hold the receipt's guards (292 of 292 cells green with three guards removed), which moved the profiles into the targeted cells; that the first carry executor judged a run after its scenario had gone on to change it; and that a local gate declared a collation provider the local server does not have.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The outside reviewer, reading the spec against the plan's own record | 1 | No |
| The outside reviewer's skill run, then deleting the three refusals in scratch | 1 | No |
| The outside reviewer, with a scratch corpus | 1 | No |
| The outside reviewer, reading a comment | 1 | No |

Self-catch rate: 0 of 4, or 0% (previous round on main, PR3.1c's: 0 of 5. The round before it on a conformance surface, PR4.5b's: 0 of 6).

The rate has not moved in three rounds on this surface. The mechanisms those rounds added were instances, a test for the hold that was found unheld, and this round adds more of the same kind.

## Recurrence

**A hold that cannot fail.** Finding 2 is this class, and it recurred. PR4.4c's round counted it, PR4.5b's round counted it, and PR3.1c's round counted three holds that could not fail. Each round answered with the test that was missing. None instituted a mechanism against the class, because the class is "a branch of test-side code that no test requires", and the one mechanism this repository has for "can this fail" is the mutation audit, which reads registered mutations and nothing else. A branch of a checker that nobody registers is invisible to it. That is why it recurs: the audit is a list of the holds somebody thought to attack, not a property of the checkers.

**A claim that says more than is held.** Findings 1, 3 and 4 are this class, and it recurred. PR3.1c's round counted two sentences that said more than was held, and PR2.5b's and PR3.3b's rounds counted the same. Nothing mechanical reads prose against code, so each round's answer was a corrected sentence. The part of the class that can be mechanised is the claim about a test surface: a sentence of the form "this surface holds that guard" is true exactly when removing the guard fails the surface, which is a registered mutation. Finding 1's counter-example, the five ambient cells, is such a claim with no mutation behind it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Three meta tests that require the seed check's refusals | 3 | A fifth refusal added to the check with no meta test passes every gate, because nothing enumerates the refusals. Written and run in the review's own way: with a refusal's `errors.push` deleted, only the test that names that sentence fails, so a sentence no test names fails nothing. The tests are instances, not the property. A registered mutation for each refusal would keep these tests honest and would not see a new refusal either, because a mutation is registered for a branch someone already knows about. What would see it is an enumeration of the check's refusals held against the meta tests, which the plan records as an option with its trigger, the next refusal added |
| The case that holds the scenarios' labels to the corpus's labels | 3 | A label that no scenario drives and that the corpus gives no run insert is outside both lists, so a run inserted there by a statement built as text, which the corpus never records, fails nothing in these cases. Not run: the stores build every run insert as a tree today, and the list of statements that stay text holds none that inserts a run |
| The corrected spec sentence on what an ambient cell holds | none | A sentence is held by nothing. The five ambient cells it cites could stop failing under the accounting guard's removal and the sentence would stand unchanged, because no registered mutation removes that guard from the failure batch alone |
| The corrected comment on the scanning arms | none | A comment is held by nothing |

## Fix-induced defects

None were found. The fold was not reviewed again: it is documents, meta tests, one generated case and comments, and the coordinator planned no second review. Its own checks found two unheld directions in the first version of the new meta tests, a deadline that cannot be read and a stray phase marker, while the false negatives above were being written, and a further commit holds both.

## Evidence

- Red tests: none of its own. No counted finding is a product defect, so no test could be committed failing against buggy code. Each new test was instead seen failing by name in a scratch copy with the code it holds removed: each of the three meta tests with its refusal's `errors.push` deleted (one red of 14 each), the lease test and the saga test again with their condition weakened in the direction a later commit added, and the label case over a corpus that no longer recognises the revival's run insert (the `retry-task` case gone, the other five green, the new case red).
- Fixes: commit `0863f15` holds the three refusals with meta tests, and commit `eb800fb` adds the two directions the first version left unheld. Commit `15f2f88` adds the case that holds the scenarios' labels to the corpus and corrects the executor's comment. Commit `97def44` corrects the spec and the plan. Commit `7f5fa59` corrects the two comments. Gate after the fixes: the short list on the fold's head, with the unfiltered mutation audit catching 977 of 977 exact-only and the base gate green, and the same list again on the merged head.
- Finder: the one review of this pull request, a Fable subagent that ran the built-in code review skill and then answered seven questions by experiment, quoted verdict: "The branch does what it says. I found nothing HIGH: one MEDIUM (a false sentence in the spec and the PR body) and four LOW."
- What the review reproduced, so that an outside reader can audit the round: with the ambient `activate` and `defer-launch` cells seeded over an unactivated claim, all 292 stayed green with nothing removed and with the relaunch bound, the accounting guard or the sole-live-run guard removed; with the failure batch's accounting guard removed, five ambient cells of `fail` and `fail-rollback` went red by name, which is the counter-example to the false universal; with the three refusals deleted, the oracle meta test stayed 69 of 69 green and the 53 cells of the new profiles stayed green.
- Claims that did NOT reproduce as stated, and the probe that settled each. The review filed the scanning-arm sentence under notes older than this branch. The missing control is older, but the sentence was added by this branch, so it is counted here as finding 4. The review said that for 14 of the 48 new cells no control can show the call acting. Read from the target cases, companions move the seed in 16. The review's 14 are the ones whose companions make sense only beside the corrupt value, and the other two, the lower bounds of the revival's budget and of a run's ordinal, are a valid failed task on their own, so a control over them is possible and is recorded as not built. The review's note that the call changes the poison's rows in none of the 438 ambient cells of three labels was run again from the source and holds: 438 ran, 0 changed.

## Root cause

The work added checkers and sentences faster than it added ways for them to fail. Every new cell was shown failing, by eleven guards removed by hand, because the brief asked that of cells. Nothing asked it of the code that checks the cells' own seeds, or of the sentences that say what the cells hold, so those were written once and believed. The measurement that contradicted the false universal was in hand and recorded, in a paragraph written for another purpose. A number is read against the claim it was taken for, and not against the other claims in the same document.

## Mechanisms

Built in this PR:

- Three meta tests over the seed check's refusals, eight writes, each requiring the check's own sentence (rung 3, `packages/conformance/test/poison-oracle-meta.test.ts`).
- A generated-surface closure case: the labels the carry scenarios drive must be the labels the corpus gives a run insert (rung 3, `packages/conformance/src/suite.ts`).

Deferred (recorded in BUILD.md):

- An enumeration of the seed check's refusals held against the meta tests, with the next refusal added as its trigger. It is the one mechanism this round names against the class of finding 2, and it is not built because it is its own small change and nothing is unheld today.
- A control for the four scanning profiles, controls over companions, and the ambient cells of three labels seeded where the label acts, each as an option with its trigger. None holds a guard that is unheld today.

## What this round still would not catch

- A refusal added to the matrix's seed check with no meta test would ship with every gate green.
- A sentence in the spec about what a test surface holds would ship false whenever no registered mutation stands behind it. The five ambient cells that hold the failure batch's accounting guard are such a sentence today.
- A run inserted by a statement built as text, under a label no carry scenario drives, would carry nothing unnoticed.
