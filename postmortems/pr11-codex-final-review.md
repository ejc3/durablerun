# Postmortem: the codex final-head review of PR #11

Before merging PR #11, a fresh codex review ran against the branch's actual
final head, not the implementation head seen by the original events review.
That tree had moved through five bug fixes, three prevention mechanisms, and a
simplification pass. Codex returned **DO NOT MERGE** with eight reports: six
confirmed correctness bugs and two refuted claims with real hardening
residuals. Re-reviewing the repairs found two more bugs and one benign legacy
claim; reviewing that repair found one fix-induced regression. This is a
review-caught SEV round and evidence that a review of an earlier head cannot
attest the code eventually merged.

## Severity

The worst confirmed defect deadlocked a task that awaited the same event name
twice and timed out. Another let a durable operation nested inside a step
silently corrupt replay keys. Others left orphan waits on running runs,
mirrored a task to sleeping based on an unrelated run, accepted names that did
not round-trip through storage, and let corruption pass the engine's own
invariants. The second and third passes then showed that repairs themselves
could reintroduce orphan writes through two database-time reads and a
pre-existing post-state.

None shipped. The important machinery failure is that the original review was
real and useful but stale: it could not find bugs in code written after it
ran.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Confirmed: a carried wake matched the event name, not the await's step key; two same-name awaits deadlocked after timeout | A run never completes and burns a pass per timer fire | Replay-equivalence harness | Generated programs did not repeat the same event name with a timeout; structural wake-step binding was a known deferral | `wake_step` binds delivery to one await, and generated programs repeat same-name timed awaits (rungs 1 and 3) |
| 2 | Confirmed: the wait insert guarded only `running`, while the park used stricter task eligibility | A refused park leaves an orphan waiting row and later emit mutates inconsistent state | Wait invariants and await-event conformance | No invariant rejected a waiting row on a non-sleeping run, and the two statements duplicated their eligibility decision | Give registration and park one winning-state derivation; add wait-on-non-sleeping-run coverage (rungs 1 and 3) |
| 3 | Confirmed: the task mirror checked that the supplied run was sleeping but not that it belonged to the supplied task | A mismatched call flips a caller task to sleeping on an unrelated run | Wait referential invariants | Existing checks did not bind the parked run, wait, and task as one witness | Fence the mirror to run and task; add wait/wake identity invariants (rungs 1 and 3) |
| 4 | Confirmed: await or sleep inside `ctx.step` changed replay counters instead of failing | Durable replay keys diverge between first execution and replay | Step reentrancy guard | `inStep` rejected only nested `step()`, so every other durable method could bypass it | One `enterDurableOp` chokepoint rejects every replay-key-bearing durable operation inside a step (rung 1) |
| 5 | Confirmed: `UserName` accepted embedded NUL and lone UTF-16 surrogates | A stored name fails to match its wake, or two inputs collapse to one storage value | `UserName.parse`, the single mint point | It checked only replay-key separators, not storage round-trip | Reject NUL and lone surrogates at the mint point (rung 1) |
| 6 | Confirmed: `wait-for-fired-event` represented only one conjunct of TLA `WaitIntegrity` | Findings 2 and 3's corrupt states produced no invariant violation | Invariant library and guard-twin mapping | One named check stood in for a multi-conjunct model invariant | Add the missing wait-integrity conjuncts and make payload comparison NULL-safe (rung 3) |
| 7 | Refuted: SQL NULL appeared to be both emitted payload and timeout sentinel | The report predicted a NULL emit could false-time-out a waiter | Typed emit boundary | The public `payloadJson: string` boundary made the reported NULL payload unreachable, but the database had no structural non-NULL guarantee | Record and later add a schema/emit-boundary non-NULL guarantee; NULL-safe invariant hardening landed (deferred rung 1) |
| 8 | Refuted as reported: a non-serializable result appeared to become an infrastructure retry loop | The report predicted all infrastructure retries would be consumed | Batch compiler and worker error classifier | `FencedBatch.compile` coerced `undefined` to NULL before binding, so the reported store error did not occur; the real residual was silent completion with NULL | Canonicalize and classify handler results at the source (deferred rung 1) |
| 9 | Confirmed on fixed-head re-review: wait insert and park evaluated cancellation eligibility against separate database times | A deadline between the reads registers an orphan wait that the park refuses | The first repair for finding 2 and clock-aware conformance | Sharing predicate text was mistaken for sharing one decision; fake-now made the reads identical | Evaluate eligibility once and derive the second statement from the winner's post-state (rung 1 for the resulting shape) |
| 10 | Confirmed on fixed-head re-review: wait timeout and run availability each computed `NOW + timeout` | The run can wake after the wait's own registered deadline | Wait-integrity invariant and production-clock testing | Fake-now hid per-statement drift, and no invariant compared the two stored deadlines | Copy one stored deadline across statements; add wait-timeout-availability-mismatch (rungs 1 and 3) |
| 11 | Refuted as reachable: pre-v3 wake decode fabricated a step from event name when `wake_step` was NULL | A hypothetical legacy row would not match the SDK's prefixed replay key | Schema migration and decode boundary | Events and `wake_step` were believed to arrive together, so the branch was considered unreachable; the fallback nevertheless encoded a misleading second representation | Decode a wake only when both event and step are present; legacy behavior remained an explicit compatibility boundary (rung 1 for current rows) |
| 12 | Confirmed on the reorder's re-review: the reordered wait insert keyed on `wake_step` and sleeping state that could pre-exist | A stale call recreates a wait even though its own park lost | Post-transition fencing rule and duplicate-call conformance | A replay key was treated as batch authorship; a preserve-rescheduled run could already carry that state | Register under the live claim token and derive the park from that registration; use invocation provenance rather than replay identity (rung 1 for the repaired transition) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Codex final-head review | 8 | no |
| Codex re-review of the repaired head | 3 | no |
| Codex re-review of the await-event reorder | 1 | no |
| Existing tests, TLC, fuzz, invariants, and lints before each report | 0 | yes |

Self-catch rate: **0 of 12 review reports, or 0%** (and **0 of 9 confirmed
defects**). The preceding events review was also **0%**, so detector
independence did not improve between rounds.

The red commits created after each report demonstrate the failures; they do
not change who found them. Findings 7, 8, and 11 remain in the denominator
because the review emitted them and this document records their
disconfirmation instead of silently deleting it.

## Recurrence

The wake-identity class recurred immediately. The events round had added
generated event programs, but structural binding of a wake to an await was
deferred. Finding 1 landed exactly in that gap: generation was a detector
proxy for a representation that still carried too little identity.

Findings 2, 3, and 6 recurred after wait invariants were instituted. The
mechanism checked selected quiescent conjuncts, not the complete TLA
`WaitIntegrity` property. Finding 4 repeated the method-local-guard class:
`step()` knew it could not nest itself, but the shared property “no
replay-key-bearing operation inside a step” still had no chokepoint.

Findings 9 and 12 are the most important recurrence. The repair for finding 2
copied the eligibility predicate into both statements instead of giving the
decision one owner; finding 9 was the resulting two-clock defect. The repair
for findings 9 and 10 then keyed a follow-on on sleeping state plus
`wake_step`, a post-state that could pre-exist; finding 12 was introduced by
that repair. Predicate equality and post-state resemblance were proxies for
one decision and one invocation's authorship.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Generated repeated-event replay programs | 3 | A generator can emit every declared op kind yet omit the exact adjacency `await("go", timeout)`, timer wake, `await("go", timeout)`; the enrollment tests still pass because they count kinds and methods, not every sequence |
| `wake_step` binding | 1 for current-schema rows | `UPDATE runs SET wake_step = NULL WHERE run_id = ?` followed by an emit creates the historical compatibility case: strict step correlation cannot identify the registration. The current-row constructor is closed, but raw legacy/corrupt rows remain outside it |
| `enterDurableOp` | 1 within `TaskContext` | A new replay-key-bearing context method that fails to call `enterDurableOp`, or a direct store operation below `TaskContext`, is outside the chokepoint. The context-method coverage inventory is the build-time companion, not part of the type itself |
| `UserName.parse` round-trip rejection | 1 within ordinary construction | `raw as unknown as UserName` bypasses runtime parsing through TypeScript's explicit assertion escape hatch. Direct raw SQL can also write text the API refuses |
| Wait-integrity invariants | 3 | An atomic batch that inserts an orphan wait and deletes it before the invariant snapshot leaves no quiescent violation. The state checker cannot prove a losing statement wrote transiently |
| One eligibility and deadline derived from post-state | Claimed 1, hand-written in this round | Finding 12 is the executed false negative: `WHERE run_id = ? AND wake_step = ? AND state = 'sleeping'` accepted state left by an earlier preserve reschedule. The second statement derived from post-state, but not state authored by this invocation |
| Live claim token as invocation fence | 1 while token ownership is intact | Raw corrupt state can assign the caller's token to a foreign row, and a duplicated token source can make two invocations indistinguishable. The transition assumes token uniqueness and the storage authority that establishes it |
| Typed non-NULL payload boundary | 1 only at the API | `INSERT INTO events (..., payload) VALUES (..., NULL)` through fixture or migration SQL bypasses the string type; no schema constraint in this round rejected it |
| Final-head review attestation | Not built in this round | A completed review log from head `H` still attests head `H+1`; `review-attest.sh` did not bind transient artifacts to the commit. This is the exact residual the round recorded |

## Fix-induced defects

**Two confirmed defects were introduced by repairs in this same sequence.**
Finding 9's duplicate eligibility read was introduced when the first repair
for finding 2 added `eligibleTask` to the wait insert while the park continued
to evaluate it independently. Finding 12 was introduced by the repair for
findings 9 and 10, which reordered the batch and treated an existing
`wake_step` post-state as proof that this invocation won.

Finding 10's two timeout calculations predated those repairs, and finding 11
was refuted as reachable, so neither is counted as fix-induced. The fixes were
re-reviewed as new code, not merely re-tested: that fresh review is exactly
how findings 9 and 12 were found.

## Evidence

- Reviewed head: `f324f99`. Codex verdict: **“Verdict: DO NOT MERGE.”**
- First-pass reproductions and fixes:
  - Finding 1: red `babc521`, green `83a9e23`.
  - Findings 2 and 3: red `b442b34`, green `59d5ca0`.
  - Finding 4: red `9c80840`, green `7d8d16a`.
  - Finding 5: red `4382a48`, green `1bc1847`.
  - Finding 6: red `7e39e32`, green `3feb96d`.
- The first repair gate was recorded as `pnpm verify` green with 319 tests,
  followed by a deep fuzz over the changed store.
- Findings 9 and 10: red `ed28b2b`, green `534f1f6`; recorded gate:
  `pnpm verify` green with 320 tests and a 2,000-seed fuzz green.
- Finding 12: red `a8875db`, green `348c374`; recorded gate:
  `pnpm verify` green with 321 tests, a 2,000-seed fuzz green, and TLA
  re-proving the protocol.
- Findings 7 and 8 did not reproduce as reported. The string payload boundary
  made SQL NULL unreachable through the public emit API, and compiler
  `undefined`-to-NULL coercion prevented the predicted store outage. Both left
  narrower hardening residuals, documented rather than counted as confirmed
  bugs.
- Finding 11 was benign under the then-current schema history: the SDK prefix
  could not match the fabricated bare event step, and the row shape was
  believed unreachable. Decode was tightened anyway so current rows have one
  representation.

## Root cause

Four initial findings shared under-identified wait state: a delivered wake
named its event but not its await, so neither the SDK nor invariants could
prove which operation owned it. The other initial findings were boundary
guards scoped to one method or one example.

The follow-up failures expose the broader common cause. Multi-statement SQL
duplicated an eligibility decision and database-time calculation, then the
repair relied on a post-state that looked right without proving which
invocation wrote it. The model represented one atomic action, while the SQL
implementation had no structural primitive forcing one time and one
provenance source. Review freshness was the process analogue: a log looked
like valid evidence without proving which head produced it.

## Mechanisms

Built in PR #11:

- `wake_step` delivery identity and generated repeated-await programs (rungs 1
  and 3).
- One `enterDurableOp` gate for replay-key-bearing context operations (rung 1).
- NUL and lone-surrogate rejection at `UserName`'s single mint point (rung 1).
- Complete wait-integrity conjuncts, including wait/run state, wake identity,
  timeout equality, and NULL-safe payload checks (rung 3).
- One eligibility decision and one stored timeout copied through the
  await-event transition, ultimately fenced by the live claim token (rung 1
  for that hand-written batch).

Deferred (recorded in `BUILD.md`):

- Bind review artifacts to the exact PR head.
- Make event payload non-NULL structurally at the schema/emit boundary.
- Canonicalize and classify handler results at their source, rejecting
  non-serializable values as permanent user failures.

## What this round still would not catch

The generated program surface can omit an interaction while covering every
method. Quiescent invariants cannot see transient writes. Raw fixture or
migration SQL can construct rows that typed SDK boundaries forbid. A
hand-written batch can derive from a post-state without proving that its own
compare-and-set authored that state; finding 12 demonstrated that boundary
inside this round. Finally, a review log was still not cryptographically or
structurally bound to the branch head, so one more commit after review could
again make the attestation stale.
