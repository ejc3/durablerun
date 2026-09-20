# Postmortem: the saga reads and results review (PR #66)

PR3.4b worked three findings that the saga review had recorded and not fixed: the rollback error a task result names, saga reads that walked a task's checkpoints, and who sees the rollback outcome. Its one review found no HIGH, three MEDIUM and ten LOW. The store reads were correct on all three dialects. Seven findings are counted here: a hosted route that threw on stored text, three places where a sentence or a pin said more than the code does, a guard nothing held, a premise only a comment held, and a fuzz floor that fails a correct store. All seven were found by the review and none by this project's machinery.

**This document is adversarial toward the MACHINERY and blameless toward people.** Every section below asks what would have made the defect unwritable, or caught it without a human looking.

## Severity

The worst finding is a hosted route that answers 500 for one task for good. The store's port takes any text for a rollback's error, and only the SDK always hands it JSON. This PR made the inspect route parse that text, so a saga halted by a caller that is not the SDK, with an error such as `not json`, lost its whole inspect answer, permanently, because no value of a task that ended ever changes. Main already had the same exposure for a failure reason and for a result.

The fuzz floor would have cost the most in time. A simplify fold of this PR added a count of results that named a halt, and the shard runner's zero floor took it in. Measured with a correct store, a shard of the size `verify:fuzz` runs names no halt about once in nine hundred, which is a required gate failing in about one run of thirty with nothing wrong. My own gate run was green, as thirty-four runs of thirty-five would be.

The other five would have shipped as false confidence. The milestone's exit test line said the read names the rollback that failed in a history where the branch, rightly, names none, and the branch marked the line met. The PostgreSQL pin was said in three places to refuse a name compared by order, and it could not see an ORDER BY on a name, which is the line this branch had carried for four commits and removed by hand. A guard sat on two stores where no test could see it removed. The read's limit of one rested on a premise that only a comment held. A comment said the guard spares more reads than it does.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The hosted inspect route parsed the attempt record's error with no check that it is JSON, as main already parsed a failure reason and a result | A task that holds such text, which the port accepts from a caller that is not the SDK, answers 500 for good | The hosted router suite | Every case stored JSON, as the SDK does. No case stored what the port accepts and the SDK never sends | One helper shows every stored value of the answer, decoded or as its text under a key of its own, and three cases store text that is not JSON (rung 3) |
| 2 | The milestone's exit test line said the read names the rollback that failed when a cancellation follows a failed attempt with budget left. The branch names none there, and marked the line met | The plan claimed a behaviour the code refuses, and an operator reading it expects an error the result no longer carries | None. Nothing reads the plan against the code | It is prose | None. The sentence is reworded, and the line and DESIGN.md say what an operator loses and where it still is |
| 3 | The PostgreSQL pin was said, in its comment, in BUILD.md and in the PR body, to refuse a name compared by order. It read a scan line and the index condition under it | An ORDER BY on a name passes the pin, and on a database with a linguistic collation it orders by that collation. The branch carried that line for four commits | The pin's own controls | They planted only what the pin could refuse: a read with no task bound, and a range in the index condition. Nothing planted what it claimed and could not see | The pin reads each saga statement's text for a checkpoint name ordered or compared by order, beside a table of controls that says what each check can and cannot see. It is a syntactic check (rung 3) |
| 4 | The guard on the attempt record read sat on all three stores and was held on PostgreSQL alone | On libSQL and MySQL it could be deleted with every behaviour and plan check green. There it spared no walk and cost a probe of the phase marker | The mutation registry, under the rule that a new guard gets a mutation | On those two stores the guard changes no result and no plan, so no mutant of it can be killed, and the registry cannot say that a guard has no mutation because none is possible. The omission was invisible | Deletion. The guard exists only where a test can see it removed (rung 1 for the two stores: there is nothing left to hold) |
| 5 | The read takes one row under a limit of one and no order, which rests on a run writing one attempt record at most. Only a comment said so | A later writer that let one run own two records would make each dialect name an arbitrary one, with nothing red | The saga row checker | It checked that an attempt record decodes, and not who owns it | A row invariant: no two attempt records of a task share an owning run, with a planted defect in the checker's meta test and a registered mutation (rung 3) |
| 6 | The shard runner's zero floor took in a count whose op is one pass move in ten | Measured with a correct store: a shard of the size `verify:fuzz` runs misses about once in nine hundred, so the gate fails about one run in thirty | The floor's own design: a progress floor must hold for a correct store | Nobody measured the rate. The review's estimate called the shipped sizes safe, and one green run looks the same as a safe floor | The count holds its floor from 20,000 walked steps in a shard, a size taken from three measured rates (rung 3) |
| 7 | A comment in the PostgreSQL pin said no attempt record is read for a task that anything but a rollback's failure ended | That holds for a cancellation only. A cap ends the task as failed with its saga begun, and the read runs, as this PR's own table shows | None | It is prose | None. The comment now says what the pin's four tasks show |

## Detection ledger

Every counted finding came from the one review. Its code review skill raised findings 1, 3, 4, 5 and 6, and the reviewer checked each, three of them with probes on real servers. The reviewer's own reading raised findings 2 and 7. This project's machinery found none of the seven.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: the built-in code review skill at high, each finding then checked by the reviewer, several with probes on real servers | 5 | No |
| The reviewer's own reading of the plan and the pin against the code | 2 | No |

Self-catch rate: 0 of 7, or 0% (previous round on this work, the saga review: 0 of 14, or 0%. The round before this one on main, the self-concurrency surface's: 1 of 11, or 9%).

The rate is not improving on this work. Two rounds in a row found nothing themselves. What the fold's own measurement did find is recorded under Evidence: it is about main's older floors and not about this PR.

## Recurrence

**Text stronger than what was run or read** (findings 2, 3 and 7). This class has recurred in every recent round. The saga review's postmortem ended its list of what would still ship with "any false sentence in DESIGN.md, BUILD.md, a comment, or a PR body", the round after it said no mechanism exists, and the self-concurrency round said its only mechanism is a reviewer reading. It recurred here three times in one PR. Finding 3 is the instructive one, because a mechanism did exist: the pin carried controls, under the rule that a check must be shown to say no. The controls showed two refusals and the text claimed three. A control list proves what it plants and nothing about the sentence beside it. The pin's claim now stands on a control that was run, the planted line, and the two sentences of findings 2 and 7 stand on nothing but having been read again.

**A hold that cannot fail** (finding 4). The self-concurrency round named this class and said nothing asks of a new hold that it be seen red once. It recurred, and with a twist: I knew. The PR body said the guard changes no result and that only a cost pin can hold it, and I kept it on the two stores where no pin could, for the sake of three identical fragments. The rule that a new guard gets a mutation was applied where a verdict could be written and skipped where none could, and the registry has no way to record that a guard has no mutation because none can be killed. This round deletes the instance and adds no mechanism for the class.

**A floor nobody calibrated** (finding 6). The fuzz floors exist because safety checking needs a progress floor, and their threshold, twenty walks of fifty steps, was chosen and never measured. That is a proxy, a size that feels large, standing for the property, that a correct store misses with negligible probability. The measurement made for this finding shows the proxy is wrong for main's older stats too, at the threshold size only. I can find no earlier round that measured a floor.

**A suite that stores only what the engine's own writer stores** (finding 1). The saga review met this as a dialect difference no shared case exercised: every saga case wrote a name exactly as the engine writes it, so a comparison that folds case agreed with one that does not. Here every hosted case stored a value exactly as the SDK stores it, so a parse that throws on other text agreed with one that does not. The mechanism then was a case that writes look-alike names. It was local to names, and nothing asks of a new reader what the port admits that the SDK never sends.

**A premise of a read that no checker holds** (finding 5). I can find no earlier round with this shape. Its nearest relative is the rule that every guard of the model has an executable twin, which covers the model's guards and not the premises a statement's text relies on.

## Mechanism audit — the false negative of each

Each row was written and run against the folded code, and each planted file was restored.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| One helper shows every stored value of the inspect answer, and three hosted cases store text that is not JSON | 3 | A second path in the same route: `if (searchParams.has('raw')) response.raw = parseTaskValueJson(result.failureReasonJson)`. The hosted suite passed 16 of 16. The helper is a single definition, and nothing forbids a second reader of a stored value |
| The PostgreSQL pin reads a saga statement's text for a checkpoint name ordered or compared by order. Syntactic: it matches spellings | 3 | `ORDER BY (st.owner_attempt), st.checkpoint_name LIMIT 1` planted in the shipped attempt record read. The file passed 2 of 2, because the text check stops at a closing parenthesis. `MIN(st.checkpoint_name)` is not read either |
| The PostgreSQL pin holds the guard by reading which result reads execute the attempt record scan | 3 | `(state = 'failed' OR state IN` the live set`) AND sagaBegan` planted as the guard. The file passed 2 of 2, because the pin reads no live task's result, so a walk for every read of a rolling back task is not seen. A first spelling, a list of two terminal states, was refused before any test ran, by the tree's rule that a list of states is one of the defined sets |
| The saga row checker refuses two attempt records of a task that share an owning run | 3 | Rows no suite history builds: a second attempt record of the last run, written by hand beside a halted saga. `getTaskResult` named the planted record's error and not the halt's, and no store test fails, because the checker judges only the histories the suite builds. Run over those rows it says `saga/attempt-records-share-a-run` |
| The halt count holds its floor from 20,000 walked steps in a shard | 3 | `const halts = false` planted in the walk, so no saga is ever halted. A shard of the size `verify:fuzz` runs passed, so at the pull request gate the half of the check that compares a named error is never exercised and nothing says so. A shard of the nightly's size failed with `op 'haltsNamed' never succeeded across 157 walks x 150 steps` |
| The guard is deleted on libSQL and MySQL | 1 | None can be written. There is no guard on those stores to break |

## Fix-induced defects

None of the seven was caused by a fix for another finding of this round. Two were caused by this PR's own earlier folds, before the review: the ORDER BY that finding 3 turns on arrived with the fix for the saga review's finding 10 and was removed by hand in a simplify fold, and the floor of finding 6 arrived with the fuzz check that a simplify candidate asked for. Both folds were tested and neither was reviewed as new code before the one review.

The fixes of this round changed behaviour: the route's answer gained three keys, a guard left two stores, and a floor moved. They were tested, with the gates in the PR body, and they have not been reviewed as new code.

## Evidence

- Red tests: commit `55e5361`, probe `packages/driver/test/hosted.test.ts` `answers with the text of a rollback error that is not JSON`, run and seen failing (3 tests) against `fa81612`. Each of the three new cases got 500 `internal_error` where it expected 200: a rollback error, a failure reason and a result that are not JSON.
- Fixes: commit `842d923`, which turns the three cases green. Gate after the fix: the hosted router suite, 16 of 16, the driver's typecheck, and the repository's lints.
- Red tests: commit `5288616`, probe `packages/store-postgres/test/query-plans.test.ts` `walks a saga's names among one task's rows of the key, and reads no attempt record when no saga began`, run and seen failing (1 test) against `fa81612`: "expected [] to have a length of 1", the pin returning no fault for a statement that orders attempt records by name.
- Fixes: commit `c9694d9`, which turns it green and rewords the comment of finding 7. Gate after the fix: the file, 2 of 2. With `ORDER BY st.checkpoint_name` planted in the shipped read the same file fails and names it, `[task-result] its text orders a name: ORDER BY st.checkpoint_name`.
- Red tests: none for findings 2, 4, 5, 6 and 7. Findings 2 and 7 are sentences. Finding 4 deletes a guard that no test can see removed, which is the finding. Findings 5 and 6 are LOW, and each carries its check in its own commit: the planted defect in the row checker's meta test, and the measurement below.
- Fixes: commit `412f11c` for finding 2. Commit `1da84df` for finding 4, after which the saga surface passed on three dialects, 72 of 72, and the three plan files 26 of 26. Commit `f18ce20` for finding 5. Commit `596f7f7` for finding 6. A filtered probe over every mutation whose name says saga caught all 69, the two new ones among them, before the branch's last rebase. The full gates run on the head that holds this document and are in the PR body.
- Finder: the one review of PR #66, quoted verdict: "No HIGH findings: three MEDIUM and ten LOW. The store reads are correct on all three dialects, and every red the body names reproduced by test name."
- The reviewer's probe for finding 1, with a control: a commit of this branch whose route is byte-identical to main's answered 200 with the state and the failure for a saga halted by an error of `not json`, and the head answered 500 `internal_error`. For finding 3 the reviewer planted the ORDER BY at the head and the file passed 2 of 2. For finding 4 the reviewer removed the guard on libSQL: the saga surface passed 24 of 24 and the plan file 18 of 18, and only the SQL corpus test failed.
- The measurement for finding 6, on libSQL with a correct store. A walk named a halt in 248 of 6,000 walks of 50 steps, in 386 of 3,720 walks of 100 steps, and in 341 of 2,000 walks of 150 steps. Of 300 shards of twenty walks of 50 steps, 121 named none. At 62 walks of 100 steps the measured rate gives a miss in one shard of about nine hundred, and `verify:fuzz` runs 32 shards. At the nightly's 156 walks of 150 steps it gives about two in ten trillion. At 20,000 walked steps it is under one in a billion at the rate of the 100 step walks.
- Six of the review's thirteen items are not counted. Five were fixed as small: the fuzz walk takes the store's answer for which failed rollback ended a task, its last loop reads every spawned task, the PostgreSQL plan test's cases share their helpers, `firstNamePast`'s colon check has a registered mutation, and the names cases gained an accented look-alike and a multi-byte step key. One was declined in the PR body with its reason.
- What did not reproduce. The review skill estimated a false failure of 10 to 20 percent at the floor's threshold size and called the shipped sizes safe. Measured, the threshold size misses in 40 percent of shards, and the shipped gate size is not safe: about one run in thirty. My first exhibit for the guard's pin did not run: the statement was refused when it was built, by the tree's rule about lists of states. The measurement also found something that is main's: at the threshold size six older stats stay at zero with a correct store, in 2 to 4 percent of 300 shards each. No configured run uses that size, and it is reported to the maintainer and not changed here.

## Root cause

I wrote what each check holds from what I meant it to hold, and not from a run that showed it. Three of the seven are sentences that say more than any run did. Two are holds that nobody had seen fail where they were claimed: a guard on two stores, and a floor whose miss rate was never measured. One is a premise that was never turned into a check. One is a suite that stores only what the SDK stores. No layer asks of a new claim which run showed it, no layer asks of a new floor what a correct store does at that size, and no layer asks of a new reader what the port admits that the engine's own writer never sends. The review asked all three, by planting, by removing, and by storing `not json`.

## Mechanisms

Built in this PR:

- One helper in the hosted route shows every stored value, decoded or as its text under a key of its own, with three cases that store text that is not JSON. Rung 3, in `packages/driver/src/hosted.ts` and its suite.
- The PostgreSQL pin reads each saga statement's text for a checkpoint name ordered or compared by order, beside a control table that includes the planted line and says what the plan cannot see. Rung 3 and syntactic, in `packages/store-postgres/test/query-plans.test.ts`.
- The guard on the attempt record read is deleted where nothing could hold it. Rung 1 on libSQL and MySQL. On PostgreSQL it stays under the pin and two mutations.
- The saga row checker refuses two attempt records of a task that share an owning run, behind every saga case, fault matrix cell and fuzz walk, with a planted defect and a registered mutation. Rung 3, in `packages/conformance/src/saga-rows.ts`.
- The halt count's floor starts at a measured size, and the comment beside it carries the rates. Rung 3, in `packages/conformance/test/fuzz-shard-runner.ts`.
- The fuzz walk takes the store's answer for which failed rollback ended a task, and reads the result of every task it spawned.

Deferred (recorded in BUILD.md):

- Holding a result, a failure reason and a rollback's error to JSON on the way in, at the port's entries. It would make the state of finding 1 unwritable, which is rung 1. It changes what the port accepts from a caller that is not the SDK, so it is recorded as an option under PR3.4 with its trigger, and is not built here.

## What this round still would not catch

- A second reader of a stored value that parses it without the route's helper answers 500 for text that is not JSON, and the suite passes.
- A checkpoint name ordered through a spelling the PostgreSQL pin's text check does not read, behind a parenthesis or through MIN or MAX, passes the pin. On a database with a linguistic collation it orders by that collation.
- A guard on PostgreSQL that also lets a live task's result read through costs a walk for every read of a rolling back task, and nothing sees it.
- A writer that gives one run two attempt records in a history the suite never builds. Each dialect then names an arbitrary one.
- At the pull request gate, a fuzz walk that never halts a saga. The floor that would say so starts at the nightly's size.
- A floor added to the shard runner without a measurement of what a correct store does at the size where it switches on. The older floors were never measured either.
- A guard that no test can see removed, added on a store where it spares nothing. The registry records the mutations a guard has and cannot record that it has none.
- Any false sentence in DESIGN.md, BUILD.md, a comment, or a PR body.
