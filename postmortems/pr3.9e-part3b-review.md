# Postmortem: PR3.9e part 3b, deleting the text path (PR #52)

PR #52 deletes `FencedBatch`'s text path, requires the dialect that compiles a
tree, builds the failure successors' deadline from nodes, and restored a reader
of a value fragment's text for a function call. One review pass over
`69be7f9..7caf7ea` found seven things, two of them MEDIUM and reproduced. The
worst is that the restored reader accepted a schema-qualified call. Nothing
shipped is broken, because no shipped follow-on insert selects a fragment. Our
own machinery found none of the seven.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Without the review, a rule documented as "refused, whatever the function is"
would have merged while accepting `pg_catalog.max(f.x)`. On PostgreSQL an
aggregate returns a row even when the fence matched nothing, so a follow-on
insert that selected it would write a row for a batch that lost. The exposure
was latent: the first store statement to pass a value fragment there would
have met a rule that looked closed and was not.

The second MEDIUM is a gate that could not fail. Two new controls in the
package smoke were meant to show that the published-surface check refuses a bad
withdrawal. They failed for another reason whatever the check did, so deleting
a refusal would have left smoke green, and the `withdrawn` table could then
excuse any published name.

The third finding is a worse error message and an unstated break: untyped code
that built a batch without its dialect got a read of undefined with no batch
label, and alpha consumers lose five `FencedBatch` methods that the surface
check cannot see. The other four are documents and comments that named deleted
code or gave a wrong count.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `fragmentCalls` read a name before a parenthesis and skipped a name that follows a dot, so `pg_catalog.max(f.x)` in a value fragment of a follow-on insert was accepted | On PostgreSQL the aggregate returns a row the fence did not match, and a losing batch would insert it. Latent: no shipped follow-on insert selects a fragment | The reader's four per-condition mutations and its test | A mutation removes a condition the author thought of. None adds a spelling the author did not think of. The reader was a list of name shapes | A raw node in a follow-on insert's SELECT list is refused whatever it holds, so nothing reads text there. Rung 1 for that list |
| 2 | The two new withdrawal controls in `package-smoke.sh` replaced the whole `withdrawn` table, so the checker exited 1 for the four real names it then missed, and only the exit code was read. A third control the comment promised was never run | Someone deletes a refusal from `package-surface.mjs`, smoke stays green, and the table can excuse any name | The controls themselves | Nobody deleted a refusal to watch a control go red. A control that is red for any reason looks like a control that works | One helper builds additive controls and reads the refusal, which must be the only problem reported. Each new control was seen red with its refusal deleted. Rung 2 |
| 3 | The required dialect was a type-only rule. Untyped code constructed a batch without it and the first `casTree` threw `Cannot read properties of undefined (reading 'compile')`. The surface check also cannot see that `FencedBatch` lost five methods | A construction error with no batch label or statement name. Alpha consumers lose `cas`, `casMany`, `followOn`, `tail`, and `openTail` with nothing recording it | The substitution step of the ratchet | The runtime refusal was deleted as redundant with the type, and it is redundant only for typed callers. The surface check reads export names | A constructor refusal that names the batch, with a test from untyped code seen red without it. Rung 3, beside the rung 1 type. BUILD.md and the PR body state the lost methods |
| 4 | Three review-bot rule files still named a deleted registry entry, deleted store text, deleted scanners, and `FENCE_SET`, one of them in a line two bot configs mirror | A review bot is told to protect things that no longer exist | Nothing | No checker reads a rule file's identifiers against the tree. `review-bot-lint` says it does not judge the rules | None built. Corrected by reading, as a class, across the three files and the two configs. No rung |
| 5 | A registry comment said the node-built ceiling mutant survives if the ceiling moves. That holds only for a move down | A reader trusts the audit to flag a ceiling that moved up, and it would not | Reading | Nothing runs a comment | None. Corrected |
| 6 | BUILD.md counted twenty-eight deleted tests where twenty-seven were deleted and one renamed, and a comment in `sql-tree.ts` still compared a rule with the text path | The plan disagreed with the PR body | Reading | The count was typed from a list that held the rename | None. Corrected |
| 7 | `PreservedFenceTable` lost its only reader with `fenceSetAt` and stayed exported with nothing saying why | A published type nobody in the repository names | Nothing | The surface check holds names that leave, and asks nothing of a name nobody uses | None. It stays, as the key type of a published constant, and its comment says so |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| One Fable `/code-review` and `/simplify` run over `69be7f9..7caf7ea`, which reproduced findings 1, 2, and 3 with scripts outside the worktree | 7 | no |

Self-catch rate: 0 of 7, or 0% (previous round on this work, PR3.9e part 3a's: 4 of 16, or 25%).

It fell to nothing. Before review, this PR's own final gates did catch three
defects of the branch, which is the system working and is not counted here: a
conformance test that found the retry deadline by its old compiled text, a
bridge arm whose generated mutant did not parse under the base registry's
self-test, and the base gate's copy of the surface snapshot reporting the four
withdrawn names. All three were gates already in place failing loudly. None of
the seven review findings trips any gate. Two of them are gates that were green
and proved nothing, which is the worst kind, and the machinery has no check
that a new control can fail.

## Recurrence

**One spelling standing for the operation** (finding 1). AGENTS.md names it:
"Every clock and counter lint matched one SPELLING; the property is the
operation." Part 3a's round recorded the same class and answered it in two
halves. For function nodes it closed the grammar, which is the property. For
fragment text it kept a spelling list and wrote down that "the boundary is
text". This PR then wrote a new reader of fragment text, on the text side of
that boundary, and gave each of its conditions a mutation. The mutations
checked that each listed shape is refused. The property is that no call is
accepted, and a list of shapes cannot hold it. The structural refusal ends the
class in this position because it removes the reader: a fragment in that SELECT
list is refused without being read, so there is no spelling left to miss. It
does not end the class elsewhere. The clock scan of fragment text is still a
list.

**One failing case treated as proof** (finding 2). AGENTS.md names this too: "A
mechanism with one failing case was treated as proven; the property is that it
fails for EVERY condition it claims." Here the controls had one failing case
and it was the wrong one. Earlier rounds answered this class with witnessed
deletions, and part 3a made deletion automatic for the tree rules. Neither
reaches a shell script's control. The fold answers it the old way, by deleting
each refusal once by hand, and the commit message records the command. That
protects these three controls and no future one.

**A lower rung deleted as redundant when it was not** (finding 3). The ratchet
rule says a stronger guarantee deletes the checks it makes redundant. The type
made the runtime refusal redundant for every caller the compiler sees. This is
the first time this class is recorded, so it is not a recurrence.

Findings 4 to 7 are documents and comments. Part 3a's round had two of the same
kind, a name that overstated a replacement and a plan that undercounted, both
filed under reading with no mechanism. They recurred, and they will again.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A raw node in a follow-on insert's SELECT list is refused | 1 for that list | None found for the list. Run against the rule: an aggregate inside a subquery built from nodes is refused by the same rule, and a CASE built from nodes is accepted and adds no row. The boundary is the grammar's list of node kinds: a node kind added there that can aggregate would pass. Outside the list the documented residual stands: a join whose ON is store text can tie the fenced row to every row of the joined table, and the rule cannot read that text |
| Additive surface controls that read the refusal | 2 | Narrow the still-exported refusal to `includes(name) && name.startsWith('F')`. The control withdraws `FencedBatch`, so it is still refused, and the package smoke exits 0. A withdrawal of any still-exported name that does not start with F would then be accepted. A control holds one shape |
| The constructor refuses a missing dialect | 3, beside a rung 1 type | `new FencedBatch('b', 'seed', { now: '0', tree: { compile: () => undefined } })` from untyped code constructs, and `casTree` then throws `TypeError: Cannot read properties of undefined (reading 'fences')`. The refusal asks for a compile method, and any object with one passes |
| Documents and comments corrected by reading | none | Any rule file, comment, or plan sentence that names a deleted identifier passes every gate today. The four stale names the review found were each present while `pnpm verify` was green |

## Fix-induced defects

None of the seven was caused by a fix in this round. One fix changed which rule
answers a shape: a literal stamp, `sql.lit('s')`, is a raw node, so the new
refusal now answers it before the stamp rule does. The core suite failed on
that row at once, and the row now shows both rules. The fold was re-tested and
not re-reviewed, as one review round was the budget for this PR.

## Evidence

- Red tests: commit `0b53901`, run and seen failing (1 test) against `7d08d8c`'s code: "reads a value fragment for a function call, as it reads nodes for one" accepted `pg_catalog.max(f.task_id)`.
- Fixes: commit `978cc94` for finding 1, `8fc7768` for finding 2, `409b18b` for finding 3, and `8325425` for findings 4 to 7. Gate after the fixes: the registry self-test, typecheck, lint, the core suite, the corpus test, the package smoke, the base gate, and a filtered mutation run over the tree rules, recorded with exit codes in the PR body.
- Finding 2's controls were seen red: with each refusal in `scripts/package-surface.mjs` replaced by `if (false) {`, `bash scripts/package-smoke.sh` exits 1 with "package-surface accepted a withdrawal of a name that is still exported", "of a name the release never exported", and "with no reason". Finding 3's test was seen red with the refusal removed: "expected [Function] to throw an error".
- Finder: one Fable `/code-review` and `/simplify` run, quoted verdict: "Two MEDIUM findings, both reproduced: `fragmentCalls` accepts a schema-qualified call, and the two new withdrawal controls in `package-smoke.sh` cannot fail. There is no HIGH finding and nothing shipped is broken."
- Claims that did not reproduce. The review asked five questions and answered "no finding" to each: lost checks beyond finding 3, the withdrawal mechanism hiding a removal, behaviour of the deadline commit, the scoping of the bridge, and the two plan documents beyond findings 1 and 6. One simplify candidate did not hold up as behaviour-preserving when read against the corpus: feeding the sweep's headroom guard from one numeric constant changes the compiled guard from `(5 * 1000)` to `(5000)`, which the corpus records and two registered finds quote. It is declined in the PR body.

## Root cause

The PR's new checks were each proven against the cases their author wrote, and
nothing asks of a new check what it does with a case the author did not write.
The reader was tested with the spellings in its own pattern. The controls were
run and seen to exit 1, and nobody asked why they exited 1. The type was tested
with a typed caller. In each, the check and its proof came from one head at one
moment, so they share a blind spot by construction. Part 3a's derived coverage
check holds that every condition has a mutation. It cannot hold that the
conditions are the right ones, and it does not look at shell scripts at all.

## Mechanisms

Built in this PR:

- A follow-on insert's SELECT list refuses a raw node, so no text is read there. Rung 1 for that list. It lives in `followOnInsertProvenance` in `packages/core/src/sql-tree.ts`, held by `tree-followon-insert-no-fragment`.
- `surface_refuses` in `scripts/package-smoke.sh`: additive controls that read the refusal. Rung 2.
- The constructor's refusal of a missing dialect, in `packages/core/src/fenced-batch.ts`. Rung 3, beside the type.

Deferred (recorded in BUILD.md):

- None. A check that a new gate control can fail, and a check of rule files against the tree, would each be new machinery with no milestone evidence behind it, so neither is scheduled. The residual below says what that leaves.

## What this round still would not catch

- A new control in a gate script that is red for the wrong reason would ship today. Nothing deletes the refusal a control claims to hold. The three controls of this PR were checked by hand, once.
- A surface control holds one shape, so a refusal narrowed to that shape passes, as the audit shows.
- A reader of fragment text anywhere else is still a list. The clock scan of fragment text accepts `age(column)` on PostgreSQL, as part 3a recorded, and this round did not change it.
- A fake dialect, an object with a `compile` method, passes the constructor and fails later without a label.
- A rule file, a comment, or a plan sentence that names something deleted passes every gate. Findings 4 to 7 were found by reading, and the next ones will be.
- The surface check reads export names. A published class that loses a method, or a function whose signature changes, passes it.
