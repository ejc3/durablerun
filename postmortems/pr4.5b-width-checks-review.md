# Postmortem: PR4.5b identifier width checks review (PR #65)

The change built the two checks of rule 10 that PR4.5 parked: a name-length
axis in the SDK's replay-equivalence harness, and a width condition in the
invariant library with its enrollment, a fuzz op that lets it fail, and five
registered mutations. It ships no engine, SDK, driver or store code. It passed
every local gate, with the unfiltered mutation audit at 878 of 878. One
review, by the built-in code review skill with the reviewer's own probes on
libSQL, PostgreSQL and MySQL, found no bug in shipped code and found that the
branch meets every clause of its exit test. It named twelve things, one of
MEDIUM severity and eleven LOW. Six are counted here: each is a check or a
sentence this change added that said more than it held. The worst was
reproduced. The test that ties the width condition's list of columns to
MySQL's schema would have passed with a new identifier column missing from the
list, if the column arrived in the shape this schema uses for DDL that is safe
to repeat. Our own machinery found none of the six.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here reached a user, because the change ships checks and no product
code. What would have shipped is a set of checks weaker than they read.

1. The worst. A future identifier column on MySQL, added the way this schema
   adds anything it must be able to repeat, as a statement inside a string that
   it sets, prepares and executes, would never have reached the inventory pin.
   The inventory would miss it with every test green, the width condition would
   not read it on libSQL and PostgreSQL, and a name the engine derived and
   nothing held would sit in that column with nothing reporting it. The port's
   entry hold is separate and still applies, so this is second order. A column
   at another width, or in a seventh table, was dropped by the pin the same way.
2. The axis's past-room check would have passed an SDK that made too few store
   calls after a refused call, in any attempt but the last.
3. The spawn member would have passed any `ctx.spawn` failure as the documented
   refusal of the stored child key.
4. A faulted schedule's stored lengths were not held, the emitted event name
   above all, while the pull request said a run must have left them.
5. One expectation could not fail, and read as coverage.
6. Three documents told a reader that no length in `identifier-width.test.ts` is
   typed by hand. Eight are.

## Findings

The numbers are the review's. Its findings 6, 7, 8, 9, 11 and 12 are not counted: an omission from the description, a latent note, a gap in the registry's self-test that is older than this change and is closed here anyway, tidying, three options, and nits.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The inventory pin's reader skipped any migration statement that does not start with CREATE TABLE or ALTER TABLE, and the pin kept only columns of width 255 in the six snapshot tables | A future identifier column added in the schema's repeat-safe shape, at another width, or in another table is missing from the inventory with every test green, and the width condition does not read it on libSQL and PostgreSQL | The reader's own case, which feeds it formatting it did not anticipate, and the registered mutation that removes a column from the inventory | The case fed the reader only shapes it reads. The mutation takes a column away from the inventory side and never adds one to the schema side, so it cannot see a reader that reads too little | The reader counts the VARCHAR columns a statement types and refuses a statement where it read a different number. The pin holds every VARCHAR column of the schema by name and width, the meta table's with it, to the inventory or to five named columns (3, and syntactic: it reads the text of the migrations) |
| 2 | Three documents said `identifier-width.test.ts` takes every length from the shared table of rooms. Only its table case does | A reader believes no room in that file is typed by hand. Eight lengths are | Nothing. No machine reads a sentence against the code | There is no such layer | The sentences are corrected. No mechanism |
| 3 | The axis's past-room check let every attempt but the last make any leading part of the expected store calls, the empty list included | An SDK that made no store call, or too few, after starting a refused call in an attempt that is not the last passes | The mutants the axis was falsified with | Each of them removes a hold, which adds calls. None takes a call away, so the lower side of the allowance was never exercised | The trace marks the call the harness failed, and a short list is accepted only when it ends at that mark (3) |
| 4 | The spawn member's message check looked for the opening of `ctx.spawn`'s message, which begins all three of its errors | The documented exception, the store's refusal of the stored child key, was not pinned. Another spawn failure passes as it | The falsification by core's stored child key mutant | That mutant lets the task complete, which fails an earlier expectation, that the run ends failed. The message check never decided anything | The member looks for the refusal's own phrase (3, and syntactic: a substring of a message) |
| 5 | The lengths a run left were asserted on the reference run only, and the comparison between schedules never read an event | For the `emitEvent` member a faulted schedule's emit was unchecked, while the pull request said a run must have left what the member says | The harness's one comparison between schedules | It compared five fields by name. A field added to the record is not compared until someone lists it | The comparison is the whole record a run reports, less the count of store calls, so a new field is compared without being listed (1 for the list of fields, 3 for what the record holds) |
| 10 | The comparison's `state` expectation could not fail, because each run is already held to the end it was told to reach | None today. An expectation that cannot fail reads as coverage | The simplify pass, which removed one expectation of this kind from the same file before the review | It named the one instance it saw. Nothing swept the file for the class | The field and the expectation are deleted. No mechanism |

## Detection ledger

Every counted finding, the review's 1, 2, 3, 4, 5 and 10, came from the one outside review. Its skill returned ten candidates, and the MEDIUM came from the reviewer's own question about the inventory.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of PR #65: the built-in code review skill as one subagent, and the reviewer's own probes on libSQL, PostgreSQL and MySQL with main as the control | 6 | No |
| This project's machinery on the reviewed head: the SDK suites and the replay-equivalence harness, conformance on three dialects, the poison matrix, the fuzz, the lints, the unfiltered mutation audit | 0 | Yes |

Self-catch rate: 0 of 6, or 0% (previous round on main, PR3.9f part 2's: 0%. The previous round on this work, PR4.5's: 0 of 9).

Three things our own machinery did find on this branch are not counted, because they were found before the review or inside the fold, which is the system working. The audit's baseline refused a verdict this branch first placed in a fuzz file, a file the audit's test command excludes, with `worker baseline is red: targeted test did not run`. The simplify pass found that the documents, one commit message and the description said the inventory holds 19 columns where it holds 22. And in this fold the new whole-record comparison failed the first version of the fix for finding 5 before it was committed.

The rate is 0% for the second round running on this work, and it was 0% on main in the round between them. The mechanisms being added catch what they are aimed at. The review keeps finding the side of a check that nobody aimed at, which is what Root cause says.

## Recurrence

**A reader of text standing where the property is the catalog (finding 1). Recurred.** This is the spelling proxy of the repository's own catalogue: every clock and counter lint matched one spelling, where the property is the operation. The mechanism instituted against it, the statement tree, moved the stores' statements from text to a tree. Migration DDL is still text, and this change added a new reader of that text knowingly. The description says why: the fixtures' catalog statements return a type without a width, and a catalog pin runs only where a MySQL server runs. What the reader checks is how a VARCHAR column is spelled in the text of a migration. What it was supposed to check is which columns the schema bounds. The review found the gap between the two in one day. The fold keeps the proxy and makes it refuse what it knows it cannot read. The catalog pin is recorded as an option, and its false negative is in the audit below.

**A check proven able to fail in one direction and treated as proven (findings 3, 4, 5 and 10). Recurred.** This is the last entry of the same catalogue: a mechanism with one failing case was treated as proven, and two conditions of the wake surface could be deleted with every case green. The mechanism against it is per-condition mutation, which stays deferred on main. This change used the next best thing it had, falsification by registered mutants, and every mutant it used removes a hold. A removed hold adds store calls, completes a task that should fail, or stores a longer name. So each expectation was exercised from the side it was built to catch and from no other: nothing made too few calls, failed with the right end and the wrong message, or changed what a faulted schedule left. The simplify pass had removed one expectation of this class from the same file, the instance it saw, and the file was not swept for the class.

**A sentence that says more than the code (finding 2). Recurred, in every round on this work so far.** PR4.5's round counted three of these, and its answer was the same as this one's: no machine reads a sentence against the code. Two rounds of two.

## Mechanism audit — the false negative of each

Each row was run against the fixed code, except where it says it was not.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The reader refuses a statement whose VARCHAR columns it did not all read, and the pin holds every VARCHAR column of MySQL's schema by name and width | 3, syntactic: it reads the text of the migrations | A column bounded by another type. Ran: `probe_char CHAR(255),` added to the tasks table in the MySQL schema file, and the pin passes, 1 of 1. Two controls show what it now refuses. Ran: the reviewer's column, as `SET @durablerun_ddl = IF(1 = 1, 'ALTER TABLE tasks ADD COLUMN probe_name VARCHAR(255)', 'DO 0')`, fails the pin with `a migration statement types 1 VARCHAR column(s) and the reader read 0`. Ran: `probe_width VARCHAR(64),` fails it with `"tasks.probe_width": 64` in the difference. A sixth name added to the list of columns that are not identifiers also passes, and is a person's choice that no test reads. Not run |
| A short list of store calls after a refused call is accepted only when it ends at the injected outage's mark | 3 | The trace holds the names of the SDK's store calls. It does not hold their arguments, and it does not hold what user code ran. A `fail` that records the wrong payload is a call named `fail`: on one schedule the whole-record comparison catches it, and on every schedule alike, the reference with it, only the substring check of the next row stands. A rollback handler that the SDK ran after the refusal and did not record makes no store call at all. Not run: both need a change to the SDK that this change does not make |
| The spawn member looks for the refusal's own phrase, `was refused: childOf.replayKey, as the stored child key` | 3, syntactic: a substring of a message | A message that carries the phrase and names the wrong width passes. Not run: it is a statement about text. The store's own conformance surface holds the number |
| The comparison between schedules is the whole record a run reports | 1 for the list of fields, 3 for what the record holds | The record holds the length of the longest name the task emitted, and not the name. Ran: with the harness's emit made to end its name in the number of the pass, which keeps the length, the `emitEvent` member passes, 1 of 1, although a faulted schedule then emits under another name than its reference. By design the record also leaves out the external events the harness itself emits and the completion events of tasks that happened to run, because both are there or not by schedule |
| The registry's self-test refuses a verdict in a file the audit's test command excludes | 2 | It reads a verdict's path against the command's exclusions and nothing else. Ran by import: it returns nothing for the 880 live verdicts of the rebased head, and one problem for a verdict moved into a fuzz file. A test that does not run for another reason, a skipped case or a title the pattern cannot match, sits in a file the audit runs, and passes this check. The audit's baseline is what catches that, when the audit selects the mutation |

## Fix-induced defects

None is counted. One fix went wrong on its first try and was caught before it was committed. The first version of the fix for finding 5 compared the longest event name of any kind between schedules. That measure depends on the schedule for two members, for no defect: the harness's own external emit exists only when a run lasts to the round where externals start, 36 characters against 249, and the completion event of a child with a padded id exists only when that child happened to run, 36 against 255. The new comparison failed on both, by member name, and the measure became the task's own emits.

The fixes were tested again and not reviewed again. The harness ran clean and then under six registered mutants by hand, with the same seven members red by name as before the fold and the same two mutants green.

## Evidence

- Red tests: commit `3f11f26`, probe `packages/conformance/test/invariant-checkers.test.ts` `refuses a migration statement that types a VARCHAR column it did not read`, run and seen failing, one test, against `bc76f3c`. That commit is the head the review read, as it stands since the branch was rebased onto main, with the same patch. The reader returned nothing for the prepared statement and said nothing: `expected [Function] to throw an error`. The other 47 cases of the file passed.
- Fixes: commit `c9d5eaa`, which turns that case green. Gate after fix: the file passes 48 of 48, and the registered mutation that removes `wake_step` from the inventory still fails the pin.
- Fixes, for findings 3, 4, 5 and 10, which tighten a test and have no red commit, because no product code was wrong: commit `7e307cd`. Gate after fix: the harness passes 27 of 27. By hand, `sdk-repeated-name-key-held-with-its-counter` turns `step used twice` red, `sdk-durable-key-held-before-the-body-runs` turns five members red, `sdk-emitted-event-name-held` turns `emitEvent` red, core's `stored-child-key-held-to-the-width` turns `spawn` red, and the two mutants that need a name an older build stored leave it green.
- Fixes, for finding 2, with the review's two history comments and its note on the fuzz op's count: commit `318ff7b`.
- Fixes, for the review's finding 8, which is not counted: commit `c5d983e`. The classifier self-test passes with three new cases, and its new injected fault is caught through the command line and enrolled in the lint self-test, which runs twelve such faults where main runs eleven.
- The branch was rebased onto main twice after these commits were made, because other pull requests merged first. Each commit cited here is the same patch at the same position as the one that was run, which a comparison of patch ids shows for every one of them.
- The whole gate list for this fold runs on the head that holds this document, and the pull request's description carries its table.
- Finder: the one review, quoted verdict: "I found no correctness bug in shipped code, and the branch meets every clause of its exit test line."
- The reviewer's reproduction of finding 1, quoted: "With `probe_name ${NAME}` added to the tasks CREATE TABLE, the pin goes red by name and shows `+ \"tasks.probe_name\"`. With the same column added as a prepared conditional ALTER TABLE, the pin passes (1 passed, 46 skipped)."
- The reviewer's trace for finding 3, quoted: "I traced all 24 past-the-room schedules. Six members only ever produce `[\"fail\"]`. `spawn` produces `[\"spawn\",\"fail\"]` and once `[\"spawn\"]`, when the injected outage hit the spawn call. An empty list never occurs."
- The message for finding 4, as the reviewer captured it: "`ctx.spawn('<name>') was refused: childOf.replayKey, as the stored child key, which also holds the parent task id, is longer than the 255 characters a durable identifier holds`".
- Claims that did not reproduce. The reviewer rechecked three candidates its skill had refuted, and all three stayed refuted: the bridge arm's digest is main's registry's, all 878 find strings occur exactly once at the head, and the libSQL `spawn` mints its ids before its first await. The reviewer also tested the worry behind its finding 9, that the rooms table types the SDK's private prefixes again and could drift unseen: "I grew the SDK's await prefix by one character and left the table alone. The `awaitEvent` member went red." And one of the author's own did not hold, which Fix-induced defects records: the first measure chosen for finding 5 differed between schedules for no defect.

## Root cause

Each check this change added was shown able to fail, and each was shown from one side: the side it was built to catch. The axis was falsified by removing a hold, which adds store calls and completes tasks. The inventory pin was falsified by removing a column from the inventory. Both are the author's picture of the defect. Nothing took a call away, added a column to the schema, changed a message while keeping its opening, or changed what a faulted schedule left, because no registered mutant has those shapes and the author did not think of them. A reviewer who had not built the checks asked what each one lets through, and answered by reading the expectation's other side.

The repository already names this class, and its mechanism, a mutation for every condition of a check, is deferred on main. Until it lands, a new check here is proven from one side by whoever wrote it.

## Mechanisms

Built in this PR:

- The migration reader refuses a statement whose VARCHAR columns it did not all read, and the inventory pin holds every VARCHAR column of MySQL's schema by name and width, against the inventory and five named columns. Rung 3, syntactic. `packages/conformance/test/invariant-checkers.test.ts`.
- The axis's trace marks the call the harness failed, and a short list of calls after a refused call is accepted only when it ends at that mark. Rung 3. `packages/sdk/test/replay-equivalence.test.ts`.
- The comparison between schedules is the whole record a run reports, so a field added to the record is compared without being listed. Rung 1 for the list of fields. The same file.
- The spawn member looks for the refusal's own phrase. Rung 3, syntactic. The same file.
- The registry's self-test refuses a verdict in a file the audit's test command excludes, with three cases and an injected fault. Rung 2. `scripts/mutation-probe.py` and `scripts/lint-selftest.py`.

Deferred (recorded in BUILD.md):

- Holding the inventory to MySQL's catalog, which states each column's width, in the MySQL conformance job. It is an option in the PR4.5b entry. Deferral is acceptable because the text pin now fails on every VARCHAR column it does not account for, and the shape it cannot see, a column bounded by another type, is one this schema does not use.
- A mutation for every condition of a check is PR3.10's work and stays deferred on main. This round is more evidence for it and does not move it.

## What this round still would not catch

- A MySQL column that holds an identifier and is bounded by a type other than VARCHAR would be missing from the inventory with every test green.
- A column added to the pin's list of columns that are not identifiers, which should have been an identifier column, would ship.
- An SDK defect after a refused call that does not show as a store call, a rollback handler run and not recorded above all, would ship.
- A `ctx.spawn` refusal with the right phrase and the wrong width in its message would ship.
- A faulted schedule that emits under another name of the same length than its reference would pass the harness.
- A verdict whose test is skipped inside a file the audit runs would pass the registry's self-test, until the audit selects its mutation.
- A sentence in DESIGN.md, BUILD.md or a description that says more than the code does would ship, as it has in both rounds on this work.
