# Postmortem: the 2026-07-24 nightly TLA failure (phantom liveness violations)

The scheduled nightly deep-verification run on `main` (workflow run
30081427978) reported failures in all three heavy TLC liveness groups (3, 4,
and 5), each printing what looked like a temporal counterexample trace.
Investigation showed no spec violation: the traces were fragments printed by
resource-starved TLC processes, and the gate script could not tell a checker
failure from a model verdict. This is a verification-infrastructure SEV: the
harness produced a false alarm and, worse, was structurally unable to say
which kind of red it was.

## Severity

A red nightly that cries wolf trains everyone to ignore red nightlies, and
this one impersonated the scariest possible signal: a liveness violation in
the verified protocol. Believing it without reproduction would have blocked
the events PR and triggered a hunt for a protocol bug that did not exist. The
inverse failure is worse: once phantom reds are normal, a real violation
scrolls by unread. The volume leg of the proof stack is useful only when its
verdicts are trustworthy.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Six concurrent TLC JVMs (safety plus five liveness groups) shared one 7 GB, 14 GB-disk GitHub runner; `tla.sh`'s budget arithmetic was tuned on a larger machine | All three heavy groups died of shared-resource exhaustion, and the nightly spent hours producing no trustworthy verdict | The gate script's resource sizing | It sized each heap from the environment but treated concurrency and shared disk as free; six processes were assumed viable at every runner size | Nightly is a six-job matrix, each running one `TLA_ONLY` target with the whole runner budget (rung 1 for cross-target runner contention) |
| 2 | `tla.sh` flattened every nonzero TLC exit into `GROUP FAILED` plus a 40-line tail | A checker crash printed trace-shaped fragments and was presented as a model violation while its real error header was cropped | The failure-reporting path | It discarded TLC's exit-code distinction between model verdicts and checker failures and retained only the most misleading end of the log | `report()` classifies exits 10–13 as `MODEL VIOLATION`, every other nonzero exit as `INFRA ERROR`, and prints the first error lines before the tail (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Scheduled nightly failure followed by local reproduction and log analysis | 2 | yes |

Self-catch rate: **2 of 2, or 100%**. No earlier infrastructure round recorded
this metric, so there is no honest numerical previous-round comparison.

That rate needs a qualification: the nightly made the failure visible, but it
did not diagnose itself. A human had to compare timestamps, queue sizes,
trace endings, exit behavior, and a well-resourced reproduction. The
mechanism was therefore good enough to stop the line and not good enough to
produce a trustworthy verdict.

## Recurrence

Neither finding was a recurrence of a previously recorded incident class.
Both were, however, existing mechanisms standing in for broader properties.
Heap auto-sizing measured memory available to one process and was treated as
a proxy for total resource safety, even though process count and shared disk
were unmodeled. A log tail was treated as a proxy for a TLC verdict, even
though the authoritative discriminator is the exit code. The fixes narrow
those claims: the matrix removes only cross-target contention on one runner,
and `report()` classifies only the exit-code contract TLC exposes.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| One `TLA_ONLY` target per matrix runner | 1 for cross-target contention | No in-scope false negative: one matrix job cannot launch a second target. The adjacent residual is a single configuration whose own state graph exceeds one runner's memory or disk; `TLA_ONLY=liveness5` still passes the isolation shape and can still die, but it is then one labelled infrastructure failure rather than six processes starving one another |
| Exit-code verdict classification | 2 | A wrapper that prints `Exception in thread "main" java.lang.OutOfMemoryError` and exits 13 is still labelled `MODEL VIOLATION`, because `report()` trusts the reserved exit code over contradictory text. The checker deliberately does not infer semantics from arbitrary log prose |
| First-error-lines plus tail reporting | 2 | An infrastructure failure whose diagnostic contains none of `Error`, `Exception`, `OutOfMemory`, or `No space` and occurs before the final 40 lines is still cropped. The exit class remains correct, but the root-cause detail can be absent |

## Fix-induced defects

**Zero.** The fix changed job topology and reporting in commit `ff72236`; it
did not alter the TLA model. The accused liveness group and then the complete
five-group gate were rerun after the change. No later finding in this incident
was attributed to the repair.

## Evidence

- There is no red-test commit for this operational incident. The red evidence
  is GitHub Actions run 30081427978 on `main` commit `3e4a86f`; the fix and
  this postmortem landed together in `ff72236`.
- The nightly fuzz leg was green; the `tla` job failed after 5h17m. Liveness
  groups 1 and 2 completed at 10:06Z, then groups 3, 4, and 5 errored with
  `Finished in` timestamps of 12:28:52, 12:27:58, and 14:25:08. The first two
  were within one minute, and all three cited the same trace-file name,
  `Scheduler_TTrace_1784884085.tla`.
- None of the three fragments contained TLC's lasso closure (`Back to state
  N`) or a stuttering marker. Each reported a non-empty state queue, including
  948,912 queued states in group 5, which cannot be a completed
  `-lncheck final` verdict.
- The identical spec was rerun locally with a 48 GB budget. The accused group
  completed 54,522,953 generated states, 10,682,165 distinct states, depth 33,
  a drained queue, and the final temporal check with no violation: exit 0 in
  8m55s. The complete five-group gate was then rerun clean. Commit `ff72236`
  records exhaustive safety at 22.09 million distinct states as green too.
- The counterexample claim did **not** reproduce. The complete local graph and
  absence of a lasso settled it; this document therefore does not call the
  nightly output a protocol finding.

## Root cause

The proof gate had a trusted-verdict assumption that nothing enforced. Budget
arithmetic tuned on a large box was reused on a small runner: heap sizing
adapted, concurrency did not, and no budget included the disk shared by the
liveness graphs. When the starved processes died, a bare log tail cropped the
error header and presented the remaining trace fragment as a counterexample.
The common machinery failure was using resource and text proxies where runner
isolation and TLC's exit contract were available.

## Mechanisms

Built in commit `ff72236`:

- One process per nightly runner (rung 1 for this contention class): a six-way
  matrix of `safety` and `liveness1` through `liveness5`, each invoking
  `TLA_ONLY=<target> bash scripts/tla.sh`.
- Verdict classification (rung 2): `report()` maps TLC exit codes 10–13 to
  model violations, all other nonzero exits to infrastructure errors, and
  emits first matching diagnostic lines before the tail.
- Target selection validation (rung 2): `TLA_ONLY` accepts only `safety` or
  `liveness1` through `liveness5`, so a misspelled matrix leg fails explicitly.

Deferred (recorded by the residuals in this document): none. The adjacent
single-target capacity and diagnostic-vocabulary limits are intentionally
reported below rather than presented as closed.

## What this round still would not catch

A single TLC target whose graph exceeds one runner can still fail for
resources; the matrix removes cross-target starvation, not the need to size a
runner. A wrapper that returns a reserved TLC model-verdict exit for an
infrastructure crash will still be classified from that exit. An unfamiliar
diagnostic outside the first-error vocabulary and final 40 lines may still be
cropped. Those failures should now be labelled red without impersonating a
clean model run, but the reporting mechanism is not a proof that every
infrastructure cause will be explained.
