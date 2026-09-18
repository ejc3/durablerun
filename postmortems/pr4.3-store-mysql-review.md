# Postmortem: store-mysql review (PR #51)

PR #51 adds `packages/store-mysql`, the third dialect, which passed the
identical conformance suite on MySQL 8.4 before it was pushed, with CI green.
One review pass then found ten defects. Three are correctness bugs the
reviewer reproduced on a real MySQL 8.4 server: concurrent driver heartbeats
deadlock, a name with trailing spaces past 255 characters is silently stored
as a different name, and a DELETE of exactly two rows reports one. Two are
hot reads whose cost grows with a queue's history. Two are in the executor's
use of mysql2. The rest are a label rule standing in for a lock coordinate,
stale spec text, and a second parser of one environment variable. Our own
machinery found none of the ten. Nine are fixed here, seven of them as a red
test and a fix, and one is deferred to a named PR.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding loses durable identity. MySQL cuts trailing spaces past a
VARCHAR's width with a note, in every `sql_mode`, where it refuses any other
excess with error 1406. An event emitted under a name of 255 characters and a
space was stored under the 255 character name, so a later await on that other
name would have seen its payload. An idempotency key of that shape answered
for the task of the key it was cut to, so a distinct task was never created.
The other two dialects keep all of these apart.

The second makes a healthy fleet read as dead. Each driver beat buried
expired rows with a DELETE that had no index to find them by, so it locked
every row it scanned and waited on rows other drivers had just written. On
MySQL 8.4, 171 of 200 concurrent beats deadlocked, where PostgreSQL had 200
successes. The driver loop swallows a failed beat, so with two or more
drivers most beats are lost and registry rows expire.

The third is latent. A DELETE of exactly two rows reported one row written,
so FencedBatch's one-row audit would pass a follow-on DELETE that removed two
rows on MySQL and refuse it on the other two dialects. No store decision
reads a DELETE count today.

The fourth would misattribute a lost compare-and-set as won, for any
application that handed the store its own mysql2 pool, because mysql2 turns
`FOUND_ROWS` on by default and the precondition lived in a comment.

The rest cost time and not state. The cancel scan and the next-wake read
walked a queue's dead history on every sweep and every driver tick. Every
batch paid one more round trip to set the session again.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The driver registry's cleanup DELETE locks every row it scans and waits on rows other beats hold | 171 of 200 concurrent beats deadlock; a fleet of two or more reads as dead | The shared conformance suite, driver registry | Every registry case ran one beat at a time, so no lock was ever contended | A shared case of 8 drivers for 10 rounds on every dialect (rung 3). The fix waits on no lock, which makes the cycle unwritable for this statement only |
| 2 | MySQL cuts trailing spaces past VARCHAR(255) with note 1265 and stores a different identifier | An event or idempotency key answers for another name; the dialects diverge silently | The store's length test, and the portability survey behind it | The test used one kind of excess, 256 non-space characters, which MySQL does refuse | The store refuses any identifier past the width at every entry, with the entry list held to the store's own methods (rung 3, coverage derived at rung 2). The executor refuses any write that raised note 1265 (rung 3, at the one chokepoint). A mutation for each |
| 3 | The single-row upsert rule also fires for a DELETE of exactly two rows | A follow-on DELETE that removed two rows passes the one-row audit on MySQL alone | The executor contract test | It checked counts of 1, 3, and 4 and skipped 2, the one value where the two rules meet. A registered mutation pinned the rule that caused it | The rule reads the statement and applies to an INSERT alone; tests at 2; a mutation on the new condition (rung 3) |
| 4 | `tasks_cancel (queue, cancel_at_ms)` dropped the live-state filter of PostgreSQL's partial index | Every sweep walks every failed task with a past deadline: 403 rows walked to return none | A query plan test | The store had none. The only plan tests are libSQL's, over libSQL's planner | A MySQL plan test that reads the session's handler counters around the exact production SQL (rung 3) |
| 5 | `NEXT_WAKE_SQL`'s `MIN()` legs are not answered from an index on MySQL | Every driver tick walks the queue: 1207 rows walked of a 1200 row queue | A query plan test | As 4. The constants were exported for a plan suite that no MySQL test imported | As 4, over the next-wake read (rung 3) |
| 6 | The session settings were remembered against the pool's wrapper object, which mysql2 makes anew on every checkout | One more round trip on every batch | The executor unit test | Its stand-in pool returned one object, and its helper filtered SET SESSION out of what it compared | A stand-in that wraps anew, a mutation, and a case over the real pool where the server counts the SET statements (rung 3) |
| 7 | `fromPool` accepted any pool, and mysql2 connects with `FOUND_ROWS` by default | A compare-and-set that lost reads as won, for an application that passes its own pool | Validation of an object crossing a port | The precondition was a doc comment | `fromPool` reads the handshake flags and refuses the flag, or flags it cannot read (rung 3), with a mutation. A branded pool type would be rung 1 and was not built |
| 8 | The migration lock is chosen by matching the batch label | A future `migrate:v6:ddl` or `migrate:repair` batch would run DDL with no lock and no test going red | Core's rule that a lock travels in the batch control | The rule covers the event and claim locks, and nothing checks that a third lock uses it | None built. Deferred to PR4.4 in BUILD.md, with the half-applied-version case |
| 9 | DESIGN.md and AGENTS.md still said MySQL takes row locks for events, and the 30 second lock wait and its error were in no spec | A port in another language has no line to match | The rule that a behaviour change updates DESIGN.md in the same diff | It is an instruction to a reviewer, with no checker | The text is corrected and the lock wait has a test. No mechanism: the class is open |
| 10 | The root vitest configuration parsed `DURABLERUN_CONFORMANCE_DIALECTS` a second time, leniently | A misspelled name drops a server's test files and the run stays green | The single-definition rule | The validated parser lived in a file that imports `pg` and `mysql2`, which a configuration file should not load, so a second one was written | One parser in a file that imports nothing, used by both readers (rung 1 for this value), with a test of the lists it refuses |

## Detection ledger

Every finding came from the outside review of PR #51. The branch had passed
the whole gate locally three times and CI was green on the reviewed head, so
each of the ten is a defect our machinery was shown and accepted.

| Detector | Findings | Ours? |
|----------|----------|-------|
| Outside review of PR #51, seven finder angles and the reviewer's own runs on MySQL 8.4 | 10 | No |
| This project's machinery: conformance, fault and poison matrices, lints, mutation probe | 0 | Yes |

Self-catch rate: 0% (previous round: 25%).

That is the lowest rate of any recent round, and the reason is structural
and not a bad week. The previous rounds reviewed changes to code the
machinery was built around. This one reviewed a new dialect, and the
machinery's claim about a dialect is one sentence: it passes the identical
suite. The suite was written against two other servers, so it asks of MySQL
only what SQLite and PostgreSQL could also get wrong.

## Recurrence

**A transition with no concurrent case.** This recurred one round after a
mechanism. PR #50 found the cold-start migrator race and added an
eight-migrator shared case. That mechanism checks one transition. The
property is that every store call is safe against itself and its neighbours
under each server's locking, and the heartbeat is the next call the same
class reached. The case added here is again one transition. The class-level
mechanism is a generated surface, every store call run concurrently with
itself on every dialect, and it is deferred, so this class is expected again.

**A boundary sampled at one value.** Findings 2 and 3 are the same class: the
length test used one kind of excess, and the count test skipped the one count
where two rules meet. Earlier rounds record the class many times, and no
mechanism exists for it beyond the mutation probe, which holds a condition
that is written and says nothing about a condition that is missing. It
recurred because nothing was ever instituted against it.

**A stand-in that differs from what it stands for.** Finding 6. Earlier
rounds met it in other layers. The mechanism has each time been a better
stand-in, which is what this round's unit test is too. The part that is new
here is a case over the real pool in which the server does the counting.

**A second representation.** Finding 10, under a law this repository already
states. The law is enforced by review, which is why it recurred. For this one
value the second parser is now unwritable without deleting an import.

**A precondition in a comment**, finding 7, and **spec text left behind**,
finding 9, are both rules that exist only as instructions to a reviewer.
Neither has ever had a mechanism, and finding 9 still has none.

Findings 4 and 5 are new as a class here: a dialect with no plan tests of its
own.

## Mechanism audit — the false negative of each

Each row below was written and run against the fixed code, except where it
says otherwise.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The single-row rule applies to an INSERT alone | 3, syntactic: it reads the first keyword of the text | `writtenRows({ affectedRows: 2, info: '' }, "REPLACE INTO meta VALUES ('k','v')")` returns 2 for one row written, and an upsert behind a leading comment, `/* x */ INSERT ... ON DUPLICATE KEY UPDATE`, returns 2. Both ran. The store writes neither shape |
| Session settings remembered against the physical connection | 3 | A pool whose wrapper exposes no `connection` property falls back to the wrapper: three batches over such a pool sent SET SESSION three times. Ran. mysql2 exposes the property, and the real-pool case would fail if it stopped |
| `fromPool` refuses `FOUND_ROWS` | 3 | `fromPool` over a pool with the flag off and `supportBigNumbers: false` is accepted, and that pool decodes a BIGINT past 2^53 as a rounded number. Ran. The check reads one flag of the several options `createOwnedMysqlPool` sets |
| The store refuses an identifier past the width at every entry | 3, with its method list derived from the store | A new identifier parameter on a method that already has an entry passes the coverage test with no call for it. Not run: it is a statement about a parameter that does not exist yet. The executor's check below is what would still refuse the write |
| The executor refuses a write that raised note 1265 | 3, at the chokepoint | No false negative found for a write through this executor. Two were tried and both are refused: a value cut by `CAST(? AS CHAR(3))` is error 1292 under the strict mode the session sets, and `INSERT IGNORE` of 300 characters raises the same note 1265. Its boundary is the executor: a fixture or an operator writing through another client is not checked |
| Measured plan tests for the cancel scan and the next-wake read | 3 | The claim's `FORCE INDEX (runs_poll)` removed from the store, with both plan tests still passing. Ran. The claim has no plan test, and any hot read without one is unheld |
| The shared concurrent-beats case | 3, probabilistic | The cleanup written as `WHERE (queue, driver_id) IN (the same skip-locked read)` still deadlocked 22 of 200 beats when measured. At that rate 80 beats almost never all pass, so this case would catch it. A cycle that forms once in a thousand beats passes the case 92 times in 100 |
| One parser of the dialect selection | 1 for this value | The files that need a server are a hand-kept map in the root configuration. A new server test file that is not added to it still runs, and fails, in a job that has no such server. That is loud and not silent. Not run |

## Fix-induced defects

None of the ten findings was caused by a fix for another. Three defects were
introduced while fixing and were caught by the fix's own green run before any
commit: the first next-wake rewrite read a property the bounds object does not
have and MySQL answered error 1054; the first deadlock fix was refused with
error 1093 until the derived table was kept materialized; and the lock-wait
test expected a returned connection where the executor discards it. A fourth
candidate, the `IN` form of the cleanup, was legal SQL and was rejected only
because it was measured: 22 of 200 beats still deadlocked. The fixes were
tested and measured, and were not re-reviewed as new code. One narrow
re-review of the behaviour changes is the plan.

## Evidence

- Red tests, each run and seen failing by name before its commit, and each
  fix seen passing on the same run:
  - `63363f6` red, `f7e9f42` fix. "reports a DELETE of two rows as two rows": expected [ 1 ] to deeply equal [ 2 ].
  - `79943ad` red, `9151710` fix. "sends the session settings once for each physical connection": length 2 where 1 is expected.
  - `9abe836` red, `5f69857` fix. "refuses a pool that connects with FOUND_ROWS, or whose flags it cannot read": expected [Function] to throw an error.
  - `223258c` red, `8d13319` fix. "the cancel scan does not walk the dead tasks whose deadline has passed": expected 403 to be less than 20.
  - `df55695` red, `fc99de3` fix. "seeks the earliest instant of each wake source, whatever the queue holds": expected 1207 to be less than 20.
  - `6bba5b8` red, `898f21c` fix. "scheduler conformance [mysql] > driver registry > concurrent beats from distinct drivers all land": MySQL error 1213. The same case passed on libSQL and PostgreSQL in the red run.
  - `01d311f` red, `e0883ce` fix. Three tests: the raw write was 'accepted', emitEvent threw a RangeError where an invalid durable string is expected, and none of the store's 45 entries refused.
- The reviewer's own harness, rerun before and after: 29 successes and 171
  deadlocks of 200 before, 200 successes and 0 deadlocks after. DELETEs of 1,
  2, and 3 rows reported 1, 1, 3 before.
- Against the real mysql2 pool: a new wrapper on every checkout over one
  physical connection, the owned pool accepted, a default pool refused, and
  SET SESSION sent once over three batches.
- Finder: the code review of PR #51, quoted verdict: "I found 10 issues in
  `69be7f9..a1d5795`. Three are correctness bugs I reproduced on a real MySQL
  8.4 server, and two more are index and query-cost problems one of the
  finder agents measured on that server."
- Claims that did not reproduce, all four settled by the reviewer before the
  report: the claim's self-read wrapper does not materialize the whole table
  (the measured plan shows no materialize step); a dead connection is not
  returned to the pool (mysql2 detaches a fatally errored connection before
  release runs); `LIMIT ?` is not refused for a JavaScript number (the claim
  ran on 8.4); and the claim and emit follow-on scans are a design shared with
  the other two dialects. Two more were mine, in the audit above: neither a
  CAST nor INSERT IGNORE gets a cut value past the executor.

## Root cause

A dialect was called done when it passed the identical suite, and the suite
cannot ask a dialect-specific question. It was written against SQLite and
PostgreSQL, so its boundaries are the ones those two servers have, its cases
run one actor on each registry and read path, and it measures no plan. Every
finding here lives in what is specific to MySQL or to mysql2: a locking scan
under READ COMMITTED, the one excess MySQL cuts where it refuses the rest, a
result header that a DELETE and an upsert share, an optimizer that does not
answer `MIN()` from an index, a pool that wraps a connection anew, and a
handshake flag that defaults on. The portability survey measured what the
shared trees needed from MySQL. Nothing measured what MySQL and its driver do
that the other two do not, and the store's own tests ran over stand-ins shaped
by what was believed of mysql2.

## Mechanisms

Built in this PR:

- A shared conformance case of concurrent driver beats, on every dialect
  (rung 3). Lives in the conformance suite's driver registry.
- The identifier bound at every store entry, with the entry list held to the
  store's prototype (rung 3, coverage at rung 2), and the executor's refusal
  of a write that raised note 1265 (rung 3). Lives in `store-mysql`.
- The INSERT-only counting rule, the physical-connection key, and the refused
  foreign pool, each with a registered mutation (rung 3).
- `store-mysql/test/query-plans.test.ts`: measured plan tests over the exact
  production SQL, from the session's handler counters (rung 3).
- One import-free parser of the dialect selection (rung 1 for that value).
- A case over the real mysql2 pool in which the server counts the session's
  SET statements (rung 3).

Deferred (recorded in BUILD.md):

- The migration lock as a lock coordinate in the batch control, with the
  half-applied-version case, under PR4.4. Deferral is acceptable because no
  batch with another label exists today, and the change reaches core's batch
  control and every executor while two other PRs are editing them.
- A plan test for the claim's index-ordered legs, under PR4.4. The shared
  concurrency case already fails when a leg over-locks.
- A generated surface that runs every store call concurrently with itself on
  every dialect, under PR4.4. It is the class-level answer to finding 1, and
  it is not small.

## What this round still would not catch

- A deadlock or lost update between two calls other than two driver beats. One
  transition has a concurrent case, and the class has recurred once already.
- A cycle rare enough to pass 80 beats, by the arithmetic in the audit.
- A hot read other than the cancel scan and the next-wake read whose plan
  degrades with history. The claim is the first of them.
- A boundary sampled at the wrong value. Nothing enumerates the values at
  which two rules of one function meet, and the mutation probe cannot see a
  condition that was never written.
- A foreign pool that decodes numbers or dates differently from the owned one.
- A write with a statement shape the counting rule does not know, a REPLACE
  or an INSERT behind a comment, if the store ever writes one.
- A behaviour change that leaves DESIGN.md behind. It is still a rule for a
  reviewer.
- A new batch label that needs the migration lock and does not match the
  label rule, until PR4.4.
