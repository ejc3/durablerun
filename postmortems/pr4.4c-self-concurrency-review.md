# Postmortem: the self-concurrency surface's review (PR #63)

PR #63 adds a conformance surface that races every call of the store's two
ports against copies of itself on libSQL, PostgreSQL and MySQL, and a count of
deadlock victims on the two server executors, held at zero where real callers
race. The surface found one product defect on its first day, before any
review: on MySQL, concurrent claims deadlock while `runs` holds five rows or
fewer. One review then found no HIGH, no MEDIUM and twelve LOW. Ten of the
twelve are counted here. Nine of the ten are holds of the new surface that
could not fail, or sentences of DESIGN.md and BUILD.md that said more than the
code holds or than was measured. One is in product code: the MySQL executor did
not count a victim whose rollback then failed. None changes what a caller of
the product sees. All ten are folded in this PR.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here could lose, duplicate or misattribute durable state. What would
have shipped is a test surface that claims more than it holds, and the cost of
that arrives later, when someone trusts a hold that cannot fail.

The worst is finding 1. The one contest in which MySQL is excused its deadlock
victims expected its own count, so any number of victims from any cause passed
there. Until the claim's fix lands, a second source of victims in MySQL's claim
path would have been invisible in the one place victims are expected. And had
the fix merged first, this branch's rebase would have carried the excusal in
over a fixed defect with nothing red.

Finding 5 is the one in product code. A MySQL deadlock victim whose rollback
failed was reported and never counted, while the getter's comment and DESIGN.md
said every victim is counted, and PostgreSQL counted the same victim. That path
surfaces as an outage, which the surface forbids anyway, so no verdict changed.
A port in another language would have been built to the sentence.

Findings 3, 4, 6 and 7 are holds that read as protection and could not fail.
The count was held in seeded scenarios that run one batch at a time. The floor
that refuses a contest in which nothing happened was blind to the nine calls
that answer nothing. One contest compared nothing its call writes. A method
with an empty entry raced nothing while the type was described as giving every
method its contest.

Findings 2, 8 and 9 are sentences. DESIGN.md said 24 libSQL contests fail on a
wrong answer, and they cannot. A projected figure was called a recorded one.
"Three each" was not what twenty runs had measured. Finding 10 is a comment
that described less than the comparison loses.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The excused contest expected its own count of deadlock victims | Any number of victims from any cause passes in that contest, and a rebase over the landed fix would carry the excusal in with nothing red | The surface's final expectation | It compared the count with itself | The count is held to a bound, four copies times the two attempts a copy can lose without an outage (rung 3). Seen red: with the bound at zero the contest failed at 3 victims |
| 2 | The surface's oracle is this build's own serial order, and DESIGN.md said 24 libSQL contests "fail on a wrong answer" | A reader takes the surface to hold answers against the contract. With libSQL's `cancelTask` answering true every time, its contest stays green | The rule that DESIGN.md changes with behaviour | It is an instruction to an author with no checker, and no control asked what a wrong answer in both orders does | The sentences say what is compared. Holding winners against the contract is recorded in BUILD.md as an option, with the review's break as its ready red (no mechanism: prose) |
| 3 | The executors' count was held, and claimed as held, where it could not fail: seeded scenarios that run one batch at a time through the simulator, and a native claim case and an eight-migrator case that open their connections inside their race | Two documents listed protection that did not exist | The measurement made before the holds were written | It measured that the holds were green, zero victims in 4311 fixtures, and never whether each could be red | The two holds are deleted, and the documents claim the count only where callers overlap on open connections (no mechanism: the claim was made true) |
| 4 | The idle floor counted a call that answers nothing as work done, and nine calls of the ports answer nothing | A contest whose arranged state no longer lets its call work would pass for those nine | The idle floor | It read answers alone | The floor reads the six tables, the schema version and the engine's clock before and after a contest, and a contest is idle when no copy answered anything and nothing changed (rung 3). Seen red: a call that answers and writes nothing fails as idle |
| 5 | The MySQL executor counted a victim after its rollback, and reported a failed rollback from inside that block | A victim whose rollback fails is reported and never counted, against the getter's comment and DESIGN.md. PostgreSQL counted it | The executors' unit tests | Each counted victims whose rollback succeeds, and nothing ran one path on both executors | The count comes first in the catch block. One unit case on each executor's fake connection fails a victim's rollback: it read 0 on MySQL before and reads 1 on both now (rung 3) |
| 6 | The snapshot omits `meta`, so the `setFakeNowEpochMs` contest compared nothing its call writes | That contest could fail only on an outage | The rows comparison | Its table list was the invariant library's six tables, and the clock lives in none of them | The engine's clock joins every contest's record and the idle floor (rung 3) |
| 7 | A method whose entry holds no state compiled and generated no contest | "A port method without an entry does not compile" was true, and did not mean every method is raced | The typed tables | A record type admits an empty record | A guard whose type refuses a table with an empty entry, on either port (rung 1). Seen: `activate: {}` fails with TS2345 |
| 8 | "Three times its slowest recorded run" used 1,784 s, which is a recorded 1,767 s plus a projected 17 s | A projection read as a record, in the sentence that says a CI limit still holds | The author's sentence | Nothing checks a figure against its source | The figure is called what it is, beside what CI's `verify` took on this work's first head, 1,482 s (no mechanism: prose) |
| 9 | "Three each" for the victims of the excused contest | The first twenty runs had one, two or three victims in a run that met any | The author's sentence | The tally counted runs with any victim, and the sentence generalized one probe | Restated from those twenty runs and from the review's 300 rounds (no mechanism: prose) |
| 10 | Setting drawn ids aside erases the links between rows a contest itself wrote, and the comment said the rows still say which task and which run they are | The rows comparison cannot see a new run attached to the wrong new task | The comparison's own comment | It described arranged rows and was silent on new ones | The comment and DESIGN.md say so, and that the invariant checkers, which read the rows as they are, hold those links (no mechanism: prose, and the gap stays) |
| 11 | On MySQL concurrent claims deadlock, and come back short or empty, while `runs` holds five rows or fewer | Throughput and deadlock retries for a database's first five runs. No run is claimed twice or lost | A concurrent claim case | The older native claim case has eight rows and opens its connections inside its race | Found by this PR's surface before any review. The fix is deferred to PR4.4e in BUILD.md, and until then one contest's victim count is excused up to a bound (rung 3 for the detection; the fix is not built) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: the built-in code review skill at high, each finding then checked by the reviewer, several with probes on real servers | 10 | No |
| This PR's self-concurrency surface, on its first run on MySQL | 1 | Yes |

Self-catch rate: 1 of 11, or 9% (previous round: 0%).

The one find of ours is the kind the surface was built for, a product defect
under a server's locking, and it found it on its first day. All ten findings of
the review are about the new machinery itself or about its description. That
split is the point of this document. This project's machinery asks a great deal
of a product guard, and it has nothing that examines a new hold in a test.

## Recurrence

**A hold that cannot fail** (findings 1, 3, 4, 6 and 7). This class recurred
after mechanisms. The write-provenance round found three checkers that could
not fail. The child-task model's round found an instrument whose control could
not fail while its document said it could. The child-task implementation's
round wrote that a mechanism with one case is not proven. Each mechanism was
local to the checker at hand: a control for that lint, a floor for the fuzz, a
second case for that pin. AGENTS.md states the property in prose, in its list
of proxies. Nothing asks of a NEW hold that it be seen red once. This round saw
the surface red through two paths, a reverted heartbeat fix and the claim
contest, and its documents then described every hold as though each had been
seen. The excuse's path, the floor's branch for a call that answers nothing,
the clock's contest, the empty entry, and the holds added to older cases had
never been red in front of anyone.

**Text stronger than what was run or read** (findings 2, 8 and 9, and the
document half of 3 and 10). The migrator race's postmortem said this class had
recurred in every review round of its week. It recurred here. Its only
mechanism is a reviewer reading, which is the last net and not a mechanism. Two
sentences of this round now stand on a control that was run: what the floor
refuses, and what the bound refuses.

**One rule written once in prose and twice in code** (finding 5). The migrator
race's round found the PostgreSQL admin's recovery missing from the libSQL
admin, which was an earlier round's finding on the other dialect. Here the rule
is "count every victim", and the two executors placed the count differently
around a rollback that only one of them can throw from. The mechanism then was
a shared case that asks every dialect the same question. The executors have no
shared test, so this round's case is two copies, one in each package.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The bound on the excused count | 3 | A second source of victims that adds up to five more in that contest. Not run: nothing in the tree produces four to eight victims on demand. Run: with the bound at zero the contest fails at 3 victims, so the comparison is live |
| The idle floor that reads the store | 3 | A call that writes, but not what its state was arranged for. Run: "emitEvent to a parked waiter" made to emit another event's name never wakes its waiter, and the contest passes on libSQL, because a row changed and both orders agree |
| The engine's clock in every contest's record | 3 | A `setFakeNowEpochMs` that sets the wrong instant in both orders. Not run: it is finding 2's gap, the serial-order oracle, which the review's `cancelTask` break showed |
| The typed tables that refuse an empty entry | 1 for "every method has an entry with a state", nothing for "the entry calls that method" | Run: the entry under `activate` made to call `claimedTaskName` compiles, and the contest named for `activate` passes |
| The unit case on each executor that fails a victim's rollback | 3 | An early exit placed above the count in either catch block, on a path the two cases do not drive. Not run: no such exit exists to bend. The two cases are copies in two packages, so one can drift from the other |
| The corrected sentences of DESIGN.md and BUILD.md | none, prose | Any later sentence. Nothing reads DESIGN.md |

## Fix-induced defects

None was found, of eleven. The folds were not reviewed again, which is the
maintainer's rule for a round whose findings are all LOW. They were tested
again: both new holds were seen red, five compile controls were run, the
surface passed on all three dialects, and the whole gate list runs on the head
that adds this document, with its table in the PR body.

## Evidence

- Red tests: none is committed apart from its fix. Every finding of the review is LOW, and the maintainer's rule for such a round is one commit for each fold. Finding 5's unit case was run before the executor changed and read `"rollbackFails": 0` on MySQL against an expected 1, under its test's name, while PostgreSQL's case passed. It is committed with the fix.
- Fixes: commit `4d58aa1` for finding 5. Commit `0b4c4d9` for findings 1, 3, 4, 6 and 7, the comment of finding 10, and the excusal's sentences of findings 9 and 11. Commit `c743588` for findings 2, 3, 8, 9 and 10 in DESIGN.md and BUILD.md.
- Controls run on `0b4c4d9`, each a temporary change that was restored and compared byte for byte. A call that answers and writes nothing failed its contest with `"idle": true`. With the bound at zero the excused contest failed with `"deadlocks": 3` in its first run on MySQL. `activate: {}` and `schemaVersion: {}` each failed with TS2345, a missing `retryTask` entry with TS1360, and a misspelled excused name with TS2353, and the restored tree compiled.
- Finder: the one review, quoted verdict: "No HIGH and no MEDIUM findings on PR #63 at 7c4e02d. None of the twelve LOW findings below changes what a caller of the product sees."
- The reviewer's reproductions, quoted: "I made libSQL's `cancelTask` answer true every time. Both orders answered true four times and the contest stayed green." "Reproduced with one unit probe on each executor's fake connection: MySQL read 0 and PostgreSQL read 1 for the same path." "Reproduced: `activate: {}` typechecks." "In 300 rounds of that contest on unmodified code, victims per round were 0 in 61, 1 in 36, 2 in 30 and 3 in 173, and never more than 3."
- The reviewer also watched this PR's own red again at the head it read, quoted: "With 898f21c reverse-applied, the distinct-drivers heartbeat contest was red 10 of 10 on MySQL by name, with 4 to 6 victims and an outage in 8 rounds. The control was green 10 of 10 with no victim."
- Not counted, and why. The review's finding 11, an outage in the excused contest, did not reproduce in its 300 rounds, and its fold is one sentence that says what such a failure would mean. Its finding 12 is cost: connections are now opened ahead of the raced order alone, and starting a contest's two fixtures together is listed in the PR body and not built. Its nit is a plan entry named in a source comment, which main does in six places.
- Claims that did not reproduce. After the fold the surface first read about a second slower on PostgreSQL. Four pairs run one after the other, the head before the fold and then the head after it, read 8.69 s and 8.45 s on PostgreSQL, 7.22 s and 7.05 s on MySQL, and 1.83 s and 1.76 s on libSQL, at a load average of 45 to 58. The machine was busier, and the fold costs nothing that shows.

## Root cause

A hold is a claim that a test fails when a property is false. This project
makes a product guard earn that claim: a registered mutation breaks the guard,
and the audit fails unless the named test catches it. A race cannot own a
mutation's verdict, because a verdict that depends on timing would flake the
audit. So the surface owns no mutation, and with none, nothing forced any of
its holds to be seen red. The surface as a whole was seen red through its
widest path, and every narrower hold borrowed that proof: the excuse, the floor
for a call that answers nothing, the contest of the clock, the type's claim
about every method, and the count's holds in older cases. The documents then
described each hold by what it was meant to do.

## Mechanisms

Built in this PR:

- The bound on the excused count, rung 3, in the surface's final expectation.
- The idle floor that reads what the store holds before and after a contest, rung 3, in `contest`.
- The engine's clock in every contest's record, rung 3.
- The type that refuses a table with an empty entry, rung 1, where the contests are generated.
- One unit case on each executor that fails a victim's rollback, rung 3.
- Two holds deleted because they could not fail. The ladder moves by substitution, and a claim that cannot fail is removed and not patched.

Deferred (recorded in BUILD.md):

- The fix of the MySQL claim, PR4.4e, which deletes the excusal. It is acceptable because no durable state is at risk, and the excused contest holds its answers, its rows and the invariants meanwhile.
- Holding each contest's winners against the contract, recorded as an option with its ready red and not scheduled. It is acceptable because the scheduler suite's own cases hold the answers, one call at a time.

## What this round still would not catch

A hold nobody has seen red would ship today. The count's hold in three of the
four older cases, an await beside its emit, one claim token sent sixteen times,
and a child's await beside every terminal batch, has never failed in front of
anyone. Only the driver beats' case and the lock-order test have. The next
test-side hold in a later PR would ship the same way, because nothing asks.

An answer that is wrong in both orders would ship. An entry that races another
method than the one it is filed under would ship. A call that writes something
other than what its state was arranged for would ship. A second source of
deadlock victims in the excused contest would ship while it stays under nine. A
wrong link between two rows a contest wrote would ship unless an invariant
reads it. And any sentence of DESIGN.md would ship, because nothing reads it.
