# Postmortem: fence provenance — six batch statements that write without proof they won (PR #11 / PR3.6)

The engine executes each store operation as one atomic batch of SQL
statements. Later statements in a batch see the effects of earlier ones, and
the design depends on that: a batch's first statement does the guarded
compare-and-swap, and the rest are supposed to fire only when that swap won.
The rule (DESIGN.md section 3.4, rule 1) is that a later statement must key on
state *this batch just wrote*, never on state that could already have been
there. A seventh adversarial review round found six places where a later
statement keys on state that can pre-exist. Each one lets a stale, duplicated,
id-colliding or externally corrupted caller push the database into a state the
engine's own invariants forbid. Verdict of the round: do not merge.

## Severity

<!-- filled in with the fix round -->

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Replaying the claim-timeout sweep batch at the infra-retry cap terminalizes the task while the successor run the first pass created is still pending | A task is reported permanently failed while a run for it is still queued and will execute — work runs under a task nobody is watching | The generated fault matrix: it already injects a duplicate at exactly this batch label | The matrix varies the FAULT but not the PRE-STATE. Its single canonical workload never reaches 19 infra retries, so the cap boundary where the bug lives is never visited | Boundary-state dimension crossed with the existing label x fault grid (rung 2, generated) |
| 2 | When a failing run's minted successor id collides with its own id, the stamped parent is mistaken for the successor | The task ends failed with no failure reason recorded, so the caller cannot see why | Seeded id collision is an established test seam here, and there is case law for a successor-collision bug in `fail` | The existing collision case pinned a different symptom. Nothing generalizes "a stamp identifies a BATCH, not a ROW" — so every discriminator that asks "does row X carry my stamp" is unguarded when this batch stamped more than one row | A stamped-row discriminator must also pin the row's distinguishing role, enforced by the batch primitive (rung 1) |
| 3 | An activate carrying a stale generation correctly fails its compare-and-swap and returns null, but its task follow-on still matches and clears the task's armed cancellation deadline | A task that was never started never gets cancelled: its start deadline is silently disarmed and the sweep has nothing left to fire on | The batch primitive, which exists to make this shape unwritable | `activate` is one of five operations that hand-roll their batch instead of using the primitive, because the primitive cannot express an operation whose compare-and-swap must PRESERVE the row's existing owner token and so has nowhere to write a batch stamp | Route the operation through the primitive (rung 1) |
| 4 | spawn reports the run id it minted even when it never inserted it | The caller polls a run id that does not exist and never will; the task looks stuck forever | The batch primitive | Same root cause: spawn hand-rolls its batch, because the tasks table has no column to write a batch stamp into, so the run insert cannot key on "our task insert won" | Route the operation through the primitive (rung 1) |
| 5 | awaitEvent's wait registration silently does nothing when a wait already exists for the same run, step and event; the park then borrows that stale row and inherits ITS timeout | An old untimed wait plus a new 30-second await parks the run forever — a workflow that should time out never wakes | The batch primitive | Same root cause: awaitEvent hand-rolls its batch and hand-mints its own stamp, a verbatim reimplementation of the primitive's stamp, but the wait row itself carries no stamp so registration cannot be distinguished from a conflict | Route the operation through the primitive (rung 1) |
| 6 | emitEvent reads task ids straight out of the waits table instead of from the runs it actually woke | A corrupt wait row naming an unrelated healthy task flips that task to pending while its own run keeps running — corrupt state amplified into a healthy task, which rule 6 forbids outright | The batch primitive | Same root cause: emitEvent hand-rolls its batch, because its follow-ons are a fan-out over every waiter and the primitive only knew how to key on a single stamped row | A fan-out shape whose targets must derive from the batch's own post-state (rung 1) |

## Evidence

- Red tests: commit `c2f199e` — six tests, run and seen failing against
  `9654002`. They live in
  `packages/conformance/test/fence-provenance-regressions.test.ts`. Finding 1
  is caught by the engine's own invariant library once a driver presents the
  state to it: the failure message is
  `terminal-task-with-live-run: T/successor-1`.
- Fixes: <!-- filled in with the fix round -->
- Finder: an independent adversarial review of the branch head, whose verdict
  was: "Reviewed head `9e6eaff`. Eight concrete correctness bugs remain. ...
  The full clock sweep found no remaining 'two `NOW`s that must agree' bug. No
  retained class finding exists in `claim`, `heartbeat`, `complete`,
  `reschedule`, `suspendRun`, `cancelTask`, or `setCheckpoint`. **Verdict: DO
  NOT MERGE.**"
- Two of the eight reported bugs were the blind counter bumps already fixed in
  `9654002`, where the batch primitive's new guard rejected the shape outright.
  One further reported bug did not reproduce: a losing spawn does not attach a
  run to a pre-existing task, because the run insert selects the task by the
  caller's own task id, which does not exist when the insert lost. That
  assertion is kept as a guard inside the spawn test.

## Root cause

<!-- filled in with the fix round -->

## Mechanisms

<!-- filled in with the fix round -->
