# Postmortem: the codex final-head review of PR #11

Before merging PR #11, a fresh codex review was run against the branch's
FINAL head — not the head the original events review had seen, which had
moved by five bug fixes, three prevention mechanisms, and a simplification
pass. This was the honest merge gate: attesting the final head against a
stale review is exactly the "attest falsely" the attestation mechanism
exists to prevent. Codex returned DO NOT MERGE with eight findings. Six were
confirmed as real correctness bugs and fixed; two were refuted (with cheap
residual hardenings recorded). This is a review-caught SEV round.

## Severity

Two of the six are HIGH: a task that awaits the same event name twice and
times out deadlocks forever (finding 1), and a durable operation nested in a
step silently corrupts replay keys (finding 4). The rest leave a durable
engine in states its own invariants could not see — an orphan wait on a
running run, a task mirrored to sleeping on the back of an unrelated run, and
names that do not survive storage. None had shipped; the review caught them
before merge, which is the process working. What the round proves is that
running the review against the ACTUAL head — after the tree had moved — was
load-bearing: the original review could not have found bugs in code written
after it ran.

## Findings

| # | Defect | Impact | Verdict | Layer that should have caught it | Why it could not | Mechanism |
|---|--------|--------|---------|----------------------------------|------------------|-----------|
| 1 | A carried wake is matched by event NAME, not the await's step key; two same-name awaits deadlock on timeout | Run never completes, burning a pass per timer fire | CONFIRMED (high) | The replay-equivalence harness | Its generated programs never awaited the same event name twice with a timeout; the deferred "wake_step binding" was the known gap | wake_step column binds a wake to its await; the SDK matches by step key. Generated event programs now include repeated same-name timed awaits |
| 2 | awaitEvent's wait INSERT guards on `running` only; the park on the stricter `eligibleTask` — an orphan waiting row is left | Task/run coherence violation; a later emit mutates the task inconsistently | CONFIRMED (medium) | The wait invariants | No checker flagged a waiting row on a non-sleeping run | INSERT now carries the same eligibleTask guard; wait-on-non-sleeping-run invariant added |
| 3 | The task-mirror only checks the given run is sleeping, not that it belongs to the caller task | A mismatched call flips the caller task to sleeping on an unrelated run | CONFIRMED (medium) | The wait invariants | No checker tied a parked run's wake to its wait | Mirror fenced to the run AND task; wait-wake-name-mismatch invariant added |
| 4 | A durable op (await/sleep) inside a ctx.step corrupts repeat counters on replay | Wrong wake consumed; nondeterministic replay | CONFIRMED (high) | The step reentrancy guard | inStep blocked only nested step(), not await/sleep | One enterDurableOp gate rejects nesting ANY durable op in a step |
| 5 | UserName accepts an embedded NUL (SQLite truncation) and a lone surrogate (U+FFFD collision) | A name's wake never matches, or two names cross-deliver | CONFIRMED (high) | UserName.parse (the single mint point) | It checked only '#'/'$' | parse now rejects NUL and any lone surrogate |
| 6 | wait-for-fired-event is an incomplete twin of TLA WaitIntegrity | Findings 2/3's corruption returns zero invariant violations | CONFIRMED (medium) | The invariant library itself | One conjunct stood in for a multi-conjunct invariant | Added the missing conjuncts; made wake-payload-mismatch NULL-safe |
| 7 | SQL NULL doubles as an emitted payload and the timeout sentinel | A NULL emit could false-time-out a waiter | REFUTED (low) | — | Unreachable through the typed `payloadJson: string` boundary; the collision needs a NULL payload the API cannot produce | NULL-safe invariant landed; a schema/emit-boundary guarantee recorded as a deferral |
| 8 | A non-serializable handler result is misclassified as infrastructure | Would burn infra_retries forever | REFUTED (low) | — | FencedBatch.compile coerces undefined→null before the bind, so no StoreUnavailableError and no infra loop; the residual is a silent completion with NULL | Canonicalize-and-classify the result at the source, recorded as a deferral |

## Evidence

- Reviewed head: pr3.1 at `f324f99`. Codex verdict verbatim:
  **"Verdict: DO NOT MERGE."** with the eight findings above.
- Each finding was independently re-verified by an eight-way adversarial
  tracer pass against the actual committed code: six CONFIRMED with concrete
  reproductions, two REFUTED with the exact reason (FencedBatch's
  undefined→null coercion for finding 8; the typed string boundary for
  finding 7).
- Fixes, each red then green:
  - Finding 1: `babc521` (red) → `83a9e23` (green).
  - Findings 2/3: `b442b34` (red) → `59d5ca0` (green).
  - Finding 4: `9c80840` (red) → `7d8d16a` (green).
  - Finding 5: `4382a48` (red) → `1bc1847` (green).
  - Finding 6: `7e39e32` (red) → `3feb96d` (green).
- Gate after fixes: full `pnpm verify` green (319 tests, all lints), plus a
  deep fuzz over the changed store.

## Root cause

The common thread is that the wake carried too little identity. A delivered
wake named only its event, so nothing downstream — not the SDK's matching,
not the invariants — could tell which await a wake belonged to (findings 1,
2, 3, 6 are all facets of under-identified wait/wake state). Binding the wake
to its await (`wake_step`) and completing the WaitIntegrity twin closes that
class. The remaining two (durable-op-in-step, name round-trip) are boundary
guards that were scoped too narrowly — one method's reentrancy check, one
charset check — and are now single chokepoints.

The process lesson: the review must run against the head being merged. The
original events review was real and found real bugs, but the head kept
moving after it; only a review of `f324f99` itself could find bugs in the
code added since. The attestation script already claimed (in its header)
that artifacts must be newer than the last commit; this round is why that
claim must be enforced, not just stated.

## Mechanisms

Built in this PR (see the commits above): the wake_step binding, the
enterDurableOp gate, the UserName round-trip rejection, and three new/upgraded
WaitIntegrity invariant conjuncts.

## Second round: re-reviewing the fixed head

Per the freshness principle this round established, the fixed head was
re-reviewed by codex before attesting. It confirmed all six fixes sound and
found three more, sharing one root cause: `awaitEvent`'s wait INSERT and its
park each read database time (`NOW`) independently, so under real time (not
the tests' fake-now) the two disagree by ~1ms of clock drift.

- **A** (real): the eligibility decision — the cancellation deadline inside
  `eligibleTask` is database time — was evaluated in both the INSERT and the
  park, so a deadline landing between the two reads registered a wait the
  park then refused (the orphan-on-a-running-run again, now via drift not
  guard asymmetry).
- **B** (real): `timeout_at_ms` (wait) and `available_at_ms` (run) were both
  `NOW + timeout` computed separately, so they could differ by 1ms —
  scheduling the timeout after its own registered deadline.
- **C** (benign, unreachable): the pre-v3 wake decode fell back to the bare
  event name for a NULL `wake_step`, which the SDK's `$await:`-prefixed keys
  never match. No such row can exist (events were introduced with
  `wake_step`), but the fallback was misleading.

Fix: reorder the `awaitEvent` batch so the park runs FIRST and the wait
derives entirely from its post-state — the wait fires iff the park set this
run sleeping under this `wake_step`, and its `timeout_at_ms` **is** the run's
`available_at_ms` (read from the just-parked row, not recomputed). One `NOW`,
one eligibility decision; A and B become structurally impossible. Added the
`wait-timeout-availability-mismatch` invariant (the WaitIntegrity conjunct
that catches the class), and tightened the decode to require `wake_step`
alongside `wake_event` (C). Landed `ed28b2b` (red) → `534f1f6` (green); full
verify (320 tests) and a 2000-seed fuzz green.

The deeper lesson, now explicit: a multi-statement batch must not compute the
same quantity — or an eligibility decision — from `NOW` in two places;
derive the second from the first statement's committed post-state. This is
the §3.4-rule-1 "fence on the post-state" pattern applied to time itself.

Deferred (recorded in BUILD.md):

- Enforce attestation-artifact freshness in review-attest.sh: refuse a codex
  log or workflow journal older than the branch head, so the review always
  matches the merged code (the header already promises this; the code does
  not check it).
- Finding 7 hardening: a schema/emit-boundary guarantee that an event payload
  is never SQL NULL, lifting the timeout sentinel from a type-only guarantee
  to a structural one.
- Finding 8 hardening: canonicalize the handler result at the source and
  classify a non-serializable result as a permanent user failure, rather than
  completing silently with NULL.
