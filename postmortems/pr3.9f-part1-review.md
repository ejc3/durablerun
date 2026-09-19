# Postmortem: PR3.9f part 1 review (PR #57)

PR #57 builds the eight reads a store sends outside a transition as statement
trees, sent as batches of reads. It passed every local gate, including the
unfiltered mutation audit, and its corpus showed that no statement main
enrols had changed. One full review then found no wrong answer: it ran main's
store and this branch's over one database on all three dialects and every
read agreed. It found eight defects of other kinds. Every read was built,
checked and compiled again on each call, about a hundred times the cost of
the text it replaced, on a path every driver tick runs. Two reads bound a
state that the text had written inline. The spec contradicted itself on who
may hold the clock, overstated the plan pins, and did not say that a read now
throws when an executor answers short. Three were latent: a refusal that
would be misread as a lost lease, a clock read counted before the read was
admitted, and a reason accepted where it excuses nothing. Our own machinery
found none of the eight. All eight are fixed here, two of them as a red test
and a fix.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding is a cost nobody measured. `next-wake` and the sweep's two
scans run on every driver tick. As text they cost about 1 and 2 microseconds a
call to send. As trees they cost about 120 and 160, all of it synchronous
work on the event loop: build the tree, walk it for every rule, compile it.
Nothing was wrong in any answer, so no test, no corpus entry and no plan pin
could see it. This repository has already had a CI failure from a chain of
small synchronous calls stalling one worker, and a driver that ticks many
queues pays this on each of them.

The second would have cost an index later. `claimed-task-name` bound
`'running'` and `get-checkpoints` bound `'committed'`, where the text wrote
both inline. Both reads seek by primary key, so no plan changed. A partial
index is matched by the literal in a statement's text, and the header of the
shared reads says a state stays the dialect's own text for that reason. The
next read to copy the shape onto `runs_lease` or `tasks_cancel` would have
walked the table, and the corpus would have recorded only that it takes one
more bind.

The rest would have misled a reader or a caller. A port written from DESIGN.md
would have refused every read that holds the clock, because one bullet still
said only a compare-and-set may. A statement the builder refused inside the
refusal-state read would have told a worker whose task was cancelled that it
had lost its lease.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Every read was built, checked and compiled again on each call | About 120 microseconds of synchronous work for `next-wake` where its text cost 1, on every driver tick | The store's own tests, or the query-plan suites | Every layer asks what a statement answers or what the database does with it. None asks what it costs to make | `prepareRead` and `readPrepared` build a read once, with a store test that a second call compiles nothing and a check that every prepared read stands at module scope (3) |
| 2 | Two reads bound a state the text had written inline | None today. A read copying the shape onto an indexed state loses its partial index | The corpus, which exists to show a change in compiled SQL | The reads were new labels, so the corpus had no earlier entry to differ from, and it records a bind's count and not its value | A batch of reads refuses a state or status column compared with a bound value, and `literalValue` writes one inline (2) |
| 3 | DESIGN.md said both that only a compare-and-set may hold the clock and that a read may | A port built from the spec refuses every read of the clock | Review of the spec in the same diff | Nothing reads DESIGN.md against itself | One rule, stated once (none: prose) |
| 4 | DESIGN.md said the query-plan suites pin the reads, and PostgreSQL's pins none | A reader trusts a pin that does not exist | The same | The same | The sentence names the two suites that do, and the one that does not (none: prose) |
| 5 | A read throws when an executor answers with fewer results than statements, where the text read no row | A contract point changed and nothing said so | The spec | The executor's contract was never written down, so a change to who holds it was invisible | DESIGN.md and the executor's interface state it, and a core test holds a read to it (3) |
| 6 | A statement the builder refuses inside the refusal-state read is reported as a lost lease | A cancelled run would answer lease-lost | The conformance cases for refusals | They refuse a write and read the state, and the read's construction never fails in them | The batch is built before the read is handed to the caller that classifies a failed read (1, by where the code stands) |
| 7 | A read was counted as a clock read before the rules that could still refuse it | A batch whose first clock read was refused then refused its only held one as a second | The verdict tests of the clock rule | Each builds a fresh batch for each refusal, so none reuses a batch after one | The count comes last, and a core test reuses a batch after a refusal (3) |
| 8 | The reason for a second read of the clock was accepted on any read, and restated in three stores | A reason outlives the read it excused, and nobody is asked again | The rule that asks for the reason | It asked only whether a second clock read lacked one | A reason is owed by a second read of the clock and refused anywhere else, and the sweep's is one constant (2) |

## Detection ledger

The branch had passed every local gate, with the unfiltered audit at 847 of
847, before the review read it. Every finding came from the review. The audit
did catch one defect of mine before review, a verdict test whose unmarked
expectation failed ahead of its marked one, and that is not counted here
because no reviewer had to find it.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #57: eight finder angles, a verifier, and the reviewer's own runs on libSQL, MySQL 8.4 and PostgreSQL 17 | 8 | No |
| This project's machinery: conformance, corpus, plan pins, lints, mutation probe | 0 | Yes |

Self-catch rate: 0% (previous round: 0%).

Two rounds on this work at zero is a pattern and not a bad week. Part 3c's
round and this one both reviewed statements moving from text to trees, and
the machinery's claim about such a move is equivalence: same rows, same
compiled SQL, same plans. The review confirmed that claim and found nothing
under it. Everything it found sits beside equivalence, in what a statement
costs to make, in what the spec says, and in paths no test walks.

## Recurrence

**Client-side cost of the tree path. Recurred.** Part 3c's round measured a
store call and found about two fifths of its time in reading node fields
generically, once for every check, and changed the checks to walk a tree
once. That was a fix to one cost, with no test behind it. The mechanism this
work relied on for cost is the query-plan suites, and they hold what the
database does with a statement. They are a proxy for cost that is blind to
everything before the statement is sent. So the same class came back as soon
as a hot read became a tree.

**A partial index against the text of a statement. Recurred.** The PR gate
has carried this trap since the first plan suite: an index's predicate must
be implied by the query's text. The mechanism was the plan pins. They passed
here because both reads seek by primary key, so the pins were true and the
shape was still wrong for the next read to copy. A pin holds a plan, and a
plan is a property of one statement and one index. The rule the reads' header
states is about every read, and until this round nothing held it.

**Spec text left behind by a change. Recurred in every recent round.** PR
#51's round, the sagas round and this one each found DESIGN.md saying
something the diff had made false. No mechanism exists for it and this round
adds none. One statement of a rule is easier to keep true than two, which is
all that finding 3's fix does.

**A failure read as another kind of failure.** PR3.11c's round found the
inverse, a refusal read as a store outage, and gave the store's answers
names. Finding 6 is the same family from the other side: a catch written when
only the executor could throw inside it kept its meaning after the builder
could too. The earlier mechanism named answers and did not reach this catch.

Findings 7 and 8 are not instances of an earlier class that I can find.

## Mechanism audit — the false negative of each

Each row was written and run against the fixed code.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A batch of reads refuses a state column compared with a bound value | 2, syntactic: it reads a comparison built from nodes, column on the left, a bound value on the right | `.where(predicate('state = ?', ['running']))` binds the state inside a store fragment, and `.where('state', 'in', ['running'])` binds it in a one-state list. Both were admitted by `readTree`. Ran. A fragment is opaque text to a tree, and the list rule reads only lists of two or more |
| A second call of a read compiles nothing | 3, through a spy on the store dialect's compiler | A call site that passes `tree: new TreeDialect(new SqliteQueryCompiler())` makes a dialect on every call. The shape is kept for each dialect object, so every call prepares again, at 237 microseconds for `next-wake`, and the spy watches another compiler and sees nothing. All seven cases passed. Ran |
| Every prepared read stands at module scope | 3, syntactic: it counts `prepareRead(` against `const NAME = prepareRead(` in a store's sources | Before this check existed, `task-done-state` prepared inside its method passed all seven cases, because that read is reached only through a transition and no case can call it alone. Ran. With the check, the row above is what still passes |
| A prepared read must compile to one statement whatever values it is sent | 2 | A build that branches on a value, `binds.attempt > 0 ? A : B`, is admitted when both stand-ins take one branch. The stand-ins for a number are negative, so shape B was kept and then sent with 5. Ran. Two stand-ins show that a shape depends on a value only when they differ in the way the build tests |
| A reason is owed by a second read of the clock and refused anywhere else | 2 | `readTree('b', due(), 'x')` is admitted as a second clock read. Ran. The rule holds where a reason stands and cannot hold what it says, as an open tail's reason cannot |
| refusal-state's batch is built before the read is handed on | 1 by placement, with no test | Moving the two lines back inside the returned function passes the libSQL store suite, 89 tests, and the 72 refusal cases of the conformance file. Ran. Nothing can make the builder refuse this read from outside, so nothing holds where it is built |
| A read is counted as a clock read only after every rule admits it | 3, one regression case | A rule added after the count would reopen it, and the one case exercises only the spelled-clock rule. Not run: it is a statement about a rule that does not exist |

## Fix-induced defects

Two, and our own machinery caught both before any reviewer read the fixes. The
prepared read first kept what it compiled to in a `Map`. A read is prepared
wherever it is first sent, and the SDK has a test that first sends one inside
a task that has replaced the global `Map`, so the run ended in a throw. The
unfiltered audit stopped at a red worker baseline on that test. The record is
now core's captured WeakMap and a plain list, a core test prepares a read
while `Map` and `WeakMap` are both replaced, and the fix is part of the commit
that made the defect, so no commit carries it.

The second was in the tests of the new read rule. Two of them matched the
rule's answer against a pattern. A mutant that admits the read answers null,
and the matcher refuses a value that is not a string before it prints the
marker, so the unfiltered audit reported both mutants as caught on the wrong
path. Commit `dc0c806` matches the answer as text. This is the second time in
this pull request that a verdict test of mine failed somewhere other than at
its marker. The first was an unmarked expectation standing ahead of a marked
one, before the review. The audit caught both, and it is the only thing that
can: nothing at build time reads a verdict test for what it does when its
mutant is live.

Neither is in the findings table, because no review found them.

The fixes have not been re-reviewed as new code. They were re-tested, and the
machinery caught three smaller slips inside the fold before any commit. MySQL's inventory of store methods refused the new `rows` helper until
it was named internal. The probe's self-test refused two mutants whose libSQL
lines the rewrite had moved. The linter refused a `typeof` compared with a
value that is not a literal. At most one narrow re-review of the behaviour
changes follows this fold.

## Evidence

- Red tests: commit `925a0c4`, run and seen failing (3 tests) against
  `c1a6024`: `claimed-task-name` sent `['r1', 'q', 'w1', 'running', 1, 1]`,
  `get-checkpoints` sent `['t1', 'q', 'committed', 2]`, and a bound state was
  admitted. Commit `f0fbd5d`, run and seen failing (7 tests) against
  `1836694`: "the second call compiled a statement again: expected
  compileQuery to not be called at all", once or twice for each read, and the
  source check listed nine `readTree` calls in a store.
- Fixes: commit `e9aaf7c` (finding 2), `1836694` (7 and 8), `c6e0c9d` (1 and
  6), `81e825e` (3, 4 and 5), `23c59dd` for BUILD.md and the base gate's arm,
  and `dc0c806` for two verdict tests. Gate after the fixes: core 558 tests,
  the SDK and driver suites, the three store suites, the corpus test on three
  dialects, the probe's self-test at 860 mutations, and the base gate against
  main with the arm live, each at exit 0. The pull request's body carries the
  full gate table for the final head.
- Finder: the one full review of PR #57. Its verdict: "No HIGH finding. The
  converted reads return the same rows as main's text on all three dialects.
  The defects found are a hot-path cost, two spec contradictions, and latent
  or stale items."
- Measured, over an executor that does nothing, three interleaved rounds of
  5,000 calls with main as the control. Before: main 1.1, 2.4 and 1.5
  microseconds a call for `next-wake`, the sweep's scans and `task-result`;
  this branch 120, 160 and 57. After: main 1.1, 2.3 and 1.5; this branch 3.2,
  4.4 and 1.6.
- Every finding was checked before it was folded, and none was refuted. The
  review marked three as not reproduced. Finding 6 was confirmed by reading
  the catch, finding 5 by reading `run`, and the two stale registry figures
  by running both mutants: 7 of 538 core tests fail with the open-tail test
  gone, and 250 with `!isCas` gone, where the text said 245 and 226 of 472.
- Two of the review's ten items are not counted: text in tooling and review
  rules that named what the reads removed, and the two registry figures. Both
  are corrected in `81e825e`.

## Root cause

Every layer this work leaned on asks one question of a statement that moves
from text to a tree: is it the same statement. The corpus compares compiled
SQL, the plan suites compare plans, conformance compares behaviour, and the
review confirmed all three were right. A move from text to a tree changes two
things none of them reads. It changes when the statement is made, from once
at module load to once a call. And it changes which parts of the statement
are values, because a builder binds what text would have written inline.
Neither is a difference in the statement the database runs today, so a
machinery built on equivalence is structurally unable to see either.

## Mechanisms

Built in this PR:

- `prepareRead` and `FencedBatch.readPrepared`, rung 1 for the stores that use
  them: a prepared read cannot be rebuilt by a call. A store test holds that a
  second call compiles nothing, rung 3, and a source check holds that no
  store sends an unprepared read or prepares one outside module scope, rung
  3 and syntactic. Three registered mutations hold the prepared path.
- A batch of reads refuses a state or status column compared with a bound
  value, rung 2, in `packages/core/src/sql-tree.ts`, with `literalValue` for
  the inline form and six registered mutations.
- One rule for a batch's reads of the clock, `countClockRead`, rung 2: a
  reason is owed by a second read and refused anywhere else, and a read is
  counted last. Seven registered mutations hold it.
- The executor's contract, written in DESIGN.md and on the interface, with a
  core test that a read holds an executor to it, rung 3.

Deferred (recorded in BUILD.md):

- A state bound inside a store fragment, and a one-state list of a bound
  value, still pass the read rule. Both wait for PR3.9f part 2's decision
  about fragments, which is the same question: a tree cannot read a
  fragment's text as anything but text.

## What this round still would not catch

- A transition whose cost to build grows. Every write is still built, checked
  and compiled on each call, by design, and nothing measures it. A defect of
  the shape "a hot write became several times slower to make" ships today.
- A read prepared for a dialect object made on each call ships today, at
  twice the cost this round removed.
- A read that binds a state inside a fragment, or in a one-state list, ships
  today and loses its partial index the day it is pointed at one.
- A build that branches on a value the stand-ins do not separate ships today
  and sends the wrong shape.
- A sentence in DESIGN.md that a diff makes false ships today. It has in
  every recent round.
- A statement the builder refuses inside any other catch that reads a failure
  as an answer ships today. Only the refusal-state read was moved.
- A verdict test that fails ahead of its marker is caught only by running its
  mutant, which the unfiltered audit does and nothing earlier does.
- New core code that reaches for an ambient global is caught only where an
  SDK test happens to run that path under a replaced global. This round's one
  such slip was caught that way, by luck of where a read is first sent.
