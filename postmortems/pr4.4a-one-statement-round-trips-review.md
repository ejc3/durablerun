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
schema-version read go alone, and no write does. Six findings are counted.

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

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A single write that MySQL cut to fit committed before the executor refused it | The caller is told the write was refused and the cut key is stored. Reproduced for a trailing tab, line break, vertical tab, form feed and carriage return, a bytes bind, a literal in the text, and INSERT IGNORE. Not reachable through the stores | The condition's own registered mutation and server case | Both were written from the condition's picture of the property, one spelling, a trailing space. The mutant died and the hole stayed open | No write is sent alone: the path is deleted, rung 1. The server case now writes a key ending in a tab and owns `mysql-lone-statement-is-a-read`, rung 3 |
| 2 | On PostgreSQL a write inside a read sent as text ran outside the read-only transaction | `SELECT 1; DELETE ...` deleted, and `nextval` and `setval` advanced a sequence, where main refused each with 25006. Not reachable through the stores | The guard's server case and the mutation of the prefix test | It tried two spellings, DELETE and SELECT INTO. A test of text can only enumerate spellings, and SQL has no end of them | Provenance in place of text, rung 1 against text: core brands what its read path compiles, frozen, and only a branded read goes alone. The server case `SELECT 1; DELETE` owns `postgres-lone-read-is-known-to-be-a-read`, rung 3 |
| 3 | A read sent alone on PostgreSQL runs at the pool's default isolation level | Over a pool whose default is SERIALIZABLE the read runs at that level and read-write, where main ran it at REPEATABLE READ, READ ONLY. A serialization failure there is reported as an outage and not run again. The premise was reproduced and the failure was not | DESIGN.md's answer on isolation, which the exit test required | It answered whether one statement reads one snapshot, and not what else naming the level had given | None. DESIGN.md now states what a pool's owner must leave alone. A sentence is not a mechanism, and the audit below says so |
| 4 | A write whose result the executor refuses was already committed | `UPDATE ... RETURNING true` stored its value and then threw, where main rolled it back. Both dialects | The list of what a transaction gives a batch, in DESIGN.md and in the rule's doc comment | The list was written from each statement's success path. The executor's two refusals that come after the server has run a statement, the cut and the result contract, were found one at a time | No write is sent alone, rung 1. A server case owns `postgres-lone-statement-is-a-read`, rung 3 |
| 5 | Nothing held the MySQL session's `autocommit = 1` | With the line deleted all 33 tests of the three MySQL files passed. On a server whose default is off, a read sent alone would open a transaction that stays open on a pooled connection | The rule that a new guard gets a registered mutation | The line was not seen as a guard, because the server's default already is 1, so no test on a default server could fail | A unit case on the session settings and `mysql-session-autocommit-on`, rung 3 and syntactic |
| 6 | A single `LOCK TABLE` on PostgreSQL failed with 25P01, where main accepted it | No caller sends one. A statement that is only legal inside a transaction block could not be sent as a batch of one | Nothing: no case enumerated statements that need a block | The equivalence argument weighed what a transaction gives a statement's effects, and not statements that need one to run at all | No write is sent alone, rung 1 |

## Detection ledger

The branch had passed every local gate before the review read it: the
unfiltered audit at 884 of 884, conformance on three dialects, the corpus, the
round-trip pins and the fuzz run. Every counted finding came from the review.

Our machinery did catch one break of this PR before the review. The final
gates' run of the whole conformance directory failed the bootstrap window test,
which had used a read batch of one statement as its way to a REPEATABLE READ
transaction. It is not counted: a defect the author's machinery finds before
review is the system working.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #64: the built-in review skill as one subagent, eight finders and a verifier over 17 candidates, and the reviewer's own server probes with main as the control | 6 | No |
| This project's machinery: unit cases, server cases, round-trip pins, conformance on three dialects, the corpus, the fuzz run, the unfiltered mutation audit | 0 | Yes |

Self-catch rate: 0% (previous round on main, PR3.9f part 2's: 0%. The
previous round on this work, the MySQL store's: 0%).

That is zero again, and the reason is the same as in the MySQL store's round:
what the review found was not a regression of anything the machinery measures.
The machinery measures whether the engine's statements behave identically on
every dialect. These six are about what the port does with statements the
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

## Mechanism audit — the false negative of each

Each row below was written and run against the fixed code, except where it
says otherwise.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| No write is sent alone | 1 | No false negative found for a write through these executors. Tried on a server, and each refused with nothing changed: a key ending in a tab sent as a single write, a single UPDATE whose RETURNING the executor refuses, and a DELETE sent as a read in text. Its boundary is the executor: a write sent through another client has no such guard |
| Only a read core branded goes alone (`isTreeBuiltRead`) | 1 against text. 3, by trust, against a store's own fragment | Ran against PostgreSQL. A read built through `prepareRead` and `readPrepared`, a SELECT from `meta` whose WHERE holds the store-owned fragment `nextval('probe_seq') > 0`, was branded, sent alone and accepted, and the sequence read `is_called = true` after it. The same text sent as a read was refused by the server and left `is_called = false`. Core reads a fragment for clocks and comments, and not for the functions it calls, so the brand shows where a statement came from and not what its fragments do. Six of the nine shared read statements hold a fragment, the next-wake read and the task result among them, so the brand cannot be kept to reads with no fragment without losing what this PR is for |
| The brand is frozen (`brandRead`) | 1 for the statement object | The `args` array of a read built by `readTree` is not frozen. Not run as a defect, because a bind is data and cannot make a SELECT write. A wrapper that copies a statement loses the brand and its copy keeps the transaction, which is the safe side. Ran: the measuring wrappers of this PR's own server tests do exactly that |
| The unit case on the session settings, and `mysql-session-autocommit-on` | 3, syntactic: it reads the text of `SET SESSION` | Not run. A pooled connection on which another user of the pool later runs `SET autocommit = 0` passes the case, because the settings are sent once for each physical connection and never again. A read sent alone on it would open a transaction that stays open. It is the boundary the MySQL store round's audit ran for a shared pool, and DESIGN.md already says a pool handed to `fromPool` must not be shared |
| DESIGN.md states what a read sent alone asks of a pool's default isolation level | None: a sentence | A pool created with `default_transaction_isolation = serializable` passes every gate. The reviewer ran the premise: over such a pool a one-statement read ran at serializable, read-write. Nothing refuses the pool |
| The three server cases of the fold, each owning a mutation | 3, one input each | Not run. Each case is one input: a tab, `SELECT 1; DELETE`, `RETURNING true`. A rule that sent a single write alone unless a bound string ends in a tab would still commit a key cut at a line break, and would pass all three. One input is enough for the conditions as they stand, because neither has a spelling in it: one is the batch's mode and the other is the brand. It stops being enough the day either is widened by a test of text |

## Fix-induced defects

None found in the product. The fixes were not reviewed as new code: this pull
request has no second review unless the coordinator asks for one. They were
re-tested. The reviewer's probes for findings 1, 2 and 4 became the three red
cases, each mechanism's false negative was run where the table says so, and
the ten mutants the fold changed or added were probed and each was caught by
its own verdict.

One fold commit did break a gate. Freezing what core brands added a condition
to `addTree`, and main's registry, which the base gate reads, holds no mutation
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

- Red tests: the commit "Red: a statement sent alone commits what its
  transaction would have refused", run and seen failing (3 cases) against the
  head the review read. "refuses a single write whose key ends in a tab and
  would be cut to fit, and writes nothing": expected { refused: true, stored:
  1 } to deeply equal { refused: true, stored: 0 }. "refuses a delete sent
  behind a select in one read, and keeps the row": the row gone, and "Cannot
  read properties of undefined (reading 'map')" for an answer. "rolls back a
  single write whose result it refuses": value 'after' where 'before' was
  expected.
- Fixes: the commits "Send alone only a read the executor knows to be a read",
  "Say in DESIGN.md and BUILD.md which statements go alone, and why no write
  does", and "Freeze what core brands as a read". Commits are named by subject
  because this branch is rebased before it merges. Checked before this file was
  committed: the suites of core, the SDK, the driver and the three stores at
  79 files and 1,055 tests, the registry at 884 by import of a copy, and the
  filtered probes of the ten mutants the fold changed or added, all caught by
  their own verdicts with no collateral failure. The full gates of the final
  head are in the pull request's body.
- Finder: the one full review of PR #64. Quoted verdict: "No HIGH findings on
  PR #64, but two MEDIUM ones: in both, main refused the write and wrote
  nothing, and this branch commits it. Both were reproduced on a server and sit
  at the executor port. Neither is reachable through the store's own statements
  today."
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
- Four test files are main's text again, so the bootstrap window test runs the
  executor's own read transaction against a server, which the first version
  had taken away.

Deferred (recorded in BUILD.md):

- Reading a read's fragments for the functions they call. It is an option and
  not a deferral of this PR: no read of the stores calls a function that
  writes, a fragment is store source and not text that arrives at run time, and
  its trigger is the first store read that calls a function outside core's
  list.
- A shared conformance case that a write sent as a read is refused on every
  dialect. Server cases hold it on the two servers, where the exit test asks.
- Checking a PostgreSQL pool's default isolation level once for each client.
  DESIGN.md states the requirement, and nothing refuses a pool that breaks it.

## What this round still would not catch

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
