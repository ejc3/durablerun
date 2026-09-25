# Postmortem: PR5.2a, the retention model and its two review rounds

The pull request models the purge of whole terminal task units in `specs/Retention.tla` ahead of any SQL, and states the protocol, as proposed, in DESIGN.md section 3.12. Its first review found 12 findings, of which 9 are counted (issue #98 lists them). The fold of that review added a name-only half to the barrier's condition B3, on a ruling the narrow re-review then refuted: keeping a unit for a run that holds only its completion event's name kept two cancelled tasks that awaited each other forever, under every policy the type allows, and no property depended on it. The re-review found 10 findings, of which 6 are counted, and every counted one came from the first fold's own repairs. The fold of the re-review narrows B3 to a run of another unit that holds the child's outcome, the condition the model had checked from the start, and corrects the rest. No engine code changed, so nothing a user runs was wrong: 15 findings are counted, all in the model, its mutants, and the design prose that PR5.2c2 will build from.

**This document is adversarial toward the MACHINERY and blameless toward people.** The question in each section is what would have made the defect unwritable, or caught it without a person reading.

## Severity

Nothing a user runs was wrong, because no store sends a purge batch yet. The model and section 3.12 are PR5.2c2's precondition, so a defect in them becomes a defect in the SQL written against them. The worst finding is the re-review's finding 1: the barrier as the first fold stated it would have kept forever two tasks that awaited each other and were cancelled, and a cancelled task that awaited itself, under every policy the type can express. Those rows are what retention exists to bound. The first review's finding 1 was the same condition seen from the other side: section 3.12 stated a wider B3 than the model checked, so every property of the model spoke about a barrier the design did not describe. The remaining findings would have shipped false sentences about what holds a guard, which grid cell or twin checks it, and what a store does today.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | First review 1 (MEDIUM): DESIGN.md's B3 read every run that names the completion event, while the model's guard read only a run that carries the outcome | The model's properties and keep list were false for the designed SQL | A check that the design's condition and the model's guard are the same condition | Nothing compares prose with a TLA guard, and the spec ledger reads labels and action names only | None built. DESIGN.md's B3 now states the model's guard, and says it is the delete-time form of the invariant library's `payload/event-missing` |
| 2 | First review 2 (MEDIUM): the twins named for WholeUnit catch only rows that outlive their task, not a task row whose runs were deleted | PR5.2c2 could keep a task row with no runs and pass every history check | The twin table in section 3.12 | A twin is named in prose, and nothing runs a twin against the half it claims | None built. Section 3.12 says which half is held today, and PR5.2c1 adds the other (issue #103), which exit test line 41 names among its conditions |
| 3 | First review 3 (LOW): "no other reason" left out a NULL stamp, an unparsable key, and the checkpoint cap | A false completeness claim | The keep list against the barrier's own bullets | Prose | The list now names what the model cannot express |
| 4 | First review 4 (LOW): PurgeStepIsDeadAndOld keyed on `st' = "absent"`, so a purge that wrote another state passed it | A property that could not fail for one kind of wrong purge | The mutant check | No enrolled mutant wrote a state other than absent | The step keys on the task leaving presence |
| 5 | First review 6 (LOW): the ledger mapped the sweep caps only to endings, where a saga's forward phase enters rollback | A false mapping in a machine read block | The spec ledger | It checks that labels and actions exist, not that a mapping is complete | The two lines name EnterRollback |
| 6 | First review 7 (LOW): the TIME header said every batch that writes the task row resets its age | A false sentence about the model's abstraction | Prose | Prose | The header says which writes reset the age |
| 7 | First review 8 (LOW): a mutant was caught only under a policy the policy type cannot express | A mutant catch that no deployment could meet | The configurations' constants | Nothing holds a configuration to the type's domain | The failed policy configuration is one the type can express; the mutant that then survived is recorded as unheld |
| 8 | First review 10 (LOW): BUILD.md said TLC showed that the key is parsed | A conclusion TLC cannot support | Prose | Prose | BUILD.md says what TLC checked |
| 9 | First review 11 (LOW): contract change 1 said a spawn in the purge race creates a fresh task, which today's stores do not do | A requirement stated as a fact | Prose against the stores | Prose | It is stated as a requirement on PR5.2c2 |
| 10 | Re-review 1 (MEDIUM): the name-only half kept forever two cancelled tasks that awaited each other, and a cancelled self-await; the keep list and its reasons were false | Unbounded rows under every policy, had PR5.2c2 built it | A model with more than one awaited task | Only C is awaited in the model and C is never a holder, so a cycle cannot be expressed | None built. B3 is narrowed to a run of another unit that holds the outcome, and the cycle that needs a revival is listed, with an option and its trigger |
| 11 | Re-review 2 (LOW): the reason given for the name-only half, that a revived holder replays its await and reads the child, does not match the replay path | A false reason in the design and the model | Prose against the claim and the SDK's replay | Prose | The half is gone, and the Revive comment says its fresh await is wider than a replay |
| 12 | Re-review 3 (LOW): under the design's widened B3, B4's mutant catch and its vacuity witness held only against the model's narrower guard | Two holds that could not fail against the designed condition | The mutant check, run against the designed condition | The mutant check runs against the model's guard, not the design's | Moot once the design's B3 equals the model's; B4's catch and witness hold again |
| 13 | Re-review 5 (LOW): "the barrier grid's parent cells hold both" included a rolling-back parent, which the grid does not have | A false claim that a guard is held | Prose against the grid's declared states | Prose | Section 3.12 names the cells that hold it, and exit test line 42's grid gains a rolling-back parent state, so section 3.12 names those cells too |
| 14 | Re-review 6 (LOW): the delete order's reason said a checkpoint is reached through its owner run | A false reason | Prose against the schema | Prose | The reason names the relations: waits through runs, checkpoints and the event by the task id |
| 15 | Re-review 9 (LOW): HolderCancelled's clause for a parked holder could be deleted with every property green, and the carrier mutant's guard text named only payloads while its find deleted both halves | A guard nothing held, and a false line in the mutant list | The mutant check | No mutant was enrolled for that clause | Moot: the clause, its variable, and the name-only find are gone |

Counted 0, each with its reason. First review 5: missing mutant evidence where TLC already caught each deletion, a redundant conjunct, and an unheld part already disclosed. First review 9: B5's single-database assumption, unreachable in this build, now stated with a trigger. First review 12: the delete order's reason, plausible and not shown false in that round (its replacement is finding 14). Re-review 4: the parse case's owner, which the milestone's design does give PR5.3b1; exit test line 35 now names the case. Re-review 7: the index B3's read needs, which the milestone's design already plans for schema version 12 and the plan check would demand at build time. Re-review 8: contract change 1 named PostgreSQL's throw, which is true; the other two stores throw the same way, and it now says every store. Re-review 10: two parallel variables, a simplification, gone with the name-only half.

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The first review: the built-in code review skill at high effort, run by a subagent, beside the reviewer's own TLC runs in a scratch worktree | 9 | No |
| The narrow re-review of the first fold: code traces and TLC runs at the fold's head | 6 | No |
| This project's machinery: TLC on four configurations, the mutant check, fourteen vacuity probes, the spec ledger, and the artifact test, green on both reviewed heads | 0 | Yes |

Self-catch rate: 0 of 15, or 0% (previous round on main, the closing docs pull request of round two: 0 of 2, or 0%).

While folding the re-review the author traced one more thing no review named: a cycle of runs that hold each other's outcomes keeps every unit in it forever, and it needs a `retryTask` revival. It exists under either reading of B3, so it is recorded in section 3.12 and BUILD.md rather than counted.

## Recurrence

Three classes, each with more than one instance in this pull request.

Design prose that names a different condition from the model's guard: findings 1, 10, 11, and 12. No earlier round built a mechanism against it. The spec ledger, the nearest check, says in its own header that it reads no guard. The first fold repaired finding 1 in the direction of the prose, which is how findings 10 to 12 came in: the understanding behind the repair was about the design's sentence, not about what any reader of the rows needs.

A guard or property that no check can fail: findings 4, 7, 12, and 15. This class has a mechanism, the mutant check, and it recurred. The check proves that a property fails when an enrolled guard is deleted. It says nothing about a guard nobody enrolled (finding 15), about a mutant caught only under constants no deployment has (finding 7), or about a property that restates its own guard: `NameCarrierKeepsChild` was caught by its mutant, and with the guard and the property both removed the other nine stayed green. The mutant check is a proxy for "the design needs this guard", and it measures "some property names this guard".

A false sentence about another pull request's plan, a twin, or what a store does today: findings 2, 3, 8, 9, 13, and 14. This is the class the closing docs postmortems record in every round, and nothing reads such a sentence against its subject.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The mutant check in `scripts/tla.sh` | 2, semantic for each enrolled guard, silent on the rest | At this pull request's head, `ParentAllows` changed to admit a parent that is rolling back or failed with a saga: all four configurations report "No error has been found" (195,342; 119,734; 2,087; and 204,488 distinct states), and no mutant names that change, so the gate stays green. At the first fold's head, HolderCancelled's clause for a parked holder deleted: Retention.cfg with all ten properties, 353,836 distinct states, no error. |
| A property that its mutant names | 2 | At the first fold's head, the name-only half of B3 deleted with `NameCarrierKeepsChild` removed from Retention.cfg: 356,110 distinct states, no error. The property was the only thing that held the guard, and it held it by restating it. |
| The spec ledger, `scripts/spec-ledger.py` | 2, syntactic: labels and action names | The first reviewed head, whose DESIGN.md read B3 as every run naming the event while the model's guard read the carrier, passed `lint:ledger` and every other gate of its full list. |
| `AgedUnblockedIsPurged` as the completeness of the keep list | 3, bounded by the model's shape | The model has one awaited task, so a cycle between two units cannot be written in it. The keep list at the first fold's head claimed completeness while the cancelled mutual await kept both units forever, and every configuration was green. |

## Fix-induced defects

Six of the fifteen: findings 10, 11, 12, 13, 14, and 15, all introduced by the first fold. Findings 10, 11, 12, and 15 came from the name-only half, which a coordinator's ruling chose over the review's own first option, to key B3 on the payload; finding 13 from a sentence the fold wrote about the grid; finding 14 from the reason the fold wrote for the delete order. The first fold was re-reviewed once as new work, narrowly, and that re-review found all six. The second fold has not been re-reviewed.

## Evidence

- Red tests: commit `d642333` for finding 1, where TLC reports `Invariant NameCarrierKeepsChild is violated` on all four configurations: the parent parks on the child, is cancelled, the child completes, and the purge takes the child.
- Fixes: commit `013923c`, which widened the guard and turned that run green, and commit `8b20c60`, the final fix for finding 1, which narrows the design's B3 to the model's carrier.
- Red tests: none of its own for finding 2, and this line cites no commit.
- Fixes: commit `1194b99` for finding 2.
- Red tests: none of its own for finding 3, and this line cites no commit.
- Fixes: commit `476dc38` for finding 3.
- Red tests: none of its own for finding 4, and this line cites no commit. Before the fix a purge that ignored the age and wrote another state ran green under PurgeOnlyDeadAndOld; after it the same change fails with TLC exit 13.
- Fixes: commit `c917f14` for finding 4.
- Red tests: none of its own for findings 5 to 7, and this line cites no commit.
- Fixes: commit `c917f14` for findings 5, 6, and 7.
- Red tests: none of its own for findings 8 and 9, and this line cites no commit.
- Fixes: commit `476dc38` for findings 8 and 9.
- Red tests: none of its own for findings 10, 11, 12, and 15, and this line cites no commit. The model cannot express the cycle of finding 10, and the other three are removed with the half they describe.
- Fixes: commit `8b20c60` for findings 10, 11, 12, and 15.
- Red tests: none of its own for findings 13 and 14, and this line cites no commit.
- Fixes: commit `82bc85c` for findings 13 and 14, and for the Revive comment of finding 11.
- Finder of findings 1 to 9: the first review, quoted verdict: "returned 15 findings. I checked each one myself. 12 held."
- Finder of findings 10 to 15: the narrow re-review of the first fold, quoted: "Under the conservative B3 the fold now models and states, an await cycle that ends the way DESIGN.md:1387-1390 says cycles end (a cancellation deadline) keeps both units forever, under every policy the type can express."
- The code the narrowing rests on, checked for this fold: the claim decodes a wake whose payload is null as a timeout (`packages/core/src/statements/claim-receipt.ts`), a successor run copies `wake_event` and `event_payload` (`SUCCESSOR_CARRIED_RUN_COLUMNS` in `packages/core/src/contract.ts`), and the terminal batch's wake updates only a sleeping run of a live task with a registered wait (`packages/core/src/statements/events.ts`), which is why a cycle of carriers needs a revival.
- After the second fold, TLC on the four configurations: 191,130; 116,458; 2,087; and 200,276 distinct states, no error. The mutant check caught 18 of 18 and every one of the 14 vacuity probes found its witness, `RetentionProbeWait` among them.
- Claims that did not reproduce: none of the counted findings. The first review refuted three of its skill's findings (empty section headings that PR5.0 does not write, a contradicted absolute in ChildTasks.tla, and the model's second copy of engine actions, which side models keep on purpose).

## Root cause

The model and the design are two descriptions of one barrier, and every check the repository runs reads only one of them. TLC and the mutant check read the model, and nothing reads section 3.12 at all, so the two drifted apart in the first version, and the repair moved the model toward a sentence of the design rather than asking which condition a reader of the rows needs. The mutant check then reported the new guard as held, because the property added with it restated it. A property that restates a guard, and a sentence that no check reads, are the same gap: each says the guard is there, and neither says the design needs it.

## Mechanisms

Built in this PR:

- None. The fold narrows B3, removes a property that only restated its guard, and corrects sentences. It adds no check.

Deferred (recorded in BUILD.md):

- Checking the model's copy of the engine's actions against ChildTasks.tla and Sagas.tla, with its trigger: a change to either model's await or wake.
- Purging together a set of terminal units whose runs hold each other's outcomes, with its trigger: a unit kept past its window by a carrier whose own unit is kept the same way.
- A check that compares a sentence of DESIGN.md with the guard it describes has no owner, as the closing docs postmortems record for prose in general.

## What this round still would not catch

A guard of the model that no mutant names ships today with the gate green, and one exists at this head: B5's block of a parent that is rolling back or failed with a saga, disclosed in the model's header. A property added beside a guard that only restates it would be reported as holding that guard. A sentence of section 3.12 that names a different condition from the model's guard would pass every gate, as the first version did. And a leak that needs two awaited units, such as the revival cycle, cannot be written in this model, so its keep list is complete only for what one awaited child can express.
