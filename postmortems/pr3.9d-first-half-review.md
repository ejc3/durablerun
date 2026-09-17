# Postmortem: PR3.9d first half, review round 1 (PR #40)

PR3.9d's first half moves fail, the cancel transition, retry-task's revival, and set-checkpoint's lease onto shared statement trees. One Fable `/code-review` round found the four moved statements equal to the SQL they replace in both dialects, and found the defects around them: a lint this PR widened further than it said, a corpus scenario that asserted nothing, two lists of live states with nothing holding them together, and a revival whose failed-state check a store could leave out. Turning the second of those into assertions then caught a defect of our own: the scenario had been failing the wrong task. Our base-gate reproduction caught a sixth before CI ran. All six are fixed, and nothing wrote a wrong row.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

No shipped statement was wrong. The severity is in the gates, because each of these would have let a later defect through green.

- **A lint that stopped guarding reads (worst).** The task outcome lint exists so that one decoder reads a task's outcome. This PR let core's shared statements name `failure_reason`, and did it by exempting every file in the statements directory. A file there that parsed `row.failure_reason`, selected the column, or held SQL reading both outcome columns passed the lint. The PR body said reading an outcome still went through `decodeTaskResult` alone, and the lint did not enforce that.
- **A corpus that records a statement whether or not it did anything.** The corpus scenario asserted nothing, and a compare-and-set that matches no row still compiles. A lost revival or cancel would have produced the same green corpus. The scenario was in fact wrong: the claim after the emit took the waiter the emit had woken, so the task meant to fail twice never failed, and another task's failures were recorded under its name. The recorded statements were the right ones, by luck of the labels being per statement and not per task.
- **Two lists of one fact.** The cancel compare-and-set checks the live state with core's list, as nodes, and the follow-ons of the same batch read each store's text list. A state added to one list only would cancel a task whose live run the follow-on skips.
- **A revival that trusted the store for its own precondition.** `reviveCas` raised a task's budget with no failed-state check of its own. The check was store text inside the admission fragment. The PR body declared that, on the belief that the registered mutation owning the text could not move to core.
- **Caught by our gates before CI.** Main's outcome lint rejected this tree in the local base-gate reproduction, because main's lint predates the allowance. CI's base-gate would have failed the same way.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The outcome lint's new allowance exempted whole files in core's statements directory | A second decoder of a task's outcome lands green in that directory | The lint's self-test | Its new inputs covered only paths outside the directory. None read an outcome inside it | A statement or the descriptor may name an outcome column only as an object key. A property read, a selected column, and SQL text are refused there, with a self-test input for each (rung 2) |
| 2 | The corpus scenario asserted no step's outcome, and named a label's variants by the order it reached them | A compare-and-set that loses still records its label, and swapping two calls swaps the variants' names | The corpus test | It compared compiled text and nothing else | Each step that can lose silently asserts that it won, the claims assert which task they took, and a label with two variants names each by what its batch holds (rung 3) |
| 3 | The scenario failed the wrong task: the claim after the emit took the woken waiter | The `fail` variants were recorded from another task's failures | The corpus test | Finding 2: nothing asserted which run a claim returned | The scenario finishes the waiter first and asserts every identity. Found by finding 2's assertions on their first run (rung 3) |
| 4 | The cancel statement's live states are core's list as nodes, beside follow-ons that read each store's text list | A state added to one list cancels a task whose live run the follow-on skips | None existed | The corpus pins only the arity of `in (?, ?, ?)` | A test in each store holds its text list to core's list (rung 3) |
| 5 | `reviveCas` had no failed-state check of its own | A store that leaves the check out revives a task that never failed, and raises its budget | PR3.9c's mechanism for this class, the claim's identity as nodes | It was not applied, on the belief that a registered mutation cannot move from a store to core. The registry already mutates core files | The failed state is a node in `reviveCas`, its mutation moved to core with it, and the bridge gained `reaim_moved` for an entry whose file moved (rung 1 for that conjunct) |
| 6 | Main's outcome lint rejected this tree | CI's base-gate fails | The local base-gate reproduction | It could, and did, before CI ran | A base-gate bridge step for the lint, pinned to one base file and one head file by hash (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The local base-gate reproduction, before the PR opened | 1 | yes |
| The corpus scenario's new assertions, on their first run | 1 | yes |
| Fable `/code-review` round 1 over `2506d6d...9f9c529` | 4 | no |

Self-catch rate: 2 of 6, or 33%. PR3.9c's was 1 of 7 and PR3.9b's 2 of 13. The rise is real and small, and both self-catches share a cause worth naming: each came from running a real instrument end to end instead of reasoning about it. The base-gate reproduction is main's own checkers run on this tree, and the scenario assertions are the scenario run with its claims checked. Neither is a new checker. The four review findings are all places where no instrument ran at all.

## Recurrence

One of the six is a class an earlier round already met.

- **Finding 5 is PR3.9c's finding 5 again.** That round found the await-event registration taking its whole claim check as one opaque fragment, and the mechanism was to build the identity from nodes and leave the store only what a mutation owns. This PR's revival kept its failed-state check as store text, and the PR body declared it, reasoning that the mutation owning the text could not move. That reasoning was never tested. The registry has mutated core files since before this work began. So the mechanism did not fail. It was set aside on an unverified belief, which is the cheaper failure to repeat. The repair includes the piece that was believed missing: `reaim_moved` bridges an entry whose mutated file changed.

Findings 1 to 4 are not recurrences of a fixed class. Finding 1 is a new instance of the oldest pattern here, a proxy where the property fits: a directory stood in for "a statement that assigns this column".

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| An outcome column only as an object key | 2 | An object key that is not an assignment. Run: a statements file holding `({ failure_reason: row.reason })` passes the lint at exit 0, and the control, `row.failure_reason` in the same file, is refused at exit 1. The lint knows a key from a read. It does not know a `.set()` from any other object |
| The failed state as a node | 1 for that conjunct | The guard beside it. Run: the committed test passes `admission: 1 = 1` and the statement is accepted, so a store can still omit the well-formed-failure guard. That guard names `completed_payload`, which no statement names, and its registered mutation and the corpus hold the shipped text |
| A test holding each store's live list to core's | 3 | A third copy. Run: each store's `schema.ts` spells the same three states in an index predicate, which the test does not read. A state added to core and to `fragments.ts` leaves that index behind |
| Asserted corpus steps | 3 | A step whose port returns nothing. `emitEvent`, `deferLaunch`, `reschedule`, and `suspendRun` throw on refusal and are asserted no further, so a first emit that lost to an earlier event would still record its label. This is a reading of the test, not a run |
| `reaim_moved` | 2 | It refuses a rename and allows any new file. An entry moved to a file where its find matches by accident would pass the bridge, and the head registry's own self-test is what catches a wrong target. Not run, because running it means fabricating a registry |
| The pinned pair for the lint bridge | 2 | None for the pair: any other base skips and any other head refuses. It does not constrain what the pinned head lint allows, which is finding 1's subject |

## Fix-induced defects

None found. The fix for finding 5 broke one registered find, `retry-task-requires-well-formed-failure`, whose text lost its leading AND when the line above it became a node. The mutation self-test caught it on the next run, before any commit, and the fragment's conjuncts were reordered so the find survives verbatim.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `2506d6d...9f9c529`, run locally in the PR's worktree. Its verdict: "Neither found a correctness bug in the four moved statements", and for parity, "Every guard, SET column, and bind order is preserved for all four statements in both dialects."
- Quoted findings:
  - "The allowance `relative.parent == STATEMENTS` exempts every file directly under `statements/`, for reads as well as writes";
  - "The new scenario steps assert nothing, and the recorder captures a signature even when the compare-and-set matches no rows";
  - "The cancel compare-and-set binds core's `LIVE_STATES`, while the same batch's follow-ons still read each store's text `LIVE`, and no test ties the two together";
  - "The registry already mutates core files (`fenced-batch.ts`), so 'a node copy in core would mask them' is avoidable".
- Red test: commit `6434c91`, run and seen failing against `47155fc`. The lint self-test reported "ACCEPTED a bad input" for all three new inputs, and the revival test failed because the compiled statement had no state check.
- Fix: commit `ba65458`. At that tree core, the corpus test, the schema descriptor test, both stores' live-state tests, and 830 retry-task and cancel conformance cases pass, with typecheck and every lint at exit 0. Filtered mutation runs at `305d04a` caught 8 of 8 for `retry-task`, the moved mutation among them, and 14 of 14 for `cancel`.
- Finding 3 was seen red on the way: the first run of the new assertions failed with the claimed task's id differing from the spawned one, in both dialects. The corpus files are byte for byte the same before and after the scenario fix.
- Finding 6: the local base-gate reproduction exited 1 with main's outcome lint naming five lines, and exits 0 with the bridge step applied.

## Root cause

The PR changed two gates, the outcome lint and the corpus scenario, and tested each change only in the direction it was meant to open. The lint's new inputs proved the allowance admitted what it should. The scenario's new steps proved the labels compiled. Nothing asked what else the wider gate now admits, and that question is the whole job of a gate's self-test.

## Mechanisms

- **Built now**
  - The outcome lint admits an outcome column in a shared statement only as an object key, with a refused self-test input for a property read, a selected column, and SQL text.
  - `reviveCas` requires the failed state as a node. `reaim_moved` lets the bridge follow a mutation from a store into core.
  - The corpus scenario asserts which task each claim took and that each silent loser won, and names variants by content.
  - A test in each store holds its text list of live states to core's list.
  - The lint bridge is one pinned pair of files, so a later lint edit must re-pin it in the same change.
- **Deferred, recorded in BUILD.md**
  - The checker bridges and dead registry arms become one table of pinned file pairs in PR3.9e.
  - The measured per-call cost of rebuilding a tree statement joins PR3.9e's one-pass item.
  - PR3.12 owns a race between concurrent PostgreSQL migrators, which failed this PR's first CI run on code it does not touch.

## What this round still would not catch

- An object in a shared statement that carries an outcome column somewhere other than a `.set()`.
- A third spelling of the live states, such as the index predicates in each store's schema.
- A corpus step that loses without throwing and returns nothing.
- A store fragment that is present and guards nothing. The registered mutations and the corpus hold the shipped spellings.
