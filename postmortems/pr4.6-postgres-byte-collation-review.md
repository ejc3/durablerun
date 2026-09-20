# Postmortem: the PostgreSQL byte collation's review (PR #67)

PR #67 makes PostgreSQL compare and order names by their bytes, as libSQL and
MySQL already did. Version 7 of the PostgreSQL schema declares `COLLATE "C"`
on every text column, CI's PostgreSQL service is created with a linguistic
collation so that the identical suite can see the difference, and a test that
reads the catalog holds it. Version 7 is the first version that locks every
table, so the PR also measured what it costs under live traffic. One review
found nothing HIGH, two MEDIUM and ten LOW. Both MEDIUM findings are about
version 7 under live traffic, where the documents claimed more than had been
measured: a read batch that lost a deadlock to the version's locks was
reported to its caller and never run again, and the version took its locks in
the opposite order to every statement of the engine. Six findings are counted
here, the two MEDIUM and four LOW that are a gap in a gate or wrong advice to
an operator. None of them could lose, duplicate or misattribute durable state.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Worst first, and what would have shipped without the review.

1. While version 7 migrates under workers of an older build, a read batch that
   loses a deadlock to the version's table locks is an error at its caller. A
   worker's run then waits out its lease and is charged an infrastructure
   retry, and a driver counts an outage. DESIGN.md, BUILD.md and the PR body
   said that no caller saw an error. That sentence would have shipped in the
   operator's note, and so would an executor that reports every deadlocked
   read during every later version that locks tables.
2. Version 7's first statement took `meta` first, where every statement of the
   engine that reads the clock takes its own table and then `meta`. Measured
   after the review with read batches and event batches in the traffic, on an
   empty schema: the version lost all three of the executor's attempts in 11
   of 80 migrations and left version 6, and the server counted 568 deadlocks.
   A version's text is frozen by its hash once it is on main, so that order
   would have shipped for good.
3. A build older than the schema hears from `migrate()` that the database is
   in an inconsistent state and must be repaired by hand. Nothing is broken
   there, and the operator's note sent an operator to that message without
   saying what to do. An operator who followed it could damage a healthy
   schema.
4. The index key half of the catalog test had no registered mutation, so that
   half could have been deleted with the mutation audit still green.
5. The racing migrators case told a second migrator that waits for the
   runner's lock from one that blocks on an uncommitted sentinel only at
   version 7, where the second kind becomes a deadlock. Its title claimed
   every version.
6. Nothing failed if CI's PostgreSQL service lost its ICU arguments. The order
   case would then have run green on a server where it cannot fail, which is
   the state this PR was opened to end.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A read batch that loses a deadlock is reported and never run again, and three documents said no caller saw an error | An error at a caller while a version migrates. A run waits out its lease, a driver counts an outage | The PR's own live traffic measurement, and the executor's unit case for a deadlock victim | The measurement's traffic was five calls, all write batches, so no read could lose. The unit case held the policy as it was written, "only a write batch is run again", because the policy's reason was believed | `store-postgres/test/deadlocked-read.test.ts`, a deadlock built without a race whose victim is a read, and the registered mutation `postgres-deadlocked-read-runs-again` (rung 3) |
| 2 | Version 7's lock list began with `meta`, the opposite order to every statement that reads the clock | Deadlocks with statements that arrive while the version waits. Under dense traffic the version fails and must be run again, and reads of an older build lose | The same live traffic measurement | It sent no read batch and no event batch, and nothing examined the order of a version's lock list | `store-postgres/test/version-lock-order.test.ts`, which reads the server's lock table, and the registered mutation `postgres-version-locks-meta-before-the-store-tables` (rung 3). The order's rule in `schema.ts` is a comment (none, prose) |
| 3 | The index key half of the catalog test had no registered mutation | That half could be deleted with the audit green | The mutation audit | The audit runs registered mutants. Nothing requires a mutant for each assertion | The registered mutation `postgres-index-key-keeps-another-collation`, whose marker is on the index key assertion alone (rung 3) |
| 4 | The racing migrators case asked whether the second migrator waits on a lock, which both kinds of second migrator do | The property "waits for the runner's lock holding nothing" was held at one version of seven | The case's own registered mutation | The mutant was killed, at version 7, so the audit was green. A kill does not say which version killed it | The case reads the lock table: what the second waits for and what it holds. The same mutant now fails at all seven versions (rung 3) |
| 5 | Nothing held CI's PostgreSQL server to the collation provider the workflow asks for | The order case could run green where it cannot fail | CI | No test read the cluster's provider | `DURABLERUN_POSTGRES_LOCALE_PROVIDER` in the three jobs with the service, and a case that holds the server to it (rung 3) |
| 6 | One message for two states: a version that failed to advance, and a schema newer than the build | Wrong advice to an operator, who is told to repair a healthy database by hand | A case for `migrate()` on a schema newer than the build | The one such case, on libSQL, asserted the error's class and not its message | The message says a newer build migrated the database and to run that build, on all three stores, with a case on each (rung 3) |

The review's numbers for these are 1, 2, 3, 4, 6 and the last part of 10.

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: the built-in code review skill at high, each finding then checked by the reviewer, several with probes on a server only the reviewer used | 6 | No |
| This project's own machinery | 0 | Yes |

Self-catch rate: 0 of 6, or 0% (previous round: 9%, PR #63's).

Before the review this PR's own machinery did find defects, which are not
counted here because they never reached a reviewer: the order case went red by
name on a linguistic server, and a probe with the server's own deadlock
counter measured the deadlock between racing migrators that version 7
introduced. Both MEDIUM findings of the review are of one kind, and it is the
kind that probe was built against: a measurement whose inputs could not
produce the failure, read as evidence that the failure does not happen. The
machinery found it for racing migrators and not for live traffic, in the same
PR, which is the subject of the next section.

## Recurrence

A measurement that cannot produce the failing input. This class recurred
inside this PR. Before the review, the first racing migrators probe
under-measured the deadlock, 1 round in 10 where a probe with warmed
connection pools saw 61 in 100, because cold pools spread the migrators in
time. What was instituted then was a note: warm the pools, and count with the
server's counter in a database nothing else uses. That is a lesson about care,
which AGENTS.md calls a red flag and not a prevention, and it did not carry to
the next harness: the live traffic harness sent five write calls, no read and
no event batch, and its result was written down as "no caller saw an error".
The note checked how a harness counts. It was supposed to check what a harness
can produce.

An assertion that no registered mutation holds (finding 3). AGENTS.md records
the first instance: two conditions of the wake surface could be deleted with
all 1,728 cases green. The mechanism named then, a mutation for every
condition (PR3.10), is deferred and not built, so this class is still held by
review alone, and this round is the evidence.

A proxy where the property fits (finding 4). "Is waiting on a lock" stood for
"waits for the runner's lock while it holds nothing". AGENTS.md's catalogue of
this class has five entries, and every one of them, like this one, was a check
written by hand and examined by nobody. The standing rule against it is prose,
so it recurs wherever a new predicate is written. It has recurred in every
round whose postmortem names the class.

A gate whose precondition is read from text (finding 5). `gate-lint` counting a
textual `scripts/foo` as execution is the recorded instance. Here the workflow's
text asked for ICU and nothing read the server.

One message for two states (finding 6). No earlier instance was found.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The deadlocked read case and its mutation | 3 | Run: `(mode !== 'read' \|\| statements.length === 1) &&` put ahead of the attempt bound in the executor's decision. The case and the unit case both pass, 23 of 23, and the sweep's scan, a read batch of two statements, is reported to its caller again. The case drives one read of one statement |
| The lock order case and its mutation | 3 | Run: `LOCK TABLE tasks, runs, checkpoints, events, waits, event_locks, drivers, meta`. The case passes, because both arrivals wait for `tasks` holding nothing. That order was measured: 65 errors at callers of the older build where the committed order gave 51, and 18 of the 65 were a worker's checkpoint read where the committed order gave none. The case holds "`meta` last". The order among the store tables was chosen by measurement and is held by nothing but the frozen hash, which fails on this edit (run) and on any other |
| The racing case's lock table predicate | 3 | Not run: no variant was found in which two migrators of one version deadlock while the second waits for the runner's lock holding nothing. The bootstrap batch takes no such lock and is outside the case, and `conformance/test/postgres-bootstrap-window.test.ts` holds that batch |
| The index key mutation | 3 | Not run: the mutant is one key of one index. A catalog query narrowed to a set of indexes that still holds `runs_woken` kills the same mutant and reads fewer indexes. The floor on the number of keys is what holds the count, and no mutation holds the floor |
| The provider variable and its case | 3, and syntactic at one end | Run: the variable unset and a server that sorts by bytes. The case passes, 3 of 3. A workflow that loses the service's arguments and the variable together is green, and the two sit twelve lines apart in one file. The case holds the server to the variable, and nothing holds the variable to the arguments |
| The newer schema message and its three cases | 3 | Not run, because there is no fourth store: each store builds the message itself, so a new store's `migrate()` could say "repaired by hand" and no case of the other three would see it. The cases match one phrase of the message |
| The corrected sentences of DESIGN.md and BUILD.md | none, prose | Any later sentence. Nothing reads DESIGN.md |

## Fix-induced defects

None is known. The fixes were tested again and were not reviewed again, which
is the maintainer's rule of one review for a pull request. One fix changed
course before it was committed, and a measurement caught it, not a test: moving
`meta` to the end of the list and leaving the rest committed every migration
but gave callers of the older build 65 errors where `meta` first gave 13. The
list was then put in the order the engine's own statements take their locks,
and measured again: every migration committed, and 51 errors, every one a
driver's sweep scan, whose statement names `tasks` before `runs`.

## Evidence

- Red tests: commit `4552ad7`, run and seen failing (1 test) on two servers against `9108468`, the reviewed head as it stands on this base. It needs a PostgreSQL server, and its failure reads `Expected: "returned"`, `Received: "StoreUnavailableError: batch(next-wake) failed (SQLSTATE 40P01): error: deadlock detected"`.
- Fixes: commit `3ded5e8`, which turns `4552ad7` green on both servers. Commit `efdc888` then holds the executor's count of victims at one for that read.
- Red tests: commit `816d1a6`, run and seen failing (1 test) on two servers against `9014e50`. It needs a PostgreSQL server. Its failure shows the spawn holding `tasks RowExclusiveLock` and the sweep holding `runs AccessShareLock` and `tasks AccessShareLock` while each waits, where both must hold nothing.
- Fixes: commit `c0ac52d`, which turns `816d1a6` green on both servers and freezes version 7's new text.
- Red tests: commit `a2323ff`, probe `packages/store-postgres/test/admin.test.ts` `tells a build older than the schema to run a newer build, and never to repair`, run and seen failing (3 tests, one on each store) against `55f0fab`. Each read `expected 'migrate finished with the schema reco…' to match /a newer build migrated this database/`.
- Fixes: commit `f6c86f0`, which turns `a2323ff` green on the three stores.
- Red tests: none is committed apart from its fix for finding 3. Its mutant was applied by hand before the fix was committed and failed the case by name with the new marker: `expected [ 'runs_woken key 2' ] to deeply equal []`. The column assertion beside it stayed green.
- Fixes: commit `6c7479d` for finding 3.
- Red tests: none is committed apart from its fix for finding 4. With the runner's lock removed by hand, the rewritten case failed at all seven versions with `"secondWaitsFor": "transactionid ShareLock"` where the case as it was differed at version 7 alone.
- Fixes: commit `b30f1db` for finding 4.
- Red tests: none is committed apart from its fix for finding 5. With `icu` declared, the case passed on a server created with ICU and failed by name on a server of the same image created without the arguments: `Expected: "icu"`, `Received: "libc"`. With nothing declared it passed there.
- Fixes: commit `55f0fab` for finding 5. The documents' corrections for findings 1, 2 and 6 are commit `62c678c`.
- Finder: the one review, quoted verdict: "The byte collation is correct and well held: the catalog test, the order case, the three mutations and the racing-migrators fix all reproduce. There is nothing HIGH. There are two MEDIUM findings, both about version 7 under live traffic, where DESIGN.md claims more than was measured."
- The reviewer's reproduction of finding 1, quoted: "One open transaction had read `tasks`, head's `migrate()` started, and main's `nextWakeAtEpochMs` started 0.5 s later. The transaction ended 0.3 s after that. The read failed at 1,504 ms with `StoreUnavailableError: batch(next-wake) failed (SQLSTATE 40P01)`, and `migrate()` committed at 1,525 ms." And why the PR's runs missed it: "It sends no read batch and no event batch."
- The reviewer's reproduction of finding 4, quoted: "With the runner's lock removed, only the version 7 row differs (`23505` becomes `40P01`). `secondWaited` is true either way."
- The measurements behind finding 2's fix. Four workers and two drivers of the build on main sent write batches, read batches and event batches at an empty schema while the branch's `migrate()` took version 7, 80 migrations for each order and each order on a server of its own. With `meta` first: 69 of 80 committed, a median of 3.0 seconds, 568 deadlocks by the server's counter, 13 errors at callers. With `meta` last and the rest as declared: 80 of 80, 1.0 seconds, 339 deadlocks, 65 errors. In the committed order: 80 of 80, 1.0 seconds, 126 deadlocks, 51 errors, every one a driver's sweep scan. At scale in the committed order the version committed in 12 of 12 runs at a million rows a table and in 6 of 6 at four million, each on its first attempt, and callers of the older build saw 4 errors, each a sweep scan.
- PR #63's contest "admin migrate of a database nobody has migrated" ran 50 times on PostgreSQL at the head of this branch, in a database nothing else used: 50 of 50 passed, the contest holds each executor's count of victims at zero, and the server counted no deadlock in that database.
- Not counted, and why. The review's findings 7, 8, 9 and 11 and the rest of 10 are hygiene of a test, a comment, two counts in BUILD.md, a hand-off parked under a finished entry, and sentences of the operator's note. They are folded in commits `b30f1db`, `4f66c65`, `c2b2b15`, `9014e50` and `62c678c`. Findings 5 and 12 are options, listed in the PR body with a sentence each.
- Claims that did not reproduce. The review wrote "Not reproduced: three migration losses in a row. There were none in my 100 live rounds or the author's 46." With event batches added to the traffic it reproduced at once: 11 of 80 migrations with `meta` first. My own first reading of `meta` first, that the version is the usual victim, was wrong: the server's log classed 345 of 363 victims as a worker's or a driver's write, 14 as a read and 4 as the version. Two claims of the review skill were refuted by the reviewer and are not folded: that a regression which skips empty versions would pass libSQL's schema gate case ("backwards: such a regression would now be caught"), and that the 16 minutes in the verify job's comment has no source ("verify's fastest success in the saved data is 962 s").

## Root cause

The PR's evidence about live traffic came from a harness written to answer one
question, whether the version commits, and its result was then used to answer
another, what callers see. The harness's inputs were chosen by hand: five
calls, all of them write batches. Nothing in this project derives a traffic
mix from the store's ports, the way PR #63's surface derives its contests from
them, so a harness covers what its author thought of, and a sentence such as
"no caller saw an error" carries no record of what was sent.

Findings 3, 4 and 5 have the same cause at a smaller scale. Each is a check
whose reach was asserted by the one who wrote it and examined by nothing: a
half of a test with no mutant, a predicate that one version of seven
satisfied, and a server assumed to be what a workflow asked for. The mutation
audit answers "does some test fail when this line changes". It does not answer
"what does this assertion hold", and both MEDIUM findings and three of the
four LOW ones sit in that gap.

## Mechanisms

Built in this PR:

- The executor runs a deadlocked read batch again, held by
  `store-postgres/test/deadlocked-read.test.ts` without a race, by a unit case,
  and by the mutation `postgres-deadlocked-read-runs-again` (rung 3).
- Version 7 takes its locks in the order the engine's statements do, `meta`
  last, held by `store-postgres/test/version-lock-order.test.ts` for every
  version whose first statement takes table locks, and by the mutation
  `postgres-version-locks-meta-before-the-store-tables` (rung 3).
- The racing migrators case reads what the second migrator waits for and what
  it holds, so its mutant fails at every version (rung 3).
- The mutation `postgres-index-key-keeps-another-collation` (rung 3).
- `DURABLERUN_POSTGRES_LOCALE_PROVIDER` and the case that holds the server to
  it (rung 3).
- One message for a schema newer than the build, on three stores, with a case
  on each (rung 3).
- The operator's note says what was sent and what callers saw, and what the
  note left out (none, prose).

Deferred (recorded in BUILD.md):

- The lock order case over every call of the store's two ports, generated as
  PR #63's contests are, and a case that holds each worker read's table order
  to the list's. Both are options in the PR4.6 entry, and their trigger is the
  next version that locks tables: version 7's text is frozen once it is on
  main, so nothing can change its order before then.
- A short `lock_timeout` on a version's lock statement, with reruns, for a
  deployment that must migrate under sustained traffic. An option in the same
  entry.
- A mutation for every condition of a test is PR3.10's, which stays deferred.

## What this round still would not catch

- An executor that stops running a deadlocked read again when the batch holds
  more than one statement would ship today. The case and the unit case both
  drive a batch of one statement.
- A lock list that ends in `meta` and crosses a worker's read would ship
  today in the next version that locks tables. The lock order case holds where
  `meta` comes, and only a measurement chose the rest.
- A harness whose traffic cannot produce a failure, written down as a claim
  about callers, would ship today. Nothing generates a traffic mix from the
  store's ports, and nothing records what a measurement sent beside what it
  found.
- A workflow that loses the ICU arguments and the variable together would be
  green today.
- A fourth store whose `migrate()` tells an operator to repair a healthy
  database would ship today.
- A sentence of DESIGN.md that says more than was measured would ship today.
  Nothing reads DESIGN.md.
