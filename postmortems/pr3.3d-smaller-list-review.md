# Postmortem: PR3.3d, the child-task review's smaller list, and its one review

PR3.3d builds five small items that the second review of the child-task work
left as a smaller list: the run-to-task memo forgets a run its terminal batch
has ended, an event name carries the task of a completion event, a port's
refusal of its caller's input has one typed class that the hosted route maps
once, one helper runs every row checker at every generated surface, and a test
helper that was a copy exists once. It passed every local gate, the unfiltered
mutation audit and the base gate included. One full review then confirmed the
claims that carry the change, with its own probes: both red cases were red at
their commits, the two hand mutations of the fault matrix's excusal behaved as
described, no released declaration changed, and the matrix with every checker
found no violation on any dialect. It found nothing HIGH and nothing MEDIUM,
and nothing that loses, duplicates, or misattributes durable state. It found
nine LOW. Five of them are counted here: one hold that could not fail, and
four sentences that said more than the code.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

This is a SEV by the project's rule and by no other measure: five things
survived the author's machinery and were found by a reviewer. None of them is
a defect of the product. Without the review, this would have merged:

1. A fault matrix that could not see one class of lost completion event for
   one task. The matrix excuses the child that its simulated older build ends
   with no completion event. The excusal began when the workload spawned that
   child. In the cells where the older build's cancel dies before it runs, the
   child stays an ordinary live task, the probe loop ends it with an ordinary
   `complete`, and the matrix would have passed a store whose `complete` lost
   that child's event. Every other task of those cells was held.
2. A specification that said no store parses or formats the reserved event
   name, while the PostgreSQL executor tests the reserved prefix to choose a
   completion event's lock. A reader would have concluded that no store code
   depends on the prefix.
3. An exit test line in BUILD.md that said every surface calls the one helper,
   while three generated surfaces judged rows the engine wrote by one checker.
   All of their cases pass under the helper on three dialects, so the sentence
   hid nothing, and it was still not so.
4. A class comment that said an ended run takes no room in the memo, which is
   true only of a run the store's own terminal write ended.
5. A pull request body whose two `gate-changes:` lines named the base gate's
   key and the registry's size as they had been one merge of main earlier.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The fault matrix excused the older build's child from the spawn that creates it, before that build's cancel was known to have applied | In the cancel-task cells where the fault strikes before the batch, the child stays live, the probe loop ends it with an ordinary `complete`, and a lost completion event of that batch went unseen for that one task. The reviewer showed it with a bend: the cell resolved. No product defect was hidden | The two cases and the two hand mutations that held the excusal narrow | They varied WHICH task is excused and never WHEN. Every case ran a cell in which the older build's cancel had applied, and the excusal was keyed on the workload's position, which only stands in for "the older build ended this child" | The judge reads the rows and excuses the child only while its row is cancelled. A case that was committed failing holds it, and so does a registered mutation that drops the condition (rung 3) |
| 2 | Two `gate-changes:` lines of the pull request's body named the arm's key as the registry of an earlier main, and the registry as 939 entries. After the second merge of main the arm was keyed on the later registry, which held 952. The body's gate table was right | A reader of the body is told the base gate is keyed on a registry it is not keyed on | Nothing. No check holds a pull request's body to the tree | The two lines were written before the second merge of main. That merge's commit restated the workflow, and nothing restates a body | None in the repository (no rung). The option of a check in the attestation is recorded in BUILD.md |
| 3 | BUILD.md's exit test line said every surface calls the one helper, and the helper's comment listed the saga surfaces among its callers. The saga surface's race case, the suite's seeded races, and the identifier surface judged rows that only the engine wrote by one checker. The review named two of the three, and the third was found while converting them | Those three kept two checkers out of their verdicts. Under the helper every case of theirs passes on three dialects, so nothing was hidden | The simplify pass, which did raise the helper's comment before the review. The comment was narrowed then and the line in BUILD.md was left as it was | No check asks a file that calls the invariant library alone why it does. A sentence about every surface is a sentence about files the diff did not touch | The three sites call the helper, and a case lists the files that may call the library directly, with the reason of each (rung 2, and syntactic: it reads the text of a call) |
| 4 | The memo's class comment said an ended run takes no room. A run that ended by a refused write, a cancel, a sweep, or another process stays until 1,024 newer activations push it out | A reader sizing the memo expects it to hold only runs still at work | No layer reads a comment | The behaviour is held, by a case on three dialects and now by a mutation. The sentence about the behaviour is held by nothing | None for the sentence, which is prose (no rung). It now says what DESIGN.md already said |
| 5 | DESIGN.md said no store parses or formats the reserved event name. The PostgreSQL executor tests the reserved prefix to choose the lock of a completion event | A reader concludes that no store code depends on the reserved prefix, and changes the prefix without looking there | No layer reads a sentence of the specification against the code | The sentence was written from the diff, which removed the stores' hand formatting of the name. The executor's line is on main and outside the diff | None for the sentence (no rung). It now names the one reader that remains |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review, by experiment, for finding 1: an instrumented copy of the matrix, a bend of one task's `complete`, and a control aimed at another task | 1 | No |
| The same review, by digest, for finding 2: the arm's key in the workflow against the registry of each main | 1 | No |
| The same review, by reading and then by switching the sites in scratch, for finding 3 | 1 | No |
| The same review, by reading, for findings 4 and 5 | 2 | No |
| This project's machinery on the reviewed head: conformance on three dialects, the fault matrix with every checker, the fuzz, the lints, the registry's self-test, the unfiltered mutation audit, and the base gate | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round on main, PR3.1c's: 0 of 5).

The rate has not moved. The nearest this project's own passes came was finding
3: the simplify pass reported that the helper's comment claimed more than the
call sites showed, and the comment was narrowed while the same claim in
BUILD.md stood. A pass that finds a sentence in one file does not look for its
twin in another, and neither did the fold of that pass.

What the machinery did find before the review is not counted, because the rule
counts what escaped: the registry's self-test found two stale finds after the
event name and the refusal class moved text, and the first run of the matrix
with every checker is what showed that an excusal was needed at all.

## Recurrence

**A hold that could not fail (finding 1).** This class recurs. The review of
the self-concurrency surface counted a hold that could not move, and the
mechanism instituted since is that a hold is seen failing before it is
believed: a hand mutation at the least, a registered one where the guard is
new. That mechanism was applied here and it did not work. Two hand mutations
of the excusal were run before the review, the reviewer reran both, and both
behaved as described. They moved WHO is excused, to everybody and to nobody.
Neither moved WHEN. What the mechanism checks is that a guard fails when it is
bent along the axis its author thought of. What it was supposed to check is
that the excusal covers the older build's ending and nothing else, and that
property has a second axis, the moment, which no mutation of the first axis
touches. A mutation is an instrument for a guard that exists. It cannot find
the guard that is missing.

**A sentence that says more than the code (findings 2, 3, 4 and 5).** This
class recurred in every one of the last four rounds on main. The stale-token
column's review counted three such sentences, the transport lifecycle's two,
the byte collation's one, and the saga reads' three. No earlier round
instituted a mechanism, and each gives the same reason: no test reads prose.
This round gives one of its four sentences a reader, because finding 3's claim
was about the source tree and could be restated as a list that a case holds.
The other three get none. Findings 3 and 5 share a finer shape that is worth
naming for the next round: a universal, "every surface" and "no store", was
written from the diff. A universal is a statement about everything the diff
did not touch, so the diff is the one instrument that cannot check it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The judge excuses the older build's child only while its row is cancelled | 3, and a proxy: the state of the row stands in for which build ended the task | Written and run. In the cell where the older build's cancel dies before it runs, the probe loop's store was bent so that where it would complete that child, the CURRENT build cancels it through an executor that drops the completion event from `cancel-task`: `complete: async (queue, runId) => { ... await losing.cancelTask(queue, taskId) }`. The row is cancelled, the id is in the set, and the cell answered `resolved`. No batch of the workload does this. The rows do not say which build ended a task, so the judge cannot either |
| The list of files that may call the invariant library directly | 2, syntactic: it reads the text `engineInvariantViolations(` in a file | Written and run. `suite.ts` is on the list for its scenario cases. With the suite's seeded races switched back to `engineInvariantViolations(fx.raw)`, which is finding 3 itself, the case passes. It fails only for a file that is not listed, which was run too: the identifier surface switched back fails it by name |
| The registered mutation that drops the durable string refusal from the family | 3, and it holds one line | Written and run. With `ChildAwaitRefusedError` out of `isPortRefusal` and the expectation that named it out of the core case, the core case passes, and the registered mutant would still be caught, so the registry stays green. The hosted route's table case, which is not registered to any mutation, still fails by name, and it is the only reader of that line |
| `TaskDoneEventName`, the type the recording statement takes | 1 for typed code | A cast: `eventName: EventName.fromPort('emitEvent', 'paid') as never` compiles. The refusal when the statement is built stays for that caller, and the case that holds the type through an expected type error also holds that refusal, so the pair has no false negative for a caller's event |

## Fix-induced defects

None of the five was introduced by a fix for another finding of this round.
Two were introduced by the pull request's own later steps, which is the same
lesson one level up. Finding 1 lives in the excusal that the fault matrix
needed once it gained the child-task checker, so the step that strengthened
the matrix also wrote its one blind spot. Finding 2 was true when it was
written and was made false by the second merge of main, which changed the
facts under two lines of the body.

The fold was tested again and was not reviewed again. It changes no behaviour
of the product: a type that exists at compile time, test machinery, five
registered mutations, and prose. Its one new guard, the condition on the row's
state, has its false negative in the table above.

## Evidence

- Red tests: commit `9bfe9dc`, probe `packages/conformance/test/fault-matrix-history-checkers.test.ts` `holds the child to the rule in a cell where the older build never ended it`, run and seen failing (1 test) against `2465b9e`, the reviewed head. The cell with one task's completion event dropped from its `complete` answered `resolved`, and the same bend aimed at another task of the workload was rejected, which is the control.
- Fixes: commit `573313c` for finding 1. Gate after the fix: the four cases of that file pass, the registered mutation that drops the new condition is caught by that case, exact-only, and the gates named in the pull request's body ran green on the merged head.
- Red tests: none of this round's own for findings 2, 3, 4 and 5, so this line cites no commit. They are sentences, of a pull request's body, of BUILD.md, of a comment, and of DESIGN.md, and no test reads prose. For finding 3 the converted sites were run on three dialects and passed, so there was no failing case to commit.
- Fixes: commit `894ffb4` converts the three sites and commit `b369157` adds the list that gives the claim a reader, for finding 3. Commit `2b25cc5` narrows the class comment, for finding 4. Commit `b4a0e8d` corrects DESIGN.md and BUILD.md, for findings 3 and 5. Finding 2 lived in the pull request's body, which is no file of the repository, and is corrected there. Commit `a8ee9a2` registers the five mutations.
- Finder: the one full review of this pull request, which ran the built-in code review skill once and checked each of its findings. Its verdict: "I found nothing HIGH or MEDIUM, and nothing that loses, duplicates, or misattributes durable state. There are nine LOW findings. Most are in test machinery or wording; one is about the hosted mapping."
- What the review confirmed, with its own probes. The memo's red case fails by name at its commit on three dialects and passes at the head, and fails again on libSQL with only the forget after a won `fail` removed. With the excusal widened to every missing event all three cases of the matrix file fail, and with nothing excused two of them do. Of the touched names only `InvalidDurableStringError` and `SchedulerStore` are released, and both declarations are untouched. Main's registry and the head's hold the same entries, five differ, and only in find and replacement.
- What is not counted, and why. No mutation was registered for the five new guards, but an existing test killed each by hand, so no hold was unable to fail. They are registered now. DESIGN.md gave "no route can raise it" as the reason a refused number stays at 500, while the mapping answers a child-await refusal that no route can raise either. No sentence there was false, and the reason given now is membership of the family. The cost of the added reads was unmeasured, which is an absence and not a claim. A name type that carries its task was optional, and is built.
- Claims that did NOT reproduce. The sentence the reviewer could not verify, that a task's recorded failure carries the new error name, is true of the path it names: a case has task code call a port past the SDK and let the refusal escape, and the recorded failure is named `PortRefusalError`. DESIGN.md now says which path that is. The worry that every checker costs the matrix time did not reproduce: the slowest PostgreSQL starting state took 57.9 s on main and 57.5 s on the branch, the means of three interleaved runs on a server of the measurement's own, with a spread of two to three seconds inside each. The author's own suggestion, that the generated stale-token column should call the helper, did not survive a run: 16 of its 17 cases fail under it on libSQL, because the column judges the poison matrix's seeds, which end a task by hand and carry no completion event. It stays on the invariant library and is on the list with that reason.

## Root cause

Each of the five was checked along the axis its author had in mind and along
no other. The excusal's cases and mutations asked which task is excused and
never in which state, because the excusal was written as a position in the
workload and a position has no state. The sentences were read against the
diff and never against the tree, and two of them were universals, which only
the tree can check. The body's lines were read when they were written and not
after the merge that changed what they described.

The machinery is built the same way. A mutation bends a guard that exists. A
case exercises a scenario someone predicted. The registry's self-test reads
finds, the package smoke reads exported names, and nothing reads a claim. So a
missing guard and a wide sentence have one property in common: there is no
line for an instrument to fail on.

## Mechanisms

Built in this PR:

- The matrix's judge reads the state of the row, in
  `packages/conformance/src/fault-matrix.ts`, with a case committed failing and
  a registered mutation that drops the condition (rung 3, a proxy for which
  build ended the task).
- A case in `packages/conformance/test/history-judges.test.ts` lists the files
  that may call the invariant library directly, with the reason of each
  (rung 2, syntactic).
- Five registered mutations, one for each guard this pull request added,
  each owned by a case that already existed (rung 3).
- `TaskDoneEventName`, a type that the recording statement takes, with the
  refusal kept for an untyped caller (rung 1 for typed code). It answers the
  review's optional point and no counted finding.

Deferred (recorded in BUILD.md):

- Telling the older build's ending from the current build's by more than the
  row's state. The rows do not record which build ended a task, and no batch
  of the workload cancels that child under the current build.
- A check in the attestation that refuses a body whose stated registry count
  or arm key is not the head's. Nothing holds a body to the tree today.
- The listed files. A file on the list can gain a site that judges rows the
  engine wrote by the library alone, and the suite's scenario cases are such
  sites today.

## What this round still would not catch

- A cancel of the older build's child by the current build that loses its
  completion event, in a cell where the older build's own cancel died. The
  judge would excuse it, as the first row of the audit shows.
- A new seeded race in a file that is already listed, judged by the invariant
  library alone. The list reads file names and the text of a call.
- A sentence of DESIGN.md, BUILD.md, a comment, or a pull request's body that
  says more than the code. Four of this round's five were of that shape, the
  class has recurred in every recent round, and nothing built here reads
  prose. A universal written from a diff is the likeliest next instance.
- A pull request body whose figures go stale when main is merged after it was
  written.
- A guard that is missing. Every instrument of this project fails on a line,
  and a missing guard has none.
