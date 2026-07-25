# Postmortem: two store bug classes, and why the machinery missed them

Across six adversarial codex rounds against PR #11's head, the review found
eleven confirmed correctness bugs that reduce to just **two classes**, each
appearing in several store operations:

- **Class A — "two NOWs in one batch."** A multi-statement batch computes two
  values that must be equal (or an eligibility decision) from database `NOW`
  in *separate* statements. Real libSQL (and MySQL) re-read the wall clock per
  statement, so the values drift by ~1ms. Instances: `awaitEvent`
  `timeout_at_ms` vs `available_at_ms` and its eligibility re-check (round 2);
  `activate` lease-expiry `1,060,000` vs cancel-deadline `1,060,001`, causing a
  claim-timeout sweep instead of cancellation (round 6).
- **Class B — "a losing batch still writes."** A hand-rolled follow-on keys on
  a post-state that could *pre-exist* (not proven to be this batch's winning
  write), so a stale/duplicate invocation, or externally-corrupted state (§3.4
  rule 6: a terminal task with a live run), gets amplified. Instances:
  `awaitEvent` wait keyed on a replay key (round 3), its task-mirror keyed on
  pre-existing sleeping state (round 4), the claim receipt reviving a terminal
  task (round 5), the activate follow-on re-arming a terminal deadline (round
  5), `spawn`'s initial run not fenced on the task-insert winning, and the
  `awaitEvent` park borrowing a pre-existing wait (round 6).

## Severity

None had shipped, and the review caught them before merge — the process
working. But six rounds of the *same two classes* is a machinery failure, not
eleven unrelated bugs. Left unfound, class A silently mis-schedules real
cancellations under production clocks, and class B lets any corrupt or racing
input amplify into off-model state.

## Root cause (one sentence)

`spawn`, `claim`, `activate`, `awaitEvent`, and `emitEvent` hand-roll
`this.db.batch([...])` with per-statement guards, instead of routing through
`FencedBatch` — the primitive built precisely to mint **one** stamp, read
**one** `NOW`, and make every follow-on key on the winning write by
construction — so both classes are *writable* only because these ops sit
outside the net that forbids them.

The damning part: we already learned this. CLAUDE.md says *"hand-rolled
batches ... are how the losing-sweeper race shipped,"* and we built
`FencedBatch` as the cure. The **sweep** was migrated to it (`store.ts` uses
`new FencedBatch('sweep:lost-launch' | 'sweep:claim-timeout' | 'reschedule' |
'suspend' | 'complete' | 'fail')`), but `spawn`/`claim`/`activate`/`await`/
`emit` never were — and **nothing failed the build to force it.** The
round-3/4 `awaitEvent` fix even hand-wrote a `parkStamp` and keyed the mirror
on it — a verbatim reimplementation of `FencedBatch`'s stamp, proving the
primitive was the right shape and merely wasn't reached for.

## Why every green check missed it

- **Fake-now hides all of class A.** Every test, the fuzz, the fault matrix,
  the conformance suite run against a *fixed* clock. With a constant `NOW`, the
  two reads are identical — the drift is *unobservable* in anything we have. It
  exists only under a clock advancing between statements, which no harness
  exercises.
- **No corrupt-pre-state fault dimension.** The matrix injects crash/duplicate
  at batch boundaries; nothing *seeds* the rule-6 corrupt states (a terminal
  task with a live run) that class B needs. The invariant library even *names*
  those states — but runs at quiescence over states reachable by *legal*
  transitions, which never produce them, so the checkers never fire.
- **Quiescence invariants are blind to a transition property.** "A losing batch
  wrote a same-value row" leaves the state coherent — a check at rest sees
  nothing. It is a property of the transition, not the state.
- **TLA proves the protocol under an assumption these batches violate.**
  `Scheduler.tla` maps one atomic action per batch and states outright: *"SQL
  atomicity is assumed exactly as action atomicity."* `now` is one logical
  clock advanced only by the standalone `TimeAdvance` action, never within a
  batch — so per-statement drift (class A) is unmodelable — and each batch is
  one guarded action, so a follow-on firing on pre-existing state (class B) is
  unmodelable. TLA isn't wrong; it proves the *idealized* batch, and the
  hand-rolled SQL doesn't realize it. The refinement/sim layer that was
  supposed to check that realization runs under the *same* fake-now single
  clock and models a batch as one step, so it inherited the identical blind
  spot.

## Mechanisms

Built now (this PR):

- **`scripts/batch-lint.py` (build-caught, wired into `pnpm verify`).** Every
  raw `this.db.batch(...)` label must be classified; reads and single fenced
  writes pass; the five hand-rolled multi-statement writes are a *frozen
  migration debt set that may only shrink*, and any new unclassified raw batch
  fails the build — so a new hand-rolled multi-statement write is impossible to
  add without either using `FencedBatch` or making the debt visible in review.
  This is the build failure that should have existed when the sweep was
  migrated and the others weren't.
- **`scripts/clock-lint.py` (build-caught).** The SQL analog of the determinism
  lint: raw wall-clock functions (`unixepoch`, `CURRENT_TIMESTAMP`, `NOW()`,
  `clock_timestamp`, …) are banned in store SQL outside `time.ts`, so database
  time enters only through `NOW_MS`.
- The point-fixes themselves all apply the *derive-from-post-state* rule (one
  `NOW`, one eligibility decision; follow-ons read the winner's committed
  columns) and rule-6 live guards — the shapes the `FencedBatch` migration will
  make structural.

Deferred (recorded in BUILD.md), the unwritable rung and its test twin:

- **Route `spawn`/`claim`/`activate`/`await`/`emit` through `FencedBatch`**
  (extended for the fan-out, discriminator, and idempotent-insert shapes), so
  one-stamp/one-`NOW`/post-state-fenced is structural and the batch-lint debt
  set empties. This is the "unwritable" rung and the real end state.
- **A per-statement clock-jitter test executor** (advance `NOW` 1ms per read,
  buggify-seeded) run across the conformance suite and fault matrix, so class A
  manifests deterministically instead of being hidden by fake-now.
- **A generated corrupt-pre-state ("poison") fault surface**: for every write
  label × each invariant-forbidden pre-state, drive the op and assert no
  amplification — the missing driver that presents rule-6 corrupt states to the
  transitions, turning the already-written invariants from dormant to firing.
