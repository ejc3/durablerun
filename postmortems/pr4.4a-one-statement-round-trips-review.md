# Postmortem: PR4.4a one-statement round trips review (PR #64)

PR #64 sends a batch of one statement alone, with no transaction around it, on
MySQL and PostgreSQL, so that the hot reads of a driver tick cost one round
trip. Its first version decided which batches qualify from a statement's text
and binds. A read went alone when its text began with SELECT, and on PostgreSQL
also named no INTO. A single write went alone on MySQL when no bound string
ended in a space. It passed every local gate, the unfiltered mutation audit
included, with a registered mutation and a server case for each condition. One
full review then reproduced, with main as the control, a write that MySQL cut
to fit and committed before the executor refused it, and a DELETE sent behind a
SELECT that ran as a read on PostgreSQL. Neither is reachable through a
statement the stores send today. Both sit at the executor port, which takes
text from any caller. The rule now asks where a statement came from: core
brands what its read path compiles, only such a read and MySQL's canonical
schema-version read go alone, and no write does. A second review, of that
fold, then ran a read that core built whose fragment held a second statement,
which PostgreSQL ran once the read went alone as plain text, and found that the
MySQL executor decided whether a batch goes alone after its wait for a
connection. Eight findings are counted.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding is a durable string stored cut while its writer is told it
was refused. On MySQL a single write sent alone had committed before the
executor read its warning count. MySQL cuts, with note 1265, a value that ends
in a tab, a line break, a vertical tab, a form feed or a carriage return as it
cuts one that ends in a space, and it does the same for a bind sent as bytes,
for a literal written into the statement's text, and under INSERT IGNORE for a
key one letter too long. The condition looked for a bound string ending in a
space and nothing else. Each of those writes stored a key cut to 255
characters and then raised the refusal. Main raised the same refusal and
stored nothing. Two identifiers that differ past their 255th character would
have been stored as one.

The second is a write that ran where the port promises a read. On PostgreSQL a
read of one statement sent as text ran outside the read-only transaction
whenever its text began with SELECT and did not hold the word INTO.
`SELECT 1; DELETE FROM meta ...` deleted the row, because a statement with no
binds goes through the simple query protocol, which runs every statement in
the text. `SELECT nextval(...)` and `SELECT setval(...)` advanced a sequence.
Main refused all three with 25006.

Neither is reachable through the stores today. Their only single writes are
`expire-lease-now` and the two test clock writes, every one-statement read
batch in the corpus is tree-built, identifiers are held to 255 at every store
entry, and the schema has no sequence. The port is public, though: fixtures,
tests and any later text statement go through it, and the PR's own documents
said the text test failed safe.

The four low findings: a read sent alone on PostgreSQL runs at the pool's
default isolation level, where main named REPEATABLE READ. A write whose
result the executor refuses was already committed, on both dialects. Nothing
held the MySQL session's `autocommit = 1`. A single `LOCK TABLE` on PostgreSQL
failed with 25P01 where main accepted it.

The fold's review found the second again, one layer in. A read that core built
carried a store fragment whose text held `; DELETE ...`. Core brands such a
read, because it reads a fragment for clocks and comments only. Sent alone as
plain text, PostgreSQL ran the DELETE and the caller got an error, where the
same text sent as a read was refused with 25006 and the row kept. MySQL refused
both with 1064. No store reaches it: a fragment is store source, and none holds
a second statement. The sentence the fold had added to DESIGN.md, that such a
statement writes nothing, was false, and it is the sentence the rule rests on.
That review's other counted finding was introduced by the fold. The MySQL
executor asked whether a batch goes alone after its wait for a connection, of
the caller's array as it was by then, so a delete passed as a read and swapped
for a branded read during the wait was sent with no transaction. No caller does
that: `FencedBatch.run` passes a fresh array.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A single write that MySQL cut to fit committed before the executor refused it | The caller is told the write was refused and the cut key is stored. Reproduced for a trailing tab, line break, vertical tab, form feed and carriage return, a bytes bind, a literal in the text, and INSERT IGNORE. Not reachable through the stores | The condition's own registered mutation and server case | Both were written from the condition's picture of the property, one spelling, a trailing space. The mutant died and the hole stayed open | No write is sent alone: the path is deleted, rung 1. The server case now writes a key ending in a tab and owns `mysql-lone-statement-is-a-read`, rung 3 |
| 2 | On PostgreSQL a write inside a read sent as text ran outside the read-only transaction | `SELECT 1; DELETE ...` deleted, and `nextval` and `setval` advanced a sequence, where main refused each with 25006. Not reachable through the stores | The guard's server case and the mutation of the prefix test | It tried two spellings, DELETE and SELECT INTO. A test of text can only enumerate spellings, and SQL has no end of them | Provenance in place of text, rung 1 against text: core brands what its read path compiles, frozen, and only a branded read goes alone. The server case `SELECT 1; DELETE` owns `postgres-lone-read-is-known-to-be-a-read`, rung 3 |
| 3 | A read sent alone on PostgreSQL runs at the pool's default isolation level | Over a pool whose default is SERIALIZABLE the read runs at that level and read-write, where main ran it at REPEATABLE READ, READ ONLY. A serialization failure there is reported as an outage and not run again. The premise was reproduced and the failure was not | DESIGN.md's answer on isolation, which the exit test required | It answered whether one statement reads one snapshot, and not what else naming the level had given | None. DESIGN.md now states what a pool's owner must leave alone. A sentence is not a mechanism, and the audit below says so |
| 4 | A write whose result the executor refuses was already committed | `UPDATE ... RETURNING true` stored its value and then threw, where main rolled it back. Both dialects | The list of what a transaction gives a batch, in DESIGN.md and in the rule's doc comment | The list was written from each statement's success path. The executor's two refusals that come after the server has run a statement, the cut and the result contract, were found one at a time | No write is sent alone, rung 1. A server case owns `postgres-lone-statement-is-a-read`, rung 3 |
| 5 | Nothing held the MySQL session's `autocommit = 1` | With the line deleted all 33 tests of the three MySQL files passed. On a server whose default is off, a read sent alone would open a transaction that stays open on a pooled connection | The rule that a new guard gets a registered mutation | The line was not seen as a guard, because the server's default already is 1, so no test on a default server could fail | A unit case on the session settings and `mysql-session-autocommit-on`, rung 3 and syntactic |
| 6 | A single `LOCK TABLE` on PostgreSQL failed with 25P01, where main accepted it | No caller sends one. A statement that is only legal inside a transaction block could not be sent as a batch of one | Nothing: no case enumerated statements that need a block | The equivalence argument weighed what a transaction gives a statement's effects, and not statements that need one to run at all | No write is sent alone, rung 1 |
| 7 | A read that core built whose fragment holds a second statement ran both on PostgreSQL | The DELETE ran and the caller got an error, where main refused the same text with 25006 and kept the row. MySQL refused both. Not reachable through the stores | The fold's own mechanism audit, which had run a fragment that calls `nextval` and recorded the class as an option | It exhibited one input, a sequence step, and wrote the boundary as a function a fragment calls. Nothing asked what else a fragment's text can hold, and DESIGN.md then said such a statement writes nothing | A read sent alone goes through PostgreSQL's extended protocol, which takes one statement (`oneStatement`), rung 1 for a second statement on that server. MySQL takes one statement in a text over a pool the store opens. A server case owns `postgres-lone-read-is-one-statement`, rung 3 |
| 8 | The MySQL executor decided whether a batch goes alone after its wait for a connection | A delete passed as a read, and swapped in the caller's array for a branded read during the wait, was sent with no transaction. Introduced by the fold. No caller does it | The fold's unit cases on what goes alone | Each passes an array nobody touches again. The first version read the executor's own copy. The fold moved the question to the caller's object, for its identity, and left it after the wait | The decision stands beside the copy, before any wait, as PostgreSQL's did, rung 3: a unit case owns `mysql-lone-send-is-decided-with-the-copy` |

## Detection ledger

The branch had passed every local gate before the review read it: the
unfiltered audit with every mutant caught, conformance on three dialects, the
corpus, the round-trip pins and the fuzz run. Every counted finding came from a
review, and the fold's own gates were as green before the second review as the
first version's had been before the first.

Our machinery did catch one break of this PR before the review. The final
gates' run of the whole conformance directory failed the bootstrap window test,
which had used a read batch of one statement as its way to a REPEATABLE READ
transaction. It is not counted: a defect the author's machinery finds before
review is the system working.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #64: the built-in review skill as one subagent, eight finders and a verifier over 17 candidates, and the reviewer's own server probes with main as the control | 6 | No |
| The one review of the fold: the built-in review skill at medium effort as one subagent, five finders and a verifier, and the reviewer's own server and unit probes on private servers | 2 | No |
| This project's machinery: unit cases, server cases, round-trip pins, conformance on three dialects, the corpus, the fuzz run, the unfiltered mutation audit | 0 | Yes |

Self-catch rate: 0% (previous round on main, PR3.9f part 2's: 0%. The
previous round on this work, the MySQL store's: 0%).

That is zero again, and the reason is the same as in the MySQL store's round:
what the review found was not a regression of anything the machinery measures.
The machinery measures whether the engine's statements behave identically on
every dialect. These eight are about what the port does with statements the
engine does not send.

## Recurrence

**A proxy standing where a property fits. Recurred, in its plainest form.**
The property is what a statement is: whether it writes, and whether MySQL can
cut what it stores. The proxy was how its text begins and how its binds end.
That is the class AGENTS.md catalogues, beside a lint that matched one spelling
of a clock and a rule that checked a statement's text for a fence. The earlier
mechanism against it is the largest in the repository: statement trees replaced
text in core and in every store, so a rule reads a node and not a spelling, and
one checked list names the eight statements that stay text. It did not work
here because it stops at the executor port. A statement crossing the port
carried its text, its binds and its gate, and nothing about how it was built.
The one layer below the trees therefore had only a picture to decide from, and
this PR gave that layer a decision that needed the property. The earlier
mechanism was not a proxy. Its reach ended one layer too high, and the fix
carries the fact across the port.

**A mechanism with one failing case treated as proven. Recurred.** AGENTS.md
records it from the wake surface, where two conditions could be deleted with
every case green, and PR3.10's work on it is deferred. Here every condition had
a registered mutation and the audit was green, and both holes were open. A
mutation shows that a test fails when a condition is REMOVED. It shows nothing
about whether the condition is COMPLETE, and the test that kills the mutant is
written from the same picture as the condition. The reviewer stated it
exactly: two of the new mechanisms passed with their holes in place. The audit
cannot see an incomplete condition by construction, so a green audit over a
condition that enumerates spellings is not evidence about the spellings it
forgot. This round deleted both conditions and did not complete them, which
removes these two instances and leaves the class where it was.

**An exhibited false negative, read as one input and not as a boundary.
Recurred inside this round.** The fold's own mechanism audit ran a branded read
whose fragment called `nextval`, and recorded that the brand says where a
statement came from and not what a fragment calls. Finding 7 is that boundary
again: the fragment's text held a second statement. The audit had been run and
written down, and DESIGN.md still said such a statement writes nothing, because
the exhibit was kept as one input, a function call, and the sentence was written
from the mechanism's picture of itself, a closed grammar of nodes. A false
negative belongs to the mechanism's boundary and not to the input that showed
it. The comments and DESIGN.md now say what the brand does NOT say, and the
part a server can refuse by structure is closed there.

## Mechanism audit — the false negative of each

Each row below was written and run against the fixed code, except where it
says otherwise.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| No write is sent alone | 1 | No false negative found for a write through these executors. Tried on a server, and each refused with nothing changed: a key ending in a tab sent as a single write, a single UPDATE whose RETURNING the executor refuses, and a DELETE sent as a read in text. Its boundary is the executor: a write sent through another client has no such guard |
| Only a read core branded goes alone (`isTreeBuiltRead`) | 1 against text. 3, by trust, against a store's own fragment | Ran against PostgreSQL. A read built through `prepareRead` and `readPrepared`, a SELECT from `meta` whose WHERE holds the store-owned fragment `nextval('probe_seq') > 0`, was branded, sent alone and accepted, and the sequence read `is_called = true` after it. The same text sent as a read was refused by the server and left `is_called = false`. Core reads a fragment for clocks and comments, and not for the functions it calls, so the brand shows where a statement came from and not what its fragments do. Six of the nine shared read statements hold a fragment, the next-wake read and the task result among them, so the brand cannot be kept to reads with no fragment without losing what this PR is for |
| The brand is frozen (`brandRead`) | 1 for the statement object | The `args` array of a read built by `readTree` is not frozen. Ran at unit level: a bind changed after core built the read went out alone with the new value, and the statement sent still began with `select`. The statement is frozen and assigning its `sql` threw, and its `args` array is not frozen. It is no defect, because a bind is data and cannot make a SELECT write. A wrapper that copies a statement loses the brand and its copy keeps the transaction, which is the safe side. Ran: the measuring wrappers of this PR's own server tests do exactly that |
| The unit case on the session settings, and `mysql-session-autocommit-on` | 3, syntactic: it reads the text of `SET SESSION` | Ran on a server. A pooled connection on which another user of the pool later runs `SET autocommit = 0` passes the case, because the settings are sent once for each physical connection and never again. A read sent alone on it would open a transaction that stays open. It is the boundary the MySQL store round's audit ran for a shared pool, and DESIGN.md already says a pool handed to `fromPool` must not be shared Over a caller's pool of one connection, after the settings had been sent, another user of the pool ran `SET autocommit = 0` and released the connection. A read that core built, sent alone, was accepted, and that connection then held one open transaction where it had held none. |
| DESIGN.md states what a read sent alone asks of a pool's default isolation level | None: a sentence | A pool created with `default_transaction_isolation = serializable` passes every gate. The reviewer ran the premise: over such a pool a one-statement read ran at serializable, read-write. Nothing refuses the pool |
| The three server cases of the fold, each owning a mutation | 3, one input each | Ran in a scratch copy. Each case is one input: a tab, `SELECT 1; DELETE`, `RETURNING true`. A rule that sent a single write alone unless a bound string ends in a tab would still commit a key cut at a line break, and would pass all three. One input is enough for the conditions as they stand, because neither has a spelling in it: one is the batch's mode and the other is the brand. It stops being enough the day either is widened by a test of text Under exactly that rule all three cases passed, and a single write of a key of 255 characters and a line break was refused with one row stored, where a key ending in a tab was refused with none. |
| A read sent alone is one statement (`oneStatement`, `postgres-lone-read-is-one-statement`) | 1 for a second statement on PostgreSQL. None for what the one statement calls | Ran on a server against the fixed executor. A read that core built whose fragment is `nextval('probe_seq') > 0` was accepted and the sequence went from not called to called, where the same text sent as a read was refused with 25006. On MySQL the refusal is the server's default and not the executor's: over a caller's pool with multiple statements switched on, which `fromPool` accepts, the two-statement read ran its DELETE and the row was gone, where a pool the store opens refused it with 1064 |
| The decision stands beside the copy (`mysql-lone-send-is-decided-with-the-copy`) | 3 | Ran at unit level. An array that answers a delete to the first read of its first element, and the branded read to every later one, within one tick, had its delete sent alone. Both executors read the caller's array once to copy it and again to decide. Only code inside the process can build such an array, and that code can reach the pool itself, so it is recorded and not closed. One snapshot of the array, read for both, would close it |

## Fix-induced defects

One of the eight. Finding 8 was introduced by the fix for finding 2. Asking the
caller's own object for its brand moved the question from the executor's copy
to the caller's array, and it was left after the wait for a connection. The
fold's fixes had been re-tested and not read as new code, which is how it got
through, and the second review was run because the fold changed product
behaviour. Finding 7 is not fix-induced in the code, which sent such a read
alone before the fold as well. The false sentence about it was the fold's.

In the first fold the reviewer's probes for findings 1, 2 and 4 became the
three red cases, and the ten mutants that fold changed or added were probed and
each was caught by its own verdict. In the second, the reviewer's two probes
became the two red cases, the two new mutants were applied by hand and each was
caught by its own verdict, and every false negative in the table above was
run. The second fold's fixes were not reviewed again.

One fold commit did break a gate. The fix that brands reads added a condition
to `addTree`, which the freeze commit then rewrote, and main's registry, which the base gate reads, holds no mutation
on that line, so the base gate refused the tree until its bridge listed the
line. The author's final gates caught that before anything was pushed.

The fold did leave two things behind that a careless fold would have kept.
Deleting the write arm made the lock condition dead code, because a lock
coordinate always comes with a write, so its two mutations had become
equivalent mutants that the old cases would have gone on killing for the wrong
reason. PostgreSQL's schema-version condition became redundant the same way,
because that read is text. All three conditions and their mutations are
deleted.

## Evidence

- Red tests: commit `dd55249`, "Red: a statement sent alone commits what its
  transaction would have refused", run and seen failing (3 cases) against
  `4d45e64`, the head the first review read.
  "refuses a single write whose key ends in a tab and
  would be cut to fit, and writes nothing": expected { refused: true, stored:
  1 } to deeply equal { refused: true, stored: 0 }. "refuses a delete sent
  behind a select in one read, and keeps the row": the row gone, and "Cannot
  read properties of undefined (reading 'map')" for an answer. "rolls back a
  single write whose result it refuses": value 'after' where 'before' was
  expected.
- Fixes: commit `0487fa9`, "Send alone only a read the executor knows to be a
  read", which turns the three cases green, with `9b571bb`, "Say in DESIGN.md
  and BUILD.md which statements go alone, and why no write does", and
  `9f4a20f`, "Freeze what core brands as a read". Checked before this file was
  committed: the suites of core, the SDK, the driver and the three stores, the
  registry's count by import of a copy, and the filtered probes of the ten
  mutants the fold changed or added, all caught by their own verdicts with no
  collateral failure. The full gates of the final head, with their counts, are
  in the pull request's body.
- Red tests: commit `f854fbf`, "Red: a read that core built can carry a second
  statement, and MySQL decides after its wait", run and seen failing (2 cases)
  against `aa4b09f`, the head the second review read. "refuses a read that
  core built whose fragment holds a second statement, and keeps the row": kept 0
  where 1 was expected, and "Cannot read properties of undefined (reading
  'map')" for an answer. "decides whether a batch goes alone when it copies the
  statements, and not from what the array holds later": expected [ 'DELETE FROM
  t' ] to deeply equal the read-only transaction around it.
- Fixes: commit `1701e41`, "Send a read alone as one statement on PostgreSQL, and
  decide on MySQL beside the copy", which turns both cases green. Measured for
  it: over loopback a statement with no bind cost 61 microseconds through the
  extended protocol against 57 through the simple one, the driver already chose
  the extended protocol for every statement with a bind, which every read of
  the stores has, and the three lone reads of the bench did not move.
- Finder: the one full review of PR #64. Quoted verdict: "No HIGH findings on
  PR #64, but two MEDIUM ones: in both, main refused the write and wrote
  nothing, and this branch commits it. Both were reproduced on a server and sit
  at the executor port. Neither is reachable through the store's own statements
  today."
- Finder: the one review of the fold. Quoted verdict: "No HIGH findings remain
  in the fold of PR #64, but one MEDIUM does, and wording alone fixes it in
  minutes. Everything else is LOW." Its notes that are not product findings
  were corrected in the same fold: stale comments above the pins and in two
  executor comments, slips in the pull request's body, three in this document
  (which commit added the `addTree` condition, how many test files are main's
  text, and three false negatives given as not run, which are now run), and
  registry counts in four commit messages, which now say what changed and
  state no number.
- The reviewer on the two mechanisms that were blind: "Two of the new
  mechanisms pass with their holes in place: `mysql-lone-write-binds-no-
  trailing-space`, `postgres-lone-read-begins-with-select`."
- Claims that did not reproduce. The review skill's finding that no test fails
  if the schema-version read's text changes was refuted: with a leading comment
  the marked assertion fails, with four statements sent where one is expected.
  Finding 3's failure, a serialization failure inside a read sent alone, was
  not produced, only its premise. The snapshot probe found nothing: on both
  servers one statement answered with one count while another session committed
  a row during its sleep, and two statements of one READ COMMITTED transaction
  answered with two, so the probe can fail. A no-break space, an ideographic
  space, a NUL and a letter past the width each got error 1406 on both sides,
  so MySQL's cut class is its own space class and no wider. MySQL's own pool
  rejected the two-statement text with 1064 on both sides, so finding 2 is
  PostgreSQL's alone. The review did not run `lo_create`, the 40001 failure, or
  a pool with multiple statements switched on.

## Root cause

The executor port is the one layer under the statement trees, and what crosses
it is text. The repository's ratchet had moved every decision about a statement
up into trees, where a rule reads a node. This PR put a new decision below
them, in the layer that cannot see a node. The decision needed two facts about
a statement, that it writes nothing and that nothing it stores can be cut. The
layer had the statement's text and binds, so it approximated both, and the exit
test's own words, "when the executor can show that what the transaction gave
still holds", were read as "when a test of the text passes".

The verification then inherited the approximation. Each condition got the
mutation and the server case its author could think of, which is one spelling,
and the audit, which measures whether a test can fail and not whether a
condition is complete, went green. The design's list of what a transaction
gives a batch was written from each statement's success path, which is why the
executor's two refusals that come after the server has run a statement, and
the statements that need a block to run at all, were each found separately and
by someone else.

## Mechanisms

Built in this PR:

- No write is sent alone, rung 1 by deletion: `sentAlone` in both executors
  answers false for any batch not in read mode. Findings 1, 4 and 6.
- Provenance across the port, rung 1 against text: core's `isTreeBuiltRead`,
  minted by `brandRead` in `readTree` and `readPrepared`, which refuse a root
  that is not a SELECT, and frozen as it is minted. Both tests of text are
  deleted. Finding 2.
- Three server cases and six registered mutations that own the new conditions,
  rung 3. The seven mutations of the deleted conditions are gone with them.
- A unit case and a mutation for the session's `autocommit = 1`, rung 3 and
  syntactic. Finding 5.
- Two test files are main's text again, the pool lifecycle test and the
  bootstrap window test, so the latter runs the executor's own read transaction
  against a server, which the first version had taken away. The two executor
  unit files keep every case main has and add the folds' cases.
- One statement for a read sent alone on PostgreSQL, rung 1 for a second
  statement: `oneStatement` sends it through the extended protocol, and a
  server case owns `postgres-lone-read-is-one-statement`. Finding 7.
- The MySQL executor decides beside the copy it sends, before any wait, rung 3:
  a unit case owns `mysql-lone-send-is-decided-with-the-copy`. Finding 8.

Deferred (recorded in BUILD.md):

- Reading a read's fragments for the functions they call. It is an option and
  not a deferral of this PR: no read of the stores calls a function that
  writes, a fragment is store source and not text that arrives at run time, and
  its trigger is the first store read that calls a function outside core's
  list.
- A rule in core's fragment parser that refuses a semicolon outside a literal.
  It is an option and not a deferral: both servers already refuse a second
  statement, and it is a new condition of a tree rule. A MySQL pool handed to
  `fromPool` with multiple statements switched on is outside what was checked,
  and the option says so.
- A shared conformance case that a write sent as a read is refused on every
  dialect. Server cases hold it on the two servers, where the exit test asks.
- Checking a PostgreSQL pool's default isolation level once for each client.
  DESIGN.md states the requirement, and nothing refuses a pool that breaks it.

## What this round still would not catch

- A MySQL pool handed to `fromPool` with multiple statements switched on ships
  today, and over it a read that core built whose fragment holds a second
  statement runs both. The audit above ran it.
- A store read whose fragment calls a function that writes ships today. It is
  branded, sent alone, and runs outside the read-only transaction that would
  have refused it. The audit above ran it.
- A PostgreSQL pool whose default isolation level is SERIALIZABLE ships today,
  and a serialization failure in a read sent alone over it is reported as an
  outage.
- A pooled MySQL connection whose autocommit another user of the pool turned
  off ships today, and a read sent alone on it leaves a transaction open.
- An incomplete condition with a registered mutation ships today. The audit
  shows that a test can fail when a condition is removed, and nothing about the
  inputs the condition forgot. This round removed the two conditions it found
  and did not complete them, so the next condition written from a picture will
  pass the audit the same way.
- A decision added below the trees at any other place that takes text, such as
  the admin's statements or a fixture, has the same shape, and nothing flags
  it.
