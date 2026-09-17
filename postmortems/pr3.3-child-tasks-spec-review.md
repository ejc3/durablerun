# Postmortem: PR3.3 child-task spec, review round 1 (PR #42)

PR3.3 is child tasks, and this PR is its TLA+ model and nothing else: `specs/ChildTasks.tla`, its configurations and probes, its place in the TLA gate, and the DESIGN.md text it proves. No SQL exists yet, so nothing shipped wrong. Two Fable review runs over the first version found seven defects in what the model and the text claimed. Four more were ours: one caught by CI on the first push, one by the mutant check this round built, and two by writing and running this document's false-negative exhibits. All eleven are fixed or recorded as obligations on the implementation.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

No SQL is built on the model yet. The cost of each defect is what the implementation PR would have inherited.

- **A rule that leaves no await that works.** DESIGN.md keeps Absurd's rule that a same-queue await is refused. Events are keyed by queue, so a child in another queue writes its completion event where the parent's wait row is not, and the parent sleeps forever. The first version said TLC had checked "the child in another queue". That configuration explored the same states as the same-queue one, because nothing but the rule read the queue constant. The implementation would have been built on a case that was never modeled and cannot be delivered.
- **A stranded waiter on PostgreSQL only.** The model's actions are atomic and mutually exclusive. On PostgreSQL only the event lock makes a terminal batch and an await so, and only `emit-event` and `await-event` take it today. Nothing in the first version said that every terminal batch must take it. Without it a parent reads no event, the child inserts the event and sees no wait row, and the parent sleeps forever, while TLC and the SQLite suite both pass.
- **A refusing rule that nothing made refuse.** SQL that checks the same-queue rule on the register path only would let a refused await return an outcome, with the model green.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `ChildTasksCrossQueue.cfg` explored the same states as `ChildTasks.cfg`, and the text cited it as a check of a child in another queue. Events are keyed by queue, so that await cannot be delivered at all | The implementation is told a case was verified that was never modeled, and the kept rule permits only that case | The configuration itself, as a TLC run | A configuration that varies a constant proves something only if an action reads the constant. Nothing compares two configurations' state graphs, and both reported 47 states in the PR's own evidence | The two constants are one, `AwaitAllowed`, which three actions read and an invariant holds. The configuration is deleted. The header and DESIGN.md scope the protocol to one queue and say an await across queues needs a delivery protocol that does not exist (rung 1: the unread constant no longer exists) |
| 2 | No invariant said that the refusing rule refuses. Deleting the rule's guard from the register action, or from the hit action, left both configurations green | SQL that enforces the rule on one path only passes the model | The model's invariants | `RefusalIsTheRule` restated the refused action's own guard, so it could not fail when another action ignored the rule. The probes show that an invariant can fail, never that a guard is held | `RefusedNeverWaits`, and a mutant check in the TLA gate: every listed guard, bent or deleted, must fail some configuration (rung 2) |
| 3 | Neither the text nor the model's header said that every terminal batch takes the dialect's event lock | A lost wakeup on PostgreSQL that TLC and the SQLite suite both pass | DESIGN.md §3.4 rule 2, applied to the new batches | The rule is prose, and the model's atomic actions assume it silently | The obligation is written into DESIGN.md and the spec header, and BUILD.md gives the implementation one conformance case per terminal batch, on both dialects (rung 3, owed by the implementation) |
| 4 | DESIGN.md described the reserved name's protection wrongly: it said the store's `emitEvent` port refuses a `$` name, which it does not, and that the HTTP route passes raw names, which it does not. It also called the child await the ordinary `awaitEvent`, which refuses the reserved name | The implementation reads a requirement as done, and plans an await the SDK would reject | The text, checked against the code it describes | Nothing checks DESIGN.md's statements about today's code | The paragraph now states requirements: the port must refuse the name, and the child await uses an internal path (no mechanism yet beyond the text, and said so below) |
| 5 | The text said a second-step emit "would let a crash strand every waiter, which the model shows". The shipped probe showed a transient safety violation, and the model has no crash | An overclaim in the document the implementation is mapped onto | A probe for the claim | No probe checked a temporal property, and the probe loop could only recognise an invariant's violation | `ChildTasksProbeStrandedWaiter`: with the emit as a second step, `EveryWaitResolves` fails under the fair specification. The probe loop recognises a property's violation as well as an invariant's (rung 2) |
| 6 | The header called the parent's await unchanged while the model left out its timeout, its successor, and the dedicated placement | The timeout branch of the child await has no model, and the omissions are not stated | The header's own scope list, as Scheduler.tla keeps one | It had none | The timed await is modeled. The successor, the dedicated placement, a second await, several waiters, and await cycles are listed as not modeled, each with what bounds it |
| 7 | Nothing said that the completion event must outlive every await of it. The planned event cleanup protects only rows with delivered waits | A late await registers a wait that nothing will wake | The model's assumptions, stated | No action removes an event, and the assumption was silent | DESIGN.md and the header state the constraint, and BUILD.md records it against event cleanup (text, owed by that work) |
| 8 | The first push ran the probes on every scope, so the gate's test under a stub checker read each stubbed success as a vacuous probe | A red verify job | `tla-artifact.test.ts`, which did catch it, in CI | It was not run locally, on the reasoning that no TypeScript had changed | The probes sit after the `TLA_ONLY` branch. A changed script means its tests are run (caught by existing machinery) |
| 9 | In the rework's timed await, an emit that wakes a parent whose wait already timed out passed every invariant | The model would accept SQL that wakes a run after its await timed out | The invariants over the new action | They speak of outcomes, and the woken parent resolves with the right outcome | First `TimeoutIsFinal`, then `AnswerIsFinal` (finding 11), held by a mutant (rung 2) |
| 10 | A timeout that takes a parent the emit already woke passed every invariant: the wake is lost and the parked outcome is never returned | The model would accept a claim that times out a run the emit already woke | The mutant list | The guard had no entry, and no invariant spoke for it | `WakeIsDelivered`, held by a mutant (rung 2) |
| 11 | An emit that wakes a cancelled parent passed the allowed configuration. The refusing configuration caught it only by accident | The model would accept a wake of a cancelled run | `TimeoutIsFinal`, which spoke for one of an await's four answers | It was written for the instance that had just been found | `AnswerIsFinal` replaces it: an outcome, a timeout, a refusal, and a cancellation are each final. The mutant is confined to the allowed configuration so the accident cannot hide it (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Two Fable `/code-review` and `/simplify` runs over `fce5078...c72671c` | 7 | no |
| CI's verify job, `tla-artifact.test.ts` under the stub checker | 1 | yes |
| The mutant check, run on the rework before it was pushed | 1 | yes |
| Writing and running this document's false-negative exhibits | 2 | yes |

Self-catch rate: 4 of 11. The rounds before were 4 of 10, 0 of 1, 2 of 6, 1 of 7, and 2 of 13. The number that matters more is what kind of defect each side found. Review found every defect in what the model CLAIMED: a configuration that proved nothing, a missing invariant, an unstated lock, a wrong description of today's code. Our machinery found defects only after review had shown it how, by deleting guards. Both reviewers ran mutants by hand, 20 and 30 of them, and that practice is now a gate for this model. Nothing we own checks the text against the code, and four of review's seven findings were there.

## Recurrence

Finding 2 is a recurrence, and AGENTS.md already names the class: a mechanism with one failing case was treated as proven, where the property is that it fails for every condition it claims. The wake surface once kept two deletable conditions under 1728 green cases. The mechanism since then has been a practice, witnessed deletions run by hand in each PR, and the last four PRs ran them over TypeScript rules. This PR's author ran none over the model, because the practice lives in the habit of writing TypeScript tests and the model was checked with probes, which are single failing cases. A practice does not transfer to a new kind of artifact. For this model it is now a gate. PR3.10 still owns the general form.

Findings 9, 10, and 11 are the same class one level down: each property was written for the instance just found. `TimeoutIsFinal` held the timeout and not the other three answers, and it took an exhibit to show that. The mutant list has the same shape, and the audit below says so.

Finding 1 belongs to the class the vacuity probes exist for, a green signal that checked nothing. The probes guard invariants and behaviours. Nothing guards a configuration.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The mutant check over `ChildTasks.mutants.json` | 2 | A guard with no entry. Run: deleting `parent = "running"` from `SpawnChild`, so that a cancelled or resolved parent can spawn, passes both configurations, and the mutant check passes because the list does not name that guard. The list is hand-kept. Two more unlisted guards pass when widened, a terminal child ending again and a completed child being revived, and both belong to Scheduler.tla, which proves the task's own lifecycle |
| `RefusedNeverWaits` | 2 | A refusal with a side effect the invariant does not name. Run: a refused await that also consumes one of the child's revivals passes both configurations. The invariant speaks of the wait row, the parent's state, and the outcome, which is what "registers nothing" means for the event protocol, and not of every variable |
| `AnswerIsFinal` and `WakeIsDelivered` | 2 | A stray write that leaves the parent's state alone. Run: an emit that parks its outcome on a cancelled parent's run passes both configurations, because the properties speak of `parent` and `ParkedMatchesEvent` is satisfied by a parked value that matches the event. The model has no invariant over `parked` for a parent that is not woken |
| The probe families, each probe named after its cfg | 2 | A probe witnessed by a different cause than the one it is named for. Run: `ChildTasksProbeStrandedWaiter.cfg` with the emit made ATOMIC, against a model whose register action ignores an existing event, still exits 13 and reads as witnessed. A probe shows that its property can fail under its configuration, and not why |

## Fix-induced defects

Two of eleven. Findings 9 and 10 are defects of the timed await, which the rework added to answer finding 6. Both were caught before the rework was pushed, one by the mutant check the same rework added and one by an exhibit for this document. Finding 11 was in the first version too.

One more in the process. The commit that introduced `AnswerIsFinal` did not parse: after `[`, the parser reads `parent \in S` as the start of a function constructor. The mutant check reported every mutant as a checker error, exit 150, and refused to count any as caught, which is what it is for. The inline shell guard around the commit did not stop on that, the commit was made, and it was amended before anything was pushed. Verify-then-commit sequences now run as `bash` scripts with `set -euo pipefail`.

## Evidence

- Review artifacts: two Fable subagents, each invoking the built-in `/code-review` and `/simplify` skills over `fce5078...c72671c` in the PR's worktree, with TLC runs of their own on scratch copies. The first reported "Ten findings survive verification" and "`ChildTasks.cfg` and `ChildTasksCrossQueue.cfg` both report 67 states generated and 47 distinct." The second, time-boxed, reported "Both hand-listed mutations that stay green bypass the refusing rule", "Every other mutation I ran turns TLC red, and I found no way for `scripts/tla.sh` to pass when it should fail", and "I ran 30 TLC jobs on scratch copies."
- Quoted findings: "SameQueue is read only by AwaitAllowed, so this cfg explores the identical state graph as ChildTasks.cfg", "Only emit-event and await-event call lockEvent today (store-postgres store.ts:1849 and 2045)", "`RefusalIsTheRule` restates `AwaitRefused`'s own guard, so it cannot catch this", and "The only HTTP emit route, packages/driver/src/hosted.ts:255, already calls UserName.parse".
- Checked against the code before folding: `lockEvent` has two callers in the PostgreSQL store, the hosted route parses the name at `hosted.ts:255`, the SDK parses it in `context.ts`, the store's `emitEvent` checks only the payload, and the events table's key is `(queue, event_name)`.
- Finding 2. Red: commit `2da5907`, the mutant check over the first version, 10 of 12 caught, with `miss-ignores-rule` and `hit-ignores-rule` surviving. Green: commit `31db220`, 12 of 12.
- Finding 9. Red: commit `4caa251`, 13 of 14 caught, with `emit-wakes-a-timed-out-parent` surviving. Green: commit `31c1e6c`.
- Finding 10. Red: commit `80fd1dd`, 14 of 15. Green: commit `3f6b4cd`.
- Finding 11. Red: commit `3d3436c`, 15 of 16. Green: commit `ab50e00`, 16 of 16.
- Finding 5: `ChildTasksProbeStrandedWaiter` exits 13 on `EveryWaitResolves`, 118 states. A probe is its own red, because the gate requires it to fail.
- Finding 1: both configurations reported 47 distinct states in the first version's own evidence.
- The instrument's control: `tla-artifact.test.ts` runs the gate under a stub checker that passes every model, and requires every mutant to be reported as a survivor and the gate to fail.
- Final state: both configurations are clean at 55 and 26 states, seven probes are witnessed, and sixteen mutants are caught.

## Root cause

The model was checked the way its author checks a model, with invariants and a probe for each, and its configurations were written by varying constants. Neither step asks whether the thing varied or guarded is connected to anything. A probe proves an invariant can fail. It says nothing about a guard no invariant mentions, or a constant no action reads, and those were findings 1 and 2. The text was then written outward from the model, and what it said about today's code, the lock, the route, and the port, was never read against that code.

## Mechanisms

- **Built now**
  - A mutant check for this model in `scripts/tla.sh`, fed by `specs/ChildTasks.mutants.json`, with a test that proves it fails when mutants survive.
  - `RefusedNeverWaits`, `AnswerIsFinal`, and `WakeIsDelivered`, each held by a mutant.
  - One constant for the rule in place of two, and the configuration that proved nothing deleted.
  - A liveness probe, and one probe loop for both families that enrolls a cfg by its existing.
  - The header's obligations on the SQL and its list of what is not modeled.
- **Recorded in BUILD.md for the implementation**
  - One conformance case per terminal batch, six of them, on both dialects: the batch writes the completion event and wakes a registered waiter. This is the executable form of the ledger block, which no checker reads, and of the lock obligation.
  - Event cleanup must not remove a completion event whose task can still be awaited.

## What this round still would not catch

- A guard of the model with no entry in the mutant list. The list is hand-kept, and PR3.10 owns generating it.
- A configuration or a constant that nothing reads. Nothing compares the state graphs of two configurations.
- Any statement DESIGN.md makes about today's code. Four of review's seven findings were of this kind, and the only check is a reader who opens the file.
- The obligations the header puts on the SQL, until the implementation's conformance cases exist: the event lock, the reserved name at the port, and the event's lifetime.
- A wake delivered across queues. No protocol for it exists, and the model says so.
