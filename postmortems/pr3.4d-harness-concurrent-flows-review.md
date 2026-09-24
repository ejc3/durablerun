# Postmortem: PR3.4d, the replay harness draws concurrent durable calls (PR #75)

PR #75 widened the SDK's replay-equivalence harness to draw durable calls started together, a step named after the attempt, and concurrent flows. Its first version fixed a pass-dependent refusal with a guard held while a replayed step settles. A review of that version found the guard fails an ordinary fan-out on every replay, and eight further findings. The second version withdrew the guard and refused a step name that concurrent flows share, to close a silent swap the harness found. A second review found that refusal fails ordinary programs and can be caught. The pull request now changes tests and documents only: the SDK is main's, the swap and the other gaps are pinned by witnesses, and DESIGN.md states the limitation. The verdict is that the harness found real defects, that both attempted fixes were checks standing for a property the SDK cannot see, and that a pin is the strongest mechanism available until the SDK can see it.

**This document is adversarial toward the MACHINERY and blameless toward people.** It asks what would have made each defect unwritable, or caught it without a human looking.

## Severity

The worst finding is the shared step name swap, which is on main: two flows that each await something and then call a step under one name can be handed each other's value by a replay, and the task completes with nothing to say so. Measured on main, an outage at 3 of 30 store calls for two flows over two spawned children, and at 2 of 11 for two flows over two emitted events. That was found by this project's own harness, and no version of the pull request closes it. Without the reviews, the first version would have shipped a guard that fails every replay of an ordinary fan-out, and the second a refusal that fails poll and heartbeat loops and that a `try` defeats. Each would have turned a task that completes into one that fails for good, on the next replay of a task in flight.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 0 | The engine refuses a call made while a step runs and raises nothing while a step replays, so a group one pass refuses is admitted by another | A task that fails for good completes when an outage takes the failing pass's own fail call | The replay harness | Its grammar drew sequential programs only | The grammar itself, and pinned witnesses (rung 3) |
| 1 | The first guard refuses an ordinary fan-out written as flows on every replay (HIGH) | A task in flight of that shape fails at its next replay | The harness | Every member of a generated group was called before the first await, so no program had two flows | A flow op and three flow programs (rung 3) |
| 2 | The guard covers only calls made in the step's own synchronous run (MEDIUM) | The same program ends two ways by fault point | The harness | Same grammar gap as 1 | Pinned witness (rung 3) |
| 3 | The harness could not see 1 and 2 (MEDIUM) | All 44 tests passed while both reproduced | The harness's own self-tests | They checked that generators draw shapes, not that a shape class exists | The flow programs run at every store call (rung 3) |
| 4 | The known cost in DESIGN.md was narrower than the behavior (MEDIUM to LOW) | A reader would under-estimate the cost | Review of the text | No mechanism reads a Summary against the code | None; the paragraph is removed with the guard |
| 5 | A second false negative in the saga comparison (LOW) | Two runs differing in where the first member rolled back compare equal | The comparison's self-test | It was written for one false negative | The place is asserted (rung 3) |
| 6 | The shape inventory is anchored to the table it checks (LOW) | Deleting a shape fails no self-test | The inventory self-test | It reads the table it is checking | One self-test names every shape (rung 3) |
| 7 | A group member's body never fails (LOW) | The started-and-never-persisted case is not run for a member | The generator | Bodies fail only at top-level ops | Recorded, not built |
| 8 | The same seeds draw different programs (LOW) | A claim in the body was inaccurate | Review of the text | No check compares the stream | The body says so |
| 9 | `owning` stamps a verdict on any throw (LOW) | No false booking today | The verdict helper | It was written for one owner | Stamps only an assertion failure (rung 2) |
| 10 | Two identical `if` statements in the guard (nit) | None | None needed | A registered mutation owned the lines | Removed with the guard |
| 11 | The refusal is an ordinary thrown error, so `try` or `Promise.allSettled` around the flows lets the task complete with swapped values (MEDIUM) | DESIGN.md's "nothing completes silently" was false whenever the program catches; reproduced at calls 5 and 6 of 40 | The harness | It drew no program that catches | A catch program and an allSettled program are pinned as what main does (rung 3) |
| 12 | The refusal fails ordinary programs (MEDIUM): a poll loop beside an await, a heartbeat loop, a step named twice after a sleep started before the first, a saga step named twice | Tasks that complete today fail for good on their next replay | The harness and the SDK suite | They drew only two such programs, and the rule refused what it could not tell from a swap | The withdrawal, and the programs run as ordinary programs (rung 3) |

## Detection ledger

Twelve of the thirteen defects above were found by outside review, and finding 0 was found by this project's own grammar before any review.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The widened grammar (a generated program, red before its fix) | 1 (finding 0) | Yes |
| First review round, a `/code-review` at HIGH | 10 (findings 1 to 10) | No |
| Second review round, a `/code-review` at HIGH with its own probes | 2 (findings 11 and 12) | No |

Self-catch rate: 8 percent, 1 of 13 (previous round: see the sagas review's postmortem in this directory). Both review rounds found what the harness could not draw. The two review rounds are the same detector twice, one per attempted fix, so the number reads: our machinery found the defect, and an outside reader found what each fix broke.

## Recurrence

The first round's HIGH and the second round's two MEDIUM are the same class: a check standing in for a property the SDK cannot see. The property is the identity of the flow a call belongs to. The guard checked that a step was pending, and the refusal checked that another call was pending. Both are proxies: a call made while another is pending is true of a swap and equally of a fan-out, a poll loop and a heartbeat. Neither proxy separates them, and no rule over what the SDK can observe can, because a swap and an ordinary program make the same sequence of durable calls. The class also recurs from earlier postmortems: a syntactic check standing for a semantic property. It did not recur against a mechanism instituted for it in an earlier round, since neither guard existed before. It recurred in both rounds of this pull request, and that is the sentence the reader should take: the second attempt was made against the same missing property as the first, and it needed a second review to show it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes it |
|-----------|------|-----------------------------------------------|
| Pinned endings for the shared step name (children, events, catch, allSettled) | 3, and a proxy | A change of the engine that keeps the table of endings but changes why: the witness sees endings by store call, so a different mechanism with the same table passes. Timing is fixed because every run is seeded and each outage is at a fixed store call, but a machine whose microtask order differs would fail it loudly, not pass. |
| Pinned witnesses of the sibling-flow refusal and the refused groups (call lists) | 3 | A program of the same class with different shape (three flows, a saga) has no witness, and the harness draws none. |
| The flow op and its programs | 3 | Two concurrent `awaitEvent('x')` or `sleepFor` calls are numbered by arrival order too, and no program draws them. Not constructed. |
| The programs of one flow that run as ordinary programs | 3 | A shape of poll or heartbeat not in the three programs. |
| `owning` stamps only an assertion failure | 2 | A verdict-owning test that fails by another route reports as itself, which is intended. |
| Two registered mutations (the start marker and the attempt ordinal) | 3 | A mutation of another line of the same function. |

## Fix-induced defects

Three of the thirteen findings were caused by a fix for an earlier finding in this pull request: finding 1 by the guard that fixed finding 0, and findings 11 and 12 by the refusal that fixed the swap. Neither fix was re-reviewed as new code before its review round: each was re-tested only. The fold that ends this document changes no behavior, since the SDK diff against main is empty, and is not re-reviewed.

## Evidence

- Red test: commit `23c76da`, which makes both generators draw the refused groups, run and seen failing (four tests) against the SDK as it was. Fix: commit `ac97270`, the guard, later withdrawn.
- Red test: commit `4cfd9f6`, three flow programs committed failing by name against the guard. Fix: commit `89ee054`, which withdraws the guard and pins the programs as witnesses.
- Red test: commit `f6b5041`, two programs of flows that share a step name, run and seen failing by name against the SDK as it was, with the values swapped at calls 5, 8 and 21 of 30 and 6 and 8 of 11. Fix: commit `994ffea`, the refusal, withdrawn by commit `e8f4bf0`, which pins the same programs as witnesses that fail by name when the refusal is put back, run and seen failing (seven tests).
- Finder: the first review round, quoted verdict: "One HIGH finding: do not merge PR3.4d as it stands. The replayed-step guard makes an ordinary fan-out task fail for good on a clean run. The same task completes on main."
- Finder: the second review round, quoted verdict: two MEDIUM, both reproduced. The refusal is an ordinary thrown error, so flows that catch it complete with swapped values, at calls 5 and 6 of 40; and the false refusals go beyond the two named, to a poll loop beside an await, a heartbeat loop, and a step named twice after a sleep started before the first.
- Claims that did not reproduce: two narrower rules, counting only calls from an earlier microtask turn, and refusing a repeated name only when the call itself is beside another, were measured over the same programs and rejected. The first completes both swap programs at the last store call. The second fails a poll loop at 6 of 8 store calls and completes it at 2.
- The maintainer's decision, 2026-09-23: nothing that completes today may start failing, so the swap is a documented, pinned limitation and a flow identity in the SDK is the option that would close it.
