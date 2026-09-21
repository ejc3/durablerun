# Postmortem: PR3.1c stale-token column review (PR #72)

The change built a generated conformance surface, the stale-token column: one
case for every call of the scheduler port that presents a claim, derived from
what the poison matrix's `invoke` passes, with 17 registered mutations. It
ships no engine, SDK, driver or store code. It passed every local gate, with
the unfiltered mutation audit at 897 of 897 before main was merged in, and CI
was green on the pushed head. One review, by the built-in code review skill
with the reviewer's own probes on libSQL, PostgreSQL and MySQL, found no bug
in shipped code and found that exit test line 14 holds on all three dialects.
It named six things, one of MEDIUM severity and five LOW. Five are counted
here: three holds of the new surface that could not fail, and two sentences
that said more than was held. The worst was reproduced on three dialects.
DESIGN.md said that a comparison which reads part of the claim token cannot be
written, and with `like` in place of `=` in the shared claim predicate the
batch built and every case of the column passed. Our own machinery found none
of the five.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here reached a user, because the change ships a conformance surface
and no product code, and the product compares the claim token by equality
today. What would have shipped is a surface weaker than it read, under a
sentence of the spec that was false.

1. The worst. A statement that compares the claim token as a pattern would
   have passed the surface built to hold the token, on three dialects, while
   DESIGN.md said such a statement cannot be written. Under that statement a
   caller whose token is `%` holds every claim in its queue.
2. The two lease sweep cases presented a scan from the side no real scan
   reads. A sweep that acts on a claim older than the row, which is the real
   stale scan, would have passed both.
3. The case that says a cancellation sweep is handed no generation would have
   passed when its scan returned no row at all.
4. The audit would not have noticed if the PostgreSQL or the MySQL case of
   `expire-lease-now` lost its ability to fail, while two sentences said every
   comparison the column holds has a registered mutation.
5. DESIGN.md told a reader that a second token-taking argument cannot arrive
   unseen. Two kinds can.

## Findings

The numbers are the review's. Its finding 6 is not counted: a sentence of DESIGN.md put a measurement made before the column in the present tense, which understates what is held and overstates nothing.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | DESIGN.md, the column's own comment and the description said the statement grammar lists no function, so a comparison that folds the token's case or reads part of it cannot be written. The grammar is closed over node kinds, lists one function, `coalesce`, and holds no list of operators, so `like` builds | With `like` in place of `=` in the shared claim predicate the column passed 17 of 17 on libSQL, PostgreSQL and MySQL. A statement under which the token `%` holds any claim would pass the surface that exists to hold the token, under a spec that says it cannot exist | The column's choice of stale callers, which was made against what a statement can spell, and the experiment behind the sentence | The experiment tried one spelling, a call of `lower`, saw the grammar refuse it, and the sentence went from that one refusal to everything that reads part of a token. The grammar's definition was not read. It has a list of functions and none of operators | Three more stale callers: `%`, the claim's token with its last character as `_`, and the token in upper case. A registered mutation makes the `like` edit, and the `complete` case owns it (2 for the mutation the audit runs, 3 for the callers). The three sentences say what the grammar can spell |
| 2 | The two lease sweep cases ran the sweep over a scan one claim later than the row, which no real scan produces, because a stale scan is older than the row | With `>=` in place of `=` in the sweeps' shared predicate, which admits exactly the real stale scan, the column passed 17 of 17 | The two registered scan mutations | Both remove the comparison, and a removal fails from either side. No mutant weakened it to one side, so which side was presented decided nothing | The cases seed a run at its second claim and present the claim before and then a claim not yet made. By hand `>=` and `<=` each fail both cases (3) |
| 3 | The `sweep:cancel` case asserted that the sweep resolved and that no scan row was rewritten, and nothing else | With the cancel seed made not due the case passed, so it could not tell a scan that hands no generation from a scan that returned no row | The case itself, which was added so that the table's one `null` entry is observed and not asserted | It observed the rewriter's count, and the count is zero both when a row carries no generation and when there is no row | The case requires the sweep to have cancelled the seeded task. By hand, with the seed made not due, it fails (3) |
| 4 | The registry's comment and BUILD.md's exit test line counted one registered mutation for every comparison the column holds. `expire-lease-now` is each store's own text, the same seven lines three times, and only the libSQL copy had one | The audit would not notice if the PostgreSQL or the MySQL case of `expire-lease-now` stopped being able to fail. The column itself held both copies: with either removed, that dialect's case fails | The enrollment case, which holds the marker tables to the derived column | It counts markers by call, and a call has one marker however many store texts stand behind it | Two registry entries make the same edit in the PostgreSQL and the MySQL store, each owned by its dialect's case, and the sentences count what is there (2). Nothing derives one entry for each store text |
| 5 | DESIGN.md said the inventory of target shapes keeps a second token-taking argument from arriving unseen | A reader believes no such argument can arrive unseen. One that reaches a call through a branch on a required field's value does, and so does one carried by a field of the target other than `token` and `claimGen`, because the column finds a claim by the probes it places in those two | Nothing. No machine reads a sentence against the code | There is no such layer | The sentence says what the inventory sees, a new optional field, and what it does not. No mechanism |

## Detection ledger

Every counted finding came from the one outside review. Its skill returned one candidate, finding 4, and the reviewer's own probes found the other four.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of PR #72: the built-in code review skill as one subagent, and the reviewer's own probes on libSQL, PostgreSQL and MySQL | 5 | No |
| This project's machinery on the reviewed head: conformance on three dialects, the poison matrix, the fuzz, the lints, the registry's self-test, the unfiltered mutation audit, and CI's five checks | 0 | Yes |

Self-catch rate: 0 of 5, or 0% (previous round on main, PR2.5b's: 0 of 4. The last round on a conformance surface, PR4.5b's: 0 of 6).

Five things this branch's own work found are not counted, because they were found before the review or inside the fold, which is the system working. Before the review, the branch's own written experiment put `<=` in place of `=` in the shared claim predicate, saw the column pass with two arbitrary stale tokens, and moved the tokens to both sides of the claim's. The coordinator's question found that a child spawn presents its parent's claim token through a call `invoke` never made, and the column gained that call. Inside the fold, this document's own mechanism audit wrote and ran two more false negatives, a list that holds the token beside one the column does not present, and the lost-launch cap's statement losing its generation alone. Both are recorded below and in DESIGN.md, and neither is fixed here. And the unfiltered audit, run on the folded head, read both scan mutations as WRONG-PATH, which is the defect that Fix-induced defects records.

The rate is 0%, as it was in the six rounds before this one on main: PR4.5b's, PR4.4a's, PR3.3b's, PR4.6's, PR3.4b's and PR2.5b's. The round before those, PR4.4c's, was 9%, because its new surface found one defect by itself. The `<=` experiment shows why it matters: the branch met the class that findings 1 and 2 belong to, fixed the instance in front of it, and did not ask the same question of the next operator or the next comparison. Root cause says what that question is.

## Recurrence

**A check proven able to fail in one direction and treated as proven (findings 1, 2 and 3). Recurred.** This is the last entry of the repository's own catalogue: a mechanism with one failing case was treated as proven, and two conditions of the wake surface could be deleted with every case green. PR4.5b's round counted four of the same class. The mechanism against it is per-condition mutation, which stays deferred on main. This change used what it had, registered mutants, and every one of its seventeen removes a comparison. A removal fails from every side and under every spelling, so the mutants said nothing about a comparison that is still there and weaker: another operator (finding 1), one side of an ordering (finding 2), a count that is zero for two reasons (finding 3). What the mutants checked is that a case fails when its comparison is gone. What they were supposed to show is that the case holds the comparison to equality.

**A sentence that says more than the code (findings 1, 4 and 5). Recurred, in every round on main since PR4.5.** Each round's answer has been the same, and it is this one's: no machine reads a sentence against the code. Finding 1's sentence is the sharpest of them, because it was written as the conclusion of an experiment. One refused spelling, a call of `lower`, became a claim about everything the grammar can spell. That is the spelling proxy of the catalogue, turned on the author's own probe: the experiment matched one spelling, and the property is what the grammar's definition lists.

## Mechanism audit — the false negative of each

Each row was run against the fixed code on libSQL, except where it says it was not.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Three pattern callers, and the registered `like` mutation of the shared claim predicate | 3 for the callers, 2 for the mutation | A comparison that admits one token the column does not present. Ran: `.where('claimed_by', 'in', [binds.claimToken, 'a-token-the-column-does-not-present'])` in `whereClaimedRun`, and the column passes 17 of 17. The callers sample the tokens that are not the claim's, and do not prove equality. Three controls show what the callers reach beyond the one registered statement. Ran: `like` in heartbeat's own comparison fails the heartbeat case, `like` in `stillClaimed` fails the three cases that share it, and `LIKE` in the libSQL store's `expire-lease-now` text fails that case. Those three statements are held by these hand runs and by no registered mutation |
| The sweep cases present the claim before and a claim not yet made | 3 | The lost-launch case reaches the reopen statement and not the cap. Ran: with the generation comparison removed from the cap's statement alone, the column passes 17 of 17, because the seeded run is below the relaunch cap and the cap's statement matches nothing either way. Any other value a scan hands its write is outside too, because the rewriter moves the two generation counters and nothing else |
| The `sweep:cancel` case requires the sweep to have cancelled the seeded task | 3, and syntactic in one place: it looks for the scan's generation under the column name `claim_gen` | A scan that handed its write a generation under another name would be read as handing none. Not run: it needs a store's scan and its reader changed together |
| Two registry entries for the server stores' `expire-lease-now` text | 2 | The entries are written by hand, one for each store. A fourth store, or a second statement that a store keeps as text and that compares a token, gets its case from the column, because enrollment is derived and every dialect runs the suite, and gets no mutation until someone writes one. Not run: it is a statement about the registry |
| The corrected sentences | none | No machine reads a sentence against the code |

## Fix-induced defects

One, and our own machinery caught it before anything was pushed, so it is not a counted finding. The fix of finding 2 made each sweep case present two stale scans in turn, and held each scan to a floor, that it handed the write a generation, before the marked assertion that nothing was swept. With the scanned generation removed from the sweeps' shared predicate the first stale sweep acts, the second scan then finds no row for the run, and the unmarked floor failed first. The cases failed for the right cause under the wrong message. The by-hand check made before that fix was committed counted the cases that failed under `>=` and `<=` and did not read which assertion failed, and the filtered audit was run for the new mutations and not for the two whose cases had changed. The unfiltered audit on the folded head caught 911 of 913 and reported the two scan mutations as WRONG-PATH. Each scan is now held to the marked assertion first and to the floor after it, and the filtered audit catches all twenty of this branch's mutations by their own verdicts.

One step of the fold also went wrong in its tooling and was caught by reading its output. The first script for findings 2 and 3 committed finding 2 and then stopped without a word after applying finding 3's edit: its check of line widths piped `grep` over a diff of two documents that step does not touch, and under `pipefail` a `grep` that matches nothing is a failure. Nothing was committed from the stopped step. It was finished from a corrected script that first holds the tree to the one expected change.

The fixes were tested again and not reviewed again, which the coordinator decided because the fold changes conformance code and documents only. The unfiltered audit is what tested the fix of finding 2 again, and it is why that audit is not optional. Each operator experiment was run by hand before its commit, the three new registry entries went through the registry's self-test in a scratch tree before any was committed, and the filtered audit caught each new mutation by its own verdict.

## Evidence

- Red tests: commit `8d3906f` registers the mutation `stale-token-read-as-a-pattern` while the column cannot see it. The defect is a hold that could not fail, so no case of the column fails at that commit and the red is the audit's: run and seen, the filtered audit on that commit prints `stale-token-read-as-a-pattern: SURVIVED` and exits 1, and by hand the column passes 17 of 17 with `like` in place of `=`.
- Fixes: commit `280e4be`. Gate after fix: the column passes 17 of 17 on libSQL, PostgreSQL and MySQL with the product unedited, with `like` in place of `=` the eight cases that share the predicate fail, and the filtered audit on that commit catches the mutation by the `complete` case's verdict, 1 exact.
- Red tests, for finding 2: none of its own, and this line cites no commit. The cases could not fail from the real side, no product code was wrong, and the two scan mutations were already registered.
- Fixes, for finding 2: commit `ed36787`. Gate after fix: the column passes on three dialects, `>=` and `<=` in the sweeps' shared predicate each fail both lease sweep cases by name, and the poison matrix, whose sweep seeds now read the invocation target, passes on libSQL.
- Red tests, for the defect that the fix of finding 2 introduced: none of its own, and this line cites no commit. The red is the unfiltered audit's on the folded head, which printed `stale-scan-sweep-lost-launch: WRONG-PATH` and `stale-scan-sweep-claim-timeout: WRONG-PATH`, each case failing with `the scan of a claim not yet made handed the write no generation: expected 0 to be greater than 0`.
- Fixes, for that defect: commit `2923d75`. Gate after fix: the column passes on three dialects, and the filtered audit catches this branch's twenty mutations by their own verdicts, all exact.
- Red tests, for finding 3: none of its own, and this line cites no commit. The case could not fail, and no product code was wrong.
- Fixes, for finding 3: commit `e986457`. Gate after fix: the column passes on three dialects, and with the cancel seed made not due `sweep:cancel is handed no generation by its scan` fails.
- Red tests, for finding 4: none of its own, and this line cites no commit. The column already held the two store texts, and what was missing is registry entries.
- Fixes, for finding 4: commit `36110bb`. Gate after fix: the registry imports at 913 with every find occurring exactly once, and the filtered audit catches all three `expire-lease-now` mutations, each by its own dialect's case, 3 exact.
- Red tests, for finding 5: none of its own, and this line cites no commit. It is a sentence.
- Fixes, for finding 5: commit `26f82f4`.
- Fixes, for the review's finding 6, which is not counted: commit `178afcd`.
- The whole gate list ran on the folded head before main was merged in, and a short list ran on the merged head, where the registry imports at 972, which is main's 952 and this branch's 20, and the unfiltered audit caught all 972 by their own verdicts. This document was added after both, with the attestation's own check of it. The pull request's description carries both tables.
- Finder: the one review, quoted verdict: "I found nothing HIGH, one MEDIUM finding and five LOW ones. The column does what the brief asked, and exit test line 14 holds on all three dialects."
- The reviewer's reproduction of finding 1, quoted: "with `.where('claimed_by', 'like', binds.claimToken)` in `whereClaimedRun` (`claimed-run.ts:17`), the batch builds. The column is green 17 of 17 on libSQL, PostgreSQL and MySQL." Its control, quoted: "With one stale caller `{ token: '%' }` added at `stale-token-column.ts:194`, the eight cases that share the predicate fail. With only `holder.token.toUpperCase()` added, they fail on libSQL, because SQLite's LIKE folds ASCII case."
- The reviewer's result for finding 2, quoted: "With `>=` in `whereSweptClaim` (`sweep.ts:24`), which admits exactly that real case, the column is green 17 of 17. With `<=`, both sweep cases fail."
- The reviewer's probe for finding 3, quoted: "with the cancel seed made not due (`triggerTask('pending')`, no cancel deadline), the column stayed green."
- What the review checked and found sound, in its words: "Each failed exactly its own case by name, and the other 16 stayed green", for the token comparison of all 13 calls removed one at a time on three dialects. "I passed `target.token` to `retryTask` in `invoke`. 18 cases ran and two failed: the enrollment pin, and the new generated case". The poison matrix "generated 3,082 cases" at the base and at the branch's head "with the same names and the same results".
- Claims that did not reproduce. The review's skill said the registry holds no mutation of the MySQL store, and the reviewer counted 24. This fold's own first false negative for finding 1's mechanism did not reproduce either: removing the claim check from the read that answers an await of an event already emitted was expected to pass the column, and it failed two cases, because a tree rule refuses that batch when it is built.

## Root cause

The surface was proven able to fail by removing comparisons, and a removal fails from every side and under every spelling. So the proof said nothing about a comparison that is still there and weaker, and all three holds that could not fail are that: another operator, one side of an ordering, a count that reads zero for two reasons. The branch met the class once before the review, in its own `<=` experiment, fixed the instance, and then closed the class by assertion. It wrote "cannot be written" from one refused spelling, where the grammar's definition would have shown a list of functions and no list of operators. A false negative that is written and run is evidence about one spelling. The sentence claimed the grammar.

The fold repeated the class once more in miniature. Its by-hand check of the new sweep cases counted the cases that failed and did not read which assertion failed, and the audit's attributable verdict is what told the two apart.

The two counted sentences have the cause every round has named: a sentence is written once, from what the author believes the code does, and nothing reads it against the code afterwards.

## Mechanisms

Built in this PR:

- Three pattern callers in the column's one table of stale callers, so that every token-taking case presents them (rung 3), and a registered mutation that compares the claim token with `like` in the shared claim predicate, owned by the `complete` case (rung 2).
- The lease sweep cases present a scan of the claim before, which is the real stale scan, and of a claim not yet made (rung 3). The poison matrix's sweep seeds take their generations from the invocation target.
- The `sweep:cancel` case requires the cancellation (rung 3).
- Registry entries for the PostgreSQL and the MySQL store's `expire-lease-now` text, each owned by its dialect's case (rung 2).

Deferred (recorded in BUILD.md):

- Seeding the lost-launch sweep at the relaunch cap as well, so that the cap's statement is held to the scanned generation by a case. It is an option under the PR3.1c entry. The cap's write takes what it needs from the stored row and reports no scanned value, so nothing durable depends on it today.
- A second argument form of `fail` in the column, the one with a retry. The column calls `fail` with none, and a hand-written case holds the retry form. It is an option under the PR3.1c entry.
- Per-condition mutation, PR3.10, which is the mechanism against the recurring class, stays deferred on main.

## What this round still would not catch

- A claim token compared against a list that holds it and one other token, when the column does not present that other token. The column samples the callers that do not hold the claim, from both sides and as patterns, and does not prove equality.
- A pattern match in heartbeat's own comparison, in `stillClaimed`, or in a store's `expire-lease-now` text would fail the column today, by hand run. No registered mutation keeps that true, so the audit would not notice if those cases stopped presenting a pattern.
- The lost-launch cap's statement losing its generation comparison alone, because the column's lost-launch seed is below the relaunch cap.
- A sweep that trusts a scanned value other than the generation, because the cases move the two generation counters of a scan row and nothing else.
- A scan that handed the cancellation sweep a generation under another column name.
- A fourth store's own `expire-lease-now` text with no registered mutation, and any sentence in DESIGN.md or BUILD.md that says more than the code does.
