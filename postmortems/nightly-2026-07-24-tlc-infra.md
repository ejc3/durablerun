# Postmortem: the 2026-07-24 nightly TLA failure (phantom liveness violations)

The scheduled nightly deep-verification run on main (workflow run
30081427978) reported failures in all three heavy TLC liveness groups
(3, 4, and 5), each printing what looked like a temporal counterexample
trace. Investigation showed no spec violation exists: the traces were
fragments printed by resource-starved TLC processes, and the gate script
could not tell a checker failure from a model verdict. This is a
verification-infrastructure SEV: the harness produced a false alarm and,
worse, was structurally unable to say which kind of red it was.

## Severity

A red nightly that cries wolf trains everyone to ignore red nightlies —
and this one impersonated the scariest possible signal, a liveness
violation in the verified protocol, which (had it been believed without
reproduction) would have blocked the events PR and triggered a hunt for a
protocol bug that does not exist. The inverse failure is worse: once
phantom reds are normal, a REAL violation scrolls by unread. The volume
leg of the proof stack is only worth running if its verdicts are
trustworthy.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Six concurrent TLC JVMs (safety + 5 liveness groups) share one 7 GB / 14 GB-disk GitHub runner; the budget arithmetic in tla.sh was tuned on a large box | All three heavy groups died of shared-resource exhaustion in the same minute (~12:28Z), ~2.5 h before the job even reported | The gate script's sizing logic | It sizes the HEAP from the environment but never questions the CONCURRENCY — six processes were assumed viable at any scale, and the liveness disk graphs share one filesystem no budget accounts for | One TLC process per runner: nightly `tla` is now a six-job matrix, each running `TLA_ONLY=<target>` with the full runner budget (rung 1 — the contention is structurally impossible) |
| 2 | tla.sh flattened every nonzero TLC exit into "GROUP FAILED" + a 40-line log tail | A checker crash printed trace-shaped fragments and read as a model violation; the actual error header was above the tail window and lost with the temp logs | The failure-reporting path itself | TLC distinguishes its verdicts by exit code (10 assumption / 11 deadlock / 12 safety / 13 liveness; anything else is the checker failing) and the script never looked | `report()` in tla.sh classifies every failure as MODEL VIOLATION vs INFRA ERROR from the exit code, and prints the first error lines, not just the tail (rung 2) |

## Evidence

- Nightly run 30081427978 on main commit `3e4a86f`: fuzz leg green; `tla`
  job red after 5h17m. Log shows liveness groups 1–2 completing clean at
  10:06Z, then groups 3, 4, 5 all erroring with "Finished in" timestamps
  of 12:28:52, 12:27:58, and 14:25:08 — the first two within a minute of
  each other, all three citing the SAME trace-file name
  (`Scheduler_TTrace_1784884085.tla`, an epoch-second stamp ≈ 12:28:05Z).
- None of the three printed traces contains TLC's lasso closure ("Back to
  state N") or a stuttering marker — every genuine TLC liveness
  counterexample ends with one. All three also report a NON-EMPTY state
  queue (e.g. group 5: 948,912 states still queued), impossible for a
  `-lncheck final` verdict, which runs only after exploration completes.
- Authoritative reproduction: the identical spec (the only change on main
  since `3e4a86f` is a five-line comment in the batch ledger) was run
  locally with a 48 GB budget — complete exploration, 54,522,953 states
  generated, 10,682,165 distinct, depth 33, queue drained, final temporal
  check over the complete graph: **no violation, exit 0, 8m55s**. The full
  five-group gate was then re-run clean with the fixed script.

## Root cause

The gate script treats "the checker exited nonzero" and "the model is
wrong" as the same event. Everything else follows: budget arithmetic tuned
on a 192-core box was reused unexamined on a 7 GB runner (heap adapts to
the environment, concurrency does not, and the shared disk that the three
liveness graphs fill is in no budget at all), and when the starved
processes died, the reporting path — a bare log tail — cropped the error
header and presented the remaining trace fragment as a counterexample.
The proof stack had a trusted-verdict assumption nothing enforced.

## Mechanisms

Built in this PR:

- **One process per runner** (rung 1): the nightly `tla` job is a six-way
  matrix (`safety`, `liveness1`–`liveness5`), each invoking
  `TLA_ONLY=<target> bash scripts/tla.sh` — one TLC process with the whole
  runner's memory and disk. Cross-process starvation on the shared runner
  is no longer expressible.
- **Verdict classification** (rung 2): `report()` in tla.sh maps TLC exit
  codes to MODEL VIOLATION (10–13) vs INFRA ERROR (everything else),
  prints the first error lines from the log before the tail, and the local
  concurrent path uses the same reporting — a checker crash can no longer
  impersonate a counterexample anywhere the script runs.

Deferred: none.
