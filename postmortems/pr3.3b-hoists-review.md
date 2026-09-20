# Postmortem: PR3.3b hoists review (PR #68)

PR #68 builds the three hoists the second review of child tasks deferred: a
statement names its event lock where core defines it, a batch that ends a task
and records no completion event is refused when it runs, and the child await's
engine logic exists once, in core. It passed every local gate, including the
unfiltered mutation audit and the base gate, and its CI was green. One full
review then recorded every batch of the corpus scenario at the base and at the
head, found the arguments byte-identical in all of them, and found that the
new rule refuses a legal write: it read a caller's run id as the state a
statement gives a task. It also found three things the pull request said, or
left unsaid, that were not so. Four findings are counted.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding is a legal write refused. `deferLaunch`, `reschedule` and
`suspendRun` copy a run's state into its task, and the filter of that copy
binds the caller's run id. The rule that holds a terminal write to its
completion event read every value node below the value a statement gives
`tasks.state`, so a run id of `failed`, `completed` or `cancelled` read as a
terminal state with no completion event, and the batch refused itself with a
plain error before anything was sent. Main answers `LeaseLostError` for a run
nobody has, whatever its id spells. Engine ids are UUIDs, so only a malformed
or hostile worker call reached it and no durable state was at risk. It would
still have shipped under the words "behaviour is unchanged", and the same
reading would have misfired on the first state expression that compared
against a terminal literal, the condition of a CASE arm for one.

The second is a net that was named and is not there. DESIGN.md, BUILD.md, the
pull request's body and a test comment said a dialect's facts are held by the
conformance suite on that dialect. The review made `liveTask`, `taskOwnsRun`
and the stored payload's type each wrong in the libSQL store: all 28
child-task cases still passed with each, all 145 cases of the batch that uses
them passed with all three wrong at once, and one libSQL store test caught the
payload type. Main had the same gap, so nothing got worse, and a reader was
told it was closed.

The third is a release note that was not written. The pull request said
behaviour is unchanged and did not say that the released types changed:
`FencedBatch.lockEvent` is gone, `DefinedStatement` gains a required
`eventLock`, `DerivedSet` takes no text for a task's state, and a libSQL batch
whose statements name two events throws where main sent it.

The fourth is a build-time refusal that got narrower in silence. A batch that
declared an event lock had to follow it at once with a compare-and-set. An
event lock now arrives with the statement that names it, so that rule binds a
claim lock alone. Nothing is unsafe, because the executor takes a batch's lock
before its first statement whatever that statement is, and no shipped batch
has the shape. No `gate-changes:` line said so.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The terminal-state rule read every value node below the value a statement gives `tasks.state`, which includes the caller's run id bound in the filter of a copied state | `deferLaunch`, `reschedule` and `suspendRun` with a run id of `failed`, `completed` or `cancelled` throw a plain error where main answers `LeaseLostError`, on every dialect, and any later state expression that compares against a terminal literal would be refused as the end of a task | The identifier surface, which is generated from every place an identifier enters the port and sends each one adversarial identifiers | Its identifiers were adversarial in length alone, and it ran over a recorder, so no entry ever built a batch from a word that means something to the engine. The rule's own exhibit asks what the rule misses, and nothing asks what it refuses | The rule reads what the column can receive, `receivedNodes` (2). Six registered mutations with a case each (3). The identifier surface answers a word that spells a task state as it answers any other, at every entry, on a database, on every dialect (3) |
| 2 | Four texts said a dialect's facts are held by the conformance suite on that dialect, and nobody had run the suite with a fact wrong | A reader trusts a net that is not there: every child-task case and every case of the recording batch passes with all three facts wrong, and one libSQL store test catches one of them | The false negative written and run for the hoist, which is where "what holds it" was written | The exhibit ran in core against a hand-made dialect. The sentence about what holds a wrong fact is about a store under the conformance suite, and nothing was run there | The texts say what holds each fact and what holds none (none: prose). The poison case that would hold them is recorded under PR3.10 |
| 3 | The pull request said behaviour is unchanged and did not say the released types changed | A consumer of the published packages meets a class without a method it had, a definition with a new required member, and a batch that throws on libSQL where it was sent | The published-surface check that the package smoke runs | It compares exported names, and no name left. A method of an exported class is below what it reads | The body and BUILD.md's entry name the four changes (none: prose) |
| 4 | The rule that a locked batch opens with a compare-and-set stopped binding event-locked batches, and no `gate-changes:` line said so | A batch that holds an event lock and opens with a read is admitted where main refused it. Nothing is unsafe and no shipped batch has the shape | The rule's own case in core, which declared an event lock and then added a read | The commit that deleted `lockEvent` rewrote that case to declare a claim lock, so the case kept passing while the rule's reach shrank | DESIGN.md §3.4 rule 2 and a `gate-changes:` line say the rule binds a claim lock alone, and why that is safe (none: prose) |

## Detection ledger

The branch had passed every local gate before the review read it: the
unfiltered audit at 899 of 899, conformance on three dialects, the fuzz, and
the base gate. Its own machinery had found real things on the way. The first
unfiltered audit sent seven mutants down a wrong path, which is how the rule's
reach into the conformance suite was seen and the five mutants re-aimed, and a
direction from the maintainer stopped a first version of the rule, which read
fragment text, before it was committed. Neither is a finding of this round.
Every counted finding came from the review.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #68: the built-in review skill as one forked agent, and the reviewer's own probes with main as the control | 4 | No |
| This project's machinery: the tree rules and their mutations, conformance, the corpus, the fuzz, the identifier surface, the published-surface check | 0 | Yes |

Self-catch rate: 0 of 4, or 0% (previous round: 9%).

The rate is not improving. The round before this one caught one finding of
eleven itself, and the three before it caught none. The review that found
finding 1 did what no layer here does: it asked of a new refusal what legal
input it refuses, and answered by running the port with main as the control.

## Recurrence

**A proxy standing where a property fits. Recurred, twice inside this pull
request.** The property is whether the value a column receives names a
terminal state. The first version of the rule read fragment text, which the
maintainer stopped before it was committed, and the milestone's exit test was
reworded to ask for a declared node or field. The second version read declared
nodes, all of them. "It reads nodes and not text" was then taken for the
property, and it is half of it. The other half is which nodes: the ones the
column can receive. A correction away from one proxy landed on the nearest
thing that was not that proxy. The earlier mechanisms are each a fix to one
proxy, and the last two postmortems each said that no check asks of a new
reading whether it is the property or a picture of it. This round adds no such
check either. It adds, for one kind of input, a generated probe of the side
nobody was asking about: what a rule refuses.

**A check's own test edited to agree with a weaker check. Recurred.** The
review round of PR #59 met it first, in a lint's self-test, and recorded it
under what would still ship. It shipped here in another place. Main's case for
the rule that a locked batch opens with a compare-and-set declared an event
lock and then added a read. The commit that removed `lockEvent` had to change
that case, changed it to declare a claim lock, and the case went on passing
while the rule stopped binding the batches it had been written about. The
mutation audit could not see it, because the rule's mutants are held by the
rewritten case. The vehicles of finding 5 of the review, which is not counted,
are the same shape: cases in two more files were moved off a terminal state
written as text, and the `gate-changes:` line named core's cases alone.

**Spec or plan text that says more than was run. Recurred in every recent
round.** Findings 2 and 3 are this class, as were findings of the rounds of
PR #51, the sagas, PR #57, PR #59 and PR #63. Finding 2 has a sharper form
than before: the sentence was written inside the discipline that exists to
stop it, the false negative of a mechanism, and it named a layer the exhibit
never ran. No mechanism exists and this round adds none.

**A change to a released type that nothing reads.** I can find no earlier
round that met it. The published-surface check is a list of names, which is
the first class again: the property is what a consumer can compile against,
and a list of names stands in for it.

## Mechanism audit — the false negative of each

Each row was written and run against the fixed code, in a scratch worktree
with its own install.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The rule reads what the column can receive: the value, each result of a CASE, what a subquery selects from a table or from another subquery, and anything else below the value as an operand | 2, and it reads declared nodes, so it is the property only as far as a name stands where the column receives it | `select g.state from runs as g where g.run_id = 'r1' and g.state = 'failed'` as the value: the column receives `g.state`, which names nothing, the filter lets a failed run through alone, and the batch is accepted and sent with no completion event. Reading every node caught this one, by the accident that also refused a legal write. `'fai' \|\| 'led'` as the value is accepted and sent too, and no reading of names ever caught it. Both are accepted exhibits in `fenced-batch-tree.test.ts`, each beside a control the rule refuses. Ran |
| Six registered mutations of `receivedNodes`, a case each | 3 | `receivedNodes` patched to take what a subquery orders by as well. Core's suite passes, 610 tests, and both conformance cases pass on three dialects. A copy ordered by `coalesce(g.failure_reason, 'failed')` is then refused as the end of a task, where the head accepts and sends it. Ran. The cases name a filter, a join condition and a CASE condition, and no other clause that chooses a row |
| The identifier surface answers a word that spells a task state as it answers any other | 3 | The libSQL store patched so `deferLaunch` refuses a claim token that spells a terminal state. Both conformance cases pass on three dialects, and `deferLaunch('q', 'no-such-run', 'failed', 1, 5)` then throws a plain error where the head answers `LeaseLostError`. Ran. The surface varies identifiers, and a claim token, a payload and a header are not among them. It also calls every entry on a database that holds no such run, so a statement a store builds only after it finds the run is never built from the word |

Findings 2, 3 and 4 have no mechanism, so they have no row.

## Fix-induced defects

None found. The fixes were not reviewed as new code: this pull request has no
second review unless the fold changes what the product does beyond the
finding, and it does not. They were re-tested, the reviewer's probe was run
again with main as the control, and each mechanism's false negative was run.
One slip inside the fold was caught before its commit. The new case of the
identifier surface first made all of an entry's calls at once, as the surface
does over a recorder. Over a database they raced, 115 refusals were reported
as unhandled, and the run exited 1 with every test passing. The case now
starts each call when it is awaited.

## Evidence

- Red tests: commit `ff31489`, probe `packages/conformance/test/libsql.test.ts` `a run id that spells a task state is only an id, and a run nobody has holds no lease`, run and seen failing (3 cases, one for each dialect, beside 2 core cases) against `5ed787d`, the reviewed head as it stands on this branch. On each dialect the case reports `"deferLaunch failed": "Error"` where it expects `"LeaseLostError"`, and the same for `reschedule` and `suspendRun` and for the ids `completed` and `cancelled`, 9 of its 15 answers. The two core cases fail by name, "does not read the filter of a copied state, where a run id is a caller's string" and "does not read the condition of an arm", each with the rule's own refusal. Both were seen failing again at this commit after the branch was rebased, in a scratch worktree with its own install.
- Fixes: commit `6bc3030` narrows the reading, which turns all five green. Gate after the fix: core's suite, the three store suites, conformance on three dialects with main's self-concurrency surface, the fuzz, the probe's self-test and the unfiltered audit at 907 mutations, and the base gate with the arm live, each at exit 0. The pull request's body carries the gate table.
- Fixes: commit `0d0a92a` corrects the texts of findings 2, 3 and 4 in DESIGN.md, BUILD.md and a test comment. They have no red test, because no test reads prose.
- Finder: the one full review of PR #68. Its verdict: "The refactor holds up on three dialects, with one reproduced behaviour change that should be fixed before merge and six low-severity items."
- The reviewer's probe, run again as a case of the shared suite with main as the control. On main all 15 answers are `LeaseLostError` on libSQL, PostgreSQL and MySQL. On the reviewed head 9 of the 15 are a plain error on each. On the fixed head all 15 are `LeaseLostError` on each. The reviewer ran `deferLaunch` alone and read that `reschedule` and `suspendRun` share the helper, and the case shows they fail the same way.
- The class, on the unfixed code. The new case of the identifier surface sends the six state words to every entry of the port, 56 calls a word. The case arrived with the fix and is not in the red commit. Laid over the red commit, it fails on each dialect at three entries, the run id of those three writes, and at no other. On main and on the fixed head it passes on each dialect. So no other entry of the port reads a caller's identifier as a state today.
- Every finding was checked before it was folded, and none was refuted. Three of the review's seven items are not counted. Its finding 4, a sentence of an older BUILD.md entry that described `lockEvent`, is corrected. Its finding 5, two files whose cases moved off a terminal state written as text, is now named in the body's `gate-changes:` line with why nothing weakens. Its finding 6, the same 33 lines of `taskDoneDialect()` in each store, stands as the body's simplify dispositions say, because the batch lint refuses the collapse.
- What did not reproduce. A wider reach was looked for and not found: the identifier surface's new case fails at three entries and nowhere else, and no other shipped statement binds a caller's string below a value it gives `tasks.state`. The wrong-fact probes are the review's, and they were not run again here. The review did not run the whole libSQL conformance file or the fuzz with the facts wrong, so the corrected texts say what it ran and no more. Main's self-concurrency surface arrived while this was folded, and because this pull request moved where the event lock is taken, conformance ran on three dialects on the rebased branch before anything else: all 37 contests of each dialect pass, with the executors' count of deadlock victims held at zero.

## Root cause

Every check this pull request ran on its new rule asked one question: what
does the rule miss. The mutation audit asks it of every condition, the
postmortem discipline asks it of every mechanism, and the exhibits answer it
with a statement the rule accepts. Nothing asks the opposite question of a
new refusal, which is what legal input it turns away, and a rule that reads
too much answers the first question better the more it reads. The statements
the rule's cases were built from were all written by the author of the rule,
with run ids such as `r1`. The layers that send a caller's strings, the
identifier surface and the fuzz, vary length and volume and never meaning.

Findings 2, 3 and 4 share a second cause. A claim was as wide as the sentence
and as narrow as the instrument. "Behaviour is unchanged" was measured by the
SQL corpus and conformance, which hold SQL and answers and not types. "Held by
the conformance suite" was written beside an exhibit that ran in core. The
rule that narrowed kept a passing case because the case was edited with it.
In each, what ran was true, and the sentence said more than what ran.

## Mechanisms

Built in this PR:

- The terminal-state rule reads what the column can receive (`receivedNodes`
  in `packages/core/src/sql-tree.ts`), rung 2. It is closer to the property
  and is still a reading of names.
- Six registered mutations of that reading, each with a verdict case in
  `fenced-batch-tree-verdicts.test.ts`, and the three mutants of the reading
  line re-aimed, rung 3.
- The identifier surface (`packages/conformance/src/identifier-bound.ts`)
  answers a word that spells a task state as it answers any other, at every
  entry of the port, on a migrated database, on every dialect, rung 3. It
  extends a generated surface, so a new port method is held to it by the type
  that already refuses a method with no entry.
- The shared suite's case of the three writes, rung 3, which is the red test.
- Two accepted exhibits of where the narrower reading stops, beside refused
  controls.

Deferred (recorded in BUILD.md):

- A poison case for the batch that records an unrecorded ending, over rows
  where a run's claim outlives its task or names a task of another queue,
  under PR3.10. It is larger than this pull request, main has the same gap,
  and on consistent rows the batch's own claim predicate implies both facts.

## What this round still would not catch

- A terminal state that reaches a task through a copy ships today with no
  completion event, as it could before, and now also when the copy's own
  filter lets a terminal run through alone. `childTaskViolations` reports it
  after the fact, over the rows.
- A state the database assembles from pieces that name none ships today, as it
  always could.
- A task inserted by an INSERT ... SELECT whose state is named in a table that
  SELECT reads from or joins ships today with no completion event, as it
  always could: for an INSERT the rule reads the selection at the state's
  position and never that SELECT's sources. The fold's derived-table and
  joined-table cases hold a subquery given as a value, and not this. The
  re-review of the fold found it, and it is an accepted exhibit now, beside a
  refused control. No shipped statement has the shape.
- A copy of one column of a derived or joined table is refused as the end of
  a task when another column of that table names a terminal state, because
  the rule reads every column such a table selects and not the one the outer
  query takes. It is the over-read of finding 1 one level down. It is
  conservative, no store builds the shape, and an exhibit holds it beside a
  control the rule accepts. The re-review of the fold found it.
- A reading that came to take a clause which chooses a row, other than a
  filter, a join condition or a CASE condition, passes every case and refuses
  a legal write. No case names ORDER BY, GROUP BY, HAVING or LIMIT.
- A caller's string that is not an identifier, a claim token, a payload, a
  header or an error, read as something the engine means, passes the
  identifier surface. So does a misreading in a statement a store builds only
  after it has found the run.
- A new build-time refusal of any other kind ships with nobody having asked
  what legal input it refuses. The identifier surface asks it of identifiers
  that spell a state, and of nothing else.
- A sentence in DESIGN.md, BUILD.md or a pull request's body that says more
  than was run ships today, as in every recent round, and so does one written
  as the answer to "what holds this false negative".
- A member removed from, or made required on, a released type ships with the
  published-surface check green, because the check reads exported names.
- A case edited in the same commit as the rule it holds, so that it still
  passes while the rule's reach shrinks, ships today, as the round of PR #59
  said it would.
