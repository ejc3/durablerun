# Postmortem: PR3.2a lifecycle review rounds 1 and 2 (PR #28)

PR3.2a moved the rolling-deploy deferral before activation, taught every refused
worker write to name a cancellation, pinned idempotency-key reuse, and added a
wake floor to the driver loop. A Fable subagent running the built-in
`/code-review` over `b8eb478...04b79b9` reported ten findings. Five are
correctness defects in product code. An older driver's launches all failed
against a newer worker, and the new deferral parked claims activation refuses.
A mismatched or flapping task name latched the first start, and a duplicate
delivery of an unknown task reported a lost lease. The wake floor could delay a
due look or stall the loop for the size of a clock step. A second Fable `/code-review` over the fixes found two more correctness
defects. A failed refusal read turned a definitely-refused write into a store
outage, and the deferral still lacked two of activation's range guards. None had
shipped, and all seven are fixed behind red commits.

## Severity

Without the review, five defects would have shipped. Worst first:

1. A rolling deploy in the order DESIGN.md recommends, new workers before new
   drivers, would fail every launch from an older driver with HTTP 400. The
   sweep would reopen each run as a lost launch until the relaunch cap failed
   the task, with no handler ever run.
2. A claim activation refuses, such as a task with two live runs or drifted
   attempt accounting, would be parked by the deferral instead, and the task
   would mirror its state from a run that is not its sole live run.
3. A launch naming another task, or a registry that stops resolving after the
   first lookup, would latch the first start and then throw. That disarms the
   start deadline, starts the duration clock, and ends in infrastructure
   retries without a handler running.
4. A backwards clock step would stall the driver loop's ticks, sweeps, and
   registry beats for the size of the step, and a wake during a short park
   would delay a due look by up to the floor.
5. A duplicate delivery of a task no handler knows would report a lost lease,
   so the inline launcher reports a crash and dogfood records an
   infrastructure failure for an ordinary duplicate.
6. A dropped connection during the refusal read would turn a refused worker
   write into `StoreUnavailableError`, so the worker aborts as an outage and a
   verify-then-exit caller retries a write that can never win.
7. A claimed run whose stored lease or relaunch counter is out of range would
   be parked by the deferral where activation refuses it, carrying the corrupt
   row forward.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The worker server returned 400 for a launch without `taskName` (review finding 2) | Every launch from an older driver fails, and tasks end at the relaunch cap with no handler run | Driver worker-server hardening tests | Every launch body in the tests is built from the current `LaunchInvocation`, so no test sends an older driver's payload | The launch payload carries only ids again, and the worker reads the claimed task's name from the store, so there is no field for an older driver to omit (rung 1). A red test sends an older driver's launch (rung 3) |
| 2 | `deferLaunch` lacked activation's corruption and admission guards (review finding 3) | A corrupt claim parks, and the task mirrors state from a non-sole live run | Poison matrix `defer-launch` cells | The base poison world seeds the poisoned run already activated, and the cells defer at claim generation 1, so the claim receipt refuses before any corruption guard runs. The four targeted profiles cover only claim and sweep labels | `deferLaunch` carries activation's guards, and a conformance case corrupts a claim and requires the deferral to refuse and write nothing on libSQL and PostgreSQL (rung 3) |
| 3 | A task-name mismatch was detected only after activation latched the first start (review finding 4) | Start deadline disarmed, duration clock started, infrastructure retries | SDK `runClaimedRun` tests | Every test builds the launch from its own claim and registers tasks in a `Map`, so the name never disagrees and never stops resolving | The worker resolves one handler from the store's name before activation, so there is no second name to disagree with (rung 1). Red tests use a structural resolver and a payload naming another task (rung 3) |
| 4 | The wake floor's wait ignored clock steps and the park's planned look (review finding 5) | Loop stall for the size of a backwards step; a due look delayed by up to the floor | Driver loop tests | The fake clock never steps backwards, and no test wakes the loop during a park shorter than the floor | The wait is capped at the floor and at the planned look, with two loop tests (rung 3) |
| 5 | A duplicate delivery of an unknown task reported a lost lease (review finding 6) | Crash and infrastructure-failure outcomes for an ordinary duplicate | SDK duplicate-delivery test | It covers only a registered task | The name read answers nothing once the first delivery parks the claim, and the worker reports superseded, with a red test (rung 3) |
| 6 | A failed refusal read replaced a refused write's `LeaseLostError` with `StoreUnavailableError` (round 2, finding 4) | An outage outcome and a retry of a write that cannot win | Store refusal tests | The only refusal-read test injected no fault into the read, and the fault matrix's `refusal-state` cells swallow every error through the workload's tolerant wrapper | Core's `refusedWriteError` owns the classification and keeps `LeaseLostError` with the read's failure as its cause, so both stores share one definition (rung 1), with a red store test that fails the read (rung 3) |
| 7 | The deferral lacked activation's `lease_ms` and `relaunch_count` range guards (round 2, finding 5) | A corrupt claim parked instead of refused | The corrupt-claim deferral case added for finding 2 | It corrupted live-run cardinality and accounting only, so the fix for finding 2 copied the guards that case named and missed the rest | Both range guards in both dialects, and the case corrupts both counters and the headers too (rung 3). One admission fragment shared with activation stays deferred |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review` round 1 (findings 1 to 5) | 5 | no |
| Fable `/code-review` round 2 over the fixes (findings 6 and 7) | 2 | no |
| Existing conformance, fuzz, TLC, invariant, mutation, and lint gates before review | 0 | yes |

Self-catch rate: 0 of 7, or 0% (previous round: 0%, `pr3.5b-store-simplification-review.md`).

The rate has not moved. Every correctness defect in this round was found by
outside review, and none of the machinery added in earlier rounds saw any of
them. The poison matrix did run the new label, and it passed vacuously, which
is worse than not running: it is green evidence about a transition it never
reached.

## Recurrence

- **Two transitions on one claim receipt applied different guard sets
  (finding 2).** This recurred. Reschedule's own comment records that its
  eligibility guard and suspendRun's had quietly diverged, and `fragment-lint`
  exists because the claim once re-derived eligibility without the
  cancellation deadline. The mechanism checks that each eligibility predicate is
  spelled only in `fragments.ts`. It does not check that every transition fenced
  on the same receipt applies the same set of predicates, and `deferLaunch` used
  fragments, just fewer of them. The mechanism is a proxy for one definition per
  predicate, not one admission rule per receipt.
- **A second representation of one value (findings 1, 3, 5).** This recurred.
  AGENTS.md's single-representation law says a value that crosses a
  serialization boundary is returned in canonical form at its source. The launch
  payload grew a copy of a durable column, the claimed task's name, and nothing
  checks that launch payload fields are identities only. The law is prose, with
  no mechanism at the launch boundary.
- **The same class inside this round (finding 7).** The fix for finding 2
  copied activation's guards by hand and copied only the ones its red test
  corrupted. A red test is a proxy for the property here: it proves the guards
  it exercises, and a hand copy follows the test, not the source it copies.
  That is the argument for the deferred shared admission fragment, stated in
  code rather than in prose.
- **Driver loop timing that trusts the local clock (finding 4).** This recurred.
  The loop suite already pins one clock shape, a host clock ahead of database
  time, as a single regression test. Nothing generates clock shapes for the loop,
  so a new computation from two local clock readings brought the class back.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes it |
|-----------|------|----------------------------------------------|
| Worker reads the claimed task's name through `claimedTaskName`, keyed on its unactivated claim, and the launch carries only ids | 1 for the payload shape, 3 for the read's claim conditions | Dropping `AND r.queue = ?` and its argument from the libSQL read. Run against that variant: the SDK suite (83 passed), the worker-server, inline, and tick driver tests (36 passed), and the libSQL deferral and cancellation discovery conformance cases (5 passed). A worker handed another queue's run id still learns that task's name, and the queue-fenced deferral then refuses it as lease-lost instead of superseded |
| `deferLaunch` applies activation's guards, pinned by the corrupt-claim case | 3, and the parity with activation is textual | Deleting `durableTaskHeadersAdmissible('t')` from the libSQL deferral. Run against that variant: the libSQL deferral conformance cases and every libSQL poison `defer-launch` cell (148 passed). The corrupt-claim case corrupts accounting and live-run cardinality, not headers, and the poison cells never reach the guards |
| The wake floor's wait is capped at the floor and at the planned look | 3 | Computing the planned look before the registry-beat cap. Run against that variant: the loop and wake driver suites (49 passed). By reading the code, a wake during a park whose ceiling exceeds the time to the next beat can then push the beat past its due time; no test has a registry interval shorter than the ceiling |
| `deferLaunch` carries activation's range guards, pinned by the extended corrupt-claim case | 3 | Deleting `storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')` from the libSQL deferral. Run against that variant: the four libSQL deferral conformance cases (4 passed) and every libSQL poison `defer-launch` cell (144 passed). The case corrupts the relaunch counter, the lease, the headers, live-run cardinality, and task accounting, but never the run's own attempt |
| The name read's claim conditions, pinned by the `claimedTaskName` case and its registered queue mutation | 3 | Dropping `AND r.state = 'running'` from the libSQL name read. Run against that variant: the libSQL `claimedTaskName`, deferral, and cancellation discovery cases (6 passed) and the SDK suite (83 passed). The case varies queue, token, generation, and activation, never the run state |
| Core's `refusedWriteError` keeps `LeaseLostError` when the refusal read fails | 1 for the classification, 3 for the fallback | Making PostgreSQL's refusal read call the executor outside `refusedWriteError`, so a failed read escapes. Run against that variant: the PostgreSQL cancellation discovery case (1 passed) and the PostgreSQL fault matrix (4 passed), with the libSQL refusal-read test as control (2 passed). Only a libSQL store test fails the read, and the matrix's workload swallows the injected error. A classifier change is caught: naming a failed run as cancelled fails the cancellation discovery case and 2 SDK tests |

## Fix-induced defects

None of the five findings came from a fix in this round, because the round
reviewed the original change. The fixes introduced one defect of their own,
caught by our own machinery before any push. The store read of the claimed task
name joined the fault matrix's read labels without a workload call that reaches
it, so every crash-after and duplicate cell armed a fault that never fired, and
all eight fault matrix tests failed on libSQL and PostgreSQL. The workload now
performs the read. The refusal-state read the performance fix added needed the
same workload call, a refused replay of a complete, and the matrix caught that
before commit too.

Two of the seven review findings were introduced by fixes. Finding 6 came from
the fix that moved the refusal read after the refused write: splitting one
batch into two opened a window where the second can fail on its own. Finding 7
is an incomplete fix for finding 2. The round-2 review read the fixes as new
code, which is where both were found; the re-testing alone passed them.

## Evidence

- Red tests: commit `503c28b`, run and seen failing (4 tests) against `04b79b9`:
  `accepts a launch from an older driver that sends no taskName and runs its
  task` (`expected { status: 400, state: 'running' } to deeply equal { status:
  202, state: 'completed' }`), `a resolver that stops resolving after the first
  lookup still runs the handler it resolved`, `a launch that names another task
  still runs the task its claim holds`, and `a duplicate delivery of an
  unregistered task is superseded after the first parks it`.
- Fixes: commit `34de97c`. The SDK suite (83), the driver suites (88), the
  label inventory and deferral conformance cases, and package smoke passed.
- Red test: commit `55a9f0a`, run and seen failing (2 tests, libSQL and
  PostgreSQL): `a launch deferral refuses a corrupt claim and writes nothing`.
  Fix: commit `cbee30c`.
- Red tests: commit `2ab8f32`, run and seen failing (2 tests): `a wake after the
  clock steps backwards waits no longer than the wake floor` (`expected 3601000
  to be less than or equal to 1000`) and `a wake during a park never pushes the
  planned look later` (`expected 995 to be less than or equal to 245`). Fix:
  commit `e653558`, with the loop, wake, and end-to-end driver suites passing
  (54).
- Fault matrix workload fix for the fix-induced defect: commit `5ed9f56`, with
  all eight fault matrix tests passing on libSQL and PostgreSQL.
- Red test: commit `b6cbb87`, run and seen failing (1 test): `a refused write
  still raises LeaseLostError when the refusal read fails` (`expected
  'StoreUnavailableError' to be 'LeaseLostError'`). Fix: commit `962529f`, with
  the cancellation discovery, deferral, and fuzz regression cases (11) and both
  fault matrices (8) passing.
- Red test: commit `f99ff09`, run and seen failing (2 tests, libSQL and
  PostgreSQL): `a launch deferral refuses a corrupt claim and writes nothing`,
  with the out-of-range relaunch and lease claims reported as `parked`. Fix:
  commit `9e0fb03`, with the deferral slice (296, every poison `defer-launch`
  cell included) and both fault matrices passing.
- Finders: Fable subagents running the built-in `/code-review`, over
  `b8eb478...04b79b9` for findings 1 to 5 and over `04b79b9...1a15f62` for
  findings 6 and 7. Quoted verdicts:
  - "The worker server now returns 400 for any launch body without taskName, so
    the deploy order DESIGN.md recommends (new workers first, old drivers still
    running) fails every launch and eventually fails the tasks."
  - "deferLaunch parks a claimed run without the corruption and admission
    guards the old path (activate, then reschedule) applied first".
  - "A mismatch between the launch's taskName and the claim's task is detected
    only after activate commits, which latches the first start and then throws
    with no transition".
  - "The wake-floor wait is computed from two wall-clock readings with no clamp,
    ignores the sleep the loop had already planned (nextWakeAtEpochMs,
    msUntilBeatDue), and cannot be cut short by another wake."
  - "A duplicate or stale delivery of an unknown task is now refused by
    deferLaunch and reported as lease-lost (or cancelled), where it used to be
    superseded."
  - "then the follow-up `refusal-state` batch hits a connection drop or an
    injected fault. The caller gets `StoreUnavailable` instead of
    `LeaseLostError` or `RunCancelledError`"
  - "a claimed run whose `relaunch_count` goes out of bounds after the claim is
    refused by `activate` but parked by `deferLaunch`"
- The reviewer marked its findings 3, 4, 6, and 7 as plausible but not run.
  Findings 3, 4, and 6 each became a red test that failed. Finding 7, that a
  cancelled task's pass ends as cancelled or lease-lost depending on timing, did
  not become a defect fix: the outcome still depends on whether the heartbeat or
  a write sees the cancellation first, or whether a suspension is refused on a
  due deadline before the sweep cancels the task. DESIGN.md states both halves,
  and BUILD.md records the heartbeat half as a gap.
- Not counted as correctness findings: review finding 1, the fuzz walk's lease
  counter rethrowing `RunCancelledError` (verification tooling, red `3453d35`,
  fix `17a8606`); finding 8, an extra PostgreSQL round trip on every winning
  worker write (red `c19e7ad`, fix pending commit); findings 9 and 10, stale
  documentation and displaced doc comments.

## Root cause

PR3.2a gave a new pre-activation transition its own inputs and its own guards:
a payload copy of the task name, and a subset of activation's guards. Both
should have been derived from the claim row and from activation. No layer
compares a transition fenced on the claim receipt against activation, and no
conformance case crosses component versions or delivers an unknown task twice.
The loop finding has the same shape in the driver: a new computation from local
clock readings, tested only with a clock that moves forward.

## Mechanisms

Built in this PR:

- The launch invocation type carries no task name, and the worker reads the name
  through `claimedTaskName`, keyed on its unactivated claim (rung 1, `ports.ts`
  and both stores).
- `deferLaunch` applies activation's corruption and admission guards, with a
  corrupt-claim conformance case on both dialects (rung 3, `suite.ts`).
- Four SDK and driver red tests for older drivers, mismatched names, flapping
  resolvers, and duplicate deliveries of unknown tasks (rung 3).
- The wake floor's caps, with two loop tests (rung 3, `loop.test.ts`).
- The cancellation discovery case covers all seven refused worker writes
  (rung 3, `suite.ts`).
- The fault matrix workload reads the claimed task name (rung 3,
  `fault-matrix.ts`).
- Core's `refusedWriteError` owns the refused-write classification, including a
  failed refusal read, and both stores delegate to it (rung 1, `errors.ts`).
- The corrupt-claim deferral case corrupts the relaunch counter, the lease, and
  the header set as well, on both dialects (rung 3, `suite.ts`).
- A `claimedTaskName` conformance case on both dialects, with a registered
  mutation that drops the read's queue condition and must fail it (rung 2 for
  the registered mutation, rung 3 for the case).

Deferred (recorded in BUILD.md):

- One admission fragment for the claim receipt, used by both activation and the
  deferral, so a guard added to one reaches the other (rung 1). Deferred because
  seven registered mutations own find texts inside activation's SQL, and a
  shared fragment rewrites every one of those texts and their verdicts.
- A poison target profile for a running, unactivated claim, so the `activate`
  and `defer-launch` cells reach their corruption guards instead of refusing on
  the receipt (rung 3).
- A launch payload case generated from `LaunchInvocation`'s fields that crosses
  an older driver with a newer worker and the reverse (rung 3).
- A generated clock-shape surface for the driver loop: forward and backward
  steps, and registry intervals shorter than the ceilings (rung 3).

## What this round still would not catch

- A defect of the shape of variant A would ship today: a claim-keyed read that
  drops one of its receipt conditions, where the transition that follows
  refuses the mismatch and only the reported outcome is wrong.
- A defect of the shape of variant B would ship today: a transition fenced on
  the claim receipt that omits an admission guard the corrupt-claim case does
  not corrupt. The poison matrix still seeds its poisoned run activated.
- A defect of the shape of variant C would ship today: a driver loop wait that
  honors one of its deadlines and not the others, where no test sets the
  registry interval below the ceilings.
- A new launch payload field that a worker trusts instead of reading from the
  store would ship today, because no mechanism constrains payload fields to
  identities.
- A defect of the shape of the round-2 variants would ship today: a deferral
  guard for a column the corrupt-claim case never corrupts, such as the run's
  attempt; a claim-keyed read that drops a condition its case never varies, such
  as the run state; and a PostgreSQL refusal path that lets a failed read escape,
  because only libSQL has a failing-read test.
