# Postmortem: PR3.4c saga port and freezes review

PR3.4c changes a published port. `failRollback` takes the step and the failure
of this attempt, and the store names the rollback's attempt record and counts
the attempt, where a caller used to hand over both the name and the count. The
store also refuses a child spawn inside a saga's rollback phase on three
dialects, every frozen durable call of the SDK has a case that fails when its
freeze line is deleted, and a saga case holds the pass budget at its bound for
a task that has infrastructure retries. The pull request's one review found
nothing HIGH or MEDIUM and four LOW items, one of which the pull request's
body had already rejected with a written reason. Three are counted here, under
the rule earlier rounds were counted under: a product defect counts, and so
does a claim that is false or says more than was shown. One is a defect in
arithmetic this pull request moved into core. Two are passages of DESIGN.md
that said more than the code holds.

## Severity

Nothing here loses, duplicates or misattributes durable state in a history the
engine can produce. Without the review the following would have shipped, worst
first.

1. The count of a rollback's failed attempts left its own domain at the top.
   From a stored count at the largest safe integer, the store wrote one past
   it. The decoder reads a count that is no safe integer as no record, so the
   attempt after that was stored as the first, and every spent attempt came
   back: a rollback that had spent its budget would be tried again as if it
   had never failed. Only a record an older build's store wrote can sit at
   that bound, because that store wrote whatever count it was handed, and no
   legal history counts that far. The base did the same arithmetic in the SDK.
   This pull request moved it into core, which owns the count now, and its own
   sentence, that a caller can store no other count, was false at the bound.
2. DESIGN.md said a rollback's spent attempts are never given back, in the
   paragraph that says a record the store cannot read counts as none. Through
   the SDK the second rule only meets a halt. A direct caller of the port that
   asks for another pass over such a record gets every spent attempt back, and
   a reader of the first sentence, the author of a port in another language
   for one, would have built on a guarantee the code does not give.
3. The argument that the count cannot go stale between its read and the batch
   that writes it named three legs and left a fourth out: the read must be
   current. It is a batch of reads, which core's executor contract says a
   replica can serve. An executor that took that at its word could hand the
   store a count from before the last failed attempt, and the store would
   write N where N + 1 is due. No executor in the repository sends a batch of
   reads anywhere but its one target, so nothing is wrong today. The argument
   claimed more than it had shown.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The count goes one past the largest safe integer, which its own decoder reads as no record | The attempt after it is stored as the first, and every spent attempt of that rollback comes back | Core's cases of the count, and the persisted counter contract of PR #12's round, which generates a witness at each bound of every durable counter | The cases counted from no record, from one, and from an older build's five, and none stood at an edge of the domain the decoder admits. The contract enumerates counter columns, and this count is no column: it sits inside the JSON state of a checkpoint under a reserved name | The count stops at the bound in the one definition core holds, which the three stores call (rung 1 for every caller of it). A core case at the bound, held by a registered mutation that removes the bound, and a conformance case at the bound on three dialects, which holds every store and any port that proves itself against the scenarios (rung 3) |
| 2 | DESIGN.md said spent attempts are never given back, beside the rule that a record the store cannot read counts as none | A direct caller of the port, or the author of another port, builds on a guarantee the code does not give | None can today: no machine reads a sentence. The rule that every guard has an executable twin is the nearest, and "never given back" had no case of its own | The sentence was written from what the change intends, that a caller no longer chooses the count, and not from the decoder's cases, which already showed the other half | None. The rule is restated with both halves in the four places that stated it: twice in DESIGN.md, in exit test line 20 of BUILD.md, and in the port's doc comment. A correction, not a mechanism |
| 3 | The soundness argument for reading the count before the batch left out that the read must be current | An executor that serves a batch of reads from a replica that lags would make the store write a count one short, and nothing written said the store relies on it not doing so | The argument's own form: each leg has a test that holds it, so a leg with no test stands out. A premise that was never listed is not looked for | No fixture has a replica, so no case can present a stale read through an executor. A store whose own read lags is caught by two cases by name (specimen C below), which is why three legs looked complete | None today. The premise is written as a fourth leg with what holds it, and BUILD.md records the design question as an option with its trigger: the port has no way to ask an executor for a current read, which is the rung 1 shape and is not built |

## Detection ledger

All three were found by the pull request's one review: a subagent that ran the
built-in code review skill at high effort, with the coordinator's probes
beside it. It reproduced the first two by probe and could not reproduce the
third, because no fixture has a replica. This project's machinery had run in
full on the reviewed head: the unfiltered audit caught 948 of 948 mutants, the
registry self-test passed, and conformance on three dialects, the fuzz and TLC
at the CI scope were green.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The review (the built-in code review skill, with the coordinator's probes) | 3 | No |
| Red tests, the mutation audit, the lints, the fuzz, TLC | 0 | Yes |

Self-catch rate: 0 of 3, or 0% (previous round on main, PR4.4d's: 0 of 3. The
previous round on this work, PR3.4b's: 0 of 9).

The rate has been zero in every round on main since PR4.4c's 1 of 11, and the
template is right about what that means. What the machinery did catch in this
pull request before the review is worth setting beside that number without
counting it. The filtered probe found one new mutation dying on the wrong
path, because its case awaited a later call bare, and found that a mutation of
the base survived once the store counted, so it was aimed again at a case it
reaches. The registry self-test refused five verdicts in a file of dynamic
titles that carried no reason. An exhibit showed that a plan pin on libSQL
could not fail: it told a task update from a spawn insert by a column name
both statements hold. In the fold itself the self-test refused the first
spelling of the bound before any commit, because a ternary changes the number
of raw question marks between a mutant's find and its replacement. The
simplify pass, which is a review and not machinery, found that the branch had
dropped `failRollback`'s step from the generic identifier surface. None of
these is one of the three. Each of the three sits where the engine meets
something it did not write, and the machinery enumerates what the engine
writes.

## Recurrence

A persisted counter leaves its domain at a bound (finding 1). This class has a
mechanism, and it did not work here. PR #12's round found twenty-one
counter-domain defects and instituted one contract,
`PERSISTED_COUNTER_FIELDS`, that generates the identity, the bounds, the
conditions and an upper and a lower witness of every durable counter, with a
domain of its own for a counter that must have room for one more. What that
contract checks is every counter column of the tasks and runs tables. What it
was meant to check is every persisted counter. The count of a rollback's
failed attempts is a persisted counter that is no column: the saga work, which
came later, keeps it inside the JSON state of a checkpoint under a reserved
name, with a decoder of its own in core. So the contract could not see it, no
witness was generated at its upper bound, and the defect is of the kind that
contract exists to find. A counter kept inside a value is outside that
mechanism today, and this round's case is a hand-written witness at one bound
of one such counter.

A sentence of DESIGN.md says more than the code holds (findings 2 and 3). This
class is not new either. PR4.4d's round, the one before this on main, counted
three wrong statements in its body and wrote that prose has no checker here.
PR3.9g's round before it corrected DESIGN.md and BUILD.md for four of its five
findings. On this same work, five of the nine findings of PR3.4b's round were
statements: an exit test line, comments, and sentences of BUILD.md. No
mechanism has been instituted against the class, because no machine reads a
sentence. The nearest rule is that every guard of a model and every leg of an
argument has an executable twin, and both passages here were claims without
one: "never given back" had no case of its own, and the argument had a test
for each of three legs and needed a fourth it never listed. The rule asks for
a twin of what was written. It cannot ask for what was left out.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The bound in core's one definition of the count, `failedRollbackRecord`, which the three stores call | 1, for every caller of it | Specimen A: a store that does the arithmetic again after core and goes one past the bound. Nothing makes a store, or a port in another language, take the count from core. The definition cannot see it, and the conformance case below does |
| The core case at the bound, held by a registered mutation that removes the bound | 3 | Specimen A passes it, because core is untouched |
| The conformance case at the bound on three dialects | 3 | Specimen D: a store that keeps the count in 32 bits and wraps where a signed 32-bit integer ends. The cases sample the count at its first few values, at six and at the bound, and a store that goes wrong between those points passes them all |
| The rule restated with both halves in four places | None, it is prose | Specimen B: the older sentences put back. Every checker passes |
| The read's fourth leg written down, with an option in BUILD.md | None, it is prose | No code in the repository can have this bug: it needs an executor that serves a batch of reads from a replica, and no fixture has one. Specimen C is the nearest shape the suite can express, and it is caught |

Specimens A, B and C ran against the fold's head `708f7ad`, on libSQL, and the
conformance case at the bound was then written against A. A ran again, with
specimen D, against `2b9639a`, the commit that adds that case. They are
boundaries of the tests, not further product findings.

```ts
// A: in the libSQL store's failRollback entry, after core has counted.
const bent = JSON.parse(counted.stateJson) as { tries: number }
const tried =
  bent.tries === Number.MAX_SAFE_INTEGER
    ? { ...counted, stateJson: JSON.stringify({ ...bent, tries: bent.tries + 1 }) }
    : counted
// D: the same entry keeps the count in 32 bits, so it wraps where a signed 32-bit integer ends.
const tried =
  bent.tries === 2 ** 31
    ? { ...counted, stateJson: JSON.stringify({ ...bent, tries: -(2 ** 31) }) }
    : counted
// C: the same entry serves the count's read from the first answer it ever gave.
run: (batch: FencedBatch) => ((globalThis as any).laggingTries ??= batch.run(this.db)),
```

Against the fold's head, A passed core's 7 cases of the names and the count,
the libSQL store's 92 tests, and all 29 cases of the saga surface on libSQL:
finding 1 again, one layer down, with nothing in the branch to see it. A case
written for the specimen seeds a record at the bound with raw SQL and fails a
rollback twice. It passes on the store as it is and fails on A with
`{ atTheBound: undefined, after: 1 }` where both should read 9007199254740991:
the store wrote one past the bound, the decoder read that as no record, and
the attempt after was stored as the first. The conformance scenarios are what
a store, or a port in another language, proves itself against, so that case is
now part of the branch and passes on three dialects. Against the head that
holds it, A fails it by name and passes the other 29 cases of the surface.

D passed core's 7 cases, the libSQL store's 92 tests and all 30 cases of the
saga surface, the case at the bound among them. A case written for D, and not
part of the branch, seeds a record at 2147483647 and fails on D with
`{ first: undefined, after: 1 }`: the same defect at a value the cases do not
sample.

B put the older text of DESIGN.md back, five lines where the fold has 24. The
ten source checkers, the lint and the format check all exit 0 over it.

C failed two cases of the saga surface by name: "counts a failed rollback
attempt, retries it past the budget, and halts when told to" and "counts a
rollback's failed attempts itself, one more than the last one stored". A store
whose own read lags is caught, so the gap that finding 3 names is the missing
replica, not a missing case.

## Fix-induced defects

None of the three was introduced by a fix for another. One slip was made in
the fold and caught by the machinery before any commit: the first spelling of
the bound was a ternary, and the registry self-test refused the new mutation,
because a mutant's find and its replacement must hold the same number of raw
question marks. The guarded commit script requires that self-test green, so
nothing landed, and the bound is an `if`. The fixes were not reviewed again as
new code. The maintainer's process gives a change one review, and the one
behaviour change of the fold is the bound, which has its red test and its
registered mutation. They were tested again: the short gate list with the
unfiltered audit ran on the fold's head, and again on the head that holds
main.

## Evidence

- Red test: commit `07c9c74`, probe `packages/core/test/saga-names.test.ts` `holds the count at the largest safe integer, and never reads its own record as none`, run and seen failing (1 test of 7, by name, and no other) against `e38fff2`, the reviewed head. Fix: commit `40f2b2d`, which turns `07c9c74` green, stops the count at the bound, and registers the mutation that removes the bound.
- Fixes with no red test of their own, because each corrects a statement and not a behaviour: commit `708f7ad` restates the rule with both halves in DESIGN.md, in exit test line 20 and in the port's doc comment (finding 2), names the read's fourth leg with what holds it today, and records the option in BUILD.md (finding 3).
- Fix: commit `2b9639a` adds the conformance case at the bound, for the class of finding 1. It has no red commit of its own, because what it fails on is a specimen store that is not committed: on that store it fails with `{ atTheBound: undefined, after: 1 }`, and on the three stores it passes.
- Gate after the fixes, on the head that holds main's tip by a merge: the short list from one driver, 12 of 12 gates at exit 0 on `5a446b5`, which holds the pull request ahead of this one by a merge: typecheck, lint and the format check, the ten source checkers, the registry at 1022 by import, the registry self-test, the corpus on three dialects, the core, SDK and driver suites at 949 tests, the three stores' suites at 241, the saga, stale-token and identifier surfaces on three dialects at 231, the UNFILTERED mutation audit (1022 caught by their own verdicts, 0 with collateral failures), and CI's base gate run locally against the commit merged, with this branch's arm live. The conformance case came after those gates, and what its file can move ran again on `2b9639a`, all at exit 0: typecheck, lint, the format check and the ten source checkers, the registry at 1022 by import, the same three surfaces on three dialects at 234 tests with the new case passing on each dialect, the filtered probes of all 79 saga mutations and of the stale-token column's `fail-rollback` mutation, each caught by its own verdict with 0 collateral failures, and the registry self-test. The merge of main's tip after it changes no file. The full list, with conformance on three dialects, the fuzz and TLC at the CI scope, ran once on the reviewed head, and the fold's one behaviour change is in a pure function of core.
- Finder: the pull request's one review, a subagent running the built-in code review skill at high effort with the coordinator's probes beside it, quoted verdict: "I found nothing HIGH or MEDIUM. Four LOW items follow; none changes behaviour against the base, and the fourth the author has already rejected with a written reason."
- The review's own words. For finding 1: "From a stored count of 9007199254740991, `nextRollbackTry` writes 9007199254740992. `decodeRollbackTry` reads that as no record, so the attempt after it is stored as 1." For finding 2: "Through the SDK this only happens alongside a halt. A direct caller of the port that passes a retry over such a record gets every spent attempt back." For finding 3: "The argument names three legs. It also needs the `rollback-tries` read to see every committed attempt record, and it does not say so." and "An executor that takes that at its word could serve the count from a lagging replica, and the store would then write N where N+1 is due."
- What the review ran: both red commits of the branch on three dialects, the three plan pins each seen passing and then failing, nine mutations by hand, three mixed-build probes, two core probes, and the bridge arm on a copy of the base registry. It did not run the full suites, the unfiltered audit, the fuzz, TLC or any replica probe.
- Claims that did not reproduce. Finding 3 is one: the reviewer wrote "No fixture has a replica, so I could not show it red", and it is counted as a claim that said more than was shown, not as a defect of behaviour. The base control of finding 1 held: at the base the SDK did the same arithmetic, so the behaviour is not new. It is counted because core owns the count now and the branch's own sentence was false at the bound.
- Not counted, and the coordinator agreed. The fourth item, that the three stores build the same small object for core's reader, which the body had rejected with a reason that stands. The branch's stale caller case for `fail-rollback`, which has no verdict marker of its own: it can fail, the review made it fail by name on three dialects, and the generated stale-token column took that leg over when main was merged. Two lines of the body that were each true of what they described, and one sentence on why a wrong-shaped argument stays a `TypeError`, all reworded.

## Root cause

Every case and every leg in this pull request was written for a history the
engine itself can produce. The three findings sit at the two places where the
engine meets something it did not write. One is stored bytes: a record another
build wrote, or one nobody can read. The other is the executor, whose contract
is wider than any fixture. The machinery has the same shape as the cases. Its
generated surfaces enumerate what the engine writes, which is labels, faults,
programs and counter columns, and a count inside a checkpoint's value and a
replica behind an executor are in none of those lists. The change moved a
definition from the SDK into core and wrote its contract from the intent of
the move, that a caller no longer chooses the count. It did not derive the
contract from the domain of the stored value or from what the read is
promised, and those are where the count can be wrong.

## Mechanisms

Built in this PR:

- The count stops at the largest safe integer in core's one definition, which
  the three stores call: rung 1 for every caller of that definition. It is
  never refused there, because a failed rollback that could not record its
  failure would fail again for ever, and a count at the bound still says the
  budget is spent.
- A core case at the bound, with a registered mutation that removes the bound:
  rung 3.
- A conformance case at the bound on three dialects, from a record written
  there with raw SQL: rung 3, at the layer every store and any port in another
  language is held to. It was written against specimen A, which is not
  committed.
- No mechanism for findings 2 and 3. The sentences are corrected where they
  stood, and the premise is written with what holds it today.

Deferred (recorded in BUILD.md):

- A way for the port to ask an executor for a current read, as an option under
  PR3.4 with its trigger, the first executor that serves a batch of reads from
  a replica. Deferral is acceptable because no executor in the repository
  sends a batch of reads anywhere but its one target, and the question is
  wider than this read: a worker's replay reads its memo the same way. It is
  the maintainer's design question.

## What this round still would not catch

- A store, or a port in another language, that counts a rollback's failed
  attempts itself and goes wrong at the bound is now caught on three dialects,
  by the conformance case there. One that goes wrong between the points the
  cases sample would ship today: specimen D wraps at the end of a signed
  32-bit integer, and every case passes on it. The cases are points of a
  range, and nothing generates them.
- A persisted counter that is no column gets no generated witness at its
  bounds. The next counter kept inside a checkpoint's value will be tested at
  whatever points its author thinks of.
- A sentence of DESIGN.md that says more than the code holds would ship today
  as these two did. Specimen B passes every checker.
- An executor that serves a batch of reads from a replica that lags would ship
  today with every gate green, because no fixture has a replica. The count
  would be written one short, and a replay would miss a checkpoint that has
  committed.
