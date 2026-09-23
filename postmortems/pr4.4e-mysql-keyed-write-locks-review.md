# Postmortem: PR4.4e review, MySQL keyed write locks (PR #74)

PR4.4e makes the MySQL compiler write every write keyed by a subquery one way: the keys first, the written table second, through the index of its key. A keyed delete reads its keys through a new index of a run's statement stamp, which schema version 8 adds on MySQL, and the excusal of the claim contest is deleted. The pull request's one review found no HIGH finding, one MEDIUM and seven LOW. Five of them count as findings under the rule pull requests 63 and 65 were counted under: one product defect, one hold that could not fail, and three false claims. The branch does what it says on the statements the store sends today. Every finding sits where the pull request kept a list or a sentence by hand.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst would have shipped. A MySQL database that has not reached schema version 8 answers every batch that holds a keyed delete, a claim among them, with error 1176, because the delete names an index that is not there. The executor booked that as an outage. An embedder that starts the newer build before its migration step has finished would have seen every claim fail as a store that is unavailable, its workers and drivers would have retried, and nothing in the error said to migrate. The condition is permanent until someone migrates. The two host programs migrate when they start and were safe.

Second, a delete keyed by the table it writes compiled to text the server refuses with error 1064. No statement has that shape today. The first one to have it would have failed at run time, on MySQL alone, as an outage, while DESIGN.md said the rule refused anything else.

Third, the survey of every keyed write accepted a write with no plan row for its target. No user would have seen it. The survey read as holding every keyed write and held less.

Last, two false statements: a registry reason that described a schema which no longer exists, and a latency figure that no kept log holds, given to two different measures.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A MySQL database below schema version 8 answers every batch that holds a keyed delete with error 1176, and the executor booked it as an outage (the review's point 1) | Callers retry a condition no retry repairs, and nothing says to migrate | The executor's classification of errors, held by its schema mismatch cases | The set of permanent errors is a list kept by hand, written when every index a statement named was part of version 1. No case ran a build against a schema older than its statements need | Error 1176 joins the set. A server case drops the index and claims, and one mutation drops the number (rung 3). DESIGN.md says to migrate first |
| 2 | The registry's reason for the mutant that removes the forced index described the schema before that index existed (point 2) | A reader is told a consequence that no longer happens, and what really holds the hint was unknown | The registry's self-test | It checks that a mutant is caught at its marker. A reason is prose, and nothing executes prose | The reason is rewritten from a run, and DESIGN.md records that only the compiler's text cases hold the hint (a correction, no rung) |
| 3 | DESIGN.md said the rule for a delete's keys refuses anything else. Two shapes passed the compiler and core, and one of them was sent as text the server refuses (point 3) | None today. A future delete keyed by its own table fails at run time on MySQL alone, as an outage | The compiler's refusal cases | They list shapes by hand. Nothing crossed the rule with the compiler's older rewrite of a subquery that reads the written table | That shape is refused where the statement is built (rung 2), with a case seen failing first and a mutation. DESIGN.md states what the rule refuses by itself, what core refuses ahead of it, and the false negative that remains |
| 4 | The class survey accepted a keyed write with no plan row for its target, a branch that no write takes (point 6) | None. The survey claimed more than it held | The survey itself | An allowance written inside a test is not a product line, so no registered mutant reaches it | The branch now names the write and fails (rung 3), shown failing in a scratch run |
| 5 | "258 ms beside a million" stood in a test comment for the statement and in two documents for the whole emit, and no kept log holds an emit beside a million runs (point 8) | A reader is given a number nobody can trace | None. Nothing holds a figure in prose | That evidence is measured is a rule the author keeps | The figure is removed. Each figure that remains names its measure and has a kept log (a correction, no rung) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of the pull request, a subagent running the built-in code review skill | 5 | No |
| This project's own machinery | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round on this work, pull request 64's: 0%. The round before that, pull request 63's, was 1 of 11).

The rate is not improving. Before anything was pushed this pull request's own measurements had found six defects: the two claim deadlocks on main, which its contests and lock readings found, and four of its own first build. Those are the system working and are not counted here. After the push nothing of ours found any of the five.

## Recurrence

A hold that could not fail, finding 4. Pull request 63's round had four of this class. Its mechanism was one per hold: two were deleted and the others were bounded. It named no checker for the class, and this round shows what that costs. An allowance written inside a test is invisible to the mutation probe, which mutates product lines only. The class has recurred in both rounds of the self-concurrency work. The property would be that every branch of a test that accepts something is either shown to be taken or fails. Here the branch now fails, which is the ladder moving by substitution, and the class still has no checker.

A sentence that says more than the code holds, findings 2, 3 and 5. This class has recurred in every round of this work so far. Pull request 63's postmortem names sentences of DESIGN.md and BUILD.md that said more than the code held, and pull request 64's fold corrected comments, the body and a postmortem. The mechanisms so far have been corrections, and a correction is no mechanism. Where a claim can be made executable it should be: finding 3's claim now is, for the one shape, because the refusal is code with a case. A figure and a reason cannot be, and they stay prose.

A permanent answer of the server booked as an outage, finding 1. The executor already answered one permanent condition by its number, a value too long for its column, which has a branch and a typed error of its own. The set of schema mismatch numbers is the same device, a list kept by hand, and such a list is a proxy for the property, which is that a condition no retry repairs is never answered as an outage. This round adds one more number, so it extends the proxy. The property's own form, classifying MySQL's answers by their SQLSTATE class, is recorded as an option with its trigger.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Error 1176 in the schema mismatch set, held by the server case | 3 | Another permanent answer the list lacks is still an outage. Run: the delete keyed by its own table, as the compiler wrote it before this fold, sent to MySQL 8.4 answers "StoreUnavailableError: batch(shape:own) failed (MySQL error 1064)". The new case passes beside it |
| The refusal of keys that come from the written table | 2 | A subquery nested inside the key selection passes the compiler and core and is sent. Run: a delete of `waits` whose keys are "select f.run_id from runs as f force index (runs_stamp) where f.fence_stamp = ? and exists (select t.task_id from tasks as t where t.task_id = f.task_id)" is accepted by the server with the plan f ref runs_stamp, t eq_ref PRIMARY. The nested table is read under the shared locks a DELETE takes |
| The survey fails on a write with no plan row | 3, and syntactic: the survey finds its writes by a pattern over the statement's text | A keyed write the pattern does not read is never explained. Run: the survey's own pattern against "update runs set state = ? where runs.run_id in (select f.run_id from runs as f)", spelled with backticks, reads nothing, while the compiler's spelling is read as runs.run_id. The compiler writes no qualified key today |
| The single definition of the two forced index names | 1 for a rename, because the compiler's name is the schema's | A database that lacks the index at run time because it has not migrated has no name mismatch. It is classified by the first mechanism and not prevented |
| The registry reason rewritten from a run | none, prose | Any reason passes. The registry's self-test passed for the whole life of the branch with the reason that was false |
| Figures that name their measure and have a kept log | none, prose | Any figure passes. The documents' lints passed with the figure no log holds |

## Fix-induced defects

None found, and no reviewer looked: no second review read this fold. The two behaviour changes are one condition each, each with a red test seen failing first and a registered mutation, and the unfiltered mutation audit ran on the merged head because a rule that refuses more can push a registered mutant onto the wrong path. The fixes were tested again and not reviewed again. One error of the fold's own instruments: a guard in a commit script read a count of zero as a failure and stopped a good commit. It blocked a commit and passed nothing.

## Evidence

- Red tests: commit `0aa90d3`, probe `packages/store-mysql/test/real-server.test.ts` `answers a statement that forces an index the database lacks with a schema mismatch, which no retry repairs`, run and seen failing (1 test) against `e2fac3d`: "expected StoreUnavailableError: batch(claim) failed (MySQL error 1176) to be an instance of SchemaMismatchError".
- Fixes: commit `ae6d4cb`, which turns `0aa90d3` green.
- Red tests: commit `9cf5bb3`, probe `packages/store-mysql/test/tree.test.ts` `refuses a delete whose keys come from the table it writes`, run and seen failing (1 test) against `e2fac3d`: "expected [Function] to throw an error".
- Fixes: commit `aeaf715`, which turns `9cf5bb3` green, with `c212814` for the index names, `2d2d2ca` for the survey, the comment and the registry reason, and `d3a32a6` for the documents. Gate after the fixes: the short list on the merged head, with the unfiltered mutation audit and the base gate, whose counts are in the pull request's body.
- Finder: the one review of pull request 74, a subagent running the built-in code review skill at high effort, quoted verdict: "The branch does what it says. I found no HIGH finding, one MEDIUM and seven LOW."
- Five key sources were run through the MySQL dialect alone and through a batch under core's rules, each fenced on the batch's own stamp. The dialect alone compiled all five. Through a batch core refused the second UNION ALL arm ("it holds a set operation"), FOR SHARE SKIP LOCKED ("it holds SelectQueryNode.endModifiers") and the second selected column ("gated only by a subquery that is not tied to the rows it reads or writes"). The nested subquery and the keys from the written table were sent.
- With the forced index of the stamp removed by hand and the index present, the keys were read through `runs_poll` in three arrangements (4 runs due beside no waits, 4 beside 50 parked waiters, 40 beside 200), and through `runs_stamp` with the hint. Under that mutant the 13 plan cases passed, the two MySQL claim contests passed 5 runs of 5, and two cases of the compiler's unit file failed, both comparisons of text.
- In a session with semijoin switched off the head's claim update read the written table first with type ALL and the server raised warning 3128, "Unresolved name `k`@`keys` for JOIN_PREFIX hint". Main's form of the same update read the written table with type ALL in that session too, with no warning.
- With the survey made to find no plan row for a claim's writes, the edited survey failed and named them: "claim[0] runs: no row of its own".
- Claims that did not reproduce as stated. The review said one text case is the hint's only holder: two text cases fail under the mutant, the registered one and the case that sets the compiler beside core's gating rule, so the holders are two and both are text. The review read the 258 ms figure as one number given to two measures: the author's kept logs and tool outputs hold no emit beside a million runs at all, so the figure was removed and not given to either measure. Every other claim of the review reproduced: the outage with error 1176, the syntax error 1064, the three idle arrangements, the dead branch of the survey, the names in three places, and the warning 3128.

## Root cause

Each finding is a place where the pull request kept a list or a sentence by hand, and its machinery exercises only the statements the store sends today, on a database at the newest schema version. The plan cases, the contests and the mutations hold what the compiler does to those statements. Nothing generates the deployment states a build can meet, a schema older than its statements need among them. Nothing generates the trees core's generator can hand a dialect. And nothing executes a reason or a figure. So a rule that reads one statement was claimed over a space that no test walks, and a list of errors and a list of refused shapes were each complete only for what their author had thought of.

## Mechanisms

Built in this PR:

- MySQL error 1176 is answered as a schema mismatch, held by a server case and one mutation, rung 3, in `packages/store-mysql/src/executor.ts` and `packages/store-mysql/test/real-server.test.ts`.
- A delete whose keys come from the table it writes is refused where the statement is built, rung 2, in `packages/store-mysql/src/tree.ts`, with a case and one mutation.
- The survey's accepting branch is gone: a keyed write with no plan row fails the case, rung 3, in `packages/store-mysql/test/query-plans.test.ts`.
- One definition of the two index names the compiler forces, in the schema file, rung 1 for a rename: the frozen schema hashes move in a unit test before a name can reach a server.
- DESIGN.md says to migrate first, what the rule for a delete's keys refuses by itself and what core refuses ahead of it, what holds the forced index, the limit of the dialect, and that the rule assumes the server's default optimizer switch.

Deferred (recorded in BUILD.md):

- Reading a keyed delete's keys from a table other than `runs`, or from a derived table. Acceptable because nothing sends either shape and the first statement that does fails when its batch is built in the MySQL conformance leg.
- Classifying MySQL's permanent answers by SQLSTATE class in place of a list of numbers kept by hand. Acceptable because both known numbers are in the list, and an unknown one is an outage that retries, which loses no durable state.
- A generated surface that runs every labeled batch against a database stopped at each earlier schema version and expects a typed mismatch or success, never an outage. Acceptable because version 8 is the only version a statement requires, and it has its case.

## What this round still would not catch

- A permanent MySQL answer outside the list would ship as an outage that callers retry. Error 1064 is the one shown above.
- A key selection that holds a nested subquery would ship, and the nested table would be read under shared locks, which is the shape of the second deadlock.
- A keyed write in a text shape the survey's pattern does not read would never be surveyed.
- A false reason in the registry and a figure with no log would ship, because prose stays unchecked.
- A server or a session with semijoin switched off would run every keyed write as a scan, with a warning nothing reads, as main's statements did.
- A newer build on a database that stopped below some future version a statement requires would be caught only if someone writes that version's case, because only version 8 has one.
