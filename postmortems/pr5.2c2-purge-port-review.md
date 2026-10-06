# Postmortem: PR5.2c2, the retention purge port (its one review)

PR5.2c2 is the first code that deletes durable state: schema version 12 and a port, `Retention`, that purges one ended task's unit whole, in one fenced batch, when every condition of the barrier of DESIGN.md section 3.12 holds inside the batch's compare-and-set. One review of the branch's head found no reachable way for the port to lose, duplicate or misattribute durable state, and four things, all LOW: two product defects, one hold that was missing, and one cost. The worst is that the package's entry exported the builders of the purge, and they took the barrier's inputs from their caller, so the barrier held only for a caller that came through the port. Three of the four count, and each is closed here. No review follows the fold, because the round found nothing HIGH or MEDIUM, so each change was checked by running it.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing shipped: the branch was not merged, and no store, command or host calls a purge. What would have shipped without the review is a public export that deletes what the barrier keeps. `@durablerun/core` is a published package, and its entry re-exported two modules whole, so it handed out `addUnitPurge` and `purgeUnitCas`. They took the policy's windows, the unit's parent and the stamp proof as plain values of their caller. The review built a child that had completed a moment before under a parent that was still running. Through the port the purge answered null. A batch built from the entry's own export, with windows of zero, no parent and a stamp proof of `1 = 1`, won: the child's row was deleted while the parent ran, and the parent's replay of its spawn answered `created: true` with another task id. That is the second child the barrier's parent condition exists to prevent, and a child's outcome lost to its parent (finding 1). It needs a caller that builds its own batch, and none exists in this repository, which is why the review classed it a bypass and not an incident.

The second finding is on the port itself. Its check of strings read a member of an object argument, and the method behind it read the member again. A unit whose key answered a short string to the check and a string of 3,002 characters holding a NUL to the method sent a `purge-unit` batch that carried the second string, where the same string passed directly is refused and nothing is sent. A cursor's task id did the same to `purge-candidates`. On libSQL the purge matched nothing. The harm is that a value the port states it refuses reached a statement of the one port that deletes (finding 2).

The third is a hold that was missing. `purgeCandidates` holds its limit to a whole number from 1 to 1,000, and no case and no registered mutation held that at this port: with the check gone, a limit of a million would have sent three legs of a million and one rows each, and nothing would have failed. Beside it, options that were null and options left out were refused by two different errors, and half of the second test could not be reached (finding 3).

## Findings

The findings are numbered as the review listed them. The fourth counts 0 and is not in the table: a purge counts its unit's checkpoints twice, once bounded in the compare-and-set's cap check and once unbounded in the read of the unit, which at 200,000 checkpoints on libSQL is 16.0 to 16.8 ms of a 285.8 ms purge. It is a cost and no defect, the cap was measured with both counts in place, and BUILD.md records counting once as an option with its trigger.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Core's entry exported the builders of a purge, which took the windows, the parent and the stamp proof from their caller (LOW, product) | A caller that builds its own batch deletes a unit the barrier keeps: a child under a running parent, whose replayed spawn then makes a second child | The rule that only a purge deletes, and the mark it reads | The mark is held by identity in a module the entry does not export, so it holds who may mark a statement. Nothing held who may choose what the marked statement requires, and no check ranges over what the entry exports beyond the names the last release had | The entry exports of retention the factory of the port and two types, by an explicit list (rung 1 for the list). The builder reads the parent from the key itself, so that input is gone (rung 1). A policy's windows are a nominal type one function makes (rung 1 without a cast). A case over the exports of retention's three modules, with a registered mutation (rung 3) |
| 2 | The port's method read a member of an object argument again after the port's check had read it (LOW, product) | A member that answers its second reader another value is bound into a batch unchecked, on the port that deletes | The port's check of strings, and the generated case that asks every string place | The check reads and throws, and hands nothing back, so the method reads the argument itself. The generated case passed each bad value directly, where the check sees it | The port takes one reading of every argument into a frozen copy, and the check and the method read the copy (rung 1 for an argument's own members). A case generated from the table of strings and from one well-formed call of each method, with a registered mutation (rung 3) |
| 3 | No case and no mutation held the limit of a candidates listing, and options that are no object were refused two ways, one half unreachable (LOW, tests) | With the limit's check gone a listing reads a million rows of each state in one batch, and no test fails | The mutation registry, and the cases of what the port refuses | The registry derives which conditions lack a mutation only for the regions that hold the statement tree's rules. Core's retention module is outside them, so there the registry is a list its author keeps, and the refusal cases asked the policy, the cursor and the strings | A case of the limit's bound and of options that are no object, with a registered mutation of the limit's check (rung 3). One refusal for options that are no object, with the unreachable half gone |

## Detection ledger

Every counted finding came from the outside review. This project's own machinery found five defects on the branch before the review, and by the repository's rule they are the system working and are not counted: a defect the author's machinery catches before review is no finding of a review round. They are listed because the ratio alone would hide them. The contest of four purgers beside a spawner counted 40 deadlock victims in 20 rounds on MySQL, and the purge now takes the key's index entry before the row. Two regression cases of the spawn, which no run of the branch had included until the check of the simplify fold ran them, failed because the spawn's second send minted ids of its own, and the second send now takes the ids of the first. A first round of the gates failed a floor of the operator's admission read on three dialects, because the purge had been added to the fuzz walk for every caller, and the walk now purges only for a caller that asks. The unfiltered reading of the new mutations found two caught on the wrong path, and each was aimed again. A read of the branch for what could be simpler found four gaps in its tests, which are not in this count of five. None of these five machines looked at what the package's entry exports or at how many times an argument is read, which is where the review looked.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of the branch's head, by reading and by its own probes on libSQL (findings 1, 2 and 3) | 3 | No |
| This project's machinery, before the review (the contest, the regression cases, the gates, the mutation audit): five defects, none of them a finding of this round | 0 | Yes |

Self-catch rate: 0 of 3, or 0% (previous round, PR5.3d's: 0 of 27, or 0%). All nine rounds of the operable alpha milestone so far have a rate of zero. The rate is not improving. Counted over everything found on this branch by anyone, the machinery found five of eight, and that number is not the rate: the three it missed are the three a reader of the package's surface found in one pass.

## Recurrence

A proxy standing where a property fits recurred, in finding 1, and it is the class AGENTS.md names. The property is that nothing deletes a row of a unit unless the barrier held. What was built is a mark: a statement is the purge's compare-and-set if one function marked it, and the marking module is not exported. That holds who may mark. It stood for who may choose the barrier, because the only statement ever marked was built by a function that took the barrier's inputs as arguments, and that function was exported. PR5.3a's round met the class as a lint that matched spellings, PR5.3b2's as a table of causes standing for the states the engine leaves, and PR5.3d's three times in one fold. Each was answered at the instance. This pull request built its own instance while applying the repository's remedy for an earlier one: the nominal type of the port's value and the mark were each chosen so that a store could not write its own, and both are true and beside the point. The answer here takes the inputs away where it can, the parent and the windows, and narrows the export. It does not turn the mark into the property, and the audit below says what is left.

Two readings of one value recurred, in finding 2. The repository's rule from the SDK's residual round is a single representation: a value that crosses a boundary is returned in its checked form at the source, because two read paths for one value is where divergence lives. It was applied to values that cross a serialization boundary, and DESIGN.md records that the SDK reads an option once before a store call. It was not applied to the port's own check, which is written as a check and returns nothing, on the scheduler port and then again, new, on the port that deletes. PR5.3d's first finding is the same class one layer up, a decision made from a read the write does not hold. The retention port now returns what it read. The scheduler port's older second readings stand, and BUILD.md records the option with its trigger.

A hold that could not fail for what it claims, and a guard with no registered owner, recurred in finding 3, and the first has recurred in every round so far. The mechanism against both is the mutation registry, and it did its work on what it was given: every one of the 33 mutations the branch had registered was caught by its own case. The limit's check was not given to it. PR5.3b1's round said why this recurs: outside the regions the registry derives, it is a list its author keeps. That is still so.

A statement that says more than the code recurred, inside finding 1, and it has recurred in every round of this milestone. The comment of the marking module said a store cannot mark a statement it wrote. That was true, and a reader took from it that a store cannot purge past the barrier, which was not.

## Mechanism audit — the false negative of each

Each row marked as run was planted in the fold's tree, run on libSQL, and taken back.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The entry's explicit list of what it exports of retention, and the case that of everything retention's three modules export the entry exports the factory alone | 1 for the list, 3 for the case, and the case is syntactic: it reads three modules by name | Run: a fourth module holding `export { purgeUnitCas as purgeAgain } from './purge.js'`, exported whole from the entry. The case over the entry and the libSQL case of the review's state both pass (2 passed). The case asks whether a name of three modules is in the entry, and not whether anything the entry exports can build the marked statement |
| The builder reads the unit's parent from the unit's key | 1 | None can be written for the parent: the builder has no parameter for it. Its boundary is the function that parses a key, which its own round-trip cases hold |
| A policy's windows as a nominal type that one function makes | 1 without a cast | Run: `{ completed: 0, failed: 0, cancelled: 0 } as unknown as RetentionWindows` builds a purge with no window at all (1 passed), and the compiler takes it, while the same record without the cast is a compile error. A brand holds what a caller can write by accident, and nothing at run time |
| One reading of every argument of the port, into a frozen copy | 1 for an argument's own enumerable members, two objects deep | Run: a getter three objects deep, under the cursor, is read 0 times and is not copied, so a method that came to read that deep would read the caller's object. Nothing reads that deep today. Run in the same case: a `taskId` the argument only inherits is not read, and the call is refused as one whose task id was left out |
| The generated case that each member has one reader | 3 | Not run: the case asks the members that one well-formed call of each method holds. A member a method gains, which that call is not given, is not asked. The copy would still hold it |
| The case of the limit's bound, with its registered mutation | 3 | Run: with each leg reading `limit + 1000` rows where it reads `limit + 1`, every case of the limit, the port, the candidates, the plans and the corpus passes on libSQL (371 passed in 10 files). The case holds which limits the port takes. It does not hold how many rows a leg then reads |
| One refusal for options that are no object | 3 | Not run: the case asks null, a list, text and options left out. A value of another kind is refused by the same test of the port's check, which the case does not ask |
| The corrected comment and the sentences of DESIGN.md | text | Not a check. Nothing reads the next sentence against the code it describes |

## Fix-induced defects

None is known, and none could be found by a review, because no review follows this fold. In place of one, each change was run. The two product fixes each turn a committed failing case green, on libSQL for the first and on three dialects for the second. The registry's self-test passed with 1448 live mutations, and a filtered audit of the 36 mutations this pull request registers caught each by its own verdict, with no collateral failure. The false negatives above were written and run. The whole gate then ran once on the final head. So the fold's changes were tested and were not read as new code by anyone but their author.

Three defects of the fold were caught inside it and are not counted. The first red commit holds a type error in a helper of its case: a typecheck that failed was followed by the commit all the same, because the two were joined in one command line that did not stop, and the next commit types the helper. The lint refused the brand's declaration where it stood after its first use, before anything was committed. The first script of the false negatives stopped on a search of a log for a line a passing test does not print, and was run again with the finding asserted.

## Evidence

- Red tests: commit `7bf6c54`, probe `packages/store-libsql/test/retention-entry.test.ts` `builds no batch that deletes a child that completed a moment ago under a parent that is still running`, run and seen failing (1 test) against `e85cba8`, where the entry exported five builders, the batch built from `addUnitPurge` won, the child's row was gone with its parent `running`, and the replayed spawn answered `created: true`.
- Fixes: commit `ebe6765`, which turns that red test green; gate after the fix: the 880 cases of core and of the libSQL store, the typecheck, and the lint half of verify.
- Red tests: commit `d6a53d5`, probe `packages/conformance/test/libsql.test.ts` `reads each member of an object argument once, so what the check read is what is bound`, run and seen failing (3 tests, one for each of libSQL, PostgreSQL and MySQL) against `e85cba8`, where the cursor, the cursor's task, the unit's task and the unit's key each had two readers, and the second value of the three named strings was bound into a batch.
- Fixes: commit `2f93f81`, which turns that red test green on the three dialects; gate after the fix: the 24 cases of the port, of a unit that is gone and of the spawn on three dialects, and the typecheck.
- Red tests: none of its own for finding 3, and this line cites no commit. Its case was seen failing by name under its registered mutation, `purge-candidates-holds-its-limit`, in the filtered audit.
- Fixes: commits `839f034` (finding 3, the case of the limit and of the options, and one refusal for options that are no object), `33a5e3d` (a registered mutation for each of the three holds, the count of the registry, and the base gate's exemption of their three markers) and `81b1987` (the type of a helper in the first red test, which changes nothing the case asserts).
- Finder: the one review, a subagent invoking the built-in code review skill, on a detached copy of the branch at that head, e85cba8, on 2026-10-06, on libSQL alone, quoted verdict: "HIGH: no finding. MEDIUM: no finding. LOW: four (two product, one tests, one cleanup)."
- The review's demonstration of finding 1, in its own words: "a child completed moments ago under a parent that is still running. Through the port, `purgeUnit` answers null. A `FencedBatch` built with `addUnitPurge(b, { ..., parentTaskId: null, windowsMs: { completed: 0, failed: 0, cancelled: 0 }, stampStored: sqlFragment('1 = 1') })` wins: the child's row is deleted while the parent is `running`, and the parent's replay of its spawn answers `created: true` with a different task id." The red test builds the same state and makes the same call.
- Its demonstration of finding 2: "a unit whose `idempotencyKey` getter answers `'k'` to the check and then a 3,002 character string holding a NUL. Passed directly, that string is refused with `InvalidDurableStringError` and nothing is sent. Through the getter, a `purge-unit` batch carrying it is sent, and a cursor's `taskId` does the same to `purge-candidates`."
- Its account of finding 3: every limit a test passed was 1, 4, 5, 10, 20 or 50, options that were null were refused as `InvalidDurableStringError`, options left out as `PortRefusalError`, and a bad limit as `RangeError`. It was found by reading and by a probe of the behaviour as it stood, and the review ran no mutant. The fold ran it: the audit applies the mutant and the new case fails.
- Finding 4 in the review's numbers: at 200,000 checkpoints on libSQL the two counts took 20.4 to 21.2 ms and 16.0 to 16.8 ms of a 285.8 ms purge, about 13 percent of the time the batch holds the writer.
- What the review checked and found sound: the paging of candidates that ended at one instant, a unit with no run and one whose own run still has a wait, the refusal of a delete as the compare-and-set and of two forms of an insert that replaces a row, the pins of the workflow and a dry run of its bridge, the MySQL corpus, and the time of the size cells on libSQL. It did not run PostgreSQL, MySQL, the suites, the mutation audit or the model checker.
- Did not reproduce: none was refuted. Where the fold differs from the review's suggestion for finding 1: it offered two shapes, to derive the parent inside the statement and let one function make the windows, or to keep the two builders out of the entry. The fold does both.

## Root cause

The barrier was built as a property of the port, and the port was taken for the only door. Two things made that look closed. The value a store's factory hands out is of a nominal type that one function makes, and the statement that may gate a delete is marked by a module the entry does not export. Each answers the question a store's author would ask: can a store write its own port, or mark its own statement. Neither answers the question a caller of the package would ask, which is what else the package hands out. The entry re-exports its modules whole, so everything a module exports for a sibling module is public, and the one check that reads the entry reads it against the names the last release exported. A name newer than the release is read by nothing.

The second finding has the same root one level down. The port's check was the door for strings, and it was a check: it read, refused or passed, and returned nothing. Whatever is checked and then read again is checked for one reading only. Both findings are a guard that stands in front of a value and does not hold the value.

The third is the registry's known edge. Outside the regions it derives, a guard has a mutation when its author thinks of one.

## Mechanisms

Built in this PR:

- The entry exports of retention the factory of the port, the dialect it is made from and the type it hands out, by an explicit list in `packages/core/src/index.ts` (rung 1 for what that list holds).
- The builder of the purge's compare-and-set reads the unit's parent from the unit's key, and builds nothing for a key in the engine's namespace that names no parent, in `packages/core/src/statements/purge.ts` (rung 1: the input is gone).
- `RetentionWindows` is a nominal type that `retentionWindowsMs` alone makes (rung 1 without a cast).
- The retention port takes one reading of every argument into a frozen copy that its check and its methods read, in `packages/core/src/retention.ts` (rung 1 for an argument's own members, two objects deep).
- A case in core over the exports of retention's three modules, a case on libSQL of the state the review built, a generated case on three dialects that each member of an argument has one reader, and a case on three dialects of the limit and of options that are no object, with three registered mutations, `entry-exports-no-builder-of-a-purge`, `retention-port-reads-each-member-once` and `purge-candidates-holds-its-limit` (rung 3).

Deferred (recorded in BUILD.md):

- Counting a unit's checkpoints once. It is a cost and no defect, and the cap was measured with both counts in place. Its trigger is a measured writer hold near the cap that matters to a deployment, or the next change to the unit's read or to the cap.
- One reading of each object argument on the scheduler port. Its second readings are older than this pull request, DESIGN.md records that the SDK hands the port values it has read once, and its trigger is the next change to a port method that binds a member of an object argument.

## What this round still would not catch

A builder of the purge exported through a module the entry case does not read would ship: the case names three modules. The property is that nothing the entry exports can build the marked statement, and nothing computes that.

A purge built inside core with windows written through a cast would ship. A brand is a compile-time fact.

Every other statement builder of the engine is still exported from the entry with its binds its caller's, because the stores, which are other packages, build their batches from them. A caller can build a batch of the engine's own statements with values of its choosing. The rule that only a purge deletes holds that such a batch deletes no row of a unit. It holds nothing else about it.

A method of the retention port that came to read a member three objects deep would read the caller's object and not the copy. A second reading on the scheduler port ships today, as it did before this pull request.

A leg of the candidates listing that read many more rows than its limit would ship: the cases hold which limits the port takes and that each leg has a LIMIT, and not the size of it.

A guard outside the regions the registry derives, with no mutation because nobody thought of one, would ship, as the limit's check did until a reader looked. And a sentence that is true and implies more than the code holds would ship, as the marking module's comment did.
