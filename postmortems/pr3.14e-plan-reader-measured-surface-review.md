# Postmortem: PR3.14e plan reader measured surface review

PR3.14e held the libSQL plan reader, which judges the text of EXPLAIN QUERY PLAN, to a measurement that reads no plan text: every statement the store ships is run beside a backlog of four and of sixteen copies of every row, and the reader must refuse what did more work. One review ran on the branch. It found no defect in a shipped statement and no high finding. It found three defects in the new surface, all of them holds that could not fail: an entity column the reader trusts and the backlog frees by assumption, a reader defect the surface cannot reach, and a claim that a group of statements was measured when their tables were empty. Three findings count, and four more items were fixed or recorded without counting.

## Severity

Without the review the surface would have shipped claiming to hold the reader against what shipped, while it could not see a leg of a multi-index OR read with none of the loops that drive it, and while four statements and every DELETE on an empty table measured nothing. The worst finding is the first: the reader and the backlog both assume that one claim token holds at most its limit of runs, so a seek by a claim token can never read as growing, and the two lists of entity columns that carry the assumption were not compared. No shipped statement is misjudged and no behaviour a user of the store sees changes. The harm is to what the surface promises the next change to the reader: coverage it did not have.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The reader's list of entity columns and the backlog's list of identifying columns were two lists with no check that they agree. Removing `claimed_by` from the backlog's list kept every surface test green, and the rule behind it, one token holds at most one claim's limit of runs, is assumed on both sides and measured on neither. | A change that let a claim hold more runs than its limit would read as keyed on the reader's side and as flat on the backlog's side, so the one check built to disagree with the reader agreed with it. | A test that compares the two lists. | The surface compares verdicts over statements, and a column both sides trust changes no verdict. | The two lists are held to each other with the one named difference, `key`, which is the row of a table that is not copied (rung 2, a check of a shared declaration). The rule itself stays an assumption, recorded in DESIGN.md and BUILD.md with a trigger. |
| 2 | Reading a leg of a multi-index OR with no drivers passed all 35 tests. No shipped plan has a leg under a driver, so the surface never asks the reader about one, and no hand case did either. | A due range in a leg of an OR that runs once for each row of a keyed step would not be refused. | A hand case of the shape the surface cannot reach. | The surface reaches only the plan shapes the shipped statements and their index variations produce, and it names the kinds it does not reach without holding any of them. | A hand plan of the shape in the plan test file, red under the bent reader (rung 3, a hand case). |
| 3 | Four statements, the driver heartbeat and three spawn statements, and eighteen DELETE variations on `waits` ran beside a table with no row, so their probes cost nothing and could not grow. The records said the refused variations that did not grow were "33", which counted them as examined. | The claim that every write without its WHERE was measured was false for the writes on `waits`, and 18 of the 33 unexamined refusals were these. | A floor that every variation without a WHERE grew. | The floors asked for one growing variation of each kind and not for each variation. | Each snapshot's empty tables get one row, every write without a WHERE must grow, and the driver heartbeat, whose trigger's walk of `drivers` then shows, is held apart in both directions (rung 3, a generated check with a floor). |

Four smaller items were fixed at their cost, and none counts. A seek through an automatic index treated as keyed passed for the same reason as finding 2 (declared as unreached, now held by a hand case). The bind count of a write without its WHERE assumed no bind after the clause and none in a literal, and the test now asserts both for every shipped write. The three writes skipped for a constraint were excused by kind, and the test now names them. A comment-first spelling was required to be refused and not to be refused for the right reason, and the test now asserts the fault text. Two notes that did not reproduce were checked. The marker column of a table may be NULL in principle, and the builder now refuses a table whose marker column could be. The spellings are read on a snapshot without the backlog, which changes no plan because the database holds no statistics.

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The review: the built-in code review at medium effort, with about twenty mutations of its own on libSQL, each reproduced | 3 | No |
| This change's machinery: the surface, its floors, the plan test file, the mutation probe and audit, the base gate | 0 | Yes |

Self-catch rate: 0 of 3, or 0% (previous round, PR3.14d's reviews of the same reader: 0 of 5).

The machinery did catch defects that are not findings by this project's rule. The author's own six reader bugs were each caught by name before the review, a table that took fewer copies than it should is refused by a count, and a run of the surface on the base of the branch showed the two deleted tests were red under the same bugs. None of that bears on the three findings, which are three places where the surface promised what it did not hold.

## Recurrence

The class is a hand-written reader whose checked property is what its author had seen. Every finding of PR3.14c's and PR3.14d's reviews against the plan reader was a plan shape or a statement spelling the reader read wrongly, and this round's findings 1 and 2 are the same class one level up: the surface was built to end it, and it is itself bounded by what its author had seen. The mechanism PR3.14e built for the class, a measurement that reads no plan text, is the property for every statement that runs, and it is a proxy for the reader's whole reading. It holds a shape only when a shipped statement or one of its variations produces that shape. So the class recurred in the way a mechanism against a property that is not fully enumerable recurs: the measurement moved the boundary from "shapes the author had seen" to "shapes the store and three variations produce", and the residual is the difference. It has recurred in every round so far on this reader, PR3.14c's, PR3.14d's and this one, and this round says so in those words.

Finding 3 is the second class, a claim in the records that no check holds, which recurred in PR3.14c and PR3.14d as well. The surface built here holds the sentence it was written to justify, that every write without its WHERE was measured, as a test.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The measured surface over shipped statements and three variations | 2 | Reading a leg of a multi-index OR with no drivers, which changes one argument of `loopsOf` in `plan-nests.ts`, passed all 35 tests at the reviewed head. Treating a seek through an automatic index as keyed passed too. Both were run by the reviewer, and are now held by a hand case that fails for each, seen failing by name. |
| The agreement of the two lists of columns | 2 (syntactic) | It compares names. A column both lists hold, with a rule about it that is false, passes: `claimed_by` on a database whose claim can hold more runs than its limit. The rule is assumed and recorded, and not measured. |
| The seeding of empty tables | 3 | It gives each empty table one row of a value its type allows, so a statement whose probe needs a row of a particular value, as a state a check accepts and the seed does not choose, still runs beside rows that do not match it. The floor that every write without a WHERE grew cannot see a select that reads nothing there. |
| The floor of plan-line kinds | 3 (syntactic) | It reads each kind by the start of the line. A kind named by one of its regular expressions that a plan prints another way is reported as unreached and held nowhere. |

## Fix-induced defects

None of the three findings was introduced by a fix. One fix changed a measurement: seeding the empty tables made the driver heartbeat grow, which is a true observation of a walk inside a trigger that DESIGN.md already recorded as unseen by the reader. It is held apart and asserted in every variation, and it was reviewed as new code by the author's own run of the six reader bugs, not by a second review. This fold has not been reviewed.

## Evidence

- Red tests, for finding 1: none of its own, and this line cites no commit. The agreement test passes on the reviewed head, which held the two lists in agreement by construction, and it was seen failing by name, `names every entity column of the reader among the columns the backlog makes fresh`, with `claimed_by` deleted from the backlog's list.
- Fixes, for finding 1: commit `3264ad5`, which adds the agreement test, and commit `8f8ada0`, which records the assumption of `claimed_by` in DESIGN.md and BUILD.md. Gate after fix: the surface passed 10 of 10.
- Red tests, for finding 2: none of its own, and this line cites no commit. The hand case passes on the reviewed head, which read the leg correctly, and it was seen failing by name, `judges a leg of a multi-index OR against the loops that drive it, and an automatic index as a walk`, with the leg read against no drivers, and again with an automatic index read as keyed.
- Fixes, for finding 2: commit `c02be50`, which adds the hand case. Gate after fix: the plan test file passed 29 of 29.
- Red tests, for finding 3: none of its own, and this line cites no commit. It is a claim, and the floor that every write without its WHERE grew was seen failing by name, `reaches every kind of statement with a variation that grows, so no kind is judged by silence`, together with `sees the walk inside the driver heartbeat that no plan of it shows, in every variation`, with the seeding turned off.
- Fixes, for finding 3: commit `3264ad5`, which seeds the empty tables and adds the floors, and commit `8f8ada0`, which corrects the figures in BUILD.md and DESIGN.md. Gate after fix: the surface passed 10 of 10, with all 79 writes without a WHERE growing.
- Finder: the review, quoted verdict, as relayed with its ruling: "NO HIGH, ONE MEDIUM, SIX LOW."
- Claims that did not reproduce, and what settled each. A marker column that is NULL never copying its rows: no table of the schema has one, since each marker column is a NOT NULL primary key, and the builder now refuses one. The spellings read on a snapshot with no backlog: a plan changes with statistics and the database holds none.

## Root cause

Every finding has one cause: the surface was built to hold the reader, and its own holds were written and not tried against a bent reader or a bent backlog. The floors asked for one growing case of each kind, and not for each case, and the two lists of columns were compared by nobody. The review tried each hold by bending the code under it, which the author's own six bent readers had done for the reader and not for the surface.

## Mechanisms

Built in this PR:

- The agreement of the reader's and the backlog's lists of columns, with the one named difference (rung 2, `packages/store-libsql/test/plan-reader-surface.test.ts`).
- A hand case for a leg of a multi-index OR against its drivers and one for an automatic index (rung 3, `packages/store-libsql/test/query-plans.test.ts`).
- The seeding of empty tables, the floor that every write without a WHERE grew, and the driver heartbeat held apart in both directions (rung 3, the same file and `plan-oracle.ts`).
- Assertions of the surface's own assumptions: no bind after a WHERE clause and none in a literal, exactly three writes skipped for a constraint, and the fault text of a comment-first spelling (rung 3).

Deferred (recorded in BUILD.md):

- A measurement of the claim rule, that one token holds at most its limit of runs, with a claim that can hold more as its trigger.
- A synthetic surface for the plan-line kinds no shipped statement produces, with a shipped statement that reaches one, or the next finding against the reader in one, as its trigger.

## What this round still would not catch

A defect of each of these shapes would ship today. A plan shape that no shipped statement or variation produces, held only where a hand case exists, so a reader bug in a kind the hand cases do not name passes. A claim token that holds more runs than its limit. A statement whose probe needs a row of a value the seed does not choose. A refused variation that did not grow, of which there are 26, because a probe that ran for no row costs nothing. And a sentence in the records that no check reads, which recurred in every round so far.
