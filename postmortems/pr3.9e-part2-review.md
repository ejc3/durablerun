# Postmortem: PR3.9e part 2, review round 1 (PR #44)

PR3.9e part 2 moves the thirteen hand-written follow-ons, tails, and open tails of both stores onto shared statement trees, and adds the rules a hand-written tree needs: a follow-on INSERT, a subquery gate tied to the row it guards, and an open tail. One Fable review read every moved statement against the text it replaced and found them faithful in both dialects. It then ran the new rules and found seven gaps. Six are fixed, red first. One stays open, because the fix built for it broke two registered mutations, and it is deferred to part 3. Three more defects were ours, all three in the fixes, and all three caught by our own runs before anything was pushed.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped wrong. The review's verdict: "This branch introduces no production defect. `/code-review` found ten things and none is in the SQL the two stores run today." No pinned statement uses any shape below: all five IN subqueries in both corpora select a column of the fenced source.

- **A gate that proves the batch won and not that the row is the winner's.** The tie rule this PR added checked only that IN had a column on its left. Nothing read what the subquery selects. `task_id in (select ? from runs f where f.run_id = ? and f.fence_stamp = :win)` with a bound task id was accepted, and the review ran it on SQLite: the victim's row was completed and the fenced run's own task was left alone. The shape is carried from main, and this PR's rule was written to close it and did not.
- **A follow-on INSERT that writes one stamped row per row of an unrelated table.** `from runs as f, tasks as t2` was accepted. The `'one'` bound is audited after the batch returns, so on PostgreSQL the rows have committed by then.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The subquery tie never reached the fenced source. IN checked only that its left side is a column, EXISTS accepted an equality with any inner source, and a second FROM source in a required subquery was not refused | A win writes rows the batch never stamped, with no store fragment involved | The tie rule this PR added | It tested position, a column on the left, and not the property, that the key selected comes from the fenced row | A gating subquery has one source, the fenced one. IN selects one plain column of it, and an EXISTS tie equates a column of it with an outer column. Each `GatingFence` carries `tied` (rung 2) |
| 2 | A follow-on INSERT … SELECT did not bound its FROM list | One stamped row per row of a second table | The follow-on insert rule this PR added | It read the selection and the gate and never the FROM list | One FROM item, the fenced source. A join carries its ON (rung 2) |
| 3 | The preserved-instant rule applied to a compare-and-set insert only. A follow-on insert into `events` with a bound `emitted_at_ms` was accepted | A first instant that did not come from the engine's clock, against §3.4 rule 3 | The preserved-instant rule | The follow-on INSERT did not exist when the rule was written, and this PR opened that door without walking the rule through it | `fencedInstants`: in a follow-on insert a preserved instant is the fenced row's `fence_at_ms` (rung 2) |
| 4 | OPEN. `plain` refuses a function node in a follow-on insert's selection and does not read a fragment, so `max(f.fence_at_ms) + ?` in the successor's deadline slot passes, and a losing batch would still insert a successor. Both shipped successor inserts carry that slot | The same as an ungated row, through one opaque slot | The plain-selection rule | A store fragment is opaque to the tree. The rule built for it, no `name(` in such a fragment, was taken back: see finding 10 | None. DESIGN.md and BUILD.md record it. What closes it is building the successor's deadline from nodes, with part 3 |
| 5 | A PostgreSQL cast sat in a shared statement: `case when cast(? as bigint) <= ? …` in the fail successor. MySQL has no `CAST(x AS BIGINT)`, and DESIGN.md called it a cast every dialect takes | The third dialect fails on a shared statement | The shared-statement dialect test | `MysqlSpellingCompiler` checks spelling the compiler controls, and a cast written by hand is not one | The state is decided before the statement is built, `retryDelayMs <= 0`, which is what the old text compared. The CASE, the cast, and a duplicate bind are gone (rung 1: nothing dialect-specific is left to spell) |
| 6 | The counting rule refused `excluded.owner_attempt + 1` in a conflict arm as a blind self-count | A correct upsert that counts from the incoming row cannot be written | The counting rule, widened by this PR to read a conflict arm | It dropped every qualifier, and `excluded` names the incoming row | `excluded` is read as the incoming row, in nodes and in a fragment (rung 2) |
| 7 | `openTailTree` skipped the gate and also the check that a fence is compared on the table its compare-and-set stamps, while DESIGN.md said it skips the gate and nothing else | An open tail with a fence that can never match passes | The table check | It ran only on the gated path | The table check runs for every fence in a gating position, and `addTree` takes an `'openTail'` kind (rung 2) |
| 8 | Ours, in the fix for 1: an IN subquery selecting two things had no refusal of its own | A condition of the new rule could be deleted with every test green | The witnessed-deletion run, which caught it | The refusals were written for the review's exhibits and not for each condition | Its own refusal and test (rung 3) |
| 9 | Ours, in the fix for 7: the table check read only tied fences | The same | The same run | The same | Its own refusal and test (rung 3) |
| 10 | Ours, in the fix for 4: the rule that refused `name(` in a value fragment killed two registered mutants at build time. `timestamp-addition-claim-timeout-successor-exact` and `timestamp-addition-user-retry-successor-exact` write `MIN(<deadline>, <cap>)`, SQLite's two-argument scalar, into that slot, and went WRONG-PATH | CI's full mutation audit would have gone red | The filtered mutation runs over the entries that own that text, which caught it | Every other gate passed. Text cannot tell that scalar from an aggregate, by name or by argument count | The rule is taken back, and its red and green stay in history. The accepted aggregate is an exhibit again |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| One Fable `/code-review` and `/simplify` run over `9aa3b30...da99a02`, with probes against real SQLite and PostgreSQL 17 | 7 | no |
| The witnessed-deletion run over the fold's new conditions | 2 | yes |
| The filtered mutation runs over the entries that own the successor's deadline | 1 | yes |

Self-catch rate: 3 of 10, and every one of the three is a defect of the fold and not of the PR as first pushed. Part 1 was 4 of 10, and the rounds before it 0 of 1, 2 of 6, 1 of 7, and 2 of 13. What the round shows about the machinery: the instruments built in earlier rounds, deletions and filtered mutations, now catch defects in NEW RULES before push. Nothing we own reads a new rule the way the review did, by writing the smallest statement that satisfies its letter and defeats its purpose.

## Recurrence

Finding 1 is the oldest class in this repository, a proxy standing where the property fits. `hasPositiveFence` checked that a statement's text contains a fence, where the property is that the fence reaches the rows, and it took four rounds. This PR's tie rule checked that IN has a column on its left, where the property is that the key it selects comes from the fenced row. The PR3.9a postmortem's own exhibit was refused by that rule, which is how it read as closed. The mechanism from the earlier rounds, the false-negative exhibit, was applied here and produced three exhibits, all about fragments. None asked what the subquery SELECTS, because the author's attention was on what a fragment hides and not on what plain nodes allow.

Finding 3 is PR3.9c's class again: a rule written for the statement kind at hand and not walked through a door opened later. There it was a grammar field admitted by name. Here it is a statement kind, the follow-on INSERT.

Finding 10 is the ratchet law working through the registry. The rule built for finding 4 was a spelling, `name(`, standing for the property that the selection cannot produce a row when the gate fails. Two registered mutants that spell a scalar call in that slot refuted it within the hour.

## Mechanism audit — the false negative of each

Each exhibit below is a test in `packages/core/test/fenced-batch-tree.test.ts` that asserts the shape is ACCEPTED, beside a control that is refused. They run with the suite.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A gating subquery tied to the fenced source | 2 | An IN key that is a stored column of the fenced row and the wrong one: `f.run_id` selected for a task key. The rule says where the key comes from and cannot say which column is the key |
| One FROM item in a follow-on INSERT | 2 | An explicit join whose ON is the store text `1 = 1` still inserts a row for every task. A join's ON is a fragment, and a fragment is opaque |
| A preserved instant in a follow-on INSERT | 2 | A bound instant on a table the hand-kept map does not list, `checkpoints.updated_at_ms`. The rule reads `PRESERVED_FENCE_INSTANTS`, which is a list someone keeps |
| `excluded` read as the incoming row | 2 | The written row counted through an aliased subquery with the arithmetic outside it, part 1's exhibit, still accepted |
| The table check on every fence in a gating position | 2 | A misplaced fence under OR stands in no gating position, so no rule reads it |
| Finding 4, no mechanism | none | `max(f.fence_at_ms) + ?` in the successor's deadline slot, the original exhibit, accepted again |

Sixteen conditions of the new rules were each deleted in turn, and each deletion fails a test.

## Fix-induced defects

Three of ten, findings 8, 9, and 10, and all three were caught before push by the runs this series built for that purpose. Finding 10 is the one to remember: a rule that passed the whole suite, the corpus, typecheck, and every lint was wrong, and only the filtered mutation runs over the entries that own the text said so.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `9aa3b30...da99a02`, 45 minutes, both lenses finished, 10 of 14 candidates surviving its verifier, with probes of its own under a scratch directory.
- Quoted: "The IN branch only checks that the left side is a column", "On real SQLite the victim row became `completed|seed:task` and the fenced run's own task was left alone", "Base 9aa3b30 accepts it as well, so it is carried, not regressed", and "`plain` does not refuse a `RawNode`".
- What it found sound: guards, conflict arms, orderings, and limits intact in every moved statement; spawn's receipt, the old UNION ALL against the new OR form, identical over 24 cases of id and key on SQLite and on PostgreSQL 17, with both indexes kept in the plan; the bridge digest equal to main's registry.
- Finding 1. Red: commit `cc1c4ae`, 1 of 275 tests fails, eight untied shapes read as tied. Green: `2cb4320`.
- Finding 2. Red: `4483804`, "expected [Function] to throw an error". Green: `c275827`.
- Finding 3. Red: `d47ee91`. Green: `3314fa2`.
- Finding 4. Red: `171e03e`. Green: `65daafc`. Taken back: `6ba4203`, after the two filtered mutation runs went WRONG-PATH.
- Finding 5: `da270b8`. Both corpus files change in that one statement, `case when cast(? as bigint) <= ? then ? else ? end as "state"` becomes `? as "state"`, binds 11 to 8, and 1734 fail, retry, and sweep conformance tests pass in both dialects.
- Finding 6. Red: `907fee8`, "bumps a counter blindly (x = x + n)" thrown for `excluded.owner_attempt + 1`. Green: `f6b680f`.
- Finding 7. Red: `385017a`. Green: `0cc1426`.
- Findings 8 and 9: `8559ea9`. The first deletion run of 20 caught 15, two survived, and three anchors were stale. The second run of six caught all six.
- Exhibits: `946ebef`.
- Final state, before the rebase onto main: 86 files and 6873 tests pass with none skipped, 2989 of them PostgreSQL cases, typecheck and all fourteen lints pass with 439 live mutations, and the four filtered mutation keys that own the fail successor are each caught by their own verdict. After the rebase: the base gate reproduces against main with zero lines between the repaired base registry and this tree's, and core and the corpus pass, 284 tests.

## Root cause

The rules this PR added were each written against the statements this PR moves, which satisfy them, and against the last round's exhibits, which they refuse. A rule's author asks whether the good statements pass and the known bad one fails. The review asked a different question of each rule: what is the smallest statement that meets its letter and defeats its purpose. For the tie that statement selects a bind. For the insert it adds a table. Neither needs a fragment, and the author's exhibits were all about fragments.

## Mechanisms

- **Built now**
  - A gating subquery reads one source, the fenced one, and its tie names a column of that source.
  - A follow-on INSERT reads one FROM item, and takes a preserved instant from the fenced row.
  - `excluded` is the incoming row to the counting rule.
  - An open tail skips the gate and nothing else.
  - The fail successor's state is decided before the statement is built.
- **Deferred, recorded in BUILD.md**
  - Finding 4: the successor's deadline built from nodes, so that `plain` can read it. It re-aims two registered mutations onto core and needs a bridge arm, and it belongs with part 3's tree-path mutations.

## What this round still would not catch

- The five accepted exhibits above. Four of the five end in a fragment or a hand-kept list.
- A rule that meets the statements at hand and the known exhibit and is still a proxy. Nothing we own writes the adversarial statement. The review does.
