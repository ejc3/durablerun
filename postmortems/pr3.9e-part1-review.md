# Postmortem: PR3.9e part 1, the generated follow-ons as trees, review round 1 (PR #43)

PR3.9e part 1 makes the generated follow-ons, `derived()` and `seal()`, build statement trees. One Fable `/code-review` round compared all 62 regenerated statements with the text they replace and found every one a faithful respelling, with the fence, the parentheses, the queue correlation, the source instant, and the bind order intact. It then ran the rules around those statements and found six gaps. Three are regressions: the text path refused the shape and the tree path had stopped. Four more defects were ours, found by our own instruments while fixing the six: two in the repairs, and two holes that turned up when the false-negative exhibits for this document were written and run. All ten are fixed, and no store statement has any of these shapes.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped wrong. The severity is that three rules silently weakened in translation, in the one place this engine cannot afford it, and every gate was green.

- **A counter that counts twice (worst).** `set: { attempts: 'tasks.attempts + 1' }` was accepted. The text path's rule named this form in its own comment, `x = t.x + 1`, and refused it. A replayed batch re-matches the row it stamped and counts again. The tree rule looked for an unqualified mention only, because a qualified read of another row, `(SELECT f.state FROM runs f …)`, must pass.
- **Arguments dropped, and the write widened.** `whereArgs: ['r']` with no `where`, or with a `where` that a caller computed and that came out empty, was accepted, and the statement compiled with no caller correlation at all. It then writes every row under the fence. The text path refused the bind count.
- **A gate that gates nothing.** A follow-on gated by `EXISTS (SELECT count(…) … WHERE fence)` was accepted when the aggregate was built as a plain function node or hidden in a value fragment. An ungrouped aggregate returns a row whether or not any row matched, so the EXISTS is always true and a losing batch writes. The rule recognised one node kind.
- **A legitimate tail refused.** The same rule ran at the statement's root, so a tail that counts the rows this batch stamped was refused as ungated. The text path accepted it.
- **Fence tokens with text left over**, `$FENCE:a$FENCE:b$`, passed the fragment parser. The database would reject the compiled SQL, which a caller sees as a store outage.
- **A set value that only looked like an expression** passed the guard and was bound as data. It was refused later, by the bind type check, for the wrong reason.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The counting rule's fragment form skipped a qualified mention of the assigned column | A self-count under a qualifier replays and counts twice | The tree counting rule, which replaced the text rule | It was tested with the unqualified forms only. The text rule's qualified forms are held by text-path mutations, and the tree rules have no mutations yet | The fragment form refuses a qualified mention beside an arithmetic or concatenation operator, under any qualifier, with a refusal for each side (rung 2) |
| 2 | `whereArgs` or `narrowArgs` with no text, or with empty text, were accepted and dropped | A correlation that comes out empty widens the write to every row under the fence | The generator's own argument check | The text generator concatenated the text and checked the bind count of the whole statement. The tree generator mints a fragment only when text is present, so absent text skipped the check | `derived()` refuses arguments with no text and empty text, each with its own refusal (rung 2) |
| 3 | The aggregate rule looked for one node kind | A gate through an ungrouped aggregate built as a function node, or hidden in a fragment, is always true | The gating rule | It matched a spelling. The property is whether the SELECT can return no row | A required subquery or a derived table gates only if it is grouped or selects nodes with no function and no fragment (rung 2) |
| 4 | The aggregate rule ran at the statement's root | A tail that counts the rows its own WHERE gates is refused | The gating rule's tests | No test had an aggregate at a root, and the corpus has no such tail | The rule is asked only of a required subquery and a derived table, and a fenced count tail has an acceptance test (rung 3) |
| 5 | A fence token with text left over passed the fragment parser | The compiled SQL is rejected by the database at run time | The fragment parser's malformed-token check | It looked for the token's prefix in what was left, and the leftover of a run-on token has no prefix | Nothing may be left over beside a token: no `$` outside literals once tokens are removed (rung 2) |
| 6 | The set value guard accepted any object with a `toOperationNode` | A value that is not an expression is bound as data and refused later for the wrong reason | The guard | It re-implemented a weaker form of the builder's own test | The builder's exported `isExpression` (rung 1 for that guard) |
| 7 | The repair for finding 5 ran before the dollar-quote check and shadowed its message | A dollar-quoted string is refused as a malformed fence token | An existing test of the dollar-quote refusal | It could, and did, before the repair was committed | The new check runs after the dollar-quote check (rung 3) |
| 9 | The repaired counting rule looked for an operator beside a qualified name, so a function call between them hid a read of the assigned row: `1 + COALESCE(tasks.attempts, 0)` | A self-count through any function replays and counts twice. The text path had the same hole | The false-negative exhibit for finding 1's repair | It could, and did: the exhibit was written to show a boundary and showed a hole | The fragment form refuses ANY mention qualified by the table being written, with or without arithmetic, and keeps refusing arithmetic on another row (rung 2) |
| 10 | The repaired gate rule read the selections and the GROUP BY, and not a HAVING | A gate through `HAVING count(*) >= 0` with no GROUP BY is always true, so a losing batch writes | The false-negative exhibit for finding 3's repair | It could, and did | An ungrouped HAVING returns a row regardless, so it gates nothing (rung 2) |
| 8 | Three conditions of the repairs were not held by any test, and one of them was dead code | A later edit could drop the derived table's gate or the grouped escape with everything green | The witnessed deletion run | It could, and did, before the repair was committed | Two cases added, the dead check deleted, and all fourteen deletions now fail a test (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| An existing test of the dollar-quote refusal, during the repair | 1 | yes |
| The witnessed deletion run over the repairs | 1 | yes |
| The false-negative exhibits, written and run for this document | 2 | yes |
| Fable `/code-review` and `/simplify`, round 1 over `fce5078...3ab86a6` | 6 | no |

Self-catch rate: 4 of 10, or 40%. The earlier rounds were 0 of 1, 2 of 6, 1 of 7, and 2 of 13. All four self-catches are defects in the repairs or holes beside them, found by instruments pointed at the repairs: an existing test, the deletion run, and the exhibits this template demands. The exhibits earned their place: asked to write the code that still has the bug and still passes, two of four attempts found a bug worth fixing, one of which the text path had carried all along. Nothing of ours found any of the six the review found, and the next section says why that is the finding that matters.

## Recurrence

Findings 1, 2, and 4 are regressions against the text path, and finding 3 is the oldest class in this repository: a check that matches one spelling of a condition. All four have the same cause, and it has now appeared in three consecutive rounds.

- **The corpus proves statements, not rules.** Every PR since PR3.9a has compared the compiled statement with the text it replaces, and the reviews keep confirming those comparisons are right. But a rule is a function from statements to refusals, and nothing compares what the tree rules refuse with what the text rules refused. Findings 1, 2, and 4 are exactly such differences.
- **The text rules are held by registered mutations, and the tree rules are not.** BUILD.md defers the tree-path mutations to PR3.9e part 3, when the text path is deleted. PR3.9c's postmortem named that deferral as the reason six conditions were deletable. PR #41's named it again for a grammar field nobody read. This round it cost three regressions. A mechanism deferred three rounds running is not a plan, it is the hole.
- So the order of part 3 changes. The registered mutations for the tree checks land FIRST, as their own PR, before any more text is moved and well before the text path is deleted. Each text-path mutation that holds a rule gets a tree-path successor that holds the same condition, and the successor must be caught before its text-path original is retired. BUILD.md records this.

Findings 5 and 6 are new instances of smaller classes: a check on a token's prefix where the property is that nothing is left over, and a hand-rolled copy of a guard the library exports.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The fragment form of the counting rule | 2 | The assigned row read through an alias, with the arithmetic outside the subquery. Run: `(SELECT t2.attempts FROM tasks t2 WHERE t2.task_id = f.task_id) + 1` is ACCEPTED, and the control with the arithmetic beside the aliased name is refused. Knowing that `t2` is the row being written needs the text's aliases resolved, which a net over text cannot do. A counting value belongs in nodes, where the rule reads the operator and its operands |
| Arguments need their text | 2 | Text that is present and correlates nothing. `where: '1 = 1'` with no arguments is accepted, and it widens the write exactly as absent text does. The rule knows empty from present, not meaningful from vacuous, which is every fragment's boundary |
| A gate only through a SELECT that can return no row | 2 | A gate that can return no row and is not correlated to the row it writes. Run: a hand-built follow-on on `tasks` gated by `EXISTS (SELECT f.run_id FROM runs f WHERE f.fence_stamp = <fence>)` is ACCEPTED. It proves the batch won, not that this row is the winner's. Generated follow-ons are correlated by construction, and BUILD.md gives the hand-written ones to part 2 |
| Nothing left over beside a fence token | 2 | A `$` inside a string literal is outside the check by design, since JSON paths live there. The literal scanner knows plain single quotes only, and the forms it cannot read are refused before this check runs |
| The witnessed deletion run | 3 | It is a witness made once, not a gate. A condition added after this PR with no refusal of its own passes everything until the tree checks have registered mutations |

## Fix-induced defects

Four, findings 7 to 10. Findings 7 and 8 were caught before the first repair was committed, and findings 9 and 10 after it, by the exhibits, and repaired red first in a second pair of commits. The repair for the leftover-token check was placed ahead of an older, more specific check and changed the message a dollar-quoted string gets, which an existing test pins. And the first deletion run over the repairs found three conditions no test held, one of which was unreachable code.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `fce5078...3ab86a6`, run locally in the PR's worktree. It re-ran its top findings with scratch probes against the head and the base. For the statements, its verdict: "All 31 changed statements per dialect keep the same paths, `bindArity`, and placeholder count", with `where` and `narrow` parenthesized, the queue correlation kept, `fence_at_ms` as `min(f.fence_at_ms)`, and bind order unchanged.
- Quoted findings:
  - "Head accepts it and compiles `set "attempts" = (tasks.attempts + 1)`. Base refuses it with 'bumps a counter blindly'";
  - "A spec with `whereArgs:['r']` and `where` absent or `''` is accepted on head. It compiles with no caller correlation";
  - "A follow-on gated by `EXISTS (SELECT eb.fn('count',[f.run_id]) … WHERE f.fence_stamp = fence)` is accepted";
  - "`tailTree(SELECT count(*) FROM runs WHERE fence_stamp = fence)` is accepted on base and refused on head as ungated".
- Red test: commit `f7bf805`, run and seen failing (6 of 61 tests) against `3ab86a6`. Four fail with "expected [Function] to throw an error". The tail fails with the batch's own "has no fence gating every row it reads or writes". The set value fails with the later bind refusal, "argument 0 is object", where the guard's own message was expected. Each reason was read in full before the commit.
- Fix: commit `4622861`, after which core, the corpus test, and the generated-selection store test pass (266 tests), the compiled corpus is unchanged in both dialects, and 2662 conformance cases that run generated follow-ons pass in both dialects. Fourteen condition deletions were run. Three survived, two cases were added and a dead check deleted, and all then failed a test.
- Second red: commit `1026f49`, run and seen failing (2 of 63 tests), each with "expected [Function] to throw an error": the function-wrapped self-count and the ungrouped HAVING gate.
- Second fix: commit `86af270`, after which core, the corpus test, and the generated-selection store test pass (268 tests), the compiled corpus is unchanged in both dialects, and the same 2662 conformance cases pass, so no shipped fragment reads its own row. Five more condition deletions were run and each fails a test.

## Root cause

Each PR3.9 step translated a rule by reading the statements that exercise it, and proved the translation with those statements. The statements in the stores are well behaved, so they exercise the accepting side of every rule and almost none of the refusing side. The refusing side of the text rules lives in thirty registered mutations and their tests, and no step carried those across.

## Mechanisms

- **Built now**
  - The five rule repairs above, each with a refusal or an acceptance for every condition, and fourteen witnessed deletions.
  - The builder's own expression guard in place of a copy.
- **Reordered, recorded in BUILD.md**
  - Registered mutations for the tree checks move to the front of part 3, as their own PR, ahead of part 2's merge if part 2 is not already in review. Each text-path mutation that holds a rule gets a tree-path successor before its original is retired.
- **Deferred, recorded in BUILD.md**
  - The batch's `tree` option becomes required when the text path is deleted, so a batch that calls `derived()` without one fails to compile instead of failing when it runs.
  - The parentheses around a value fragment get their own registered mutation. Two mutations own the one line that decides a fragment's parentheses today, and neither removes the parentheses from a value alone.

## What this round still would not catch

- A difference between what a tree rule refuses and what its text rule refused, for any rule not touched in this round, until the tree checks have registered mutations.
- Fragment text that is present and means nothing: a correlation of `1 = 1`, a gate the text only appears to make.
- A self-count written so the text shows no arithmetic on the column's name.
