# Postmortem: two store bug classes, and why the machinery missed them (PR #11)

Across six adversarial codex rounds against PR #11, review found eleven store
correctness bugs that reduce to two classes:

- **Two NOWs in one batch.** Statements independently compute values or
  eligibility decisions that must share one database instant. Real libSQL and
  MySQL can advance between statements, while fake-now tests cannot.
- **A losing batch still writes.** A hand-written follow-on treats a
  pre-existing post-state as evidence that this invocation's guarded write
  won, so stale, duplicate, or corrupted input is amplified.

The common cause was structural. `spawn`, `claim`, `activate`, `awaitEvent`,
and `emitEvent` hand-rolled `this.db.batch([...])` instead of using
`FencedBatch`, the primitive intended to mint one stamp, read one time, and
make follow-ons depend on the winning write. The sweep had already migrated;
these operations remained outside that boundary, and no build rule forced the
migration.

## Severity

None of the eleven had shipped, but six review rounds finding the same two
classes is a machinery failure. Class A could silently mis-schedule a real
cancellation or timeout by one statement's clock drift. Class B let corrupt or
racing input create orphan waits, mutate terminal tasks, create runs for tasks
the invocation did not insert, or turn a losing transition into durable state.
Each failure is quiet and can leave later reads looking ordinary.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Round 1: `awaitEvent` registered a wait under a weaker guard than its park | A refused park leaves an orphan registration on a running run | Await-event conformance and wait invariants | Healthy fixtures made both guards win; no invariant rejected a wait on a non-sleeping run | Align the immediate guards, then structurally derive registration and park from one winner (rungs 1 and 3) |
| 2 | Round 1: the await task mirror accepted any sleeping run id, regardless of task ownership | An unrelated sleeping run flips the caller's task to sleeping | Referential invariants | No full run, wait, and task witness existed | Bind the mirror to run and task; later generate the write from invocation provenance (rungs 1 and 3) |
| 3 | Round 2: the repair for finding 1 evaluated cancellation eligibility in both the wait insert and park | A deadline between two reads registers a wait that the park refuses | Clock-aware conformance | Predicate text was shared, but its database-time decision was not; fake-now made both evaluations equal | Make one eligibility decision and derive the second statement from its post-state (rung 1 for the transition) |
| 4 | Round 2: wait `timeout_at_ms` and run `available_at_ms` each computed database now plus timeout | Timeout scheduling can occur after its own recorded deadline | Wait-integrity invariant | No checker compared the two fields, and fixed clocks erased drift | Compute once, copy the stored deadline, and add deadline-equality invariant coverage (rungs 1 and 3) |
| 5 | Round 3: reordered wait registration keyed on sleeping state plus `wake_step`, which a preserve reschedule could leave behind | A stale invocation recreates a wait although its own park matched no row | Duplicate-call and post-transition fence tests | Replay identity was mistaken for batch authorship | Fence registration on the live claim token and derive the park from that registration (rung 1 for this path) |
| 6 | Round 4: the task mirror fired whenever the run was already sleeping, even when this invocation's park lost | A stale call changes a still-running task to sleeping | Transition-write instrumentation | The same-value follow-on left a coherent quiescent state and exposed no outcome proving it ran | Stamp the park per invocation and fence the mirror on that stamp; later use dedicated provenance (rung 1) |
| 7 | Round 5: a same-token claim receipt updated a terminal task from a corrupt live run | A completed task is revived to running and handed back for launch | Rule-6 corrupt-pre-state coverage | Tests generated only legally reachable states; invariants observed corruption but did not drive claim through it | Require a live task in claim receipt and return; add the poison pre-state surface (rungs 1 and 2) |
| 8 | Round 5: a losing duplicate activation re-armed a terminal task's cancellation deadline | A completed task becomes cancellable again | Rule-6 corrupt-pre-state coverage | The follow-on trusted run state and did not guard task liveness; no fault dimension seeded terminal-task/live-run corruption | Require a live task and later derive from activation provenance; add poison coverage (rungs 1 and 2) |
| 9 | Round 6: spawn's initial run insert did not prove the task insert won | A task-id collision or idempotency hit can book a run under pre-existing task state | Collision and duplicate-injection coverage | Existing collision cases did not cross both task identity and losing-insert provenance | Fence the run on a live task with no prior run; later route spawn through per-statement provenance (rung 1) |
| 10 | Round 6: await park borrowed a pre-existing wait row even when this invocation registered nothing | A stale or mismatched wait parks a run for the wrong event or under a terminal task | Duplicate and corrupt-pre-state coverage | Wait existence stood in for authorship; healthy fixtures made the wait belong to the call | Require the event and live task immediately; later fence on the wait this invocation inserted (rung 1) |
| 11 | Round 6: activate derived lease expiry and task cancellation deadline from separate database-time reads | A claim can expire at one instant while cancellation is armed one millisecond later, selecting the wrong sweep transition | Clock-jitter and cancellation conformance | All clocks were fixed, and TLA had one logical instant per atomic action | Derive both values from the run's single stored activation instant; later enforce one clock source per fenced batch (rungs 1 and 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Codex round 1 | 2 | no |
| Codex round 2 | 2 | no |
| Codex round 3 | 1 | no |
| Codex round 4 | 1 | no |
| Codex round 5 | 2 | no |
| Codex round 6 | 3 | no |
| Existing conformance, fault matrix, fuzz, invariants, and TLC | 0 | yes |

Self-catch rate: **0 of 11, or 0%**. The preceding events review was also
**0%**, so six more passes did not improve the project's own detection rate.
Red regressions written after each review report prove the behavior; they do
not become self-catches.

## Recurrence

Class B recurred in rounds 1, 3, 4, 5, and 6. The repository already had
`FencedBatch` and prose warning that hand-rolled batches caused the historical
losing-sweeper race, but neither mechanism reached these five operations. The
primitive made the bad shape unwritable only for callers that used it; the
standing rule was a memory aid, not a structural enrollment rule. Round 4
even hand-built a `parkStamp`, recreating the primitive locally and proving
that the missing scope, not the primitive's idea, was the problem.

Class A recurred in rounds 2 and 6. The first point fix derived one deadline
from another but left every other hand-written batch free to read `NOW`
twice. Fake-now was a proxy for deterministic engine time, not an adversarial
implementation of the rule that a multi-statement transition has one logical
instant.

Both classes therefore recurred after local fixes. The fixes repaired
instances; no mechanism forced the next operation through the same property.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Historical `batch-lint` with frozen `FENCED_DEBT` | 2, syntactic | `this.db.batch('await-event', [losingCas, followOnBorrowingOldState])` passed because `await-event` was one of five explicitly accepted debt labels. The lint made new debt visible but allowed every bug in the existing debt set |
| Historical raw-batch label harvest | 2, syntactic | `this.db.batch('await-' + 'event', statements)` was invisible to the quoted-literal regular expression. A computed label could carry a multi-statement write without entering either classification set |
| Historical `clock-lint` | 2, syntactic | Two separate statements each interpolating the sanctioned `${NOW_MS}` contained no raw clock function, so the exact two-NOW class passed |
| Fake-now conformance and fault matrix | 3 | `INSERT ... ${NOW_MS}; UPDATE ... ${NOW_MS}` returns the same fixed value for both reads. The test passes even though production time can advance between them |
| Quiescent invariant library | 3 | A batch can write a same-value mirror, or insert and then delete an orphan row, and leave the final snapshot invariant-clean. The transition violated “a loser writes nothing” without leaving a state violation |
| TLA atomic action mapping | Model assumption, not an implementation rung | Modeling both statements as one action with one `now` proves the intended protocol while the SQL reads two instants or lets one follow-on fire. The refinement boundary is assumed, not checked |
| Point fixes using live guards or borrowed stamps | Claimed 1 locally | `UPDATE tasks ... WHERE EXISTS (SELECT 1 FROM runs WHERE state='sleeping')` still passes every unrelated live-state guard while borrowing an older park. Finding 6 is the executed counterexample to hand-assembled provenance |

## Fix-induced defects

**Two of eleven.** Finding 3 was introduced by the first repair for finding 1:
it copied `eligibleTask` into the wait insert while the park continued to
evaluate the same clock-dependent predicate separately. Finding 5 was
introduced by the repair for findings 3 and 4: reordering the batch removed
clock drift but keyed registration on a sleeping `wake_step` state that could
pre-exist.

The remaining nine were latent in the original or adjacent hand-written
batches. The two induced repairs were re-reviewed as new code, which is how
the later rounds found them; merely rerunning the fixed-clock suite would not
have done so.

## Evidence

- Round 1: red `b442b34`, green `59d5ca0` for orphan registration and wrong
  task mirror.
- Round 2: red `ed28b2b`, green `534f1f6`. The red commit specifically
  demonstrated the missing timeout/availability invariant. The codex review
  separately reported the duplicated eligibility read. The recorded green
  gate was 320 tests plus a 2,000-seed fuzz.
- Round 3: red `a8875db`, green `348c374`; recorded green gate was 321 tests,
  a 2,000-seed fuzz, and TLA.
- Round 4: red `a959377`, green `6d30202`.
- Round 5: red `36ecdf5`, green `3ef0403`.
- Round 6's three reproductions and repairs landed together in `2146519`; its
  commit records each case run red against the prior code and green after,
  followed by `pnpm verify` with 326 tests and a 2,000-seed fuzz. There is no
  separate red commit for these three, and this retrofit does not invent one.
- Root-cause controls and this original postmortem landed in `9e6eaff`.
- The reported bugs all reproduced. The separate round-6 SDK zombie-emit
  finding fixed in `a33470b` is not one of these eleven because it is neither
  a two-NOW store batch nor a losing store follow-on.

## Root cause

Every test, fault cell, and refinement run exercised transitions under a
fixed clock and legally reachable starting state. That made per-statement
time drift unobservable and never presented the corrupt pre-states needed to
show a loser amplifying state. Quiescent invariants could not see same-value
or transient writes. TLA correctly proved one atomic action with one logical
clock, but the hand-written SQL sat outside the primitive that was supposed to
realize that action.

The root structural failure was unenforced migration scope: a correct
primitive existed, but five protocol operations did not have to use it.

## Mechanisms

Built in `9e6eaff`:

- `scripts/batch-lint.py` (rung 2): every raw store batch label had to be
  classified; new multi-statement writes could not appear silently, and the
  five existing offenders became a visible shrink-only debt set.
- `scripts/clock-lint.py` (rung 2): raw SQL wall-clock functions were banned
  outside `time.ts`, leaving `NOW_MS` as the one named source.
- Point fixes derived deadlines and follow-ons from earlier state and added
  rule-6 liveness guards.

Deferred in `BUILD.md` as PR3.6 work:

- Route `spawn`, `claim`, `activate`, `awaitEvent`, and `emitEvent` through
  `FencedBatch`, then delete the debt set.
- Add a per-statement clock-jitter executor across conformance and the fault
  matrix.
- Add a generated poison surface crossing every write label with
  invariant-forbidden pre-states.

## What this round still would not catch

Every existing label in `FENCED_DEBT` could still contain a losing follow-on
and pass. Two uses of sanctioned `NOW_MS` in separate statements still passed
clock lint. A computed batch label could evade the original label harvester.
Fixed-clock tests still erased drift; legal-state generators still omitted
corrupt inputs; quiescent invariants still missed transient writes. The
historical controls made the migration debt visible and prevented it from
growing, but only the deferred FencedBatch migration, jitter executor, and
poison surface could close the properties themselves.
