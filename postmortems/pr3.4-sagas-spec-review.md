# Postmortem: the sagas spec, its review round (PR #47)

PR #47 is `specs/Sagas.tla`, the rolling-back phase modeled before its SQL, with the TLA gate made to serve a second side model. One review round found nineteen defects and none was a blocker. Eleven are in the model or the text written from it, and eight are in the runner and its test. Two more were found by our own gate while folding. No reviewer lens ran TLC, so every claim about the model was run before it was folded, and three did not hold.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing here touches durable state, because no SQL exists yet. The cost is a model the SQL would have been mapped onto, saying things it did not hold.

- **The SQL would have inherited a false "rollback failed".** A cancellation or an infrastructure cap inside the rolling-back phase recorded the outcome `failed` even with nothing left to roll back, and no invariant held `failed` to its meaning. The shortest trace has no step started at all.
- **An SQL author following the header would have kept a stale rollback order.** The header said the start ordering index grows across saga generations. The model resets it on a revival, and an index kept across one orders the next saga's rollbacks by the last saga's starts.
- **Two witnesses proved nothing.** A saga with nothing to roll back completes at entry, and two probes accepted it, so the behaviours they exist to show reachable could have vanished with both still reading as witnessed.
- **A mutant list lost in a merge would have taken a whole model out of the gate, green.**

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `SagasProbeRevivedAfterSaga` and `SagasProbeInfraRolledBack` were satisfied by a saga with nothing to roll back | Run: with a rolled-back step unable to ever run again, and with rollbacks disabled in a saga an infrastructure cap began, both probes were still witnessed | The probes | A probe shows one trace is reachable, and the shortest trace to each predicate never rolled anything back | The first is an action property, a compensated step starting again in generation 1, and the second asks for a rollback that is done. Under the same two edits each finds no witness (rung 2) |
| 2 | `Cancel` and `InfraCap` inside the phase wrote the outcome `failed` whatever remained, and no invariant made `failed` honest | The SQL inherits a user-visible "rollback failed" when nothing failed and nothing was left | The invariants | `OutcomeHonest` constrained `complete` only | `FailedOutcomeHonest`, red under all four configurations, then `HaltOutcome` in both actions, held by two mutants (rung 2) |
| 3 | The header and DESIGN.md said the ordering index grows across generations and that no two steps ever share one. `Revive` resets it, and a mutant requires the reset | SQL written from the header keeps the first generation's order for the second saga's rollbacks | A reader comparing the prose with `Revive` | Nothing checks a header against the actions under it | The prose says what the model holds: first-write-wins within a generation, forgotten on a fresh revival, keyed by generation in the SQL (none) |
| 4 | DESIGN.md said a rollback's spent attempts only grow, and nothing held it. Run: a `RunRollback` that gives them back passed all four configurations | A budget the SQL refills would satisfy the model | The mutant list | The sentence had no property, so no mutant could name one | `TriesOnlyGrow`, first shown as a surviving mutant (rung 2). An attempt that is not counted at all is a stuttering step, which no property can see, and BUILD.md records the conformance case that owes it |
| 5 | The rollback retry budget and the revival bound were held by ranges inside `TypeOK` | A mutant past either budget read as a type error, and the revival bound, which is artificial, read as a protocol guard | The mutant check | It accepted whatever property was reported | `RollbackBudgetHeld` and `RevivalBoundHeld`, the second saying it is artificial. `TypeOK` says types only (rung 2) |
| 6 | `HaltStops` follows from `ReverseOrder`, so no mutant could ever be attributed to it | An invariant that shows nothing, listed as if it did | The mutant list | No entry named it, and nothing asked that one should | Deleted. Run: `ReverseOrder => HaltStops`, placed first so nothing masks it, holds under every mutant and configuration (rung 1: the line is gone) |
| 7 | No mutant named `CompensatesAnEffect` or `DecisionSettles` | Either could be deleted from every configuration with the gate green | The mutant check | It asked that every mutant be caught, never that every property be named | One mutant each, and finding 21's rule (rung 2) |
| 8 | Four mutants named the property TLC reported first and not the one their guard is about: two revival mutants a bookkeeping invariant, one a rollback-finality property where liveness also holds it, and one held by bookkeeping alone | A guard can lose the property that holds it while its entry still reads as caught | The mutant check | It ran each mutant among every property, and TLC stops at the first violation | Finding 20's runner. Two entries now name `MemoMatchesEffect` and `DoneMeansCompensated`, and `revive-keeps-the-tries` says only bookkeeping holds it (rung 2) |
| 9 | `Revive`'s forward branch had no witness and no mutant. It is reachable only when an infrastructure cap skips the saga. Run: with the branch replaced by FALSE every configuration passed | Behaviour could be removed unseen | The probes | None was written for it, and mutants cannot see removed behaviour | `SagasProbeRevivedWithNoSaga`, which finds no witness with the branch removed (rung 2) |
| 10 | The ledger block mapped two actions to a batch label `'checkpoint'`. The batch is `'set-checkpoint'`, and `'checkpoint'` is a statement label inside it | An implementer following the ledger finds no such batch | `scripts/spec-ledger.py` | It reads `Scheduler.tla` only | The block corrected against a grep of both stores, and it says no script reads it (none) |
| 11 | BUILD.md claimed a mutant for every guard of every action, a runner that serves every side model, and that its conformance list is the model's executable form, which omits six twins. It also kept counts by hand | The implementation PR's exit list left out the start marker, the one-batch decision, the frozen forward steps, the revival refusal, the cancel outcome, and the infrastructure rule | The pr-gate rule that every model guard has an executable twin | It is prose | The entry lists the owed twins and drops the counts and the two claims (none) |
| 12 | Bash and python each globbed a model's pass configurations, differently. A model whose name begins another's took its cfgs and probes, and a model with one configuration handed TLC a literal glob | A mutant could be caught under a configuration the gate never required to pass | The stub test | It ran the real lists only, which have neither shape | One definition in the shell, passed to the python as arguments. Stub cases on a fixture with both shapes (rung 1 for the second definition, rung 3 for the cases) |
| 13 | A model was enrolled by its mutant list existing, and nothing asked that every module be enrolled | A list lost in a merge takes four configurations, the probes, and the mutants out of the gate, green | The runner | Three globs of one pattern, each content with what it found | Every `.tla` and cfg beside the specs must belong to something the script runs (rung 2) |
| 14 | The check that a model's configurations differ in constants only was written for two child-task files by name, with a `tail -n +3` that assumed a two-line comment | Run on the fixture: a pass configuration that drops an invariant its sibling checks stays green | The check PR #42's round added | It was a point fix for the two files that round was about | Every pass configuration is compared with `<Model>.cfg` from `SPECIFICATION` down (rung 2) |
| 15 | The stub reported every model's property names on every mutant run, and the test never read which runs happened | A runner that hands one model's mutants another's configurations still read "N of N caught" | The stub test | Generalizing it to several lists added a way to cross wires that the single-model stub could not have | The stub violates only what the cfg it is handed checks, and the test reads each model's pass runs, probes, and mutant runs from the java log. Seen failing with the wiring crossed (rung 3) |
| 16 | The probe waves, a fix for a run killed for memory, had no red test, and a side-model probe took an eighth of the whole budget | Waves could regress to every probe at once with everything green | The stub test | It counted nothing | The stub counts live probes. Waves pack by memory, and a side probe holds 512 MB. Seen failing with the wave boundary removed (rung 3) |
| 17 | The stub test's cost grew with mutants times configurations, 234 blocking spawns, inside the conformance worker | Measured, not the several seconds a test that review feared: 591 and 571 ms before. The growth was real | Nothing measures it | | The surviving and wrong-property cases run on a two-model fixture, and one case runs the real lists (none beyond that) |
| 18 | Side-model pass runs sat ahead of the target in every `TLA_ONLY` liveness job, and no tla job had a timeout | One sagas regression turns all six nightly jobs red and the Scheduler liveness targets never run. A hang holds a runner for six hours | The stub test's liveness case | It asserted that the target ran, not what ran before it | The runs sit after the liveness exit, a stub case asserts it, and the jobs get `timeout-minutes` (rung 3) |
| 19 | The script's header sentence was broken mid-clause and still said every probe runs at once, two comments were fused, counts were kept by hand in three files, and the pr-gate skill described the old gate | Text that is wrong the day the next probe is added | A reader | | Rewritten, and the counts dropped (none) |
| 20 | Adding `FailedOutcomeHonest` for finding 2 displaced three correct mutant names, because it sits earlier in the configurations and TLC reports the first violation it meets | The gate went red on three entries that were right | The mutant check, which did catch it | It caught the symptom. The cause was its own design, which finding 8 had already shown | Each mutant runs under its configuration reduced to the one property it names (rung 1 for the order: there is no list left to have one) |
| 21 | `TypeOK` in both models, and `TerminalImpliesDone`, `DoneAuthority`, and `EveryWaitResolves` in the child-task model on main, were named by no mutant | Each could be deleted from every configuration with the gate green | The rule this fold added, which found them | Before it nothing asked | Every checked property must be named by a mutant, or the gate fails with UNNAMED. Five mutants close these (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| One Fable review: the built-in `/code-review` in a single pass with five finder lenses, and `/simplify` with four cleanup agents | 19 | no |
| The mutant check, run on the fold before anything was pushed: three WRONG-PROPERTY verdicts | 1 | yes |
| The every-property-named rule, on its first run | 1 | yes |

Self-catch rate: 2 of 21, or 10% (previous round, PR #42's: 4 of 15, or 27%). It fell. PR #42's round ended by saying review found every defect in what the model CLAIMED and our machinery found defects only after review showed it how. That is this round again. The mutant check, built in that round, caught nothing here before review, because the author chose each entry's property by running the mutant and writing down what fired. A check fed its own output confirms itself. Both self-catches came after review, from mechanisms review's findings caused to be built.

## Recurrence

**A configuration that checks less than it appears to** (finding 14) is PR #42's finding 1 again. That round's mechanism compared `ChildTasks.cfg` with `ChildTasksRefuse.cfg`, by name. It checked two files, and the property is that no configuration of any model checks less than its siblings. The very next model arrived with four configurations and no guard, in the PR that generalized everything else in the script from one model to many. A mechanism written against the instance in front of it does not carry over, because nothing connects it to the class. The comparison is now a rule over every enrolled model.

**Prose stronger than the model** (findings 3, 4, 10, 11) recurred from PR #42's findings 4, 5, and 6, and PR #42's round said of it that the only check is a reader who opens the file. No mechanism was instituted then, so none failed. One of the four is closed at a higher rung here: "spent attempts only grow" is now a property with a mutant. The other three are corrected text, and a fourth round will find more.

**A mutant caught by accident** (finding 8) is PR #42's finding 14, and that round's mechanism, matching the named property in TLC's output, is what failed. It checked that the named property is the one REPORTED. The property is that the named one HOLDS the guard. TLC reports the first violation it meets, so the mechanism made the name a function of the order of a list, and it let an author satisfy it by writing down whatever was reported. Finding 20 is the same defect seen from the other side, when a new invariant moved three names. Running each mutant under one property removes the order.

**A property or guard nothing speaks for** (findings 6, 7, 9, 21) has appeared in every spec round so far. PR #42's round listed "a guard of the model with no entry in the mutant list" under what it would not catch and left it to PR3.10. This round closes the property half with a rule, and the guard half is still hand-kept.

**A fix with no red test** (finding 16) is AGENTS.md's oldest rule. The seam existed, the stub `java`, and the fix was made under the pressure of a killed run.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Every `.tla` and cfg must belong to something the script runs | 2, syntactic: it reads file names | A model whose every file is gone, list, modules, and cfgs together. Run on the fixture with every `AlphaBeta*` file removed: the gate is green |
| Pass configurations compared from `SPECIFICATION` down | 2 | A property deleted from every configuration of a model at once. The every-property-named rule covers it only while a mutant names that property |
| One property for each mutant run | 1 for the order | An entry that names a bookkeeping invariant where a soundness property also holds the guard. Run: `revive-keeps-the-tries` names `RollbackOnlyEligible`, and nothing asks whether a better name exists. Here none does: with the three bookkeeping invariants out of the configuration it passes |
| Every checked property named by a mutant | 2, a proxy: named once is not held everywhere | Run: with the conjunct `outcome \in {"none", "complete", "failed"}` deleted from `TypeOK`, `Sagas.cfg` passes and `TypeOK`'s one mutant is still caught |
| `FailedOutcomeHonest` with `HaltOutcome` | 2 | Run: `HaltOutcome` reading the pending set in place of "not done" passes all four configurations. It is equivalent while the task is live, and a model that let a failed rollback coexist with a live task would make it wrong |
| The two strengthened probes | 2 | Run: in a saga an infrastructure cap began, step `b` can never be rolled back, and the infra probe is still witnessed through step `a`. `DecisionSettles` catches that edit. A probe shows one trace, not every one |
| `TriesOnlyGrow` | 2 | Run: a `RollbackRetry` that does not count its failure passes all four configurations. It is a stuttering step |
| The forward-revival probe | 2 | A forward revival that also forgets a step: the probe is still witnessed. Not run, because `MemoMatchesEffect` is stated over that state and the mutant check covers it |
| The stub's wiring assertions | 3 | Run: a runner that tries only each model's FIRST pass configuration passes all 17 stub tests. The real gate catches it, because `cancel-ignores-the-rule` is reachable only under another answer |
| The live-probe count and the heap flag | 3 | Run: TLC's off-heap share doubled passes all 17. The test bounds how many probes run and each one's `-Xmx`, not its direct memory |
| Side models after the liveness exit | 3 | Run with a stub checker that fails `WakeDelivery.cfg` under `TLA_ONLY=liveness1`: the script exits 1 and the job's target runs 0 times. That line predates this PR and its comment asks that it stay on every scope |

## Fix-induced defects

One of twenty-one: finding 20, caused by the fix for finding 2. The fold was re-tested, with every red seen failing first, and was not reviewed again. The repair for finding 20 changes what "caught" means for every mutant of both models, which is the largest change in the fold and the one a second review would be best spent on. Its safety argument is monotone: a property TLC reports first among many is violated alone, so every earlier catch stands, and the full gate confirms it for all 77.

## Evidence

- Finder: one Fable subagent invoking the built-in `/code-review`, a single pass with five finder lenses (reuse and efficiency, removed behaviour, altitude and conventions, a cross-file tracer, a line-by-line scan), and `/simplify` with four cleanup agents, over the six commits of the PR. Quoted: "13 findings (5 MEDIUM, 8 LOW), nothing HIGH", and from the lenses, "Two witness probes are satisfied by an empty saga, not by the behaviour their comments name", "the two globs already disagree", and "`outcome' = \"failed\"` is written even when `Pending = {}`, and no invariant requires \"failed\" to be honest". No lens ran TLC.
- Reds and greens, by commit subject. "Show what the side-model runner lets through, on a small fixture": 9 stub cases fail. The fixture cannot run at all under the old script, because of the prefix defect and two file names it hard-coded, and with the fixture made runnable five cases fail alone: the liveness job, the lost list, the dropped invariant, the action-property witness, and the side probe's heap. Green: "Decide once what belongs to a side model, and let nothing beside the specs go unchecked".
- "Ask that a failed rollback outcome be honest, which the model is not": all four configurations exit 12 on `FailedOutcomeHonest`. Green: "Record what a saga that ends early left, in place of \"failed\" every time".
- "Show that nothing holds a rollback's spent attempts": the mutant survives all four configurations. Green: "Hold a rollback's spent attempts within a saga generation", exit 13 on `TriesOnlyGrow`.
- "Show that a mutant's named property follows the order of a list": 2 stub cases fail, and at the commit before it the real gate exits 1 with three WRONG-PROPERTY verdicts, `rollback-on-a-dead-task`, `finish-saga-on-a-dead-task`, and `halt-recorded-as-done`. Green: "Check each mutant against the one property it names, and ask that every property be named".
- Gate on the final tree, `TLA_SCOPE=ci` through `scripts/confine.sh`: exit 0 in 207 seconds, 21 of 21 child-task mutants and 56 of 56 saga mutants caught, 27 of 27 probes witnessed, no trace file beside the specs. Lint, typecheck, and the format check exit 0, and the 17 stub tests pass.
- An attribution run backs findings 6 and 8: every mutant under every configuration with TLC's `-continue`, listing every property reported. It also showed `-continue` reports one violation for each state, so an earlier invariant still masks a later one in the same state, which is why the memo mutant's soundness property appeared only once `StartOrderDistinct` was out of the configuration.
- Claims that did not reproduce. One lens said TLC prints a generic line for a violated liveness property, so no mutant could name `DecisionSettles`: run, TLC prints "Temporal property DecisionSettles was violated", which another lens had also reported from a run of its own. One said the stub test stalls the worker for several seconds a test: measured, 591 and 571 ms. And the request to name a soundness property for `revive-keeps-the-tries` has no answer: with `RollbackOnlyEligible`, `ReverseOrder`, and `SagaOnlyAfterDecision` out of the configuration it passes.

## Root cause

The model's checks were all written by the person who wrote the model, from the model. Each probe was the shortest trace to a predicate its author had in mind, each mutant's property was whatever fired when the author ran it, and each sentence of prose was the author's memory of an action. None of those can disagree with the author. The mutant check that PR #42's round built looked like an outside view and was not one, because its input, the named property, was produced by running it.

The runner's defects share a second cause. The script was generalized from one side model to many by replacing each name with a glob, and a glob keeps the behaviour for the files that exist while dropping every guarantee the names carried: that a missing file fails, that two specific files are compared, that one model's files are not another's.

## Mechanisms

Built in this PR:

- One property for each mutant run, in `scripts/tla.sh` (rung 1 for the order of a list).
- Every checked property named by a mutant, in the same check (rung 2).
- Every `.tla` and cfg beside the specs accounted for, a model's files decided once from file names, and every pass configuration compared with its base, on every scope (rung 2).
- `FailedOutcomeHonest`, `TriesOnlyGrow`, `RollbackBudgetHeld`, and `RevivalBoundHeld`, each held by a mutant, and mutants for `CompensatesAnEffect`, `DecisionSettles`, `TypeOK`, and three child-task properties (rung 2).
- Two probes that need a rollback that ran, and a probe for a forward-phase revival (rung 2).
- Stub cases on a two-model fixture for the wiring, the structure checks, the waves, the side probe's heap, the action-property witness, and the liveness job (rung 3).
- `timeout-minutes` on the tla jobs.

Deferred (recorded in BUILD.md):

- The executable twins the implementation PR owes, listed in the PR3.4 entry, the uncounted rollback attempt among them. They need SQL that does not exist yet.
- Generating the mutant list from the model's guards stays with PR3.10. The guard half of "nothing speaks for it" is hand-kept until then.

## What this round still would not catch

- A guard of a model with no entry in its mutant list. The new rule asks that every property be named, not every guard.
- A property named once whose other conjuncts nothing exercises.
- An entry that names a weaker property than the best one available. Nothing ranks properties.
- A witness probe whose shortest trace is not the behaviour its comment names. Two were found by reading. The others were read in this round and not mutated.
- A model whose every file disappears together.
- A sentence in a header, DESIGN.md, or BUILD.md that says more than the model holds. Three rounds running.
- A WakeDelivery failure hiding a nightly liveness target.
- TLC's direct-memory share, which no test reads.
