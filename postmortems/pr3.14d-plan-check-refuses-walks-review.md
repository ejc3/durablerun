# Postmortem: PR3.14d plan check refuses walks review

PR3.14d gave the libSQL plan check, which plans every statement the store ships, a clause that refuses a step that walks a table in any statement, and deleted two older tests that planned every UPDATE and DELETE, because the clause refuses the walks those tests were written against. Two review rounds ran on the branch. The first found three claims in the durable records false or incomplete, and one of them hid two holds that deleting the first older test lost: an UPDATE or a DELETE with no step over the table it writes, and a due range over that table. Its fold moved both holds into the reader and corrected the records. The second round found two more false claims in the records, both written or left by the first fold, and nine LOW items. No shipped statement was refused or passed wrongly at any head: all 129 read as no fault throughout. Five findings count, all of them claims.

## Severity

Without the reviews the plan check would have shipped claiming to hold every write the deleted tests held, while a DELETE with no WHERE and an UPDATE that reaches its table by a due range passed it silently. Its records, DESIGN.md, exit test line 26 and the pull request body, would have stated holds that no test makes: that a due range over a written table is refused wherever it stands, and that the deleted tests lost only a write by another entity's key. A registered mutation's comment would have said it passes every older test of the file while one older test failed with it, and DESIGN.md would have described the two deleted tests as if they still ran. No statement the store ships has any of these shapes, so no behaviour a user of the store sees changes. The harm is to the check and to what its records promise the next change, and the worst finding is the first: a hold lost under a sentence that said it stayed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Deleting the first older test over writes lost two holds. A DELETE with no WHERE plans as no rows and read as no fault, and an UPDATE that reaches its table by a due range read as a due range that stands alone. The first `gate-changes:` line and the documents said that test's property stays held. | A write of every row of a table, or of everything due in a queue, would pass the plan check. | A run of the deleted test's own code against the new reader over a set of writes, before the test was deleted. | The substitution was argued from what the test was written against, walks, and its code was never run against the reader. | Two lines of the reader over a write, properties of the plan with no list, red first (rung 2, the generated check over every shipped statement). |
| 2 | The second registered mutation was said, in its comment, in exit test line 26 and in BUILD.md's entry, to pass every older test of the plan file. With it in place on the base's reader, the older pin over the batches a saga touches failed. | The mutation offered as a gap that only the clause closes did not show one, and three records overstated the evidence. | The mutation probe, run over the whole plan test file at the base for each new mutation. | The probe runs only the registered owner's title, so a failure of another test on the base cannot be seen by it. | The mutation bends the one write that no older test judges, and was run by hand over the whole file at the base and at the head (no rung: a run by hand). |
| 3 | DESIGN.md's item on keyed follow-ons still described the two deleted tests in the present tense, and so stated a stronger hold than any test makes. | A reader of the spec would believe every write is held to a listed key. | A check that reads a sentence of the spec against the test it describes. | No check reads DESIGN.md against the tests, and the diff did not touch that passage, so no review of the diff showed it. | None. The passage is rewritten to what holds now. |
| 4 | The records said a due range over a written table is refused, and inside a subquery it is not: a COUNT in an UPDATE's SET and an INSERT whose SELECT is a due range read as no fault. The first fold had also narrowed the list of what the rule cannot see to reads. | A write that counts or copies every expired lease of its queue passes, while the records said such a range is refused. | The false negatives' test, which runs what the rule cannot see. | The fold wrote the sentence from what the line was meant to do, over the table a write writes, without the limit the code has, among the steps of the write's own select, and no case put a due range in a write's subquery. | Both statements run in the false negatives' test, and the limit named in every record (rung 3 for the run; the sentence is prose). |
| 5 | The records said the deleted tests lost only a write by another entity's key, and four more writes they refused pass the reader: a test of an entity column for NULL, which reads as keyed, and three writes whose FROM item shares the written table's name or alias, one of them a walk by a queue and a state that the second test refused. | Four shapes of write that walk or rewrite a whole table pass the plan check, while the records said the only loss was one bounded shape. | The same run of the deleted tests' own code against the reader as finding 1. | The first fold recorded the losses its author found by reasoning, and the deleted tests' code was still never run against the reader. | The write form of each run beside its read in the false negatives' test, and every loss named in the records (rung 3 for the run; the comparison is not built). |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The first review: the built-in code review at medium effort, each finding reproduced against the base | 3 | No |
| The second review: the same skill at medium effort over the first fold's range, merged with the reviewer's own findings | 2 | No |
| This change's machinery: the generated check, the commit guards, the mutation probe and audit, the base gate | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round, PR3.14c's review of the same check: 0 of 7).

The machinery did catch defects that are not findings by this project's rule, and they are recorded here so the rate is read with them. The author's own reading of the first fold's diff found that a comment before a write's first word hid the write from both lines over a write, and its red came before its fix. A commit guard refused a control count: a message said a reader bent so it cannot read a quoted table names every shipped write, and the guard's count was 81 of 82. None of that bears on the five findings. Every one of them is a claim in a record that was false while every check was green, and the check this change built reads the store's statements, never the sentences written about it.

## Recurrence

The first class is a substitution recorded by reasoning, findings 1 and 5. Finding 5 is another instance of finding 1's class, after the first fold's mechanism. That fold moved the two holds it had found into the reader and named the loss it had found, and it did not change how losses are found: by the author reasoning about what the deleted test was written against. The property is that the replacement holds what the deleted check held. The proxy was that the deleted check's stated purpose is held. What measures the property is a comparison: run the deleted check's own code and the replacement over the same writes and list every write the old refused that the new passes. The second review did exactly that by hand, on eleven writes.

The second class is a claim in the records that no check holds, findings 2, 3 and 4. It recurred in every round so far on this check. PR3.14c's review found four places that said no earlier test planned a read, and a list of due ranges whose prose reasons held nothing. This change's first review found findings 2 and 3, and its second found finding 4. The mechanism PR3.14c built for its instance, a name on the list of due ranges that must pin its driving lines and a bound, is the property for that one list. No mechanism reaches a sentence.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The refusal of a walk in any statement | 2 | `delete from waits as "2 CONSTANT ROWS" where status = ?` scans `waits` and reads as no fault, because its plan prints the scan as `SCAN 2 CONSTANT ROWS`, which the reader takes for the rows of a VALUES. Run in the false negatives' test. |
| The line that refuses a due range over a written table | 2 | `update runs set attempt = (select count(*) from runs where queue = ? and state = 'running' and claim_expires_at_ms < ?) where run_id = ?` counts every expired lease of its queue and reads as no fault, because the range stands in a subquery. Run. |
| The line that a write's own select has a step over its table | 2 | `update tasks as d set max_attempts = 7 from (values (1)) as d` writes every task and reads as no fault: the scan of `tasks` shares the FROM item's name, so it reads as that item's rows and also stands as the step over the table. Run. |
| The refusal of what the reader cannot tell from a statement's first word, syntactic | 2 | No write is known to pass it wrongly. It is a proxy for what the plan says a statement writes, and the write above passes the half of the same reading that names the table. What it refuses though sound is recorded as strictness. |
| The case that holds `key` to `meta` | 3 | None written. It reads the tables of the migrated schema, and `json_each` has a column named `key` that it does not list, which is sound only because the reader reads a virtual table's step before any column. |
| The run by hand of each new mutation over the whole plan test file at the base | none | A later mutation registered without that run. The probe runs only the owner's title, so a failure of another test on the base is not seen. |

## Fix-induced defects

Two of the five findings were written or left by the first fold's own fixes. Finding 4's sentence was written in that fold, and finding 5's sentence was that fold's correction of finding 1's, and still false. Of the second review's LOW items, its findings 4, 5 and 7 and part of 6 came from that fold too: reading a statement's first word refused sound statements with wrong words, widening the reading of a VALUES's rows let a contrived alias pass, the comma added to the lookup of a table's name matched a select-list alias, and several sentences the fold wrote were inexact. Those fixes were reviewed again as new code: the second review read the first fold's range. This fold has not been reviewed. Its change to the reader is one pattern, which now reads an UPDATE's conflict clause and a table's schema, red first, and its document changes take the review's own words.

## Evidence

- Red tests, for finding 1: commit `076e87d`, probe `packages/store-libsql/test/query-plans.test.ts` `refuses a write whose plan has no step over the table it writes, or a due range over it`, run and seen failing (1 test failed, 26 passed) against `5fe7880`.
- Fixes, for finding 1: commit `242d713`, which turns `076e87d` green. Gate after fix: the plan test file passed 27 of 27. The four conditions of the two lines each have a case in commit `25919de`, and each case was seen failing by name with its condition deleted alone.
- Red tests, for finding 2: none of its own, and this line cites no commit. The finding is a claim in three records about what a mutation does, and each mutation was run by hand, alone, over the whole plan test file at the base and at the head instead.
- Fixes, for finding 2: commit `ae0a129` bends only the lease-fenced checkpoint write, commit `338690b` corrects exit test line 26 and BUILD.md's entry, and commit `aa6dccb` makes the registry's comment and description exact. Gate after fix: by hand on the base, 1 failed and 25 passed, the one failure the inventory's tie to the corpus, and at the head the generated check also fails by name, and nothing else does.
- Red tests, for finding 3: none, and this line cites no commit. It is a sentence of DESIGN.md.
- Fixes, for finding 3: commit `338690b`. Gate after fix: the deferral lint and the milestone section's test passed.
- Red tests, for findings 4 and 5: none of their own, and this line cites no commit. They are sentences, and the statements they are about now run in the false negatives' test, each reading as the records now say.
- Fixes, for findings 4 and 5: commit `25919de` runs the statements, and commit `b90692a` corrects DESIGN.md, exit test line 26, BUILD.md's entry and its options. Gate after fix: the plan test file passed 30 of 30, and the gate list of the merged head passed.
- Red tests, for the author's own finding, which is not counted: commit `d1b7b46`, probe `packages/store-libsql/test/query-plans.test.ts` `refuses a statement whose kind it cannot tell from its first word`, run and seen failing (1 test failed, 28 passed) against `338690b`.
- Fixes, for the author's own finding: commit `904fb20`, which turns `d1b7b46` green. With the reader's pattern bent so that it reads no write, the generated check named all 82 shipped writes.
- Red tests, for the second review's finding 4, which is not counted: commit `be4eb02`, probe `packages/store-libsql/test/query-plans.test.ts` `reads a write as a write whatever its conflict clause or its schema`, run and seen failing (1 test failed, 29 passed) against `06c5692`.
- Fixes, for the second review's finding 4: commit `9c712ad`, which turns `be4eb02` green.
- Finder: the first review, quoted verdict: "The clause works and the red is sound, but three claims in the durable records are false or incomplete, and one of them hides a hold that deleting pin 1 lost." The second review, quoted verdict: "Merged with my own six, they come to two MEDIUM and nine LOW. None affects a shipped statement: all 129 still read as no fault."
- The reviewers' reproductions, quoted. From the first: "At the head, `delete from waits` plans as zero rows and reads as no fault." and "With `checkpoint-write-seeks-its-source-run` applied alone on the base reader, this test fails under marker `saga-plans`." From the second, which ran each deleted test's own logic at the base: "All four pass the reader at the head and at 5fe7880", and of its table of four conditions: "I deleted each condition by hand, alone, and the whole plan test file stayed 29 of 29."
- Claims that did not reproduce, and what settled each. The second review reported that its skill's agent saw the lint self-test's child fail at its 0.1 s verifier deadline in 2 of 110 runs. The reviewer confirmed the mechanism by reading and did not measure the rate again, and neither did the author, who read the same program: the descendant's first act is to ignore SIGTERM, so a SIGTERM that lands sooner kills it before it writes its record. The rate is not quoted in the records for that reason. The second review's suggestion to read a write's table from EXPLAIN's bytecode was not tried, and is recorded as an option. The first review's LOW item on `key` reproduced only on a scratch table.

## Root cause

Every finding has one cause: the change's claims were written, and not measured. The substitution of the two deleted tests was argued from what they were written against, and their own code was never run against the reader over a set of writes, which is the one measurement that says what a substitution loses. The records were written in the same commits as the code, as sentences that no check reads: the generated check holds the statements the store ships, and nothing holds the sentences about the check. The reviews measured both, by hand.

## Mechanisms

Built in this PR:

- The refusal of a walk in any statement, in the plan reader that the generated check runs over every statement the store ships (rung 2, a generated enumeration, `packages/store-libsql/test/plan-nests.ts`).
- Two lines over a write, and the refusal of a statement whose kind or written table the reader cannot tell, in the same reader, red first (rung 2).
- A case for each of the four conditions of the two lines, each seen failing by name with its condition deleted alone (rung 3, `packages/store-libsql/test/query-plans.test.ts`).
- The false negatives' test, which runs every shape the rule is known not to see, so that a change in how the reader reads one of them fails by name (rung 3).
- The case that holds `key` to `meta` alone, and `meta`'s primary key to that column (rung 3).

Deferred (recorded in BUILD.md):

- A comparison before a check is deleted for one that replaces it: the deleted check's own code and its replacement over the same statements, listing what the old refused and the new passes. It is the mechanism the root cause asks for, recorded with the next deleted check as its trigger.
- A generated surface for the plan reader. Its trigger, the next finding against the reader, has been met by these rounds, and building it waits for the maintainer's decision.
- Reading a statement's kind and written table from EXPLAIN's bytecode, with the next write the text misreads as its trigger.
- Naming every due range, whose trigger is a person's finding, and the lint self-test's watchdog, whose trigger is its tripping on CI.

## What this round still would not catch

A defect of each of these shapes would ship today. A due range in a subquery of a write, or in the SELECT an INSERT copies from. A write whose FROM item shares the name or the alias of the table it writes. A test of an entity column for NULL. A table aliased to what a plan prints for the rows of a VALUES. A plan that changes under statistics, or under binds the history never sends. A statement inside a trigger. And a sentence in the records that no check reads, which recurred in every round so far.
