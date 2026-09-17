# Postmortem: PR3.9d second half, review round 1 (PR #41)

PR3.9d's second half moves the last compare-and-sets onto shared statement trees: spawn's task insert, the lost-launch sweep's reopen and cap, and the claim-timeout sweep's failure. It widens the closed statement grammar by one field, a partial-index predicate on a conflict target, which spawn's idempotency index needs. One Fable `/code-review` round found the four moved statements equal to the SQL they replace in both dialects, with every bind in its old order, and found one defect in the new grammar field: nothing read what the predicate holds. The review's other seven points were wording and duplication. The defect is fixed, and nothing shipped wrong.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped wrong: spawn's predicate is `idempotency_key is not null`, which holds no bind, and both corpus files pin it.

- **A statement that runs on one dialect and fails on the other.** The grammar admitted `indexWhere` as a field and no check looked inside it. A partial index is matched by its predicate's text. A predicate that compares to a bound value, such as `where state = ?`, passed every check at build time. The review measured what happens next: PostgreSQL 17 accepts the bound predicate and infers the same index, and SQLite refuses it. So the next statement to narrow a conflict target by a value would pass the PostgreSQL suite's statement checks, run there, and fail on libSQL, which is exactly the dialect drift this engine's shared statements exist to prevent. The identical conformance suite would catch such a statement once a scenario ran it, and the grammar should refuse it before that.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The grammar admitted a conflict target's index predicate and no check read what it holds | A predicate with a bind, a token, or a store fragment passes at build time, runs on PostgreSQL, and fails on libSQL | The grammar's insert shape check, which this PR extended | It was extended with the field's name only. The refusals tested beside it were for other target kinds, a constraint name and an index expression, and none put anything unusual inside the admitted predicate | An index predicate holds only column references, operators, and inline values. A bound value, an engine token, and a fragment are refused, each with its own refusal (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review` round 1 over `28984c5...d720f10` | 1 | no |

Self-catch rate: 0 of 1. The earlier rounds were 2 of 6, 1 of 7, and 2 of 13. One finding is too few to call a trend in either direction. What the round does show is that the instruments built in the earlier rounds held: the review tried the bind order of a twenty-bind insert, NULL propagation through the cancel deadline, PostgreSQL's typing of values that used to be literals, the corpus scenario's task identities, and the bridge arm, and reported no finding for any of them. The one defect was in the one place this PR added a rule with nothing beside it.

## Recurrence

Finding 1 is a recurrence, and of the same class as PR3.9c's findings 1 and 4: a field admitted to the closed grammar by name, with the checks written for the statement at hand and not for the field's other members. PR3.9c's mechanism was `insertShapeProblem`, which says what an INSERT looks like beyond its node kinds. This PR added a field to the node that function guards and did not extend the function. So the mechanism exists and works, and it was not applied when the grammar grew. The cheap form of that lesson is already a rule here, from PR3.9c's root cause: a grammar addition is tested against the grammar's other members, not against the one statement that needs it. The witnessed deletion this PR ran, deleting `indexWhere` fails two tests, proved the field is needed. It could not show the field was too wide, because a deletion only tests the direction a rule opens.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| An index predicate of references, operators, and inline values only | 2 | A predicate that is well formed and names the wrong index. Run: a conflict target of `(queue, task_name)` narrowed by `cancellation is not null`, which no index in the schema matches, is ACCEPTED by the tree checks. The grammar can say what a predicate may hold. It cannot say which partial index the schema has, which the schema and the conformance suite hold |
| The store text lints, for conditions now built from nodes | 2 | The review asked whether the lints that refuse a second definition of the live states should scan core's statements. Run, with core's statements added to the lint's scope: a second definition built from nodes, `.where('state', 'in', ['pending', 'running', 'sleeping'])`, passes `fragment-lint` at exit 0, and the control, the same list as SQL text in that file, is refused at exit 1. A text lint cannot see a condition built from nodes, so widening its scope would read as coverage and check nothing. It was declined, and BUILD.md records the rule's tree-level form under PR3.9e |

## Fix-induced defects

None in the code. One in the process, caught before it left the machine: the first red test for finding 1 failed because it named a helper that was local to the test beside it, not because the batch accepted the statement. Its guard checked only that the test failed. The test was corrected, and its guard now requires the failure to read "expected [Function] to throw an error" and requires that no other test fails. A red that fails for the wrong reason proves nothing, and a guard that checks only for a failure cannot tell the difference.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `28984c5...d720f10`, run locally in the PR's worktree, with all six finder lenses, its verifier, and all four simplify lenses complete. Its verdict: "`/code-review` found no correctness bug. Eight LOW findings survive its verifier."
- Quoted finding: "`indexWhere` is admitted with no check that reads what it holds. `insertShapeProblem` checks only `columns.length`", and "I measured PostgreSQL 17 accepting both a bind and a stronger predicate, inferring the same index and swallowing the same conflict. SQLite 3.36 refuses both."
- Red test: commit `5cacb54`, run and seen failing (1 of 49 tests) against `d720f10` with "expected [Function] to throw an error": a predicate comparing to a bound value, and a predicate that is a store fragment.
- Fix: commit `5a3844f`, after which core and the corpus test pass (248 tests). Witnessed: deleting either refusal fails the new test, and refusing inline values too fails the test that admits spawn's own predicate. After the round's other folds, 1236 sweep, spawn, and migrator conformance cases pass in both dialects.
- The review's other seven points were wording and duplication, and the PR body lists them with the simplify pass.

## Root cause

The grammar is a list of fields, and adding a field to a list feels complete when the statement that needed it compiles. The PR's own test of the addition asked whether the field was necessary. Nothing asked what else the field now lets through, which is the only question that matters for a closed grammar, because every member it admits is a statement some later change may write.

## Mechanisms

- **Built now**
  - `insertShapeProblem` reads a conflict target's index predicate: column references, operators, and inline values only, with a refusal each for a bound value and a fragment.
  - The red test's guard checks the reason a test failed, not only that it failed.
- **Deferred, recorded in BUILD.md**
  - PR3.9e's third part gives the "one definition of the live states" rule a tree-level form, since the text lint that holds it cannot see nodes.

## What this round still would not catch

- A conflict target whose columns and predicate are well formed and match no index the schema has. SQLite and PostgreSQL both raise at run time, and the conformance suite runs every shared statement on both.
- A condition built from nodes that duplicates a definition the text lints guard, until PR3.9e.
- A store fragment that is present and guards nothing. The registered mutations and the corpus hold the shipped spellings.
