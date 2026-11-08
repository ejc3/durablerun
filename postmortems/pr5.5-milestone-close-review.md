# Postmortem: PR5.5, the record that closes the operable alpha milestone (its one review)

PR5.5 records the operable alpha milestone as complete in BUILD.md, and reads DESIGN.md sections 3.11 and 3.12 against the code. Before its review it had corrected 62 sentences of those sections, nine sentences of BUILD.md that repeated them, seven comments, and one gate script: CI's MySQL job runs a list of test files, and four test files of the CLI that run on each selected dialect were not on it. One review of the branch's head found ten things, none HIGH, two MEDIUM and eight LOW. It reported that every new or corrected statement it checked is true. What it found is the other half of the work: a sentence was corrected where it was read and left standing where it was copied, in an exit test line, in BUILD.md, in the README, in another section of DESIGN.md and in ten comments. And the gate fix added four names to a list written by hand, with a fifth file still outside it and nothing that would name a sixth.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here changes what the engine or the CLI does. It is a SEV because the pull request's whole product is a record that says the exit test is met, and the review found that record false in the lines it stands on.

Finding 1 is the worst. Exit test line 37 said a grace of zero shows the task that loops through launch deferral "at the same instants" as the default grace hides it. The case that holds the line requires the opposite of the first instant: the task is not shown there, and is shown at the last three. This pull request had corrected that sentence in DESIGN.md and then declared line 37 met with the old sentence still in it. A reader who trusts the exit test over the design reads a property the code does not have, in the one document that says the milestone is complete.

Finding 8 is the other MEDIUM. The pull request said CI's MySQL job now runs the test files that run on each selected dialect, and one more such file was outside the job: the case that a week of the retention soak turns the event loop, which DESIGN.md says holds "on every selected dialect". No job ran it on MySQL. The fix that came before the review was four names added to the list, so the next file that loops the selected dialects would have been dropped the same way, with a record that says otherwise.

The other eight are the same two shapes at a smaller scale: a false sentence left in a second place (findings 2, 3, 6, 9 and 10), a corrected sentence that still said more than the code (finding 4), an option whose trigger had already fired when it was written (finding 5), and a sentence of the record that the standing rules contradict (finding 7).

## Findings

Each finding was found by the one review. The severity is the review's.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Exit test line 37 said a grace of zero shows the deferral-loop task "at the same instants". Its case requires that the first instant is not shown and the last three are. The pull request corrected the same sentence in DESIGN.md and left this one (MEDIUM) | The record declares a line met whose own words the case contradicts | The read of DESIGN.md against the code, which this pull request is | The read went through two sections of DESIGN.md. A sentence it corrected was searched for in BUILD.md by its exact words, and this copy is worded differently | None for prose. The copy is corrected, and every corrected sentence was searched for again by its claim (not a rung: a search made once) |
| 2 | Three more sentences of BUILD.md kept what DESIGN.md no longer says: a failure "before any unit was reached", and "a dump of every table" twice, once inside exit test line 42 (LOW) | The plan and the design say two things of one command and of one oracle | The same read | As finding 1 | None for prose, as finding 1 |
| 3 | The README said the CLI never prints the URL. It prints what `--target` names of it (LOW) | An operator is told less is printed than is | The same read | The README was read for the one sentence the gate change touched | None for prose |
| 4 | The corrected sentence on a run a claim takes named five causes and "the two commands agree". Two shapes of due run are named otherwise, both rows no engine path writes (LOW) | A sentence written by this pull request says more than the code, in the way the sentences it corrects do | The check of each corrected sentence against the code | The correction was checked against the arms it names, and not against the order the arms are asked in | None for prose. The sentence is held to rows an engine path writes |
| 5 | The new option for count markers gave the trigger "the first of those counts found stale", and this pull request's own read had found two (LOW) | An option whose trigger has fired is a plan entry, and the record called it an option | The author's read of the option beside the diff | Nothing holds a trigger to what the same diff says | None. The trigger is the next one, and the option names the two |
| 6 | DESIGN.md section 3.10 kept the sentence that section 3.11 no longer has: the invariants hold "over every conformance case" (LOW) | The design states both versions | The same read | Section 3.10 is outside the two sections the read went through | None for prose |
| 7 | "No milestone is current" stands beside the standing rule "At any time BUILD.md names one current milestone" (LOW) | A reader of the rules expects a current milestone and finds none | Nothing: it is the state the repository is in | The record says what is true, and the rules are the maintainer's | None, and no change. The pull request's text says the next milestone is the maintainer's to name |
| 8 | The MySQL job's list of test files is written by hand. The pull request added four names to it with no check that the list holds every test file that runs once for each selected dialect, and `retention-soak-turns.test.ts` was still outside it (MEDIUM, a gate) | A case that its record says holds on every selected dialect ran on MySQL in no job, and the next such file would be dropped the same way | A generated enumeration of the files, which the ladder names at rung 2 | There was none. The script checks that something of the dialect ran, and not that everything that selects ran | A case finds the files by what they import and holds the list to them (rung 2) |
| 9 | Ten more comments carried sentences this pull request corrected in DESIGN.md (LOW) | A reader of the code is told what the design no longer says | The same read | The first pass searched the code for each old sentence's exact words, and found seven | None for prose. The ten are corrected, and so are the others a second search found |
| 10 | The header comment of the operator's statements said the reads select no event payload, in a file whose `event-payload` read selects one. This pull request had rewritten the comment's second paragraph (LOW) | A comment the change touched is half true | The author's read of the comment it edited | The edit was of the paragraph a corrected sentence pointed at | None for prose |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of the pull request: the built-in code review skill at high, run as a subagent, with the reviewer's own run for findings 1 and 4 | 10 | No |
| This project's machinery: the lints, the format check, the type check, the deferral lint, the counts case, the case that reads BUILD.md and the README, the registry's self-test and the base gate, all green on the reviewed head | 0 | Yes |

Self-catch rate: 0 of 10, or 0% (previous round, PR5.4's: 0 of 24, or 0%). All twelve rounds of the operable alpha milestone have a rate of zero. The rate is not improving.

The ratio hides one thing and it does not help. The pull request is itself a read of documents against code, by readers and not by machinery, and before the review that read found 62 false sentences, the four test files outside the MySQL job, and a defect of `selftest` that PR5.4 then fixed. None of that is machinery either. So the milestone ends with every false sentence it is known to have held found by a reading: this pull request's, or a review's.

Not counted: nothing. The review reported no finding it marked uncertain, and its ten are the ten here.

## Recurrence

A statement that says more than the code recurred, in findings 1 to 4, 6, 9 and 10, and PR5.2c1's postmortem says it has recurred in every round of this milestone. Each round answered it by reading its own sentences once more. This pull request is that answer made into a whole pull request, and the class recurred inside it: the read finds a false sentence and corrects it where it stands, and the same claim stands in other places in other words. The earlier rounds' records say "none, prose" for the mechanism and "nothing reads DESIGN.md" for why. One mechanism does read it: the counts case, which holds a number of DESIGN.md to a value the code exports where a marker says which. It is the property for the twelve counts that carry a marker and nothing for a count that carries none. Finding 5 is that boundary: the two counts this read found stale had no marker, and neither has an exported value a marker could name.

A second copy of one thing recurred, in the same findings, and the single representation law and the simplify gate exist for it. PR5.2d's finding 1 and PR5.4's findings 9 and 14 met it in code. Here the copies are sentences: one claim written in DESIGN.md, again in BUILD.md, again in an exit test line, in a comment above the code, and in the title of the case. The law's mechanisms hold a value that crosses a boundary to one definition. Nothing holds a sentence to one place, and the repository's own rules ask for the copies: an exit test line cites its evidence in words, a Phase entry records what was built, and a comment says what the code does.

A list written by hand where the property is a set the code defines recurred, in finding 8. PR5.2c1's postmortem names it as cases enumerated from a list that is not the property, PR5.3b2's as seeds enumerated from the cause table, PR5.3b1's as kinds of value written by hand, and PR3.3c's as a second copy written by hand. The mechanism that stood nearest is the script's own check, which refuses a run that exercised nothing. It checks that some test of the dialect ran. The property is that every test file that selects ran. The fix made before the review was the class once more: four names added to the list by hand.

A record that contradicts a standing rule, finding 7, is not a recurrence: BUILD.md recorded the same state after the milestone before this one, and no round's record names it as a finding.

## Mechanism audit — the false negative of each

One mechanism was built, and the audit ran it. Every other correction is prose, and a search for copies is a reading made once, which is named below as what it is.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The case of `enrollment.test.ts` that finds every test file under a `test` directory of a package or an app that imports the selected fixtures, the CLI's selected list or the parser of the selection, or that reads the variable, and requires each to be a path the one-dialect script hands vitest, or to be named in the case with its reason (finding 8) | 2 | Three files, each written and run with the case passing. A test file that imports the CLI's support as a namespace and loops `support.SELECTED`. A test file that imports the selected fixtures and stands under `packages/store-libsql/test`: the script lists `packages/store-$dialect/test`, which the case reads for every dialect, so the file counts as run though the MySQL job runs the MySQL store's directory alone. A test file that reads the variable through a bracket and a joined name. The case is syntactic: it reads import statements and one pattern of the variable, and the property is which files run their cases for a dialect |
| The same case, for what it does refuse | 2 | None found for these four, each bent in the script and seen failing by name: a file that selects taken off the list, a listed path that does not exist, a file named as left out and listed all the same, and a list the case cannot find, which fails its floor |
| The corrections of sentences and comments (findings 1 to 6, 9 and 10) | none, prose | Any sentence. After the ten findings were corrected, a search of the old claims of all 63 corrections, by four readers, reported more than eighty more places. Of them 33 comments, six sentences of DESIGN.md and three of BUILD.md, two of them inside exit test lines 34 and 38, were corrected. The rest stand, and the last section lists their kinds |
| The reworded trigger of the option (finding 5) | none, prose | An option written tomorrow whose trigger the same diff has fired |

## Fix-induced defects

None of the ten was made by the fix for another finding of the round: there was one round, and its fold is this document's subject.

Four of the ten are defects of what this pull request wrote before the review, and each was made by a correction. Finding 4 is in a sentence the pull request had corrected twice. Finding 5 is in an option it added. Finding 8 is its gate fix. Finding 10 is in a comment it rewrote in part. A correction is a change, and these were checked against the thing each was about and not against what stood beside it.

The fold made the class it was folding twice more, in its own commit messages, and both were found before it was reported. The message of its commit for BUILD.md calls a sentence of exit test line 34 a sentence of a Phase 5 entry: the search reported the place by a line number, and the line was not read for which part of the document it is in. The message of its commit for the comments counts 26 source and test files where it changed 27. A commit message is not rewritten here, so the pull request's text and this document say what each commit holds.

The fold was tested again, by the gates the evidence lists, and its corrections were each read against the code named in its commit. It was not reviewed as new code when this was written. A narrow second review of the gate part, the new case and the script, is to follow, and its result is not in this document.

## Evidence

- Red tests: commit `7cb0f9a`, probe `packages/conformance/test/enrollment.test.ts` `finds them by what they import, and requires each to be a path the script runs or to be named with its reason`, run and seen failing (1 test, naming `packages/conformance/test/retention-soak-turns.test.ts` under `selectedAndNotRun`) against `b08be29`.
- Fixes: commit `0eed89e`, which turns it green by adding the file to the script's list, and commit `bbca349`, which names a missing listed path once; gate after the fix: the case passes, and each of the four conditions it claims was bent in the script and seen failing by name. The file passes on MySQL, run alone on one machine: 1 file, 1 test, in 9 seconds.
- Red tests: none of its own for findings 1 to 6, 9 and 10, and this line cites no commit. They are sentences of BUILD.md, DESIGN.md and the README, and comments, and no test reads prose. Each correction was read against the code its commit message names.
- Fixes: commits `98c3ec8` (finding 1, and the sentence of finding 2 inside exit test line 42), `802496e` (the two other sentences of finding 2, finding 5, and a sentence inside exit test line 34 that the second search found), `5d0295b` (findings 3, 4 and 6), `0cdb5bc` (the sentence of exit test line 38 that the second search found) and `8161e37` (findings 9 and 10, and the comments the second search found); gate after the fixes: the registry's self-test passes with the comments in the tree, no registered mutation's find or replacement holds a changed line, and the cases that read BUILD.md, DESIGN.md, the README and the week's workflow pass.
- Finder: the one review, which ran as a subagent invoking the built-in code review skill, at high, on a detached copy of the branch at its head then, b08be29, on 2026-11-08, on libSQL alone, quoted verdict: "ten findings: no HIGH, two MEDIUM, eight LOW." and "every new or corrected statement it checked is true against the code, `git log` and the postmortems. That covers the Status paragraph's pull request numbers, dates and counts, and about 40 of the corrected DESIGN.md sentences. The defects are sentences the change corrects in one place and leaves standing in another, plus the gate fix being a hand-written list."
- What the review ran: the case of the deferral loop for finding 1, which passes and so shows the first instant is not shown; a probe of `diagnose` for finding 4, which printed `wait-outlives-its-event` with the verdict `inconsistent` for a sleeping run past its timeout whose wait stands beside its event, and `unexplained` for a due sleeping run that names an event no wait registers; the lints and the document cases, 6 files and 39 tests. It started no database server.
- What the fold ran for the three sentences the first pass had left as not verified. The model run that admits a rolling-back and a saga-failed parent was made on another machine, with `ParentAllows` widened both ways: every configuration of the retention model ended with no error, 18 of 18 mutants were caught, and every probe was witnessed, so the sentence stands. The plan check was run with the index `runs_wake_holders` removed from libSQL's version 12: 1 of 30 cases failed, naming the two reads of the purge as a walk of runs, and the unbent tree passed 30 of 30, so that sentence stands. The reason DESIGN.md gave for refusing an empty task name was not what the code does, and it is corrected: the hosted enqueue route refuses one.
- What the second search found and the fold corrected, beyond the ten: in DESIGN.md, the executors' note in section 3.4, `explain`'s exit 10, the cause that answers when a row moved, what the purge twin holds, what `selftest` prints, and what core's entry exports; in BUILD.md, the routing case of `selftest`, and two sentences inside exit test lines, the seeds of the fault surface in line 34 and a verb without `--yes` in line 38; and 33 comments.
- Claims that did not reproduce: none of the ten. Of what the second search reported, more than forty places were read and left, each because it is true in the place it stands (a title of a case that seeds only the ordinary input, a sentence that states a sufficient condition), or because it is not a comment (a title a registered mutation names, a line of the registry, a comment of a specification, a message the code prints).

## Root cause

A correction was made where the read was, and not where the sentence was copied. The read went through two sections of one document, sentence by sentence, and each sentence it found false it corrected in place. The repository states one claim in many places by design: the design, the plan's entry for the pull request that built it, the exit test line that cites it, the comment over the code, and the title of the case. The first pass searched for copies by a sentence's exact words, found nine in BUILD.md and seven in comments, and took that for the set. A copy in other words is found only by its claim, and nothing in the repository connects the places a claim is written.

The gate finding has the same root in another material. The property, every test file that selects a dialect runs in that dialect's job, was written down as a list of files, and the list was corrected where it was found short.

## Mechanisms

Built in this PR:

- The case that holds the one-dialect script's list to the test files that run once for each selected dialect, found by what they import. Rung 2, a generated enumeration, in `packages/conformance/test/enrollment.test.ts`. It also refuses a listed path that does not exist and an exemption that no longer applies. The script names the case in a comment above its list.

Deferred (recorded in BUILD.md):

- Markers for the counts of DESIGN.md sections 3.11 and 3.12. The two counts this read found stale have no exported value to hold them to, so a marker for either needs code this pull request does not change. The option's trigger is the next unmarked count found stale.
- The words of two refusals the code prints, which DESIGN.md no longer repeats: the reason `enqueue` gives for an empty task name, and the bound `stuck` and `purge` state for a duration. The trigger is the next change to those messages.

Not built, and not recorded as an option: anything that holds a sentence to the other places its claim is written. No observed use shows what it would read, and a search by readers is not a mechanism.

## What this round still would not catch

A defect of these shapes would ship today.

A test file that runs once for each selected dialect and reaches the selection by a namespace import, by a helper that loops it, or by reading the variable another way. A test file that selects and stands under the test directory of one store. The audit ran three of these and the case passes each.

A false sentence in any place the read did not go, and a copy of a corrected sentence in other words. The second search reported more than eighty after the review's ten, so more stand. Known to stand, because each is not a comment or is true where it is: titles of cases that a registered mutation names, which state a rule without the exception DESIGN.md now gives (the purge that "is the retention port and nothing else", "every batch that ends or parks a run", "each hold of the simulated week can fail", "a pending timer fire in each of its simulated days", "the instants at the head of the queue", "every other code an outage"); lines of the registry that quote them; comments of the two specifications that say an operator reads an event's payload "for its digest" and that every delete of a purge is keyed on its stamp; the phrase "a purge that reached no unit" in the week receipt's checker and its record, which is a sufficient condition and not the whole of when a report is dropped; and "every sim, scenario and fuzz walk" in two older entries of BUILD.md, which is the standing rules' own phrase.

A count of DESIGN.md that carries no marker and goes stale. An option whose trigger its own pull request has fired. A sentence of the record that a standing rule contradicts.
