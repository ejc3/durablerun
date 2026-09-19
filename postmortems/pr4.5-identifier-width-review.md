# Postmortem: PR4.5 identifier width review

The change made the 255 character width of a durable identifier, which only the
MySQL store enforced, a rule of core that every entry of every store holds
first. It passed every local gate, with the unfiltered mutation audit at 835
of 835. One review, by the two built-in skills with the reviewer's own probes
on libSQL and on MySQL 8.4, found the rule sound at the store: every entry
checks first, nothing can exceed MySQL's column, the character count agrees
with MySQL's, and no coverage was lost. It found eleven things one layer up
and in the documents. Eight are defects of product code or of the spec, and
all eight are fixed here, the three of MEDIUM severity as a red test and a
fix. They share one root. The rule was added at the port and tested at the
port, and every layer above the port turns a permanent refusal into something
else: the SDK retries it, the driver swallows it, and a task in flight from
before the rule meets it on replay. Our own machinery found none of the eight.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding is a step body that runs on every attempt. The SDK stores a
task's names under keys longer than the names: a repeated step as `name#2`, an
await as `$await:` and the event name, a registered step's start marker as
`$started:` and its key. A name that fit the width could have a key that did
not. Every store refused the key, the SDK read the refusal as an ordinary
failure, and the task was retried. With three attempts, a 254 character step
name used twice ran the second step's body three times, and then failed naming
`checkpointName`, an argument the task never passed. Every side effect before
the refused call repeats with it. This was new on libSQL and PostgreSQL with
this change. MySQL already behaved this way.

The second is a task in flight across the upgrade. The change held the width
in the SDK's name parser, which runs before the memo lookup. A task whose step
name an older build had stored at 300 characters failed for good on its next
pass, where it used to finish. The spec said of exactly such rows that the
"task still finishes", which was true only of the port.

The third is a saga in flight under a stored step key of 240 to 245
characters. Its rollback ran once, the store refused the record that it ran,
and the saga ended with a failed rollback outcome and the store's refusal
where its cause had been. The compensation had happened and the record said it
had not.

A driver configured with an id past the width ran and never registered, with
nothing logged, because the registry beat's refusal is swallowed by design.
The spec and the pull request's description told a reader three wrong things:
that a task name is not bounded, where a child spawn bounds it at 201, that an
awaited child id holds 244, where the SDK gives it 243, and nothing at all
about a wait on a longer event name that an emit can no longer wake. And a
check of three parent identifiers at a child spawn was held by no test.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The SDK retried the store's refusal of a key the SDK itself derived from a name that fit | A step body runs on every attempt and every earlier side effect repeats, until the budget is gone | The replay-equivalence harness, which is the SDK's generated surface, and the task boundary's rule that a bad input is classified where it enters | Its name corpus is six names of at most six characters, so no generated program builds a key near the width. The refusal was added two layers down and tested only over the port | The SDK holds each key where it builds it, and the key builder takes what the task passed as a required argument (1 for the signature, 3 for the behaviour: six cases and three mutations) |
| 2 | The width was held in the SDK's name parser, which runs before the memo lookup | A task in flight under a stored longer step name fails for good where it used to finish | The legacy rows surface, which exists for rows an older build wrote | It enrols the columns a migration adds. A new rule over values that are already stored is not a migration, so nothing enrols it, and the surface drives the port and never the SDK | The key is held only when it is not already stored as a memo or a started step (3: one case on two dialects and one mutation) |
| 3 | The store held every saga name of a step to the step's 239 character key | A saga in flight under a longer stored key cannot record a rollback that ran, and loses its cause | The same legacy rows surface, and the saga conformance surface | No case starts a saga under one rule and ends it under another | The key is held where the step starts, in one definition in core, and the step's other saga names are held to the plain width (1 for the single definition, 3 for the conformance expectation and the SDK case) |
| 4 | The spec and the description said a task name is not bounded | A reader ships a 230 character child task name, which fails its parent for good | Nothing. No machine reads a sentence against the code | There is no such layer | The sentence is corrected, and one case holds the documented 201 by the same sum the spec does (3) |
| 5 | No test passed an over-width parent queue, parent task id or parent run id at a child spawn | A deleted check would ship unseen, against a spec that claims a call for every place an identifier enters | The entries table of the shared conformance surface, which is typed by the port | It is typed by method. A position inside an options object is not a method, so the type is satisfied without it | The three calls, a mutation for each of the two checks a deletion can reach, and the third check removed because the stored child key already holds it (3) |
| 7 | The spec gave an awaited child id 244 characters where the SDK gives it 243, and the SDK's own key was left to the store's refusal | The same retry as finding 1, behind a forged handle | The same as finding 1 | The same as finding 1 | The same hold as finding 1. The spec now gives both numbers. No test holds 243 (3 for the hold, none for the number) |
| 8 | A driver id past the width was refused on every registry beat, and the beat's catch swallowed it | A driver runs and never registers, with nothing logged | The driver's construction test, whose comment says a misconfigured loop must fail at construction | The knobs it refuses are listed by hand, one at a time | The constructor holds the queue and the id, with one mutation (3) |
| 11 | The description left out that a wait on a longer event name can no longer be woken by an emit | A reader of the pull request misjudges what the rule strands | Nothing. No machine compares the description with the spec | There is no such layer | The sentence is added. No mechanism |

## Detection ledger

The branch had passed every local gate before the review read it, with the
unfiltered audit at 835 of 835. Every counted finding came from the review.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review: the built-in review skill at high effort with its finders and one verifier, the built-in simplify skill, and the reviewer's own probes on libSQL at the head and at the base and on MySQL 8.4 | 8 | No |
| This project's machinery on the reviewed head: the shared conformance surface on three dialects, the SDK suites and the replay-equivalence harness, the fault and poison matrices, the fuzz, the lints, the unfiltered mutation audit | 0 | Yes |

Self-catch rate: 0 of 8, or 0% (previous round on main, PR3.9f part 1's: 0%. The previous round on this work, the MySQL store's: 0%).

Zero again, and for a reason that is not about effort. Every gate this change
ran, it ran at the layer where the rule was written. The shared surface drives
the port. The mutation audit breaks the port's checks and asks the port's
tests. All eight findings are about what a layer above the port does with the
port's new refusal, and no check of ours crosses that line with a name near
the width in its hand.

Our machinery did catch four defects of the fold's own making before any
reviewer could, and they are not counted above. Typecheck and the MySQL leg of
the shared surface caught a rebase resolution that had dropped main's new
prepared reads along with the code this change deletes. The registry's
self-test refused three SDK verdicts that were declared without the reason a
suite title built at run time requires, after a filtered run of the same
mutations had passed. A boundary case's run contradicted four expectations the
author had written wrong. And a probe whose forged rows woke nothing was read
as a faulty probe and rebuilt, where it could have been read as a result.

## Recurrence

**A rule proven at the layer that owns it, and never carried to the layer
above.** This recurs. The events round found the same shape and answered with
the rule that every new layer gets its own generated surface, and built the
replay-equivalence harness as the SDK's. The sagas review then recorded that
harness as "a generated surface that enumerates what its author thought of".
It did not work here for the same reason. The harness generates programs from
a grammar of calls, and draws every name from a list of six, the longest of
them six characters. It checks that a program replays the same way whatever
fault the store injects. The property it stands in for is wider: that the SDK
answers every refusal the store can give the same way on every pass. A refusal
that depends on a name's length cannot be reached by a harness that never
varies a name's length. The mechanism is a proxy, and this is its third round.

**A bad input that is the same on every pass must fail the task for good at
the task boundary.** This recurs, and it has recurred in every round that
added a refusal a task can reach: the sleep duration, then the await timeout
and the event name, and now the derived key. The events round instituted the
name parser as the single mint point, the classified validators, and a lint
that keeps the raw validators out of the SDK. The lint reads for two function
names. The property is that no permanent refusal from the store reaches the
retry decision as an ordinary failure, and a lint for two spellings is a
picture of it. This change even used the mechanism, by putting the width in
the name parser, and that was wrong in a way the mechanism cannot see: the
mint point sees the name, and the store refuses the key.

**What an older build stored.** This recurs from the round that instituted the
legacy rows surface. That surface derives its cases from the migrations, so a
column a migration adds cannot ship without a case. It stands in for the
property that nothing an older build could have stored is broken by this one.
A new rule over old values is not a migration, adds no column, and enrols
nothing. The two cases this change added to that surface were written by hand,
drove the port, and asserted `complete()`, which is why they passed while a
task in flight failed.

**A sentence in the spec that the code contradicts.** This recurs in most
rounds, and no mechanism has ever been instituted against it, here included.

## Mechanism audit — the false negative of each

Each row was run against the fixed code, except where it says it was not.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The SDK holds every key where its one key builder makes it, and the builder requires what the task passed | 1 for the signature, 3 for the behaviour | A key built anywhere else is held by nothing in the SDK. Three are today: `$started:`, `$rollback:` and `$rollback-tries:` and a step's key. They are safe only because the key was held to 239 when the step was admitted. Ran, with a stored key of 240 and a rollback that throws: the saga ends failed in one pass with `rollbackTry.key is longer than the 255 characters a durable identifier holds` in place of its cause, and the whole SDK suite passes |
| A key that is already stored is not held, so it replays | 3, one case and one mutation | "Already stored" is read from the memo and from the started steps. An await parked before the rule is stored as a wait, and is in neither. Ran, with a real emit waking the run and only the wake it carries rewritten to a 250 character event name: the woken pass fails the task at once with `event name is too long`. It is not retried, and it does not finish |
| A saga step's key is held where the step starts, and its other saga names to the plain width | 1 for the one definition in core, 3 for what it lets a saga in flight do | It lets a saga in flight record a rollback only while `$rollback:` and the key fit. Ran at 245 and 246: at 245 the saga rolls back, outcome complete, with its cause. At 246 the rollback runs once, its record is refused, and the saga ends failed without its cause |
| The entries table of the shared surface is typed by the port | 1 for a method, 3 for a position | The case reads the class of the error and not which check refused. Ran before the redundant check was removed: deleting the parent task id's line passed 4 of 4, because the stored child key holds that id and refused it. A new identifier inside an options object still compiles with no call here. Not run: it is a statement about a parameter that does not exist |
| A driver holds its queue and its id when it is constructed | 3, one case and one mutation | It holds their length and nothing else. Ran: a driver id of `d`, a NUL and `x`, and one ending in a lone surrogate, both construct without complaint. PostgreSQL refuses both on every beat, and the beat's catch is unchanged |
| One case holds the rooms the spec documents | 3, syntactic in what it covers: it holds the four numbers it names | It holds 248, 239, 253 and 201. The SDK's 243 for an awaited child id needs a forged handle and is held by no test. Checked by a search of the three test files and not by a run: the spec could say 244 there and every test would pass |
| Two mutations delete the parent queue's check and the parent run id's | 3 | Both are caught by the class of the error, so a check that refuses for another reason would satisfy them, as the entries table's row says |

## Fix-induced defects

None of the eight was introduced by a fix made in this round. All eight were
in the change as the review first read it. One of them, finding 2, came from
an addition the change made beyond what it was asked for. It put the width
into the SDK's name parser to stop a retry loop, which is the reasoning of a
fix, and it was tested for the refusal and never for replay.

The fold's own changes have not been reviewed. They were tested, by ten red
tests, six registered mutations and five probes whose results are in the audit
above, and one narrow re-review of the SDK's behaviour is planned. One change
in the fold is not in the SDK, and that re-review should read it as new code:
the store's saga key rule now holds at the start marker only, so the shared
surface accepts a `$rollback:` name under a 240 character key that it refused
before.

## Evidence

- Red tests: commit `1df5e17`, run and seen failing, ten tests, which are five cases on libSQL and on PostgreSQL, against `283aad4`, the head the review read once it was rebased onto main. The repeated step took three passes and ran its second body three times. The 250 character event name and the 245 character registered step each took three passes. The task in flight ended `failed` where it should complete. The saga in flight ended `failed` with `"outcome": "failed"` and without `boom`. The original change's own red is `3d61eb6`: three of four cases failed on libSQL and on PostgreSQL, and none on MySQL.
- Fixes: commit `4a2d8c4`. Commit `2697877` holds the documented rooms, and `c667afd` records the reason the registry's self-test demanded. Gate after fix: the ten red tests pass, a filtered run caught each of the nine new and re-aimed mutations by its exact verdict at `4a2d8c4`, and the registry's self-test passed with 870 live mutations at `c667afd`. The whole gate list runs on the head that holds this document, and its table is in the pull request's description.
- Finder: the one review, quoted verdict: "The store-level rule is sound: every entry checks the width first, and nothing can exceed MySQL's column. The defects are one layer up, in the SDK, where the new refusals land."
- The reviewer's reproductions, quoted: "A 254-character step name used twice ran the second step's body 3 times, then failed with `checkpointName is longer...`", "With a 300-character step name, the head gives `FatalTaskError` on the first pass. The base gives `suspended`", and for the saga, "Head: the rollback handler runs once, then the result reads `rollbackTry.key is longer...` with `rollback.outcome: failed`. Base: the cause stays `boom` with `rollback.outcome: complete`."
- The control for finding 5, run on libSQL after the three calls were added: without the parent queue's check, 1 of 4 cases fails. Without the parent run id's, 1 of 4 fails. Without the parent task id's, 4 of 4 pass.
- Claims that did not reproduce. The review's verifier refuted four of its own candidates: an unguarded read of `rollbackTry.key`, the sort order of the fourth conformance case on PostgreSQL, the fixture helper's room of 64, and a missing early exit in the character count. Two of the author's did not hold either. A first probe of the parked await forged its wait row, the emit then woke nothing, and the task stayed `sleeping`. That was a faulty probe and not a result, and the second probe, which forged only the carried wake, settled it. And a boundary case expected `retry-scheduled` one character past each room, where the run gave `failed` four times, which is the fix working.

## Root cause

A refusal was added to the lowest layer, and every check of it was written at
that layer. The port's callers were read, in that every store entry was found
and enrolled, but what each caller above the port does with a refusal was not.
The SDK treats an error it does not recognise as the task's own failure and
retries it. The driver treats a failed registry beat as noise. A replaying
pass passes in, as a new argument, a name the engine stored long ago. Each of
those is a reasonable rule on its own, and none of them was written with a
permanent, input-dependent refusal from the store in mind, because until this
change only one dialect had one.

No surface of ours generates the pair that matters: a refusal the store can
give, against a call a layer above can make. The store has a generated fault
surface and the SDK has a generated program surface, and they meet only on
faults, which are transient by construction. A refusal that depends on the
length of a name is permanent, and sits in neither.

## Mechanisms

Built in this PR:

- The SDK's one key builder holds every key it makes to its room, takes what
  the task passed as a required argument, and skips a key that is already
  stored (rung 1 for the signature, rung 3 for the behaviour), in
  `packages/sdk/src/context.ts`, with six cases on libSQL and PostgreSQL in
  `packages/sdk/test/identifier-width.test.ts` and three mutations.
- Core holds a saga step's key at its start marker, in one definition (rung 1
  for the definition, rung 3 for the behaviour), with the shared surface's
  expectation on every dialect and one mutation.
- A driver holds its queue and its id at construction (rung 3), with one
  mutation.
- The shared surface passes every parent identifier of a child spawn, with a
  mutation for each check a deletion can reach (rung 3).
- One case holds four of the rooms the spec documents (rung 3).

Deferred (recorded in BUILD.md):

- A name-length axis for the replay-equivalence harness: for every keyed call
  it generates, a name at its room, one under, and one past. It is the only
  mechanism named here that attacks the root cause. Deferral is acceptable
  because every instance the review found is fixed and held by a case, and it
  is not acceptable for long, because the next refusal the store gains will
  meet the same six short names.

## What this round still would not catch

A key the SDK builds outside its one key builder would ship unheld today, and
the store's refusal of it would be retried. The saga names are three such
keys, safe only through the step key's 239.

A refusal the store gains tomorrow, for any reason that depends on a value a
task passes, would reach the retry decision as an ordinary failure. Nothing
generates a store refusal against an SDK call, and the lint that guards the
task boundary reads for two function names.

A rule that refuses a value an older build could have stored would break a
task in flight, and the legacy rows surface would not enrol it, because it
enrols columns and not rules.

A driver id that no store keeps unchanged, one with a NUL or a lone surrogate,
still constructs, and its beats are still swallowed.

The spec could give the SDK's awaited child id the wrong room and every test
would pass, and any sentence of the spec or of a pull request's description
can contradict the code with nothing to notice.
