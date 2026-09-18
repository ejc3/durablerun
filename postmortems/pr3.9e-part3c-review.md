# Postmortem: PR3.9e part 3c review

PR3.9e part 3c made a batch read each statement's tree once, asked the rules of the two
store SQL text lints of the tree, enrolled the generated corpus from a descriptor, cut
the base gate's bridge to one table and one arm, and built completion's task mirror as a
tree. One review pass found twelve defects, none of them in what the engine writes. The
corpus enrolment could not see a batch its scenario never drives, the new rule judged
caller data and had more false negatives than it admitted, and the documents claimed an
exit test that is not met. Our own machinery found none of the twelve.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here loses, duplicates, or misattributes durable state, and no shipped
statement changed its meaning. It is a SEV because every one of these would have
merged under green gates, and three of them weaken the gates themselves.

The worst is finding 1. MySQL builds `heartbeat` as a `FencedBatch`, and the corpus held
no copy of its two statements, so a change to the SQL that extends a lease on MySQL
would have failed nothing. Finding 7 is the one a user could have met: the new rule
read any list of values wherever it stood, so a future statement comparing a column
with caller data would have thrown for the one caller whose data held the word
`failed`, and the message quoted that data. Findings 4 and 5 are a rule that claimed
more than it checked. Findings 2, 3 and 10 are documents that said what was not so,
and finding 3 would have closed a milestone exit test that is still open.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | MySQL's `heartbeat` is a tree-built `FencedBatch` that the corpus scenario never drives, so it had no golden copy | A change to the SQL that extends a lease on MySQL fails nothing | Corpus enrolment, which this PR rebuilt to catch an unenrolled tree-built label | Enrolment by what ran sees only what the scenario drives | A test reads every `new FencedBatch(` in the store sources and holds each store's labels to the labels the descriptor enrols for its dialect, and refuses a label that is not a literal (rung 2) |
| 2 | DESIGN.md and BUILD.md called `heartbeat` text that no tree holds, which is false on MySQL | PR3.9f's scope was written one dialect short | None: no check reads a sentence against the code | Prose | None. The documents now state it per dialect, and the label check's inventory is where the fact comes from |
| 3 | BUILD.md said exit test 3 was met for every fenced batch, while the test also requires the text scanners deleted | A milestone exit test would have read as closed while `fragment-lint` and `clock-lint` still run | The deferral lint | It checks that deferred work has one owner, never that a claim of "met" is true | None. BUILD.md now says the test is not met until PR3.9f, and the milestone's item list names PR3.9f |
| 4 | The deadline half of the new rule listed four ordering operators, so BETWEEN, equality and IS DISTINCT FROM passed, and no test wrote that down | A second comparison of `cancel_at_ms` built from nodes passes the rule that exists to refuse it | The rule's own verdict tests and mutations | Each mutation removed a listed operator, and none could name an operator nobody listed | The rule lists the two tests that are allowed, IS NULL and IS NOT NULL, and refuses every other operator (rung 1 for an operator built from nodes) |
| 5 | The state-list half read literal lists only, and its tests named one false negative of eight | `state IN (?, ?)` with bound states, `ARRAY[...]`, a partly bound list, a complement, CASE arms, a chain of `<>` and a join to values all pass | The mechanism audit the repository requires of every mechanism | The audit was written for the one spelling the author thought of | A fragment's binds are read. The rest are run as exhibits in the verdict tests, and DESIGN.md calls the rule a check of spellings (rung 2, a proxy) |
| 6 | The registry arm and the inventory size were pinned to a main that had moved | The base gate would go red on the reviewed head | The base gate | It did catch it: the arm skips and the base registry fails on this tree. The reviewed head predated the rebase | None needed. The rebase re-keyed the arm and re-derived its lists from main's own coverage function |
| 7 | The state-list rule read bind data whatever column was compared, and quoted it in the refusal | A statement comparing another column with caller data throws for one caller's data, and the error carries that data | The rule's verdict tests | Every test compared a state column, so the rule's reach beyond it was never exercised | The rule is keyed on the compared column, so a list elsewhere is never read, and the refusal is a constant (rung 1: the list is reached only through the comparison that names the column) |
| 8 | The pinned pairs table's only row could never fire, so its install and its refusal shipped without ever running | The next pull request to need a row would run that code for the first time inside a required step | The lint self-test, which runs bad inputs through every checker | The table is inline in the workflow, which no self-test runs | The step runs three controls on every pull request: another base skips, an unpinned head refuses, a pinned head installs. Deleting each answer in turn fails the step (rung 3) |
| 9 | The derived coverage check wants one mutation for a one-line spelling list, however many entries it holds | Entries of such a list can lose their mutations with the check still green | The coverage check | It counts lines, and a one-line list is one line | None in this PR. The pattern is older than this change (`COUNTING_OPERATORS`), and the rewritten rule's list has two entries with a mutation each. Recorded below as a residual |
| 10 | BUILD.md said none of the twenty-three hashes named a file main still had, and one head-side pin did | A reader checking the claim finds it false | None | Prose | None. The sentence now says what was measured: none of the base-side hashes |
| 11 | A doc comment was separated from its function by an insertion | `isFencedBatchBindError` had no comment and `treeBuilt` had the wrong one | None | No check ties a comment to a declaration | None. Fixed |
| 12 | `tree-walk.ts` held an unreachable fallback that failed open: `walk.ends[at] ?? at` | If it ever fired, no node would be tested and every rule would answer that there is no problem | The type checker's index rule, which is what demanded a fallback | It demands some value and cannot say which value is safe | A node's place now holds its own end and children, so no parallel array is indexed and no fallback exists (rung 1) |

## Detection ledger

Every finding came from the one outside review pass, which ran the built-in review and
simplify skills as subagents and added the reviewing agent's own reading and one probe.
Our machinery found none. Finding 6 is the nearest to ours: the base gate would have
gone red on the reviewed head, and the rebase had already re-keyed the arm when the
review returned, but the review reported it first, so it is counted as theirs.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The built-in code review skill, run as a subagent | 7 | No |
| The code review and simplify skills, overlapping | 2 | No |
| The code review skill with the reviewing agent's probe | 1 | No |
| The reviewing agent's own reading | 2 | No |
| This project's machinery | 0 | Yes |

Self-catch rate: 0% (previous round: 0%).

The previous round, part 3b, was 0 of 7. Two rounds at zero say the mechanisms these
rounds add guard the code that was just written and not the claims made about it: six
of these twelve are a document or a test suite saying more than the code does.

## Recurrence

**A spelling standing in for the operation (findings 4, 5 and 9). This class has
recurred in every round that added a rule over SQL.** AGENTS.md catalogues it: the
clock lints matched one spelling each, `NOT (EXISTS (` beat `NOT EXISTS (`, and part
3b's reader of a fragment's text for a call passed a schema-qualified one. This round
wrote a new instance on purpose, because the rule it replaces is a regex over store
source text, and a condition built from nodes is invisible to that regex. Asked of the
tree, the same rule sees both. That is a step up and it is still a proxy: the property
is that eligibility has one definition, and the rule checks that a list under IN
compared with a state column is a known set. The deadline half shows what ending the
class looks like. It listed operators to refuse, an open list, and BETWEEN beat it. It
now lists the two tests that are allowed, a closed list, and an operator nobody thought
of is refused. The state-list half cannot be closed that way without reading SQL text
as SQL, which is the parser this project does not have, so its gaps are run as
exhibits.

**A check that sees only what a scenario drives (finding 1).** The fault matrix exists
because coverage curated by suspicion missed a duplicated claim, and its labels are
held to the store sources by `batch-lint`. The corpus enrolment this PR built repeated
the mistake one layer up: it enrolled by what ran. The earlier mechanism was right and
was not reused. The fix is the same shape, a static read of the constructions.

**A claim of done that a gate cannot read (findings 2, 3 and 10).** The deferral lint
was built against deferred work with no owner. It reads ownership, and "met" is a
sentence. This class has no mechanism and this round adds none.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A list under IN or NOT IN on a state column must be a defined set | 2, syntactic | `eb.or([eb('state', '=', 'pending'), eb('state', '=', 'running')])`, a chain of `<>`, CASE arms, one-state lists joined by OR, and in a fragment `state = ANY(ARRAY['pending','running'])` and a join to a list of values. Each is run in `sql-tree-verdicts.test.ts` and passes. `NOT IN` the terminal states defines the live states by complement and passes as the defined set it lists |
| Only IS NULL and IS NOT NULL may test `cancel_at_ms` from nodes | 1 for a node-built operator | A fragment whose text is `cancel_at_ms <= 5` in a core statement passes, run in the same file. A store's fragments are where the deadline is compared, so text is not read, and the scan of store SQL text does not read core either |
| Every `new FencedBatch(` in the store sources is enrolled for its dialect | 2, syntactic | A store that constructs the batch through a wrapper, `const make = (label) => new FencedBatch(label, ...)`, fails the literal check, which is the intended refusal. A class that extends `FencedBatch` and is constructed by its own name is not read. Not run: no such code exists |
| The pinned pairs controls | 3 | They prove the function's three answers on made-up files. A row whose path is misspelled skips as "the base does not need this pair", silently, and the controls pass |
| One walk of a statement's object graph | 1 for the fallback | None found for the fail-open fallback: the place holds its own end, and there is no array to index. A tree mutated inside one run of checks is read stale, which a test pins as intended |
| The static label check's per-dialect descriptor | 2 | A label enrolled for MySQL alone that libSQL later builds as trees fails, because libSQL's labels must equal its enrolled set. A label two dialects build differently under one variant name passes: variants are named per label, not per dialect |

## Fix-induced defects

None of the twelve was caused by a fix for another, because this was a single review
pass. The fold itself was re-tested and not re-reviewed, under the project's cap of one
review round. One defect of the fold was caught by our own check before it was kept:
the red commit for finding 1 did not typecheck as first committed, because the commit
ran after a failed check in an unguarded command, and it was repaired before anything
was built on it. A second was caught by the mutation probe: a verdict test of the fold
carried its marker on arithmetic around the deadline, which the rule refuses as an
operator in its own right, so the mutant that stops reading below an operand was
caught by the test's other assertion and reported WRONG-PATH. The marker moved to the
call, which is the shape only that condition decides.

## Evidence

- Red tests: commit `39e742e`, run and seen failing (16 tests) against `d052618`, the rule as reviewed. Commit `d72944a`, run and seen failing (1 test) naming `heartbeat` for `store-mysql`.
- Fixes: commits `412d44f`, `89d7662`, `62fbeab` and `553d44b`, and the commit that adds this file, which corrects DESIGN.md and BUILD.md; gate after fix: at each fix commit the core suite passed (520 tests), the corpus test passed on libSQL, PostgreSQL and MySQL (9 tests), and the mutation registry's self-test exited 0. The full gates on the final head, each with its exit, are in the pull request body.
- Finder: one review pass by a subagent running the built-in code review and simplify skills, quoted verdict: "No correctness bug in the core TypeScript. The defects are in corpus enrolment, the new rule's undocumented false negatives, the CI pins, and what the docs claim."
- The pinned pairs controls were themselves controlled: with the refusal deleted the step exits 1 with "a head file other than the pinned one was not refused", with the skip deleted "a base with another hash was not skipped", and with the install deleted "the pinned head file was not installed".
- The lines of the rewritten rule that have no mutation were swept: each was mutated in a scratch copy and the core suite run. A list naming only terminal states passed the first sweep with the live half of the test gone from 0 failing tests, so a refusal of two terminal states was added, and the line is listed with what the sweep showed.
- Claims that did NOT reproduce. The reviewer checked and dropped two: a state spelled in another case cannot match on MySQL, whose `state` column is `utf8mb4_0900_bin`, and a list built with `sql.lit` is refused by an earlier rule. Finding 9 was reported unverified, and reading `tree_condition_lines` confirms it: a line of a spelling block wants one mutation whatever it holds. The reviewer's clean verdicts on the one walk's equivalence, the completion mirror's SET order on MySQL, the bridge's refusal paths and enrolment by identity were taken as given and not re-derived.

## Root cause

The gates in this repository read code, and half of what a pull request asserts is not
code: what a rule covers, what a document says is done, which batches a corpus holds.
Each of those was written once, by the author, from the author's picture of the change,
and nothing derived it from the thing it describes. Where a derivation existed it
worked: the registry arm's lists come from running main's coverage function over the
tree, and they were right after two rebases. Where the author listed by hand, the
operators to refuse, the false negatives, the labels that are trees, the list was
short.

## Mechanisms

Built in this PR:

- Every `FencedBatch` construction in the store sources is held to the corpus descriptor for its dialect, rung 2, in `packages/conformance/test/sql-corpus.test.ts`.
- The deadline rule is a closed list of allowed tests, rung 1 for node-built operators, in `packages/core/src/sql-tree.ts`.
- The state-list rule is keyed on the compared column and reads a fragment's binds, rung 2, same file, with its unread spellings run as exhibits.
- The pinned pairs step runs its three answers as controls on every pull request, rung 3, in `.github/workflows/ci.yml`.
- A node's place in the one walk holds its own end and children, rung 1, in `packages/core/src/tree-walk.ts`.
- The queued states have one definition in `packages/core/src/types.ts`, and a test in each store holds its text fragment to it, rung 2.

Deferred (recorded in BUILD.md):

- PR3.9f builds the statements a store still sends as text as trees and then deletes `fragment-lint` and `clock-lint`. Until then exit test 3 is not met, and BUILD.md says so.
- The coverage check's count for a one-line spelling list (finding 9) is left as it is. It is older than this change, the rewritten rule does not lean on it, and changing the count re-opens every listed line of two files.

## What this round still would not catch

A second definition of a set of states spelled any way but a list under IN on a state
column would ship today: alternatives, a chain of `<>`, CASE arms, an array, a join to
values. A comparison of the deadline written as text inside a core statement would
ship. A `FencedBatch` constructed through a subclass would escape the corpus. A
sentence in BUILD.md or DESIGN.md that says a thing is met, deleted, or text on every
dialect would ship if it were false, because nothing reads prose against the code. A
misspelled path in the pinned pairs table would skip in silence. And a spelling list on
one line can lose all but one of its mutations with the coverage check still green.
