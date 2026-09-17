# Postmortem: PR3.9a statement trees, review round 1 (PR #37)

PR3.9a lets a store build a batch statement as a Kysely operation tree and makes `FencedBatch` check the tree instead of scanning SQL text. The first version accepted any tree and refused a list of known bad shapes. One Fable `/code-review` round and one Fable `/simplify` round then found ten shapes that list missed. They include an assignment written in the builder's other `set` form, a counter or a clock hidden in a raw fragment, and a write inside a common table expression under a read-only tail. They also include a fence compared on a table its statement never stamped, and a raw fragment adding a placeholder no argument binds. None was reachable from the one statement this PR moves to a tree, `complete`'s compare-and-set. All ten are fixed, and the checks now run inside a closed statement grammar that refuses any node kind or clause it does not list.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped a wrong write: `complete`'s compare-and-set used none of these shapes. The severity is what PR3.9b to PR3.9e would have inherited. Those PRs move twelve more operations onto these checks and then delete the text scanners.

- **A write through a read-only tail (worst).** A fenced SELECT tail whose common table expression deletes rows was accepted. On PostgreSQL the delete runs whether or not the fence matches, so a losing invocation writes. The text path refuses this shape.
- **Replay counts twice.** A follow-on counter written as `.set('attempts', …)` or as a raw fragment was accepted, so an exact batch replay would count twice.
- **A follow-on that never runs.** A fence compared with the `fence_stamp` of a table its statement did not stamp never matches, so the follow-on is inert while the batch reports success. `UPDATE … FROM` with no join predicate let one won run rewrite every row of another table.
- **A column silently skipped.** Kysely drops an undefined assignment before a tree exists, so the statement runs without that column. The text path throws.
- **A forged or missing stamp.** A second assignment to `fence_stamp` passed the stamp rule, and a follow-on declared without a target could update a provenance-carrying table unstamped.
- **Binds shifted or missing.** A `?` inside a raw fragment, or in the unguarded second clock, added a placeholder with no argument. libSQL binds NULL there, which silently falsifies a guard.
- **A second clock in a follow-on.** The clock with its spaces removed, or called as a function node, was accepted.
- **Checked is not what runs.** The checked tree was kept by reference and compiled again when the batch ran.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The two-argument `set` form wraps the assigned column in a reference node, so the counter and stamp rules skipped it, and a second assignment to `fence_stamp` passed | A replayed counter counts twice, and a forged stamp is accepted | The tree statement tests | Every test assignment used the object form | `assignedColumn` resolves both forms in one place, and the grammar refuses an assignment that resolves to no column (rung 1) |
| 2 | A counter hidden in a raw fragment, as text or as a column reference, was accepted | A replayed counter counts twice | The tree statement tests | The counter rule read only operator nodes | A raw fragment in an assignment may not mention the column it assigns, and every arithmetic or concatenation operator counts (rung 2) |
| 3 | A follow-on accepted the clock with its spaces removed, and the clock called as a function node | A follow-on reads a second instant | The tree statement tests | The rule matched the clock token and one exact text | Clock function nodes are refused, and raw text is scanned with the spelling list `clock-lint.py` uses (rung 2, a spelling proxy confined to raw text) |
| 4 | An undefined assignment is dropped before a tree exists | A transition commits with a column unwritten | `FencedBatch`'s bind checks | They run on the tree, after the builder dropped the value | `FencedBatch` accepts only statements minted by `defineStatement`, which refuses an undefined bind at any depth (rung 1 for binds) |
| 5 | A data-modifying common table expression under a SELECT tail or a gated follow-on was accepted | A losing invocation writes on PostgreSQL | The tail rule | It read only the root node's kind | The closed statement grammar lists no `with` clause and no write below the root (rung 1) |
| 6 | A raw fragment could add a `?` that no argument binds | libSQL binds NULL and a guard goes silently false, and PostgreSQL reports an outage | The tree compile step | The text compiler's count check was not carried over | Compiled placeholders must equal bound arguments (rung 2) |
| 7 | The batch held its clock twice, and only one copy had the no-`?` guard | A `?` in the second clock shifts every later bind, and two clocks can stamp one batch | The `FencedBatch` constructor | The tree dialect carried its own clock | The tree dialect holds no clock, so a batch has one (rung 1) |
| 8 | A fence compared on a table its statement did not stamp was accepted, as were `UPDATE … FROM` and a schema-qualified table | An inert follow-on, a follow-on that rewrites every row, and a write to another schema's table | The gating rule | It matched any column named `fence_stamp` and ignored the fence's source table | A gating fence names the table it is compared on, which must equal the table its statement stamps, and the grammar lists no `from` on an update and no schema (rung 1 for the grammar, rung 2 for the table match) |
| 9 | A follow-on declared without a target could update a provenance-carrying table without stamping it | Rows change with no provenance for a later fence or audit | The stamp rule | It read the declared target, not the table the tree writes | The stamp rule reads the table the tree writes, and the declaration is gone (rung 1) |
| 10 | The checked tree was held by reference and compiled again at run time, and the stored SQL was a probe nothing read | What runs can differ from what was checked, at twice the compile cost | `FencedBatch`'s statement record | It kept two representations | A tree statement compiles once, when added, and only the compiled statement is kept (rung 1) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| PR3.9a's tree decision table and tree statement tests, before review | 0 | yes |
| Fable `/code-review` round 1 over `a9b3c86...e4fe09c` | 9 | no |
| Fable `/simplify` round 1 over `a9b3c86...e4fe09c` | 1 | no |

Self-catch rate: 0 of 10, or 0% (previous round: 0%, `pr3.11c-store-answers-review.md`).

Three of the nine were also reported by `/simplify`: findings 6, 7, and 10. While writing this document's mechanism audit, the exhibits found one more gap before it was committed: the first `requireDefinedBinds` checked only top-level binds.

## Recurrence

- **One spelling matched, inside the PR built to end that class.** AGENTS.md's catalogue lists it: every clock and counter lint matched one spelling. PR3.9's own BUILD entry warns that a tree makes the question answerable, not easy. The builder API is a second spelling space: two `set` forms, raw templates, function nodes, common table expressions, `FROM`, and schemas. The first tree checks accepted any tree and refused listed shapes, so every unlisted form was open. The earlier mechanisms, better regexes and then "use a tree", each moved the list without changing the default. The grammar changes the default: what it does not list is refused.
- **A second representation, for the third PR running.** `pr3.11c-store-answers-review.md` found the worker checking one object and running another. Here the batch checked a tree and compiled it again later, and held two clocks. The mechanism is the same each time: keep one representation, produced by the check.
- **Test axes taken from known instances, for the third PR running.** `pr3.11b-generated-surfaces-review.md` and `pr3.11c-store-answers-review.md` both name it as root cause. The decision table's six shapes came from the BUILD entry's list of past failures. Generating more shapes would repeat the pattern, so this round's answer is structural instead: an unlisted shape fails closed.

## Mechanism audit — the false negative of each

Every exhibit below was run against the fixed code, beside a control the same run refused (a fence joined by OR).

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The closed statement grammar | 1 for what it excludes | A listed node used harmfully. Run: a follow-on with `task_id = 'some-other-task'` and an uncorrelated `EXISTS` on the fenced run is ACCEPTED, and it rewrites a task the run does not own |
| The gating fence's table match | 2 | The same exhibit: the right table, the wrong row. Gating decides position, not correlation |
| Clock function nodes and the raw text spelling scan | 2, and the scan is a syntactic proxy | A clock read the list does not spell. Run: a follow-on assigning `(SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'fake_now_ms')` from a raw fragment is ACCEPTED |
| Counting assignments | 2 | A non-idempotent function of the own column. Run: `headers = json_insert(headers, '$[#]', 'x')` built from function nodes is ACCEPTED |
| `defineStatement` and its bind check | 1 for binds | An undefined the builder computes itself. Run: a statement whose builder looks a value up and gets undefined is ACCEPTED, and its compiled SQL has no `available_at_ms` assignment |
| Declared raw booleans and the placeholder count | 2 | A raw fragment outside a boolean position is not counted. Run: a follow-on assigning `state` from the raw fragment `'cancelled'`, with no raw booleans declared, is ACCEPTED |
| Compile once, one clock | 1 | None found. The compiled statement is the only representation the batch keeps, and the tree dialect has no clock field |
| The builder column descriptor's catalog check | 2 | A column listed in the test's omissions is unchecked, so a mistaken omission hides a missing column |

## Fix-induced defects

One, caught before commit by the exhibits above. The first `requireDefinedBinds`, written for finding 4, checked only top-level binds, so an undefined nested in a bind object was still dropped. It now checks every depth.

## Evidence

- Red tests: commit `c0f4293`, run and seen failing (2 of 10 tests) against `e4fe09c`: the unstamped follow-on and the unbound placeholder.
- Red tests: commit `1ba2318`, run and seen failing (8 of 16 tests, the two above and six more) against `e4fe09c`:
  - the two-argument counter, the second stamp assignment, and the raw counter;
  - the data-modifying common table expression under a tail;
  - the fence on an unstamped table;
  - `UPDATE … FROM` and the schema-qualified table.
- Red tests: commit `0b51c8c`, run and seen failing (9 of 17 tests, the eight above and one more) against `e4fe09c`: the respelled clock and the clock function node.
- No red was possible for findings 4, 7, and 10. `defineStatement` did not exist at the red commits, and the fixes for 7 and 10 removed the API that expressed them. For finding 4, `complete` was rescued at the red commits by its text follow-on, which throws on the same undefined value.
- Fix: commit `52a8729`. Gate after it: typecheck, Biome lint and format, and the determinism, user boundary, ledger, fragment, batch, clock, outcome, and deferral lints pass. Core tests pass (15 files, 208 tests), and store and non-fuzz conformance tests pass on libSQL and PostgreSQL (36 files, 6,336 tests).
- Finders: Fable `/code-review` and Fable `/simplify`, round 1. Quoted verdicts:
  - "`columnName()` matches only a bare `ColumnNode`. Kysely's two-argument `.set('col', v)` wraps the column in a `ReferenceNode`";
  - "The tree checks inspect only the root node. A data-modifying CTE under a SELECT tail or a gated follow-on is ungated, unstamped, and outside the blind-counter and INSERT checks";
  - "`gatingFences` accepts any column named `fence_stamp`, because `referencedColumn` drops the qualifier";
  - "The tree path has no bind-arity check";
  - "`opts.now` and `opts.tree.now` configure the same clock twice".
- The same round found a test file under `packages/core/src`, which the build would have shipped in the published package. It moved to `packages/core/test`, and a build now emits no test file. That is packaging, not a defect in the checks, so it is not counted above.
- Did not reproduce as a silent failure: the claim that the CI bridge arm "silently takes the 'does not need the bridge' arm" after a registry change. The bridge step exits 0, but base-gate then fails on the find count, as PR #36's first base-gate run did.
- Not re-run here: the reviewers' PostgreSQL behaviour for a missing bind and for a column assigned twice. Both shapes are now refused before any dialect sees them.

## Root cause

The tree checks were written as ports of the text scanners' known failures: accept any tree, refuse the listed shapes. A query builder offers many forms for one statement, so a list of refusals is always one form short. The tests repeated the same forms the checks were written against, so they could not see the gap.

## Mechanisms

Built in this PR:

- The closed statement grammar, `statementGrammarProblem`, in `packages/core/src/sql-tree.ts` (rung 1 for what it excludes). A statement that needs a new node kind adds it there, with the check that reads it.
- `defineStatement`, the only source of statements a batch accepts, with a bind check at every depth (rung 1 for binds).
- One representation: a tree statement compiles once when added, and a batch has one clock (rung 1).
- The stamp rule reads the table the tree writes, and a gating fence must stamp the table it is compared on (rung 1 and rung 2).
- Counting assignments cover every arithmetic and concatenation operator and raw self-references, and clocks cover function nodes and raw text spellings (rung 2).
- Declared raw booleans and the placeholder count (rung 2).
- A builder that throws if executed, and a conformance case comparing the builder's column descriptor with every dialect's catalog (rung 2).

Deferred (recorded in BUILD.md):

- Correlation of a gated subquery with the written row, under PR3.9e. The generated `derived()` selections are correlated by construction, and the text path has the same residual today.

## What this round still would not catch

- A follow-on gated by an uncorrelated subquery that writes a row the fenced run does not own.
- A clock read from raw SQL that the spelling list does not name, such as the fake clock row.
- A non-idempotent function of a follow-on's own column, such as a JSON append.
- An undefined value a statement's builder computes itself, which Kysely still drops.
- A raw fragment outside a boolean position, which no declaration counts.
