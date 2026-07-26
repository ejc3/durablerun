# Postmortem: closing the write-provenance residual (PR3.7)

PR3.7 closed four mechanisms deferred by the final PR3.6 review: a structural
many-row bound, contract-owned source/target key relations, attributable
mutation verdicts, and a generated corrupt-pre-state fault surface. The new
poison surface found three production store defects before review. Adversarial
review found thirty-four gaps in the mechanisms themselves, while
`pnpm verify` caught one integration defect in the new classifier self-test.
The first full clean-tree mutation audit then self-caught six attribution
defects: 28 of 34 mutations reached their exact verdict and six reached a
wrong path.

The reviewed snapshots were not safe to land: they could leave obsolete waits
behind, delete a foreign wait through corrupt denormalized ownership, rewrite
generated provenance or public row identity, certify amplification through
colliding identities or non-mutating calls, double-launch a task with corrupt
multiple-live-run state, activate an issued claim after that corruption
appeared, let corrupt work consume a bounded claim budget and starve healthy
tasks, and report malformed verification evidence as green.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question throughout is what would have made each defect
unwritable or caught it without another review.

## Severity

The worst production escape was cancellation deriving wait ownership from
`waits.task_id`. That column is a denormalized mirror, so corrupt state could
make cancellation delete another run's live event registration while retaining
the cancelled run's own. The two suspension APIs also cleared a run's event
wake fields without deleting the registration they replaced with a timer,
leaving durable state that disagreed about whether the run was still waiting
for the event.

The mechanism escapes were equally serious because they claimed those classes
were closed. A widened write could commit before a row-count alarm reported it;
a generated relation could read a table its named fence never stamped; the
poison matrix could count a label that wrote nothing, accept authority laundered
into the allowed after-state, and miss a more severe value under the same
finding identity. A short invariant result vector defaulted a missing table to
empty, while name-level coverage allowed one of several semantic arms to answer
for the others. Those are false assurances in the gates intended to keep
corruption from shipping.

Late review found a second production-adjacent worst case: the generated UPDATE
surface still let a caller compete with provenance or rewrite public
`runs.run_id`. The verification layer could then hide escapes through composite
key collisions, rendered-subject collisions, number/bigint mismatches,
display-name exemptions, CTE/SELECT/no-op progress proxies, or malformed
mutation reports. The unconstrained mutation runner also repeated full suites
outside the repository's memory/CPU boundary. Together these findings meant the
new prevention could corrupt identity, misgrade corruption, or endanger the
host it ran on.

The final review also made the poison matrix's advertised
`claim × cardinality/two-live-runs` cell real. Its corrupt runs had been
scheduled in the future, so claim touched only an unrelated healthy trigger.
Once due, both were claimed: SQLite chose one row for a multi-row scalar
task-book projection, while PostgreSQL and MySQL would reject it. The same
state could therefore double-launch one task or fail differently by dialect.
The first claim repair still left an issued launch usable if the second live
run appeared before activation, so the worker could begin executing precisely
the task state that claim and receipt had learned to refuse.

The next re-review found that the claim guard's placement was still a proxy:
an earlier corrupt row was selected by `LIMIT 1` and only then rejected, so a
later healthy task received no claim and could be starved on every tick.

The six audit findings did not add production transitions, but they invalidated
six advertised proofs. Construction rejections were mislabeled as behavioral
evidence, plan and wake tests were not independently discriminating, and
Vitest's custom messages disappeared on unexpected promise outcomes. A mutation
surface that reports the right defect through the wrong assertion is not an
attributable prevention mechanism.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `reschedule` replaced an event wait with a timer but did not delete the old wait rows | An obsolete registration survived after the run no longer carried the matching wake, violating atomic replacement and leaving later cleanup or emit to reason over stale ownership | Generated poison matrix and suspension conformance | Existing suspension tests started from a clean timer state; no corrupt pre-state supplied an already registered wait | One `finishSuspension` chokepoint couples the task mirror with cleanup derived from the run stamped by the suspension CAS; poison runs the label over the wait-corruption inventory (rungs 1 and 2) |
| 2 | `suspendRun` had the same stale-registration hole | The checkpointed suspension could commit while retaining an event registration the transition had replaced | Generated poison matrix and suspension conformance | The two APIs duplicated the post-transition shape and neither test family asserted wait removal from corrupt pre-state | The same `finishSuspension` chokepoint is mandatory for both suspension APIs, with exact-replay regression coverage (rungs 1 and 2) |
| 3 | Cancellation deleted waits through denormalized `waits.task_id` | A corrupt mirror could delete a foreign task's live registration and retain the cancelled run's own wait | Generated poison matrix and cancellation invariants | The transition treated a convenient mirror as authority; healthy fixtures made the mirror and authoritative run ownership agree | Wait cleanup now traverses `runs.run_id → waits.run_id` from the runs the cancellation follow-on actually stamped, never `waits.task_id` (rung 1) |
| 4 | The first many-row bound counted keys after the batch committed | An amplified write was already durable when the checker noticed it, and counting rows could confuse several physical waits under one legal logical run key with widened authority | `FencedBatch` row-bound design | A postcondition measured an outcome proxy instead of constraining the target selection | `rows: 'source-keys'` is generated as a target-key subset of stamped source keys; there is no runtime count to get wrong or run too late (rung 1) |
| 5 | A relation name paired its keys, but `derived()` did not prove that the named fence stamped the relation's source table | A valid-looking generated follow-on could silently select no authoritative source row or borrow an unrelated stamped table | Typed `FencedBatch` boundary | The relation owned the table/key pair while fence metadata carried no checked source-table identity | Named fences retain their target table and construction rejects any relation whose `from` table differs (rung 1) |
| 6 | The initial relation set admitted `tasks → waits`, and `seal()` accepted a self-table relation without proving the same logical key on both sides | Corrupt denormalized task ownership could redirect wait cleanup, while a seal over a different key could leave replay capability alive or consume unrelated provenance | Closed relation ledger and seal type | “Same table” and a plausible join were proxies for authoritative ownership and exact self-identity | The ledger contains only five reviewed authoritative relations; sealing is typed and runtime-checked as exact table and exact key identity (rung 1) |
| 7 | Generated self-source updates read the table being updated directly | The shared SQL shape fails on MySQL's target-table restriction even though SQLite tests are green | Pluggability contract and SQL-shape tests | Only SQLite executed the generated self-relation during development | Self-source key and instant reads are materialized through non-mergeable `SELECT DISTINCT` derived tables, with construction tests pinning both shapes (rungs 1 and 2) |
| 8 | Poison compared only condition ID plus subject, so `attempts = 2` becoming `attempts = 100` was treated as the same surviving violation | A write could make corruption substantially worse while the non-amplification oracle stayed green | Poison semantic oracle | Finding identity recorded existence, not severity | Condition-specific severity evidence rejects worsening on the same subject; adversarial meta-tests attack positive and negative counters (rung 2) |
| 9 | A poison cell passed when the requested label crossed the executor but every DML statement affected zero rows | Every generated cell for a transition could be vacuous while the matrix advertised label coverage | Poison progress floor | Invocation was used as a proxy for exercising a transition | Every label must first demonstrate a successful durable effect on a healthy trigger; merely recording the label is insufficient (rung 2) |
| 10 | Poison derived allowed ownership from after-state rows | A write could move a foreign row into an allowed owner, so the oracle reclassified the escape as authorized | Poison authority oracle | The evidence being graded was allowed to rewrite the grading boundary | A protected population across tasks, runs, checkpoints, events, waits, and drivers is frozen before invocation; authority comes only from that snapshot (rung 2) |
| 11 | The invariant runner treated a truncated executor result vector as empty rows | Dropping the result for a protocol table could erase every violation in it and make checking fail open | Invariant execution boundary | Optional indexing plus an empty-array default confused “no rows” with “no result” | One atomic snapshot batch requires exactly five result sets and rejects any cardinality mismatch (rung 3) |
| 12 | Poison completeness covered display names rather than the individual branches sharing each name | A null arm, comparison arm, or storage-kind arm could disappear while another arm kept the name covered | Invariant inventory and poison generator | Twenty-three names compressed many distinct semantic conditions | One typed inventory now gives all 50 condition IDs an independent witness, and completeness fails on missing or unknown IDs (rungs 1 and 2) |
| 13 | Most invariants still encoded SQLite operators and storage checks in SQL; the first portable rewrite then accepted ISO strings and selected unrestricted rows | MySQL or Postgres conformance could fail or silently weaken the integer epoch-ms contract, while schema growth could change the evaluator input unnoticed | Pluggability contract, invariant portability review, and schema gates | A previous “portable evidence” repair covered provenance only; the rest of the invariant library retained SQLite semantics, and the first replacement traded those semantics for a broader representation | One dialect-neutral table snapshot is evaluated in TypeScript, result shape is exact, temporal values remain canonical integer epoch milliseconds, and native dialect adapters own normalization (rungs 1 and 2) |
| 14 | The first `lint-selftest` integration invoked the live mutation-inventory path inside an empty checker fixture | The verification gate failed for fixture absence instead of proving that each injected classifier fault was detected | `pnpm verify` and the lint self-test harness | One command mixed a repository inventory audit with the portable classifier unit surface | The gate caught the failure; classifier-only self-tests are now separate from the live 34-entry inventory check, and both accepted and six injected-fault paths are exercised (rung 2) |
| 15 | Frozen poison authority encoded composite keys by delimiter-joining their fields | Checkpoints or waits whose real key components contained the delimiter could collide, allowing a foreign row change to answer as an authorized row | Poison authority oracle | A display serialization stood in for tuple identity | Composite row keys are canonical JSON tuples and the meta-surface constructs the collision pair that defeated joined text (rung 1 for representation, rung 2 for attack) |
| 16 | Invariant deltas identified a finding by condition plus its rendered subject | A violation could move between two distinct rows that render to the same text and remain classified as the old violation | Invariant/poison finding identity | Human-readable subjects flattened several identity components into one slash-delimited string | Every finding carries a structured `subjectIdentity` tuple; public legacy messages remain deduplicated separately (rung 1) |
| 17 | Provenance checked stamp/instant presence but not whether a present instant used the canonical integer representation | A string or otherwise invalid provenance instant could survive as apparently valid evidence and contaminate cross-row seed comparisons | Provenance invariant and poison condition inventory | Pair completeness was used as a proxy for pair validity | `provenance/instant-not-integer` is an independent condition with its own witness and storage-corruption path (rungs 1 and 2) |
| 18 | The first portable oracle compared exact integers with JavaScript representation-sensitive equality | A dialect adapter returning bigint for the same integer that SQLite returned as number looked like a state mutation or failed a healthy-transition oracle | Dialect-neutral conformance boundary | Physical JavaScript representation was confused with canonical integer value | One exact-integer comparator converts safe number/bigint pairs to bigint and is used by snapshots, authority, outcomes, and severity without lossy Number conversion (rung 1) |
| 19 | A matching expected assertion could receive mutation credit even when the suite also had an unrelated file-level error | A broken test environment could certify a guard while the intended behavioral path was not the only failure | Mutation verdict classifier | Exact assertion matching did not make suite health part of the verdict | Any suite-level error forces `wrong-path`, even beside the expected assertion; a dedicated classifier case maintains it (rung 2) |
| 20 | Internally contradictory “success” reports could pass classifier coherence checks | A report missing test results, or declaring success while carrying failed assertions, could be interpreted as meaningful mutation evidence | Mutation report parser and classifier | Process/report equality was narrower than full structured-report coherence | Sixteen classifier cases now reject missing results, success-plus-failure, malformed output, and every process/report contradiction (rung 2) |
| 21 | Invalid-storage poison witnesses assumed every dialect could insert SQLite-style malformed values | A strict PostgreSQL/MySQL type could reject setup before the shared invariant scenario ran, making one conformance suite dialect-specific | Store fixture contract and poison generator | Raw corrupt SQL encoded a permissive storage engine's capability | `injectStorageCorruption` returns `injected` or `structurally-rejected`; both are first-class portable outcomes of the same typed witness (rung 1) |
| 22 | The poison progress detector recognized DML by an `INSERT`, `UPDATE`, or `DELETE` prefix | Valid dialect DML beginning with a CTE was reported as vacuous even when it durably changed state | Poison progress floor | One lexical spelling stood in for a state transition | Each write-mode store call is bracketed by exact six-table snapshots; a CTE counts when and only when it creates a durable delta (rung 2) |
| 23 | Relaxing lexical DML recognition could let SELECT result rows or affected-row counts from no-op DML stand in for progress | A matrix cell could pass without changing durable protocol state | Poison progress floor | Executor metadata was another proxy for the state property | Per-call six-table before/after comparison requires a real durable delta; SELECT rows and no-op DML cannot satisfy it (rung 2) |
| 24 | Persisted provenance accepted a nonempty statement suffix outside the builder's legal name grammar | Corrupt stamps could be treated as builder-produced authority even though no builder statement could emit them | Provenance evaluator | “Nonempty after the final colon” was weaker than the actual statement-name language | `provenance/statement-name-invalid` is a distinct condition and witness (rung 2) |
| 25 | The builder and invariant evaluator initially carried separate statement-name definitions | The accepted persisted language could drift from the emitted language while both local test sets stayed green | Contract representation | Two regexes represented one wire-format rule | `FENCE_STATEMENT_NAME_SOURCE` and `isFenceStatementName` are the single shared grammar for construction, token parsing, and invariant evaluation (rung 1) |
| 26 | Generated UPDATE callers supplied a raw SET fragment and could assign provenance themselves | Dialect duplicate-assignment semantics could let caller data compete with or override the primitive's authoritative stamp | `FencedBatch.derived()` construction boundary | The primitive generated provenance after accepting an unstructured caller write clause | Callers now supply only scalar right-hand sides under builder-generated assignment structure (rung 1) |
| 27 | The first provenance-assignment guard recognized plain column spellings but could be bypassed with a quoted identifier | A caller could still write the provenance column while the syntactic guard reported the assignment safe | Generated assignment checker | A textual column-name proxy tried to recognize all dialect quoting forms | Assignment left-hand sides come from a closed per-table contract; callers cannot spell any identifier, quoted or otherwise (rung 1) |
| 28 | The initial generated assignment surface exposed public primary identity, including `runs.run_id` | A follow-on could rewrite the logical identity used to prove authority and make later fences or cleanup address the wrong row | Per-table writable-column contract | “Not provenance” was treated as sufficient writability | Public primary keys are absent from the closed writable sets; only exact self-sealing can assign its private identity key (rung 1) |
| 29 | The mutation probe launched each baseline and mutant suite without internal confinement | Thirty-four repeated test sweeps could exhaust the host even when the caller forgot an outer wrapper | Heavy-run safety rule and mutation self-test | Confinement was an operator convention outside the tool that creates the load | The probe's own test command starts with `scripts/confine.sh`, and its live self-test rejects removal of that prefix (rung 2) |
| 30 | Emit's necessary poison exception matched the public display name `wait-for-fired-event` | A future condition sharing that display name could be silently exempted from new-violation checking | Poison invariant-delta oracle | Human-facing classification was used as executable identity | The exception names condition `wait/fired-event` and the exact structured poisoned-run component (rung 1 for representation) |
| 31 | The atomic emit exception existed only in oracle code and was absent from the design contract | A later “cleanup” could remove or widen it without understanding why the generated matrix needs exactly that boundary | DESIGN/spec and prevention ledger | An executable special case had no authoritative semantic owner | DESIGN records the exact condition and structured run-component boundary beside the poison mechanism; the meta/inventory surface pins the code (rung 2) |
| 32 | Same-identity severity treated every wait-deadline mismatch as severity one | A transition could increase a timeout/availability divergence while the condition and subject remained unchanged | Poison worsening oracle | The first severity map covered counters but not temporal magnitude | Severity is the exact absolute integer delta between wait timeout and run availability, with a meta-test that widens it (rung 2) |
| 33 | Same-identity severity treated every one-seed/two-instants violation as severity one | A transition could widen the provenance instant span under the same seed without being classified as amplification | Poison worsening oracle | Finding existence stood in for the magnitude of surviving evidence | Severity is the exact bigint max-minus-min span for the seed across all provenance tables, with a widening meta-test (rung 2) |
| 34 | The mutation parser trusted a failed assertion even when its file status and all aggregate counters said every test passed; the first repair then indexed a malformed non-string assertion status and raised `TypeError` | A contradictory report could certify a mutant, while malformed status data could crash the checker instead of producing a fail-closed verdict | Mutation report parser and classifier | Top-level success/process checks and assertion matching did not validate the reporter's redundant accounting views against each other, then assumed status was hashable before category lookup | All nine counters must be nonnegative integers with coherent internal arithmetic; test counters match assertion rows, each file status matches its assertions/messages, and success matches failure counters; status is type-checked before lookup and dedicated classifier cases pin both paths (rung 2) |
| 35 | The `cardinality/two-live-runs` poison witness scheduled both corrupt runs in the future, so claim no-oped on them while an unrelated healthy trigger satisfied progress; neither the candidate CAS nor the same-token receipt tail enforced the sole-live-run rule | SQLite could claim and return both runs for one task and choose an arbitrary `last_attempt_run`, while PostgreSQL/MySQL would reject the multi-row scalar; after one legitimate claim, injecting a live sibling could still make a retry return the first run for launch | Claim eligibility, receipt semantics, poison non-vacuity, and the pluggability contract | A healthy durable delta proved only that the label could work, not that this poisoned subject reached the branch; the first guard repair covered only the CAS half; and SQLite's permissive scalar semantics masked the portability failure | The due witness and canonical `soleLiveRun(run)` gate both the candidate CAS and `picked` receipt tail; task-book uses `MIN(f.run_id) … HAVING COUNT(*) = 1` for a portable singleton; exact mutations `claim-requires-sole-live-run` and `claim-receipt-requires-sole-live-run` pin both halves (rungs 1 and 2) |
| 36 | Activation did not require the claimed run to remain its task's sole live run; the generated `activate × two-pending-runs` witness was vacuous because its target had never been claimed | After spawn→claim(T), injecting a pending live sibling still let activate return the original payload and set `activated_gen = 1`, so an already-issued worker could execute a task whose corrupt cardinality every later claim/receipt refused | Activation eligibility, poison temporal reachability, and lifecycle conformance | The first sole-live repair named claim and receipt but omitted the issued claim's activation door; the generated witness placed corruption before claim rather than between claim and activation | Activation composes canonical `soleLiveRun('runs')`; a targeted post-claim/pre-activate regression and exact `activate-requires-sole-live-run` mutation pin the temporal placement (rungs 1 and 2) |
| 37 | The sole-live filter sat outside each pending/sleeping candidate subquery's `ORDER BY … LIMIT` | An earlier due corrupt task consumed `limit: 1`, was rejected only afterward, and permanently starved a later healthy task even though claim returned no work | Claim selection construction, bounded-progress conformance, and the real query-plan surface | A late outer predicate looked equivalent for safety but did not define which rows were allowed to spend the budget; duplicated candidate legs made placement drift expressible, while hand-written plan stand-ins did not prove the shipped CAS | One `candidateEligibility` composition (eligible task + sole live run + wait unambiguity) appears inside both ordered legs before each limit; the existing exact mutation removes that shared predicate once; shared conformance pins progress and libSQL records/pins the shipped CAS's two `runs_poll` legs plus indexed sibling probes (rung 1 for the single representation, rung 2 for placement and behavior) |
| 38 | Finding 34's counter-coherence repair equated `numFailedTestSuites === 0` with zero failed files | A legitimate top-level failed assertion could have one failed test and failed file but zero failed nested suites, causing the mutation classifier to deny valid behavioral credit | Mutation report parser and reporter-semantics self-test | Vitest suite counters describe nested suites, not files; the repair overfit two unrelated aggregate domains because the fixture shape happened to align them | Suite counters retain their own internal arithmetic, while file status is checked against that file's assertion/message rows and exact test counters; the sixteenth classifier case pins the valid topology (rung 2) |
| 39 | `emit-replay-preserves-event-instant` expected a behavioral replay failure, but the mutant was structurally rejected during the initial emit | The audit reported wrong-path and the advertised replay verdict described a path that never ran, obscuring the stronger construction guarantee | Mutation verdict registry and exact-call wrapper | The verdict followed the downstream scenario story rather than the earliest load-bearing boundary the mutation crossed | The verdict is construction; `attributeExpectedFailure` wraps only the initial emit and translates only the exact emitted-instant preservation error to its marker (rung 2 attribution over the rung-1 builder guard) |
| 40 | `emit-index-driver` marked only the first of three plan assertions, while its mutation also changed semantics | An incidental assertion or behavioral change could kill a performance mutant without proving the shipped statement retained the intended access path | Mutation design and libSQL query-plan verdict | Three separate assertions split one verdict, and the counterexample was not behavior-preserving | One marked vector atomically asserts waits-index use, runs primary-key seeks, and no runs scan; the mutation adds logically redundant `run_id` correlation so only the plan changes (rung 2) |
| 41 | `emit-cleanup-follows-the-wake` expected a behavioral cleanup failure, but changing its fence to `event` was rejected by derived relation/source validation | The audit reported wrong-path and failed to credit the structural mechanism that made the invalid cleanup unconstructable | FencedBatch construction verdict and exact-call wrapper | The expected user-visible cleanup scenario sat below a builder boundary that rejected the mutant first | The verdict is construction and the exact emit call is wrapped for only the derived relation/source mismatch; the healthy behavioral assertions remain independent (rung 2 attribution over the rung-1 relation guard) |
| 42 | The dedicated `emit-wake-event-correlation` fixture was not discriminating; the pairwise wake surface killed the mutation under another marker | Coverage existed, but the mutation's claimed regression did not prove its own event-correlation property and received only wrong-path evidence | Wake-event regression and exact mutation verdict | The original rows let another wake condition decide the outcome, so a broader generated test—not the named regression—caught the change | The regression splits the legitimate A registration from the disjoint B driver row and carries its own exact marker, making removal of the run-event correlation change that assertion (rung 2) |
| 43 | Vitest omitted a custom message when the successor-attempt rejection assertion unexpectedly resolved | The intended behavior mutation reached its target, but the audit saw an unmarked framework assertion and classified it wrong-path | Promise-verdict test helper | The test relied on Vitest forwarding a custom message through the inverse promise outcome | `requireExpectedFailure` accepts only the exact healthy rejection, throws the exact marker on unexpected success, and propagates unrelated rejection (rung 2) |
| 44 | Vitest omitted a custom message when the claim sole-live resolution assertion rejected | The intended poison mutation reached its target, but its raw rejection lacked the attributable marker | Promise-verdict test helper and poison regression | A `.resolves` custom message was treated as an exact failure channel even though Vitest did not preserve it on rejection | `attributeExpectedFailure` converts only the exact claim/cardinality poison error to the marker and propagates every unrelated rejection (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Generated poison matrix on its first corrupt-state run (findings 1–3) | 3 | **yes** |
| `pnpm verify` through `lint-selftest` (finding 14) | 1 | **yes** |
| Full clean-tree mutation audit (findings 39–44) | 6 | **yes** |
| Initial adversarial implementation review (findings 4–13) | 10 | no |
| Late adversarial mechanism reviews (findings 15–38) | 24 | no |
| Existing conformance, fuzz, TLC, invariant, mutation, and lint gates before this round | 0 | — |

Self-catch rate: **10 of 44, or 23%**. The final PR3.6 residual round was **0 of
51, or 0%**; the preceding PR3.6 provenance round was **7 of 44, or 16%**.
The poison surface, verify gate, and full mutation audit are real movement:
this round exceeds the earlier 16% self-catch rate. Review still found
thirty-four of forty-four defects—**77%**—so outside review remains the majority
detector, but the final clean-tree gate itself now exposed six flaws that would
previously have required another reviewer.

## Recurrence

Findings 5 and 6 are the exact class deferred from PR3.6's typed-generator
review: independently spellable or insufficiently constrained relation halves.
The first repair paired names but still failed to bind the fence's source table
and admitted a denormalized ownership relation. The proxy was “the keys come
from one entry”; the property is “this stamped authoritative source proves
exactly these target keys.”

Finding 4 is the recurring count-as-authority error. Earlier row bounds detected
too many writes after execution; the proposed source-key audit moved the same
idea to distinct keys but still ran after commit. A count can diagnose a
property. It cannot make amplification unwritable, and it cannot express the
difference between several physical registrations for one run and several
unauthorized run keys.

Findings 8–10, 15–16, 22–23, 30, and 32–33 recur after the generated clock and
wake surfaces in the final PR3.6 round. Generation again created volume without
proving discrimination: rendered text stood in for tuple identity, finding
existence stood in for severity, SQL spelling or returned counts stood in for
state change, crossing an executor stood in for progress, and the after-state
stood in for authority. The correction attacks the oracle itself with fifteen
meta-tests rather than trusting the size of the matrix.

Finding 35 is the same progress/vacuity recurrence one altitude higher. A
healthy durable delta proved that claim could work, but not that the corrupt
subject was eligible for the claimed branch; future-dated witness rows made the
generated cell decorative. Making the witness due and attaching the exact
sole-live-run mutations proves both claim paths. The production guard is the
canonical eligibility fragment on the candidate CAS and the same-token receipt
tail, while the singleton task-book aggregate makes a guard regression
observable the same way on every dialect instead of relying on SQLite's
permissive scalar behavior.

Finding 36 is the temporal version of that recurrence. Crossing an activation
label with two pending runs looked like surface coverage, but activation
requires an already claimed target: the cell could not reach the door whose
guard it advertised. The targeted schedule establishes claim first, injects
corruption second, and activates last. Its mutation proves that exact ordering
instead of allowing a nearby generated state to represent it.

Finding 37 repeats the late-check proxy from finding 4 inside selection itself.
The sole-live predicate existed, but after each per-state limit it could protect
safety only by returning nothing; it could not protect bounded progress because
the corrupt row had already spent the budget. The property is eligibility
before selection. One composition now owns all three claim-candidate guards and
is inserted inside both ordered legs before either limit.

Finding 11 is the “every new layer needs its own fault surface” law in another
layer. `FencedBatch` already rejected a short executor vector, but invariants
implemented a separate reader and defaulted missing results to empty. The lower
layer's test could not protect a new consumer with different cardinality
semantics.

Finding 12 is another proxy/property recurrence. The final PR3.6 review found
positive axes hidden under a generated surface; this round initially counted
human-facing invariant names, allowing one branch to answer for several. The
fifty condition IDs close the currently declared arms. PR3.10 owns the next
ratchet: one red mutation per branch and enum literal, because an inventory
cannot prove that its own declaration is complete.

Finding 13 directly recurs after the prior postmortem claimed a
dialect-portable invariant evidence representation. That repair moved
provenance evaluation into TypeScript but left the other invariants using
SQLite concatenation and null/type operators. The mechanism protected one
projection while its prose claimed the library. The portable evaluator is now
the single representation for all conditions.

Findings 17, 18, and 21 show that “portable TypeScript” was itself still a
proxy for a portable conformance boundary. A present provenance instant was
not necessarily a valid integer; the same integer could arrive as number or
bigint; and a strict native column could reject corruption that SQLite permits.
The shared evaluator now owns canonical integer semantics while the fixture
seam owns whether invalid storage can be injected at all.

Findings 24–28 repeat the single-representation lesson inside the builder.
Nonempty provenance suffixes approximated the builder grammar, two regexes
represented one wire rule, and a textual SET fragment plus a blacklist
approximated the set of legal assignments. The final shape shares one name
grammar and generates assignment left-hand sides from a closed per-table list,
excluding both provenance and public identity.

Findings 14, 19, 20, 29, 34, and 38 are checker-mechanism recurrences. A
self-test that failed for missing repository files, a matching assertion beside
a suite error, an internally contradictory success report, malformed or
misrelated status/accounting fields, and an unconstrained heavy runner could
all make the verifier report evidence other than the property it claimed.
Sixteen classifier cases, six injected faults, separated classifier/live-
inventory modes, type-safe report-consistency checks, and internal confinement
attack those paths.

Findings 39–44 are the next altitude of the same attribution class. A perfect
report parser cannot recover evidence a test never emits. Findings 39 and 41
named a downstream behavioral story although construction was the first
load-bearing boundary. Findings 40 and 42 treated “some assertion kills this
mutation” as equivalent to the mutation's exact plan or wake verdict. Findings
43 and 44 trusted framework custom-message propagation for inverse promise
outcomes. The full audit—not the inventory or classifier self-test—was the
first mechanism that executed every mutation far enough to expose all six.

Finding 31 is the recurring undocumented-exception class. A narrow atomic emit
waiver may be correct, but code alone cannot own a protocol exception. DESIGN
now names its exact condition and structured identity; widening it is therefore
a spec change rather than an unremarked test edit.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Closed `FENCE_RELATIONS`, source-table check, and exact self seal | 1 inside `FencedBatch.derived()` | No caller of the typed builder can independently spell the paired keys or seal a different source key. A direct `raw.batch("bypass", [{ sql: "DELETE FROM waits WHERE task_id = ?", args: [taskId] }], "write")` remains outside this boundary; the poison oracle, not the relation type, must catch that adjacent bypass. |
| Structural `source-keys` selection | 1 inside generated follow-ons | No generated follow-on can widen its distinct logical keys beyond the stamped source selection. The hand-written `wake-runs` statement still uses `{ many: reason }`; a stale wait shaped to satisfy its textual predicate remains the explicit PR3.8 false negative. |
| Non-mergeable self-source materialization | 1 for the generated SQL shape | No direct target-table subquery can be emitted for a registered self relation. A future dialect can still reject another otherwise portable construct; real-dialect conformance, not this shape, owns that boundary. |
| Closed per-table generated assignments and shared stamp-name grammar | 1 inside the generated builder | No generated caller can spell a left-hand side outside the contract or emit a stamp suffix outside the shared grammar. Hand-written `followOn()` and direct executor SQL remain adjacent raw surfaces; PR3.9's SQL AST and the poison oracle own them. |
| Exact mutation verdict attribution, 16 classifier cases, 34/34 clean-tree audit, typed report consistency, and internal confinement | 2 | A different causal defect can still make the exact expected test throw the exact expected marker, and the audit attacks only the current 34 registered mutations. A structurally consistent forged report can still lie that Vitest ran the intended code; suite arithmetic cannot be mapped to file counts without reporter topology. The wrapper also proves only that `scripts/confine.sh` was invoked, not that the cgroup implementation enforces the intended limits. |
| Exact-call construction wrappers, one marked plan vector, split A/B wake witness, and explicit promise-failure helpers | 2 | An unrelated defect can still produce the same exact construction or poison regex. The plan vector proves only its three declared access-path properties, and the A/B fixture proves only the declared event-correlation topology; a new plan or row axis needs its own mutation and witness. |
| Per-call six-table durable-delta progress floor | 2 | A store call can write and restore the same row before its after-snapshot, or produce an external side effect outside the six tables; both are invisible. Unlike the retired SQL/row-count proxies, CTE DML, SELECT rows, and no-op DML are decided by the durable state property itself. |
| Structured row keys, finding identities, and frozen before-state authority | 1 for representation; 2 for oracle coverage | Two tuples cannot collide merely because components contain separators. A relationship column omitted from the explicit authority schema, or a new table absent from the six-table snapshot, can still change without this oracle noticing. |
| Canonical exact-integer comparison and condition-specific numeric severity | 1 for number/bigint identity; 2 for severity | A newly added numeric condition that falls through to the default severity still treats every surviving instance as severity one. Its exact metric needs a meta-test like the deadline-delta and provenance-span attacks. |
| Portable `injectStorageCorruption` disposition | 1 at the fixture contract | A broken strict-dialect fixture can falsely report `structurally-rejected` without attempting the native write. That dialect's schema gate must prove the physical constraint independently. |
| Typed 50-condition inventory and poison completeness | 1 for IDs; 2 for coverage | Removing `cancelled` from a terminal-state set while retaining the `failed` witness can leave `terminal-task/live-run` covered. PR3.10 adds a red mutation per claimed branch and enum literal because inventory membership alone is a proxy for semantic completeness. |
| Exact invariant and poison snapshot result shapes | 3 | An executor returning the right number of correctly shaped but false row sets passes shape checks. Dialect fixture/schema gates and the same-scenario cross-dialect suite must establish that each adapter projects real canonical values. |
| Exact atomic emit exception | 1 for condition/run identity; 2 for semantic scope | Another defect that creates `wait/fired-event` on any wait under that same structured poisoned-run component during `emit-event` is also waived. The narrow run identity prevents cross-run exemptions; only PR3.8's active-wait identity removes the underlying inference. |
| Shared suspension cleanup and authoritative cancelled-run relation | 1 inside the current store transitions | A future suspension implementation that writes SQL without calling the shared helper remains expressible until the store surface or label inventory enrolls it. The source-harvested label and poison inventories are the adjacent build-time controls. |
| Canonical `soleLiveRun` on claim CAS, receipt, and activation; singleton task-book projection; due/temporal regressions; three exact mutations | 1 for predicate/projection representation; 2 for door enrollment and attacks | The guards enforce only live-run cardinality at these doors, not other ownership, queue, or state invariants, which retain separate witnesses. A fixture that lies about the rows it inserted could also make a case vacuous despite the mutation marker. |
| Pre-limit `candidateEligibility`, bounded-progress conformance, and shipped-CAS plan proof | 1 for the shared candidate composition; 2 for placement, behavior, and plan assertions | A new claim candidate leg could omit the composition unless its conformance and mutation inventory is extended. The recorded SQLite plan also cannot prove that a future MySQL/PostgreSQL optimizer uses an equivalent physical plan; their real-dialect suites own that boundary. |

## Fix-induced defects

**Twenty-four findings were induced by repairs earlier in this round: 13, 15,
16, 18, 22, 23, 25, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
42, 43, and 44.** The portability repair
initially accepted ISO strings and unrestricted projections, then compared
canonical integers by JavaScript representation. Authority and
finding-identity repairs first flattened tuples. The progress repair moved from
label presence to a DML prefix and then toward affected-row metadata before
reaching per-call durable state deltas. Grammar and generated-assignment
repairs briefly retained second definitions, quoted-name proxies, and public
identity. The atomic emit and same-identity severity repairs were initially
broader or shallower than the properties they claimed. The report-coherence
repair initially reconciled top-level success without reconciling all nine
counters and per-file status, then assumed status was a string and equated
nested-suite counters with file totals. The future-dated two-live-run witness and
unrelated healthy progress path then made the new claim cell vacuous, exposing
an older store bug only after review forced the witness onto the branch. The
first repair then guarded the candidate CAS but not the same-token receipt,
creating the second red path inside finding 35. Even that expanded repair
described only claim and receipt, leaving activation of an already-issued claim
as finding 36's third door. Its candidate guard also sat at a semantically late
outer boundary until finding 37 moved the shared property before both limits.
The attribution surface then mislabeled two structural kills, split a plan
verdict, gave one mutation semantic collateral, retained a nondiscriminating
fixture, and delegated two exact markers to framework behavior. The full audit
found those six defects in the new verdict machinery itself.

That count is not discounted because the defects lived briefly or only in test
machinery. Each repair was a new change and was re-reviewed as new code. The
fifteen oracle meta-tests are the executable result of that re-review rather
than evidence that the first repairs were safe.

## Evidence

- The audit's six wrong-path results are preserved in a separate red commit.
  Their attribution fixes and the final 34-of-34 audit evidence land in the
  paired green commit.
- The first generated poison run produced four red cells. Three reproduced
  findings 1–3. The fourth was an `expire-lease-now` oracle-boundary case, not
  a fourth store defect: the advisory call had no eligible target, so progress
  had to be demonstrated on a separate healthy trigger.
- Reverting the three structural builder protections made three focused tests
  fail: relation source-table mismatch, exact self-key sealing, and MySQL
  self-source materialization. Restoring them made the core/generated-selection
  set green.
- The earliest poison-oracle attacks were run against the pre-hardening
  mechanisms and failed on short invariant vectors, label-with-no-write,
  after-state authority laundering, positive-counter worsening, and
  negative-counter worsening. Late review expanded the surface to fifteen
  cases covering malformed vectors, bigint adapters, strict storage rejection,
  CTE/SELECT/no-op progress, tuple collisions, and both exact numeric
  worsening gaps.
- `pnpm verify` caught finding 14 in the first lint-selftest integration. The
  accepted path and all six injected classifier faults now use the isolated
  classifier mode; the live mode additionally checks every mutation address,
  marker, and internal confinement prefix.
- Finding 34's controlled classifier case was observed red as “expected
  wrong-path, got caught” when a failed assertion was contradicted by passed
  file status and aggregate counters. After requiring all nine counters and
  every related status/accounting view to agree, that path was green. A
  malformed `status: []` fixture was then observed red as
  `TypeError: unhashable type: 'list'`; type-checking status before category
  lookup made it return `wrong-path`.
- Finding 35 changed both `cardinality/two-live-runs` witness deadlines from
  `NOW + 60_000` to `NOW`. The focused
  `claim does not amplify cardinality/two-live-runs` case then failed because
  both poison runs changed without quiescing. With the canonical sole-live
  eligibility guard and singleton task-book aggregate in place, that case was
  green; the exact `claim-requires-sole-live-run` mutation was caught by the
  same assertion. A second red test first claimed one run with token T, then
  injected a pending live sibling: retrying claim(T) returned the first run
  under marker `claim-receipt-requires-sole-live-run`. Gating the `picked`
  receipt tail on the same fragment made it green, and a second exact mutation
  now pins that half. The classifier self-test remained green.
- Finding 36 first spawned and claimed with token T, then injected a pending
  live sibling. `activate(original claim)` was observed red: it returned the
  payload and set `activated_gen = 1` under marker
  `activate-requires-sole-live-run`. Gating activation with
  `soleLiveRun('runs')` made the regression green; its exact mutation is caught
  by that same temporal assertion.
- Finding 37's shared conformance regression placed an earlier due task with
  two pending runs ahead of a later healthy task, then called `claim(limit: 1)`.
  Red returned `[]`; green claimed the healthy run after one
  `candidateEligibility` composition moved inside both ordered legs before
  their limits. The existing `claim-requires-sole-live-run` mutation removes
  the shared predicate once and breaks both legs. Query-plan coverage now
  records the shipped CAS and pins at least two `runs_poll` uses,
  `runs_task_attempt` sibling probes, and no sibling scan.
- Finding 38's classifier case, `matching top-level assertion without a failed
  nested suite`, was observed red as “expected caught, got wrong-path” for a
  legitimate report with one failed test/file and zero failed nested suites.
  Removing the suite-to-file equivalence made it green while retaining internal
  suite arithmetic, exact test counters, and file-to-assertion/message checks.
- The first clean-tree source-mutating audit ran all 34 entries and reported
  **28 attributable, six wrong-path**. Findings 39 and 41 were the two
  construction rejections; moving `attributeExpectedFailure` to the exact emit
  call and matching only each builder error gave them exact construction
  verdicts.
- Finding 40's three plan checks became one marked vector, and its mutation now
  adds a logically redundant `run_id` correlation so it changes the access path
  without changing the selected rows. Finding 42's wake fixture now separates
  the legitimate A registration from the disjoint B driver row and fails under
  its own event-correlation marker.
- Findings 43 and 44 reproduced Vitest's missing custom message on unexpected
  resolve and rejection. `requireExpectedFailure` now turns only unexpected
  success into the successor marker; `attributeExpectedFailure` turns only the
  exact claim/cardinality poison error into the sole-live marker. Both propagate
  unrelated errors.
- Current executable inventories are 50 invariant condition IDs, 47 poison
  witnesses crossed with 17 labels (799 generated cells and 801 poison cases
  including two inventory tests), fifteen poison/invariant meta-tests, and
  sixteen classifier cases over 34 live mutations plus six injected faults.
  After the six attribution fixes, the full audit completed **34 of 34
  attributable**, with no wrong-path result or survivor.
- Finder verdict: “The residual mechanisms still admitted post-commit proxy
  checks, source-table/key mismatches, colliding row and finding identities,
  vacuous or metadata-only poison progress, after-state authority laundering,
  fail-open invariant and mutation reports, SQLite-only corruption setup,
  caller-controlled provenance/identity assignments, undocumented display-name
  exceptions, unconfined heavy runs, and same-identity severity gaps.”
- Final finder verdict: “The advertised claim × multiple-live-runs poison cell
  was vacuous and missed a real portability/correctness path.”
- Re-review verdict: the generated activation × two-pending-runs cell was
  vacuous because its target was unclaimed; it did not cover corruption
  introduced between claim and activation.
- Claim-analysis verdict: an earlier corrupt candidate could consume the bound
  before a late sole-live filter, permanently starving later healthy work.
- Disconfirmed or reclassified claims: multiple physical waits for one stamped
  run are legal, so a physical-row cap was rejected in favor of a distinct-key
  construction guarantee; the initial advisory-expiry red cell was an oracle
  non-vacuity defect rather than a store mutation; a strict native rejection is
  a stronger valid result, not a missing poison cell; ISO temporal strings were
  rejected rather than accepted as a cross-dialect representation because the
  conformance boundary requires canonical epoch milliseconds; and SQL prefixes,
  statement tags, returned SELECT rows, and DML row counts were all rejected as
  progress proxies in favor of a per-call durable six-table delta.

## Root cause

Each escaped mechanism attached proof to a nearby observable instead of to the
authority that caused the write. A post-commit count approximated selection
reach. A relation name approximated source provenance. A called label
approximated progress; then a DML prefix and row count approximated durable
change. Delimiter-joined text approximated row and finding tuples. A finding's
existence approximated its numeric severity. JavaScript type approximated exact
integer value. An after-state owner approximated before-state authority. A
display name approximated every semantic branch and one atomic exception.
Column-name blacklists approximated a closed assignment language, and a
result-array lookup or matching assertion approximated complete healthy
verification. A healthy sibling transition approximated reachability of the
poisoned subject, a generated pre-state approximated a required temporal
schedule, an outer eligibility filter approximated pre-limit selection, and
SQLite's arbitrary multi-row scalar choice approximated a portable singleton.
One reporter aggregate domain also approximated another domain's hidden
topology. Finally, a scenario's downstream story approximated its earliest
failure boundary, “some assertion killed the mutant” approximated the exact
verdict, and a framework custom message approximated a reliable promise-failure
channel.

The common repair is to move proof toward the source: the contract owns both
ends of a relation; source-table provenance travels with the fence; the target
selection is generated from source keys; protected authority is frozen before
execution; tuple identities stay tuples; exact integers normalize without
precision loss; legal assignment targets and stamp names come from closed
contracts; condition IDs name atomic evaluator arms; progress is a durable
per-call state delta; and mutation credit requires a globally coherent report
and the exact assertion path, with types checked before classification and only
reporter-defined relationships compared. Exact-call wrappers name the first
load-bearing failure, plan properties share one marked vector, mutation subjects
preserve unrelated behavior, and promise helpers emit markers themselves.
Claim candidates, receipts, and activation structurally require one live run;
due and post-claim/pre-activate regressions prove those guards on the corrupt
subject, while the single candidate composition places eligibility before both
bounded legs. Where a structural representation is possible it is used. Where
only an oracle is possible, that oracle receives its own generated
false-positive surface.

## Mechanisms

Built in this PR:

- Five frozen authoritative fence relations, source-table validation, exact
  self-key sealing, and structural source-key bounds in `FencedBatch` (rung 1).
- Closed per-table generated assignment left-hand sides excluding provenance
  and public primary identity, plus one shared statement-name grammar for
  builder tokens and persisted stamps (rung 1).
- Non-mergeable derived self-source reads shared by SQLite, MySQL, and
  PostgreSQL SQL generation (rung 1, with rung-2 shape tests).
- One suspension cleanup chokepoint and cancellation cleanup derived from
  actually stamped run IDs (rung 1).
- Canonical sole-live-run eligibility on claim CAS, receipt tail, and
  activation, plus a portable singleton task-book aggregate, attacked by a due
  two-live-run witness, a post-claim/pre-activate regression, and three exact
  mutations (rungs 1 and 2).
- One pre-limit `candidateEligibility` composition shared by the pending and
  sleeping claim legs, with a shared bounded-progress conformance regression
  and libSQL recorded shipped-CAS plan assertions (rung 1 for the single
  representation; rung 2 for placement, behavior, and plan).
- Thirty-four exact mutation verdicts parsed from structured Vitest output, a
  sixteen-case classifier, typed nine-counter/file/assertion consistency checks,
  six injected false-positive faults, separate classifier/live-inventory
  modes, internally confined baseline/mutant suites, exact-call construction
  wrappers, one marked emit-plan vector, a split A/B event witness, and explicit
  require/attribute promise helpers. The full clean-tree audit is 34 of 34
  attributable (rung 2).
- One portable invariant evaluator with 50 typed condition IDs under 23 display
  names, structured finding identities, exact safe-number/bigint comparison,
  and fail-closed five-result projection shape (rungs 1 and 3).
- A portable `injectStorageCorruption` fixture seam whose two explicit outcomes
  distinguish injectable corruption from a strict schema that makes the
  forbidden representation unwritable (rung 1).
- A 17-label by 47-witness poison matrix: 799 generated cells and 801 cases
  including inventory, with tuple-keyed before-state authority, explicit
  insertion ownership, per-call six-table durable-delta progress,
  live-run/cardinality barriers, exact claim sole-live mutations, exact
  condition/subject deltas, and numeric severity for counters, deadlines, and
  provenance spans. Fifteen adversarial oracle meta-tests attack the surface
  (rung 2).
- One narrowly documented atomic emit exception keyed by condition ID and the
  structured poisoned-run component, never by public display name (rungs 1 and
  2).

Deferred (recorded in BUILD.md):

- PR3.8 adds immutable active-wait identity and removes the sole raw generated-
  follow-on exception, `emitEvent`'s `wake-runs` (rung 1). The migration and six
  transition changes are a new protocol and therefore remain spec-first.
- PR3.10 adds one attributable red mutation per semantic branch and enum
  literal. The current condition inventory makes declared arms independently
  witnessable, but cannot prove that its own declaration omitted nothing
  (rung-2 ratchet toward the property).
- PR4.1 owns real MySQL/PostgreSQL adapter normalization and physical schema
  gates. The shared contract is now expressible without SQLite operators, but
  only the real dialect matrix can prove each native projection and each
  `structurally-rejected` claim.

## What this round still would not catch

A defect omitted from both the invariant evaluator and its 50-condition
inventory can still ship; a surviving enum literal under an otherwise covered
condition is the concrete example and PR3.10 owns it. The 34-of-34 audit covers
the registered subjects, not mutations the inventory never declared. A
mutation can also receive the expected file/name/marker—or the same exact
construction/poison regex—because a different causal defect failed there.
Attribution makes wrong-path failures much harder to credit, not logically
impossible.

The poison oracle compares per-call durable snapshots, so a write that escapes
authority and is restored within one call, or an external side effect not
represented in the six tables, is outside its view. Its 47 witnesses also
cannot generate a corruption axis nobody declared, and a strict fixture could
falsely claim structural rejection unless its dialect schema gate attacks that
claim. The sole-live-run guards address only claim/activation-time live
cardinality; they do not replace the separate ownership, queue, and state
witnesses. The pre-limit construction covers the current pending/sleeping
candidate legs, but a future leg still needs structural enrollment and a real
dialect optimizer still needs its own plan suite. The atomic
emit waiver cannot distinguish another defect that creates the exact same
condition on another wait under the poisoned run. Finally, `wake-runs` still
proves current registration by correlated fields rather than immutable
identity. PR3.8 is the sole remaining raw wake follow-on and the structural
answer to that specific residual.
