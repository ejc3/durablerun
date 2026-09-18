# Postmortem: PR3.9e part 3a, review round 1 (PR #48)

PR3.9e part 3a gives the rules that read a statement tree their registered mutations, before part 3b deletes the text path and rewrites those rules into one pass. The PR went to review with eighty mutations, every one caught, and a BUILD.md paragraph that named six conditions as the ones with no mutant. One Fable review mapped every registered find against the source lines and found whole ranges of `sql-tree.ts` no mutation touched. It deleted conditions there one at a time and every test stayed green. Nothing the PR added was wrong. What it said was left was wrong, and part 3b plans from that. The fold registers 136 more mutations, derives the remainder in the registry self-test so nobody keeps the list by hand, and found two real gaps in the clock rule while giving each clock spelling its own mutation.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped wrong, and the review says so: "No correctness bug in what the PR adds, but the mutation inventory it records is short." Every rule the review probed refuses correctly today. What would have shipped is a wrong map, and then a rewrite made from it.

- **A remainder that read as complete.** BUILD.md said six conditions of the tree rules had no mutant. Nothing registered touched lines 143 to 443, 647, 824 to 876, 890 to 963, 986 to 1031, 1033 to 1213, or 1301 to 1306 of `sql-tree.ts`. Part 3b rewrites `addTree` into one pass and reads that list as what it may treat with care. A condition dropped outside it would have passed all 519 mutants the reviewed head had.
- **A deferral that named a guard as redundant.** BUILD.md said `compiled.readsClock` and `compiled.sql.includes(this.now)` answer one question, and that the one pass may keep either. They do not. With a batch clock of `(SELECT 7)` and a follow-on fragment holding that text, only the comparison refuses. Deleting it alone left 0 of 362 tests failing, and the one registered mutant removed both operands together, so part 3b could have dropped the only guard with every mutant green.
- **A tree follow-on could read a second clock, two ways.** Found in the fold, not by review. A function node was compared with a list of eighteen clock names, so `current_date`, `current_time`, `unix_timestamp`, and `now` called as an aggregate were accepted, and so were `datetime()`, `date()`, and `time()` with no argument, which SQLite 3.45 reads as the current time. A fragment was scanned for a date function of `'now'`, so `timediff('now', …)` was accepted, and SQLite answers it with the time since then. No statement of either store calls any of these, so no durable state was at risk. The rule that every engine time is the batch's one clock (§3.4 rule 3) was held by a list of spellings, and the list was short.
- **Conditions any rewrite could have dropped unseen.** A gate through NOT EXISTS of the fenced row, a DELETE accepted as a compare-and-set, a second assignment to `fence_at_ms`, a write below the root, a bare clock keyword in a fragment, and about sixty more each survived deletion with every test green.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | BUILD.md's six conditions with no mutant read as the whole remainder, and whole ranges of `sql-tree.ts` had no mutation | Part 3b would plan its one pass from a short list | The registry self-test | It checked that each find occurs once and each marker is registered. Nothing compared the finds with the conditions in the source | The self-test derives the remainder: every condition-bearing line needs as many mutations as it holds conditions, or a listed reason (2, a proxy: it reads text) |
| 2 | BUILD.md called `compiled.readsClock` and the comparison with the batch clock's text one question. Only the comparison sees the clock's own text in a fragment, and one mutant removed both | Part 3b could drop the only guard with every mutant green | One mutation for each condition | The mutant replaced the whole condition, and the deferral was written from reading, with no run | `tree-clock-text-in-followon` removes the comparison alone. `readsClock` deleted alone fails no test of 490, and the table says the comparison subsumes it (2) |
| 3 | `tree-gate-requires-tie` removed the `&& tied` half of `gate.tied && tied` only | An untied subquery nested in a tied one could be reported tied | The same | One mutant on a line of two conditions | `tree-gate-inner-tie-carried`, and the count rule of finding 1 (2) |
| 4 | The `=== 'exists'` test had no mutant, and Kysely has a `not exists` operator | A follow-on gated by NOT EXISTS of the fenced row would count as gated and write when the batch lost | The same | No test built that operator | `tree-gate-exists-operator`, killed by the operator built through `eb.unary` (2) |
| 5 | The statement-kind rule had no mutant and no test | A DELETE accepted as a compare-and-set stamps nothing | The same | The rule predates the mutations and nothing walked `addTree` line by line | `tree-statement-kind` and `tree-cas-refuses-delete` (2) |
| 6 | "Once each" was held for `fence_stamp` only. The mutant changed a helper two readers share | A second assignment could overwrite the instant or the clock | The same | One mutant, one shape, two readers | `tree-stamp-assigned-once` on the stamp's own line, with `tree-followon-instant-assigned-once` and `tree-cas-instant-assigned-once` (2) |
| 7 | Two arms of the clock spelling list and the case fold of function names had no mutant or test | A bare `current_timestamp`, `datetime('now')`, or `UNIXEPOCH()` could be dropped from the rule unseen | One mutation for each spelling | The list was held by one mutant and one spelling | A row for each function, keyword, and date function in a table in the test file, and each arm and case fold (2). For function nodes the list is gone: finding 13 |
| 8 | The grammar was held by one whole-rule mutant and one shape, `returningAll()` | A write below the root, a schema-qualified table, or any INSERT shape could be dropped unseen | The same | One mutant for a rule of about thirty conditions | A mutation for the node kinds, each write below the root, the clause list, each INSERT shape, and the listed column (2) |
| 9 | BUILD.md named twelve retirements and missed eight more registered mutations whose tests begin from the text `cas` | Part 3b would find eight verdict tests broken by its deletion | Reading | A count made from the mutated file, where the tests' first lines decide it | BUILD.md corrected: twenty tests move. No mechanism: see the last section |
| 10 | The unused-argument bind mutation mapped to a tree mutant whose test showed only the missing-argument direction | The fragment's argument count could lose one direction unseen | One mutation for each condition | One mutant of `!==` and one shape | `tree-fragment-unused-argument` and `tree-fragment-missing-argument` (2) |
| 11 | `accepts()` reported the marker for any throw and dropped the cause | An unrelated crash would read as the intended refusal | The verdict helper | It caught everything and threw the marker alone | `expect(action, marker).not.toThrow()` keeps what was thrown (3). The probe still attributes on the first line: see the audit |
| 12 | `tree-raw-fragment-order` voided every raw-fragment problem under a name that said one | The name overstated what one shape held | Reading | Nothing reads a name against a replacement | Renamed `tree-raw-fragment-problems-read`, with a mutation for each problem (2) |
| 13 | A tree follow-on could call a clock the list of function names did not hold: `current_date`, `unix_timestamp`, a date function with no argument, `datetime('now')` built from nodes, `now` as an aggregate | A second clock in a follow-on, against §3.4 rule 3. No store statement calls one | The statement grammar, which is closed for node kinds and was open for function names | A denylist of spellings stood where a closed list fits | The grammar lists the functions a statement may call, `coalesce` and five aggregates, so any other call is unwritable (1 for nodes). `clockFunctionCalls` is deleted |
| 14 | A fragment could read the clock through the literal `'now'` under any function but three | The same, in text: SQLite's `timediff('now', …)` | The spelling scan | It named three functions, and the clock is in the literal | The scan refuses the literal anywhere, and a date function with no argument (2, a proxy: a spelling list) |
| 15 | With every review finding folded, an automatic sweep still found ten conditions with a shape of their own and no mutation | The same as findings 3 to 8 | The derived check of finding 1 | It did not exist until this fold | Ten mutations: the fence comparison must be a fence token, the outer qualifier must be in scope, the four operands of the EXISTS tie, every selection of a no-row subquery, a subquery only under IN or EXISTS, the filter on fenced instants, and every fragment scanned (2) |
| 16 | Five kinds of mutant or shape of the fold did not hold what they named when first written | None reached a commit | The deletion harness and the tests themselves | They did: see Fix-induced defects | The harness runs every tree mutant against its test before a commit (3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| One Fable `/code-review` and `/simplify` run over `93a9557..9e2dee0`, which applied all eighty mutants in a scratch copy and deleted conditions one at a time against the core suite | 12 | no |
| The table that gives each clock spelling its own kill, while it was written, then a run against SQLite 3.45 and the rule as it stood | 1 | yes |
| The run written to show what the spelling scan still misses, which showed `timediff('now', …)` accepted | 1 | yes |
| An automatic sweep: every condition-bearing line with fewer mutations than conditions, mutated operand by operand against the core suite | 1 | yes |
| The deletion harness, run over every new mutant before each commit | 1 | yes |

Self-catch rate: 4 of 16, or 25% (previous round on this work, PR3.9e part 2's: 3 of 10, or 30%; the two rounds before this one by date, PR #50's: 8%, and PR #47's: 2 of 21, or 10%). Against the last round on this work it fell. It is above the two rounds before it by date, which were a concurrency fix and a TLA model and not this kind of work. The shape is the one PR #47's postmortem described the same day: review found every defect in what the PR CLAIMED, and our machinery found defects only after review showed it how. The review's instrument was a line map and single-condition deletions. The fold's sweep is that instrument made automatic, and it found ten more, which is the evidence that it should have existed before the first push.

## Recurrence

**A hand-kept list read as complete** (findings 1 and 9). PR #47's round, merged the same day, ended with "Generating the mutant list from the model's guards stays with PR3.10. The guard half of 'nothing speaks for it' is hand-kept until then", and PR #42's round listed the same residual. That mechanism lives in `scripts/tla.sh` and reads the names of TLA properties. Nothing like it read TypeScript conditions, and this PR's list was prose in BUILD.md, which no checker reads. So the class recurred in the first PR after it was named, in the other language. This round derives the list for the tree rules. Finding 9 is the same class with no mechanism: which tests begin from the text `cas` is still a count someone made.

**One spelling standing for the operation** (findings 7, 13, and 14). AGENTS.md names it: "Every clock and counter lint matched one SPELLING; the property is the operation." The earlier mechanism was a case-insensitive pattern in `scripts/clock-lint.py` with fixtures in the lint self-test. It checks that a listed spelling is refused. The property is that a statement reads no second clock. For function nodes this round replaces the list with the property, because the grammar can close the set of functions. For fragment text the list remains, and the audit below shows the next spelling it misses.

**One failing case treated as proof of a rule** (findings 2, 3, 5, 6, 8, 10, and 12). AGENTS.md names this too: "A mechanism with one failing case was treated as proven; the property is that it fails for EVERY condition it claims." Earlier rounds answered it with witnessed deletions: nineteen in part 2 and thirteen in PR3.9c, each run by hand and kept nowhere. A deletion nobody registers protects nothing after the PR that ran it.

**A verdict that cannot say why it fired** (finding 11). The probe's exact-marker rule, from the mutation rounds, checks the first line of a failure. It checks that the marker was emitted, not that the intended refusal is what went missing.

## Mechanism audit — the false negative of each

Each exhibit was run on the fold's final tree. The first two are cases of the registry self-test and run with it.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The derived remainder: conditions on a line against mutations that touch it | 2, syntactic | `while (Boolean(node.d)) return null` decides a return with none of the tokens the check reads, no mutation touches it, and the check is clean. Kept as the self-test case "false negative: a condition the token list does not name" |
| The same, its count | 2, syntactic | Two mutations that both remove `node.a` from `if (node.a && node.b)` count as two, and `node.b` is unheld. Kept as the self-test case "false negative: two mutations of one operand" |
| The closed list of functions a statement may call | 1 for nodes | None for a function node: a call the grammar does not list cannot be built. The boundary is text: the next row |
| The spelling scan of fragment text | 2, syntactic | `age(created_at_ms)` in a follow-on fragment is accepted. PostgreSQL 17.11 answers `select age(timestamp '2000-01-01')` with "26 years 8 mons 17 days" against today's date |
| One mutation for each condition, each killed by one shape | 2 | Narrow `outside.includes('--')` to `outside.includes(' -- ')`: 0 of 499 core tests fail, because the one shape, `x = 1 -- trailing`, has the spaces. A kill proves the condition is read, not that it is read for every input |
| `refusesAs`, for a condition whose deletion leaves the shape refused by the next rule | 2 | It holds the message. Delete the VALUES refusal and give the next rule's message the words "takes a SELECT, never VALUES", and it passes. By construction: the first rule is not needed for the refusal, which is what makes it layered |
| `accepts` keeps the cause | 3 | Make the read of `excluded` throw `TypeError: an unrelated crash`. The test fails with "mutation-verdict:construction:tree-counting-excluded-is-incoming: expected [Function] to not throw an error but 'TypeError: an unrelated crash' was thrown". The cause is there for a reader, and the probe, which reads the first line, still counts the mutant caught |

## Fix-induced defects

One finding, number 16, and none reached a commit. Five kinds of mutant or shape in the fold did not hold what they named when first written:

- Three shapes for a write below the root were refused as a bind error, because the builder binds a DELETE builder as a value. Only a tree built from nodes holds that shape. The tests' own first run showed it.
- `returningAll()` brings a `ReturningNode`, so under the clause-list mutant the node-kind rule refused it next. The harness reported a failure with no marker.
- `sql.lit(1)` is itself an unminted raw node, so the no-parameters mutant left the shape refused. The harness reported it unheld.
- A mutant that turned `some` into `every` over a statement's fragments refused every statement with no fragment, because `[].every()` is true: 213 tests failed and none with the marker. The harness showed it.
- The formatter reflowed one line when an operand left it, so one registered find occurred nowhere. A count of every find against the sources, run before the registry was regenerated, showed it.

The fixes were re-run as new code: the harness applied every one of the final tree mutants to a scratch copy, and each fails its own marker.

## Evidence

- Red tests: commit `12388a0` ("Red: a tree follow-on reads a clock the spelling list does not name"), run and seen failing, 1 test, "current_date: expected [Function] to throw an error", against `ca0b54e`. Commit `8c7d75b` ("Red: a fragment reads the clock through the literal 'now'"), run and seen failing, 1 test, "timediff('now', '2000-01-01'): expected [Function] to throw an error", against `f85714e`. Both reds were run on the branch before its rebase onto main's `0279907`, and the rebase left `packages/core` byte-identical, file by file.
- Fixes: commit `1a2a5aa` closes the function list, and commit `22492fa` refuses the literal. Gate after each: the core suite, 499 tests, the registry self-test, the lint self-test, which gained three clock fixtures, and the clock lint over the store sources.
- Finder: one Fable run of the built-in `/code-review` with eight finders and its own verification pass, and `/simplify` with four agents, quoted verdict: "No correctness bug in what the PR adds, but the mutation inventory it records is short. BUILD.md's claim that only six tree conditions lack a mutant does not hold, and part 3b plans from that list."
- Every deletion the review reported was run again before anything was built on it, against the 362 core tests of the reviewed head, with the registered mutant `tree-gate-not-in` as the positive control, which failed on its own marker. All thirteen reproduced: ten left 0 of 362 failing, and the listed column, the fragment's argument count, and the right operand of a count were each caught by one unregistered test, as the review said. A fourteenth deletion, ours, removed `compiled.readsClock` alone, and it too left 0 failing.
- The sweep: 218 condition-bearing lines were short of mutations. It made 441 line-local mutants, replacing each operand with its neutral value, each branch with both outcomes, and each single-line ternary with both arms, and ran the core suite for each. For 117 lines every valid mutant failed a test. For 64 one survived, and each was read by hand. For 37 it could make no valid mutant, and a second sweep with a corrected ternary mutator and hand-written deletions covered those. After the fold 180 lines are short, and the table lists 175 distinct ones.
- The clocks, run: SQLite 3.45.1 answers `select datetime()` with the current time, and `select timediff('now','2000-01-01')` with "+0026-08-17 05:01:00.853". The rule as it stood accepted seven function-node spellings and four fragment spellings, beside three refused controls: `unixepoch()` as a node and as text, and `datetime('now')` as text.
- Claims that did not reproduce:
  - Ours: `datetime("now")`, with SQLite's double-quoted string, was the first candidate for the scan's false negative. This build refuses it: "no such column: now". It is not an exhibit.
  - Ours: the first crash written to show `accepts`' boundary never reached `accepts`, because the control before it threw first. The second was aimed at the read of `excluded`.
  - Ours: a lint self-test run failed on "--suite-linger-self-test-child exceeded its external 1.5s completion watchdog". Two vitest runs shared the machine. Alone it passes, 197 bad inputs rejected.
  - The review's: none. Each of its measured claims reproduced.

## Root cause

The PR's claim about itself was written from reading, and the machinery checks mutations one at a time. The probe proves that a registered mutant is caught. Nothing asked the converse, which conditions have no mutant, and that converse was the PR's whole reason to exist. The author answered it by walking the code, which is the method that produced a short list in PR #47's round the same day. Every mechanism added here asks the converse by a run and not by a reading: the line map in the self-test, the sweep that feeds its table, and the harness that applies every mutant before a commit.

The clock findings share the older cause AGENTS.md already names. A denylist is a picture of the property, and it stays a picture until something closes the set. For function nodes the set could be closed, and had not been only because the grammar's closure stopped at node kinds.

## Mechanisms

Built in this PR:

- The derived remainder, `tree_rule_coverage_problems` in the registry self-test, with `TREE_CONDITIONS_WITHOUT_A_MUTATION` (rung 2, a text proxy, with two false negatives kept as its own cases).
- The closed list of functions a statement may call, in the statement grammar (rung 1 for function and aggregate nodes), replacing `clockFunctionCalls`, a denylist.
- The literal `'now'` and a date function with no argument in the spelling scan, in `sql-tree.ts` and in `scripts/clock-lint.py` with three fixtures (rung 2, a spelling proxy).
- 134 more registered mutations net, one for each operand and each spelling, with `refusesAs` for a condition whose deletion the next rule covers (rung 2).
- `accepts` keeps the cause (rung 3).

Deferred (recorded in BUILD.md):

- Part 3b's one pass moves the lines the self-test reads, so it moves the region anchors and the listed lines with them. That is the mechanism doing its work, not a deferral of it.
- Which tests begin from the text `cas` stays a count made by hand, because part 3b deletes `cas` and the compiler will then name every such test.

## What this round still would not catch

- A clock spelled in a fragment under a name nobody has listed, such as `age(column)` on PostgreSQL, ships today. The scan is a list, and the two lists, in `sql-tree.ts` and in `scripts/clock-lint.py`, are kept the same by hand.
- A condition of a tree rule spelled with none of the tokens the derived check reads has no mutation and no entry, and the self-test is clean.
- A line whose mutations all remove the same operand passes the count with the other operand unheld.
- A condition narrowed so that its one test shape still trips it, such as a comment test that needs spaces around `--`, passes its mutant.
- A rule that lives outside the regions the check reads has no derived remainder: the batch's audit in `run()`, the generator behind `derived()`, and the stores' fragments.
- A retirement list made by counting, finding 9's class, in any document no checker reads.
