# Postmortem: PR2.5a permanent store errors review

PR2.5a makes the three store executors type a permanent SQL error apart from an outage, from the driver's error code. Its one review, the built-in code review at high effort with the coordinator's probes beside it, found nothing HIGH, three MEDIUM and three LOW, and four of the six are counted here. No durable state was at risk, because a worker pass treats both types alike. One finding is a behaviour the branch itself introduced: the new rule by SQLSTATE class typed three MySQL limits permanent, though a retry cures each. Three of the four have one cause, which is older than this pull request and which this round closes at its source.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst would have shipped. MySQL files three limits under SQLSTATE class 42, beside a syntax error: error 1203, the server's max_user_connections, error 1226, an account past one of its own limits, and error 1461, the count of prepared statements reached. Another session's release lifts each of them. The branch's rule by class typed all three permanent, where main types them outages. A hosted route would have answered 500 for a connection limit, where a 503 invites the retry that works, and DESIGN.md's sentence that no retry changes a permanent answer was false of them. Worse, the follow-up this pull request records, a run that ends at once on a permanent store error, would have ended runs over a connection limit.

Second, two more refused writes stayed outages on MySQL where libSQL and PostgreSQL answer permanent: a row that leaves out a NOT NULL column (error 1364, filed under HY000) and text that is no number for a numeric column (error 1265, filed under 01000). That is main's behaviour and the safe side, but the same request answered 500 on two dialects and 503 on the third, under a conformance surface that said it held the kind.

Third, the SDK's replay harness was said, in four places, to hold the two kinds of store fault alike at every store call. It landed the permanent kind on two store methods of twelve. The product is right today, because both kinds pass one classifier, but a change that treated the two kinds differently at any of the other ten methods would have passed the gate that was said to hold it.

Fourth, two sentences said more than was true: an exit test said two batches deadlock, which its case cannot require, and the pull request's body said a probe showed no collateral failure, where a probe runs only the registered case and a second case of the same file failed under one mutant.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | MySQL errors 1203, 1226 and 1461, limits that a retry cures, were typed permanent because MySQL files them under class 42 (the review's point 1). Introduced by this branch | A hosted route answers 500 where 503 invites the retry that works, and the recorded follow-up would end runs over a connection limit | The MySQL executor's typing cases | They run on a fake connection that is fed the numbers their author listed, and the author listed no limit. A case that can only agree with its author's list cannot find what the list lacks | The three numbers are read before the class, held by a case on the fake and by a real-server case that holds an account to one connection (rung 3). The class: one real-server case reads the server's own list of error numbers and holds the executor's lists to it (rung 3) |
| 2 | The replay harness drew a permanent store error only on an even last call, so ten of twelve store methods never met one, while DESIGN.md, BUILD.md, the harness's comment and the body said every call (point 2) | A change that treats the two kinds differently at ten store methods passes the gate said to hold it | The harness itself | It had no floor for the kinds of fault: nothing counted which kind landed on which method, so a draw that almost never lands looked like a draw | A floor as the file's last case: every store method the sweeps fail has met both kinds. Every sampled call is failed once with each kind, and each run is held to the kind it asked for (rung 3) |
| 3 | MySQL errors 1364, a NOT NULL column left out, and 1265, text that is no number, stayed outages where the other dialects answer permanent (point 3) | The same refused write answers 500 on two dialects and 503 on the third, and is retried on one | The shared executor error surface | It broke each kind of constraint one way, and NOT NULL has two. The executor's own cases ran on the fake | The surface breaks NOT NULL both ways (rung 3), and the second rule of the case that reads the server's list (rung 3) |
| 4 | Two false statements: exit test 24 said "two batches that deadlock", and the body said "no collateral failure" of a probe that runs only the registered case (point 6) | A reader is told more than is held | Nothing reads a sentence against the code it describes | No such layer exists | The sentences are corrected. The second is also made true at the file level: the PostgreSQL deadlock case names a serialization failure, which no map of the classes moves (rung 3 for that case, none for the sentences) |

## Detection ledger

Every one of the four was found by the review. The author's own machinery found one defect of the same class before the review, which is not counted here and is what the recurrence section is about: the simplify pass asked why the shared surface broke one kind of constraint, and the surface then failed on MySQL's error 3819.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The pull request's one review: the built-in code review at high effort, which found points 1 and 5, with the coordinator's probes, which measured point 2, reproduced point 3 side by side, and added error 1203 and the control on main's executor to point 1 | 1, 2, 3, 4 | No |
| The author's red tests, conformance surface, mutation audit and simplify pass | none of the four | Yes |

Self-catch rate: 0 of 4, or 0% (previous rounds on main, PR4.4d's and PR3.3d's: 0%). Within the class of finding 1 and 3, counting the 3819 instance the author's simplify pass found before the review, the project's own machinery found one instance of four.

## Recurrence

A MySQL number that its class files apart from what a retry does: this class recurred, and it recurred INSIDE this pull request. Pull request 74's review found error 1176 booked as an outage, and its postmortem named the device, a list of numbers kept by hand, as a proxy for the property. This pull request built the option that postmortem recorded, a rule by SQLSTATE class, and the class rule was then wrong in both directions: its own simplify pass found 3819 outside the classes, and the review found 1203, 1226 and 1461 inside them and 1364 and 1265 outside them. Four rounds of finding, by four different detectors, one number or a few at a time. What the earlier mechanism checked: that the numbers its author listed are typed as its author expects, on a fake connection that is fed those same numbers. What it was supposed to check: that every number the SERVER can send is typed as its meaning requires. The first is the author's list agreeing with itself. The second needs the server's list, and the server has one.

A gate or a claim that says more than it holds: this class has recurred in the rounds on main, under several names (a hold that cannot fail in pull request 63, a surface that held one kind where the schemas declare four earlier in this pull request). The repository's mechanism against it is the progress floor (AGENTS.md: a walk that accomplishes nothing must fail), and the replay harness had floors for its window and its programs and none for the kinds of fault it lands. A floor exists only where someone thought to ask what the gate could silently fail to do.

A false sentence in a document: this class has recurred in every round on main whose postmortem I can read, and no mechanism exists against it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The case that reads MySQL's own list of error numbers, `performance_schema.events_errors_summary_global_by_error`, and asks the executor's classifier about each of the 1,776 numbers a client can be sent | 3, and the selection by name is a SYNTACTIC check of a semantic property | Three, each run. A name that does not say what the number means: error 1104, `ER_TOO_BIG_SELECT`, is filed under 42000 and typed `PermanentStoreError`, though whether a retry cures it depends on the data and on MAX_JOIN_SIZE, and "TOO_BIG" matches no word of the limit pattern, so the case passes it unseen. A cure that is no retry: error 1227, access denied, is typed permanent by its class and an operator's grant cures it, and the case has no rule for that. A number nobody here understands: error 4074, `ER_VALUE_OUT_OF_RANGE`, is left an outage under a written reason that says so. A newer server that files a limit under a name outside the pattern passes the same way, and PostgreSQL has no such catalog, so nothing of this kind holds its map |
| Errors 1203, 1226 and 1461 read before their class, held by a case on the fake connection and a real-server case for 1226 | 3 | A fourth limit that MySQL files under a permanent class is typed permanent and both cases pass: they hold the three numbers they name. Only the case above can find it, and only if its name says a limit |
| The replay harness's floor, and each sweep run held to the kind it asked for | 3 | The floor counts the store methods the sweeps failed at all. A store method that is called only at even calls that are never the last is never failed by either kind, is absent from the count, and the floor passes. Measured at the head: no such method exists today, all twelve methods the harness calls are failed. The sample itself, odd calls and the last, is unchanged, so a defect that shows only when an even, earlier call fails passes as it did on main |
| The shared surface breaks NOT NULL both ways | 3 | A third way to break a kind that a dialect files apart passes unseen: the surface sends each kind the ways its author thought of. On MySQL the case that reads the server's list is the backstop. On PostgreSQL and libSQL nothing is |
| The PostgreSQL deadlock case names a serialization failure | 3 | The probe still filters by title, so a second case of a file that fails under some other mutant stays invisible to it. Checked by hand for this one mutant only: with class 23 removed from the PostgreSQL map, the executor's test file has one failure, the registered case |

## Fix-induced defects

One of the four, finding 1, was introduced by a fix of an earlier round's finding: pull request 74's postmortem recorded "classify the server's permanent answers by SQLSTATE class" as an option, this pull request built it, and the class rule typed three limits permanent that the list by hand had left outages. The rule was tested as new code, on the fake, against the numbers its author listed, which is why it passed. Within this round's fold no finding was introduced by a fix of another: the fold's first harness fix failed its own floor on a count that the direct cases outside the sweeps unbalance, which the floor showed at once, and the floor was changed to hold each sweep run to the kind it asked for before anything was committed.

## Evidence

- Red tests: commit `33f1dee`, probe `packages/store-mysql/test/error-typing.test.ts` `types an account past its connection limit an outage, and the same batch is answered once a connection is free`, run and seen failing (2 tests, this one on a real server and the case on the fake connection for all three numbers) against `9295e9c`: "expected PermanentStoreError: batch(fixture:one-more-connection) failed permanently (MySQL error 1226) to be an instance of StoreUnavailableError".
- Fixes: commit `b4d3bad` reads the three numbers before the class; gate after fix: both cases pass, and the full gate list below.
- Red tests: commit `0d9acda`, probe `packages/conformance/test/libsql.test.ts` `executor errors [mysql] types a broken not null (a column left out) constraint permanent and not an outage, and writes nothing`, run and seen failing (1 test, with 20 passing on three dialects) against `b4d3bad`: "expected StoreUnavailableError to be an instance of PermanentStoreError".
- Fixes: commit `12e1c20` types errors 1364 and 1265 permanent by number; gate after fix: 21 of 21 cases of the surface on three dialects.
- Red tests: commit `277e59a`, probe `packages/sdk/test/replay-equivalence.test.ts`, run and seen failing (1 test, the floor, with 27 passing) against `a8df4d6`: the floor named ten methods, activate, awaitEvent, awaitTaskDone, claimedTaskName, emitEvent, failRollback, getCheckpoints, setCheckpoint, spawn and suspendRun, each "met only StoreUnavailableError".
- Fixes: commit `6a96cf5` fails every sampled call once with each kind and holds each run to the kind it asked for; gate after fix: 28 of 28, in about 35 seconds where the file took 16. Control: with one sweep made to drop the kind, its first run fails with "the fault that landed, where the sweep asked for permanent: expected 'StoreUnavailableError' to be 'PermanentStoreError'".
- Fixes with no red test of their own, because each corrects a statement and not a behaviour: commit `a285cdf` corrects exit test 24 and the harness claims in DESIGN.md and BUILD.md, and commit `6bc1ca2` makes the PostgreSQL deadlock case independent of the class map (finding 4).
- The class mechanism: commit `a8df4d6` adds the case that reads the server's list. Run over the executor as it was at `9295e9c`, with only the export it needs added, it failed naming all five numbers: "1203 ER_TOO_MANY_USER_CONNECTIONS (42000)", "1226 ER_USER_LIMIT_REACHED (42000)" and "1461 ER_MAX_PREPARED_STMT_COUNT_REACHED (42000)" under its first rule, and "1265 WARN_DATA_TRUNCATED (01000)" and "1364 ER_NO_DEFAULT_FOR_FIELD (HY000)" under its second. Commit `ee4a992` adds one real-server case on each server for classes 22 and 42, commit `9c874b7` makes the worker harness count a case's own fail, commit `2192bf0` registers eight mutations, two of them owned by the case that reads the list, and commit `9737c08` exempts the three new verdict markers in the base gate's arm.
- Finder: the pull request's one review, a subagent running the built-in code review skill at high effort with the coordinator's probes beside it, quoted verdict: "Six findings, none HIGH: three MEDIUM and three LOW. No durable state is at risk at this head."
- The review confirmed on its own servers: both of the author's earlier reds by name, the who-pays cases with the task-control line removed, the hosted predicate, four mutations by hand, and the author's count of constructed errors repeated at the head (34 errors in 114 contests, every one under a migrate label). It raced spawn and emit under one key on three dialects, 600 of 600 answered.
- Claims that did NOT reproduce, or were not counted. The review's third point from the skill, that a syntax error is typed differently on libSQL, is the maintainer's recorded decision and not a finding. Point 4, classes 22 and 42 held on a fake only, is not counted, because the hold can fail and the servers answer as the fakes say: it was folded with one real-server case on each server, which passed on its first run with exactly the codes the review's probe lists. Point 5, the worker harness's override order, affects no case and is not counted: it was folded. The author's first floor for the harness, equal totals of the two kinds, did not hold at the fixed head, because five direct cases outside the sweeps land an outage each: measured, and replaced before it was committed.

## Root cause

Three of the four findings, and the 3819 instance before them, are one failure: a map from a driver's codes to a meaning was checked against a list of codes its author wrote, on a fake driver fed that list. Every layer that looked at the map, the executor's cases, the mutation audit over those cases, the shared conformance surface with its few refused writes, could only confirm what the author already believed about MySQL. None of them asked MySQL. A class rule made it worse in one direction, because a class is a claim about numbers nobody had read: 229 numbers a client can be sent are filed under the three classes, and the rule typed all of them by reading three names.

The fourth finding, and the harness half of the second, share the other cause: a statement about what a gate holds was written from what the gate was meant to do, and nothing counted what it did.

## Mechanisms

Built in this PR:

- One real-server case reads MySQL's own list of error numbers and holds the executor's two lists to it, under two rules, with tables of written reasons that fail when they explain nothing, and two registered mutations that show in every audit that the case can fail. Rung 3, in `packages/store-mysql/test/error-typing.test.ts`. Its selection by name is a syntactic check, recorded above as such.
- MySQL errors 1203, 1226 and 1461 are read before their class, and errors 1364 and 1265 are typed permanent by number, each held by a registered mutation. Rung 3, in `packages/store-mysql/src/executor.ts`.
- The shared executor error surface breaks NOT NULL both ways. Rung 3, in `packages/conformance/src/executor-errors.ts`.
- One real-server case on each server pins the type and the driver's code for classes 22 and 42. Rung 3, in each store's `test/error-typing.test.ts`.
- The replay harness fails every sampled store call once with each kind of fault, holds each sweep run to the kind it asked for, and ends with a floor: every store method the sweeps fail met both kinds. Rung 3, in `packages/sdk/test/replay-equivalence.test.ts`.
- The PostgreSQL deadlock case no longer moves with the class map. Rung 3.

Deferred (recorded in BUILD.md):

- A run whose store call fails permanently ends at once under a terminal reason of its own. It is a spec change first and the maintainer's design question, and its spec now has to say what a unique violation from an id collision does, which a retry with a new id cures. Acceptable because a worker pass treats a permanent store error exactly as an outage until then, so no run's fate depends on the typing.
- The self-concurrency surface booking as a refusal only what the contract names as one, and the fault matrix failing a cell on a rejection it did not inject. Both are older than this pull request and each has its trigger.

## What this round still would not catch

A MySQL number whose name does not say what it means, filed under a class that says the opposite of what a retry does, would ship today: the case that reads the server's list selects by name, and errors 1104 and 1227 above are two it passes unseen. A PostgreSQL SQLSTATE under classes 22, 23 or 42 that a retry cures would ship today, because PostgreSQL has no catalog of its states to read and its map is held by three classes and one real-server case. The review read PostgreSQL's limits and found them filed under classes 53, 55 and 57, and did not probe them on a server. A defect of a worker pass that shows only when an even, earlier store call fails would ship today, because the replay harness samples odd calls and the last. A third way to break a constraint that PostgreSQL or libSQL files apart would ship today. And a false sentence in a document would ship today, as it has in every round: no layer reads prose against the code it describes.
