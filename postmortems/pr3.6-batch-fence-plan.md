# PR3.6 — FencedBatch migration + extension (design)

Goal: make class B ("a losing/duplicate/corrupt-input batch still writes a
follow-on keyed on a pre-existing post-state") **unwritable**, by routing the
five hand-rolled multi-statement write ops — spawn, claim, activate,
awaitEvent, emitEvent — through `FencedBatch`, extending the primitive for the
shapes it does not yet cover, and emptying the `batch-lint` debt set. Class A
(two NOWs) is already clean; the batch-lint + clock-lint hold the line while
this lands.

`FencedBatch` today: one or more mutually-exclusive `cas()` statements that
write `$STAMP$` into the winning row; `followOn()` statements that must
reference `$STAMP$`; a `tail()` SELECT. `won` = the CAS whose rowsAffected===1.
That already kills class B for a **distinct** invocation (fresh stamp → a
losing CAS's follow-on finds no stamped row). The gaps below are why the five
ops stayed hand-rolled.

## Primitive extensions needed

1. **Idempotent-under-exact-replay counters.** `fail`/`sweep:claim-timeout`
   already use `FencedBatch`, yet an exact re-execution of the *same compiled
   batch* (same bound stamp) double-counts `attempts` / `infra_retries` because
   the counter follow-on does `attempts + 1`. Fix shape: the counter follow-on
   must compute the target from the winning row's post-state (e.g. set
   `attempts = successor.attempt - infra_retries`) or be guarded so a second
   application is a no-op. Add a `followOn` convention/helper that forbids blind
   `+ 1` on a counter (or a lint arm). (Note: same-stamp replay needs
   seeded-id reuse or executor identical-batch retry — lower severity than the
   corrupt-state cases — but it is the reason `fail`/`sweep` show class B.)

2. **A stamp-bearer for stampless tables (spawn).** `tasks` has no
   `claimed_by`-style column, so spawn cannot stamp the task row. Options:
   (a) treat the task INSERT (`ON CONFLICT DO NOTHING`) as the CAS — it already
   yields rowsAffected 1 iff *our* insert won — and let the initial-run INSERT
   follow-on key on `created_at_ms = <this batch's NOW>` written by the task
   INSERT (the NOW read once, per the class-A rule); (b) the winner-resolve
   read becomes a `tail()`. This also fixes round 7's `created: true` with a
   fabricated run id: `created` must derive from the CAS `won`, not a
   post-hoc task_id compare.

3. **Fan-out delivery (emit).** emitEvent's CAS is the first-write-wins event
   INSERT (one row), but its follow-ons UPDATE *every* waiter run/task and
   DELETE the waits — a fan-out, not a single stamped row. Extend `FencedBatch`
   with a `fanOut()` follow-on that is gated on the CAS having won (the event
   row now exists) rather than on a per-row stamp, and whose targets are keyed
   on the wait rows (which are the provenance). Round 7's corrupt-wait finding
   (a wait naming a foreign task flips it to pending) is closed by keying the
   task fan-out on the run actually being woken (join through the wait to a run
   this batch set pending), not the bare task_id in the wait.

4. **Discriminator read (await).** awaitEvent needs the emitted/parked/
   lease-lost discrimination after its writes. The wait INSERT is the CAS
   (stamp the wait row via a new nullable `wait.stamp` column, or reuse the
   run's parkStamp); the park + task-mirror are stamp-keyed follow-ons; the
   hit-read is a `tail()`. Stamping the wait row closes round 7's
   "park borrows a pre-existing same-event wait": the park keys on the wait
   carrying THIS batch's stamp, so a pre-existing wait (no stamp / other
   stamp) cannot be borrowed.

## Per-op migration

| op | CAS | follow-ons | tail | closes |
|----|-----|-----------|------|--------|
| spawn | task INSERT (ON CONFLICT DO NOTHING) | initial-run INSERT keyed on the task's fresh `created_at_ms` | winner-resolve SELECT | collision run, created:true fabrication |
| claim | the claim UPDATE (already stamps claimed_by) | task-bookkeeping (state IN LIVE), timed-out-wait DELETE | run⋈task SELECT (t.state IN LIVE) | receipt revival |
| activate | the per-claim CAS (stamps) | task first-start/deadline keyed on the CAS stamp | payload SELECT | losing-activate deadline clear |
| awaitEvent | wait INSERT (stamps the wait) | park + mirror keyed on the wait stamp | hit-read | park borrowing, terminal park |
| emitEvent | event INSERT (first-write-wins) | fanOut run wake, fanOut task wake keyed on woken runs, waits DELETE | — | corrupt-wait amplification |

Also: emitEvent's zombie guard (round 6 finding 1) is a preflight, not a
fence — the store emit is global. Close it by having the SDK's emit go through
a lease-fenced store call (emit only if the caller's run still holds its lease)
or accept it as advisory with a documented note; decide during migration.

## Test twin (the machinery that would have caught the class)

- **Per-statement clock-jitter executor**: a test `SqlExecutor` wrapper that
  advances fake-now by 1ms on each statement of a batch, run across the
  conformance suite + fault matrix. Makes any residual two-NOWs bug a
  deterministic red instead of hiding under the fixed fake clock.
- **Corrupt-pre-state ("poison") fault surface**: for every `MATRIX_WRITE_LABEL`
  × each invariant-forbidden pre-state (terminal task + live run, etc.), seed
  the state, drive the op, and assert no amplification (no revival, no
  re-armed deadline, no launch of a terminal run) and invariants clean. This is
  the driver the already-written rule-6 invariants lacked.
- **Concurrent-losing-duplicate sim**: two SimWorld actors invoke the same
  transition on the same run; assert the loser wrote nothing (at most one stamp
  per transitioned row; follow-on side-effects count == winner count).

## Exit criteria

- `batch-lint` `FENCED_DEBT` set is empty (all five migrated).
- A fresh codex full-store sweep returns no class-A / class-B finding.
- verify + fuzz + TLA green; the two new test surfaces green.
