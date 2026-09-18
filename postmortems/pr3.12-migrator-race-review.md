# Postmortem: the concurrent cold-start migrator, and a first fix that treated the symptom (PR #50)

A conformance case that races eight cold-start migrators failed PR #40's `verify` twice on PostgreSQL and passed on a rerun, and BUILD.md recorded the cause as not known. This PR found the cause and reproduced it. Its first fix made both admins confirm a rowless schema-version read by a second read. Review found that fix treated the symptom: the PostgreSQL executor ran a one-statement read under REPEATABLE READ, which takes its snapshot before the statement resolves the name. The fix was rebuilt at the executor, the confirming read was deleted with everything built on it, and the same review found a second product defect in the libSQL migrator. Twenty-two of the twenty-four findings came from review.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing here could lose or misattribute a task's durable state. The costs were a deploy that fails on a first concurrent start, and a contract rule that would have misled the next dialect.

- **A concurrent cold start on PostgreSQL could reject a migrator as facing a malformed database.** The process then fails its start. A retry succeeds, which is why a CI rerun cleared it.
- **The libSQL migrator ran its bootstrap bare.** A bootstrap that failed after a concurrent migrator finished rejected the loser, against DESIGN.md. It predates this PR.
- **The first fix would have shipped a rule that is false for MySQL.** DESIGN.md would have told every dialect that one confirming read is enough because the bootstrap commits the table and the row together. MySQL commits each DDL statement on its own. A MySQL admin written to that rule passes the shared case and still rejects migrators.
- **The first fix could relabel a malformed database as fresh.** Its second read trusted a typed absence after the first read had seen the table.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The PostgreSQL executor read the schema version under REPEATABLE READ. That isolation takes its snapshot before the statement resolves the name, and PostgreSQL resolves a name against the newest catalog, so a read racing a bootstrap's commit saw `meta` with no version row and the admin rejected the migrator | A process fails a concurrent first start. Seen twice in CI | The eight-migrator schema/admin conformance case | It meets the race in under one run in a hundred, and until PR #40 it reported a bare status with no reason | The version read begins READ COMMITTED, where the snapshot follows the lookup, so the state cannot be shown. The executor's unit test and a registered mutation hold the isolation level (rung 1 for the state, rung 2 for the line) |
| 2 | The first fix confirmed a rowless read by a second read in both admins, which left the state showable and handled it one layer up | Every caller of the version read pays a second round trip on a corrupt database, and the mechanism had to be exported as a contract | The author's diagnosis | It stopped at the admin that threw and did not ask why the read could see that state | Deleted. Finding 1's fix replaces it |
| 3 | DESIGN.md stated "one rowless read is confirmed by a second" for every dialect, with the reason that the bootstrap commits the table and the row together. BUILD.md in the same diff said MySQL does not | A MySQL or other port built to the rule still rejects migrators | `.github/review-bot-rules/dialect-portability.md` | It is prose for reviewers, and the author did not read it | DESIGN.md states the property, that a version read never reports a bootstrap's table without its row, and says for each of the three dialects whether it has it and by what means (no mechanism beyond the text) |
| 4 | The shared conformance case pinned the mechanism: exactly two reads against a stub that fabricates one rowless answer | It forces the double read on every port, forbids deleting it after a root-cause fix, and passes a MySQL admin that still flakes | The case's own design | It tested what the fix did and not the property the fix served | Deleted with the confirming read |
| 5 | The libSQL admin got the confirming branch although its own comment said SQLite cannot show the state, with a registered mutation and a bridge arm | Dead code with its own upkeep, and a corrupt database read twice for nothing | AGENTS.md: dialect behavior lives in the dialect's store | The author made the rule dialect-neutral to keep one conformance suite | Deleted |
| 6 | The confirming read trusted a typed absence. A first read that saw a rowless table and a second that saw none returned "fresh", and `migrate()` would bootstrap over the existing empty table | A malformed database relabelled as version zero, which DESIGN.md forbids | The fail-closed conformance cases | They feed a persistently rowless answer. None feeds rowless and then absent | Deleted with the confirming read |
| 7 | Nothing bounded the retry to one. With `!confirming` deleted, a persistently rowless table would recurse forever through awaited calls. One conjunct of the guard was implied by another, an equivalent mutant | `migrate()` hangs on a malformed database where it used to fail closed | The mutation registry | The two mutations proved only that the first retry happens | Deleted with the confirming read |
| 8 | The guard was a third copy of logic already duplicated across both admins, with twin mutation specs and two mutation runs for one case | A third dialect adds a third copy, and one copy can drift | The simplify pass | The author declined the hoist because five registered mutations own that text | Moot: the copies are gone. The duplicated version-read decoding remains, recorded below |
| 9 | Every PostgreSQL read batch takes its snapshot before it resolves names, and nothing recorded what a migration may therefore not do. A migration that rewrites a table, or creates one with rows a reader requires, would show it empty to a read batch | A future migration could make a task read as absent and re-run | Nothing | Every migration so far creates empty tables or adds nullable columns, so the hazard never showed | A comment at the `MIGRATIONS` list a migration author edits (no mechanism) |
| 10 | The libSQL admin ran its bootstrap with no recovery. DESIGN.md has a loser re-read the version after an error from bootstrap or a versioned batch. PR #16's round fixed this for PostgreSQL and recorded the asymmetry | A libSQL cold-start loser is rejected after the winner finished | The eight-migrator case | The in-process libSQL fixture never makes a bootstrap lose | The bootstrap is forgiven once the metadata exists. A shared conformance case and three registered mutations, one for each direction on libSQL and one on PostgreSQL (rung 3) |
| 11 | The PostgreSQL test's poll bound was at least ten seconds and the test had vitest's fifteen, so a broken order would report a bare timeout and lose its own message | A future failure that names nothing, the fault PR #40 fixed in the eight-migrator case | The author's arithmetic | The bound was chosen for the server and never added to the rest of the test | About three seconds of polling, and an explicit thirty second timeout |
| 12 | `Promise.all` rejected on the first failure and left the other batch polling while the fixture closed | The real error is replaced by a close or timeout error | The same | It was written for the passing path | `Promise.allSettled`, and the assertion reports both sides |
| 13 | The `pg_locks` filter had no database predicate, and the key came from the process id alone | Two test processes on one server could release each other early | The same | One process ran it | The filter names the current database, and each case has its own key |
| 14 | The bootstrap's server-side bound assumes the client reaches its fourth statement in time | A starved client fails the test on a path with no race | Nothing | It needs a stall of seconds | Not fixed. Recorded below |
| 15 | The test replayed the migrator's statement under its own label inside a four-statement batch, so it never ran the executor's real version-read path, its READ COMMITTED side would have proved nothing, and one variable was both a latch and a result with an unreachable branch | A later change to how the executor runs that read leaves the test green | The test's design | The author believed the race could not be ordered inside one statement. The reviewer ordered it, by holding the statement's name lookup on a second, locked table | The server test is now one statement, first in its transaction, under each isolation level, ordered the reviewer's way. It claims only the server's behavior, and the executor's unit test holds the path |
| 16 | BUILD.md said two advisory locks. The test used one key | A reader looks for a second key | The author's reading | Nothing checks prose | Corrected |
| 17 | The BUILD.md rewrite dropped facts still true: the designed losers' log signatures, that they are forgiven, and that the test reports its reason. It also cited rounds that no artifact in the repository backs | An operator cannot learn from the repository that those errors are expected | The author's rewrite | It replaced the entry where it should have amended it | The facts are back. The rounds stay unbacked, recorded below |
| 18 | The entry closed with "FIXED", which the deferral lint does not read as closed, and put what store-mysql owes under it | The author of PR4.3 reads only PR4.3 and never learns it | `scripts/deferral-lint.py` | It matches "DONE" and a deferral keyword, and the text had neither | "DONE", and the obligation is a sub-bullet of PR4.3 |
| 19 | No postmortem, for a merged product defect that recurred from PR #16's finding 7 | The recurrence analysis is never written | `scripts/review-attest.sh` | It acts on the declared finding count, and the author counted a CI failure as found by our machinery | This document |
| 20 | No class-level layer was extended and no false negative was exhibited | The class is held by instances | AGENTS.md's rule on tests at the class altitude | The author stopped at two deterministic cases | False negatives are run below. No class-level layer is added, recorded below |
| 21 | A libSQL doc comment was left false, and the catalog-and-snapshot explanation was restated in five places | Comments that describe one dialect's behavior as the rule | `.github/review-bot-rules/docs-track-behaviour.md` | Prose for reviewers | The comment is true again, since libSQL is unchanged there. The explanation lives at the executor, and the other places point to it or state only their own part |
| 22 | The tests hand-rolled a third intercepting executor and a promise-to-outcome shape, and used `try` and `finally` where `withFixture` exists | Three copies that each decide how to forward the batch control | The simplify pass | `withFixture` takes no fixture options | Two of the three copies are deleted with the first fix. One small wrapper remains in the forgiveness case |
| 23 | The server test is covered by no mutation, so deleting it leaves every gate green | The only test of the real server behavior can vanish | The mutation registry | The test passes with the fix and without it by design, so no mutation of product code can be attributed to it | Accepted, and said in the test's comment and below |
| 24 | The forgiveness case had the winner finish every migration, so an admin that forgives only past version zero passed it, and the registered PostgreSQL mutation of exactly that shape survived | A loser whose winner had only bootstrapped is still rejected, with the case green | The case | One winner shape | The case also fails a bootstrap after its own commit landed, where the version is zero. Found twice the same hour, by the mutation probe and by this document's mechanism audit |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The eight-migrator schema/admin conformance case, failing in CI on PR #40 | 1 | yes |
| The mutation probe, where a registered mutation survived, and this document's mechanism audit | 1 | yes |
| The Fable review of the first fix: the built-in `/code-review` with finder lenses and `/simplify`, report only | 22 | no |

Self-catch rate: 8% (previous round, PR #47: 10%). The one defect our machinery found, it found at under one run in a hundred and without a reason for two CI failures. The reason it now reports is what led to the cause. Everything wrong with the first fix was found by review.

## Recurrence

Finding 10 is PR #16's finding 7 on the other dialect. That round made `applyVersionedWrite` "the single current bootstrap-and-migration recovery boundary", in the PostgreSQL admin, and its postmortem names "the bootstrap asymmetry". The mechanism was a function in one store. The property is a rule in DESIGN.md for every store, and nothing asked the libSQL admin the same question. The shared case added here asks every dialect.

Finding 1 is the class that round's eight-migrator case was instituted against, concurrent cold start. The case is rung 3 by volume, and its own false negative in that postmortem was about pool size. It was never asked how often it meets a given race. Run here with the bug in place, it passed five runs of five.

Findings 3, 16, 17, and 21 are text stronger than what was run or read. This class has recurred in every review round this week: PR #42's plan entry, PR #45's declined review point, PR #46's five sentences, PR #47's model prose, and PR #48's list read as complete. Its only mechanism is a reviewer reading, which is the last net and not a mechanism. Two sentences here now stand on a test: the isolation level, and the forgiven bootstrap.

Finding 4 is a proxy in the place of a property, the class AGENTS.md catalogues: the case asserted that two reads happen, where the property is that a migrator is not rejected.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The executor's unit test and its mutation, which assert the text the version read begins with | 2, syntactic | A second version read the executor does not recognise. Run: the admin's read made two statements in one read batch. The unit test passes. Eight PostgreSQL schema/admin cases fail, because the executor's recognition of the canonical read is also what types an absent table as fresh. So this shape is caught elsewhere, by coupling and not by design |
| The server test of one statement under each isolation level | 3 | The bug itself. Run: with the executor's version read put back under REPEATABLE READ, both cases pass, as they must, since the test shows the server and not the executor. The eight-migrator case then also passed five runs of five |
| The forgiveness conformance case, as first written | 3 | Run: a libSQL admin that forgives only when the recorded version is past zero passes it, and the PostgreSQL mutation of the same shape survived the probe. This is finding 24. With the third shape both fail it |
| The forgiveness conformance case, as it stands | 3 | A future schema-admin write that calls the executor directly, outside the forgiving path. PR #16's postmortem records the same shape for PostgreSQL. Not run: no such write exists to bend |
| DESIGN.md's property stated for three dialects | none, prose | A fourth dialect. Nothing reads DESIGN.md |

## Fix-induced defects

Nineteen of twenty-four. Findings 2 to 8, 11 to 18, and 21 to 23 are defects of the first fix or of its tests and text, and finding 24 is a defect of the fix for finding 10. The first fix was reviewed as new code, which is how they were found. The rebuilt fix was re-tested, with each red seen failing and each false negative above run, and was not reviewed again.

## Evidence

- The server's behavior, PostgreSQL 17.11, four connections in a fresh schema. A read before the bootstrap commits: error 42P01. A REPEATABLE READ snapshot taken before the commit and a name lookup after it: zero rows. A read that starts after the commit: one row. The first reader again in a new transaction: one row.
- The real migrator, raced. A scratch test, not committed because it needs timers and random jitter, runs `admin.migrate()` concurrently on a fresh schema for each round and counts rejections by reason. Every rejection in every run was `SchemaMismatchError: schema-version read must return exactly one result with one row, got 1 results and 0 rows`. Before any fix: 2 of 300 rounds with eight migrators in the conformance case's exact shape, 2 of 300 on two cores, 0 of 300 with starts jittered by up to 4 ms, and 22 of 300 and later 18 of 300 with ten migrators jittered by up to 8 ms on two cores. With the version read under READ COMMITTED and no other change: 0 of 1800. On this branch: 0 of 600 in the exact shape and 0 of 600 with ten jittered migrators.
- A timer-free stagger, where migrator k first makes k version reads, met the race once in 1500 rounds. So volume in the shared suite cannot hold this class.
- Red, then green, by commit subject. "Show the schema-version read beginning under a snapshot taken before its lookup": the executor's unit test fails, because the read begins REPEATABLE READ. "Read the schema version under READ COMMITTED, where the snapshot follows the lookup": it passes, with 35 store-postgres tests and the schema/admin conformance cases. "Show the libSQL migrator rejecting a bootstrap that lost to a concurrent winner": the shared case fails for libSQL and passes for PostgreSQL. "Forgive a lost libSQL bootstrap once the metadata exists": both pass, and the eight registered mutations of the libSQL admin still find their text once each.
- Finder: a Fable subagent invoking the built-in `/code-review`, with finder lenses for altitude, reuse, simplification and efficiency, a line scan, removed behavior, conventions, and cross-file tracing, and `/simplify` in report-only mode, over the first fix's four commits. Its altitude lens: "the retry treats a symptom, and the cause is the executor's isolation level for a one-statement read", with the PostgreSQL claim marked as from memory and unverified. It was verified here by the race above before anything was rebuilt.
- Claims that did not hold. That a PostgreSQL-only test in the conformance package breaks the rule against dialect test forks: the rule's own bullet excludes files that carry DDL, and the fixture for a live PostgreSQL server exists only in that package. That the bridge arm is a defect because it dies when another registry change merges first: that is how every arm works, and the later branch re-keys.
- A claim of ours that did not hold: that nothing outside the server can order the snapshot and the name lookup of one statement. The reviewer's control did, by naming a second table first and holding it locked, and measured zero rows under REPEATABLE READ and one under READ COMMITTED, with the simple and the extended protocol. The server test here is built that way. With the meta table named first, as a negative control, the statement is not held, and the test fails in about three seconds with its own message.
- What still cannot be done: drive the executor's real version read through the race. Its canonical statement names one table, so there is nothing to hold it on.

## Root cause

The defect sat in a default. Every PostgreSQL read batch is REPEATABLE READ, which is right for a batch of several statements that must agree, and nobody asked what it costs a batch of one. The one table whose emptiness is an error made it visible. The layer meant to catch concurrent cold start was a volume test that was never measured against a known race, so nobody knew it detects this one in under one run in a hundred.

The first fix repeated the shape of the original investigation of PR #45: it fixed where the measurement pointed, the admin that threw, and did not ask why the state was reachable. The review's first question was the one the author had not asked.

## Mechanisms

Built in this PR:

- The schema-version read begins READ COMMITTED, in `packages/store-postgres/src/executor.ts`, with a unit test and a registered mutation (rung 1 for the state on PostgreSQL, rung 2 for the line).
- A shared schema/admin conformance case for a lost bootstrap, in three shapes, with three registered mutations (rung 3).
- A server test of one statement racing a bootstrap's commit under each isolation level, as the record of the premise (rung 3, and it guards no product line).
- DESIGN.md's property for each of the three dialects, and a sub-bullet under PR4.3 for what MySQL owes.

Deferred (recorded in BUILD.md):

- PR4.3 `store-mysql` must serialize bootstrap against version reads and pass the eight-migrator and lost-bootstrap cases at volume. Deferral is acceptable because that store does not exist yet.

## What this round still would not catch

- A race in cold-start convergence that the eight-migrator case meets as rarely as it met this one. The case is unchanged, and it passed five runs of five with the bug in place.
- A migration that rewrites a table a read batch reads. A comment is all that stands there.
- A schema-admin write added outside the forgiving path.
- The server test deleted, or a PostgreSQL version that changes where READ COMMITTED takes its snapshot. The test would show the second. Nothing shows the first.
- A starved client failing the server test on a path with no race.
- The rounds cited here rebuilt by a reader: the racer is described and not committed.
- A sentence in DESIGN.md, BUILD.md, or a comment that says more than was run.
